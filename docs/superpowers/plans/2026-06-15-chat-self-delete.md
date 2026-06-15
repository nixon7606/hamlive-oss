# Chat Self-Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chat participant delete a message they authored within 15 minutes of sending it, while NCS keeps unlimited delete power; a self-deleted message vanishes for everyone.

**Architecture:** Widen the authorization in the existing `deleteMessage` (server/dist/lib/localChat.js) to allow the message author within a 15-minute window in addition to NCS. Reuse the existing soft-delete + `chat-delete` broadcast (no new route, schema, or SSE event). On the client, render the existing `.chat-delete-btn` on the author's own recent messages, gated by a new pure, unit-tested age helper.

**Tech Stack:** Node/Express/Mongoose (hand-maintained `server/dist/**/*.js`); vanilla TypeScript ES-module client compiled `client/src` → `client/dist` via `npm run build`; Jest (server project: `tests/server/**/*.test.js` against a local Mongo at `127.0.0.1:27017`; client project: ts-jest `tests/client/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-06-15-chat-self-delete-design.md`

---

## File Structure

- **`server/dist/lib/localChat.js`** — add `SELF_DELETE_WINDOW_MS` constant; rewrite `deleteMessage` to load the message first, then authorize as NCS (any age) OR author (within window). This is the single source of truth for authorization.
- **`tests/server/lib/localChat.test.js`** — update the now-incorrect "rejects deletion by non-NCS" test (the author can now delete their own message) and add owner/window/NCS-age tests.
- **`client/src/public/js/lib/selfDelete.ts`** (NEW) — pure helper `withinSelfDeleteWindow(createdAt, nowMs?)` + exported `SELF_DELETE_WINDOW_MS`. No imports, so it is ts-jest-testable (mirrors `mentions.ts`).
- **`tests/client/lib/selfDelete.test.ts`** (NEW) — unit tests for the helper.
- **`client/src/public/js/lib/chat.ts`** — render a self-delete trash button on own recent messages; relax the `deleteMessage()` guard and the `updateModerationButtons()` removal branch.
- **`client/dist/public/js/lib/selfDelete.js` + `.d.ts`, `client/dist/public/js/lib/chat.js`** — build output from `npm run build` (committed).

---

## Task 1: Server — widen `deleteMessage` authorization

**Files:**
- Modify: `server/dist/lib/localChat.js` (function `deleteMessage`, currently ~line 376; add a constant near the other module constants at the top of the file)
- Test: `tests/server/lib/localChat.test.js` (the `describe('deleteMessage()')` block, ~line 339)

Context: `deleteMessage({ npid, messageId, moderatorCallsign, userProfileId })` is called from `chatRoutes.js` (DELETE `/:id/message/:messageId`) with the caller's `userProfileId` and callsign. Messages carry `userProfile` (author) and `createdAt` (Mongoose `timestamps: true`). `checkUserCanModerate(npid, userProfileId)` returns true only for NCS. The server test harness mocks the models and exposes `chatBroadcaster`, `userId` (a member with NO station interaction → non-NCS), and `ncsId` (NCS). Messages are created via `localChat.sendMessage({ npid, user, text })`.

- [ ] **Step 1: Update the existing "rejects deletion by non-NCS" test (it will otherwise break)**

In `tests/server/lib/localChat.test.js`, the current test deletes the author's own message with the author's id, which the new behavior ALLOWS. Replace it so a *third* user (neither author nor NCS) is rejected. Replace the existing test at the `describe('deleteMessage()')` block:

```js
  test('rejects deletion by a non-NCS who is not the author', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Delete me' });
    const strangerId = new mongoose.Types.ObjectId().toString();
    await expect(localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'W1AW', userProfileId: strangerId
    })).rejects.toThrow('permissions');
  });
```

- [ ] **Step 2: Add the new owner/window/NCS-age tests**

Append these tests inside the same `describe('deleteMessage()', () => { ... })` block:

```js
  test('author can delete their own recent message', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'My typo' });
    const result = await localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'KD5SPR', userProfileId: userId
    });
    expect(result.success).toBe(true);
    const msgs = await localChat.getMessages({ npid });
    expect(msgs.find(m => m.id === msg.id)).toBeUndefined();
  });

  test('author cannot delete their own message older than the 15-minute window', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Old message' });
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await mockChatMessage.updateOne({ _id: msg.id }, { $set: { createdAt: old } });
    await expect(localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'KD5SPR', userProfileId: userId
    })).rejects.toThrow('15 minutes');
    const msgs = await localChat.getMessages({ npid });
    expect(msgs.find(m => m.id === msg.id)).toBeDefined();
  });

  test('NCS can delete a message older than the 15-minute window', async () => {
    const msg = await localChat.sendMessage({ npid, user: mockMember(), text: 'Old message' });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await mockChatMessage.updateOne({ _id: msg.id }, { $set: { createdAt: old } });
    const result = await localChat.deleteMessage({
      npid, messageId: msg.id, moderatorCallsign: 'NCS001', userProfileId: ncsId
    });
    expect(result.success).toBe(true);
  });
```

(`mockChatMessage` is already defined and registered at the top of the test file.)

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npx jest --selectProjects server -t "deleteMessage"`
Expected: FAIL — "author can delete their own recent message" and the non-NCS-stranger test fail because the current `deleteMessage` rejects every non-NCS caller (`only NCS can delete messages`); the window tests fail too.

- [ ] **Step 4: Add the window constant**

In `server/dist/lib/localChat.js`, near the top where other module-level constants live (e.g. `ROLE_LEVELS` / `MODERATION_MAX_LEVEL`), add:

```js
// Authors may delete their OWN messages for this long after sending; NCS has no limit.
const SELF_DELETE_WINDOW_MS = 15 * 60 * 1000;
```

- [ ] **Step 5: Rewrite `deleteMessage` to authorize author-or-NCS**

Replace the whole `deleteMessage` function body with:

```js
/**
 * Soft-delete a message. Allowed for NCS (any message, any age) or for the
 * message's author within SELF_DELETE_WINDOW_MS of sending it.
 */
async function deleteMessage({ npid, messageId, moderatorCallsign, userProfileId }) {
    const { ChatMessage } = getModels();
    const msg = await ChatMessage.findById(messageId);
    if (!msg) throw new Error('Message not found');
    if (msg.netProfile.toString() !== npid.toString()) throw new Error('Message not in this net');

    const canModerate = await checkUserCanModerate(npid, userProfileId);
    const isOwner = !!(msg.userProfile && userProfileId
        && msg.userProfile.toString() === userProfileId.toString());

    if (!canModerate) {
        if (!isOwner) {
            throw new Error('Insufficient permissions: only NCS or the author can delete this message');
        }
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

- [ ] **Step 6: Run the full `deleteMessage` and pinned-delete tests to verify they pass**

Run: `npx jest --selectProjects server -t "deleteMessage|pinned message: session"`
Expected: PASS — all delete tests pass, including the existing "soft-deletes a message", "filters deleted messages", and "deleting a pinned message broadcasts chat-unpin" (the pinned-delete path is unchanged).

- [ ] **Step 7: Run the whole server suite to confirm no regressions**

Run: `npx jest --selectProjects server`
Expected: PASS — full server project green.

- [ ] **Step 8: Commit**

```bash
git add server/dist/lib/localChat.js tests/server/lib/localChat.test.js
git commit -m "feat(chat): allow authors to delete their own messages within 15 min"
```

---

## Task 2: Client — pure `withinSelfDeleteWindow` helper + unit test

**Files:**
- Create: `client/src/public/js/lib/selfDelete.ts`
- Test: `tests/client/lib/selfDelete.test.ts`

Context: ts-jest only runs the `client` Jest project over pure TS files with no `#@client/...` subpath imports (that is why `mentions.ts` is a standalone module). This helper must stay import-free so it is unit-testable and reusable by `chat.ts`. The client message payload's `createdAt` is `Date | string` (see `client/src/public/js/types/commonTypes.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/client/lib/selfDelete.test.ts`:

```ts
import { withinSelfDeleteWindow, SELF_DELETE_WINDOW_MS } from '../../../client/src/public/js/lib/selfDelete';

const NOW = 1_700_000_000_000; // fixed clock for determinism

test('constant is 15 minutes in ms', () => {
  expect(SELF_DELETE_WINDOW_MS).toBe(15 * 60 * 1000);
});

test('message sent just now is within the window', () => {
  expect(withinSelfDeleteWindow(new Date(NOW).toISOString(), NOW)).toBe(true);
});

test('message sent 14 minutes ago is within the window', () => {
  expect(withinSelfDeleteWindow(new Date(NOW - 14 * 60 * 1000).toISOString(), NOW)).toBe(true);
});

test('message sent 16 minutes ago is outside the window', () => {
  expect(withinSelfDeleteWindow(new Date(NOW - 16 * 60 * 1000).toISOString(), NOW)).toBe(false);
});

test('accepts a Date instance', () => {
  expect(withinSelfDeleteWindow(new Date(NOW - 60 * 1000), NOW)).toBe(true);
});

test('undefined or invalid createdAt is not deletable', () => {
  expect(withinSelfDeleteWindow(undefined, NOW)).toBe(false);
  expect(withinSelfDeleteWindow('not-a-date', NOW)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest --selectProjects client -t "window"`
Expected: FAIL — module `selfDelete` does not exist yet.

- [ ] **Step 3: Write the helper**

Create `client/src/public/js/lib/selfDelete.ts`:

```ts
/* hamlive-oss — MIT License. See LICENSE. */

/** Authors may delete their OWN chat messages for this long after sending. */
export const SELF_DELETE_WINDOW_MS = 15 * 60 * 1000;

/**
 * True when a message authored by the current user is still young enough for
 * the author to self-delete. NCS deletion is unlimited and does not use this.
 *
 * @param createdAt the message timestamp (ISO string or Date)
 * @param nowMs     current time in ms (injectable for testing; defaults to Date.now())
 */
export function withinSelfDeleteWindow(
    createdAt: string | Date | undefined,
    nowMs: number = Date.now()
): boolean {
    if (!createdAt) return false;
    const ts = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
    if (Number.isNaN(ts)) return false;
    return nowMs - ts < SELF_DELETE_WINDOW_MS;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest --selectProjects client -t "window"`
Expected: PASS — all six assertions green.

- [ ] **Step 5: Commit**

```bash
git add client/src/public/js/lib/selfDelete.ts tests/client/lib/selfDelete.test.ts
git commit -m "feat(chat): pure withinSelfDeleteWindow helper + unit tests"
```

---

## Task 3: Client — render self-delete button and wire deletion in `chat.ts`

**Files:**
- Modify: `client/src/public/js/lib/chat.ts` (import; `renderMessage` ~line 535-577; `deleteMessage()` ~line 1275; `updateModerationButtons()` ~line 1419)

Context: `renderMessage` already computes `const isOwnMessage = msg.userId === this.currentUserId;` and renders an `editBtn` for own messages. The moderator trash button is rendered via `moderateBtn` (NCS-only) using class `.chat-delete-btn`, and `setupMessageActions` (~line 769/824) already wires any `.chat-delete-btn` click to `confirm('Delete this message?')` → `this.deleteMessage(id)`. The widget is a custom element, so `this.querySelector(...)` works. `updateModerationButtons()` adds/removes moderation buttons on role change.

- [ ] **Step 1: Import the helper**

Add to the import section at the top of `chat.ts` (alongside the other `#@client/lib/...` imports):

```ts
import { withinSelfDeleteWindow } from '#@client/lib/selfDelete.js';
```

- [ ] **Step 2: Render a self-delete button on own recent messages**

In `renderMessage`, just after the existing `editBtn` definition (line ~536-538), add:

```ts
        const canSelfDelete = isOwnMessage && !this.canModerate()
            && withinSelfDeleteWindow(msg.createdAt);
        const selfDeleteBtn = canSelfDelete
            ? `<button class="chat-action-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
            : '';
```

Then add `${selfDeleteBtn}` into the actions row template, immediately after `${editBtn}`:

```ts
            <div class="chat-message-actions">
                ${editBtn}
                ${selfDeleteBtn}
                <button class="chat-action-btn chat-react-btn" title="React"><i class="bi bi-emoji-smile"></i></button>
                <button class="chat-action-btn chat-reply-btn" title="Reply"><i class="bi bi-reply"></i></button>
                ${moderateBtn}
            </div>
```

Because `selfDeleteBtn` is suppressed when `this.canModerate()` is true, an NCS viewing their own message gets exactly one trash button (from `moderateBtn`), never two.

- [ ] **Step 3: Allow the author through the `deleteMessage()` guard**

Replace the guard at the top of `private async deleteMessage(messageId: string)` (line ~1276). Change:

```ts
        if (!this.canModerate() || !this.connection) return;
```

to:

```ts
        if (!this.connection) return;
        const el = this.querySelector(`.chat-message[data-message-id="${messageId}"]`) as HTMLElement | null;
        const isOwn = !!el && !!this.currentUserId && el.dataset['userId'] === this.currentUserId;
        if (!this.canModerate() && !isOwn) return;
```

And change the failure notice in the same method's `catch` from `'Failed to delete message'` to a clearer message:

```ts
            this.showChatNotice('Could not delete the message — you can only delete your own messages within 15 minutes.');
```

- [ ] **Step 4: Stop `updateModerationButtons()` from stripping the author's own trash button**

In `updateModerationButtons()`, the `else if (!canMod && existingDeleteBtn)` branch (line ~1419) removes the delete button for non-moderators. Guard it so it keeps the author's own self-delete button. Replace that branch:

```ts
            } else if (!canMod && existingDeleteBtn) {
                const msgUserId = (msgEl as HTMLElement).dataset['userId'];
                const isOwn = !!msgUserId && msgUserId === this.currentUserId;
                if (!isOwn) {
                    existingDeleteBtn.remove();
                }
                actionsContainer.querySelector('.chat-pin-btn')?.remove();
                actionsContainer.querySelector('.chat-ban-btn')?.remove();
            }
```

- [ ] **Step 5: Build the client and verify the helper compiles into dist**

Run: `npm run build`
Expected: PASS — `tsc` for server and client both succeed with no errors. Confirm output exists:

Run: `ls client/dist/public/js/lib/selfDelete.js client/dist/public/js/lib/selfDelete.d.ts && grep -c "withinSelfDeleteWindow" client/dist/public/js/lib/chat.js`
Expected: both files listed; grep count ≥ 1 (chat.js references the helper).

- [ ] **Step 6: Run the full Jest suite (both projects) to confirm green**

Run: `npx jest`
Expected: PASS — server and client projects both green.

- [ ] **Step 7: Commit (including built dist artifacts)**

```bash
git add client/src/public/js/lib/chat.ts client/dist/public/js/lib/chat.js client/dist/public/js/lib/selfDelete.js client/dist/public/js/lib/selfDelete.d.ts
git commit -m "feat(chat): show self-delete button on own recent messages"
```

(Verify nothing else under `client/dist` changed unexpectedly with `git status --short client/dist`; stage any additional emitted `.d.ts`/`.js` for `selfDelete`/`chat` if present.)

---

## Task 4: Manual staging verification checklist

**Files:** none (verification only — no jsdom harness for the DOM-heavy widget).

Context: This confirms the end-to-end UX before promotion. Deploy to `staging` first; because `chat.ts` is client JS and edge-cached, a Cloudflare purge is required for the change to appear (see `hamlive-prod-promotion` memory).

- [ ] **Step 1: Deploy to staging and purge the Cloudflare cache for `/js/*`.**

- [ ] **Step 2: As a normal (non-NCS) attendee in a running net, send a message.** Verify a trash icon appears in its action row, and clicking it (confirm "Delete this message?") removes the message for you **and** for other attendees in the same net.

- [ ] **Step 3: Verify you do NOT see a trash icon on other people's messages** (when you are not NCS).

- [ ] **Step 4: Reload the page so older history loads.** Verify your own messages older than 15 minutes do **not** show a trash icon.

- [ ] **Step 5: As NCS, verify you still see a trash icon on every message** (yours and others'), including messages older than 15 minutes, and that deleting works.

- [ ] **Step 6: Pin one of your own recent messages (as NCS), then delete it.** Verify the pinned bar clears for everyone (auto-unpin still fires).

---

## Notes for the implementer

- **Do not** add a new route, SSE event, or schema field — the spec deliberately reuses the existing delete path. If you find yourself editing `chatRoutes.js`, `sseChat.js`, or a model, stop and re-read the spec.
- The 15-minute window is a fixed constant in two places (`SELF_DELETE_WINDOW_MS` in `localChat.js` and in `selfDelete.ts`). They are intentionally independent (server enforces; client only hints). Keep both at `15 * 60 * 1000`.
- Server tests run against a real local Mongo at `127.0.0.1:27017`; if the suite cannot connect, that is an environment issue, not a code failure.
