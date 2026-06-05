/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const { stationEventProcessor } = require('../controllers/interactionController');
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');
router.post('/:id', authCheck(REQ_CALLSIGN), stationEventProcessor);

module.exports = router;
