import { createLogger } from '#@client/lib/logger.js';
import { getNpid } from '#@client/lib/clientUtils.js';
const logger = createLogger('lib/localChat.ts');
export class LocalChatConnection {
    npid = getNpid();
    session = null;
    eventSource = null;
    initialized = false;
    handlers = new Map();
    constructor() {
    }
    async getSession() {
        try {
            const res = await fetch(`/api/chat/${this.npid}/session`);
            const data = await res.json();
            if (data.message && data.message.enabled === false) {
                logger.info('Chat is disabled on this server');
                return null;
            }
            this.session = data.message;
            return this.session;
        }
        catch (err) {
            logger.error('Failed to fetch chat session:', err);
            throw err;
        }
    }
    connect() {
        if (this.initialized)
            return;
        if (!this.session) {
            logger.error('Cannot connect: no session. Call getSession() first.');
            return;
        }
        this.eventSource = new EventSource(`/api/chat/${this.npid}/stream`);
        this.eventSource.addEventListener('chat-message', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('message.new', data);
            }
            catch (e) {
                logger.error('Failed to parse chat message:', e);
            }
        });
        this.eventSource.addEventListener('chat-update', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('message.updated', data);
            }
            catch (e) {
                logger.error('Failed to parse chat update:', e);
            }
        });
        this.eventSource.addEventListener('chat-reaction', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('reaction', data);
            }
            catch (e) {
                logger.error('Failed to parse chat reaction:', e);
            }
        });
        this.eventSource.addEventListener('chat-delete', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('message.deleted', data);
            }
            catch (e) {
                logger.error('Failed to parse chat delete:', e);
            }
        });
        this.eventSource.addEventListener('chat-typing', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('typing', data);
            }
            catch (e) {
                logger.error('Failed to parse typing event:', e);
            }
        });
        this.eventSource.addEventListener('chat-ban', (event) => {
            try {
                const data = JSON.parse(event.data);
                this.emit('ban', data);
            }
            catch (e) {
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
    async sendMessage(text, parentMessageId) {
        try {
            const body = { text };
            if (parentMessageId)
                body['parentMessageId'] = parentMessageId;
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
            return data.message;
        }
        catch (err) {
            logger.error('Failed to send message:', err);
            return null;
        }
    }
    async sendImage(file, parentMessageId) {
        try {
            const formData = new FormData();
            formData.append('image', file);
            if (parentMessageId)
                formData.append('parentMessageId', parentMessageId);
            const res = await fetch(`/api/chat/${this.npid}/upload`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (!res.ok) {
                logger.error('Image upload failed:', data);
                return null;
            }
            return data.message;
        }
        catch (err) {
            logger.error('Failed to upload image:', err);
            return null;
        }
    }
    async sendTyping(isTyping) {
        try {
            await fetch(`/api/chat/${this.npid}/typing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isTyping })
            });
        }
        catch (err) {
            logger.debug('Failed to send typing indicator:', err);
        }
    }
    async editMessage(messageId, newText) {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newText })
            });
            return res.ok;
        }
        catch (err) {
            logger.error('Failed to edit message:', err);
            return false;
        }
    }
    async toggleReaction(messageId, reactionType) {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/react`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reactionType })
            });
            return res.ok;
        }
        catch (err) {
            logger.error('Failed to toggle reaction:', err);
            return false;
        }
    }
    async banFromMessage(messageId, reason, expiresAt) {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}/ban`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason, expiresAt })
            });
            return res.ok;
        }
        catch (err) {
            logger.error('Failed to ban from message:', err);
            return false;
        }
    }
    async getMessages(since, limit = 100) {
        try {
            let url = `/api/chat/${this.npid}/messages?limit=${limit}`;
            if (since)
                url += `&since=${encodeURIComponent(since)}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                logger.error('Fetch messages failed:', data);
                return [];
            }
            return (data.message?.messages || []);
        }
        catch (err) {
            logger.error('Failed to fetch messages:', err);
            return [];
        }
    }
    async getOlderMessages(before, limit = 100) {
        try {
            const url = `/api/chat/${this.npid}/messages?before=${encodeURIComponent(before)}&limit=${limit}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                logger.error('Fetch older messages failed:', data);
                return [];
            }
            return (data.message?.messages || []);
        }
        catch (err) {
            logger.error('Failed to fetch older messages:', err);
            return [];
        }
    }
    async getReplies(parentMessageId, limit = 50) {
        try {
            const url = `/api/chat/${this.npid}/messages/${parentMessageId}/replies?limit=${limit}`;
            const res = await fetch(url);
            const data = await res.json();
            if (!res.ok) {
                logger.error('Fetch replies failed:', data);
                return [];
            }
            return (data.message?.messages || []);
        }
        catch (err) {
            logger.error('Failed to fetch replies:', err);
            return [];
        }
    }
    async deleteMessage(messageId) {
        try {
            const res = await fetch(`/api/chat/${this.npid}/message/${messageId}`, {
                method: 'DELETE'
            });
            return res.ok;
        }
        catch (err) {
            logger.error('Failed to delete message:', err);
            return false;
        }
    }
    on(event, handler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, new Set());
        }
        this.handlers.get(event).add(handler);
    }
    off(event, handler) {
        this.handlers.get(event)?.delete(handler);
    }
    emit(event, data) {
        this.handlers.get(event)?.forEach(handler => {
            try {
                handler(data);
            }
            catch (e) {
                logger.error(`Error in ${event} handler:`, e);
            }
        });
    }
    disconnect() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        this.initialized = false;
        logger.info('LocalChat: Disconnected');
    }
    get isConnected() {
        return this.initialized;
    }
}
//# sourceMappingURL=localChat.js.map