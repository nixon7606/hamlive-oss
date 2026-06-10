declare const API = "/api/admin";
declare function statusMsg(text: string, type?: string): void;
declare function esc(s: string): string;
declare function loadStats(): Promise<void>;
declare function loadUsers(): Promise<void>;
declare function loadNets(): Promise<void>;
declare let currentUserId: string | null;
declare let currentUserEmail: string;
declare function editUser(id: string): Promise<void>;
declare function confirmDelete(id: string, label: string): Promise<void>;
declare function manageSchedule(id: string, title: string): Promise<void>;
declare let currentNetId: string | null;
declare let currentNetTitle: string;
declare function confirmNetDelete(id: string, title: string): void;
//# sourceMappingURL=main.d.ts.map