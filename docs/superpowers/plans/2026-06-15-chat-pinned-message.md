# Chat Pinned Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the NCS pin one chat message to a bar at the top of the chat (replacing any prior pin), visible to everyone, persistent across reloads.

**Architecture:** A `pinned: Boolean` flag on `ChatMessage`. `pinMessage` (NCS-gated) sets it and clears every other pin in the net (single-pin); `unpinMessage` clears it. New `chat-pin`/`chat-unpin` SSE events drive a client "pinned bar". `getChatSession` returns the current pinned message so it renders on join. No NCS-only filtering (pins are public). Mirrors the existing reaction/ban per-message-marker patterns.

**Tech Stack:** Node/Express, Mongoose, server runtime JS under `server/dist/`; vanilla client TS (`client/src` → `client/dist` via `npm run build`); Jest (server project).

**Conventions:**
- Run server tests with `npx jest` (the known `localChat uploadImage` failure is unrelated — ignore). The server tests live in the `server` jest project; the chat tests are `tests/server/lib/localChat.test.js`, which registers test models (incl. `mockChatMessage`) and helpers `mockNcs()` (callsign NCS001, id `ncsId`, has a `netcontrol` StationInteraction so `checkUserCanModerate` is true) and `mockMember()` (id `userId`, no interaction → not a moderator). It also imports `chatBroadcaster` for spying.
- Server tasks (1–3) are TDD against that harness. Client tasks (4–5) have no DOM harness — implement, `npm run build`, verify by grep, then manual on staging (Task 6).
- Client imports use the `#@client/...js` alias.

---

## Task 1: `pinned` model field + `pinMessage`/`unpinMessage` + broadcast helpers

**Files:**
- Modify: `server/dist/models/chatMessage.js` (add `pinned`)
- Modify: `server/dist/lib/sseChat.js` (broadcastPin/broadcastUnpin)
- Modify: `server/dist/lib/localChat.js` (pinMessage/unpinMessage + exports)
- Modify: `tests/server/lib/localChat.test.js` (test schema + tests)

- [ ] **Step 1: Add `pinned` to the test schema**

In `tests/server/lib/localChat.test.js`, the `testChatMessageSchema` must mirror the real one. Add (next to `edited`):

```js
  pinned: { type: Boolean, default: false },
```

- [ ] **Step 2: Write failing tests**

Add a new describe block to `tests/server/lib/localChat.test.js` (after the existing message tests):

```js
describe('pinMessage / unpinMessage', () => {
  const ncsMod = () => ({ callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId });

  test('NCS pins a message; pinning another replaces it (single pin)', async () => {
    const a = await localChat.sendMessage({ npid, user: mockMember(), text: 'first' });
    const b = await localChat.sendMessage({ npid, user: mockMember(), text: 'second' });
    await localChat.pinMessage({ npid, messageId: a.id, moderator: ncsMod() });
    await localChat.pinMessage({ npid, messageId: b.id, moderator: ncsMod() });
    const pinned = await mockChatMessage.find({ pinned: true });
    expect(pinned.map(d => d._id.toString())).toEqual([b.id]);
  });

  test('non-NCS cannot pin', async () => {
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'x' });
    await expect(localChat.pinMessage({
      npid, messageId: m.id,
      moderator: { callSign: 'KD5SPR', userProfile: userId, userProfileId: userId }
    })).rejects.toThrow(/only NCS|permission/i);
  });

  test('pinMessage broadcasts chat-pin with the message payload', async () => {
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'pin me' });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastPin').mockImplementation(() => {});
    try {
      await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
      expect(spy).toHaveBeenCalledTimes(1);
      const [, payload] = spy.mock.calls[0];
      expect(payload.id).toBe(m.id);
    } finally { spy.mockRestore(); }
  });

  test('unpinMessage clears the pin and broadcasts chat-unpin', async () => {
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'pin me' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastUnpin').mockImplementation(() => {});
    try {
      await localChat.unpinMessage({ npid, messageId: m.id, moderator: ncsMod() });
      const pinned = await mockChatMessage.find({ pinned: true });
      expect(pinned).toHaveLength(0);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, data] = spy.mock.calls[0];
      expect(data.messageId).toBe(m.id);
    } finally { spy.mockRestore(); }
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `npx jest tests/server/lib/localChat.test.js -t "pinMessage / unpinMessage"`
Expected: FAIL — `localChat.pinMessage is not a function`.

- [ ] **Step 4: Add the `pinned` field to the real model**

In `server/dist/models/chatMessage.js`, in `chatMessageSchema` after the `editedAt` field block, add:

```js
        pinned: {
            type: Boolean,
            default: false,
            index: true
        },
```

- [ ] **Step 5: Add broadcast helpers**

In `server/dist/lib/sseChat.js`, next to `broadcastUpdate`/`broadcastDelete`, add:

```js
    /**
     * Broadcast that a message was pinned (full payload) / unpinned ({messageId}).
     */
    broadcastPin(npid, data) {
        const instance = this.streams.get(npid.toString());
        if (!instance) return;
        instance.send(data, 'chat-pin');
    }

    broadcastUnpin(npid, data) {
        const instance = this.streams.get(npid.toString());
        if (!instance) return;
        instance.send(data, 'chat-unpin');
    }
```

- [ ] **Step 6: Implement pinMessage / unpinMessage**

In `server/dist/lib/localChat.js`, add after `banFromMessage` (and add `pinMessage, unpinMessage,` to `module.exports`):

```js
/**
 * Pin a message to the top of a net's chat (NCS only). Enforces a single pin
 * per net by clearing any other pinned message. Broadcasts chat-pin.
 */
async function pinMessage({ npid, messageId, moderator }) {
    const { ChatMessage } = getModels();
    const canModerate = await checkUserCanModerate(npid, moderator.userProfileId);
    if (!canModerate) throw new Error('Insufficient permissions: only NCS can pin');

    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('Message not found');
    if (msg.netProfile.toString() !== npid.toString()) throw new Error('Message not in this net');

    // Single-pin: clear any other pinned message in this net.
    await ChatMessage.updateMany(
        { netProfile: npid, _id: { $ne: msg._id }, pinned: true },
        { $set: { pinned: false } }
    );
    msg.pinned = true;
    await msg.save();

    const payload = await buildMessagePayload(msg);
    try {
        chatBroadcaster.broadcastPin(npid, payload);
    } catch (e) {
        logger.warn(`Chat: broadcastPin failed for net ${npid}: ${e.message}`);
    }
    return payload;
}

/**
 * Unpin a message (NCS only). Broadcasts chat-unpin.
 */
async function unpinMessage({ npid, messageId, moderator }) {
    const { ChatMessage } = getModels();
    const canModerate = await checkUserCanModerate(npid, moderator.userProfileId);
    if (!canModerate) throw new Error('Insufficient permissions: only NCS can unpin');

    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('Message not found');
    msg.pinned = false;
    await msg.save();

    try {
        chatBroadcaster.broadcastUnpin(npid, { messageId: msg._id.toString() });
    } catch (e) {
        logger.warn(`Chat: broadcastUnpin failed for net ${npid}: ${e.message}`);
    }
    return { messageId: msg._id.toString() };
}
```

Add to the `module.exports` object (near `banFromMessage`):
```js
    pinMessage,
    unpinMessage,
```

- [ ] **Step 7: Run, verify PASS + full suite**

Run: `npx jest tests/server/lib/localChat.test.js -t "pinMessage / unpinMessage"` → 4 passed.
Then `npx jest` → all pass except the known `localChat uploadImage` failure.

- [ ] **Step 8: Commit**

```bash
git add server/dist/models/chatMessage.js server/dist/lib/sseChat.js server/dist/lib/localChat.js tests/server/lib/localChat.test.js
git commit -m "feat(chat): pinned field + pinMessage/unpinMessage (NCS, single-pin) + broadcasts"
```

---

## Task 2: `getChatSession` returns the pinned message + delete auto-unpins

**Files:**
- Modify: `server/dist/lib/localChat.js` (`getChatSession`, `deleteMessage`)
- Modify: `tests/server/lib/localChat.test.js`

- [ ] **Step 1: Write failing tests**

Add to `tests/server/lib/localChat.test.js` (in the pin describe block or a new one):

```js
describe('pinned message: session + delete', () => {
  const ncsMod = () => ({ callSign: 'NCS001', userProfile: ncsId, userProfileId: ncsId });

  test('getChatSession returns the current pinned message (or null)', async () => {
    const none = await localChat.getChatSession({ npid, user: mockNcs() });
    expect(none.pinnedMessage).toBeNull();
    const m = await localChat.sendMessage({ npid, user: mockMember(), text: 'announce' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const session = await localChat.getChatSession({ npid, user: mockNcs() });
    expect(session.pinnedMessage).not.toBeNull();
    expect(session.pinnedMessage.id).toBe(m.id);
  });

  test('deleting a pinned message broadcasts chat-unpin', async () => {
    const m = await localChat.sendMessage({ npid, user: mockNcs(), text: 'pinned then deleted' });
    await localChat.pinMessage({ npid, messageId: m.id, moderator: ncsMod() });
    const spy = jest.spyOn(chatBroadcaster, 'broadcastUnpin').mockImplementation(() => {});
    try {
      await localChat.deleteMessage({ npid, messageId: m.id, moderatorCallsign: 'NCS001', userProfileId: ncsId });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx jest tests/server/lib/localChat.test.js -t "session \\+ delete"`
Expected: FAIL — `getChatSession` has no `pinnedMessage`, delete doesn't unpin.

- [ ] **Step 3: Add `pinnedMessage` to getChatSession**

In `server/dist/lib/localChat.js`, replace `getChatSession`'s `return {...}` so it includes the pinned message:

```js
    const pinned = await getModels().ChatMessage.findOne({ netProfile: npid, pinned: true, deleted: false });
    return {
        enabled: true,
        roomId: getChatRoomId(npid),
        userId: user._id.toString(),
        callSign: user.callSign || 'UNKNOWN',
        displayName: user.displayName || user.callSign || '',
        pinnedMessage: pinned ? await buildMessagePayload(pinned) : null
    };
```

(Keep the existing guard lines at the top of `getChatSession` unchanged; only the returned object gains `pinnedMessage` and the `pinned` lookup above the return.)

- [ ] **Step 4: Auto-unpin on delete**

In `server/dist/lib/localChat.js` `deleteMessage`, change the body so a pinned delete also clears + broadcasts unpin. Replace:

```js
    msg.deleted = true;
    await msg.save();
    logger.info(`Chat: Message ${messageId} deleted by ${moderatorCallsign} in net ${npid}`);
    try {
        chatBroadcaster.broadcastDelete(npid, messageId);
    } catch (e) {
        logger.warn(`Chat: broadcastDelete failed: ${e.message}`);
    }
    return { success: true, messageId };
```
with:
```js
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
```

- [ ] **Step 5: Run, verify PASS + full suite**

Run: `npx jest tests/server/lib/localChat.test.js -t "session \\+ delete"` → 2 passed.
Then `npx jest` → green except the known `uploadImage`.

- [ ] **Step 6: Commit**

```bash
git add server/dist/lib/localChat.js tests/server/lib/localChat.test.js
git commit -m "feat(chat): getChatSession returns pinnedMessage; deleting a pinned message unpins"
```

---

## Task 3: Pin/unpin HTTP routes

**Files:**
- Modify: `server/dist/routes/chatRoutes.js`

> Thin wrappers over the Task-1 helpers (which are already tested). Verify via `node --check` + full suite.

- [ ] **Step 1: Import the helpers**

In `server/dist/routes/chatRoutes.js`, add `pinMessage` and `unpinMessage` to the destructured `require('../lib/localChat')` block:

```js
    pinMessage,
    unpinMessage,
```

- [ ] **Step 2: Add the routes**

Add after the `POST /:id/message/:messageId/ban` route:

```js
// ============================================================================
// POST /api/chat/:id/message/:messageId/pin — Pin a message (NCS only)
// ============================================================================
router.post('/:id/message/:messageId/pin', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const result = await pinMessage({
            npid,
            messageId,
            moderator: { callSign: req.user.callSign || 'unknown', userProfile: req.user._id, userProfileId: req.user._id.toString() }
        });
        return { message: { pinned: result.id } };
    }, `pinMessage(): ${req.user?.callSign} pinned ${req.params.messageId}`);
});

// ============================================================================
// POST /api/chat/:id/message/:messageId/unpin — Unpin a message (NCS only)
// ============================================================================
router.post('/:id/message/:messageId/unpin', generalLimiter, authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!isNpid(npid)) throw new Error(`Invalid NPID: ${npid}`);
        if (!messageId) throw new Error('Missing messageId');
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const result = await unpinMessage({
            npid,
            messageId,
            moderator: { callSign: req.user.callSign || 'unknown', userProfile: req.user._id, userProfileId: req.user._id.toString() }
        });
        return { message: { unpinned: result.messageId } };
    }, `unpinMessage(): ${req.user?.callSign} unpinned ${req.params.messageId}`);
});
```

- [ ] **Step 3: Verify**

Run: `node --check server/dist/routes/chatRoutes.js` (no output = OK).
Run: `npx jest` → green except the known `uploadImage`.

- [ ] **Step 4: Commit**

```bash
git add server/dist/routes/chatRoutes.js
git commit -m "feat(chat): POST pin/unpin message routes (NCS)"
```

---

## Task 4: Client connection — pin/unpin methods + SSE listeners

**Files:**
- Modify: `client/src/public/js/lib/localChat.ts`

> Client task — implement, `npm run build`, verify by grep. Manual test in Task 6.

- [ ] **Step 1: Add pin/unpin methods**

In `client/src/public/js/lib/localChat.ts`, after the `banFromMessage` method, add (mirror its fetch shape):

```ts
    async pinMessage(messageId: string): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/pin`, { method: 'POST' });
            return res.ok;
        } catch (err) {
            logger.error('Failed to pin message:', err);
            return false;
        }
    }

    async unpinMessage(messageId: string): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/unpin`, { method: 'POST' });
            return res.ok;
        } catch (err) {
            logger.error('Failed to unpin message:', err);
            return false;
        }
    }
```

- [ ] **Step 2: Add SSE listeners**

In the SSE-setup block (where `chat-ban` etc. are registered), add:

```ts
        this.eventSource.addEventListener('chat-pin', (event: MessageEvent) => {
            try {
                this.emit('pin', JSON.parse(event.data));
            } catch (e) {
                logger.error('Failed to parse chat-pin:', e);
            }
        });

        this.eventSource.addEventListener('chat-unpin', (event: MessageEvent) => {
            try {
                this.emit('unpin', JSON.parse(event.data));
            } catch (e) {
                logger.error('Failed to parse chat-unpin:', e);
            }
        });
```

- [ ] **Step 3: Allow `pinnedMessage` on the session type**

Find the `LocalChatSession` interface/type used by `getSession()` and add an optional field so `session.pinnedMessage` type-checks:

```ts
    pinnedMessage?: unknown;
```
(If the session type is declared as `any`/inline, no change needed — just confirm the build is clean.)

- [ ] **Step 4: Build + confirm**

Run: `npm run build` → exit 0 (fix any TS errors).
Run: `grep -c "pinMessage\|chat-pin" client/dist/public/js/lib/localChat.js` → non-zero.

- [ ] **Step 5: Commit**

```bash
git add client/src/public/js/lib/localChat.ts client/dist/public/js/lib/localChat.js client/dist/public/js/lib/localChat.js.map client/dist/public/js/lib/localChat.d.ts.map
git commit -m "feat(chat): client pin/unpin methods + chat-pin/chat-unpin SSE listeners"
```

---

## Task 5: Client UI — pinned bar + pin button

**Files:**
- Modify: `client/src/public/js/lib/chat.ts`

> Client task — implement, build, verify by grep. Manual on staging (Task 6).

- [ ] **Step 1: Add the pinned-bar element to the template**

In `getTemplate()`, immediately BEFORE the `<div class="chat-messages …">` line (~405), add:

```html
                <div class="chat-pinned-bar d-none"></div>
```

- [ ] **Step 2: Add pinned-bar CSS**

In the chat `<style>` block (alongside `.chat-mention` etc.), add:

```css
                    .chat-pinned-bar {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 6px 10px;
                        background: var(--hl-quaternary);
                        border-bottom: 1px solid var(--hl-tertiary);
                        font-size: 12px;
                        color: var(--hl-light);
                        cursor: pointer;
                    }
                    .chat-pinned-bar .chat-pinned-label { color: var(--hl-secondary); font-weight: 600; white-space: nowrap; }
                    .chat-pinned-bar .chat-pinned-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    .chat-pinned-bar .chat-pinned-unpin { background: none; border: none; color: var(--hl-tertiary); cursor: pointer; }
```

- [ ] **Step 3: Add render/clear helpers**

Add these private methods to `ChatWidget` (near `renderMessageBody`):

```ts
    private renderPinnedBar(msg: any): void {
        const bar = this.querySelector<HTMLElement>('.chat-pinned-bar');
        if (!bar || !msg) return;
        bar.dataset['messageId'] = msg.id || '';
        const unpin = this.canModerate()
            ? `<button class="chat-pinned-unpin" title="Unpin">&times;</button>`
            : '';
        bar.innerHTML =
            `<i class="bi bi-pin-angle-fill"></i>` +
            `<span class="chat-pinned-label">${this.escapeHtml(msg.callSign || '')}</span>` +
            `<span class="chat-pinned-text">${this.renderMessageBody(msg.text || '')}</span>` +
            unpin;
        bar.classList.remove('d-none');
        bar.querySelector('.chat-pinned-unpin')?.addEventListener('click', e => {
            e.stopPropagation();
            const id = bar.dataset['messageId'];
            if (id) void this.connection?.unpinMessage(id);
        });
        bar.onclick = () => {
            const id = bar.dataset['messageId'];
            const el = id ? this.querySelector(`[data-message-id="${id}"]`) : null;
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
    }

    private clearPinnedBar(): void {
        const bar = this.querySelector<HTMLElement>('.chat-pinned-bar');
        if (!bar) return;
        bar.classList.add('d-none');
        bar.innerHTML = '';
        delete bar.dataset['messageId'];
    }
```

- [ ] **Step 4: Render the bar on session load**

In the session-init code (~line 138, after the `session.banned` handling), add:

```ts
            if (session.pinnedMessage) {
                this.renderPinnedBar(session.pinnedMessage);
            }
```

- [ ] **Step 5: Wire live pin/unpin events**

In `setupConnectionListeners()` (~620), after the `ban` listener, add:

```ts
        this.connection.on('pin', (data: unknown) => this.renderPinnedBar(data));
        this.connection.on('unpin', () => this.clearPinnedBar());
```

- [ ] **Step 6: Add the pin button to the message actions**

In `renderMessage`, the `moderateBtn` builds the NCS action buttons. Append a pin button to the `canModerate()` branch so it renders for moderators on every message. Change:

```ts
        const moderateBtn = this.canModerate()
            ? `<button class="chat-action-btn chat-mod-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
              + (msg.userId && msg.userId !== this.currentUserId
                  ? `<button class="chat-action-btn chat-mod-btn chat-ban-btn" title="Ban author"><i class="bi bi-slash-circle"></i></button>`
                  : '')
            : '';
```
to:
```ts
        const moderateBtn = this.canModerate()
            ? `<button class="chat-action-btn chat-mod-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
              + `<button class="chat-action-btn chat-mod-btn chat-pin-btn" title="Pin message"><i class="bi bi-pin-angle"></i></button>`
              + (msg.userId && msg.userId !== this.currentUserId
                  ? `<button class="chat-action-btn chat-mod-btn chat-ban-btn" title="Ban author"><i class="bi bi-slash-circle"></i></button>`
                  : '')
            : '';
```

- [ ] **Step 7: Wire the pin button click (both spots, mirroring the ban button)**

(a) In `setupMessageActions`, after the ban-button wiring, add:

```ts
        const pinBtn = msgEl.querySelector('.chat-pin-btn');
        pinBtn?.addEventListener('click', e => {
            e.stopPropagation();
            void this.connection?.pinMessage(messageId);
        });
```

(b) In `updateModerationButtons`, inside the `if (canMod && !existingDeleteBtn) { … }` block (where the ban button is dynamically added), add a pin button too:

```ts
                if (!actionsContainer.querySelector('.chat-pin-btn')) {
                    const pinBtn = document.createElement('button');
                    pinBtn.className = 'chat-action-btn chat-mod-btn chat-pin-btn';
                    pinBtn.title = 'Pin message';
                    pinBtn.innerHTML = '<i class="bi bi-pin-angle"></i>';
                    pinBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        const messageId = (msgEl as HTMLElement).dataset['messageId'];
                        if (messageId) void this.connection?.pinMessage(messageId);
                    });
                    actionsContainer.appendChild(pinBtn);
                }
```
And in the `else if (!canMod && existingDeleteBtn)` branch (where ban btn is removed), also remove the pin button:
```ts
                actionsContainer.querySelector('.chat-pin-btn')?.remove();
```

- [ ] **Step 8: Build + confirm**

Run: `npm run build` → exit 0.
Run: `grep -c "renderPinnedBar\|chat-pinned-bar\|chat-pin-btn" client/dist/public/js/lib/chat.js` → non-zero.

- [ ] **Step 9: Commit**

```bash
git add client/src/public/js/lib/chat.ts client/dist/public/js/lib/chat.js client/dist/public/js/lib/chat.js.map client/dist/public/js/lib/chat.d.ts.map
git commit -m "feat(chat): pinned-message bar + NCS pin button"
```

---

## Task 6: Verify on staging + deploy

**Files:** none.

- [ ] **Step 1: Full suite + build green**

Run: `npx jest` (only the known `uploadImage` failure) and `npm run build` (exit 0).

- [ ] **Step 2: Push staging**

```bash
git push git@github.com:nixon7606/hamlive-oss.git staging
```

- [ ] **Step 3: Deploy to CT 204 (Proxmox host)**

```bash
pct exec 204 -- runuser -u hamlive -- git -C /opt/hamlive fetch --all --prune
pct exec 204 -- runuser -u hamlive -- git -C /opt/hamlive reset --hard origin/staging
pct exec 204 -- systemctl restart hamlive
```

- [ ] **Step 4: Purge Cloudflare (client JS changed)**

Purge `https://staging.netcontrol.live/js/lib/chat.js` + `/js/lib/localChat.js` (or Purge Everything); hard-refresh.

- [ ] **Step 5: Manual verification (two accounts in a net)**
  - As NCS: a **pin** button shows on messages; click it → a pinned bar appears at the top for **both** accounts.
  - Pin a different message → the bar swaps to the new one (single-pin).
  - As NCS: the bar shows an **✕**; click → bar clears for both.
  - Delete the pinned message → bar clears.
  - As a **non-NCS** attendee: no pin button, no ✕ on the bar, but the bar IS visible.
  - Reload as a late joiner → the pinned bar shows immediately.
  - A pinned message containing an `@mention`/link renders correctly in the bar.

- [ ] **Step 6: Done** — feature complete on staging; promote to prod (`main`/CT 202) via the usual merge + deploy + prod Cloudflare purge.

---

## Notes for the implementer

- **DRY/pattern:** pin reuses the reaction/ban marker pattern — NCS gate via `checkUserCanModerate`, a `chat-*` SSE event, and `buildMessagePayload` for the payload. The pinned-bar text uses the existing `renderMessageBody` so mentions/links render and it's XSS-safe.
- **YAGNI:** single pin only; no pin history/audit; no auto-clear on net close; unpin is via the bar's ✕ (message row only has a pin button, not a per-message unpin toggle).
- **Single-pin invariant** lives in `pinMessage` (the `updateMany` clearing other pins) — don't duplicate it client-side.
- **Known pre-existing failure:** `localChat uploadImage › accepts valid image` — unrelated, leave it.
