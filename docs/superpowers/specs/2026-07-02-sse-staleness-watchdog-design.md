# SSE Staleness Watchdog

**Date:** 2026-07-02
**Status:** Approved design (prod incident 2026-07-01: one user's roster + chat frozen all
net while others updated — server pipeline verified healthy; classic dead-but-open stream)
**Target:** `staging`

## Problem

Both real-time surfaces trust an SSE stream forever once attached:

- `ReactiveStore` (client `lib/stores.ts`) short-polls, then **stops polling permanently**
  when the response carries an `ssePath` and the `EventSource` attaches. A stream that is
  open-but-silent (extension/AV proxy/middlebox buffering) produces no `onerror`, so the
  store never falls back — the view freezes until a full re-login.
- The chat client (`lib/localChat.ts`) has the same shape, worse: chat traffic is sporadic,
  and the server's 30-second keepalive is an SSE **comment** (`: keepalive`), which the
  browser's EventSource API does not surface — the client has no liveness signal at all.

Heartbeat sources (verified): the live-net stream (the only `ssePath` producer —
`liveNetController.js:68`) receives presence pushes as real `data:` messages every 20 s;
chat needs its keepalive converted to a named event.

## Design

### 1. Shared helper: `client/src/public/js/lib/staleStreamWatchdog.ts` (new, pure)

```ts
export class StaleStreamWatchdog {
    constructor(thresholdMs: number, onStale: () => void, checkEveryMs = 15_000)
    beat(): void   // call on ANY stream activity (open, message, named event)
    start(): void  // (re)arm; also beats
    stop(): void
}
```

When `now - lastBeat > thresholdMs` at a check tick: `stop()` then `onStale()` (fires once
per arm). No DOM — unit-testable with fake timers.

### 2. Store integration (`lib/stores.ts`)

- Threshold **90 s** (≥4 missed presence pushes).
- `beat()` from `onopen`, `onmessage`, and the `net-close` listener; `start()` when the
  EventSource is created.
- On stale: log a warning, `close()` the EventSource, set it to `null`, notify subscribers
  `OFFLINE`, and **resume the short-poll loop**. The poll-loop start is extracted from
  `init()` into a private `startMainLoop()` so recovery reuses the identical loop. The next
  poll response still carries `ssePath`, so the existing upgrade path re-creates the stream
  automatically; if that stream is dead too, the cycle repeats every ~90 s while polling
  keeps the view fresh — degraded, not frozen.

### 3. Chat server (`server/dist/lib/sseChat.js`, dist patch)

The 30-second keepalive changes from a comment to a real named event the client can see:
`event: hb` + `data: {}` (same interval, same lastWrite bookkeeping).

### 4. Chat client (`lib/localChat.ts`)

Watchdog (same 90 s), beaten by `onopen` and the new `hb` event (chat traffic shares the
pipe with `hb`, so beating on every named event adds nothing — deliberate simplification
from the original draft). On stale: close + null the EventSource, re-run `connect()`, and
emit `chat.resync`; the chat UI re-fetches history, **never replacing visible history with
an empty result** (a failed fetch is indistinguishable from empty, and recovery fires
exactly when the network is suspect).

## Testing

- `tests/client/lib/staleStreamWatchdog.test.ts` — fake timers: fires once after threshold
  with no beats; beats suppress it; `stop()` disarms; re-`start()` re-arms.
- Extend the sseChat server test: after a client connects, advancing timers 30 s writes
  `event: hb` (not a bare comment).
- Store/chat wiring is EventSource-dependent (no DOM test env) — verified on staging plus a
  code-review pass; the watchdog logic itself is fully unit-tested.

## Constraints

- Client via `client/src` + `npx tsc -p client/tsconfig.json` only; commit dist. Affected
  compiled files: `lib/staleStreamWatchdog.js` (new), `lib/stores.js`, `lib/localChat.js`,
  `lib/chat.js`, `lib/widgets/stations.js` (dist/source reconciliation) — shared by MANY
  views → the Cloudflare purge list for this deploy includes ALL of them (a stale cached
  `chat.js` would silently skip the history refill on recovery).
- `server/dist/lib/sseChat.js` patched directly (fork rule); PATCHES.md entry required.
- No behavior change when streams are healthy: watchdog never fires with beats < threshold.
