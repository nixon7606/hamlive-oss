/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Super Admin authorization middleware.
 * Only allows users with superUser: true to proceed.
 */

const { logger } = require('../lib/logger');

const superAdminCheck = (req, res, next) => {
    if (!req.user) {
        logger.warn('superAdminCheck: no user (redirect)');
        return res.redirect('/views/login');
    }
    if (!req.user.superUser) {
        logger.warn(`superAdminCheck: ${req.user.callSign || req.user.email} is not super admin`);
        return res.status(403).render('404', { VIEW: '404' });
    }
    next();
};

module.exports = { superAdminCheck };