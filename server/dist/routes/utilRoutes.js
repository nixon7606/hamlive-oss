/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const { authCheck, REQ_LOGIN, resolveLocation, qrzResolveLocation } = require('../lib/serverUtils');
const userProfileController = require('../controllers/userProfileController');
const notificationController = require('../controllers/notificationController');
const { logger } = require('../lib/logger');

router.get('/undeleteme', authCheck(REQ_LOGIN), userProfileController.userProfileUnDelete);
router.get('/resolvelocation', authCheck(REQ_LOGIN), async (req, res) => {
    try {
        return res.json({ ...{ endpointVersion: '1.0' }, ...(await resolveLocation(({ lat, lon } = req.query))) });
    } catch (err) {
        res.status(500).json({
            errorMessage: err.message
        });
        logger.error(err.stack);
    }
});

// QRZ-based location lookup for account settings
router.get('/qrz-location', authCheck(REQ_LOGIN), async (req, res) => {
    try {
        const { callsign } = req.query;
        if (!callsign) {
            return res.status(400).json({ errorMessage: 'callsign query parameter required' });
        }
        const result = await qrzResolveLocation({ callSign: callsign, user: req.user });
        return res.json({ ...{ endpointVersion: '1.0' }, ...result });
    } catch (err) {
        res.status(500).json({ errorMessage: err.message });
        logger.error(err.stack);
    }
});

// System Notifications API
router.get('/notifications/pending', authCheck(REQ_LOGIN), notificationController.getPendingNotifications);
router.post('/notifications/:notificationId/dismiss', authCheck(REQ_LOGIN), notificationController.dismissNotification);

module.exports = router;
