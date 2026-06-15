/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Chat Widget - In-house chat integration (replaces GetStream.io)
 *
 * Uses LocalChatConnection for transport (REST + SSE) instead of StreamChat SDK.
 * All UI, rendering, and event handling patterns remain the same.
 */

import { LiveNetReactiveStore, StoreSubscriber, NewDataReturnType } from '#@client/lib/stores.js';
import { createLogger } from '#@client/lib/logger.js';
import { serverInfo } from '#@client/lib/serverInfo.js';
import { getNpid, generateUUID, UserAgentPersistentPreferences, expiryFromPreset } from '#@client/lib/clientUtils.js';
import { LocalChatConnection, LocalChatMessage } from '#@client/lib/localChat.js';
import { parseMentions } from '#@client/lib/mentions.js';

const logger = createLogger('lib/chat.ts');
const prefs = new UserAgentPersistentPreferences();

// ============================================================================
// Types
// ============================================================================

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
    private connection: LocalChatConnection | null = null;
    private npid = getNpid();
    private level: number | undefined;
    private initialized = false;
    private messages: LocalChatMessage[] = [];
    private lastKnownLevel: number | undefined;
    private currentUserId: string | null = null;
    private selfCallSign: string | null = null;

    // Reply state
    private replyingTo: { messageId: string; callSign: string; text: string } | null = null;

    // Typing indicator state
    private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private typingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private wasTyping = false;

    // Ban state
    private isBanned: { reason: string; bannedAt: string } | null = null;

    // UI state
    private lastRenderedDate: string | null = null;
    private lastRenderedCallSign: string | null = null;
    private unreadCount = 0;
    private isScrolledUp = false;
    private scrollListener: (() => void) | null = null;
    private visibilityHandler: (() => void) | null = null;

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

            // Create a new local chat connection
            const conn = new LocalChatConnection();
            this.connection = conn;

            // Fetch chat session — replaces old GetStream token fetch
            const session = await conn.getSession();
            if (!session || !session.enabled) {
                logger.info('Chat is disabled on this server — skipping chat.');
                return;
            }
            this.currentUserId = session.userId;
            this.selfCallSign = (session.callSign || '').toUpperCase();

            // Check if user is banned
            if (session.banned && typeof session.banned === 'object') {
                this.isBanned = session.banned as { reason: string; bannedAt: string };
                logger.info(`User is banned from chat: ${this.isBanned.reason}`);
            }

            // Connect to the SSE stream
            conn.connect();

            // Subscribe to store for role changes (level may change during session)
            this.store.subscribe(this);
            this.setupConnectionListeners();

            this.initialized = true;
            this.render();

            // Fetch initial messages from the server
            const existingMessages = await conn.getMessages();
            if (existingMessages && existingMessages.length > 0) {
                this.messages = existingMessages;
            }
            this.loadMessages();
            // Setup scroll-to-latest button
            this.setupScrollListener();
            // Track tab visibility for unread count
            this.visibilityHandler = () => {
                if (!document.hidden) {
                    this.unreadCount = 0;
                    this.updateLatestButton();
                }
            };
            document.addEventListener('visibilitychange', this.visibilityHandler);

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
                    .chat-mention {
                        color: var(--hl-secondary);
                        background: rgba(163, 118, 195, 0.18);
                        border-radius: 4px;
                        padding: 0 3px;
                        font-weight: 600;
                    }
                </style>
                <div class="chat-messages flex-grow-1 overflow-auto px-1 py-1">
                    <div class="text-center text-muted p-4">
                        <p>Connecting to chat...</p>
                    </div>
                </div>
                <div class="chat-typing-indicator d-none px-2 py-1" style="color: var(--hl-tertiary); font-size: 12px; font-style: italic; min-height: 20px;"></div>
                <div class="chat-reply-indicator d-none" style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--hl-quaternary); border-top: 1px solid var(--hl-tertiary); font-size: 12px;">
                    <i class="bi bi-reply-fill" style="color: var(--hl-secondary);"></i>
                    <span style="flex: 1;">
                        <span class="chat-reply-name" style="color: var(--hl-secondary); font-weight: 600;"></span>
                        <span class="chat-reply-text" style="color: var(--hl-tertiary);"></span>
                    </span>
                    <button class="chat-reply-cancel btn btn-sm p-0" style="background: none; border: none; color: var(--hl-tertiary); cursor: pointer;">&times;</button>
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
        if (!this.connection) return;
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer) return;

        if (this.messages.length === 0) {
            messagesContainer.innerHTML = `
                <div class="text-center text-muted p-4">
                    <p>No messages yet. Say hello!</p>
                </div>
            `;
            return;
        }

        messagesContainer.innerHTML = '';
        this.lastRenderedDate = null;
        this.lastRenderedCallSign = null;
        this.messages.forEach(msg => this.renderMessage(msg));
        this.scrollToBottom();
    }

    private renderMessage(msg: LocalChatMessage): void {
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer) return;

        const msgDate = new Date(msg.createdAt);
        const msgDateKey = this.dateKey(msgDate);
        const smartTs = this.formatSmartTimestamp(msgDate);
        const isSameCallSign = msg.callSign && msg.callSign === this.lastRenderedCallSign;

        // Insert date separator if date changed
        if (msgDateKey !== this.lastRenderedDate) {
            this.lastRenderedDate = msgDateKey;
            const sep = document.createElement('div');
            sep.className = 'chat-date-separator';
            sep.style.cssText = 'text-align: center; font-size: 11px; color: var(--hl-tertiary); padding: 8px 0 4px; opacity: 0.7;';
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const msgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());
            const diff = Math.round((today.getTime() - msgDay.getTime()) / 86400000);
            let label: string;
            if (diff === 0) label = 'Today';
            else if (diff === 1) label = 'Yesterday';
            else label = msgDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
            sep.textContent = label;
            messagesContainer.appendChild(sep);
        }

        const rawName = msg.displayName || msg.callSign || 'Unknown';
        const usernameHtml = this.formatUsername(rawName);

        const isEdited = msg.edited;
        const editedIndicator = isEdited ? '<span class="chat-edited">(edited)</span>' : '';

        const isOwnMessage = msg.userId === this.currentUserId;
        const editBtn = isOwnMessage
            ? `<button class="chat-action-btn chat-edit-btn" title="Edit message"><i class="bi bi-pencil"></i></button>`
            : '';

        const msgEl = document.createElement('div');
        msgEl.className = 'chat-message';
        msgEl.dataset['messageId'] = msg.id;
        msgEl.dataset['userId'] = msg.userId || '';
        msgEl.dataset['callsign'] = msg.callSign || '';

        let messageContent = '';
        if (msg.text) {
            messageContent += `<span class="chat-text">${this.renderMessageBody(msg.text)}</span>`;
        }

        if (msg.imageUrl) {
            messageContent += `
                <div class="mt-1">
                    <img src="${this.escapeHtml(msg.imageUrl)}"
                         alt="Shared image"
                         class="chat-image img-fluid rounded chat-image-clickable"
                         style="max-height: 200px; cursor: pointer; border: 1px solid var(--hl-quaternary);">
                </div>
            `;
        }

        const reactionsHtml = this.renderReactions(msg);
        const moderateBtn = this.canModerate()
            ? `<button class="chat-action-btn chat-mod-btn chat-delete-btn" title="Delete message"><i class="bi bi-trash"></i></button>`
              + (msg.userId && msg.userId !== this.currentUserId
                  ? `<button class="chat-action-btn chat-mod-btn chat-ban-btn" title="Ban author"><i class="bi bi-slash-circle"></i></button>`
                  : '')
            : '';

        msgEl.innerHTML = `
            <div class="chat-message-actions">
                ${editBtn}
                <button class="chat-action-btn chat-react-btn" title="React"><i class="bi bi-emoji-smile"></i></button>
                <button class="chat-action-btn chat-reply-btn" title="Reply"><i class="bi bi-reply"></i></button>
                ${moderateBtn}
            </div>
            <div class="chat-reaction-picker">
                ${REACTIONS.map(r => `<button data-reaction="${r.type}">${r.emoji}</button>`).join('')}
            </div>
            ${isSameCallSign ? '' : `<span class="chat-username">${usernameHtml}</span>`}
            <span class="chat-timestamp ms-2">${smartTs}</span>
            ${editedIndicator}
            ${msg.parentMessage ? this.renderReplySnippet(msg) : ''}
            <div class="chat-message-content">${messageContent}</div>
            ${msg.replyCount && msg.replyCount > 0 ? `<div class="chat-reply-count" style="margin-top: 4px; font-size: 11px; color: var(--hl-secondary); cursor: pointer;"><i class="bi bi-reply-fill"></i> ${msg.replyCount} ${msg.replyCount === 1 ? 'reply' : 'replies'}</div>` : ''}
            <div class="chat-reactions">${reactionsHtml}</div>
        `;

        // If grouped, reduce padding and add separator line
        if (isSameCallSign) {
            msgEl.style.paddingTop = '2px';
            msgEl.style.borderTop = '1px solid rgba(240, 238, 222, 0.08)';
        }
        this.lastRenderedCallSign = msg.callSign || null;

        this.setupMessageActions(msgEl, msg.id, msg.text || '');

        const placeholder = messagesContainer.querySelector('.text-muted');
        if (placeholder) placeholder.remove();

        messagesContainer.appendChild(msgEl);
    }

    private renderReplySnippet(msg: LocalChatMessage): string {
        const callsign = msg.parentCallSign || 'someone';
        const preview = msg.parentText ? this.escapeHtml(msg.parentText.slice(0, 60)) : '';
        return preview
            ? `<div style="font-size: 11px; color: var(--hl-tertiary); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><i class="bi bi-reply-fill" style="font-size: 10px;"></i> <strong>${this.escapeHtml(callsign)}</strong>: ${preview}</div>`
            : `<div style="font-size: 11px; color: var(--hl-tertiary); margin-bottom: 2px;"><i class="bi bi-reply-fill" style="font-size: 10px;"></i> Replying to <strong>${this.escapeHtml(callsign)}</strong></div>`;
    }

    private renderReactions(msg: any): string {
        const reactions = msg.reactions || {};
        const ownReactionTypes = new Set(
            this.currentUserId ? Object.entries(reactions)
                .filter(([, users]) => (users as string[]).includes(this.currentUserId!))
                .map(([type]) => type) : []
        );

        return REACTIONS.filter(r => reactions[r.type] && (reactions[r.type] as string[]).length > 0)
            .map(r => {
                const count = (reactions[r.type] as string[])?.length || 0;
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

    private setupConnectionListeners(): void {
        if (!this.connection) return;

        this.connection.on('message.new', this.handleNewMessage.bind(this));
        this.connection.on('message.updated', this.handleUpdatedMessage.bind(this));
        this.connection.on('message.deleted', this.handleDeletedMessage.bind(this));
        this.connection.on('reaction', this.handleReaction.bind(this));
        this.connection.on('typing', this.handleTypingEvent.bind(this));
        this.connection.on('ban', this.handleBanEvent.bind(this));
    }

    private setupInputListeners(): void {
        const sendBtn = this.querySelector('.chat-send-btn');
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        const fileInput = this.querySelector<HTMLInputElement>('.chat-file-input');
        const emojiBtn = this.querySelector('.chat-emoji-btn');
        const emojiPickerWrapper = this.querySelector('.chat-emoji-picker');
        const emojiPicker = this.querySelector('emoji-picker');

        sendBtn?.addEventListener('click', () => void this.sendMessage());
        textInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void this.sendMessage();
            } else if (e.key === 'Escape' && this.replyingTo) {
                this.cancelReply();
            }
        });

        // Typing indicator — debounced, fires on input change
        textInput?.addEventListener('input', () => {
            this.handleInputTyping();
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
            }
            emojiPickerWrapper?.classList.remove('show');
            // Defer focus to avoid mobile keyboard swallowing the next keydown
            // after the emoji-picker shadow DOM releases its event capture
            setTimeout(() => textInput?.focus(), 100);
        });

        // Close emoji picker when clicking outside
        // Store handler for cleanup in disconnect()
        this.documentClickHandler = (e: MouseEvent) => {
            if (!emojiPickerWrapper?.contains(e.target as Node) && !emojiBtn?.contains(e.target as Node)) {
                emojiPickerWrapper?.classList.remove('show');
            }
        };
        document.addEventListener('click', this.documentClickHandler);

        // Reply cancel button
        const replyCancel = this.querySelector('.chat-reply-cancel');
        replyCancel?.addEventListener('click', () => this.cancelReply());

        // Escape key cancels reply
        textInput?.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.replyingTo) {
                this.cancelReply();
                textInput.blur();
            }
        });

        // Slash command autocomplete
        textInput?.addEventListener('input', () => {
            this.handleSlashAutocomplete();
        });
        // Tab key navigates autocomplete dropdown; Enter selects
        textInput?.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Tab') {
                const dd = this.querySelector('.chat-slash-dropdown');
                if (dd && !dd.classList.contains('d-none')) {
                    e.preventDefault();
                    const active = dd.querySelector('.chat-slash-active');
                    if (active) {
                        const nxt = active.nextElementSibling as HTMLElement;
                        if (nxt) { active.classList.remove('chat-slash-active'); nxt.classList.add('chat-slash-active'); }
                    } else {
                        const first = dd.querySelector('div') as HTMLElement;
                        if (first) first.classList.add('chat-slash-active');
                    }
                }
            }
            if (e.key === 'Enter') {
                const dd = this.querySelector('.chat-slash-dropdown');
                if (dd && !dd.classList.contains('d-none')) {
                    const active = dd.querySelector('.chat-slash-active');
                    if (active && textInput) {
                        e.preventDefault();
                        textInput.value = active.textContent || '';
                        dd.classList.add('d-none');
                    }
                }
            }
        });

        // Store handler for cleanup in disconnect()
        this.beforeUnloadHandler = () => this.disconnect();
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    private setupMessageActions(msgEl: HTMLElement, messageId: string, originalText: string): void {
        const reactBtn = msgEl.querySelector('.chat-react-btn');
        const picker = msgEl.querySelector('.chat-reaction-picker');
        const deleteBtn = msgEl.querySelector('.chat-delete-btn');
        const editBtn = msgEl.querySelector('.chat-edit-btn');
        const replyBtn = msgEl.querySelector('.chat-reply-btn');
        const reactions = msgEl.querySelectorAll('.chat-reaction');

        reactBtn?.addEventListener('click', e => {
            e.stopPropagation();
            picker?.classList.toggle('show');
        });

        // Reply button
        replyBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const callSign = msgEl.querySelector('.chat-username')?.textContent || 'Unknown';
            const textEl = msgEl.querySelector('.chat-text');
            const text = textEl?.textContent || '';
            this.startReply(messageId, callSign, text);
        });

        // Reply count click — load thread replies
        const replyCountEl = msgEl.querySelector('.chat-reply-count');
        replyCountEl?.addEventListener('click', e => {
            e.stopPropagation();
            void this.loadThread(messageId, msgEl);
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

        // Image lightbox click
        const chatImages = msgEl.querySelectorAll('.chat-image');
        chatImages.forEach(img => {
            img.addEventListener('click', () => {
                const src = img.getAttribute('src');
                if (src) this.showLightbox(src);
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

        const banBtn = msgEl.querySelector('.chat-ban-btn');
        banBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const callSign = msgEl.querySelector('.chat-username')?.textContent || (msgEl as HTMLElement).dataset['callsign'] || 'this user';
            this.showBanDialog(messageId, callSign);
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

    private handleNewMessage(data: unknown): void {
        const msg = data as LocalChatMessage;
        if (msg && msg.id) {
            this.messages.push(msg);
            const wasNearBottom = this.isNearBottom();
            if (!wasNearBottom) {
                this.unreadCount += 1;
                this.updateLatestButton();
            }
            this.renderMessage(msg);
            if (wasNearBottom) {
                this.scrollToBottom();
            }
            // If this is a reply, update the parent's reply count in the DOM
            if (msg.parentMessage) {
                this.updateParentReplyCount(msg.parentMessage);
            }
        }
    }

    /**
     * Update the displayed reply count on a parent message.
     */
    private updateParentReplyCount(parentMessageId: string): void {
        const parentEl = this.querySelector(`[data-message-id="${parentMessageId}"]`);
        if (!parentEl) return;
        const countEl = parentEl.querySelector('.chat-reply-count');
        if (countEl) {
            // Increment the displayed count
            const match = countEl.textContent?.match(/(\d+)/);
            if (match && match[1]) {
                const count = parseInt(match[1]) + 1;
                countEl.innerHTML = `<i class="bi bi-reply-fill"></i> ${count} ${count === 1 ? 'reply' : 'replies'}`;
            }
        }
    }

    private handleDeletedMessage(data: unknown): void {
        const event = data as { messageId?: string };
        if (event && event.messageId) {
            const msgEl = this.querySelector(`[data-message-id="${event.messageId}"]`);
            if (msgEl) msgEl.remove();
            this.messages = this.messages.filter(m => m.id !== event.messageId);
        }
    }

    private handleUpdatedMessage(data: unknown): void {
        const msg = data as LocalChatMessage;
        if (!msg || !msg.id) return;

        // Update in-memory store
        const idx = this.messages.findIndex(m => m.id === msg.id);
        if (idx >= 0) this.messages[idx] = msg;

        // Update DOM
        const msgEl = this.querySelector(`[data-message-id="${msg.id}"]`);
        if (!msgEl) return;
        const contentEl = msgEl.querySelector('.chat-message-content');
        if (contentEl && msg.text) {
            contentEl.innerHTML = `<span class="chat-text">${this.renderMessageBody(msg.text)}</span>`;
        }
        const editedIndicators = msgEl.querySelectorAll('.chat-edited');
        if (msg.edited && editedIndicators.length === 0) {
            const timestampEl = msgEl.querySelector('.chat-timestamp');
            if (timestampEl) {
                const edited = document.createElement('span');
                edited.className = 'chat-edited';
                edited.textContent = '(edited)';
                timestampEl.insertAdjacentElement('afterend', edited);
            }
        }
    }

    private handleReaction(data: unknown): void {
        const event = data as { messageId?: string; reactionType?: string; action?: string; reactions?: Record<string, string[]> };
        if (!event || !event.messageId) return;

        // Update in-memory store
        const msg = this.messages.find(m => m.id === event.messageId);
        if (msg && event.reactions) {
            msg.reactions = event.reactions;
        }

        // Update DOM — re-render reactions for that message
        const msgEl = this.querySelector(`[data-message-id="${event.messageId}"]`);
        if (!msgEl) return;
        const reactionsContainer = msgEl.querySelector('.chat-reactions');
        if (reactionsContainer && msg) {
            reactionsContainer.innerHTML = this.renderReactions(msg);
        }
    }

    // ========================================================================
    // Typing Indicator
    // ========================================================================

    private handleInputTyping(): void {
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        const isCurrentlyTyping = textInput ? textInput.value.trim().length > 0 : false;

        // Debounce: only send if state changed
        if (isCurrentlyTyping !== this.wasTyping) {
            this.wasTyping = isCurrentlyTyping;
            this.connection?.sendTyping(isCurrentlyTyping);
        }

        // Auto-stop typing after 3 seconds of no input
        if (this.typingDebounceTimer) clearTimeout(this.typingDebounceTimer);
        if (isCurrentlyTyping) {
            this.typingDebounceTimer = setTimeout(() => {
                if (this.wasTyping) {
                    this.wasTyping = false;
                    this.connection?.sendTyping(false);
                }
            }, 3000);
        }
    }

    private handleTypingEvent(data: unknown): void {
        const event = data as { type: string; callSign: string; isTyping: boolean };
        if (!event || !event.callSign) return;
        if (event.callSign === this.selfCallSign) return; // Don't show own typing

        const indicator = this.querySelector('.chat-typing-indicator');
        if (!indicator) return;

        if (event.isTyping) {
            // Add to typing set with auto-clear after 5s
            const existing = indicator.querySelector(`[data-typing-user="${event.callSign}"]`);
            if (!existing) {
                const el = document.createElement('span');
                el.dataset['typingUser'] = event.callSign;
                el.textContent = `${event.callSign} is typing...`;
                indicator.appendChild(el);
            }
            // Auto-clear after 5s (safety net)
            const existingTimer = this.typingTimers.get(event.callSign);
            if (existingTimer) clearTimeout(existingTimer);
            this.typingTimers.set(event.callSign, setTimeout(() => {
                const el = indicator.querySelector(`[data-typing-user="${event.callSign}"]`);
                if (el) el.remove();
                this.typingTimers.delete(event.callSign);
                this.updateTypingVisibility();
            }, 5000));
        } else {
            const el = indicator.querySelector(`[data-typing-user="${event.callSign}"]`);
            if (el) el.remove();
            const timer = this.typingTimers.get(event.callSign);
            if (timer) clearTimeout(timer);
            this.typingTimers.delete(event.callSign);
        }
        this.updateTypingVisibility();
    }

    private updateTypingVisibility(): void {
        const indicator = this.querySelector('.chat-typing-indicator');
        if (!indicator) return;
        const hasTyping = indicator.children.length > 0;
        indicator.classList.toggle('d-none', !hasTyping);
    }

    // ========================================================================
    // Ban Events
    // ========================================================================

    private handleBanEvent(data: unknown): void {
        const event = data as { type: string; callSign: string; reason?: string };
        if (!event || !event.callSign) return;

        if (event.type === 'ban') {
            // If we were banned, update state
            if (event.callSign === this.sessionCallSign) {
                this.isBanned = { reason: event.reason || 'Banned', bannedAt: new Date().toISOString() };
                this.showChatNotice(`You have been banned from chat: ${event.reason || 'No reason'}`);
                this.updateBanUI();
            }
        } else if (event.type === 'unban') {
            if (event.callSign === this.sessionCallSign) {
                this.isBanned = null;
                this.showChatNotice('You have been unbanned from chat');
                this.updateBanUI();
            }
        }
    }

    private updateBanUI(): void {
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        const sendBtn = this.querySelector('.chat-send-btn');
        const fileLabel = this.querySelector('.chat-icon-btn[title="Share image"]');
        if (textInput) {
            textInput.disabled = !!this.isBanned;
            textInput.placeholder = this.isBanned ? 'You are banned from chat' : 'Message...';
        }
        if (sendBtn) (sendBtn as HTMLButtonElement).disabled = !!this.isBanned;
        if (fileLabel) (fileLabel as HTMLElement).style.opacity = this.isBanned ? '0.4' : '1';
    }

    // ========================================================================
    // Reply / Thread
    // ========================================================================

    private startReply(messageId: string, callSign: string, text: string): void {
        this.replyingTo = { messageId, callSign, text: text.slice(0, 80) };
        this.updateReplyIndicator();
        // Focus the text input
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        textInput?.focus();
    }

    private cancelReply(): void {
        this.replyingTo = null;
        this.updateReplyIndicator();
    }

    /**
     * Load and display thread replies for a parent message.
     */
    private async loadThread(parentMessageId: string, parentMsgEl: HTMLElement): Promise<void> {
        if (!this.connection) return;

        // Check if thread is already open
        const existingThread = parentMsgEl.querySelector('.chat-thread');
        if (existingThread) {
            existingThread.remove();
            return;
        }

        try {
            const replies = await this.connection.getReplies(parentMessageId);
            if (replies.length === 0) return;

            const threadDiv = document.createElement('div');
            threadDiv.className = 'chat-thread';
            threadDiv.style.cssText = 'margin-left: 16px; padding-left: 8px; border-left: 2px solid var(--hl-quaternary); margin-top: 4px;';

            // Show the parent message as thread context header
            const parentMsg = this.messages.find(m => m.id === parentMessageId);
            if (parentMsg) {
                const parentHeader = document.createElement('div');
                parentHeader.style.cssText = 'padding: 6px 8px; border-bottom: 1px solid rgba(240, 238, 222, 0.15); margin-bottom: 4px;';
                const parentTs = new Date(parentMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const parentContent = parentMsg.text
                    ? this.linkifyText(this.escapeHtml(parentMsg.text))
                    : parentMsg.imageUrl
                        ? '<i class="bi bi-image"></i> Image'
                        : '';
                parentHeader.innerHTML = `
                    <div style="font-size: 10px; color: var(--hl-tertiary); margin-bottom: 2px;">Thread</div>
                    <span class="chat-username" style="font-size: 12px;">${this.escapeHtml(parentMsg.callSign)}</span>
                    <span class="chat-timestamp ms-2" style="font-size: 10px;">${parentTs}</span>
                    <div class="chat-text" style="font-size: 13px; margin-top: 2px;">${parentContent}</div>
                `;
                threadDiv.appendChild(parentHeader);
            }

            replies.forEach(reply => {
                const replyEl = document.createElement('div');
                replyEl.className = 'chat-message';
                replyEl.style.cssText = 'padding: 4px 8px; border-bottom: none; font-size: 13px;';
                const ts = new Date(reply.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                replyEl.innerHTML = `
                    <span class="chat-username" style="font-size: 12px;">${this.escapeHtml(reply.callSign)}</span>
                    <span class="chat-timestamp ms-2" style="font-size: 10px;">${ts}</span>
                    <div class="chat-text" style="font-size: 13px;">${this.linkifyText(this.escapeHtml(reply.text))}</div>
                `;
                threadDiv.appendChild(replyEl);
            });

            parentMsgEl.appendChild(threadDiv);
        } catch (err) {
            logger.error('Failed to load thread:', err);
        }
    }

    private updateReplyIndicator(): void {
        const indicator = this.querySelector('.chat-reply-indicator');
        if (!indicator) return;

        if (this.replyingTo) {
            indicator.classList.remove('d-none');
            const nameEl = indicator.querySelector('.chat-reply-name');
            const textEl = indicator.querySelector('.chat-reply-text');
            if (nameEl) nameEl.textContent = this.replyingTo.callSign;
            if (textEl) textEl.textContent = this.replyingTo.text;
        } else {
            indicator.classList.add('d-none');
        }
    }

    private get sessionCallSign(): string {
        return this.connection?.['session']?.callSign || '';
    }

    // ========================================================================
    // Actions
    // ========================================================================

    private async sendMessage(): Promise<void> {
        if (!this.connection) return;

        // Check if banned
        if (this.isBanned) {
            this.showChatNotice(`You are banned from chat: ${this.isBanned.reason}`);
            return;
        }

        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        const text = textInput?.value.trim();
        if (!text) return;

        // Check for slash command (NCS/logger only)
        if (text.startsWith('/')) {
            if (textInput) await this.executeSlashCommand(text.slice(1), textInput);
            return;
        }

        try {
            const parentMessageId = this.replyingTo?.messageId;
            const sent = await this.connection.sendMessage(text, parentMessageId);
            if (textInput) textInput.value = '';
            // Clear reply state after sending
            if (this.replyingTo) {
                this.replyingTo = null;
                this.updateReplyIndicator();
            }
            // Render locally in case SSE hasn't arrived yet (or as fallback)
            if (sent && sent.id && !this.messages.find(m => m.id === sent.id)) {
                this.messages.push(sent);
                const wasNearBottom = this.isNearBottom();
                this.renderMessage(sent);
                if (wasNearBottom) this.scrollToBottom();
            }
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
        if (!this.connection) return;

        // Check if banned
        if (this.isBanned) {
            this.showChatNotice(`You are banned from chat: ${this.isBanned.reason}`);
            return;
        }

        try {
            logger.info(`Attempting to send image: ${file.name} (${file.size} bytes, type: ${file.type})`);
            const parentMessageId = this.replyingTo?.messageId;
            const sent = await this.connection.sendImage(file, parentMessageId);

            // Clear reply state after sending
            if (this.replyingTo) {
                this.replyingTo = null;
                this.updateReplyIndicator();
            }

            // If upload succeeded, show status feedback
            if (sent && sent.id && !this.messages.find(m => m.id === sent.id)) {
                this.messages.push(sent);
                const wasNearBottom = this.isNearBottom();
                this.renderMessage(sent);
                if (wasNearBottom) this.scrollToBottom();
            } else if (!sent) {
                this.handleSendError(new Error('Image upload returned no message'));
            }
        } catch (error) {
            this.handleSendError(error);
        }
    }

    private async toggleReaction(messageId: string, reactionType: string): Promise<void> {
        if (!this.connection) return;
        try {
            await this.connection.toggleReaction(messageId, reactionType);
            logger.debug(`Toggled ${reactionType} reaction on ${messageId}`);
        } catch (error) {
            logger.error('Failed to toggle reaction:', error);
        }
    }

    private async deleteMessage(messageId: string): Promise<void> {
        if (!this.canModerate() || !this.connection) return;

        try {
            const success = await this.connection.deleteMessage(messageId);
            if (!success) {
                throw new Error('Failed to delete message');
            }
            logger.info(`Deleted message ${messageId}`);
        } catch (error) {
            logger.error('Failed to delete message:', error);
            this.showChatNotice('Failed to delete message');
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
        if (!this.connection) return;
        try {
            const success = await this.connection.editMessage(messageId, newText);
            if (!success) throw new Error('Edit failed');
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

                const msgUserId = (msgEl as HTMLElement).dataset['userId'];
                if (msgUserId && msgUserId !== this.currentUserId && !actionsContainer.querySelector('.chat-ban-btn')) {
                    const banBtn = document.createElement('button');
                    banBtn.className = 'chat-action-btn chat-mod-btn chat-ban-btn';
                    banBtn.title = 'Ban author';
                    banBtn.innerHTML = '<i class="bi bi-slash-circle"></i>';
                    banBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        const messageId = (msgEl as HTMLElement).dataset['messageId'];
                        const callSign = msgEl.querySelector('.chat-username')?.textContent || (msgEl as HTMLElement).dataset['callsign'] || 'this user';
                        if (messageId) this.showBanDialog(messageId, callSign);
                    });
                    actionsContainer.appendChild(banBtn);
                }
            } else if (!canMod && existingDeleteBtn) {
                existingDeleteBtn.remove();
                actionsContainer.querySelector('.chat-ban-btn')?.remove();
            }
        });
    }

    /**
     * Check if scroll position is near the bottom of the messages container.
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

    /** Format a date into a smart timestamp: today → "12:34 PM", yesterday → "Yesterday 12:34 PM", older → "Jun 8 12:34 PM" */
    private formatSmartTimestamp(date: Date): string {
        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.round((today.getTime() - msgDate.getTime()) / 86400000);
        if (diffDays === 0) return time;
        if (diffDays === 1) return `Yesterday ${time}`;
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
    }

    /** Format a date key for grouping (YYYY-MM-DD) */
    private dateKey(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
        logger.error('Failed to send message:', error);
        // Check for ban-related error messages from the server
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.toLowerCase().includes('banned')) {
            this.showChatNotice(errMsg);
        } else {
            this.showChatNotice('Failed to send message');
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

    // ========================================================================
    // Scroll-to-latest & Unread Badge
    // ========================================================================

    private setupScrollListener(): void {
        const container = this.querySelector('.chat-messages');
        if (!container) return;

        // Create latest button
        const btn = document.createElement('div');
        btn.className = 'chat-latest-btn d-none';
        btn.style.cssText = 'position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); background: var(--hl-secondary); color: #fff; border: none; border-radius: 20px; padding: 6px 16px; font-size: 12px; cursor: pointer; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: flex; align-items: center; gap: 6px;';
        btn.innerHTML = '↓ Latest <span class="chat-unread-badge" style="background: #e74c3c; color: #fff; border-radius: 10px; padding: 1px 6px; font-size: 10px; display: none;"></span>';
        const wrapper = this.querySelector<HTMLElement>('.chat-widget');
        if (wrapper) wrapper.style.position = 'relative';
        container.parentElement?.appendChild(btn);

        btn.addEventListener('click', () => {
            this.unreadCount = 0;
            this.updateLatestButton();
            this.scrollToBottom();
        });

        this.scrollListener = () => {
            const threshold = 150;
            const isUp = container.scrollHeight - container.scrollTop - container.clientHeight > threshold;
            this.isScrolledUp = isUp;
            this.updateLatestButton();
        };
        container.addEventListener('scroll', this.scrollListener);
    }

    private updateLatestButton(): void {
        const btn = this.querySelector('.chat-latest-btn');
        if (!btn) return;
        btn.classList.toggle('d-none', !this.isScrolledUp);
        const badge = btn.querySelector('.chat-unread-badge') as HTMLElement;
        if (badge) {
            if (this.unreadCount > 0) {
                badge.textContent = String(this.unreadCount);
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    // ========================================================================
    // Image Lightbox
    // ========================================================================

    private showLightbox(src: string): void {
        const overlay = document.createElement('div');
        overlay.className = 'chat-lightbox';
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; display: flex; align-items: center; justify-content: center; cursor: pointer;';
        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'max-width: 90%; max-height: 90%; border-radius: 4px; object-fit: contain;';
        overlay.appendChild(img);
        overlay.addEventListener('click', () => overlay.remove());
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') overlay.remove();
        }, { once: true });
        document.body.appendChild(overlay);
    }

    private showBanDialog(messageId: string, callSign: string): void {
        const overlay = document.createElement('div');
        overlay.className = 'chat-ban-dialog';
        overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999; display: flex; align-items: center; justify-content: center;';
        overlay.innerHTML = `
            <div style="background: var(--hl-dark, #1f2733); color: var(--hl-light); padding: 16px; border-radius: 6px; width: 320px; max-width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
                <div style="font-weight: 600; margin-bottom: 8px;">Ban ${this.escapeHtml(callSign)} from chat</div>
                <label style="font-size: 12px;">Reason</label>
                <input class="ban-reason" type="text" value="Disruptive behavior" maxlength="200"
                    style="width: 100%; margin: 4px 0 10px; padding: 6px; border-radius: 4px; border: 1px solid #444; background:#11161d; color:#fff;">
                <label style="font-size: 12px;">Duration</label>
                <select class="ban-duration" style="width: 100%; margin: 4px 0 8px; padding: 6px; border-radius: 4px;">
                    <option value="permanent">Permanent</option>
                    <option value="1h">1 hour</option>
                    <option value="24h">24 hours</option>
                    <option value="7d">7 days</option>
                    <option value="custom">Custom…</option>
                </select>
                <input class="ban-custom" type="datetime-local" style="width: 100%; margin-bottom: 10px; padding: 6px; display: none;">
                <div style="display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="ban-cancel" style="padding: 6px 12px;">Cancel</button>
                    <button class="ban-confirm" style="padding: 6px 12px; background:#dc3545; color:#fff; border:none; border-radius:4px;">Ban</button>
                </div>
            </div>`;
        const close = () => overlay.remove();
        const durationSel = overlay.querySelector<HTMLSelectElement>('.ban-duration')!;
        const customInput = overlay.querySelector<HTMLInputElement>('.ban-custom')!;
        durationSel.addEventListener('change', () => {
            customInput.style.display = durationSel.value === 'custom' ? 'block' : 'none';
        });
        overlay.querySelector('.ban-cancel')?.addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('.ban-confirm')?.addEventListener('click', () => {
            const reason = overlay.querySelector<HTMLInputElement>('.ban-reason')!.value.trim() || 'No reason given';
            const expiresAt = expiryFromPreset(durationSel.value, customInput.value);
            close();
            void this.banAuthor(messageId, reason, expiresAt);
        });
        document.body.appendChild(overlay);
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        }, { once: true });
    }

    private async banAuthor(messageId: string, reason: string, expiresAt: string | null): Promise<void> {
        if (!this.connection) return;
        const ok = await this.connection.banFromMessage(messageId, reason, expiresAt);
        this.showChatNotice(ok ? 'User banned from chat.' : 'Failed to ban user.');
    }

    // ========================================================================
    // Slash Command Autocomplete
    // ========================================================================

    private handleSlashAutocomplete(): void {
        const textInput = this.querySelector<HTMLInputElement>('.chat-text-input');
        if (!textInput) return;
        const val = textInput.value;

        // Remove existing dropdown
        const existing = this.querySelector('.chat-slash-dropdown');
        existing?.remove();

        // Only show when typing a command (starts with /, no space yet)
        if (!val.startsWith('/') || val.includes(' ')) return;

        const COMMANDS = [
            '/i — Check in',
            '/o — Check out',
            '/? — Help',
            '/ban — Ban user',
            '/unban — Unban user',
            '/f — Set frequency',
            '/nick — Set nickname',
            '/hand — Hand off',
            '/close — Close net',
            '/count — Station count'
        ];

        const partial = val.slice(1).toLowerCase();
        const matches = COMMANDS.filter(c => c.toLowerCase().includes(partial));
        if (matches.length === 0 || matches.length === COMMANDS.length) return;

        const dd = document.createElement('div');
        dd.className = 'chat-slash-dropdown';
        dd.style.cssText = 'position: absolute; bottom: 100%; left: 0; right: 0; background: var(--hl-dark); border: 1px solid var(--hl-quaternary); border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 100;';
        matches.forEach(cmd => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 6px 10px; font-size: 12px; color: var(--hl-light); cursor: pointer; border-bottom: 1px solid rgba(240, 238, 222, 0.1);';
            item.textContent = cmd;
            item.addEventListener('click', () => {
                textInput.value = cmd.split(' — ')[0] || '';
                dd.remove();
                textInput.focus();
            });
            dd.appendChild(item);
        });

        const wrapper = this.querySelector('.chat-input-wrapper');
        if (wrapper) {
            (wrapper as HTMLElement).style.position = 'relative';
            wrapper.appendChild(dd);
        }
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

        if (this.scrollListener) {
            const container = this.querySelector('.chat-messages');
            container?.removeEventListener('scroll', this.scrollListener);
            this.scrollListener = null;
        }
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }
        // Remove lightbox if any
        this.querySelector('.chat-lightbox')?.remove();
        // Remove slash dropdown if any
        this.querySelector('.chat-slash-dropdown')?.remove();
        // Remove latest button
        this.querySelector('.chat-latest-btn')?.remove();

        if (this.store) {
            this.store.unsubscribe(this);
        }
        if (this.connection) {
            this.connection.disconnect();
            logger.info('Disconnected from chat');
        }
    }

    /** Uppercased callsigns of stations currently present in the net. */
    private rosterCallSigns(): Set<string> {
        return new Set(
            (this.store?.stations.list ?? [])
                .map(s => (s.callSign || '').toUpperCase())
                .filter(Boolean)
        );
    }

    /**
     * Render message text to HTML: mention tokens that match a present callsign
     * become chips; everything else is escaped + linkified as before. Text
     * segments are HTML-escaped, so this is XSS-safe.
     */
    private renderMessageBody(text: string): string {
        const { segments } = parseMentions(text, this.rosterCallSigns());
        return segments
            .map(seg =>
                seg.type === 'mention'
                    ? `<span class="chat-mention">${this.escapeHtml(seg.value)}</span>`
                    : this.linkifyText(this.escapeHtml(seg.value))
            )
            .join('');
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
