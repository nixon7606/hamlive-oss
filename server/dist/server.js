/* hamlive-oss — MIT License. See LICENSE. */

// Environment variables are loaded from the root .env file inside lib/configLib.
const { conf } = require('./lib/configLib');
const passport = require('passport');
const responseTime = require('response-time');
const express = require('express');
const app = express();
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger, httpLogger } = require('./lib/logger');

// ── Process-level safety net ────────────────────────────────────────────────
// Without these, a single unhandled promise rejection or stray throw takes the
// whole process down (killing every live net, SSE/chat connection, and the
// scheduler). Log rejections and keep serving; on a truly uncaught exception the
// process state is undefined, so exit and let the supervisor (systemd) restart.
let httpServer = null;
// Open sockets, tracked so graceful shutdown can force-close the long-lived
// SSE/chat connections that never end on their own.
const openSockets = new Set();
process.on('unhandledRejection', reason => {
    logger.error(`Unhandled promise rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on('uncaughtException', err => {
    logger.error(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});
function gracefulShutdown(signal) {
    logger.info(`${signal} received — shutting down`);
    const finish = () => mongoose.connection.close(false).catch(() => {}).finally(() => process.exit(0));
    if (httpServer) {
        httpServer.close(finish);
        // SSE/chat connections are long-lived and never end on their own, so
        // httpServer.close() would otherwise hang until the backstop (the ~10s
        // restart stall seen on deploys). Give in-flight requests a brief grace,
        // then destroy any lingering sockets so close() completes promptly.
        // Clients auto-reconnect their SSE stream.
        setTimeout(() => {
            for (const socket of openSockets) socket.destroy();
        }, 1_000).unref();
    } else {
        finish();
    }
    // Backstop: don't hang forever if a connection won't drain.
    setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
const {
    addServerInfo,
    populate,
    flexOpts,
    publicEndpoints,
    cookieSessionKeepAlive,
    cookieSessionStubs,
    isCurrentlyLocked
} = require('./lib/serverUtils');
const mongoose = require('mongoose');
const { seedTemplates } = require('./lib/templateService');
const authRoutes = require('./routes/authRoutes');
const dataNetProfileRoutes = require('./routes/dataNetProfileRoutes');
const dataUserProfileRoutes = require('./routes/dataUserProfileRoutes');
const dataFollowRoutes = require('./routes/dataFollowRoutes');
const dataLiveNetRoutes = require('./routes/dataLiveNetRoutes');
const endorseRoutes = require('./routes/endorseRoutes');
const presenceLiveNetRoutes = require('./routes/presenceLiveNetRoutes');
const sseLiveNetRoutes = require('./routes/sseLiveNetRoutes');
const adminInteractionRoutes = require('./routes/adminInteractionRoutes');
const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const stationInteractionRoutes = require('./routes/stationInteractionRoutes');
const utilRoutes = require('./routes/utilRoutes');
const viewRoutes = require('./routes/viewRoutes');
const sendgridWebhookRoutes = require('./routes/sendgridWebhookRoutes');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const dailyDispatch = require('./lib/dailyProcessingDispatch');
const UserProfile = require('./models/userProfile').getUserProfile(null);
const PORT = process.env['PORT'] ?? 3000;

// In development we serve plain HTTP on localhost by default — browsers treat
// http://localhost as a secure context, so geolocation/crypto/etc. still work,
// and there's no self-signed-certificate warning. Set HTTPS=true to serve dev
// over HTTPS with the bundled self-signed cert (regenerate via `npm run
// gen-certs`). In production, terminate TLS at your reverse proxy / platform.
const isDev = process.env['NODE_ENV'] === 'development';
const useHttps = isDev && process.env['HTTPS'] === 'true';
const sslOptions = useHttps
    ? {
          key: fs.readFileSync(path.join(__dirname, 'ssl', 'dev-server_key.pem')),
          cert: fs.readFileSync(path.join(__dirname, 'ssl', 'dev-server_cert.pem'))
      }
    : null;

// Optional HTTPS redirect for production behind a TLS-terminating proxy/load
// balancer (Render, Fly, Railway, nginx, Caddy, a cloud LB, ...). Enable with
// FORCE_HTTPS=true. Relies on the standard x-forwarded-proto header, so it is
// platform-neutral. Leave it off if you terminate TLS in front of the app or
// run plain HTTP on a trusted network.
if (process.env['FORCE_HTTPS'] === 'true') {
    app.use((req, res, next) => {
        const proto = req.headers['x-forwarded-proto'];
        if (proto && proto !== 'https') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

mongoose.set('strictQuery', true);
mongoose
    .connect(conf.dburi, {
        maxPoolSize: conf.realtime_mongoose_poolsize
    })
    .then(() => {
        logger.info('Connected to db (realtime pool)');
        if (useHttps) {
            httpServer = https.createServer(sslOptions, app).listen(PORT);
        } else {
            httpServer = app.listen(PORT);
        }
        // Track open sockets so gracefulShutdown() can force-close lingering
        // SSE/chat connections instead of hanging on httpServer.close().
        httpServer.on('connection', socket => {
            openSockets.add(socket);
            socket.on('close', () => openSockets.delete(socket));
        });
        const scheme = useHttps ? 'https' : 'http';
        logger.info(`${conf.applogname} listening on ${scheme}://localhost:${PORT}`);

        // Startup-time configuration warnings
        if (!conf.sendgrid_api_key) {
            logger.warn('SENDGRID_API_KEY not set — email delivery disabled. Magic-link logins and net reports will NOT be sent.');
        }
        if (!conf.chat_upload_dir || conf.chat_upload_dir === path.resolve(__dirname, '../../uploads/chat')) {
            logger.info('Chat uploads storing at default path. Set CHAT_UPLOAD_DIR env var for production persistence.');
        }
        seedTemplates().catch(err => logger.error(`seedTemplates failed: ${err.message}`));
    })
    .catch(error => {
        logger.error(error);
    });

app.use(
    cookieSession({
        maxAge: 3.5 * 24 * 60 * 60 * 1000, // 3.5 days
        keys: [conf.cookie_session_key],
        sameSite: 'Lax',
        httpOnly: true,
        secure: !isDev
    })
);

// Set trust proxy so x-forwarded-* headers work behind Caddy/nginx/cloud LB.
// This is required for FORCE_HTTPS (reads x-forwarded-proto) and for
// IP-based rate limiting to see the real client IP, not the proxy IP.
app.set('trust proxy', 1);

// Renew cookie session on every 10 minutes of activity
app.use(cookieSessionKeepAlive());

// CSRF protection: Require matching Origin or Referer header for state-changing requests
// This prevents cross-site request forgery by ensuring the request originated from our app.
// Browsers automatically include the Origin header on cross-origin POST/PUT/DELETE/PATCH requests,
// but they exclude it on same-origin requests. Safe methods (GET, HEAD, OPTIONS) are exempt.
const csrfOriginCheck = (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
    // Bypass CSRF check for auth routes (magic-link, OAuth callbacks) because:
    // 1. They're already rate-limited (5 req/5min per IP on magiclogin)
    // 2. OAuth flows require user interaction with Google's consent screen
    // 3. These routes don't use cookie-session for the actual auth action
    // If rate limits are ever loosened on /auth/*, re-evaluate this bypass.
    if (req.path.startsWith('/auth/')) return next();
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];
    const baseUrl = conf.base_url || `http://localhost:${PORT}`;
    // Allow requests with no origin (e.g., curl, internal tools, same-origin GET-style POSTs)
    // and requests where origin/referer matches our domain
    if (!origin && !referer) return next();
    try {
        const originHost = origin ? new URL(origin).host : null;
        const refererHost = referer ? new URL(referer).host : null;
        const allowedHost = new URL(baseUrl).host;
        // Allow if either origin or referer matches our host
        if (originHost === allowedHost || refererHost === allowedHost) return next();
    } catch (e) {
        // Invalid URL in header — reject
        return res.status(403).json({ error: 'Invalid request origin' });
    }
    logger.warn(`CSRF: Rejected ${req.method} ${req.path} from origin=${origin} referer=${referer}`);
    res.status(403).json({ error: 'Cross-site request forbidden' });
};
app.use(csrfOriginCheck);

//Stubs for regenerate() and save() to make passport work with cookie-session
app.use(cookieSessionStubs);

//Passport Init:
app.use(passport.initialize());
app.use(passport.session());

//serializeUser() runs after we determine if the user
// is returning or new (below).The user in this fuction is
// the user we passed to done() in the prior phase (auth routes)
// user is the mongo db user instance
passport.serializeUser((user, done) => {
    done(null, user.id);
});
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

app.use(flexOpts);
app.use(responseTime(httpLogger));
app.use(addServerInfo);
app.use(dailyDispatch);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// SendGrid event webhook needs the raw body for signature verification — mount
// before the global JSON/urlencoded parsers.
app.use('/api/sendgrid/events', express.raw({ type: '*/*' }), sendgridWebhookRoutes);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Serve chat image uploads from the SAME directory localChat writes them to
// (CHAT_UPLOAD_DIR). Without this, when CHAT_UPLOAD_DIR is set (prod), uploads
// were written there but Express only served <project-root>/uploads, so every
// chat image 404'd (broken images). Mount the specific path first.
app.use('/uploads/chat', express.static(conf.chat_upload_dir || path.resolve(__dirname, '../../uploads/chat'), { maxAge: 3600000 }));
// Serve any other uploads from the default location.
app.use('/uploads', express.static(path.join(__dirname, '../../uploads'), { maxAge: 3600000 }));
app.use(express.static(path.join(__dirname, '../../client/dist/public'), { maxAge: 7200000 }));

// Per-request CSP nonce. A fresh random nonce is generated for every response
// and exposed to EJS as `cspNonce`; each inline <script> stamps it via
// nonce="<%= cspNonce %>". This lets us drop 'unsafe-inline' from script-src
// (see scriptSrc below) — only our own inline scripts run, not injected ones.
app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});

// Security headers via helmet. CSP allows the CDNs the app needs.
// script-src uses a per-request nonce (no 'unsafe-inline'): the only inline
// scripts that run are ours, which carry nonce="<%= cspNonce %>". styleSrc
// keeps 'unsafe-inline' — inline style attributes (Bootstrap, EJS) are not
// practical to nonce.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            // Enable upgrade-insecure-requests in production; disable it in dev
            // (plain HTTP on localhost). Must be [] (an enabled directive with no
            // value) for the prod case — helmet rejects `undefined` as an invalid
            // directive value and throws at startup, only on the production path.
            upgradeInsecureRequests: isDev ? null : [],
            scriptSrc: [
                "'self'",
                (req, res) => `'nonce-${res.locals.cspNonce}'`,
                'cdn.jsdelivr.net',
                'www.googletagmanager.com'
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                'cdn.jsdelivr.net',
                'fonts.googleapis.com'
            ],
            fontSrc: [
                "'self'",
                'cdn.jsdelivr.net',
                'fonts.gstatic.com'
            ],
            imgSrc: [
                "'self'",
                'data:',
                '*.gravatar.com',
                // Google sign-in profile photos (lh3/lh4/...googleusercontent.com);
                // without this, Google users' avatars are blocked by CSP and render broken.
                '*.googleusercontent.com'
            ],
            frameSrc: [
                'www.youtube.com'
            ],
            connectSrc: [
                "'self'",
                // emoji-picker-element fetches its emoji data JSON at runtime
                // (emoji-picker-element-data@^1/.../data.json) — this is a fetch,
                // so it needs connect-src, not script-src. Without it CSP blocks
                // the fetch and the picker renders "Could not find emojis".
                'cdn.jsdelivr.net',
                'www.google-analytics.com',
                'www.googletagmanager.com'
            ],
            formAction: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    // In production, HSTS should be on. In dev, disable it so localhost works
    // without certificate warnings. Production terminates TLS at the reverse proxy,
    // which should set its own HSTS header.
    strictTransportSecurity: !isDev ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    } : false
}));

app.use('/views', viewRoutes);
//API:CRUD Routes:
app.use('/api/data/netprofiles', dataNetProfileRoutes);
app.use('/api/data/userprofiles', dataUserProfileRoutes);
app.use('/api/data/follow', dataFollowRoutes);
app.use('/api/data/livenets', dataLiveNetRoutes);
// In-house Chat Routes
app.use('/api/chat', chatRoutes);
//API: Interaction Routes:
app.use('/api/admin/interactions', adminInteractionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/station/interactions', stationInteractionRoutes);
//API:Misc Routes:
app.use('/api/util', utilRoutes);
// Realtime SSE
app.use('/api/sse/livenets', sseLiveNetRoutes);
//API: LiveNet Presence
app.use('/api/presence/livenets', presenceLiveNetRoutes);
//API: Security Routes
app.use('/api/endorse', endorseRoutes);
//API Desc
app.get('/api', (_req, res) => res.json(publicEndpoints(app)));
logger.debug(`\n\nAPI:\n${JSON.stringify(publicEndpoints(app), null, 1)}\n`);

app.use('/auth', authRoutes);
app.get('/', (req, res) => {
    if (req.user) {
        res.redirect('/views/dashboard');
    } else {
        res.redirect('/views/intro');
    }
});
app.get('/login', (_req, res) => {
    res.redirect('/views/login');
});
app.get('/logout', (_req, res) => {
    res.redirect('/auth/logout');
});

// Scheduled net starter — checks every 60 seconds for matching schedules.
// Gated by config (default ON unless explicitly disabled). A host can turn this
// off via SCHEDULED_NET_STARTER_ENABLED=false in .env — useful on a staging box
// so it doesn't auto-start nets and email followers during testing.
if (conf.background_tasks?.scheduledNetStarter?.enabled !== false) {
    const { checkScheduledNets } = require('./lib/backgroundTasks/scheduledNetStarter');
    setInterval(() => {
        checkScheduledNets().catch(err => {
            const { logger } = require('./lib/logger');
            logger.error(`ScheduledNetStarter interval error: ${err.message}`);
        });
    }, 60_000);
    // Run once on startup too
    setTimeout(() => checkScheduledNets().catch(() => {}), 10_000);
} else {
    logger.warn('scheduledNetStarter disabled by config — 60s auto-start interval not started');
}

app.use((req, res) => {
    if (!res.headersSent) return res.status(404).render('404', populate(req, res, { VIEW: '404' }));
});

// Global error handler (must be last, 4-arg). Backstop so a throw or next(err)
// from any route/middleware returns a clean response instead of crashing the
// process or leaving a request hanging. Detailed errors are logged server-side
// only; clients get a generic message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error(`Unhandled route error (${req.method} ${req.path}): ${err && err.stack ? err.stack : err}`);
    if (res.headersSent) return next(err);
    const status = (err && err.status) || 500;
    if (req.path.startsWith('/api/')) {
        return res.status(status).json({ error: 'Internal server error' });
    }
    return res.status(status).send('Something went wrong. Please try again.');
});
