declare const API = "/api/admin";
declare let usersCache: any[];
declare let netsCache: any[];
declare let currentEmailRecipient: string;
declare let usersPage: number;
declare let usersSearch: string;
declare let usersTotal: number;
declare let usersLimit: number;
declare let auditPage: number;
declare let auditTotal: number;
declare let auditLimit: number;
declare let editUserWasSuper: boolean;
declare function statusMsg(text: string, type?: string): void;
declare function esc(s: string): string;
declare function loadStats(): Promise<void>;
declare function loadUsers(): Promise<void>;
declare function loadNets(): Promise<void>;
declare function loadAudit(): Promise<void>;
declare const EVENT_COLORS: Record<string, string>;
declare function loadEmailActivity(recipient: string): Promise<void>;
declare function recentRangeFromControls(presetDays?: number): {
    from: string;
    to: string;
};
declare let lastRecentRange: {
    from: string;
    to: string;
};
declare function loadRecentEmails(range: {
    from: string;
    to: string;
}): Promise<void>;
declare let currentUserId: string | null;
declare let currentUserEmail: string;
declare function editUser(id: string): Promise<void>;
declare function confirmDelete(id: string, label: string): Promise<void>;
declare function manageSchedule(id: string, title: string): Promise<void>;
declare let currentNetId: string | null;
declare let currentNetTitle: string;
declare function confirmNetDelete(id: string, title: string): void;
//# sourceMappingURL=main.d.ts.map