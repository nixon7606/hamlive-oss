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
const { logger, httpLogger } = require('./lib/logger');
const {
    addServerInfo,
    populate,
    flexOpts,
    publicEndpoints,
    cookieSessionKeepAlive,
    cookieSessionStubs
} = require('./lib/serverUtils');
const mongoose = require('mongoose');
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
const cookieSession = require('cookie-session');
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
            https.createServer(sslOptions, app).listen(PORT);
        } else {
            app.listen(PORT);
        }
        const scheme = useHttps ? 'https' : 'http';
        logger.info(`${conf.applogname} listening on ${scheme}://localhost:${PORT}`);

        // Startup-time configuration warnings
        if (!conf.sendgrid_api_key) {
            logger.warn('SENDGRID_API_KEY not set — email delivery disabled. Magic-link logins and net reports will NOT be sent.');
        }
        if (!conf.chat_upload_dir || conf.chat_upload_dir === path.resolve(__dirname, '../../uploads/chat')) {
            logger.info('Chat uploads storing at default path. Set CHAT_UPLOAD_DIR env var for production persistence.');
        }
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
        done(null, user);
    });
});

app.use(flexOpts);
app.use(responseTime(httpLogger));
app.use(addServerInfo);
app.use(dailyDispatch);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Serve chat image uploads from configurable directory (default: <project-root>/uploads/)
app.use('/uploads', express.static(path.join(__dirname, '../../uploads'), { maxAge: 3600000 }));
app.use(express.static(path.join(__dirname, '../../client/dist/public'), { maxAge: 7200000 }));
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

// Scheduled net starter — checks every 60 seconds for matching schedules
const { checkScheduledNets } = require('./lib/backgroundTasks/scheduledNetStarter');
setInterval(() => {
    checkScheduledNets().catch(err => {
        const { logger } = require('./lib/logger');
        logger.error(`ScheduledNetStarter interval error: ${err.message}`);
    });
}, 60_000);
// Run once on startup too
setTimeout(() => checkScheduledNets().catch(() => {}), 10_000);

app.use((req, res) => {
    if (!res.headersSent) return res.status(404).render('404', populate(req, res, { VIEW: '404' }));
});
