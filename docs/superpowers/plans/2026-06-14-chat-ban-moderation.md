# Chat Ban & Account Ban — Moderation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add click-driven ban controls — "ban author" on a chat message (NCS) and "Ban/Unban" on a user in admin (account lock) — both with optional auto-expiring durations, plus an active-session fix so account bans take effect immediately.

**Architecture:** Reuse the existing `chatBan` model, `banUser`/`unbanUser`/`checkIsBanned`, the `locked` flag, and the `chat-ban` SSE path. Add two schema fields (`chatBan.expiresAt`, `UserProfile.lockedUntil`), a read-time expiry check (no scheduler), one new HTTP route (`POST …/message/:messageId/ban`) backed by a testable `banFromMessage` helper, a shared `isCurrentlyLocked` helper wired into `deserializeUser` + both login flows, and ban UI in the chat widget and admin modal.

**Tech Stack:** Node/Express, Mongoose, EJS, vanilla TS client (compiled `client/src` → `client/dist`), Jest. Server runtime files are hand-maintained JS under `server/dist/`. Client TS under `client/src/` requires `npm run build`.

**Conventions for this plan:**
- Run the full server test suite with `npx jest` (there is no `npm test` script). The pre-existing `localChat uploadImage › accepts valid image` failure is unrelated — ignore it.
- Server edits go directly in `server/dist/**/*.js`. Client edits go in `client/src/**/*.ts` and require `npm run build`.
- Tasks 1–3, 5–7 are server (Jest-testable, TDD). Tasks 4 and 8 are client (no jsdom harness) — implement, build, then verify manually on staging.

---

## Task 1: chatBan `expiresAt` field + `banUser` persistence (write side)

**Files:**
- Modify: `server/dist/models/chatBan.js` (add `expiresAt`)
- Modify: `server/dist/lib/localChat.js` (`banUser` ~407)
- Modify: `tests/server/lib/localChat.test.js` (test schema ~36, ban describe block ~330)

- [ ] **Step 1: Add `expiresAt` to the test schema**

In `tests/server/lib/localChat.test.js`, the `testChatBanSchema` (~line 36) must mirror the real schema. Add the field (place it next to `unbannedAt`):

```js
  expiresAt: { type: Date, default: null },
```

- [ ] **Step 2: Write a failing persistence test**

Add to the existing `describe('banUser / checkIsBanned …')` block (after the `unbanUser removes ban` test, ~line 358):

```js
  test('banUser persists expiresAt', async () => {
    const when = new Date(Date.now() + 3600_000);
    const ban = await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: when
    });
    expect(ban.expiresAt).toBeTruthy();
    expect(new Date(ban.expiresAt).getTime()).toBe(when.getTime());
  });
```

- [ ] **Step 3: Run it, verify FAIL**

Run: `npx jest tests/server/lib/localChat.test.js -t "persists expiresAt"`
Expected: FAIL — `ban.expiresAt` is `undefined`/`null` (param ignored today).

- [ ] **Step 4: Add `expiresAt` to the real schema**

In `server/dist/models/chatBan.js`, inside `chatBanSchema` fields (after the `unbannedBy` block, before the closing `}` of the fields object), add:

```js
        // Optional expiry — when set and in the past, the ban is inert (auto-lifts).
        // null = permanent.
        expiresAt: {
            type: Date,
            default: null
        },
```

- [ ] **Step 5: Accept and persist `expiresAt` in `banUser`**

In `server/dist/lib/localChat.js`, change the `banUser` signature, the existing-ban check (so an expired prior ban no longer blocks a re-ban), and the `new ChatBan({...})` construction:

```js
async function banUser({ npid, userProfileId, callSign, reason, bannedBy, expiresAt = null }) {
    const { ChatBan } = getModels();

    // Check for existing active ban (an expired prior ban does not block re-ban)
    const existing = await ChatBan.findOne({
        netProfile: npid,
        userProfile: userProfileId,
        unbannedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    });
    if (existing) {
        throw new Error(`banUser(): ${callSign} is already banned`);
    }

    const ban = new ChatBan({
        netProfile: npid,
        userProfile: userProfileId,
        callSign: callSign.toUpperCase(),
        reason: reason || 'No reason given',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        bannedBy: {
            callSign: bannedBy.callSign,
            userProfile: bannedBy.userProfile
        }
    });

    const saved = await ban.save();
    logger.info(`Chat: ${callSign} banned from net ${npid} by ${bannedBy.callSign}. Reason: ${reason}`);

    // Broadcast ban event via SSE so clients can react
    chatBroadcaster.broadcastCustom(npid, {
        type: 'ban',
        callSign: callSign.toUpperCase(),
        reason: reason || 'No reason given',
        bannedBy: bannedBy.callSign
    }, 'chat-ban');

    return saved;
}
```

- [ ] **Step 6: Run it, verify PASS**

Run: `npx jest tests/server/lib/localChat.test.js -t "persists expiresAt"`
Expected: PASS. (Run `npx jest tests/server/lib/localChat.test.js` to confirm the existing ban tests still pass.)

- [ ] **Step 7: Commit**

```bash
git add server/dist/models/chatBan.js server/dist/lib/localChat.js tests/server/lib/localChat.test.js
git commit -m "feat(chat): persist optional expiresAt on chat bans"
```

---

## Task 2: Filter expired bans at read time (`checkIsBanned` + `getBannedUsers`)

**Files:**
- Modify: `server/dist/lib/localChat.js` (`checkIsBanned` ~393, `getBannedUsers` ~482)
- Test: `tests/server/lib/localChat.test.js`

> Depends on Task 1 (the `expiresAt` field + `banUser` persistence). Do Task 1 first.

- [ ] **Step 1: Write failing read-side tests**

Add to the same ban describe block in `tests/server/lib/localChat.test.js`:

```js
  test('checkIsBanned ignores an expired ban', async () => {
    await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: new Date(Date.now() - 60_000) // expired 1 min ago
    });
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).toBeNull();
  });

  test('checkIsBanned honors a future-dated ban', async () => {
    await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: new Date(Date.now() + 60_000) // expires in 1 min
    });
    const result = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(result).not.toBeNull();
  });

  test('getBannedUsers excludes expired bans', async () => {
    await localChat.banUser({
      npid, userProfileId: userId, callSign: 'KD5SPR', reason: 'Spam',
      bannedBy: { callSign: 'NCS001', userProfile: ncsId },
      expiresAt: new Date(Date.now() - 60_000)
    });
    const bans = await localChat.getBannedUsers(npid);
    expect(bans).toHaveLength(0);
  });
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx jest tests/server/lib/localChat.test.js -t "ignores an expired|excludes expired"`
Expected: FAIL — `checkIsBanned`/`getBannedUsers` don't filter on `expiresAt` yet, so the expired ban is still returned (non-null / length 1). (The "future-dated" test passes already and is a regression guard.)

- [ ] **Step 3: Add the expiry filter**

In `server/dist/lib/localChat.js`, replace `checkIsBanned` (~393):

```js
async function checkIsBanned({ npid, userProfileId }) {
    const { ChatBan } = getModels();
    const activeBan = await ChatBan.findOne({
        netProfile: npid,
        userProfile: userProfileId,
        unbannedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).lean();
    return activeBan || null;
}
```

And in `getBannedUsers` (~482), add the same `$or` to the query and include `expiresAt` in the mapped output:

```js
async function getBannedUsers(npid) {
    const { ChatBan } = getModels();
    const bans = await ChatBan.find({
        netProfile: npid,
        unbannedAt: null,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).sort({ createdAt: -1 }).lean();

    return bans.map(b => ({
        id: b._id.toString(),
        callSign: b.callSign,
        reason: b.reason,
        bannedBy: b.bannedBy.callSign,
        bannedAt: b.createdAt.toISOString(),
        expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null
    }));
}
```

- [ ] **Step 4: Run, verify PASS, then full suite**

Run: `npx jest tests/server/lib/localChat.test.js -t "ignores an expired|future-dated|excludes expired"`
Expected: PASS.
Then: `npx jest` → all pass except the known `uploadImage` failure.

- [ ] **Step 5: Commit**

```bash
git add server/dist/lib/localChat.js tests/server/lib/localChat.test.js
git commit -m "feat(chat): auto-lift expired chat bans at read time"
```

---

## Task 3: `banFromMessage` helper + `POST …/message/:messageId/ban` route

**Files:**
- Modify: `server/dist/lib/localChat.js` (new `banFromMessage`, add to `module.exports`)
- Modify: `server/dist/routes/chatRoutes.js` (new route + import)
- Test: `tests/server/lib/localChat.test.js`

- [ ] **Step 1: Write failing tests for `banFromMessage`**

Add a new describe block to `tests/server/lib/localChat.test.js` (after the ban block):

```js
describe('banFromMessage()', () => {
  test('NCS bans the author of a message', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'spammy' });
    const result = await localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'Disruptive',
      moderator: { callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId }
    });
    expect(result.callSign).toBe('KD5SPR');
    const banned = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(banned).not.toBeNull();
    expect(banned.reason).toBe('Disruptive');
  });

  test('non-moderator cannot ban', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'hi' });
    await expect(localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'x',
      moderator: { callSign: 'KD5SPR', userProfile: userId, userProfileId: userId }
    })).rejects.toThrow(/only NCS|permission/i);
  });

  test('cannot ban yourself', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockNcs(), text: 'mine' });
    await expect(localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'x',
      moderator: { callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId }
    })).rejects.toThrow(/yourself/i);
  });

  test('passes expiresAt through to the ban', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'spammy' });
    const when = new Date(Date.now() + 3600_000).toISOString();
    await localChat.banFromMessage({
      npid, messageId: msg.id, reason: 'Disruptive', expiresAt: when,
      moderator: { callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId }
    });
    const banned = await localChat.checkIsBanned({ npid, userProfileId: userId });
    expect(new Date(banned.expiresAt).getTime()).toBe(new Date(when).getTime());
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx jest tests/server/lib/localChat.test.js -t "banFromMessage"`
Expected: FAIL — `localChat.banFromMessage is not a function`.

- [ ] **Step 3: Implement `banFromMessage`**

In `server/dist/lib/localChat.js`, add after `banUser` (and add `banFromMessage` to the `module.exports` object):

```js
/**
 * Ban the author of a message from a net's chat (NCS only).
 * Derives the target user from the message itself.
 */
async function banFromMessage({ npid, messageId, reason, expiresAt = null, moderator }) {
    const { ChatMessage } = getModels();
    const canModerate = await checkUserCanModerate(npid, moderator.userProfileId);
    if (!canModerate) throw new Error('Insufficient permissions: only NCS can ban');

    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('Message not found');
    if (msg.netProfile.toString() !== npid.toString()) throw new Error('Message not in this net');
    if (!msg.userProfile) throw new Error('Message author has no account');

    const targetUserProfileId = msg.userProfile.toString();
    if (targetUserProfileId === moderator.userProfileId.toString()) {
        throw new Error('You cannot ban yourself');
    }

    return banUser({
        npid,
        userProfileId: targetUserProfileId,
        callSign: msg.callSign || 'UNKNOWN',
        reason: reason || 'No reason given',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        bannedBy: { callSign: moderator.callSign, userProfile: moderator.userProfile }
    });
}
```

Add to `module.exports` (alongside `banUser`):

```js
    banFromMessage,
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx jest tests/server/lib/localChat.test.js -t "banFromMessage"`
Expected: PASS (all 4).

- [ ] **Step 5: Add the HTTP route**

In `server/dist/routes/chatRoutes.js`, add `banFromMessage` to the destructured import from `../lib/localChat` (the `const { … } = require('../lib/localChat')` block ~line 14):

```js
    banFromMessage,
```

Then add the route after the DELETE message route (~line 193), before the `GET …/banned` route:

```js
// ============================================================================
// POST /api/chat/:id/message/:messageId/ban — Ban the message author (NCS only)
// ============================================================================
router.post('/:id/message/:messageId/ban', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const { reason, expiresAt } = req.body || {};
        const result = await banFromMessage({
            npid,
            messageId,
            reason: typeof reason === 'string' ? reason.slice(0, 200) : 'No reason given',
            expiresAt: expiresAt || null,
            moderator: {
                callSign: req.user.callSign || 'unknown',
                userProfile: req.user._id,
                userProfileId: req.user._id.toString()
            }
        });
        return { message: { banned: result.callSign } };
    }, `banFromMessage(): ${req.user?.callSign} banned author of ${req.params.messageId}`);
});
```

- [ ] **Step 6: Run full suite**

Run: `npx jest`
Expected: all pass except the known `uploadImage` failure.

- [ ] **Step 7: Commit**

```bash
git add server/dist/lib/localChat.js server/dist/routes/chatRoutes.js tests/server/lib/localChat.test.js
git commit -m "feat(chat): banFromMessage helper + POST message ban route (NCS)"
```

---

## Task 4: Client — "ban author" button + dialog (chat widget)

**Files:**
- Modify: `client/src/public/js/lib/localChat.ts` (new connection method)
- Modify: `client/src/public/js/lib/chat.ts` (button in template + `updateModerationButtons`, dialog, expiry)
- Modify: `client/src/public/js/lib/clientUtils.ts` (shared expiry helper)

> No jsdom test harness exists for client code. Implement, `npm run build`, then verify on staging (Task 9).

- [ ] **Step 1: Add a shared expiry helper in `clientUtils.ts`**

Append to `client/src/public/js/lib/clientUtils.ts`:

```ts
/**
 * Convert a ban-duration preset into an ISO expiry string (or null = permanent).
 * preset: 'permanent' | '1h' | '24h' | '7d' | 'custom'
 * customIso: a datetime-local value when preset === 'custom'
 */
export function expiryFromPreset(preset: string, customIso?: string): string | null {
    const now = Date.now();
    switch (preset) {
        case '1h': return new Date(now + 3600_000).toISOString();
        case '24h': return new Date(now + 24 * 3600_000).toISOString();
        case '7d': return new Date(now + 7 * 24 * 3600_000).toISOString();
        case 'custom': {
            if (!customIso) return null;
            const d = new Date(customIso);
            return isNaN(d.getTime()) ? null : d.toISOString();
        }
        default: return null; // permanent
    }
}
```

- [ ] **Step 2: Add the `banFromMessage` connection method**

In `client/src/public/js/lib/localChat.ts`, after the `toggleReaction` method (~line 269), add:

```ts
    /**
     * Ban the author of a message from this net's chat (NCS only).
     */
    async banFromMessage(messageId: string, reason: string, expiresAt: string | null): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/ban`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, expiresAt })
            });
            return res.ok;
        } catch (err) {
            logger.error('Failed to ban from message:', err);
            return false;
        }
    }
```

- [ ] **Step 3: Render the ban button beside delete in the message template**

In `client/src/public/js/lib/chat.ts`, find the `moderateBtn` definition (~line 525):

```ts
        const moderateBtn = this.canModerate()
            ? `<button class="chat-action-btn chat-mod-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
            : '';
```

Replace with (adds a ban button when the message has an author other than self):

```ts
        const moderateBtn = this.canModerate()
            ? `<button class="chat-action-btn chat-mod-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
              + (msg.userId && msg.userId !== this.currentUserId
                  ? `<button class="chat-action-btn chat-mod-btn chat-ban-btn" title="Ban author"><i class="bi bi-slash-circle"></i></button>`
                  : '')
            : '';
```

- [ ] **Step 4: Wire the ban button in `setupMessageActions`**

In `setupMessageActions` (~line 717), after the delete-button wiring (~line 775-779), add:

```ts
        const banBtn = msgEl.querySelector('.chat-ban-btn');
        banBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const callSign = msgEl.querySelector('.chat-username')?.textContent || 'this user';
            this.showBanDialog(messageId, callSign);
        });
```

- [ ] **Step 5: Wire the ban button in `updateModerationButtons`**

In `updateModerationButtons` (~line 1303), the loop adds a delete button when `canMod && !existingDeleteBtn`. Inside the same `if (canMod && !existingDeleteBtn) { … }` block, after `actionsContainer.appendChild(deleteBtn);`, add a sibling ban button:

```ts
                const msgUserId = (msgEl as HTMLElement).dataset['userId'];
                if (msgUserId && msgUserId !== this.currentUserId && !actionsContainer.querySelector('.chat-ban-btn')) {
                    const banBtn = document.createElement('button');
                    banBtn.className = 'chat-action-btn chat-mod-btn chat-ban-btn';
                    banBtn.title = 'Ban author';
                    banBtn.innerHTML = '<i class="bi bi-slash-circle"></i>';
                    banBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        const messageId = (msgEl as HTMLElement).dataset['messageId'];
                        const callSign = msgEl.querySelector('.chat-username')?.textContent || 'this user';
                        if (messageId) this.showBanDialog(messageId, callSign);
                    });
                    actionsContainer.appendChild(banBtn);
                }
```

And in the `else if (!canMod && existingDeleteBtn)` branch, also remove any ban button:

```ts
                actionsContainer.querySelector('.chat-ban-btn')?.remove();
```

> Requires `data-user-id` on the message element. Confirm the message element sets `dataset.userId` when rendered; if it only sets `data-message-id`, add `msgEl.dataset['userId'] = msg.userId || ''` where the element is created (in the message render path, near where `data-message-id` is assigned). Check `addMessageToDOM`/render (~line 499) and add it if missing.

- [ ] **Step 6: Add the `showBanDialog` method + import the expiry helper**

Add `expiryFromPreset` to the existing import from `clientUtils.js` at the top of `chat.ts`, then add this method near `showLightbox` (~line 1545):

```ts
    private showBanDialog(messageId: string, callSign: string): void {
        const overlay = document.createElement('div');
        overlay.className = 'chat-ban-dialog';
        overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999; display: flex; align-items: center; justify-content: center;';
        overlay.innerHTML = `
            <div style="background: var(--hl-dark, #1f2733); color: var(--hl-light); padding: 16px; border-radius: 6px; width: 320px; max-width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
                <div style="font-weight: 600; margin-bottom: 8px;">Ban ${callSign} from chat</div>
                <label style="font-size: 12px;">Reason</label>
                <input class="ban-reason" type="text" value="Disruptive behavior" maxlength="200"
                    style="width: 100%; margin: 4px 0 10px; padding: 6px; border-radius: 4px; border: 1px solid #444; background:#11161d; color:#fff;">
                <label style="font-size: 12px;">Duration</label>
                <select class="ban-duration" style="width: 100%; margin: 4px 0 8px; padding: 6px; border-radius: 4px;">
                    <option value="permanent">Permanent</option>
                    <option value="1h">1 hour</option>
                    <option value="24h">24 hours</option>
                    <option value="7d">7 days</option>
                    <option value="custom">Custom…</option>
                </select>
                <input class="ban-custom" type="datetime-local" style="width: 100%; margin-bottom: 10px; padding: 6px; display: none;">
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="ban-cancel" style="padding: 6px 12px;">Cancel</button>
                    <button class="ban-confirm" style="padding: 6px 12px; background:#dc3545; color:#fff; border:none; border-radius:4px;">Ban</button>
                </div>
            </div>`;
        const close = () => overlay.remove();
        const durationSel = overlay.querySelector<HTMLSelectElement>('.ban-duration')!;
        const customInput = overlay.querySelector<HTMLInputElement>('.ban-custom')!;
        durationSel.addEventListener('change', () => {
            customInput.style.display = durationSel.value === 'custom' ? 'block' : 'none';
        });
        overlay.querySelector('.ban-cancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('.ban-confirm')?.addEventListener('click', () => {
            const reason = overlay.querySelector<HTMLInputElement>('.ban-reason')!.value.trim() || 'No reason given';
            const expiresAt = expiryFromPreset(durationSel.value, customInput.value);
            close();
            void this.banAuthor(messageId, reason, expiresAt);
        });
        document.body.appendChild(overlay);
    }

    private async banAuthor(messageId: string, reason: string, expiresAt: string | null): Promise<void> {
        if (!this.connection) return;
        const ok = await this.connection.banFromMessage(messageId, reason, expiresAt);
        this.showChatNotice(ok ? 'User banned from chat.' : 'Failed to ban user.');
    }
```

- [ ] **Step 7: Build the client**

Run: `npm run build`
Expected: exit 0 (tsc clean for both server and client configs).

- [ ] **Step 8: Confirm compiled output contains the new code**

Run: `grep -c "banFromMessage" client/dist/public/js/lib/chat.js client/dist/public/js/lib/localChat.js`
Expected: non-zero counts in both.

- [ ] **Step 9: Commit**

```bash
git add client/src/public/js/lib/chat.ts client/src/public/js/lib/localChat.ts client/src/public/js/lib/clientUtils.ts client/dist/public/js/lib/
git commit -m "feat(chat): ban-author button + dialog (reason + expiry) for NCS"
```

---

## Task 5: `UserProfile.lockedUntil` + `isCurrentlyLocked` helper

**Files:**
- Modify: `server/dist/models/userProfile.js` (~line 85)
- Modify: `server/dist/lib/serverUtils.js` (new helper + export ~677)
- Test: `tests/server/security/qolHardening.test.js` (existing security test file) OR a new `tests/server/lib/serverUtils.test.js`

- [ ] **Step 1: Add `lockedUntil` to the schema**

In `server/dist/models/userProfile.js`, immediately after `locked: { type: Boolean, default: false },` (~line 85), add:

```js
        lockedUntil: { type: Date, default: null },
```

- [ ] **Step 2: Write failing tests for `isCurrentlyLocked`**

Create `tests/server/lib/serverUtils.test.js`:

```js
const { isCurrentlyLocked } = require('../../../server/dist/lib/serverUtils');

describe('isCurrentlyLocked()', () => {
  test('not locked → false', () => {
    expect(isCurrentlyLocked({ locked: false, lockedUntil: null })).toBe(false);
  });
  test('locked, no expiry → true (permanent)', () => {
    expect(isCurrentlyLocked({ locked: true, lockedUntil: null })).toBe(true);
  });
  test('locked, future expiry → true', () => {
    expect(isCurrentlyLocked({ locked: true, lockedUntil: new Date(Date.now() + 60_000) })).toBe(true);
  });
  test('locked, past expiry → false (auto-lifted)', () => {
    expect(isCurrentlyLocked({ locked: true, lockedUntil: new Date(Date.now() - 60_000) })).toBe(false);
  });
  test('null/undefined user → false', () => {
    expect(isCurrentlyLocked(null)).toBe(false);
    expect(isCurrentlyLocked(undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `npx jest tests/server/lib/serverUtils.test.js`
Expected: FAIL — `isCurrentlyLocked is not a function`.

- [ ] **Step 4: Implement the helper**

In `server/dist/lib/serverUtils.js`, add (place it just above `const authCheck = …` ~line 594):

```js
/**
 * True when a user account is currently locked/banned, honoring an optional
 * lockedUntil expiry (a past lockedUntil auto-lifts the lock). Single source of
 * truth used by deserializeUser and the login strategies.
 */
const isCurrentlyLocked = user => {
    if (!user || !user.locked) return false;
    if (!user.lockedUntil) return true; // permanent
    return new Date(user.lockedUntil).getTime() > Date.now();
};
```

Add `isCurrentlyLocked,` to the `module.exports` object (~line 682, next to `authCheck`).

- [ ] **Step 5: Run, verify PASS**

Run: `npx jest tests/server/lib/serverUtils.test.js`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add server/dist/models/userProfile.js server/dist/lib/serverUtils.js tests/server/lib/serverUtils.test.js
git commit -m "feat(auth): lockedUntil field + isCurrentlyLocked helper (expiring account locks)"
```

---

## Task 6: Enforce lock everywhere — `deserializeUser` + both login flows

**Files:**
- Modify: `server/dist/server.js` (`deserializeUser` ~165)
- Modify: `server/dist/routes/authRoutes.js` (magic-link ~97, Google ~199)

> `deserializeUser`/passport integration isn't unit-tested here; the logic lives in the Task 5 helper (already tested). Verify behavior manually on staging (Task 9). Make the edits and confirm the suite still passes.

- [ ] **Step 1: Reject currently-locked users in `deserializeUser`**

In `server/dist/server.js`, the file already requires server utils; ensure `isCurrentlyLocked` is imported. Find the existing destructure from `./lib/serverUtils` (it imports `cookieSessionKeepAlive`, `cookieSessionStubs`, etc. ~line 18-20) and add `isCurrentlyLocked` to it. Then replace `deserializeUser` (~165):

```js
passport.deserializeUser((id, done) => {
    UserProfile.findById(id).then(user => {
        if (isCurrentlyLocked(user)) {
            // Account banned → drop the session immediately (takes effect next request).
            return done(null, false);
        }
        done(null, user);
    }).catch(err => {
        logger.error(`deserializeUser error for id ${id}: ${err.message}`);
        done(err, null);
    });
});
```

- [ ] **Step 2: Honor expiry in the magic-link login flow**

In `server/dist/routes/authRoutes.js`, add near the top imports: `const { wellFormedCall, isCurrentlyLocked } = require('../lib/serverUtils');` — if `wellFormedCall` is already imported from there, just add `isCurrentlyLocked` to that destructure (do not create a duplicate `require`). Then change the magic-link check (~line 97) from `if (currentUser.locked) {` to:

```js
                if (isCurrentlyLocked(currentUser)) {
```

- [ ] **Step 3: Honor expiry in the Google login flow**

In the same file, change the Google check (~line 199) from `if (currentUser.locked) {` to:

```js
                    if (isCurrentlyLocked(currentUser)) {
```

- [ ] **Step 4: Run full suite + sanity-load the server module**

Run: `npx jest`
Expected: all pass except the known `uploadImage` failure.
Run: `node -e "require('./server/dist/server.js')" 2>&1 | head -5` is NOT safe (starts the app); instead verify no syntax error with: `node --check server/dist/server.js && node --check server/dist/routes/authRoutes.js`
Expected: no output (both parse cleanly).

- [ ] **Step 5: Commit**

```bash
git add server/dist/server.js server/dist/routes/authRoutes.js
git commit -m "fix(auth): enforce isCurrentlyLocked in deserializeUser + magic-link + Google login (immediate ban)"
```

---

## Task 7: Admin API — `lockedUntil` in `updateUser` + `listUsers`

**Files:**
- Modify: `server/dist/controllers/adminController.js` (`updateUser` ~78, `listUsers` `sel` ~66)
- Test: `tests/server/routes/adminAuditGuardrails.test.js` (existing — already exercises `updateUser` with audit via supertest; imports the real `userProfileSchema`, so `lockedUntil` carries over once Task 5 adds it)

> Depends on Task 5 (the `lockedUntil` schema field). Do Task 5 first.

- [ ] **Step 1: Write a failing test mirroring the file's existing pattern**

Add to `tests/server/routes/adminAuditGuardrails.test.js` (it already defines `buildApp`, `insertUser`, and imports `updateUser`). Append a new test:

```js
test('updateUser: ban sets locked + lockedUntil; unban clears lockedUntil', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await insertUser({ _id: actorId, email: 'actor@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Actor' });
    await insertUser({ _id: targetId, email: 'goog@x.com', superUser: false, locked: false, lastAuthVia: 'google', displayName: 'Goog' });

    const app = buildApp({ _id: actorId, email: 'actor@x.com' }, updateUser);

    // Ban with a future expiry
    const when = '2030-01-01T00:00:00.000Z';
    const banRes = await request(app).patch(`/users/${targetId}`).send({ locked: true, lockedUntil: when });
    expect(banRes.status).toBe(200);
    let u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u.locked).toBe(true);
    expect(new Date(u.lockedUntil).toISOString()).toBe(when);

    // Unban clears the expiry
    const unbanRes = await request(app).patch(`/users/${targetId}`).send({ locked: false });
    expect(unbanRes.status).toBe(200);
    u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u.locked).toBe(false);
    expect(u.lockedUntil).toBeNull();
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx jest tests/server/routes/adminAuditGuardrails.test.js -t "ban sets locked"`
Expected: FAIL — `lockedUntil` is not in the `allowed` list, so it is stripped (stored as `undefined`/absent, not the date; and not cleared on unban).

- [ ] **Step 3: Add `lockedUntil` to `updateUser`**

In `server/dist/controllers/adminController.js`, change the `allowed` array (~line 81):

```js
        const allowed = ['displayName', 'callSign', 'location', 'locked', 'lockedUntil', 'superUser'];
```

After the loop that copies `allowed` keys, normalize `lockedUntil` (add right after the `updates.callSign` uppercasing block ~line 90):

```js
        if (updates.locked === false) {
            updates.lockedUntil = null; // unbanning clears any expiry
        } else if (updates.lockedUntil) {
            updates.lockedUntil = new Date(updates.lockedUntil);
        }
```

Add `lockedUntil` to the `.select(...)` after `findByIdAndUpdate` (~line 107):

```js
            .select('email callSign displayName location lastIp locked lockedUntil superUser')
```

- [ ] **Step 4: Add `lockedUntil` to the `listUsers` projection**

In `listUsers` (~line 66), append `lockedUntil` to the `sel` string:

```js
        const sel = 'email callSign displayName location lastIp locked lockedUntil superUser newAccount policyConsent flaggedForDeletion createdAt lastLogin lastAuthVia';
```

- [ ] **Step 5: Run, verify PASS + full suite**

Run: `npx jest tests/server/routes/adminAuditGuardrails.test.js -t "ban sets locked"` then `npx jest`
Expected: target test PASSES; suite green except the known `uploadImage` failure.

- [ ] **Step 6: Commit**

```bash
git add server/dist/controllers/adminController.js tests/server/routes/adminAuditGuardrails.test.js
git commit -m "feat(admin): lockedUntil in updateUser + listUsers (expiring account bans)"
```

---

## Task 8: Admin client — Ban/Unban button + expiry in the edit modal

**Files:**
- Modify: `server/dist/views/admin.ejs` (locked checkbox block ~206)
- Modify: `client/src/public/js/byView/admin/main.ts` (populate ~390, save ~658, badge ~107)

> Client (no jsdom). Implement, build, verify on staging (Task 9).

- [ ] **Step 1: Replace the locked checkbox with ban controls in `admin.ejs`**

In `server/dist/views/admin.ejs`, replace the existing locked checkbox block (the element with `id="edit-locked"` and its label, ~line 205-207) with:

```html
          <div class="mb-2">
            <label class="form-label d-block">Account ban</label>
            <button type="button" class="btn btn-sm btn-outline-danger" id="edit-ban-btn">Ban</button>
            <span id="edit-ban-status" class="ms-2 small text-muted"></span>
            <input type="hidden" id="edit-locked" value="false">
            <div id="edit-ban-expiry-wrap" class="mt-2" style="display:none;">
              <label class="form-label small">Duration</label>
              <select id="edit-lock-duration" class="form-select form-select-sm">
                <option value="permanent">Permanent</option>
                <option value="1h">1 hour</option>
                <option value="24h">24 hours</option>
                <option value="7d">7 days</option>
                <option value="custom">Custom…</option>
              </select>
              <input type="datetime-local" id="edit-lock-custom" class="form-control form-control-sm mt-1" style="display:none;">
            </div>
          </div>
```

- [ ] **Step 2: Populate ban state when opening the modal**

In `client/src/public/js/byView/admin/main.ts`, import the shared helper at top: `import { expiryFromPreset } from '#@client/lib/clientUtils.js';`

Replace the line that set the checkbox (~line 390, `(document.getElementById('edit-locked') as HTMLInputElement).checked = !!user.locked;`) with logic that drives the new controls:

```ts
        setBanUiState(!!user.locked, user.lockedUntil || null);
```

Add this module-level helper (near the other helpers in the file):

```ts
function setBanUiState(banned: boolean, lockedUntil: string | null): void {
    const hidden = document.getElementById('edit-locked') as HTMLInputElement;
    const btn = document.getElementById('edit-ban-btn') as HTMLButtonElement;
    const status = document.getElementById('edit-ban-status') as HTMLElement;
    const wrap = document.getElementById('edit-ban-expiry-wrap') as HTMLElement;
    hidden.value = banned ? 'true' : 'false';
    btn.textContent = banned ? 'Unban' : 'Ban';
    btn.classList.toggle('btn-outline-danger', !banned);
    btn.classList.toggle('btn-outline-success', banned);
    status.textContent = banned
        ? (lockedUntil ? `Banned until ${new Date(lockedUntil).toLocaleString()}` : 'Banned (permanent)')
        : '';
    wrap.style.display = banned ? 'block' : 'none';
}
```

- [ ] **Step 3: Wire the Ban/Unban toggle button + custom-duration toggle**

In the modal-setup code (where other edit handlers are attached; if there is a one-time init, attach there — otherwise attach once on DOMContentLoaded), add:

```ts
document.getElementById('edit-ban-btn')?.addEventListener('click', () => {
    const hidden = document.getElementById('edit-locked') as HTMLInputElement;
    const nowBanned = hidden.value !== 'true'; // toggling
    setBanUiState(nowBanned, null);
});
document.getElementById('edit-lock-duration')?.addEventListener('change', e => {
    const custom = document.getElementById('edit-lock-custom') as HTMLInputElement;
    custom.style.display = (e.target as HTMLSelectElement).value === 'custom' ? 'block' : 'none';
});
```

- [ ] **Step 4: Send `locked` + `lockedUntil` on save**

In the save handler (~line 658, where `locked: (document.getElementById('edit-locked') as HTMLInputElement).checked` is currently sent), replace the `locked` line with:

```ts
            locked: (document.getElementById('edit-locked') as HTMLInputElement).value === 'true',
            lockedUntil: (document.getElementById('edit-locked') as HTMLInputElement).value === 'true'
                ? expiryFromPreset(
                    (document.getElementById('edit-lock-duration') as HTMLSelectElement).value,
                    (document.getElementById('edit-lock-custom') as HTMLInputElement).value)
                : null,
```

- [ ] **Step 5: Show expiry in the user-list badge**

In `loadUsers` (~line 107), replace:

```ts
            if (u.locked) badges.push('<span class="badge badge-locked">Locked</span>');
```

with:

```ts
            if (u.locked) badges.push(`<span class="badge badge-locked">${u.lockedUntil ? 'Locked until ' + new Date(u.lockedUntil).toLocaleDateString() : 'Locked'}</span>`);
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 7: Confirm compiled output**

Run: `grep -c "setBanUiState\|lockedUntil" client/dist/public/js/byView/admin/main.js`
Expected: non-zero.

- [ ] **Step 8: Commit**

```bash
git add server/dist/views/admin.ejs client/src/public/js/byView/admin/main.ts client/dist/public/js/byView/admin/
git commit -m "feat(admin): Ban/Unban button with optional expiry in user editor"
```

---

## Task 9: Verify on staging + deploy

**Files:** none (deploy + manual verification)

- [ ] **Step 1: Full suite green**

Run: `npx jest`
Expected: all pass except the known `uploadImage` failure.

- [ ] **Step 2: Push staging**

```bash
git push git@github.com:nixon7606/hamlive-oss.git staging
```

- [ ] **Step 3: Deploy to CT 204 (run on the Proxmox host)**

```bash
pct exec 204 -- runuser -u hamlive -- git -C /opt/hamlive fetch --all --prune
pct exec 204 -- runuser -u hamlive -- git -C /opt/hamlive reset --hard origin/staging
pct exec 204 -- systemctl restart hamlive
```

- [ ] **Step 4: Purge Cloudflare (client JS changed)**

Purge `https://staging.netcontrol.live/js/lib/chat.js`, `/js/lib/localChat.js`, `/js/lib/clientUtils.js`, and `/js/byView/admin/main.js` (or Purge Everything). Hard-refresh (Ctrl+Shift+R).

- [ ] **Step 5: Manual verification (two accounts)**
  - As NCS in a live net: a non-self message shows a ban (slash-circle) button beside delete. Click → dialog → set reason + "1 hour" → Ban. The target's chat input disables immediately (SSE). `unban <callsign>` re-enables on the target's reload.
  - As the banned target: cannot send; notice shows the reason.
  - As admin: open a Google user, click **Ban**, pick a duration, save → badge shows "Locked until …"; that user is bounced to login on their next request and rejected at login; after expiry (or Unban) they can log in again.

- [ ] **Step 6: Done** — feature complete on staging; promotion to prod (`main`/CT 202) follows the existing path, with the secret-rotation prereq and a Cloudflare purge on the prod zone.

---

## Notes for the implementer

- **DRY:** `expiryFromPreset` (client) and `isCurrentlyLocked` (server) are the single sources of truth — do not inline duplicates.
- **YAGNI:** no background expiry sweep, no net-control banned-list UI, no live re-enable on expiry (documented limitation: target reloads to regain chat; account lock lifts on next request).
- **Permissions:** chat ban → `checkUserCanModerate` (NCS); account ban → admin routes already enforce superUser.
- **Known pre-existing test failure:** `localChat uploadImage › accepts valid image` — unrelated, leave it.
