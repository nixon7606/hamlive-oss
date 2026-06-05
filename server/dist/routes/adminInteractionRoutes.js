/* hamlive-oss — MIT License. See LICENSE. */
const router = require('express').Router();

const { adminCommandProcessor, adminCommandList } = require('../controllers/interactionController');

const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');

router.get('/:id', authCheck(REQ_CALLSIGN), adminCommandList);
router.post('/:id', authCheck(REQ_CALLSIGN), adminCommandProcessor);

module.exports = router;
