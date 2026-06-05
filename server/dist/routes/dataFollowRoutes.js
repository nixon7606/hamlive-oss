/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const followController = require('../controllers/followController');
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');

router.post('/:id', authCheck(REQ_CALLSIGN), followController.followCreatePost);
router.get('/', authCheck(REQ_CALLSIGN), followController.followList);
router.get('/:id', authCheck(REQ_CALLSIGN), followController.followDetails);
router.delete('/:id', authCheck(REQ_CALLSIGN), followController.followDelete);

module.exports = router;
