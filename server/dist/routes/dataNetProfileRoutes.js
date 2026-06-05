/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const netProfileController = require('../controllers/netProfileController');
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');

router.post('/addnetowner/:id', authCheck(REQ_CALLSIGN), netProfileController.netProfileAddNetOwner);
router.post('/', authCheck(REQ_CALLSIGN), netProfileController.netProfileCreatePost);
router.get('/', authCheck(REQ_CALLSIGN), netProfileController.netProfileList);
router.patch('/:id', authCheck(REQ_CALLSIGN), netProfileController.netProfileUpdate);
router.get('/:id', authCheck(REQ_CALLSIGN), netProfileController.netProfileDetails);
router.delete('/:id', authCheck(REQ_CALLSIGN), netProfileController.netProfileDelete);

module.exports = router;
