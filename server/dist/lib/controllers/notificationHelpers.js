/* hamlive-oss — MIT License. See LICENSE. */

const { getUserProfile } = require('../../models/userProfile');
const { getSystemNotification } = require('../../models/systemNotification');
const { logger } = require('../logger');

// Helper functions for the notification controller.

/**
 * Fetches pending notifications for a user
 * @param {Object} user - The authenticated user object
 * @returns {Promise<Array>} Array of pending SystemNotification documents
 */
const fetchPendingNotifications = async user => {
    const UserProfile = getUserProfile(null);
    const SystemNotification = getSystemNotification(null);

    // Get user's dismissed notification IDs
    const userDoc = await UserProfile.findById(user._id);
    const dismissedIds = userDoc.dismissedNotifications?.map(d => d.notificationId) || [];

    // Find active notifications not dismissed by this user
    const now = new Date();
    return await SystemNotification.find({
        active: true,
        notificationId: { $nin: dismissedIds },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    }).sort({ createdAt: -1 });
};

/**
 * Dismisses a notification for a specific user
 * @param {Object} user - The authenticated user object
 * @param {string} notificationId - The notification ID to dismiss
 * @returns {Promise<Object>} Updated user profile document
 */
const dismissNotificationForUser = async (user, notificationId) => {
    const UserProfile = getUserProfile(null);

    const result = await UserProfile.findByIdAndUpdate(
        user._id,
        {
            $addToSet: {
                dismissedNotifications: {
                    notificationId,
                    dismissedAt: new Date()
                }
            }
        },
        { new: true }
    );

    if (!result) {
        throw new Error(`User ${user._id} not found`);
    }

    logger.info(`User ${user._id} dismissed notification: ${notificationId}`);
    return result;
};

/**
 * Validates notification ID format
 * @param {string} id - The notification ID to validate
 * @returns {boolean} True if valid, false otherwise
 */
const isValidNotificationId = id => {
    return typeof id === 'string' && id.length > 0 && id.length <= 100;
};

/**
 * Transforms notification documents to client format
 * @param {Array} notifications - Array of SystemNotification documents
 * @returns {Array} Transformed notification objects
 */
const transformNotifications = notifications => {
    return notifications.map(n => {
        const { id, notificationId, title, message, severity, active, expiresAt, createdAt, updatedAt } = n;
        return {
            id,
            notificationId,
            title,
            message,
            severity,
            active,
            expiresAt,
            createdAt,
            updatedAt
        };
    });
};

module.exports = {
    fetchPendingNotifications,
    dismissNotificationForUser,
    isValidNotificationId,
    transformNotifications
};
