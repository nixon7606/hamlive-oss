# Server-Sent Events (SSE) Architecture

This document describes Ham.Live's real-time push system using Server-Sent Events. The implementation is intentionally simple: one persistent SSE stream per live net, driven by a MongoDB change stream, pushing full net-state snapshots to all connected clients.

## Overview

Ham.Live uses SSE to eliminate short-polling once a client connects to a live net. The server pushes the complete `LiveNetDetailsResponse` JSON to every connected browser whenever the underlying data changes. Clients switch from polling to SSE automatically when the server includes an `ssePath` in an endpoint response.

## Server-side implementation

### Core module: `server/dist/lib/realtimeClients.js`

The module exports a `RealtimeClients` class (and a singleton `realtimeClients`) built on the [`express-sse-ts`](https://www.npmjs.com/package/express-sse-ts) npm package.

**Key internals:**

- `middlewareMap: Map<string, SseItem>` — one entry per active live net, keyed by `npid` (net profile ID as hex string). Each entry holds the `express-sse-ts` instance, `flexOpts`, and a `lastPush` timestamp.
- `init(dataGenerator)` — called once at startup (from `sseLiveNetRoutes.js`). Connects a dedicated raw `MongoClient` to MongoDB, opens a change stream on the `stationinteractions` collection, and starts the periodic-push scheduler.
- `middleware()` — returns an Express middleware function. The first request for a given `npid` creates a new `express-sse-ts` instance and registers it in `middlewareMap`; subsequent requests reuse the existing middleware.
- `push(npid, permitCachedResponse?)` — calls the `dataGenerator` to fetch a fresh `LiveNetDetailsResponse`, validates it with `isLiveNetDetailsResponse()`, then calls `sse.send(JSON.stringify(data))`. If the data generator throws `NetNotFoundError`, `close(npid)` is called automatically.
- `close(npid)` — sends a `net-close` named event (`sse.send(..., 'net-close')`), then removes the entry from `middlewareMap`. Called by the net-close flow.

### Change stream

`RealtimeClients` watches only the `stationinteractions` collection via the raw MongoDB driver. The change-stream filter matches:

- any `insert` operation, or
- `update` operations where `manualPushCount` was modified **or** `lastSeen` was **not** modified (i.e., a meaningful state change, not a routine keep-alive tick).

On each matching change event, `push(npid)` is called for the affected net.

If the change stream encounters an error it is recreated after an exponential back-off (starting at 1 s, doubling on each retry).

### Periodic push (presence cadence)

In addition to change-triggered pushes, a `schedulePush` loop runs at an interval derived from the net's `awayInMs` FlexOption:

```
pushIntervalMs = max(awayInMs × 0.8, PUSH_INTERVAL_FLOOR_MS)
```

`PUSH_INTERVAL_FLOOR_MS` is `10000` ms (10 s). This ensures clients receive a heartbeat-style update before the server considers them "away", independent of database activity.

If `pushIntervalMs` exceeds `SSE_IDLE_TIMEOUT_MS` (default `55000` ms, overridable via `SSE_IDLE_TIMEOUT_MS` env var) the server logs a warning, because proxy or load-balancer idle-connection timeouts may drop the stream.

### SSE route

File: `server/dist/routes/sseLiveNetRoutes.js`

```javascript
router.use('/:id', authCheck(REQ_CALLSIGN));
router.use('/:id', realtimeClients.middleware());
```

Mounted at `/api/sse/livenets`, the full SSE path is:

```
GET /api/sse/livenets/:id
```

Access requires an authenticated session with a valid call sign (`authCheck(REQ_CALLSIGN)`). There is no separate connection limiter or fallback endpoint.

### SSE payload

Every push sends the full `LiveNetDetailsResponse` JSON as the SSE data field (no typed sub-events for individual changes). The client receives the complete net state and re-renders from it.

### Net-close event

When a net is closed, `realtimeClients.close(npid)` sends a named SSE event:

```javascript
sse.send(`Net ${npid} is closing`, 'net-close');
```

The client handles this event by redirecting the browser to `/`.

### Multi-instance limitation

Each server instance only holds `middlewareMap` entries for nets whose SSE stream was first established on that instance. If a net's state changes on a different instance (e.g., via a POST that hits a different Heroku dyno), the change-stream event will still be picked up by the instance whose `MongoClient` sees it — but only that instance's connected clients will receive the push. In a horizontally-scaled deployment, clients connected to other instances rely on the periodic push cadence for updates between change-triggered pushes.

## Client-side implementation

### How the client switches from polling to SSE

File: `client/src/public/js/lib/stores.ts` (`ReactiveStore`)

`LiveNetReactiveStore` is constructed with `enableSse = true`. During the initial short-poll loop, when the server response includes a `data.ssePath` field and no `EventSource` is open yet, the store:

1. Creates `new EventSource(data.ssePath)`.
2. Calls `mainLooper.stop()` to end short-polling.
3. Registers listeners:
   - `onmessage` — parses the JSON payload and calls `handleNewData()`, which updates the store cache and notifies subscribers.
   - `net-close` (named event) — closes the `EventSource` and redirects to `/`.
   - `onerror` — notifies subscribers that the store is offline.
   - `onopen` — notifies subscribers that the store is online.

The `EventSource` uses the browser's built-in reconnection behavior; there is no custom reconnect logic.

### Presence and FavoritesReactiveStore

`LiveNetPresenceReactiveStore` is constructed with `enableSse = false` and continues polling for the lifetime of the page. `FavoritesReactiveStore` similarly does not use SSE.

## See also

- [Server Architecture](server-architecture.md) — Express.js application structure
- [Client Framework](client-framework.md) — client-side reactive stores and polling
- [Database Models](database-models.md) — `stationinteractions` collection
- [Runtime Configuration](runtime-config.md) — `awayInMs` and SSE timeout settings
