# Chat Self-Delete (Delete Your Own Messages) — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Branch target:** `staging`

## Goal

Let any chat participant delete a message **they authored**, within a
**15-minute** window of sending it. The net control station (NCS) keeps its
existing power to delete **any** message of **any** age. A self-deleted message
**vanishes** for everyone, exactly like an NCS delete does today.

## Scope (decided)

- **Author can delete their own message** for up to **15 minutes** after it was
  sent (`createdAt`). After that, only NCS can delete it.
- **NCS delete is unchanged** — no time limit, any message.
- **Vanish, not tombstone.** Self-delete reuses the existing soft-delete +
  `chat-delete` broadcast, so the message element is removed from every client.
  No "message deleted" placeholder.
- **No new route, no schema change, no new SSE event.** This widens the
  authorization of the existing `deleteMessage` path only.

## Non-goals (out of scope)

- Tombstone / "this message was deleted" placeholder.
- Undo / restore of a deleted message.
- A configurable per-net window (15 minutes is a fixed constant).
- Any change to edit, ban, pin, reactions, or who can post.
- Bulk delete / "delete all my messages".

## Architecture: widen `deleteMessage` authorization

`deleteMessage` (server/dist/lib/localChat.js) currently authorizes NCS only via
`checkUserCanModerate`. Change it to load the message **first**, then authorize
as:

1. `canModerate` (existing NCS check) → allowed, **any age**; or
2. **owner** (`msg.userProfile.toString() === userProfileId.toString()`) →
   allowed only if `Date.now() - msg.createdAt < SELF_DELETE_WINDOW_MS`
   (15 min); otherwise reject with a window error; or
3. neither → existing "insufficient permissions" error.

Everything after authorization (soft-delete `deleted = true` / `pinned = false`,
auto-unpin broadcast, `broadcastDelete`) is **unchanged**. This mirrors how
`editMessage` already authorizes the author
(`if (msg.userProfile.toString() !== user._id.toString()) throw 'not your message'`),
and reuses the existing `createdAt` timestamp (`chatMessage` has
`timestamps: true`; `createdAt` is already exposed in `buildMessagePayload`).

## Components

### 1. Server `deleteMessage` (localChat.js)

Add a module-level constant near the top of the file:

```js
const SELF_DELETE_WINDOW_MS = 15 * 60 * 1000; // authors may delete own msgs for 15 min
```

Rewrite the function body to load + validate the message before authorizing:

```js
async function deleteMessage({ npid, messageId, moderatorCallsign, userProfileId }) {
    const { ChatMessage } = getModels();
    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('Message not found');
    if (msg.netProfile.toString() !== npid.toString()) throw new Error('Message not in this net');

    const canModerate = await checkUserCanModerate(npid, userProfileId);
    const isOwner = !!(msg.userProfile && userProfileId
        && msg.userProfile.toString() === userProfileId.toString());

    if (!canModerate) {
        if (!isOwner) throw new Error('Insufficient permissions: only NCS or the author can delete this message');
        const ageMs = Date.now() - new Date(msg.createdAt).getTime();
        if (ageMs > SELF_DELETE_WINDOW_MS) {
            throw new Error('You can only delete your own messages within 15 minutes of sending');
        }
    }

    const wasPinned = msg.pinned === true;
    msg.deleted = true;
    msg.pinned = false;
    await msg.save();
    logger.info(`Chat: Message ${messageId} deleted by ${moderatorCallsign} in net ${npid}`);
    try {
        chatBroadcaster.broadcastDelete(npid, messageId);
    } catch (e) {
        logger.warn(`Chat: broadcastDelete failed: ${e.message}`);
    }
    if (wasPinned) {
        try {
            chatBroadcaster.broadcastUnpin(npid, { messageId });
        } catch (e) {
            logger.warn(`Chat: broadcastUnpin (on delete) failed: ${e.message}`);
        }
    }
    return { success: true, messageId };
}
```

Note: the message is now loaded before `checkUserCanModerate`, so a "message not
found / not in this net" error is returned even to a non-NCS caller — this is
fine (no information leak beyond message existence in the net the caller is in).

### 2. Route (chatRoutes.js)

**No change.** `DELETE /api/chat/:id/message/:messageId` already passes
`userProfileId` and `moderatorCallsign` (the caller's callsign) from `req.user`
into `deleteMessage`. The route stays `generalLimiter` + `authCheck(REQ_CALLSIGN)`.

### 3. Client (chat.ts)

The client already computes `isOwnMessage = msg.userId === this.currentUserId`
and renders an edit button for own messages. The delete button is the parallel.

- **New helper** (pure, on the widget or as a module helper):

  ```ts
  private withinSelfDeleteWindow(createdAt: string | undefined): boolean {
      if (!createdAt) return false;
      const ts = new Date(createdAt).getTime();
      if (Number.isNaN(ts)) return false;
      return Date.now() - ts < 15 * 60 * 1000;
  }
  ```

- **Render (`renderMessage`):** show `.chat-delete-btn` when
  `this.canModerate() || (isOwnMessage && this.withinSelfDeleteWindow(msg.createdAt))`.
  Keep a single `.chat-delete-btn` element (do not render two when an NCS views
  their own message). The existing `chat-mod-btn` class may stay on the NCS path;
  the self-delete path uses the same `.chat-delete-btn` hook so the existing
  click wiring applies unchanged.

- **Role-change add/remove block** (the `canModerate()` handler that
  adds/removes the trash button on role change): update its condition so it does
  **not** strip the trash button off the user's **own recent** messages when the
  user is not a moderator. I.e. a message keeps its delete button when
  `canMod || (isOwnMessage && withinSelfDeleteWindow)`.

- **`deleteMessage(messageId)` client method:** change the early-return guard
  from `if (!this.canModerate())` to allow the author too — attempt the delete
  when the caller is a moderator **or** the message is their own; let the server
  make the final authorization decision.

- **Confirm dialog** stays `"Delete this message?"`.

- **Server rejection** (e.g. too old): surface a clear notice via the existing
  `showChatNotice(...)`, e.g. "Couldn't delete — you can only delete your own
  messages within 15 minutes."

## Data flow

Author clicks trash → `connection.deleteMessage(id)` →
`DELETE /api/chat/:id/message/:messageId` → server `deleteMessage` authorizes
(owner + 15-min window, or NCS) → soft-delete + `broadcastDelete` → all clients
remove the message element. Identical to the NCS path downstream of
authorization.

## Edge cases

- **Own pinned message:** the existing auto-unpin path fires (bar clears for
  all). Unchanged.
- **Legacy/anonymous message with no `userProfile`:** not owned by anyone →
  only NCS can delete (owner check is false).
- **Borderline age:** a message rendered while still within the window may still
  show the trash button after it crosses 15 minutes (no re-render on a timer).
  Clicking it then fails server-side and shows the notice — acceptable; no stale
  delete succeeds.
- **NCS deleting:** unaffected, no time limit, works on any message/age.
- **Owner deleting another user's message:** rejected (owner check false,
  `canModerate` false).

## Testing

**Server (Jest)** — `tests/` alongside existing chat tests:
- Owner can delete their own message within the window (sets `deleted = true`,
  broadcasts `chat-delete`).
- Owner is **rejected** deleting their own message older than the window
  (throws the 15-minute error; message NOT deleted).
- Owner is **rejected** deleting a message authored by someone else.
- NCS can delete any message regardless of age (including > 15 min old).
- A caller who is neither owner nor NCS is rejected.
- Deleting one's own **pinned** message also broadcasts `chat-unpin`.
- Deleting a non-existent / wrong-net message throws before authorization side
  effects.

**Client** — manual on staging (DOM-heavy; no jsdom harness):
- Trash icon appears on your own recent messages and removes the message for
  everyone when clicked.
- No trash icon on other people's messages (unless you are NCS).
- Trash icon absent on your own messages older than 15 min (loaded from
  history).
- NCS still sees trash on every message.

If `withinSelfDeleteWindow` is extracted as a pure module helper (no DOM), add a
`tests/client/**/*.test.ts` unit test (in-window true, out-of-window false,
missing/invalid `createdAt` false) using the existing `client` ts-jest project.

## Build & deploy

Server (`localChat.js`) + client (`chat.ts`). Client TS → `npm run build`;
client JS is edge-cached → **Cloudflare purge** on deploy. Ships to `staging`
first, then promotes to `main`/prod via the usual path
(see hamlive-prod-promotion).
