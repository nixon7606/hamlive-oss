/* hamlive-oss — MIT License. See LICENSE.
 *
 * Endorse routes — now delegates to in-house chat system.
 * Previously served GetStream.io chat tokens; those are replaced by
 * the /api/chat routes (chatRoutes.js). These endpoints remain
 * for backward-compatible message deletion.
 */

const router = require('express').Router();
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');
const { handleRequest } = require('../lib/responseUtils');
const { deleteMessage, getChatSession } = require('../lib/localChat');
const { logger } = require('../lib/logger');

// GET /chat/:id — Get chat session info (replaces GetStream token endpoint)
router.get('/chat/:id', authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const session = await getChatSession({ npid, user: req.user });
        logger.info(`Chat session requested for net ${npid} by ${req.user.callSign}`);
        return { message: session };
    }, `chatSession(): ${req.user?.callSign} net ${req.params.id}`);
});

// DELETE /chat/:id/message/:messageId — Remove a chat message (NCS only)
router.delete('/chat/:id/message/:messageId', authCheck(REQ_CALLSIGN), (req, res) => {
    handleRequest(res, async () => {
        const npid = req.params.id;
        const { messageId } = req.params;
        if (!req.user || !req.user._id) throw new Error('Missing user object');
        const result = await deleteMessage({
            npid,
            messageId,
            moderatorCallsign: req.user.callSign || 'unknown',
            userProfileId: req.user._id.toString()
        });
        return { message: result };
    }, `deleteMessage(endorse): ${req.user?.callSign} deleted ${req.params.messageId}`);
});

module.exports = router;
