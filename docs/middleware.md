# Middleware Architecture

This document describes Ham.Live's middleware stack and the request processing pipeline as implemented in `server/dist/server.js` and `server/dist/lib/serverUtils.js`.

## Middleware Stack (in order)

The following middleware is registered on the Express app in this exact order:

### 1. HTTPS Redirect (conditional)

```javascript
if (process.env['FORCE_HTTPS'] === 'true') {
    app.use((req, res, next) => {
        const proto = req.headers['x-forwarded-proto'];
        if (proto && proto !== 'https') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });
}
```

An inline middleware, not a third-party library. Active only when `FORCE_HTTPS=true`. Inspects the `x-forwarded-proto` header set by a TLS-terminating reverse proxy (nginx, Caddy, Render, Fly, Railway, etc.). Only redirects when the header is present and non-HTTPS; plain HTTP traffic without the header passes through unaffected.

### 2. Cookie Session

```javascript
app.use(
    cookieSession({
        maxAge: 3.5 * 24 * 60 * 60 * 1000, // 3.5 days
        keys: [conf.cookie_session_key]      // single key, from COOKIE_SESSION_KEY env var
    })
);
```

Uses the `cookie-session` package. Single signing key (`COOKIE_SESSION_KEY`). Fixed 3.5-day TTL. No `name`, `secure`, `httpOnly`, or `sameSite` options are set — the package's defaults apply.

### 3. Session Keep-Alive

```javascript
app.use(cookieSessionKeepAlive());
```

Implemented in `serverUtils.js`. Renews the session timestamp every 10 minutes of activity, resetting the TTL clock.

### 4. Cookie Session Stubs

```javascript
app.use(cookieSessionStubs);
```

Adds `regenerate()` and `save()` stub methods to the session object to satisfy Passport.js, which expects the `express-session` API that `cookie-session` does not provide.

### 5. Passport

```javascript
app.use(passport.initialize());
app.use(passport.session());
```

Initializes Passport and restores authentication state from the session. Strategies configured: Google OAuth2 (optional, only when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set) and magic-link email (`passport-magic-login`). No local (username/password) strategy.

### 6. Application Middleware

```javascript
app.use(flexOpts);           // load per-user FlexOptions from MongoDB into res.locals.flexOpts
app.use(responseTime(httpLogger)); // logs HTTP request/response timing
app.use(addServerInfo);      // populates res.locals.serverInfo for EJS templates and API responses
app.use(dailyDispatch);      // triggers background task processing once per day
```

- **`flexOpts`** — Async middleware in `serverUtils.js`. Calls `getFlexOptionsByUser()` and stores the merged global+user FlexOptions in `res.locals.flexOpts`. Required by route handlers that use `ResponseHandler` (it reads `flexOpts.baseTtlMs`).
- **`responseTime(httpLogger)`** — Uses the `response-time` npm package. Calls `httpLogger` (from `lib/logger.js`) with the response duration.
- **`addServerInfo`** — Async middleware in `serverUtils.js`. Builds `res.locals.serverInfo` with server environment, feature flags, and per-user data; consumed by `populate()` for EJS views.
- **`dailyDispatch`** — Middleware in `lib/dailyProcessingDispatch.js`. Checks a `DayTracker` MongoDB document; when tasks are due, forks `lib/tasksLoader.js` as a child process to run background tasks. Always calls `next()`.

### 7. EJS Setup

```javascript
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
```

### 8. Request Parsing and Static Files

```javascript
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../client/dist/public'), { maxAge: 7200000 }));
```

Standard Express body parsers (no size limit is set explicitly beyond Express defaults). Static files are served with a 2-hour browser cache.

### 9. Routes

All route handlers are mounted after the middleware chain above. See [Routing and API](routing-api.md) for the full route map.

## Authorization

There is no global authorization middleware. Route-level authorization uses `authCheck(options)` from `serverUtils.js`, applied per-router or per-route:

```javascript
const { authCheck, REQ_LOGIN, REQ_CALLSIGN } = require('../lib/serverUtils');

router.post('/:id', authCheck(REQ_CALLSIGN), handler);
```

**Bitflags** (defined in `serverUtils.js`):

| Constant | Value | Effect |
|---|---|---|
| `REQ_LOGIN` | `0x0001` | Redirects to `/views/login` if not authenticated |
| `REQ_CALLSIGN` | `0x0010` | Redirects to `/views/myaccount?cswarn=true` if no callsign set |
| `REQ_NETOWNER` | `0x0100` | (defined; net-level ownership check) |
| `REQ_SUPERUSER` | `0x1000` | (defined; superuser check) |

## Error Handling

There is no four-argument Express error handler. Errors are handled at the route level through:

- **`handleRequest(res, callback, label)`** — Async wrapper from `lib/responseUtils.js`. Calls `callback()`, sends `200 OK` on success; catches exceptions and sends `500 INTERNAL_SERVER_ERROR`.
- **`ResponseHandler`** — Class from `lib/responseUtils.js`. `sendResponse(res, status, data)` and `sendError(res, status, message)` both produce `EndPointResponse`-shaped JSON.
- **404 fallback** — A catch-all `app.use()` at the bottom of `server.js` renders the `404.ejs` view for any unmatched request.

## Response Envelope

All API responses use `prepareEndPointResponse()` from `lib/responseUtils.js`. Response data fields are spread at the **top level** of the JSON object (not nested under a `message` key). On success, `errorMessage` is absent; on error, it is present and `errorHash` is included.

```json
{
    "endpointVersion": "1.0",
    "now": "2025-08-17T10:30:00.000Z",
    "ssePath": null,
    "ttlMs": 5000,
    "hash": "abc123...",
    // ...actual data fields spread here at top level on success
}
```

## Packages NOT in Use

The following packages are **not installed and not used**:

- `helmet` — no security-header middleware
- `cors` — no CORS middleware
- `express-rate-limit` — no rate limiting
- `csurf` — no CSRF tokens
- `compression` — no gzip middleware
- `morgan` — no morgan request logging
- `connect-livereload` — no hot-reload middleware
- `passport-local` — no local (username/password) strategy

## See also

- [Server Architecture](server-architecture.md) — Express application structure and bootstrapping
- [Routing and API](routing-api.md) — Route handlers and API patterns
- [Runtime Configuration](runtime-config.md) — Configuration system and environment variables

(End of middleware architecture documentation.)
