# Chat @mentions — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Branch target:** `staging`

## Goal

Let a user type `@callsign` in a net's chat to publicly mention another
participant. The completed mention renders as a highlighted chip for everyone,
and the mentioned person gets a distinct highlight plus an in-app indicator that
they were tagged.

## Scope (decided)

- **Public mention/ping** — a normal chat message everyone sees; `@callsign` is
  highlighted. NOT a private DM.
- **Autocomplete** from the **callsigns currently present in the net** (the live
  roster). Present-only (not everyone who has ever attended).
- **Rendering:** a completed `@CALLSIGN` that matches a present roster callsign
  renders as a highlighted chip; non-matching `@tokens` render as plain text.
- **Alert when mentioned:** the mentioning message gets a distinct highlight, and
  if the recipient is scrolled away, the existing "Latest"/unread badge flags a
  mention plus a brief on-screen notice ("You were mentioned by X"). No sound, no
  browser/OS notifications.
- A mention to someone **not currently present** still renders as a chip but
  cannot ping them live (accepted).

## Non-goals (explicitly out of scope)

- Private direct messages (separate future feature/spec).
- Sound or browser/OS notifications, notification permissions.
- Cross-session / persistent "you have unread mentions" state, or a mentions
  inbox/filter.
- Server-side parsing or storing of mentions, schema changes, SSE payload
  changes.

## Architecture: client-only

The message `text` already contains the literal `@KD5SPR` and round-trips
through the existing send → store → SSE-broadcast path unchanged. So mentions are
implemented **entirely in the chat client** (`client/src/public/js/lib/chat.ts`
plus a small pure helper). No server, DB, or SSE changes.

Inputs already available to the chat widget:
- **Present roster callsigns** — `ChatWidget` is initialized with the
  `LiveNetReactiveStore` (`ChatWidget.init(liveNetStore, level)`), so it can read
  `store.stations` (the `StationIndexer`) for currently-present callsigns.
- **Current user's callsign** — from `serverInfo.callSign` (rendered into the
  page) / the chat session.

## Components

### 1. `parseMentions` — pure, testable helper

A pure function (e.g. in `client/src/public/js/lib/clientUtils.ts` or a new
`mentions.ts`), unit-tested in jest (no DOM):

```ts
interface MentionSegment { type: 'text' | 'mention'; value: string; }
interface ParsedMentions { segments: MentionSegment[]; mentioned: Set<string>; }

// Tokenize message text into text/mention segments. A token of the form
// @<callsign-chars> becomes a 'mention' segment ONLY when its uppercased value
// is in knownCallSigns; otherwise it stays part of a 'text' segment. mentioned
// is the set of uppercased callsigns actually mentioned.
function parseMentions(text: string, knownCallSigns: Set<string>): ParsedMentions
```

- Match candidate tokens with a permissive pattern (`@[A-Za-z0-9/]+`); validate
  against `knownCallSigns` (uppercased) so only real present callsigns become
  chips.
- Case-insensitive matching; preserve the original-cased display text.
- This helper does **no HTML** — escaping is the renderer's job (keeps it pure
  and safe).

### 2. Mention autocomplete (chat.ts)

Mirror the existing `handleSlashAutocomplete` pattern, but trigger when the word
currently being typed starts with `@`:
- On input, find the `@partial` token at the caret; if present, show a dropdown
  of present roster callsigns matching `partial` (case-insensitive, capped to a
  few results).
- Enter/click/Tab inserts `@CALLSIGN ` (uppercased, trailing space) replacing the
  partial; Escape/space-without-match dismisses.
- Reuse the existing dropdown styling/structure used by slash autocomplete.

### 3. Render mention chips (chat.ts)

Where message text is rendered into the DOM (the message-content build in
`renderMessage`), replace the current escape-then-insert with: run
`parseMentions(text, presentCallSigns)`, then build the content by
**HTML-escaping each `text` segment** and wrapping each `mention` segment in a
chip span (`<span class="chat-mention">@CALLSIGN</span>`). This preserves XSS
safety (text segments are escaped; chip text is a known callsign).

### 4. Self-mention highlight + in-app indicator (chat.ts)

When a message is rendered or arrives via SSE:
- If `parseMentions(...).mentioned` contains the current user's callsign **and**
  the current user is not the message author: add a distinct highlight class to
  that message element (e.g. left border + subtle background).
- If the user is currently scrolled away from the bottom (existing
  `isScrolledUp`), mark the existing "Latest"/unread badge as a mention (a
  distinct style or a `@` marker) and show a brief `showChatNotice("You were
  mentioned by <callSign>")`.
- Never trigger for the user's own messages or self-mentions.

### 5. Styles

CSS in the chat component for: `.chat-mention` chip, the mentioned-message
highlight, and the mention-flagged badge state.

## Data flow

Typed text (with `@CALLSIGN`) → existing `sendMessage` → existing store/SSE →
existing render path, now passing text through `parseMentions` + the roster to
produce chips and detect self-mentions. Nothing leaves the client that didn't
already.

## Edge cases

- Case-insensitive callsign match; chips display the roster's canonical casing.
- `@token` at string start/end and adjacent to punctuation tokenizes correctly.
- `@token` not matching any present callsign → plain text (no chip).
- Author never gets pinged for their own message; self-mention never pings.
- Mentioned user not present → chip renders, no live ping (accepted).
- Escaping happens on text segments before any HTML insertion.

## Testing

- **Jest (pure helper):** `parseMentions` — no mentions; one/multiple mentions;
  unknown `@token` stays text; case-insensitivity; punctuation adjacency;
  `mentioned` set contents; `@` with no callsign.
- **Client (manual on staging, no jsdom):** autocomplete dropdown filters present
  roster and inserts `@CALLSIGN`; chips render; being mentioned highlights the
  message + flags the badge + shows the notice; your own messages don't ping you.

## Build & deploy

Client TS (`chat.ts` + helper) → `npm run build`; emits to edge-cached
`client/dist/...` so deploy needs a **Cloudflare purge**. Server unaffected.
Ships to `staging` first, then promotes to `main`/prod via the usual path.
