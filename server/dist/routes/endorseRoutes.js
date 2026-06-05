/* hamlive-oss — MIT License. See LICENSE. */

const router = require('express').Router();
const { getChatToken, deleteMessage } = require('../lib/streamChat');
const { authCheck, REQ_CALLSIGN } = require('../lib/serverUtils');

// GetStream.io chat token endpoint
// WHY authCheck(REQ_CALLSIGN): Matches existing pattern. All endorse routes require
// authenticated user with callsign. See serverUtils.js:536-556 for implementation.
router.get('/chat/:id', authCheck(REQ_CALLSIGN), getChatToken);

// Moderation: DELETE message - removes a chat message (NCS/logger only)
router.delete('/chat/:id/message/:messageId', authCheck(REQ_CALLSIGN), deleteMessage);

// TODO: Mute and ban should be implemented as net admin commands (like /mute, /ban)
// rather than HTTP endpoints. The helper functions exist in streamChat.ts:
// - muteUserHelper({ npid, userIdToMute, mutedByUserId, durationMinutes })
// - banUserHelper({ npid, userIdToBan, bannedByUserId, reason })

module.exports = router;
