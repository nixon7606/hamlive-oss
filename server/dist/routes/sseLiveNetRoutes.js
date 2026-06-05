/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');
const { genLiveNetDetails } = require('../lib/controllers/liveNetHelpers');
const { realtimeClients } = require('../lib/realtimeClients');
realtimeClients.init(genLiveNetDetails);
router.use('/:id', authCheck(REQ_CALLSIGN));
router.use('/:id', realtimeClients.middleware());

module.exports = router;
