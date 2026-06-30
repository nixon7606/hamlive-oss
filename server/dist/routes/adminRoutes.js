/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Super Admin API routes — user and net management.
 * All routes require superUser authorization.
 */

const router = require('express').Router();
const { authCheck, REQ_LOGIN } = require('../lib/serverUtils');
const { superAdminCheck } = require('../middleware/superAdminCheck');
const { listUsers, updateUser, deleteUser, listNets, getStats, deleteNet, updateNetSchedule, listEmailActivity, resendSignInLink, generateSignInLink, unsuppressEmail, recentEmails, listAudit } = require('../controllers/adminController');
const { getSettings, putSettings, sendTest, listTemplates, getTemplate, putTemplate, previewTemplate, resetTemplate } = require('../controllers/emailAdminController');

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
router.get('/email/recent', recentEmails);
router.post('/email/resend-login', resendSignInLink);
router.post('/email/generate-login', generateSignInLink);
router.post('/email/unsuppress', unsuppressEmail);
router.get('/audit', listAudit);
router.get('/email/settings', getSettings);
router.put('/email/settings', putSettings);
router.post('/email/test', sendTest);
router.get('/email/templates', listTemplates);
router.get('/email/templates/:key', getTemplate);
router.put('/email/templates/:key', putTemplate);
router.post('/email/templates/:key/preview', previewTemplate);
router.post('/email/templates/:key/reset', resetTemplate);

module.exports = router;
