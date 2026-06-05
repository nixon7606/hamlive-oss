/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Chat Widget - GetStream.io integration
 *
 * WHY not extend HamLiveElement: Chat has a unique initialization flow that requires
 * `level` from Presence (passed via init()) and manages its own Stream Chat connection.
 * However, we adopt key patterns from HamLiveElement:
 * - StoreSubscriber interface for reactive updates
 * - didMyDataSegmentChange() for efficient re-renders
 * - UserAgentPersistentPreferences for UI state persistence
 * - Light DOM (EncapsulationMode.Open pattern) for Bootstrap compatibility
 *
 * WHY stream-chat works: Resolved via importmap in head.ejs -> esm.sh CDN
 */

import { StreamChat, Channel, MessageResponse } from 'stream-chat';
import { LiveNetReactiveStore, StoreSubscriber, NewDataReturnType } from '#@client/lib/stores.js';
import { createLogger } from '#@client/lib/logger.js';
import { serverInfo } from '#@client/lib/serverInfo.js';
import { getNpid, generateUUID, UserAgentPersistentPreferences } from '#@client/lib/clientUtils.js';

const logger = createLogger('lib/chat.ts');
const prefs = new UserAgentPersistentPreferences();

// ============================================================================
// Types
// ============================================================================

interface ChatTokenResponse {
    token: string;
    userId: string;
    channelId: string;
    channelType: string;
    apiKey: string;
}

const isChatTokenResponse = (obj: unknown): obj is ChatTokenResponse => {
    if (typeof obj !== 'object' || obj === null) return false;
    const response = obj as ChatTokenResponse;
    return (
        typeof response.token === 'string' &&
        typeof response.userId === 'string' &&
        typeof response.channelId === 'string' &&
        typeof response.channelType === 'string' &&
        typeof response.apiKey === 'string'
    );
};

interface ChatUser {
    id: string;
    name?: string;
    callSign?: string;
    image?: string;
}

interface ChatAttachment {
    type?: string;
    image_url?: string;
    thumb_url?: string;
    asset_url?: string;
}

interface ChatReaction {
    type: string;
    user_id?: string;
    user?: ChatUser;
}

const REACTIONS = [
    { type: 'like', emoji: '👍' },
    { type: 'love', emoji: '❤️' },
    { type: 'haha', emoji: '😂' },
    { type: 'wow', emoji: '😮' }
] as const;

// ============================================================================
// ChatWidget - HamLiveElement implementation
// ============================================================================

/**
 * Chat widget following HamLiveElement patterns for reactive store integration.
 *
 * This is a "heavy" widget that manages its own Stream Chat connection.
 * Uses light DOM (like EncapsulationMode.Open) for Bootstrap compatibility.
 *
 * Patterns adopted from HamLiveElement/LiveNetElement:
 * - StoreSubscriber interface (uuid, newData, online)
 * - didMyDataSegmentChange() for efficient re-renders
 * - UserAgentPersistentPreferences for UI state persistence
 */
export class ChatWidget extends HTMLElement implements StoreSubscriber {
    // StoreSubscriber interface
    public readonly uuid = generateUUID();
    private _online = true;

    // Widget state
    private store: LiveNetReactiveStore | null = null;
    private client: StreamChat | null = null;
    private channel: Channel | null = null;
    private npid = getNpid();
    private level: number | undefined;
    private initialized = false;
    private currentUserId: string | null = null;
    private lastKnownLevel: number | undefined;

    // Event handlers stored for cleanup
    private documentClickHandler: ((e: MouseEvent) => void) | null = null;
    private beforeUnloadHandler: (() => void) | null = null;

    // ========================================================================
    // Lifecycle
    // ========================================================================

    connectedCallback(): void {
        if (!serverInfo.chat) {
            logger.info('Chat is disabled via serverInfo');
            this.innerHTML = '';
            return;
        }

        // WHY these styles: For auto-scroll to work, the chat container must have a fixed
        // height with overflow scroll, not expand infinitely. Flex children have implicit
        // min-height: auto which prevents shrinking. Setting min-height: 0 on every flex
        // child in the hierarchy allows the container to constrain its height and scroll.
        // See docs/chat-system.md "Auto-scroll behavior" for the full hierarchy.
        this.style.display = 'block';
        this.style.height = '100%';
        this.style.minHeight = '0';

        // Render placeholder while initializing
        this.innerHTML = this.getTemplate();
    }

    disconnectedCallback(): void {
        this.disconnect();
    }

    /**
     * Initialize chat with the given store and initial user level
     *
     * WHY level parameter: Comes from Presence (already resolved), avoiding the need
     * to wait for LiveNetReactiveStore. Server handles all user profile data
     * (name, callSign, image) via upsertStreamUser in getChatToken.
     *
     * WHY store parameter: For subscribing to role changes during the session.
     */
    public async init(store: LiveNetReactiveStore, level: number): Promise<void> {
        if (this.initialized) return;

        this.store = store;
        this.level = level;
        this.lastKnownLevel = level;

        try {
            logger.info(`Chat initializing with level ${level} from presence`);

            // Fetch initial token to get apiKey, userId, channelId
            const chatConfig = await this.fetchToken();
            if (!chatConfig) {
                logger.info('Chat is disabled on this server (GetStream not configured) — skipping chat.');
                return;
            }
            this.client = StreamChat.getInstance(chatConfig.apiKey);
            this.currentUserId = chatConfig.userId;

            // WHY tokenProvider: Tokens expire (3 hours). The SDK automatically calls this
            // function when a token expires, ensuring chat continues working during long nets.
            // See docs/chat-system.md for details.
            const tokenProvider = async (): Promise<string> => {
                logger.info('Token provider: fetching fresh token');
                const freshConfig = await this.fetchToken();
                if (!freshConfig) throw new Error('Chat token unavailable');
                return freshConfig.token;
            };

            // Server already set user data (name, callSign, image) via upsertStreamUser in getChatToken
            await this.client.connectUser({ id: chatConfig.userId }, tokenProvider);

            this.channel = this.client.channel(chatConfig.channelType, chatConfig.channelId);
            await this.channel.watch();
            logger.info(`Watching channel ${chatConfig.channelId}`);

            // Subscribe to store for role changes (level may change during session)
            this.store.subscribe(this);
            this.setupChannelListeners();

            this.initialized = true;
            this.render();
            this.loadMessages();

            // Show slash command tip if user is NCS/logger
            if (level <= 1) {
                this.showCommandTip();
            }
        } catch (error) {
            logger.error('Failed to initialize chat:', error);
            this.renderError(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    // ========================================================================
    // StoreSubscriber interface (following HamLiveElement pattern)
    // ========================================================================

    /**
     * Called by store when new data arrives.
     * Follows HamLiveElement pattern: check didMyDataSegmentChange() before re-rendering.
     */
    // eslint-disable-next-line @typescript-eslint/require-await
    public async newData(): NewDataReturnType {
        if (!this.didMyDataSegmentChange()) return;

        const currentLevel = this.store?.stations.mine?.level;
        if (currentLevel === undefined) return;

        logger.info(`Role level changed from ${this.lastKnownLevel} to ${currentLevel}`);
        const wasPromoted = this.lastKnownLevel !== undefined && currentLevel < this.lastKnownLevel;

        this.lastKnownLevel = currentLevel;
        this.level = currentLevel;

        this.updateModerationButtons();

        // Show slash command tip when promoted to NCS/logger
        if (wasPromoted && currentLevel <= 1) {
            this.showCommandTip();
        }
    }

    /**
     * Check if the data segment we care about has changed.
     * Follows HamLiveElement/LiveNetElement pattern for efficient re-renders.
     */
    private didMyDataSegmentChange(): boolean {
        const currentLevel = this.store?.stations.mine?.level;
        return currentLevel !== undefined && currentLevel !== this.lastKnownLevel;
    }

    public get online(): boolean {
        return this._online;
    }

    public set online(value: boolean) {
        this._online = value;
        if (!value) {
            this.classList.add('offline');
        } else {
            this.classList.remove('offline');
        }
    }

    // ========================================================================
    // Template & Rendering
    // ========================================================================

    private getTemplate(): string {
        // WHY min-height: 0 on .chat-widget and .chat-messages: See connectedCallback() comment
        // and docs/chat-system.md "Auto-scroll behavior" for explanation.
        return /*html*/ `
            <div class="chat-widget h-100 d-flex flex-column" style="min-height: 0;">
                <style>
                    .chat-messages { 
                        scrollbar-width: thin; 
                        scrollbar-color: var(--hl-quaternary) var(--hl-dark);
                        min-height: 0;
                    }
                    .chat-messages::-webkit-scrollbar { width: 8px; }
                    .chat-messages::-webkit-scrollbar-track { background: var(--hl-dark); }
                    .chat-messages::-webkit-scrollbar-thumb { background: var(--hl-quaternary); border-radius: 4px; }
                    .chat-message { 
                        padding: 6px 8px;
                        border-bottom: 1px solid rgba(240, 238, 222, 0.15);
                        position: relative;
                    }
                    .chat-message:last-child { border-bottom: none; }
                    .chat-username { color: var(--hl-light); font-weight: 600; opacity: 0.85; }
                    .chat-callsign { color: #9a9a9a; }
                    .chat-timestamp { color: var(--hl-tertiary); font-size: 11px; }
                    .chat-edited { color: var(--hl-tertiary); font-size: 10px; font-style: italic; }
                    .chat-edit-input {
                        width: 100%;
                        background: var(--hl-quaternary);
                        border: 1px solid var(--hl-tertiary);
                        border-radius: 4px;
                        color: var(--hl-light);
                        padding: 4px 8px;
                        margin-top: 4px;
                    }
                    .chat-edit-actions { display: flex; gap: 8px; margin-top: 4px; }
                    .chat-edit-actions button {
                        background: var(--hl-quaternary);
                        border: 1px solid var(--hl-tertiary);
                        border-radius: 4px;
                        color: var(--hl-light);
                        padding: 2px 8px;
                        font-size: 12px;
                        cursor: pointer;
                    }
                    .chat-edit-actions button:hover { background: var(--hl-tertiary); }
                    .chat-text { color: var(--hl-light); }
                    .chat-input-wrapper {
                        display: flex;
                        align-items: center;
                        background: var(--hl-dark);
                        border: 1px solid var(--hl-quaternary);
                        border-radius: 4px;
                        padding: 4px;
                        margin-top: 8px;
                    }
                    .chat-input-wrapper:focus-within { border-color: var(--hl-tertiary); }
                    .chat-text-input {
                        flex: 1;
                        background: transparent;
                        border: none;
                        color: var(--hl-light);
                        padding: 4px 8px;
                        outline: none;
                    }
                    .chat-text-input::placeholder { color: var(--hl-tertiary); opacity: 0.6; }
                    .chat-icon-btn {
                        background: transparent;
                        border: none;
                        color: var(--hl-tertiary);
                        padding: 4px 8px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                    }
                    .chat-icon-btn:hover { color: var(--hl-light); }
                    .chat-message-actions {
                        display: none;
                        position: absolute;
                        right: 4px;
                        top: 2px;
                        background: var(--hl-dark);
                        border: 1px solid var(--hl-quaternary);
                        border-radius: 4px;
                        padding: 2px;
                    }
                    .chat-message:hover .chat-message-actions { display: flex; gap: 2px; }
                    .chat-action-btn {
                        background: transparent;
                        border: none;
                        color: var(--hl-tertiary);
                        padding: 2px 6px;
                        cursor: pointer;
                        font-size: 14px;
                        border-radius: 3px;
                    }
                    .chat-action-btn:hover { background: var(--hl-quaternary); color: var(--hl-light); }
                    .chat-reactions {
                        display: flex;
                        gap: 4px;
                        margin-top: 4px;
                        flex-wrap: wrap;
                    }
                    .chat-reaction {
                        display: inline-flex;
                        align-items: center;
                        gap: 2px;
                        background: var(--hl-quaternary);
                        border-radius: 10px;
                        padding: 1px 6px;
                        font-size: 12px;
                        cursor: pointer;
                    }
                    .chat-reaction:hover { background: var(--hl-tertiary); }
                    .chat-reaction.mine { border: 1px solid var(--hl-secondary); }
                    .chat-reaction-count { color: var(--hl-light); font-size: 11px; }
                    .chat-reaction-picker {
                        display: none;
                        position: absolute;
                        background: var(--hl-dark);
                        border: 1px solid var(--hl-quaternary);
                        border-radius: 4px;
                        padding: 4px;
                        z-index: 10;
                    }
                    .chat-reaction-picker.show { display: flex; gap: 4px; }
                    .chat-reaction-picker button {
                        background: transparent;
                        border: none;
                        font-size: 18px;
                        cursor: pointer;
                        padding: 4px;
                        border-radius: 4px;
                    }
                    .chat-reaction-picker button:hover { background: var(--hl-quaternary); }
                    .chat-mod-btn { color: var(--hl-tertiary); }
                    .chat-mod-btn:hover { color: #dc3545; }
                    .chat-emoji-wrapper { position: relative; }
                    .chat-emoji-picker {
                        display: none;
                        position: absolute;
                        bottom: 100%;
                        right: 0;
                        margin-bottom: 8px;
                        z-index: 100;
                    }
                    .chat-emoji-picker.show { display: block; }
                </style>
                <div class="chat-messages flex-grow-1 overflow-auto px-1 py-1">
                    <div class="text-center text-muted p-4">
                        <p>Connecting to chat...</p>
                    </div>
                </div>
                <div class="chat-input-wrapper">
                    <input type="text" class="chat-text-input" placeholder="Message..." maxlength="500">
                    <div class="chat-emoji-wrapper">
                        <button class="chat-emoji-btn chat-icon-btn" type="button" title="Emoji">
                            <i class="bi bi-emoji-smile"></i>
                        </button>
                        <div class="chat-emoji-picker">
                            <emoji-picker></emoji-picker>
                        </div>
                    </div>
                    <label class="chat-icon-btn" title="Share image">
                        <i class="bi bi-image"></i>
                        <input type="file" class="chat-file-input" accept="image/*" style="display: none;">
                    </label>
                    <button class="chat-send-btn chat-icon-btn" type="button" title="Send">
                        <i class="bi bi-send"></i>
                    </button>
                </div>
            </div>
        `;
    }

    private render(): void {
        this.setupInputListeners();
    }

    private renderError(message: string): void {
        const messagesContainer = this.querySelector('.chat-messages');
        if (messagesContainer) {
            messagesContainer.innerHTML = `
                <div class="text-center text-muted p-4">
                    <p>Chat unavailable</p>
                    <small>${this.escapeHtml(message)}</small>
                </div>
            `;
        }
    }

    // ========================================================================
    // Messages
    // ========================================================================

    private loadMessages(): void {
        if (!this.channel) return;

        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer) return;

        const messages = this.channel.state.messages;
        if (messages.length === 0) {
            messagesContainer.innerHTML = `
                <div class="text-center text-muted p-4">
                    <p>No messages yet. Say hello!</p>
                </div>
            `;
            return;
        }

        messagesContainer.innerHTML = '';
        messages.forEach(msg => this.renderMessage(msg as unknown as MessageResponse));
        this.scrollToBottom();
    }

    private renderMessage(msg: MessageResponse): void {
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer || !this.client) return;

        const user = msg.user as ChatUser | undefined;
        // Server sets name as "FirstName(CALLSIGN)" or just "CALLSIGN" if no display name
        const rawName = user?.name || user?.callSign || 'Unknown';
        const usernameHtml = this.formatUsername(rawName);
        const timestamp = new Date(msg.created_at || '').toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Check if message was edited (message_text_updated_at is set and different from created_at)
        const isEdited = msg.message_text_updated_at && msg.message_text_updated_at !== msg.created_at;
        const editedIndicator = isEdited ? '<span class="chat-edited">(edited)</span>' : '';

        // Only show edit button for own messages
        const isOwnMessage = user?.id === this.currentUserId;
        const editBtn = isOwnMessage
            ? `<button class="chat-action-btn chat-edit-btn" title="Edit message"><i class="bi bi-pencil"></i></button>`
            : '';

        const msgEl = document.createElement('div');
        msgEl.className = 'chat-message';
        msgEl.dataset['messageId'] = msg.id;

        let messageContent = '';
        if (msg.text) {
            messageContent += `<span class="chat-text">${this.linkifyText(this.escapeHtml(msg.text))}</span>`;
        }

        if (msg.attachments && msg.attachments.length > 0) {
            msg.attachments.forEach((att: ChatAttachment) => {
                if (att.type === 'image') {
                    const imageUrl = att.image_url || att.thumb_url || '';
                    const fullUrl = att.asset_url || att.image_url || '';
                    messageContent += `
                        <div class="mt-1">
                            <img src="${this.escapeHtml(imageUrl)}" 
                                 alt="Shared image" 
                                 class="img-fluid rounded" 
                                 style="max-height: 200px; cursor: pointer; border: 1px solid var(--hl-quaternary);"
                                 onclick="window.open('${this.escapeHtml(fullUrl)}', '_blank')">
                        </div>
                    `;
                }
            });
        }

        const reactionsHtml = this.renderReactions(msg);
        const moderateBtn = this.canModerate()
            ? `<button class="chat-action-btn chat-mod-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
            : '';

        msgEl.innerHTML = `
            <div class="chat-message-actions">
                ${editBtn}
                <button class="chat-action-btn chat-react-btn" title="React"><i class="bi bi-emoji-smile"></i></button>
                ${moderateBtn}
            </div>
            <div class="chat-reaction-picker">
                ${REACTIONS.map(r => `<button data-reaction="${r.type}">${r.emoji}</button>`).join('')}
            </div>
            <span class="chat-username">${usernameHtml}</span>
            <span class="chat-timestamp ms-2">${timestamp}</span>
            ${editedIndicator}
            <div class="chat-message-content">${messageContent}</div>
            <div class="chat-reactions">${reactionsHtml}</div>
        `;

        this.setupMessageActions(msgEl, msg.id, msg.text || '');

        const placeholder = messagesContainer.querySelector('.text-muted');
        if (placeholder) placeholder.remove();

        messagesContainer.appendChild(msgEl);
    }

    private renderReactions(msg: MessageResponse): string {
        const reactionCounts = msg.reaction_counts || {};
        const ownReactions = (msg.own_reactions || []) as ChatReaction[];
        const ownReactionTypes = new Set(ownReactions.map(r => r.type));

        return REACTIONS.filter(r => reactionCounts[r.type])
            .map(r => {
                const count = reactionCounts[r.type] || 0;
                const isMine = ownReactionTypes.has(r.type);
                return `<span class="chat-reaction${isMine ? ' mine' : ''}" data-reaction="${r.type}">
                    ${r.emoji}<span class="chat-reaction-count">${count}</span>
                </span>`;
            })
            .join('');
    }

    // ========================================================================
    // Event Listeners
    // ========================================================================

    private setupChannelListeners(): void {
        if (!this.channel) return;

        this.channel.on('message.new', this.handleNewMessage.bind(this));
        this.channel.on('message.deleted', this.handleDeletedMessage.bind(this));
        this.channel.on('message.updated', this.handleUpdatedMessage.bind(this));
        this.channel.on('reaction.new', this.handleReactionUpdate.bind(this));
        this.channel.on('reaction.deleted', this.handleReactionUpdate.bind(this));
    }

    private setupInputListeners(): void {
        const sendBtn = this.querySelector('.chat-send-btn');
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        const fileInput = this.querySelector<HTMLInputElement>('.chat-file-input');
        const emojiBtn = this.querySelector('.chat-emoji-btn');
        const emojiPickerWrapper = this.querySelector('.chat-emoji-picker');
        const emojiPicker = this.querySelector('emoji-picker');

        sendBtn?.addEventListener('click', () => void this.sendMessage());
        textInput?.addEventListener('keypress', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void this.sendMessage();
            }
        });
        fileInput?.addEventListener('change', e => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) {
                void this.sendImage(file);
                (e.target as HTMLInputElement).value = '';
            }
        });

        // Emoji picker toggle
        emojiBtn?.addEventListener('click', e => {
            e.stopPropagation();
            emojiPickerWrapper?.classList.toggle('show');
        });

        // Emoji selection
        emojiPicker?.addEventListener('emoji-click', (e: Event) => {
            const detail = (e as CustomEvent<{ unicode?: string }>).detail;
            if (textInput && detail?.unicode) {
                const start = textInput.selectionStart ?? textInput.value.length;
                const end = textInput.selectionEnd ?? textInput.value.length;
                const unicode: string = detail.unicode;
                textInput.value = textInput.value.slice(0, start) + unicode + textInput.value.slice(end);
                textInput.selectionStart = textInput.selectionEnd = start + unicode.length;
                textInput.focus();
            }
            emojiPickerWrapper?.classList.remove('show');
        });

        // Close emoji picker when clicking outside
        // Store handler for cleanup in disconnect()
        this.documentClickHandler = (e: MouseEvent) => {
            if (!emojiPickerWrapper?.contains(e.target as Node) && !emojiBtn?.contains(e.target as Node)) {
                emojiPickerWrapper?.classList.remove('show');
            }
        };
        document.addEventListener('click', this.documentClickHandler);

        // Store handler for cleanup in disconnect()
        this.beforeUnloadHandler = () => this.disconnect();
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    private setupMessageActions(msgEl: HTMLElement, messageId: string, originalText: string): void {
        const reactBtn = msgEl.querySelector('.chat-react-btn');
        const picker = msgEl.querySelector('.chat-reaction-picker');
        const deleteBtn = msgEl.querySelector('.chat-delete-btn');
        const editBtn = msgEl.querySelector('.chat-edit-btn');
        const reactions = msgEl.querySelectorAll('.chat-reaction');

        reactBtn?.addEventListener('click', e => {
            e.stopPropagation();
            picker?.classList.toggle('show');
        });

        picker?.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const reactionType = (e.currentTarget as HTMLElement).dataset['reaction'];
                if (reactionType) {
                    void this.toggleReaction(messageId, reactionType);
                }
                picker.classList.remove('show');
            });
        });

        reactions.forEach(reaction => {
            reaction.addEventListener('click', () => {
                const reactionType = (reaction as HTMLElement).dataset['reaction'];
                if (reactionType) {
                    void this.toggleReaction(messageId, reactionType);
                }
            });
        });

        deleteBtn?.addEventListener('click', e => {
            e.stopPropagation();
            if (confirm('Delete this message?')) {
                void this.deleteMessage(messageId);
            }
        });

        editBtn?.addEventListener('click', e => {
            e.stopPropagation();
            this.showEditUI(msgEl, messageId, originalText);
        });

        document.addEventListener('click', () => {
            picker?.classList.remove('show');
        });
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    private handleNewMessage(event: { message?: MessageResponse }): void {
        if (event.message) {
            const wasNearBottom = this.isNearBottom();
            this.renderMessage(event.message);
            if (wasNearBottom) {
                this.scrollToBottom();
            }
        }
    }

    private handleDeletedMessage(event: { message?: MessageResponse }): void {
        if (event.message) {
            const msgEl = this.querySelector(`[data-message-id="${event.message.id}"]`);
            if (msgEl) msgEl.remove();
        }
    }

    private handleUpdatedMessage(event: { message?: MessageResponse }): void {
        if (!event.message) return;

        const msgEl = this.querySelector<HTMLElement>(`[data-message-id="${event.message.id}"]`);
        if (!msgEl) return;

        // Update message text content
        const contentEl = msgEl.querySelector('.chat-message-content');
        if (contentEl && event.message.text) {
            contentEl.innerHTML = `<span class="chat-text">${this.linkifyText(this.escapeHtml(event.message.text))}</span>`;
        }

        // Add or update edited indicator
        const isEdited =
            event.message.message_text_updated_at && event.message.message_text_updated_at !== event.message.created_at;
        let editedEl = msgEl.querySelector('.chat-edited');
        if (isEdited && !editedEl) {
            const timestampEl = msgEl.querySelector('.chat-timestamp');
            if (timestampEl) {
                editedEl = document.createElement('span');
                editedEl.className = 'chat-edited';
                editedEl.textContent = '(edited)';
                timestampEl.insertAdjacentElement('afterend', editedEl);
            }
        }
    }

    private handleReactionUpdate(event: { message?: MessageResponse }): void {
        if (event.message) {
            const msgEl = this.querySelector(`[data-message-id="${event.message.id}"]`);
            if (msgEl) {
                const reactionsContainer = msgEl.querySelector('.chat-reactions');
                if (reactionsContainer) {
                    reactionsContainer.innerHTML = this.renderReactions(event.message);
                    reactionsContainer.querySelectorAll('.chat-reaction').forEach(reaction => {
                        reaction.addEventListener('click', () => {
                            const reactionType = (reaction as HTMLElement).dataset['reaction'];
                            if (reactionType && event.message?.id) {
                                void this.toggleReaction(event.message.id, reactionType);
                            }
                        });
                    });
                }
            }
        }
    }

    // ========================================================================
    // Actions
    // ========================================================================

    private async sendMessage(): Promise<void> {
        if (!this.channel) return;

        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        const text = textInput?.value.trim();
        if (!text) return;

        // Check for slash command (NCS/logger only)
        if (text.startsWith('/')) {
            if (textInput) await this.executeSlashCommand(text.slice(1), textInput);
            return;
        }

        try {
            await this.channel.sendMessage({ text });
            if (textInput) textInput.value = '';
        } catch (error) {
            this.handleSendError(error);
        }
    }

    /**
     * Execute a slash command via the admin interactions API
     * e.g., "/i W1ABC" -> POST { cmdLine: "i W1ABC" }
     */
    private async executeSlashCommand(cmdLine: string, textInput: HTMLInputElement | null): Promise<void> {
        if (!cmdLine.trim()) {
            this.showChatNotice('Empty command');
            return;
        }

        try {
            const response = await fetch(`/api/admin/interactions/${this.npid.toString()}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cmdLine })
            });

            const result = (await response.json()) as { message?: string; errorMessage?: string };

            if (response.ok) {
                if (textInput) textInput.value = '';
                if (result.message) {
                    this.showChatNotice(result.message);
                }
            } else {
                this.showChatNotice(result.errorMessage || 'Command failed');
            }
        } catch (error) {
            logger.error('Slash command failed:', error);
            this.showChatNotice('Command failed');
        }
    }

    private async sendImage(file: File): Promise<void> {
        if (!this.channel) return;

        try {
            logger.info(`Attempting to send image: ${file.name} (${file.size} bytes, type: ${file.type})`);
            const response = await this.channel.sendImage(file);
            logger.info('Image uploaded successfully:', response.file);
            await this.channel.sendMessage({
                attachments: [
                    {
                        type: 'image',
                        asset_url: response.file,
                        image_url: response.file,
                        thumb_url: response.file
                    }
                ]
            });
        } catch (error) {
            this.handleSendError(error);
        }
    }

    private async toggleReaction(messageId: string, reactionType: string): Promise<void> {
        if (!this.channel) return;

        try {
            const message = this.channel.state.messages.find(m => m.id === messageId);
            const ownReactions = (message?.own_reactions || []) as ChatReaction[];
            const existingReaction = ownReactions.find(r => r.type === reactionType);

            if (existingReaction) {
                await this.channel.deleteReaction(messageId, reactionType);
                logger.debug(`Removed ${reactionType} reaction from ${messageId}`);
            } else {
                await this.channel.sendReaction(messageId, { type: reactionType });
                logger.debug(`Added ${reactionType} reaction to ${messageId}`);
            }
        } catch (error) {
            logger.error('Failed to toggle reaction:', error);
        }
    }

    private async deleteMessage(messageId: string): Promise<void> {
        if (!this.canModerate()) return;

        try {
            const response = await fetch(`/api/endorse/chat/${this.npid.toString()}/message/${messageId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const data = (await response.json()) as { errorMessage?: string };
                throw new Error(data.errorMessage ?? 'Failed to delete message');
            }

            logger.info(`Deleted message ${messageId}`);
        } catch (error) {
            logger.error('Failed to delete message:', error);
        }
    }

    private showEditUI(msgEl: HTMLElement, messageId: string, originalText: string): void {
        const contentEl = msgEl.querySelector('.chat-message-content');
        if (!contentEl) return;

        // Don't allow multiple edit UIs
        if (msgEl.querySelector('.chat-edit-input')) return;

        // Store original content for cancel
        const originalHtml = contentEl.innerHTML;

        // Replace content with edit input
        contentEl.innerHTML = `
            <input type="text" class="chat-edit-input" value="${this.escapeHtml(originalText)}" maxlength="500">
            <div class="chat-edit-actions">
                <button class="chat-edit-save">Save</button>
                <button class="chat-edit-cancel">Cancel</button>
            </div>
        `;

        const input = contentEl.querySelector('.chat-edit-input') as HTMLInputElement;
        const saveBtn = contentEl.querySelector('.chat-edit-save');
        const cancelBtn = contentEl.querySelector('.chat-edit-cancel');

        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);

        const cancelEdit = () => {
            contentEl.innerHTML = originalHtml;
        };

        const saveEdit = () => {
            const newText = input?.value.trim();
            if (newText && newText !== originalText) {
                void this.editMessage(messageId, newText);
            }
            cancelEdit();
        };

        input?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveEdit();
            } else if (e.key === 'Escape') {
                cancelEdit();
            }
        });

        saveBtn?.addEventListener('click', e => {
            e.stopPropagation();
            saveEdit();
        });

        cancelBtn?.addEventListener('click', e => {
            e.stopPropagation();
            cancelEdit();
        });
    }

    private async editMessage(messageId: string, newText: string): Promise<void> {
        if (!this.client) return;

        try {
            // Stream Chat SDK handles authorization - only message owner can edit
            await this.client.updateMessage({ id: messageId, text: newText });
            logger.info(`Edited message ${messageId}`);
        } catch (error) {
            logger.error('Failed to edit message:', error);
            this.showChatNotice('Failed to edit message');
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private canModerate(): boolean {
        return this.level === 0; // NCS only
    }

    private updateModerationButtons(): void {
        const canMod = this.canModerate();
        const messages = this.querySelectorAll('.chat-message');

        messages.forEach(msgEl => {
            const actionsContainer = msgEl.querySelector('.chat-message-actions');
            if (!actionsContainer) return;

            const existingDeleteBtn = actionsContainer.querySelector('.chat-delete-btn');

            if (canMod && !existingDeleteBtn) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'chat-action-btn chat-mod-btn chat-delete-btn';
                deleteBtn.title = 'Delete message';
                deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
                deleteBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const messageId = (msgEl as HTMLElement).dataset['messageId'];
                    if (messageId && confirm('Delete this message?')) {
                        void this.deleteMessage(messageId);
                    }
                });
                actionsContainer.appendChild(deleteBtn);
            } else if (!canMod && existingDeleteBtn) {
                existingDeleteBtn.remove();
            }
        });
    }

    private async fetchToken(): Promise<ChatTokenResponse | null> {
        const response = await fetch(`/api/endorse/chat/${this.npid.toString()}`);
        if (!response.ok) {
            throw new Error(`Failed to get chat token: ${response.statusText}`);
        }
        const data = (await response.json()) as { message?: unknown };
        // Chat is optional; the server returns { enabled: false } when GetStream
        // is not configured. Treat that as "no chat" rather than an error.
        if (data.message && (data.message as { enabled?: boolean }).enabled === false) {
            return null;
        }
        if (!isChatTokenResponse(data.message)) {
            throw new Error('Invalid chat token response from server');
        }
        return data.message;
    }

    /**
     * Check if scroll position is near the bottom of the messages container.
     * Used to determine whether to auto-scroll on new messages.
     * WHY: Only auto-scroll if user is already at/near bottom. If they've scrolled
     * up to read older messages, auto-scrolling would be disruptive.
     */
    private isNearBottom(): boolean {
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer) return true;

        const { scrollHeight, scrollTop, clientHeight } = messagesContainer;

        // If content doesn't overflow yet, always scroll
        if (scrollHeight <= clientHeight) return true;

        const threshold = 150; // pixels from bottom (accounts for message height)
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        return distanceFromBottom < threshold;
    }

    private scrollToBottom(): void {
        const messagesContainer = this.querySelector('.chat-messages');
        if (messagesContainer) {
            // Use requestAnimationFrame to ensure DOM has updated before scrolling
            requestAnimationFrame(() => {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            });
        }
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Format username for display: "Name(CALLSIGN)" -> Name in light, callsign in secondary accent
     * Falls back to plain text if no parentheses found (just a callsign)
     */
    private formatUsername(rawName: string): string {
        const match = rawName.match(/^(.+)\(([^)]+)\)$/);
        if (match && match[1] && match[2]) {
            return `${this.escapeHtml(match[1])}<span class="chat-callsign">(${this.escapeHtml(match[2])})</span>`;
        }
        return this.escapeHtml(rawName);
    }

    /**
     * Handle errors from sendMessage/sendImage
     * Shows user-friendly message for ban (code 17) and mute (code 17) errors
     */
    private handleSendError(error: unknown): void {
        // Check for Stream Chat error with code property
        const streamError = error as { code?: number; message?: string };

        if (streamError.code === 17) {
            // User is banned or muted - show friendly message
            this.showChatNotice('You are currently unable to send messages in this chat.');
            logger.info('User attempted to send message while banned/muted');
        } else {
            logger.error('Failed to send message:', error);
        }
    }

    /**
     * Show sticky command tip for NCS/loggers.
     * Uses UserAgentPersistentPreferences to remember if user dismissed it.
     */
    private showCommandTip(): void {
        // Don't show if user previously dismissed (uses prefs pattern from widgets.ts)
        if (prefs.chatCommandTipDismissed) return;

        const chatWidget = this.querySelector<HTMLElement>('.chat-widget');
        if (!chatWidget) return;

        // Don't show if already showing
        if (this.querySelector('.command-tip')) return;

        const tip = document.createElement('div');
        tip.className = 'command-tip';
        tip.style.cssText = `
            background: var(--hl-quaternary);
            border: 1px solid rgba(220, 131, 53, 0.25);
            border-radius: 6px;
            color: var(--hl-light);
            padding: 10px 12px;
            margin: 8px;
            font-size: 13px;
            position: relative;
        `;
        tip.innerHTML = `
            <button class="tip-dismiss" style="
                position: absolute;
                top: 4px;
                right: 8px;
                background: none;
                border: none;
                color: var(--hl-light);
                cursor: pointer;
                font-size: 16px;
                opacity: 0.6;
            ">&times;</button>
            <strong style="color: var(--hl-primary);">Tip:</strong> You can enter commands directly in chat:<br>
            <code style="color: var(--hl-secondary); font-size: 12px;">/i W1ABC</code> check in &nbsp;
            <code style="color: var(--hl-secondary); font-size: 12px;">/o W1ABC</code> check out &nbsp;
            <code style="color: var(--hl-secondary); font-size: 12px;">/?</code> help
        `;

        // Insert at the top of chat widget
        chatWidget.insertBefore(tip, chatWidget.firstChild);

        // Dismiss button handler - remember preference
        const dismissBtn = tip.querySelector('.tip-dismiss');
        dismissBtn?.addEventListener('click', () => {
            prefs.chatCommandTipDismissed = true;
            tip.remove();
        });
    }

    /**
     * Show a temporary notice in the chat area
     */
    private showChatNotice(message: string): void {
        const messagesContainer = this.querySelector<HTMLElement>('.chat-messages');
        if (!messagesContainer) return;

        // Remove any existing notice
        const existingNotice = this.querySelector('.chat-notice');
        if (existingNotice) existingNotice.remove();

        // Create notice element
        const notice = document.createElement('div');
        notice.className = 'chat-notice';
        notice.style.cssText =
            'background: #3a4a5c; color: var(--hl-light); padding: 8px 12px; font-size: 13px; border-left: 3px solid var(--hl-secondary); margin: 4px 0;';
        notice.textContent = message;

        // Append to messages container and scroll to it
        messagesContainer.appendChild(notice);
        this.scrollToBottom();

        // Auto-remove after 8 seconds
        setTimeout(() => notice.remove(), 8000);
    }

    private disconnect(): void {
        // Clean up global event listeners to prevent memory leaks
        if (this.documentClickHandler) {
            document.removeEventListener('click', this.documentClickHandler);
            this.documentClickHandler = null;
        }
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }

        if (this.store) {
            this.store.unsubscribe(this);
        }
        if (this.client) {
            void this.client.disconnectUser();
            logger.info('Disconnected from chat');
        }
    }

    /**
     * Convert URLs in text to clickable links (text should already be HTML-escaped)
     */
    private linkifyText(text: string): string {
        // Match URLs (http, https, or www)
        const urlPattern = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
        return text.replace(urlPattern, url => {
            const href = url.startsWith('www.') ? `https://${url}` : url;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color: var(--hl-success);">${url}</a>`;
        });
    }

    // ========================================================================
    // Static initialization
    // ========================================================================

    static init(store: LiveNetReactiveStore, level: number): void {
        customElements.define('hl-chat', ChatWidget);

        // Find existing chat container and initialize
        const container = document.getElementById('stream-chat-container');
        if (container && serverInfo.chat) {
            const widget = document.createElement('hl-chat') as ChatWidget;
            // Preserve container's sizing classes
            widget.className = container.className;
            container.replaceWith(widget);
            void widget.init(store, level);
        }
    }
}

// Keep ChatClient as alias for backward compatibility
export { ChatWidget as ChatClient };
