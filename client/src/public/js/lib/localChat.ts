/* hamlive-oss — MIT License. See LICENSE.
 *
 * Client-side in-house chat transport.
 * Replaces the GetStream.io StreamChat SDK.
 * Uses standard fetch() for CRUD and EventSource for SSE real-time updates.
 */

import { createLogger } from '#@client/lib/logger.js';
import { getNpid } from '#@client/lib/clientUtils.js';

const logger = createLogger('lib/localChat.ts');

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
    banned?: { reason: string; bannedAt: string } | false;
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

/**
 * LocalChatConnection manages the connection to the in-house chat system.
 */
export class LocalChatConnection {
    private npid: any = getNpid();
    private session: LocalChatSession | null = null;
    private eventSource: EventSource | null = null;
    private initialized = false;

    // Event handlers
    private handlers = new Map<string, Set<ChatEventHandler>>();

    constructor() {
    }

    /**
     * Fetch the chat session info.
     */
    async getSession(): Promise<LocalChatSession | null> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/session`);
            const data = await res.json();
            if (data.message && data.message.enabled === false) {
                logger.info('Chat is disabled on this server');
                return null;
            }
            this.session = data.message as LocalChatSession;
            return this.session;
        } catch (err) {
            logger.error('Failed to fetch chat session:', err);
            throw err;
        }
    }

    /**
     * Connect to chat: open SSE stream.
     */
    connect(): void {
        if (this.initialized) return;
        if (!this.session) {
            logger.error('Cannot connect: no session. Call getSession() first.');
            return;
        }

        this.eventSource = new EventSource(`/api/chat/${this.npid}/stream`);

        this.eventSource.addEventListener('chat-message', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as LocalChatMessage;
                this.emit('message.new', data);
            } catch (e) {
                logger.error('Failed to parse chat message:', e);
            }
        });

        this.eventSource.addEventListener('chat-update', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as LocalChatMessage;
                this.emit('message.updated', data);
            } catch (e) {
                logger.error('Failed to parse chat update:', e);
            }
        });

        this.eventSource.addEventListener('chat-reaction', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('reaction', data);
            } catch (e) {
                logger.error('Failed to parse chat reaction:', e);
            }
        });

        this.eventSource.addEventListener('chat-delete', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as { messageId: string };
                this.emit('message.deleted', data);
            } catch (e) {
                logger.error('Failed to parse chat delete:', e);
            }
        });

        // Typing indicator event
        this.eventSource.addEventListener('chat-typing', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as TypingEvent;
                this.emit('typing', data);
            } catch (e) {
                logger.error('Failed to parse typing event:', e);
            }
        });

        // Ban/unban events
        this.eventSource.addEventListener('chat-ban', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as BanEvent;
                this.emit('ban', data);
            } catch (e) {
                logger.error('Failed to parse ban event:', e);
            }
        });

        this.eventSource.addEventListener('chat-close', () => {
            logger.info('Chat SSE stream closed (net closing)');
            this.emit('chat.close', null);
            this.disconnect();
        });

        this.eventSource.onerror = (error) => {
            logger.error('Chat SSE error:', error);
        };

        this.initialized = true;
        logger.info('LocalChat: SSE connection established');
    }

    /**
     * Send a text message, optionally replying to a parent message.
     */
    async sendMessage(text: string, parentMessageId?: string): Promise<LocalChatMessage | null> {
        try {
            const body: Record<string, any> = { text };
            if (parentMessageId) body['parentMessageId'] = parentMessageId;
            const res = await fetch(`/api/chat/${this.npid}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) {
                logger.error('Send message failed:', data);
                return null;
            }
            return data.message as LocalChatMessage;
        } catch (err) {
            logger.error('Failed to send message:', err);
            return null;
        }
    }

    /**
     * Upload an image file via multipart upload, optionally replying to a parent.
     */
    async sendImage(file: File, parentMessageId?: string): Promise<LocalChatMessage | null> {
        try {
            const formData = new FormData();
            formData.append('image', file);
            if (parentMessageId) formData.append('parentMessageId', parentMessageId);
            const res = await fetch(`/api/chat/${this.npid}/upload`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (!res.ok) {
                logger.error('Image upload failed:', data);
                return null;
            }
            return data.message as LocalChatMessage;
        } catch (err) {
            logger.error('Failed to upload image:', err);
            return null;
        }
    }

    /**
     * Send a typing indicator.
     * Clients should debounce: send true when user starts typing, false after 2s of inactivity.
     */
    async sendTyping(isTyping: boolean): Promise<void> {
        try {
            await fetch(`/api/chat/${this.npid}/typing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isTyping })
            });
        } catch (err) {
            // Typing indicators are non-critical — silent fail
            logger.debug('Failed to send typing indicator:', err);
        }
    }

    /**
     * Edit a message.
     */
    async editMessage(messageId: string, newText: string): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newText })
            });
            return res.ok;
        } catch (err) {
            logger.error('Failed to edit message:', err);
            return false;
        }
    }

    /**
     * Toggle a reaction on a message.
     */
    async toggleReaction(messageId: string, reactionType: string): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/react`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reactionType })
            });
            return res.ok;
        } catch (err) {
            logger.error('Failed to toggle reaction:', err);
            return false;
        }
    }

    /**
     * Ban the author of a message from this net's chat (NCS only).
     */
    async banFromMessage(messageId: string, reason: string, expiresAt: string | null): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/ban`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, expiresAt })
            });
            return res.ok;
        } catch (err) {
            logger.error('Failed to ban from message:', err);
            return false;
        }
    }

    /**
     * Fetch messages.
     */
    async getMessages(since?: string, limit = 100): Promise<LocalChatMessage[]> {
        try {
            let url = `/api/chat/${this.npid}/messages?limit=${limit}`;
            if (since) url += `&since=${encodeURIComponent(since)}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                logger.error('Fetch messages failed:', data);
                return [];
            }
            return (data.message?.messages || []) as LocalChatMessage[];
        } catch (err) {
            logger.error('Failed to fetch messages:', err);
            return [];
        }
    }

    /**
     * Fetch older messages for pagination.
     */
    async getOlderMessages(before: string, limit = 100): Promise<LocalChatMessage[]> {
        try {
            const url = `/api/chat/${this.npid}/messages?before=${encodeURIComponent(before)}&limit=${limit}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                logger.error('Fetch older messages failed:', data);
                return [];
            }
            return (data.message?.messages || []) as LocalChatMessage[];
        } catch (err) {
            logger.error('Failed to fetch older messages:', err);
            return [];
        }
    }

    /**
     * Fetch replies (thread) for a parent message.
     */
    async getReplies(parentMessageId: string, limit = 50): Promise<LocalChatMessage[]> {
        try {
            const url = `/api/chat/${this.npid}/messages/${parentMessageId}/replies?limit=${limit}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                logger.error('Fetch replies failed:', data);
                return [];
            }
            return (data.message?.messages || []) as LocalChatMessage[];
        } catch (err) {
            logger.error('Failed to fetch replies:', err);
            return [];
        }
    }

    /**
     * Delete a message (NCS only).
     */
    async deleteMessage(messageId: string): Promise<boolean> {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}`, {
                method: 'DELETE'
            });
            return res.ok;
        } catch (err) {
            logger.error('Failed to delete message:', err);
            return false;
        }
    }

    /**
     * Register an event handler.
     * Events: 'message.new', 'message.updated', 'message.deleted', 'reaction', 'typing', 'ban', 'chat.close'
     */
    on(event: string, handler: ChatEventHandler): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event)!.add(handler);
    }

    off(event: string, handler: ChatEventHandler): void {
        this.handlers.get(event)?.delete(handler);
    }

    private emit(event: string, data: unknown): void {
        this.handlers.get(event)?.forEach(handler => {
            try {
                handler(data);
            } catch (e) {
                logger.error(`Error in ${event} handler:`, e);
            }
        });
    }

    disconnect(): void {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.initialized = false;
        logger.info('LocalChat: Disconnected');
    }

    get isConnected(): boolean {
        return this.initialized;
    }
}