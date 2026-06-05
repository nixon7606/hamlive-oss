# Chat System

Ham.Live uses [GetStream.io](https://getstream.io/) for real-time chat functionality within live nets. This document covers the architecture, implementation, and configuration of the chat system.

## Overview

The chat system provides:

- **Real-time messaging** within active nets
- **Inline image sharing** (replaces the separate UploadCare integration)
- **Role-based permissions** mapped from ham.live roles to Stream channel roles
- **Chat history** preserved for net close reports
- **Moderation tools** for net controllers (delete messages, ban users)

## Architecture

### Token-based authentication

Chat uses a token-based authentication flow to keep API secrets server-side:

```
┌─────────────┐     1. GET /api/endorse/chat/:npid      ┌─────────────┐
│   Client    │ ──────────────────────────────────────> │   Server    │
│  (browser)  │                                         │  (Express)  │
│             │ <────────────────────────────────────── │             │
│             │     2. { token, userId, channelId,      │             │
│             │          apiKey (public) }              │             │
└─────────────┘                                         └─────────────┘
       │                                                       │
       │ 3. Connect with tokenProvider function                │
       ▼                                                       │
┌─────────────┐                                                │
│  GetStream  │ <── Channel created when net opens ────────────┘
│    Cloud    │ <── Channel deleted after net closes ──────────┘
└─────────────┘
```

### Token expiration and refresh

- **Token expiration:** 3 hours (configured in `streamChat.ts`)
- **Token refresh:** Client uses a `tokenProvider` function instead of a static token. The Stream SDK automatically calls this function when the token expires.
- **Why this matters:** Nets can run longer than 3 hours. Without token refresh, chat would stop working mid-session.

```typescript
// In chat.ts - tokenProvider is called automatically when token expires
const tokenProvider = async (): Promise<string> => {
    const freshConfig = await this.fetchToken();
    return freshConfig.token;
};
await this.client.connectUser({ id: chatConfig.userId }, tokenProvider);
```

### Channel lifecycle

| Event      | Action                                             | Location                                    |
| ---------- | -------------------------------------------------- | ------------------------------------------- |
| Net opens  | `createNetChannel()` creates channel               | `liveNetController.js:liveNetCreatePost()`  |
| User joins | `addChannelMember()` adds user to channel          | `getChatToken()` in `streamChat.ts`         |
| Net closes | `fetchChatHistory()` retrieves messages for report | `serverUtils.js:fetchChatLog()`             |
| Net closes | `deleteNetChannel()` removes channel               | `sharedNetOps.js:closeNet()` (after report) |

**Important:** Channel deletion happens _after_ the net close report is generated to ensure chat history is available.

### Role mapping

Ham.live roles map to Stream Chat channel roles:

| Ham.Live Role | Stream Channel Role | Capabilities                                                  |
| ------------- | ------------------- | ------------------------------------------------------------- |
| `netcontrol`  | `channel_moderator` | Full channel control, moderation (delete messages, ban users) |
| `netlogger`   | `channel_member`    | Send/receive messages                                         |
| `netrelay`    | `channel_member`    | Send/receive messages                                         |
| `netuser`     | `channel_member`    | Send/receive messages                                         |

**Note:** Stream Chat uses `channel_moderator` and `channel_member` as built-in channel roles. The `admin` role is a system-level role and cannot be used as a channel member role. Moderation (message deletion, ban/unban) is restricted to NCS only (`MODERATION_MAX_LEVEL = 0` in `streamChat.js`).

## Server-side implementation

### Core module: `server/dist/lib/streamChat.js`

The server-side Stream Chat integration provides:

**Client management:**

- `getStreamClient()` - Singleton Stream Chat client instance

**User management:**

- `getStreamUserId(mongoUserId)` - Converts MongoDB user ID to Stream format: `hamlive-{id}`
- `upsertStreamUser(userData)` - Creates or updates user in Stream
- `createUserToken(userId, expiration)` - Generates JWT token for client authentication

**Channel management:**

- `getChannelId(npid)` - Generates channel ID: `net-{npid}`
- `createNetChannel({ npid, netTitle, createdById })` - Creates channel when net opens
- `deleteNetChannel(npid)` - Deletes channel when net closes
- `addChannelMember({ npid, userId, role, userData })` - Adds user to channel with role
- `updateMemberRole({ npid, userId, role })` - Atomically updates user's channel role via `updateMemberPartial()` (avoids race conditions from remove/add pattern)
- `removeChannelMember({ npid, userId })` - Removes user from channel

**Chat history:**

- `fetchChatHistory({ npid, since })` - AsyncGenerator yielding message batches for reports

**Moderation (NCS only):**

- `deleteMessageHelper({ npid, messageId, moderatorCallsign })` - Hard-deletes a message (used by the `DELETE /api/endorse/chat/:id/message/:messageId` route)
- `banUserHelper(...)` / `unbanUserHelper(...)` - Exported helper functions; **no HTTP endpoint is currently wired for these** (see TODO comment in `endorseRoutes.js`). Future work: expose as net admin commands.
- `checkUserCanModerate(npid, userProfileId)` - Returns true only for NCS (level 0, i.e., `MODERATION_MAX_LEVEL = 0`)

**Express route handler:**

- `getChatToken(req, res)` - Handles `/api/endorse/chat/:id` endpoint

### Endpoint: `/api/endorse/chat/:id`

**Route:** `server/dist/routes/endorseRoutes.js`

The full set of chat-related endpoints in `endorseRoutes.js`:

- `GET /api/endorse/chat/:id` — fetch token and join channel (described below)
- `DELETE /api/endorse/chat/:id/message/:messageId` — NCS-only hard-delete of a message

**Request:** `GET /api/endorse/chat/:npid` (authenticated)

**Response:**

```json
{
    "message": {
        "token": "eyJ...",
        "userId": "hamlive-abc123",
        "channelId": "net-xyz789",
        "channelType": "messaging",
        "apiKey": "public_api_key"
    }
}
```

The endpoint:

1. Validates the NPID parameter
2. Generates a Stream user ID from the MongoDB user ID
3. Upserts the user in Stream with their callSign and photo
4. Adds the user to the channel (idempotent)
5. Generates and returns a JWT token

**Why add user to channel here?** This is the guaranteed point before the client connects. The presence-based `addChannelMember` may not have run yet due to race conditions, or the user may be returning to a net they visited before.

## Client-side implementation

### Core module: `client/src/public/js/lib/chat.ts`

The primary class is `ChatWidget` (exported as `ChatClient` for backward compatibility). It extends `HTMLElement` and is registered as the `<hl-chat>` custom element. It uses **light DOM** (not Shadow DOM) so that Bootstrap utility classes apply directly.

**Initialization flow:**

1. `ChatWidget.init(store, level)` is called from `liveNet/main.ts` with the `LiveNetReactiveStore` and the user's level from Presence (already resolved — no store wait required).
2. Fetch token from `GET /api/endorse/chat/:npid`. If the server returns `{ enabled: false }` (GetStream not configured), chat initialization is silently skipped.
3. Initialize `StreamChat.getInstance(apiKey)` and connect user with a `tokenProvider` function (for automatic token refresh on expiry).
4. `channel.watch()` to subscribe to real-time events.
5. Subscribe to `liveNetStore` to track role changes during the session.
6. Render UI and load existing messages.

**Key public methods/static:**

- `static init(store, level)` - Replaces `#stream-chat-container` with `<hl-chat>`, then calls `widget.init(store, level)`
- `async init(store, level)` - Instance async initialization
- `async newData()` - `StoreSubscriber` callback; updates moderation buttons if the user's role level changed
- `disconnect()` - Cleans up global event listeners and disconnects the Stream user; called on `beforeunload` and `disconnectedCallback`

### Stream Chat SDK loading

The Stream Chat SDK is **vendored locally** and resolved via importmap in `head.ejs`:

```html
<script type="importmap">
  {
    "imports": {
      "stream-chat": "/js/vendor/stream-chat.9.27.2.mjs"
    }
  }
</script>
```

The same importmap also resolves `immer`. No CDN is required at runtime for either library.

### UI theming

The chat UI uses CSS variables from `main.scss` for consistent theming:

| CSS Variable      | Usage                             |
| ----------------- | --------------------------------- |
| `--hl-primary`    | Primary accent color              |
| `--hl-secondary`  | Username color                    |
| `--hl-tertiary`   | Timestamp color, placeholder text |
| `--hl-quaternary` | Borders, scrollbar                |
| `--hl-light`      | Message text                      |
| `--hl-dark`       | Background                        |

The UI features:

- Dotted borders matching the station table style
- Slack-like message layout
- Inline image sharing button
- Custom scrollbar styling

### Container element

The chat renders into `<div id="stream-chat-container">` in `liveNet.ejs`.

## Configuration

### API credentials

Credentials are read from environment variables in `server/dist/lib/configLib.js`:

```
STREAM_API_KEY=your_public_api_key
STREAM_API_SECRET=your_secret_api_key
```

These overlay `commonConfig.yaml` at startup. If either variable is absent, `getStreamClient()` throws on first use and `getChatToken()` returns `{ enabled: false }` rather than crashing the request.

**Important:** `STREAM_API_SECRET` is never sent to the client. Only `STREAM_API_KEY` (public) is included in the token endpoint response.

### Enabling/disabling chat

Chat can be disabled via `serverInfo.chat` flag. The client checks this before initializing:

```typescript
if (!serverInfo.chat) {
    logger.info('Chat is disabled via serverInfo');
    return;
}
```

## Chat history for reports

When a net closes, the chat history is included in the net close report. The flow:

1. `NetCloseReport.init()` calls `fetchChatLog(npid, since)` in `serverUtils.js`
2. `fetchChatLog()` calls `fetchChatHistory()` from `streamChat.js`
3. `fetchChatHistory()` is an AsyncGenerator that yields message batches
4. Messages are formatted with `username`, `body`, and `createdAt` fields
5. **After** report generation, `closeNet()` calls `deleteNetChannel()`

The AsyncGenerator pattern allows efficient pagination through large chat histories without loading all messages into memory.

## Error handling

### Server-side

- Missing credentials throw on startup via `getStreamClient()`
- Invalid NPID throws in `getChatToken()` and `fetchChatHistory()`
- Channel not found (code 16) is handled gracefully in `deleteNetChannel()`
- All errors are logged via the standard `logger`

### Client-side

- Token fetch failures (or `{ enabled: false }` response) are handled gracefully: chat is silently skipped when GetStream is not configured, or an error message is rendered in the container for unexpected failures.
- Message send failures are logged but don't crash the UI; Stream error code 17 (banned/muted) shows a user-friendly notice.
- Disconnect is called on `beforeunload` for cleanup.
- Global event listeners (document click, beforeunload) are stored and properly removed in `disconnect()` to prevent memory leaks.

## Audit logging

Moderation actions are logged with human-readable callsigns for audit purposes:

| Action          | Log Format                                                                                |
| --------------- | ----------------------------------------------------------------------------------------- |
| Message deleted | `Chat: Message {id} deleted by {moderatorCallsign} in channel {channelId}`                |
| User banned     | `Chat: {targetCallsign} banned by {moderatorCallsign} from {channelId}. Reason: {reason}` |
| User unbanned   | `Chat: {targetCallsign} unbanned by {moderatorCallsign} from {channelId}`                 |

These logs use callsigns (e.g., `W1ABC`) rather than Stream user IDs for readability.

## Notes on prior chat providers

This release uses GetStream.io for chat. Roomlio (a previous embedded-chat provider) and UploadCare (a previous file-upload widget) are **not part of this codebase**. File sharing is handled inline via the Stream SDK's `sendImage()` method.

## Slash commands in chat

NCS and loggers (level ≤ 1) can type net admin commands directly in the chat input box, prefixed with `/`:

| Example | Effect |
| --- | --- |
| `/i W1ABC` | Check in W1ABC |
| `/o W1ABC` | Check out W1ABC |
| `/?` | Show help |

When the client detects a `/`-prefixed message, it does **not** send it to the Stream channel. Instead, it POSTs to:

```
POST /api/admin/interactions/:npid
Body: { cmdLine: "i W1ABC" }
```

Success/error responses are shown as temporary notices in the chat area. A dismissible tip explaining slash commands is shown to eligible users on first connection (dismissed state is persisted with `UserAgentPersistentPreferences`).

## Auto-scroll behavior

The chat auto-scrolls to show new messages, but only if the user is already near the bottom. If the user has scrolled up to read history, new messages won't yank them back down.

### Implementation

```typescript
// In handleNewMessage():
const wasNearBottom = this.isNearBottom();
this.renderMessage(event.message);
if (wasNearBottom) {
    this.scrollToBottom();
}
```

### Critical CSS: Flexbox `min-height: 0`

For auto-scroll to work, the chat container must have a **fixed height with overflow scroll**, not expand infinitely with content. This requires `min-height: 0` on every flex child in the hierarchy.

**Why:** Flex children have an implicit `min-height: auto` which prevents them from shrinking below their content size. Without `min-height: 0`, the container expands to fit all messages instead of scrolling.

**The hierarchy (all need `min-height: 0`):**

```
.height-40vh (liveNet.ejs)        ← Fixed height (40vh), has overflow-y: auto
  └─ .h-100 div                   ← 100% of parent
      └─ #stream-chat-container   ← flex-grow-1, needs min-height: 0 (in local.css)
          └─ <hl-chat>            ← Custom element, needs min-height: 0 (set in connectedCallback)
              └─ .chat-widget     ← h-100 d-flex flex-column, needs min-height: 0 (inline style)
                  └─ .chat-messages  ← flex-grow-1 overflow-auto, needs min-height: 0 (in template)
```

**Symptoms if broken:**

- `scrollHeight === clientHeight` in logs (container expanding, not scrolling)
- Scrollbar gets smaller as messages arrive, but view doesn't scroll
- Manual scroll works, but auto-scroll doesn't

**Files involved:**

- `client/dist/public/css/local.css` - `.chat-container { min-height: 0; }`
- `client/src/public/js/lib/chat.ts` - Element styles in `connectedCallback()`, inline style on `.chat-widget`, CSS rule for `.chat-messages`

## See also

- [Security](security.md) - Token-based authentication and endpoint protection
- [SSE Architecture](sse-architecture.md) - Real-time updates pattern
- [Client Framework](client-framework.md) - Widget and store patterns
- [Shared Net Operations](shared-net-ops.md) - Net lifecycle including close process
