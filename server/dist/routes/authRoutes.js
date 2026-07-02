/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const passport = require('passport');
const { magicLoginLimiter, clientIp } = require('../lib/magicLoginLimiter');
const validator = require('validator');
const { conf } = require('../lib/configLib');
const { logger } = require('../lib/logger');
const UserProfile = require('../models/userProfile').getUserProfile(null);
const GoogleStrategy = require('passport-google-oauth20');
const MagicLoginStrategy = require('passport-magic-login').default;
const gravatar = require('gravatar');
const { EmailBase } = require('../lib/userNotification');
const { renderTemplate } = require('../lib/templateService');
const { isRealSenderActive } = require('../lib/emailTransports');
const { isCurrentlyLocked } = require('../lib/serverUtils');

// clientIp() and the magic-link rate limiter live in ../lib/magicLoginLimiter so
// the limiter's keying (per real CF-Connecting-IP, not the shared ::1 socket) is
// unit-testable. clientIp is reused below for saving the visitor's IP on login.

// Derive a UserProfile.displayName that always satisfies the schema validator
// (/^[A-Za-z0-9À-ÿ\-'.()\/ ]+$/, minlength 2). Email local-parts can contain '+'
// or '_', and Google display names can contain non-Latin scripts, emoji, commas,
// etc. — feeding those raw into the validator threw "invalid characters in display
// name", which aborted account creation and surfaced to the user as an auth
// failure (passport got `false` → bounced to /views/login).
const sanitizeDisplayName = raw => {
    const cleaned = String(raw || '')
        .replace(/[^A-Za-z0-9À-ÿ\-'.()\/ ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
    return cleaned.length >= 2 ? cleaned : 'New User';
};

//MagicLogin Auth:
const magicLogin = new MagicLoginStrategy({
    secret: conf.magic_link_secret,
    callbackUrl: '/auth/magiclogin/callback',

    sendMagicLink: async (destination, href, _code, req) => {
        const link = `${conf.base_url}${href}`;
        // Always capture the magic link on the request so it can be surfaced
        // in the admin panel for manual delivery when email bounces.
        if (req) req._devMagicLink = link;

        // Generate-only mode (admin "copy link" without emailing a possibly
        // bouncing address): the link is already captured above, so skip both
        // the local-login log and the SendGrid send. Nothing is persisted.
        if (req && req.generateOnly) return;

        // Local test drive: when no real sender is configured, surface the
        // sign-in link directly (returned to the browser by the route below) and
        // also print it to the server console.
        if (!(await isRealSenderActive())) {
            logger.info(
                `\n\n========== LOCAL LOGIN (email delivery disabled) ==========\n` +
                    `Magic sign-in link for ${destination}:\n${link}\n` +
                    `Open it in your browser to finish logging in.\n` +
                    `==========================================================\n`
            );
            return;
        }

        try {
            const { subject, html } = await renderTemplate('magic-link', { link });
            const email = new EmailBase({ subject, type: 'magic-login', message: html });
            const result = await email.sendMailToAddrs([destination]);

            if (result?.cooldown?.length && !result?.sent?.length) {
                logger.warn(`Auth link email to ${destination} skipped — recipient cooldown active`);
            } else if (result?.rejected?.length) {
                logger.warn(`Auth link email to ${destination} rejected by the mail server: ${result.rejected[0].reason}`);
            } else {
                logger.info(`Auth link email sent to ${destination}`);
            }
        } catch (err) {
            logger.error(err.stack);
        }
    },

    verify: (payload, done) => {
        logger.info(`look for user with this email or create user: ${payload.destination}`);

        if (!payload.destination) {
            logger.error(`paylaod: ${payload}`);
            logger.error(`paylaod type: ${typeof payload}`);
            logger.error(`paylaod stringified: ${JSON.stringify(payload)}`);

            throw new Error('Magic login payload missing destination');
        }
        //check if user already exists in our db
        UserProfile.findOneAndUpdate(
            { email: payload.destination },
            {
                lastLogin: Date.now(),
                lastAuthVia: 'email',
                photo: (gravatar.url(payload.destination, { protocol: 'https' }) || '').replace(/^\/\//, 'https://')
            }
        ).then(currentUser => {
            if (currentUser) {
                //already have the user
                logger.debug('Magic Login Auth-return: user ' + (currentUser.callSign || currentUser.id));
                if (isCurrentlyLocked(currentUser)) {
                    logger.error(`Account locked for ${currentUser.email}`);

                    done(null, false);
                } else {
                    done(null, currentUser);
                }
            } else {
                // if not, create user in our db
                new UserProfile({
                    lastAuthVia: 'email',
                    displayName: sanitizeDisplayName(payload.destination.split('@')[0]),
                    flexOptions: {
                        option: {}
                    },
                    email: payload.destination,
                    photo: (gravatar.url(payload.destination, { protocol: 'https' }) || '').replace(/^\/\//, 'https://'),
                    newAccount: true
                })
                    .save()
                    .then(newUser => {
                        logger.info('new partial user account created (email link)' + newUser);
                        done(null, newUser);
                    })
                    .catch(err => {
                        logger.error(err.stack);
                        logger.error('Likely data validation error. Missing required info on user creation?');
                        done(null, false);
                    });
            }
        });
    },

    jwtOptions: {
        expiresIn: '24h'
    }
});

passport.use(magicLogin);
router.post('/magiclogin', magicLoginLimiter, async (req, res, next) => {
    const dest = req.body && req.body.destination;
    if (typeof dest !== 'string' || !validator.isEmail(dest)) {
        return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }
    // When no real sender is configured (local test drive), include the sign-in
    // link in the JSON response so the browser can show it — no logs needed.
    if (!(await isRealSenderActive())) {
        const origJson = res.json.bind(res);
        res.json = body => origJson({ ...body, devMagicLink: req._devMagicLink || null });
    }
    return magicLogin.send(req, res, next);
});
// router.get('/magiclogin/callback', passport.authenticate('magiclogin'));
router.get('/magiclogin/callback', passport.authenticate('magiclogin'), (req, res) => {
    if (req.user) {
        // Save IP address asynchronously (non-blocking)
        const ip = clientIp(req);
        UserProfile.findOneAndUpdate({ _id: req.user._id }, { lastIp: ip }).catch(err => {
            logger.debug(`Failed to save IP for ${req.user.callSign || req.user.email}: ${err.message}`);
        });
        if (req.user.callSign) {
            res.redirect('/views/dashboard');
        } else {
            res.redirect('/views/myaccount');
        }
    } else {
        res.redirect('/views/login');
    }
});

//Google Auth (optional):
// Only register the Google strategy and routes when credentials are configured.
// Without them, the login page shows email magic-link sign-in only.
const googleAuthEnabled = Boolean(conf.google_client_id && conf.google_client_secret);

if (googleAuthEnabled) {
    passport.use(
        new GoogleStrategy(
            {
                //options for google strat
                callbackURL: `${conf.base_url}/auth/google/redirect`,
                clientID: conf.google_client_id,
                clientSecret: conf.google_client_secret
            },
            (accessToken, refreshToken, profile, done) => {
            //passport callback function

            logger.debug('Google authenticated: ' + profile.displayName);

            //check if user already exists in our db
            UserProfile.findOneAndUpdate(
                { email: profile.emails[0].value },
                {
                    lastLogin: Date.now(),
                    lastAuthVia: 'google',
                    photo: (profile.photos[0].value || '').replace(/^\/\//, 'https://')
                }
            ).then(currentUser => {
                if (currentUser) {
                    //already have the user
                    logger.debug('Google Auth-return: user ' + (currentUser.callSign || currentUser.id));

                    if (isCurrentlyLocked(currentUser)) {
                        logger.error(`Account locked for ${currentUser.email}`);

                        done(null, false);
                    } else {
                        done(null, currentUser);
                    }
                } else {
                    // if not, create user in our db
                    new UserProfile({
                        lastAuthVia: 'google',
                        displayName: sanitizeDisplayName(profile.displayName),
                        googleId: profile.id,
                        flexOptions: {
                            option: {}
                        },
                        email: profile.emails[0].value,
                        photo: (profile.photos[0].value || '').replace(/^\/\//, 'https://'),
                        newAccount: true
                    })
                        .save()
                        .then(newUser => {
                            logger.debug('new partial user account created (google)' + newUser);
                            done(null, newUser);
                        })
                        .catch(err => {
                            logger.error(err.stack);
                            logger.error('Likely data validation error. Missing required info on user creation?');
                            done(null, false);
                            logger.info('Google auth profile save failed — passport sent false, user will retry');
                        });
                }
            });
        }
    )
);

//callback for google to redirect to
router.get('/google/redirect', passport.authenticate('google'), (req, res) => {
    // this time around, we have a "code" on the uri from google. Passport will exchange the code
    // for profile info

    if (req.user) {
        // Save IP address asynchronously (non-blocking), same as the magic-link path
        const ip = clientIp(req);
        UserProfile.findOneAndUpdate({ _id: req.user._id }, { lastIp: ip }).catch(err => {
            logger.debug(`Failed to save IP for ${req.user.callSign || req.user.email}: ${err.message}`);
        });
        if (req.user.callSign) {
            res.redirect('/views/dashboard');
        } else {
            res.redirect('/views/myaccount');
        }
    } else {
        res.redirect('/views/login');
    }
});

// google specific auth, specify what we want from google (scope)
router.get(
    '/google',
    magicLoginLimiter,
    passport.authenticate('google', {
        scope: ['profile', 'email']
    })
);
} else {
    logger.warn('Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) — email sign-in only.');
    // Fallback so a stray link does not 404; send users to the login page.
    router.get(['/google', '/google/redirect'], (req, res) => res.redirect('/views/login'));
}

//logout is now async
router.get('/logout', function (req, res, next) {
    req.logout(function (err) {
        if (err) {
            return next(err);
        }
        res.redirect('/views/dashboard');
    });
});

//old sync version
// router.get('/logout', (req, res) => {
//     req.logout();
//     res.redirect('/views/dashboard');
// });

router.get('/login', (req, res) => {
    res.redirect('/views/login');
});

/**
 * Send a fresh magic sign-in link to an address using the same flow as
 * /auth/magiclogin. Resolves with { devMagicLink } — the link is always captured
 * and returned here, so CALLERS are responsible for not exposing it when an email
 * was actually sent (see adminController, which gates it behind !isRealSenderActive()).
 * For admin resend.
 */
function sendMagicSignInLink(email) {
    if (typeof email !== 'string' || !validator.isEmail(email)) {
        return Promise.reject(new Error('invalid email'));
    }
    return new Promise((resolve, reject) => {
        const req = { body: { destination: email } };
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ devMagicLink: req._devMagicLink || null, ...body }); return this; }
        };
        try {
            magicLogin.send(req, res, err => (err ? reject(err) : resolve({ devMagicLink: req._devMagicLink || null })));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Mint a fresh magic sign-in link for an address WITHOUT sending any email,
 * using the same passport-magic-login flow as sendMagicSignInLink. The link is
 * single-use and never persisted; it is only returned to the caller so an admin
 * can hand-deliver it when SendGrid can't reach the recipient. Resolves with
 * { devMagicLink }.
 */
function generateMagicSignInLink(email) {
    if (typeof email !== 'string' || !validator.isEmail(email)) {
        return Promise.reject(new Error('invalid email'));
    }
    return new Promise((resolve, reject) => {
        const req = { body: { destination: email }, generateOnly: true };
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ devMagicLink: req._devMagicLink || null, ...body }); return this; }
        };
        try {
            magicLogin.send(req, res, err => (err ? reject(err) : resolve({ devMagicLink: req._devMagicLink || null })));
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = router;
module.exports.sendMagicSignInLink = sendMagicSignInLink;
module.exports.generateMagicSignInLink = generateMagicSignInLink;
module.exports.clientIp = clientIp;
