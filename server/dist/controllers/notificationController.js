/* hamlive-oss — MIT License. See LICENSE. */

const { logger } = require('../lib/logger');
const { handleRequest, prepareEndPointResponse } = require('../lib/responseUtils');
const { isSystemNotificationResponse } = require('../types/commonTypesupport');
const helpers = require('../lib/controllers/notificationHelpers');

// Handles the REST endpoint for fetching pending notifications
const getPendingNotifications = (req, res) => {
    handleRequest(res, async () => {
        // Fetch pending notifications for the authenticated user
        const notifications = await helpers.fetchPendingNotifications(req.user);

        // Transform to client format
        const transformedNotifications = helpers.transformNotifications(notifications);

        logger.info(`User ${req.user._id} fetched ${transformedNotifications.length} pending notification(s)`);

        // Prepare response using standard format
        const response = prepareEndPointResponse(
            {
                message: {
                    notifications: transformedNotifications,
                    count: transformedNotifications.length
                }
            },
            undefined,
            undefined,
            res.locals.flexOpts.baseTtlMs
        );

        // Validate response format
        if (!isSystemNotificationResponse(response)) {
            throw new Error('NOTIFICATION_Controller: Notification response is invalid');
        }

        return response;
    });
};

// Handles the REST endpoint for dismissing a notification
const dismissNotification = (req, res) => {
    handleRequest(res, async () => {
        const { notificationId } = req.params;

        // Validate notification ID format
        if (!helpers.isValidNotificationId(notificationId)) {
            throw new Error('Invalid notificationId format');
        }

        // Dismiss the notification for this user
        await helpers.dismissNotificationForUser(req.user, notificationId);

        logger.info(`User ${req.user._id} dismissed notification ${notificationId}`);

        return {
            message: {
                success: true,
                notificationId
            }
        };
    });
};

module.exports = {
    getPendingNotifications,
    dismissNotification
};
