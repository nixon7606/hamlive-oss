/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Super Admin API routes — user and net management.
 * All routes require superUser authorization.
 */

const router = require('express').Router();
const { authCheck, REQ_LOGIN } = require('../lib/serverUtils');
const { superAdminCheck } = require('../middleware/superAdminCheck');
const { listUsers, updateUser, deleteUser, listNets, getStats, deleteNet, updateNetSchedule, listEmailActivity } = require('../controllers/adminController');

// All admin routes require login + superUser
router.use(authCheck(REQ_LOGIN), superAdminCheck);

router.get('/users', listUsers);
router.patch('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);
router.get('/nets', listNets);
router.patch('/nets/:id', updateNetSchedule);
router.delete('/nets/:id', deleteNet);
router.get('/stats', getStats);
router.get('/email', listEmailActivity);

module.exports = router;
