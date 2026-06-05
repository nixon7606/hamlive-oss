import { StreamChat } from 'stream-chat';
import { createLogger } from '#@client/lib/logger.js';
import { serverInfo } from '#@client/lib/serverInfo.js';
import { getNpid, generateUUID, UserAgentPersistentPreferences } from '#@client/lib/clientUtils.js';
const logger = createLogger('lib/chat.ts');
const prefs = new UserAgentPersistentPreferences();
const isChatTokenResponse = (obj) => {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const response = obj;
    return (typeof response.token === 'string' &&
        typeof response.userId === 'string' &&
        typeof response.channelId === 'string' &&
        typeof response.channelType === 'string' &&
        typeof response.apiKey === 'string');
};
const REACTIONS = [
    { type: 'like', emoji: '👍' },
    { type: 'love', emoji: '❤️' },
    { type: 'haha', emoji: '😂' },
    { type: 'wow', emoji: '😮' }
];
export class ChatWidget extends HTMLElement {
    uuid = generateUUID();
    _online = true;
    store = null;
    client = null;
    channel = null;
    npid = getNpid();
    level;
    initialized = false;
    currentUserId = null;
    lastKnownLevel;
    documentClickHandler = null;
    beforeUnloadHandler = null;
    connectedCallback() {
        if (!serverInfo.chat) {
            logger.info('Chat is disabled via serverInfo');
            this.innerHTML = '';
            return;
        }
        this.style.display = 'block';
        this.style.height = '100%';
        this.style.minHeight = '0';
        this.innerHTML = this.getTemplate();
    }
    disconnectedCallback() {
        this.disconnect();
    }
    async init(store, level) {
        if (this.initialized)
            return;
        this.store = store;
        this.level = level;
        this.lastKnownLevel = level;
        try {
            logger.info(`Chat initializing with level ${level} from presence`);
            const chatConfig = await this.fetchToken();
            if (!chatConfig) {
                logger.info('Chat is disabled on this server (GetStream not configured) — skipping chat.');
                return;
            }
            this.client = StreamChat.getInstance(chatConfig.apiKey);
            this.currentUserId = chatConfig.userId;
            const tokenProvider = async () => {
                logger.info('Token provider: fetching fresh token');
                const freshConfig = await this.fetchToken();
                if (!freshConfig)
                    throw new Error('Chat token unavailable');
                return freshConfig.token;
            };
            await this.client.connectUser({ id: chatConfig.userId }, tokenProvider);
            this.channel = this.client.channel(chatConfig.channelType, chatConfig.channelId);
            await this.channel.watch();
            logger.info(`Watching channel ${chatConfig.channelId}`);
            this.store.subscribe(this);
            this.setupChannelListeners();
            this.initialized = true;
            this.render();
            this.loadMessages();
            if (level <= 1) {
                this.showCommandTip();
            }
        }
        catch (error) {
            logger.error('Failed to initialize chat:', error);
            this.renderError(error instanceof Error ? error.message : 'Unknown error');
        }
    }
    async newData() {
        if (!this.didMyDataSegmentChange())
            return;
        const currentLevel = this.store?.stations.mine?.level;
        if (currentLevel === undefined)
            return;
        logger.info(`Role level changed from ${this.lastKnownLevel} to ${currentLevel}`);
        const wasPromoted = this.lastKnownLevel !== undefined && currentLevel < this.lastKnownLevel;
        this.lastKnownLevel = currentLevel;
        this.level = currentLevel;
        this.updateModerationButtons();
        if (wasPromoted && currentLevel <= 1) {
            this.showCommandTip();
        }
    }
    didMyDataSegmentChange() {
        const currentLevel = this.store?.stations.mine?.level;
        return currentLevel !== undefined && currentLevel !== this.lastKnownLevel;
    }
    get online() {
        return this._online;
    }
    set online(value) {
        this._online = value;
        if (!value) {
            this.classList.add('offline');
        }
        else {
            this.classList.remove('offline');
        }
    }
    getTemplate() {
        return `
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
    render() {
        this.setupInputListeners();
    }
    renderError(message) {
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
    loadMessages() {
        if (!this.channel)
            return;
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer)
            return;
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
        messages.forEach(msg => this.renderMessage(msg));
        this.scrollToBottom();
    }
    renderMessage(msg) {
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer || !this.client)
            return;
        const user = msg.user;
        const rawName = user?.name || user?.callSign || 'Unknown';
        const usernameHtml = this.formatUsername(rawName);
        const timestamp = new Date(msg.created_at || '').toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        const isEdited = msg.message_text_updated_at && msg.message_text_updated_at !== msg.created_at;
        const editedIndicator = isEdited ? '<span class="chat-edited">(edited)</span>' : '';
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
            msg.attachments.forEach((att) => {
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
        if (placeholder)
            placeholder.remove();
        messagesContainer.appendChild(msgEl);
    }
    renderReactions(msg) {
        const reactionCounts = msg.reaction_counts || {};
        const ownReactions = (msg.own_reactions || []);
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
    setupChannelListeners() {
        if (!this.channel)
            return;
        this.channel.on('message.new', this.handleNewMessage.bind(this));
        this.channel.on('message.deleted', this.handleDeletedMessage.bind(this));
        this.channel.on('message.updated', this.handleUpdatedMessage.bind(this));
        this.channel.on('reaction.new', this.handleReactionUpdate.bind(this));
        this.channel.on('reaction.deleted', this.handleReactionUpdate.bind(this));
    }
    setupInputListeners() {
        const sendBtn = this.querySelector('.chat-send-btn');
        const textInput = this.querySelector('.chat-text-input');
        const fileInput = this.querySelector('.chat-file-input');
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
            const file = e.target.files?.[0];
            if (file) {
                void this.sendImage(file);
                e.target.value = '';
            }
        });
        emojiBtn?.addEventListener('click', e => {
            e.stopPropagation();
            emojiPickerWrapper?.classList.toggle('show');
        });
        emojiPicker?.addEventListener('emoji-click', (e) => {
            const detail = e.detail;
            if (textInput && detail?.unicode) {
                const start = textInput.selectionStart ?? textInput.value.length;
                const end = textInput.selectionEnd ?? textInput.value.length;
                const unicode = detail.unicode;
                textInput.value = textInput.value.slice(0, start) + unicode + textInput.value.slice(end);
                textInput.selectionStart = textInput.selectionEnd = start + unicode.length;
                textInput.focus();
            }
            emojiPickerWrapper?.classList.remove('show');
        });
        this.documentClickHandler = (e) => {
            if (!emojiPickerWrapper?.contains(e.target) && !emojiBtn?.contains(e.target)) {
                emojiPickerWrapper?.classList.remove('show');
            }
        };
        document.addEventListener('click', this.documentClickHandler);
        this.beforeUnloadHandler = () => this.disconnect();
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
    setupMessageActions(msgEl, messageId, originalText) {
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
                const reactionType = e.currentTarget.dataset['reaction'];
                if (reactionType) {
                    void this.toggleReaction(messageId, reactionType);
                }
                picker.classList.remove('show');
            });
        });
        reactions.forEach(reaction => {
            reaction.addEventListener('click', () => {
                const reactionType = reaction.dataset['reaction'];
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
    handleNewMessage(event) {
        if (event.message) {
            const wasNearBottom = this.isNearBottom();
            this.renderMessage(event.message);
            if (wasNearBottom) {
                this.scrollToBottom();
            }
        }
    }
    handleDeletedMessage(event) {
        if (event.message) {
            const msgEl = this.querySelector(`[data-message-id="${event.message.id}"]`);
            if (msgEl)
                msgEl.remove();
        }
    }
    handleUpdatedMessage(event) {
        if (!event.message)
            return;
        const msgEl = this.querySelector(`[data-message-id="${event.message.id}"]`);
        if (!msgEl)
            return;
        const contentEl = msgEl.querySelector('.chat-message-content');
        if (contentEl && event.message.text) {
            contentEl.innerHTML = `<span class="chat-text">${this.linkifyText(this.escapeHtml(event.message.text))}</span>`;
        }
        const isEdited = event.message.message_text_updated_at && event.message.message_text_updated_at !== event.message.created_at;
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
    handleReactionUpdate(event) {
        if (event.message) {
            const msgEl = this.querySelector(`[data-message-id="${event.message.id}"]`);
            if (msgEl) {
                const reactionsContainer = msgEl.querySelector('.chat-reactions');
                if (reactionsContainer) {
                    reactionsContainer.innerHTML = this.renderReactions(event.message);
                    reactionsContainer.querySelectorAll('.chat-reaction').forEach(reaction => {
                        reaction.addEventListener('click', () => {
                            const reactionType = reaction.dataset['reaction'];
                            if (reactionType && event.message?.id) {
                                void this.toggleReaction(event.message.id, reactionType);
                            }
                        });
                    });
                }
            }
        }
    }
    async sendMessage() {
        if (!this.channel)
            return;
        const textInput = this.querySelector('.chat-text-input');
        const text = textInput?.value.trim();
        if (!text)
            return;
        if (text.startsWith('/')) {
            if (textInput)
                await this.executeSlashCommand(text.slice(1), textInput);
            return;
        }
        try {
            await this.channel.sendMessage({ text });
            if (textInput)
                textInput.value = '';
        }
        catch (error) {
            this.handleSendError(error);
        }
    }
    async executeSlashCommand(cmdLine, textInput) {
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
            const result = (await response.json());
            if (response.ok) {
                if (textInput)
                    textInput.value = '';
                if (result.message) {
                    this.showChatNotice(result.message);
                }
            }
            else {
                this.showChatNotice(result.errorMessage || 'Command failed');
            }
        }
        catch (error) {
            logger.error('Slash command failed:', error);
            this.showChatNotice('Command failed');
        }
    }
    async sendImage(file) {
        if (!this.channel)
            return;
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
        }
        catch (error) {
            this.handleSendError(error);
        }
    }
    async toggleReaction(messageId, reactionType) {
        if (!this.channel)
            return;
        try {
            const message = this.channel.state.messages.find(m => m.id === messageId);
            const ownReactions = (message?.own_reactions || []);
            const existingReaction = ownReactions.find(r => r.type === reactionType);
            if (existingReaction) {
                await this.channel.deleteReaction(messageId, reactionType);
                logger.debug(`Removed ${reactionType} reaction from ${messageId}`);
            }
            else {
                await this.channel.sendReaction(messageId, { type: reactionType });
                logger.debug(`Added ${reactionType} reaction to ${messageId}`);
            }
        }
        catch (error) {
            logger.error('Failed to toggle reaction:', error);
        }
    }
    async deleteMessage(messageId) {
        if (!this.canModerate())
            return;
        try {
            const response = await fetch(`/api/endorse/chat/${this.npid.toString()}/message/${messageId}`, {
                method: 'DELETE'
            });
            if (!response.ok) {
                const data = (await response.json());
                throw new Error(data.errorMessage ?? 'Failed to delete message');
            }
            logger.info(`Deleted message ${messageId}`);
        }
        catch (error) {
            logger.error('Failed to delete message:', error);
        }
    }
    showEditUI(msgEl, messageId, originalText) {
        const contentEl = msgEl.querySelector('.chat-message-content');
        if (!contentEl)
            return;
        if (msgEl.querySelector('.chat-edit-input'))
            return;
        const originalHtml = contentEl.innerHTML;
        contentEl.innerHTML = `
            <input type="text" class="chat-edit-input" value="${this.escapeHtml(originalText)}" maxlength="500">
            <div class="chat-edit-actions">
                <button class="chat-edit-save">Save</button>
                <button class="chat-edit-cancel">Cancel</button>
            </div>
        `;
        const input = contentEl.querySelector('.chat-edit-input');
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
            }
            else if (e.key === 'Escape') {
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
    async editMessage(messageId, newText) {
        if (!this.client)
            return;
        try {
            await this.client.updateMessage({ id: messageId, text: newText });
            logger.info(`Edited message ${messageId}`);
        }
        catch (error) {
            logger.error('Failed to edit message:', error);
            this.showChatNotice('Failed to edit message');
        }
    }
    canModerate() {
        return this.level === 0;
    }
    updateModerationButtons() {
        const canMod = this.canModerate();
        const messages = this.querySelectorAll('.chat-message');
        messages.forEach(msgEl => {
            const actionsContainer = msgEl.querySelector('.chat-message-actions');
            if (!actionsContainer)
                return;
            const existingDeleteBtn = actionsContainer.querySelector('.chat-delete-btn');
            if (canMod && !existingDeleteBtn) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'chat-action-btn chat-mod-btn chat-delete-btn';
                deleteBtn.title = 'Delete message';
                deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
                deleteBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const messageId = msgEl.dataset['messageId'];
                    if (messageId && confirm('Delete this message?')) {
                        void this.deleteMessage(messageId);
                    }
                });
                actionsContainer.appendChild(deleteBtn);
            }
            else if (!canMod && existingDeleteBtn) {
                existingDeleteBtn.remove();
            }
        });
    }
    async fetchToken() {
        const response = await fetch(`/api/endorse/chat/${this.npid.toString()}`);
        if (!response.ok) {
            throw new Error(`Failed to get chat token: ${response.statusText}`);
        }
        const data = (await response.json());
        if (data.message && data.message.enabled === false) {
            return null;
        }
        if (!isChatTokenResponse(data.message)) {
            throw new Error('Invalid chat token response from server');
        }
        return data.message;
    }
    isNearBottom() {
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer)
            return true;
        const { scrollHeight, scrollTop, clientHeight } = messagesContainer;
        if (scrollHeight <= clientHeight)
            return true;
        const threshold = 150;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        return distanceFromBottom < threshold;
    }
    scrollToBottom() {
        const messagesContainer = this.querySelector('.chat-messages');
        if (messagesContainer) {
            requestAnimationFrame(() => {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            });
        }
    }
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    formatUsername(rawName) {
        const match = rawName.match(/^(.+)\(([^)]+)\)$/);
        if (match && match[1] && match[2]) {
            return `${this.escapeHtml(match[1])}<span class="chat-callsign">(${this.escapeHtml(match[2])})</span>`;
        }
        return this.escapeHtml(rawName);
    }
    handleSendError(error) {
        const streamError = error;
        if (streamError.code === 17) {
            this.showChatNotice('You are currently unable to send messages in this chat.');
            logger.info('User attempted to send message while banned/muted');
        }
        else {
            logger.error('Failed to send message:', error);
        }
    }
    showCommandTip() {
        if (prefs.chatCommandTipDismissed)
            return;
        const chatWidget = this.querySelector('.chat-widget');
        if (!chatWidget)
            return;
        if (this.querySelector('.command-tip'))
            return;
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
        chatWidget.insertBefore(tip, chatWidget.firstChild);
        const dismissBtn = tip.querySelector('.tip-dismiss');
        dismissBtn?.addEventListener('click', () => {
            prefs.chatCommandTipDismissed = true;
            tip.remove();
        });
    }
    showChatNotice(message) {
        const messagesContainer = this.querySelector('.chat-messages');
        if (!messagesContainer)
            return;
        const existingNotice = this.querySelector('.chat-notice');
        if (existingNotice)
            existingNotice.remove();
        const notice = document.createElement('div');
        notice.className = 'chat-notice';
        notice.style.cssText =
            'background: #3a4a5c; color: var(--hl-light); padding: 8px 12px; font-size: 13px; border-left: 3px solid var(--hl-secondary); margin: 4px 0;';
        notice.textContent = message;
        messagesContainer.appendChild(notice);
        this.scrollToBottom();
        setTimeout(() => notice.remove(), 8000);
    }
    disconnect() {
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
    linkifyText(text) {
        const urlPattern = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
        return text.replace(urlPattern, url => {
            const href = url.startsWith('www.') ? `https://${url}` : url;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color: var(--hl-success);">${url}</a>`;
        });
    }
    static init(store, level) {
        customElements.define('hl-chat', ChatWidget);
        const container = document.getElementById('stream-chat-container');
        if (container && serverInfo.chat) {
            const widget = document.createElement('hl-chat');
            widget.className = container.className;
            container.replaceWith(widget);
            void widget.init(store, level);
        }
    }
}
export { ChatWidget as ChatClient };
//# sourceMappingURL=chat.js.map