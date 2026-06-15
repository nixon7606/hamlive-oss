# Chat Pinned Message — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Branch target:** `staging`

## Goal

Let the net control station (NCS) pin one chat message to a bar at the top of
the chat so everyone — including latecomers — sees the net's key info
(frequency, rules, announcement) without scrolling.

## Scope (decided)

- **One pinned message per net at a time.** Pinning a new message replaces the
  previously pinned one.
- **NCS-only** to pin/unpin (gated by `checkUserCanModerate`, the same gate as
  delete/ban). Everyone **sees** the pinned bar.
- **Persistent** — the pin is a flag on the message, so it survives reloads,
  late joiners, and even net restarts, until explicitly unpinned (or the pinned
  message is deleted).
- Pins are **public**, so there is no NCS-only payload filtering (unlike the
  report feature).

## Non-goals (out of scope)

- Multiple simultaneous pins / a pinned list.
- Pin history or audit trail.
- Auto-clearing pins when a net closes (a pin persists until unpinned/deleted).
- Any change to who can post/react/reply.

## Architecture: a `pinned` boolean on the message

Add `pinned: Boolean` (default `false`) to `ChatMessage`. Pinning sets the
target message's `pinned = true` and clears `pinned` on every other message in
the net (enforces single-pin); unpinning clears it. The current pinned message
is found with a trivial query (`{ netProfile, pinned: true, deleted: false }`).
This mirrors the reactions/report per-message-marker pattern.

## Components

### 1. Model
`server/dist/models/chatMessage.js`: add `pinned: { type: Boolean, default: false }`.

### 2. Server `pinMessage` / `unpinMessage` (localChat.js)
- `pinMessage({ npid, messageId, moderator })`: NCS-gate via
  `checkUserCanModerate(npid, moderator.userProfileId)`; load the message
  (validate it's in this net, not deleted); set `pinned = true`; in the SAME
  operation clear `pinned` on all OTHER messages in the net
  (`ChatMessage.updateMany({ netProfile: npid, _id: { $ne: messageId }, pinned: true }, { pinned: false })`);
  broadcast `chat-pin` with the pinned message's payload (built via
  `buildMessagePayload`). Returns the pinned payload.
- `unpinMessage({ npid, messageId, moderator })`: NCS-gate; set the message's
  `pinned = false`; broadcast `chat-unpin` `{ messageId }`.

### 3. Broadcast helpers (sseChat.js)
Add `broadcastPin(npid, data)` → `instance.send(data, 'chat-pin')` and
`broadcastUnpin(npid, data)` → `instance.send(data, 'chat-unpin')`. (Same shape
as the existing `broadcastUpdate`/`broadcastDelete` helpers.)

### 4. Routes (chatRoutes.js)
- `POST /api/chat/:id/message/:messageId/pin` — `generalLimiter`,
  `authCheck(REQ_CALLSIGN)`; calls `pinMessage` with `moderator` from `req.user`.
- `POST /api/chat/:id/message/:messageId/unpin` — same gating; calls
  `unpinMessage`.
(NCS enforcement is inside `pinMessage`/`unpinMessage`, mirroring how
`banFromMessage` self-checks `checkUserCanModerate`.)

### 5. Load (getChatSession)
`getChatSession` (server) includes the current pinned message (query
`pinned: true` for the net, build its payload) as `pinnedMessage` (or `null`).
So a client that joins/reloads renders the bar immediately without a separate
request.

### 6. Delete interaction (deleteMessage)
In `deleteMessage`, if the message being deleted has `pinned === true`, also
broadcast `chat-unpin` `{ messageId }` so the pinned bar clears (no orphan bar).

### 7. Client (chat.ts + localChat.ts)
- **Pinned bar:** a bar at the top of the chat messages area showing the pinned
  message — callsign + text rendered through the existing `renderMessageBody`
  (so `@mentions` and links render correctly). The bar shows an **unpin (✕)**
  control **only for NCS** (`canModerate()`). Clicking the bar body scrolls to /
  briefly highlights the original message if it's loaded (nice-to-have; no-op if
  not loaded).
- **Pin / Unpin action** in the message actions row, NCS-only (next to
  delete/ban): a pin icon; if the message is currently pinned it shows "unpin".
- **State:** the bar renders from `getChatSession().pinnedMessage` on load, and
  updates live on `chat-pin` (set/replace the bar) and `chat-unpin` (clear the
  bar) SSE events.
- `localChat.ts`: `pinMessage(messageId)` / `unpinMessage(messageId)` POST
  helpers (mirror `banFromMessage`); add `chat-pin`/`chat-unpin` listeners that
  emit `pin`/`unpin` events the widget handles.

## Data flow
NCS clicks pin → `POST …/pin` → `pinMessage` sets `pinned`, clears others,
broadcasts `chat-pin {payload}` → all clients render the bar. Unpin (or deleting
the pinned message) → `chat-unpin {messageId}` → all clients clear the bar. New
joiners get it from `getChatSession().pinnedMessage`.

## Edge cases
- Pinning when another message is pinned → previous is cleared (single-pin
  enforced by the `updateMany`).
- Deleting the pinned message → auto-unpin broadcast (bar clears).
- Unpin a message that isn't pinned → no-op (idempotent).
- Pinned message text is rendered with `renderMessageBody` (escaped → chips/
  links), so it's XSS-safe and consistent with inline messages.
- Non-NCS attempting pin/unpin → rejected server-side (`checkUserCanModerate`),
  and the pin/unpin controls aren't rendered for them client-side.

## Testing
- **Server (Jest):** `pinMessage` sets `pinned` + clears any prior pin
  (single-pin), is NCS-gated (non-NCS rejected), broadcasts `chat-pin`;
  `unpinMessage` clears + broadcasts `chat-unpin`; deleting a pinned message
  broadcasts `chat-unpin`; `getChatSession` returns the current `pinnedMessage`.
- **Client:** manual on staging (no jsdom for the DOM-heavy bar) — pin shows the
  bar for all; replacing the pin swaps the bar; unpin/delete clears it; only NCS
  sees pin/unpin controls; reload still shows the pin.

## Build & deploy
Server (`localChat.js`, `sseChat.js`, `chatRoutes.js`, model) + client
(`chat.ts`, `localChat.ts`). Client TS → `npm run build`; client JS is
edge-cached → **Cloudflare purge** on deploy. Ships to `staging` first, then
promotes to `main`/prod via the usual path.
