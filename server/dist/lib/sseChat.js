/* hamlive-oss — MIT License. See LICENSE.
 *
 * Lightweight SSE broadcaster for chat messages.
 * Separate from realtimeClients (which handles net-state presence pushes).
 * One SSE instance per net — all clients watching that net's chat share it.
 *
 * NOTE: This is a custom implementation replacing express-sse-ts.
 * express-sse-ts calls next() internally which caused issues — it would
 * close the SSE response when a terminating handler was passed as next.
 * Our implementation keeps the response explicitly open.
 */

const { logger } = require('./logger');

class ChatSSEInstance {
    constructor() {
        this.clients = [];
        // Prune stale clients every 60s
        this._pruneTimer = setInterval(() => this._pruneStaleClients(), 60000);
    }

    _pruneStaleClients() {
        const now = Date.now();
        const before = this.clients.length;
        this.clients = this.clients.filter(c => (now - (c.lastWrite || now)) < 120000);
        if (before !== this.clients.length) {
            logger.debug(`SSE: pruned ${before - this.clients.length} stale clients (${this.clients.length} remaining)`);
        }
        // If no clients left, stop pruning
        if (this.clients.length === 0) {
            clearInterval(this._pruneTimer);
            this._pruneTimer = null;
        }
    }

    /**
     * Express middleware: establish SSE connection for this client.
     */
    init(req, res) {
        const headers = {
            'Cache-Control': 'no-cache',
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive'
        };
        res.writeHead(200, headers);

        // Send initial retry directive
        res.write('retry: 5000\n\n');

        const clientId = Date.now() + Math.random();
        this.clients.push({ id: clientId, res, lastWrite: Date.now() });

        logger.debug(`SSE client ${clientId} connected (${this.clients.length} total)`);

        // Clean up on disconnect
        const cleanup = () => {
            this.clients = this.clients.filter(c => c.id !== clientId);
            logger.debug(`SSE client ${clientId} disconnected (${this.clients.length} remaining)`);
        };
        req.on('close', cleanup);
        req.on('error', cleanup);

        // Keep-alive ping every 30s to prevent proxy timeouts
        const keepAlive = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
                // Update lastWrite on successful keep-alive
                const client = this.clients.find(c => c.id === clientId);
                if (client) client.lastWrite = Date.now();
            } catch (e) {
                clearInterval(keepAlive);
                this.clients = this.clients.filter(c => c.id !== clientId);
            }
        }, 30000);

        req.on('close', () => clearInterval(keepAlive));
    }

    /**
     * Send an event to all connected clients.
     * Removes dead clients on write failure.
     */
    send(data, eventName) {
        const payload = JSON.stringify(data);
        this.clients = this.clients.filter(c => {
            try {
                if (eventName) {
                    c.res.write(`event: ${eventName}\n`);
                }
                c.res.write(`data: ${payload}\n\n`);
                c.lastWrite = Date.now();
                return true;
            } catch (e) {
                // Client disconnected — remove from array
                return false;
            }
        });
    }

    get clientCount() {
        return this.clients.length;
    }
}

class ChatSSEBroadcaster {
    constructor() {
        // Map<netProfileId, ChatSSEInstance>
        this.streams = new Map();
    }

    /**
     * Get or create an SSE middleware for a net's chat.
     * Returns a middleware function: (req, res) => void
     */
    middleware(npid) {
        const npidStr = npid.toString();
        return (req, res) => {
            if (!this.streams.has(npidStr)) {
                this.streams.set(npidStr, new ChatSSEInstance());
                logger.debug(`Chat SSE stream created for net ${npidStr}`);
            }
            const instance = this.streams.get(npidStr);
            logger.debug(`Chat SSE: client connecting to net ${npidStr} (${instance.clientCount} existing)`);
            instance.init(req, res);
        };
    }

    /**
     * Broadcast a chat message to all clients watching this net's chat.
     */
    broadcast(npid, data) {
        const npidStr = npid.toString();
        const instance = this.streams.get(npidStr);
        if (!instance) {
            logger.warn(`Chat SSE broadcast: no stream for net ${npidStr}`);
            return;
        }
        logger.debug(`Chat SSE broadcast: ${instance.clientCount} clients for net ${npidStr}`);
        instance.send(data, 'chat-message');
    }

    /**
     * Broadcast a custom event to all clients watching this net's chat.
     * Useful for typing indicators, ban/unban notifications, etc.
     * The eventName determines which 'event:' line the SSE client receives.
     */
    broadcastCustom(npid, data, eventName) {
        const npidStr = npid.toString();
        const instance = this.streams.get(npidStr);
        if (!instance) {
            logger.warn(`Chat SSE broadcastCustom: no stream for net ${npidStr}`);
            return;
        }
        logger.debug(`Chat SSE broadcastCustom: ${instance.clientCount} clients for net ${npidStr}, event=${eventName}`);
        instance.send(data, eventName);
    }

    /**
     * Broadcast a message update (edit).
     */
    broadcastUpdate(npid, data) {
        const instance = this.streams.get(npid.toString());
        if (!instance) return;
        instance.send(data, 'chat-update');
    }

    /**
     * Broadcast a reaction change.
     */
    broadcastReaction(npid, data) {
        const instance = this.streams.get(npid.toString());
        if (!instance) return;
        instance.send(data, 'chat-reaction');
    }

    /**
     * Broadcast a message deletion event.
     */
    broadcastDelete(npid, messageId) {
        const instance = this.streams.get(npid.toString());
        if (!instance) return;
        instance.send({ messageId }, 'chat-delete');
    }

    /**
     * Close the SSE stream for a net when the net closes.
     */
    close(npid) {
        const npidStr = npid.toString();
        const instance = this.streams.get(npidStr);
        if (instance) {
            try {
                instance.send('Chat closed', 'chat-close');
            } catch (e) {
                // Client may already be gone
            }
            // Clean up all client connections
            instance.clients.forEach(c => {
                try { c.res.end(); } catch (_) {}
            });
            this.streams.delete(npidStr);
            logger.debug(`Chat SSE stream closed for net ${npidStr}`);
        }
    }
}

// Singleton
const chatBroadcaster = new ChatSSEBroadcaster();

module.exports = { chatBroadcaster, ChatSSEBroadcaster, ChatSSEInstance };