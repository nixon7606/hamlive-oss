/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const { liveNetList, liveNetCreatePost, liveNetDetails } = require('../controllers/liveNetController');
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');

router.get('/', liveNetList);
router.post('/:id', authCheck(REQ_CALLSIGN), liveNetCreatePost);
router.get('/:id', authCheck(REQ_CALLSIGN), liveNetDetails);

module.exports = router;
