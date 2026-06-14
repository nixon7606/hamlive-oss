# Chat Ban & Account Ban — Moderation UI Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Branch target:** `staging`

## Goal

Give moderators click-driven ways to ban a disruptive user, with optional
time-limited (auto-expiring) bans, in two places:

1. **Net control (NCS):** ban the author of a chat message directly from the
   message, scoped to that net's chat.
2. **Admin (superUser):** ban a user's whole account (block login site-wide)
   from the admin user view.

Both ban types gain an optional **expiration** so a ban can act as a temporary
"timeout" that lifts itself.

## Background — what already exists (reuse, don't rebuild)

- **Per-net chat ban** is fully implemented server-side:
  - `server/dist/models/chatBan.js` — sticky per-net ban (`netProfile`,
    `userProfile`, `callSign`, `reason` (required), `bannedBy`, soft-delete via
    `unbannedAt`/`unbannedBy`, timestamps).
  - `server/dist/lib/localChat.js` — `banUser`, `unbanUser`, `checkIsBanned`,
    `getBannedUsers`. Send is blocked for banned users (`localChat.js:167`).
  - Real-time: `server/dist/lib/sseChat.js` `broadcastBan` emits the `chat-ban`
    SSE event; the client (`client/src/public/js/lib/chat.ts`
    `handleBanEvent`/`updateBanUI`) disables the banned user's input instantly.
  - Today the only way to invoke a ban is the **net-admin chat command**
    `ban <callsign> <reason>` (`server/dist/lib/netAdminCommands/ban.js`,
    `unban.js`), NCS-only. There is no HTTP ban route and no ban button.
  - `GET /api/chat/:id/banned` (NCS-gated) lists active bans.
- **Account lock** exists as a boolean: `UserProfile.locked`
  (`server/dist/models/userProfile.js:85`). The admin user-edit form exposes it
  as a "Locked (banned)" checkbox (`server/dist/views/admin.ejs:206`), saved via
  `adminController.updateUser` (audited `lock-user`/`unlock-user`, with
  self-lockout and last-admin guardrails). Both login flows reject locked
  accounts (`authRoutes.js:97` magic-link, `:199` Google).
- **Known gap:** locking does **not** end an active session — `deserializeUser`
  (`server/dist/server.js:166`) re-reads the user every request but does not
  check `locked`, and `authCheck` does not either. A locked user keeps access
  until their cookie expires (≤3.5 days). This design closes that gap.

## Requirements (decided)

- NCS bans from a **chat message** (not the roster). Button sits beside the
  existing delete button; both gated by `canModerate()`.
- NCS ban opens a **confirm dialog** with an **editable reason** (pre-filled
  default, required) and an **expiration** selector.
- Admin ban is a **one-click Ban/Unban button** = full **account lock**, with an
  optional expiration. Replaces the buried "Locked" checkbox.
- **Expiration** on both ban types: **permanent by default**, optional. Presets
  **Permanent / 1h / 24h / 7d** plus a **Custom** date-time. Expired bans
  **auto-lift** at read time (no background scheduler).
- **Net-control unban stays the existing `unban <callsign>` command** — no
  banned-list UI in this spec.
- Account ban must take effect on the user's **next request** (active-session
  fix) and respect expiration consistently across deserialize + both logins.

## Architecture

Thin entry points over existing logic + a read-time expiry check.

### Data model changes

- `chatBan` (`server/dist/models/chatBan.js`): add
  `expiresAt: { type: Date, default: null }` (null = permanent).
- `UserProfile` (`server/dist/models/userProfile.js`): add
  `lockedUntil: { type: Date, default: null }` (null = permanent while
  `locked === true`).

### Expiry semantics (read-time, no scheduler)

- **Chat:** `checkIsBanned` returns "not banned" when the active ban's
  `expiresAt` is set and `< now`. Query/logic treats `expiresAt: null` OR
  `expiresAt > now` as active. (Stale rows may remain; they are simply inert.)
  `getBannedUsers` (the NCS `GET /banned` list) applies the same expiry filter so
  expired bans don't show as active.
- **Account:** a shared helper `isCurrentlyLocked(user)` returns
  `user.locked === true && (user.lockedUntil == null || user.lockedUntil > now)`.
  Lives in `server/dist/lib/serverUtils.js` and is the single source of truth.

### Net-control chat ban

- **New route:** `POST /api/chat/:id/message/:messageId/ban`
  (`server/dist/routes/chatRoutes.js`), `generalLimiter`,
  `authCheck(REQ_CALLSIGN)`, then `checkUserCanModerate(npid, req.user._id)` (the
  same NCS gate the delete route uses).
  - Body: `{ reason: string, expiresAt?: string|null }`.
  - Handler loads the message, derives `userProfile` + `callSign` from it, then
    calls `banUser({ npid, userProfileId, callSign, reason, expiresAt, bannedBy })`.
  - Guardrail: reject banning oneself; reject if the message has no
    author/account (mirrors the command's checks).
- **`banUser`** (`localChat.js`): accept and persist `expiresAt`.
- **Unban:** unchanged — the existing `unban <callsign>` command.
- **Client** (`client/src/public/js/lib/chat.ts`): in the message actions
  template (where the delete button is rendered under `canModerate()`), add a
  "ban author" button. On click, open a small confirm dialog (reason input
  pre-filled with a default such as "Disruptive behavior"; expiration `<select>`
  Permanent/1h/24h/7d/Custom). Submit → `POST …/ban`. The existing `chat-ban`
  SSE path already disables the target's UI; no extra client enforcement.

### Admin account ban

- **UI** (`server/dist/views/admin.ejs` + `client/src/public/js/byView/admin/main.ts`):
  replace the "Locked (banned)" checkbox with a **Ban / Unban** button. Ban
  prompts for an optional expiration (same presets). The user-list row badge
  shows `Locked` or `Locked until <date>`.
- **Route:** reuse `adminController.updateUser`; add `lockedUntil` to its
  `allowed` field list beside `locked`. Banning sets `locked: true` (+ optional
  `lockedUntil`); unbanning sets `locked: false, lockedUntil: null`. Keep the
  existing audit calls and self-lockout / last-admin guardrails.
- `listUsers` projection (`adminController.js:66`) adds `lockedUntil` so the
  badge can render the date.

### Active-session fix (account ban)

- `deserializeUser` (`server/dist/server.js`): after loading the user, if
  `isCurrentlyLocked(user)` return `done(null, false)` (drops the session; the
  user is bounced to login on the next request, and login also refuses them).
- Magic-link (`authRoutes.js:97`) and Google (`:199`) login checks switch from
  raw `currentUser.locked` to `isCurrentlyLocked(currentUser)` so expiration is
  honored uniformly.

## Permissions, guardrails, audit

- Chat ban → NCS via `checkUserCanModerate`. Account ban → superUser (admin
  routes already enforce superUser).
- Guardrails: cannot ban yourself (both surfaces); account ban keeps the
  last-admin guard so you can't lock the final superUser.
- Audit/attribution: chat ban records `bannedBy` + `reason` on `chatBan`;
  account lock keeps `recordAudit` (`lock-user`/`unlock-user`).

## Testing

- **Server (Jest, `tests/server/lib/localChat.test.js` harness + admin/auth
  tests):**
  - `checkIsBanned`: active ban with future `expiresAt` is banned; with past
    `expiresAt` is not; `null` is permanent.
  - `banUser`: persists `expiresAt`.
  - `POST …/message/:messageId/ban`: NCS-gated; derives user from message; sets
    reason + expiry; rejects self-ban / authorless message.
  - `isCurrentlyLocked`: true/false across `locked` × `lockedUntil` past/future/null.
  - `deserializeUser` + both login flows reject a currently-locked user and
    allow one whose `lockedUntil` has passed.
- **Client:** no jsdom harness — the ban dialog/buttons (NCS message ban; admin
  Ban/Unban) are verified manually on staging.

## Build & deploy notes

- Touches **client TS** (`chat.ts`, `admin/main.ts`) → requires `npm run build`
  and, because it emits to edge-cached `client/dist/public/js/...`, a
  **Cloudflare purge** after deploy.
- Server changes are in `server/dist/*.js` (hand-maintained) + model schemas.
- Ships to `staging` (CT 204) first; promotion to prod follows the existing
  `main`/CT 202 path.

## Known limitations (accepted)

- **Expiry frees server-side, not live in the UI.** Because expiry is read-time
  with no scheduler/broadcast, an expired ban lets the user act again on the
  server immediately, but their client only re-enables on next page load:
  - Chat ban: the banned user's input stays disabled until they reload (no live
    `unban` SSE is pushed at expiry).
  - Account lock: takes effect / lifts on the user's next request.
  This is acceptable for a "timeout" and avoids scheduler infrastructure. A live
  re-enable (timer from `expiresAt`, or an expiry sweep that broadcasts `unban`)
  is a possible later enhancement, not part of this spec.

## Out of scope (separate specs)

- `@mention` to message a user — next feature, its own spec (clarify public ping
  vs. private DM first).
- Other chat features (pinned messages, search, mention/sound notifications,
  link previews, report/flag, slow mode, automod) — prioritized backlog, one
  spec each.
- Net-control banned-list management UI (unban stays command-driven for now).
- Background sweep of expired ban rows (read-time check makes it unnecessary).
