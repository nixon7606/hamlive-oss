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
const { EmailBase, emailEnabled } = require('../lib/userNotification');
const { isCurrentlyLocked } = require('../lib/serverUtils');

// clientIp() and the magic-link rate limiter live in ../lib/magicLoginLimiter so
// the limiter's keying (per real CF-Connecting-IP, not the shared ::1 socket) is
// unit-testable. clientIp is reused below for saving the visitor's IP on login.

//MagicLogin Auth:
const magicLogin = new MagicLoginStrategy({
    secret: conf.magic_link_secret,
    callbackUrl: '/auth/magiclogin/callback',

    sendMagicLink: async (destination, href, _code, req) => {
        const link = `${conf.base_url}${href}`;
        // Always capture the magic link on the request so it can be surfaced
        // in the admin panel for manual delivery when email bounces.
        if (req) req._devMagicLink = link;

        // Local test drive: when email delivery is not configured, surface the
        // sign-in link directly (returned to the browser by the route below) and
        // also print it to the server console.
        if (!emailEnabled) {
            logger.info(
                `\n\n========== LOCAL LOGIN (email delivery disabled) ==========\n` +
                    `Magic sign-in link for ${destination}:\n${link}\n` +
                    `Open it in your browser to finish logging in.\n` +
                    `==========================================================\n`
            );
            return;
        }

        try {
            const email = new EmailBase({
                subject: 'Sign in to netcontrol.live',
                type: 'magic-login',
                message:
                    `<div style="background-color:#f4f2ec; padding:24px 12px; font-family:Arial,Helvetica,sans-serif;">` +
                    `<table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e2ddd0; border-radius:10px; overflow:hidden;">` +
                    `<tr><td align="center" bgcolor="#23262B" style="background-color:#23262B; padding:20px 0;"><img src="https://netcontrol.live/img/hamlive-logo-tagline-beta-horizontal-darkbg.png" alt="netcontrol.live" width="300" style="display:block; width:300px; max-width:82%; height:auto; border:0;"></td></tr>` +
                    `<tr><td style="padding:28px 32px 8px 32px; font-family:Georgia,'Times New Roman',serif; color:#23262B; font-size:20px; font-weight:bold;">Finish signing in</td></tr>` +
                    `<tr><td style="padding:0 32px 20px 32px; color:#444444; font-size:14px; line-height:1.6;">Click the button below to finish signing in to your netcontrol.live account. This link expires shortly and can only be used once.</td></tr>` +
                    `<tr><td style="padding:0 32px 26px 32px;"><a clicktracking=off href='${link}' style="display:inline-block; background-color:#C24A38; color:#ffffff; font-size:15px; font-weight:bold; text-decoration:none; padding:12px 26px; border-radius:6px;">Sign in</a></td></tr>` +
                    `<tr><td style="padding:0 32px 26px 32px; color:#7a756a; font-size:12px; line-height:1.6;">If the button does not work, paste this link into your browser:<br><a clicktracking=off href='${link}' style="color:#C24A38; word-break:break-all;">${link}</a></td></tr>` +
                    `<tr><td bgcolor="#23262B" style="background-color:#23262B; padding:16px 32px; color:#9a9a9a; font-size:11px; line-height:1.6;">If you did not request this, you can safely ignore this email.<br>Sent by <a href="https://netcontrol.live" style="color:#C4933F; text-decoration:none;">netcontrol.live</a> &middot; Amateur Radio Net Control</td></tr>` +
                    `</table></div>`
            });

            await email.sendMailToAddrs([destination]);

            logger.info(`Auth link email sent to ${destination}`);
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
                    displayName: payload.destination.split('@')[0].slice(0, 40) || 'New User',
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
router.post('/magiclogin', magicLoginLimiter, (req, res, next) => {
    const dest = req.body && req.body.destination;
    if (typeof dest !== 'string' || !validator.isEmail(dest)) {
        return res.status(400).json({ success: false, error: 'A valid email address is required.' });
    }
    // When email delivery is disabled (local test drive), include the sign-in
    // link in the JSON response so the browser can show it — no logs needed.
    if (!emailEnabled) {
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
                        displayName: profile.displayName,
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
 * /auth/magiclogin. Resolves with { devMagicLink } (non-null only when email
 * delivery is disabled, mirroring the login route). For admin resend.
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

module.exports = router;
module.exports.sendMagicSignInLink = sendMagicSignInLink;
module.exports.clientIp = clientIp;
