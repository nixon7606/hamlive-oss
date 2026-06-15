export interface LocalChatMessage {
    id: string;
    netProfile: string;
    callSign: string;
    displayName: string;
    text: string;
    imageUrl: string | null;
    edited: boolean;
    createdAt: string;
    userId: string | null;
    reactions?: Record<string, string[]>;
    parentMessage?: string;
    parentCallSign?: string;
    parentDisplayName?: string;
    parentText?: string;
    replyCount?: number;
}
export interface LocalChatSession {
    enabled: boolean;
    roomId: string;
    userId: string;
    callSign: string;
    displayName: string;
    banned?: {
        reason: string;
        bannedAt: string;
    } | false;
    pinnedMessage?: unknown;
}
export interface TypingEvent {
    type: 'typing';
    callSign: string;
    isTyping: boolean;
}
export interface BanEvent {
    type: 'ban' | 'unban';
    callSign: string;
    reason?: string;
    bannedBy?: string;
    unbannedBy?: string;
}
export type ChatEventHandler = (data: unknown) => void;
export declare class LocalChatConnection {
    private npid;
    private session;
    private eventSource;
    private initialized;
    private handlers;
    constructor();
    getSession(): Promise<LocalChatSession | null>;
    connect(): void;
    sendMessage(text: string, parentMessageId?: string): Promise<LocalChatMessage | null>;
    sendImage(file: File, parentMessageId?: string): Promise<LocalChatMessage | null>;
    sendTyping(isTyping: boolean): Promise<void>;
    editMessage(messageId: string, newText: string): Promise<boolean>;
    toggleReaction(messageId: string, reactionType: string): Promise<boolean>;
    banFromMessage(messageId: string, reason: string, expiresAt: string | null): Promise<boolean>;
    pinMessage(messageId: string): Promise<boolean>;
    unpinMessage(messageId: string): Promise<boolean>;
    getMessages(since?: string, limit?: number): Promise<LocalChatMessage[]>;
    getOlderMessages(before: string, limit?: number): Promise<LocalChatMessage[]>;
    getReplies(parentMessageId: string, limit?: number): Promise<LocalChatMessage[]>;
    deleteMessage(messageId: string): Promise<boolean>;
    on(event: string, handler: ChatEventHandler): void;
    off(event: string, handler: ChatEventHandler): void;
    private emit;
    disconnect(): void;
    get isConnected(): boolean;
}
//# sourceMappingURL=localChat.d.ts.map