/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const userProfileController = require('../controllers/userProfileController');
const { authCheck, REQ_LOGIN } = require('../lib/serverUtils');

router.get('/', authCheck(REQ_LOGIN), userProfileController.userProfileDetails);
router.patch('/:id', authCheck(REQ_LOGIN), userProfileController.userProfileUpdate);
router.delete('/:id', authCheck(REQ_LOGIN), userProfileController.userProfileDelete);

module.exports = router;
