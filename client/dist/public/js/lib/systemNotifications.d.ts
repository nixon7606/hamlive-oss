export declare class SystemNotificationManager {
    private static readonly DISMISSED_KEY;
    private apiClient;
    private modalElement;
    constructor();
    checkAndDisplayNotifications(): Promise<void>;
    private displayNotification;
    private createModalHTML;
    private dismissNotification;
    private isAlreadyDismissedLocally;
    private markDismissedLocally;
    private removeModal;
    private getSeverityIcon;
    private getSeverityBadge;
    private escapeHtml;
}
//# sourceMappingURL=systemNotifications.d.ts.map