# Chat @mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users type `@callsign` in a net's chat to publicly mention present participants — rendered as a highlighted chip, with a self-mention highlight + in-app badge indicator — entirely client-side.

**Architecture:** The message `text` already carries the literal `@KD5SPR` through the existing send/store/SSE path, so this is client-only. A pure `parseMentions(text, knownCallSigns)` helper (jest-tested via ts-jest) tokenizes text into text/mention segments; `chat.ts` uses it to render chips, detect self-mentions, and power an `@`-autocomplete from the live roster. No server, DB, or SSE changes.

**Tech Stack:** Vanilla client TypeScript (ES modules, compiled `client/src` → `client/dist` via `npm run build`), Jest + **ts-jest** (already a dependency) for the pure helper.

**Conventions:**
- Server tests run under the existing `server` jest project; this plan adds a `client` jest project (ts-jest) for `tests/client/**/*.test.ts`. Run everything with `npx jest`. The pre-existing `localChat uploadImage` server-test failure is unrelated — ignore it.
- Client tasks (2–4) have no DOM test harness — implement, `npm run build`, verify the compiled output by grep, and functionally verify on staging in Task 5.
- Client imports use the `#@client/...js` alias with a `.js` extension even though sources are `.ts` — follow the existing style in `chat.ts`.

---

## Task 1: `parseMentions` pure helper + client jest project

**Files:**
- Modify: `jest.config.js` (add a `client` project using ts-jest)
- Create: `tests/client/lib/mentions.test.ts`
- Create: `client/src/public/js/lib/mentions.ts`

- [ ] **Step 1: Add a `client` jest project (ts-jest)**

In `jest.config.js`, the `projects` array currently holds only the `server` project. Add a second project so client TS tests run. The full file becomes:

```js
// Jest configuration for Ham.Live OSS
module.exports = {
  projects: [
    {
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/server/**/*.test.js'],
      testTimeout: 30000
    },
    {
      displayName: 'client',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/client/**/*.test.ts'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node' } }]
      }
    }
  ],
  collectCoverageFrom: [
    'server/dist/lib/localChat.js',
    'server/dist/models/chatMessage.js',
    'server/dist/models/chatBan.js',
    'server/dist/routes/chatRoutes.js',
    'server/dist/lib/sseChat.js',
    'client/src/public/js/lib/localChat.ts',
    'client/src/public/js/lib/chat.ts'
  ],
  coverageReporters: ['text', 'lcov', 'html']
};
```

> Note: the `client` project's `testMatch` is `*.test.ts` only, so the pre-existing orphaned `tests/client/lib/*.test.js` files (which `require()` the ESM dist and don't run) are left untouched.

- [ ] **Step 2: Write the failing test**

Create `tests/client/lib/mentions.test.ts`:

```ts
import { parseMentions } from '../../../client/src/public/js/lib/mentions';

const known = new Set(['KD5SPR', 'N0AD']);

test('no mentions: single text segment, empty mentioned', () => {
  const r = parseMentions('hello there', known);
  expect(r.segments).toEqual([{ type: 'text', value: 'hello there' }]);
  expect(r.mentioned.size).toBe(0);
});

test('one known mention splits into text + mention segments', () => {
  const r = parseMentions('hi @KD5SPR ok', known);
  expect(r.segments).toEqual([
    { type: 'text', value: 'hi ' },
    { type: 'mention', value: '@KD5SPR' },
    { type: 'text', value: ' ok' }
  ]);
  expect([...r.mentioned]).toEqual(['KD5SPR']);
});

test('unknown token stays plain text', () => {
  const r = parseMentions('hi @NOBODY', known);
  expect(r.segments).toEqual([{ type: 'text', value: 'hi @NOBODY' }]);
  expect(r.mentioned.size).toBe(0);
});

test('matching is case-insensitive but preserves typed casing', () => {
  const r = parseMentions('yo @kd5spr', known);
  expect(r.segments[1]).toEqual({ type: 'mention', value: '@kd5spr' });
  expect([...r.mentioned]).toEqual(['KD5SPR']);
});

test('multiple mentions and trailing punctuation', () => {
  const r = parseMentions('@N0AD and @KD5SPR!', known);
  expect([...r.mentioned].sort()).toEqual(['KD5SPR', 'N0AD']);
  // the "!" is not part of the callsign token
  expect(r.segments[r.segments.length - 1]).toEqual({ type: 'text', value: '!' });
});

test('a lone @ with no callsign is plain text', () => {
  const r = parseMentions('email me @ home', known);
  expect(r.mentioned.size).toBe(0);
  expect(r.segments).toEqual([{ type: 'text', value: 'email me @ home' }]);
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `npx jest --selectProjects client`
Expected: FAIL — `Cannot find module '.../mentions'` (file not created yet).

- [ ] **Step 4: Create the helper**

Create `client/src/public/js/lib/mentions.ts`:

```ts
/* hamlive-oss — MIT License. See LICENSE. */

export interface MentionSegment {
    type: 'text' | 'mention';
    value: string;
}

export interface ParsedMentions {
    segments: MentionSegment[];
    mentioned: Set<string>;
}

/**
 * Tokenize chat message text into text/mention segments. A token of the form
 * @<callsign-chars> becomes a 'mention' segment ONLY when its uppercased value
 * is in knownCallSigns; otherwise it stays plain text. `mentioned` is the set of
 * uppercased callsigns actually mentioned. Pure: does NO HTML escaping — the
 * caller escapes text segments before inserting into the DOM.
 */
export function parseMentions(text: string, knownCallSigns: Set<string>): ParsedMentions {
    const segments: MentionSegment[] = [];
    const mentioned = new Set<string>();
    const re = /@([A-Za-z0-9/]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const cs = m[1].toUpperCase();
        if (!knownCallSigns.has(cs)) continue;
        if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) });
        segments.push({ type: 'mention', value: m[0] });
        mentioned.add(cs);
        last = m.index + m[0].length;
    }
    if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
    return { segments, mentioned };
}
```

- [ ] **Step 5: Run, verify PASS, then full suite**

Run: `npx jest --selectProjects client`
Expected: PASS (6 tests).
Then `npx jest` → server + client projects both run; only the known `localChat uploadImage` server failure remains.

- [ ] **Step 6: Commit**

```bash
git add jest.config.js tests/client/lib/mentions.test.ts client/src/public/js/lib/mentions.ts
git commit -m "feat(chat): parseMentions helper + client jest project (ts-jest)"
```

---

## Task 2: Render mention chips in chat messages

**Files:**
- Modify: `client/src/public/js/lib/chat.ts` (import, new helpers, two render sites, CSS)

> Client task — no jest. Implement, `npm run build`, verify compiled output + manually on staging (Task 5).

- [ ] **Step 1: Import the helper**

At the top of `client/src/public/js/lib/chat.ts`, add to the imports (match the existing `#@client/...js` style):

```ts
import { parseMentions } from '#@client/lib/mentions.js';
```

- [ ] **Step 2: Add roster + body-render helpers**

Add these two private methods to the `ChatWidget` class (place them near `linkifyText`, ~line 1732):

```ts
    /** Uppercased callsigns of stations currently present in the net. */
    private rosterCallSigns(): Set<string> {
        return new Set(
            (this.store?.stations.list ?? [])
                .map(s => (s.callSign || '').toUpperCase())
                .filter(Boolean)
        );
    }

    /**
     * Render message text to HTML: mention tokens that match a present callsign
     * become chips; everything else is escaped + linkified as before. Text
     * segments are HTML-escaped, so this is XSS-safe.
     */
    private renderMessageBody(text: string): string {
        const { segments } = parseMentions(text, this.rosterCallSigns());
        return segments
            .map(seg =>
                seg.type === 'mention'
                    ? `<span class="chat-mention">${this.escapeHtml(seg.value)}</span>`
                    : this.linkifyText(this.escapeHtml(seg.value))
            )
            .join('');
    }
```

- [ ] **Step 3: Use it at the two message-render sites**

In `renderMessage`, replace the line (~512):

```ts
            messageContent += `<span class="chat-text">${this.linkifyText(this.escapeHtml(msg.text))}</span>`;
```
with:
```ts
            messageContent += `<span class="chat-text">${this.renderMessageBody(msg.text)}</span>`;
```

And in the message-updated handler, replace the line (~867):

```ts
            contentEl.innerHTML = `<span class="chat-text">${this.linkifyText(this.escapeHtml(msg.text))}</span>`;
```
with:
```ts
            contentEl.innerHTML = `<span class="chat-text">${this.renderMessageBody(msg.text)}</span>`;
```

- [ ] **Step 4: Add chip CSS**

Find the chat component's `<style>` block (the same one that defines `.chat-reaction`, `.chat-mention` does not exist yet). Add this rule alongside the other `.chat-*` rules:

```css
                    .chat-mention {
                        color: var(--hl-secondary);
                        background: rgba(163, 118, 195, 0.18);
                        border-radius: 4px;
                        padding: 0 3px;
                        font-weight: 600;
                    }
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exit 0 (tsc clean for server + client).

- [ ] **Step 6: Confirm compiled output**

Run: `grep -c "renderMessageBody\|parseMentions" client/dist/public/js/lib/chat.js`
Expected: non-zero.

- [ ] **Step 7: Commit**

```bash
git add client/src/public/js/lib/chat.ts client/dist/public/js/lib/chat.js client/dist/public/js/lib/chat.js.map client/dist/public/js/lib/chat.d.ts.map
git commit -m "feat(chat): render @callsign mentions as highlighted chips"
```

---

## Task 3: Self-mention highlight + in-app badge indicator

**Files:**
- Modify: `client/src/public/js/lib/chat.ts` (self-mention helper, render highlight, new-message indicator, badge state, CSS)

> Client task — implement, build, verify on staging (Task 5).

- [ ] **Step 1: Add a `hasUnreadMention` flag**

In the `ChatWidget` class fields, next to `private unreadCount = 0;` (~line 75), add:

```ts
    private hasUnreadMention = false;
```

- [ ] **Step 2: Add a self-mention helper**

Add this private method near `renderMessageBody`:

```ts
    /** True when this message text mentions the current user (by their callsign). */
    private isSelfMentioned(text: string): boolean {
        const me = this.selfCallSign;
        if (!me) return false;
        return parseMentions(text, new Set([me])).mentioned.has(me);
    }
```

- [ ] **Step 3: Highlight a mentioning message when it renders**

In `renderMessage`, after `this.lastRenderedCallSign = msg.callSign || null;` (~line 558) and before `this.setupMessageActions(...)`, add:

```ts
        if (msg.userId !== this.currentUserId && this.isSelfMentioned(msg.text || '')) {
            msgEl.classList.add('mentions-me');
        }
```

- [ ] **Step 4: Flag the badge + reset on read**

In `handleNewMessage` (~line 808), inside the `if (!wasNearBottom) { … }` block, after `this.unreadCount += 1;`, add the mention flag:

```ts
                if (msg.userId !== this.currentUserId && this.isSelfMentioned(msg.text || '')) {
                    this.hasUnreadMention = true;
                }
```

Then reset `hasUnreadMention` wherever `this.unreadCount = 0;` is set (there are two spots — the visibility/focus reset ~line 171 and the Latest-button click ~line 1540). At each `this.unreadCount = 0;`, add immediately after:

```ts
                this.hasUnreadMention = false;
```

- [ ] **Step 5: Make the Latest badge show the mention state**

In `updateLatestButton` (~line 1557), the badge currently shows `this.unreadCount`. Update the badge block so a waiting mention is visually distinct. Replace the badge-visibility block:

```ts
        if (badge) {
            if (this.unreadCount > 0) {
                badge.textContent = String(this.unreadCount);
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
```
with:
```ts
        if (badge) {
            if (this.unreadCount > 0) {
                badge.textContent = this.hasUnreadMention ? `@ ${this.unreadCount}` : String(this.unreadCount);
                badge.classList.toggle('has-mention', this.hasUnreadMention);
                badge.style.display = 'inline';
            } else {
                badge.classList.remove('has-mention');
                badge.style.display = 'none';
            }
        }
```

- [ ] **Step 6: Add highlight + badge CSS**

In the chat `<style>` block, alongside `.chat-mention`, add:

```css
                    .chat-message.mentions-me {
                        border-left: 3px solid var(--hl-secondary);
                        background: rgba(163, 118, 195, 0.08);
                    }
                    .chat-unread-badge.has-mention {
                        background: var(--hl-secondary) !important;
                    }
```

> Design note: the "in-app indicator" is the highlighted message plus the mention-flagged Latest badge. We deliberately do NOT pop a `showChatNotice` here — that method scrolls the view to the bottom, which would yank a user away from history they're reading. The badge is the non-intrusive cue; clicking it / scrolling down clears it.

- [ ] **Step 7: Build + confirm**

Run: `npm run build`
Then: `grep -c "isSelfMentioned\|hasUnreadMention\|mentions-me" client/dist/public/js/lib/chat.js`
Expected: build exit 0; grep non-zero.

- [ ] **Step 8: Commit**

```bash
git add client/src/public/js/lib/chat.ts client/dist/public/js/lib/chat.js client/dist/public/js/lib/chat.js.map client/dist/public/js/lib/chat.d.ts.map
git commit -m "feat(chat): highlight self-mentions + flag the unread badge"
```

---

## Task 4: `@`-autocomplete from the present roster

**Files:**
- Modify: `client/src/public/js/lib/chat.ts` (new `handleMentionAutocomplete`, wire into the input listener, CSS reuse)

> Client task — implement, build, verify on staging (Task 5).

- [ ] **Step 1: Add the autocomplete method**

Add this private method near `handleSlashAutocomplete` (~line 1642):

```ts
    private handleMentionAutocomplete(): void {
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        if (!textInput) return;
        this.querySelector('.chat-mention-dropdown')?.remove();

        const val = textInput.value;
        const caret = textInput.selectionStart ?? val.length;
        // An @token being typed: at start or after whitespace, up to the caret.
        const before = val.slice(0, caret);
        const m = /(?:^|\s)@([A-Za-z0-9/]*)$/.exec(before);
        if (!m) return;

        const partial = m[1].toUpperCase();
        const matches = [...this.rosterCallSigns()]
            .filter(cs => cs.startsWith(partial) && cs !== this.selfCallSign)
            .sort()
            .slice(0, 8);
        if (matches.length === 0) return;

        const dd = document.createElement('div');
        dd.className = 'chat-mention-dropdown';
        dd.style.cssText = 'position: absolute; bottom: 100%; left: 0; right: 0; background: var(--hl-dark); border: 1px solid var(--hl-quaternary); border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 100;';
        matches.forEach(cs => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 6px 10px; font-size: 12px; color: var(--hl-light); cursor: pointer; border-bottom: 1px solid rgba(240, 238, 222, 0.1);';
            item.textContent = cs;
            item.addEventListener('click', () => {
                const start = caret - m[1].length; // position just after the '@'
                textInput.value = val.slice(0, start) + cs + ' ' + val.slice(caret);
                this.querySelector('.chat-mention-dropdown')?.remove();
                textInput.focus();
                const pos = start + cs.length + 1;
                textInput.setSelectionRange(pos, pos);
            });
            dd.appendChild(item);
        });

        const wrapper = this.querySelector('.chat-input-wrapper');
        if (wrapper) {
            (wrapper as HTMLElement).style.position = 'relative';
            wrapper.appendChild(dd);
        }
    }
```

- [ ] **Step 2: Wire it into the input listener**

Find where `this.handleSlashAutocomplete();` is called in the text-input `input` listener (~line 686) and add the mention call right after it:

```ts
            this.handleSlashAutocomplete();
            this.handleMentionAutocomplete();
```

- [ ] **Step 3: Remove the dropdown on disconnect**

In `disconnect()` (~line 1716, next to the slash-dropdown cleanup), add:

```ts
        this.querySelector('.chat-mention-dropdown')?.remove();
```

- [ ] **Step 4: Build + confirm**

Run: `npm run build`
Then: `grep -c "handleMentionAutocomplete\|chat-mention-dropdown" client/dist/public/js/lib/chat.js`
Expected: build exit 0; grep non-zero.

- [ ] **Step 5: Commit**

```bash
git add client/src/public/js/lib/chat.ts client/dist/public/js/lib/chat.js client/dist/public/js/lib/chat.js.map client/dist/public/js/lib/chat.d.ts.map
git commit -m "feat(chat): @-autocomplete suggesting present roster callsigns"
```

---

## Task 5: Verify on staging + deploy

**Files:** none (deploy + manual verification)

- [ ] **Step 1: Full suite + build green**

Run: `npx jest` → server + client projects pass (only the known `localChat uploadImage` failure).
Run: `npm run build` → exit 0.

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

Purge `https://staging.netcontrol.live/js/lib/chat.js` and `/js/lib/mentions.js` (or Purge Everything), then hard-refresh.

- [ ] **Step 5: Manual verification (two accounts in a net)**
  - Type `@` → a dropdown of present callsigns appears; pick one → inserts `@CALLSIGN `.
  - Send it → the `@CALLSIGN` shows as a highlighted chip for everyone.
  - As the mentioned user: the message is highlighted (left border); if you were scrolled up, the "Latest" badge shows the `@` mention flag; clicking it clears the flag.
  - Mention a callsign **not** present → renders as plain text (no chip), no errors.
  - Your **own** message mentioning yourself does **not** highlight/flag you.

- [ ] **Step 6: Done** — feature complete on staging. Promotion to prod (`main`/CT 202) follows the usual merge + deploy + prod Cloudflare purge.

---

## Notes for the implementer

- **DRY:** `parseMentions` is the single source of truth for tokenizing/mention-detection (used by chips, self-mention, and indirectly the autocomplete's roster set). Don't reimplement token scanning inline.
- **YAGNI:** no server/DB/SSE changes, no browser/sound notifications, no DMs, no mentions inbox — all out of scope per the spec.
- **XSS:** only `text` segments are interpolated, and they go through `this.escapeHtml`; chip text is a known roster callsign. Never interpolate raw `text` into HTML.
- **Known pre-existing failure:** `localChat uploadImage › accepts valid image` (server project) — unrelated, leave it.
