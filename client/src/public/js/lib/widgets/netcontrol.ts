/* hamlive-oss — MIT License. See LICENSE. */

import { createLogger } from '#@client/lib/logger.js';
import { UserAgentPersistentPreferences, getIconSvg, Looper } from '#@client/lib/clientUtils.js';
import { LiveNetReactiveStore } from '#@client/lib/stores.js';
import { isEndPointResponseError } from '#@client/types/commonTypesupport.js';
import { LiveNetElement, NetControlMember, EncapsulationMode } from './base.js';
import { serverInfo } from '#@client/lib/serverInfo.js';

const logger = createLogger('lib/widgets/netcontrol.ts');
const prefs = new UserAgentPersistentPreferences();

type ProgressBarStates = 'PENDING_START' | 'NORMAL_START' | 'ABNORMAL_START';

export class NetStartProgress extends LiveNetElement {
    private defaultIntervalMs: number = 500;
    private _width: number = 0;
    private _state: ProgressBarStates = 'PENDING_START';
    private readonly mainLooper = new Looper(this.defaultIntervalMs, this.constructor.name);

    constructor() {
        super(EncapsulationMode.Open);
    }

    private set width(value: number) {
        if (value < 0 || value > 100) {
            throw new Error('Width must be between 0 and 100');
        }
        this._width = value;
        this.renderBarWidth(value);
    }

    private get width(): number {
        return this._width;
    }

    private set state(value: ProgressBarStates) {
        this._state = value;
        this.renderBarStyle();
    }

    private get state(): ProgressBarStates {
        return this._state;
    }

    private gracePeriodPercentComplete(createdAt: Date, gracePeriodMinutes: number, started: boolean = false): number {
        if (started || gracePeriodMinutes === 0) {
            return 100;
        }

        const elapsed = (Date.now() - createdAt.getTime()) / 1000 / 60;
        return Math.min(Math.floor((elapsed / gracePeriodMinutes) * 100), 100);
    }

    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                background-color: var(--hl-quaternary);
                height: 4px;
            }
            #${this.defaultElementId} .progress-bar {
                width: ${this.width}%;
                height: 4px;
            }
        </style>

        <div class="progress" id="${this.defaultElementId}">
            <div class="progress-bar progress-bar-striped progress-bar-animated bg-danger" role="progressbar"></div>
        </div>
    `;
    }

    private renderBarWidth(value: number): void {
        this.root.querySelector('.progress-bar')?.setAttribute('style', `width: ${value}%`);
    }

    private renderBarStyle(): void {
        const progressBar = this.root.querySelector('.progress-bar') as HTMLElement;
        if (!progressBar) {
            throw new Error('Progress bar element is not defined in widget, renderBarStyle()');
        }

        progressBar.className = 'progress-bar'; // Reset classes

        switch (this.state) {
            case 'PENDING_START':
                progressBar.classList.add('bg-danger', 'progress-bar-striped', 'progress-bar-animated');
                break;
            case 'NORMAL_START':
                progressBar.classList.add('bg-danger');
                break;
            case 'ABNORMAL_START':
                progressBar.classList.add('bg-warning', 'progress-bar-striped', 'progress-bar-animated');
                break;
            default:
                throw new Error('Invalid state in widget, renderBarStyle()');
        }
    }

    protected didMyDataSegmentChange(): boolean {
        return this.store?.mainCache?.net?.started ?? false;
    }

    protected render(): void {
        this.renderBarStyle();
    }

    private startMainLooper(): void {
        this.mainLooper.start(async loopStats => {
            const { ttlMs, net } = this.store?.mainCache ?? {};
            const { countdownTimer: gracePeriodMinutes, started } = net ?? {};
            let { createdAt } = this.store?.mainCache?.net ?? {};
            if (gracePeriodMinutes === undefined || !createdAt) return;

            if (!(createdAt instanceof Date)) {
                createdAt = new Date(createdAt);
            }

            const pct = this.gracePeriodPercentComplete(createdAt, gracePeriodMinutes, started);

            if (this.state === 'PENDING_START' && pct % 10 === 0) {
                logger.info(`Net-start grace period is ${pct}% completed`);
            }

            if (started) {
                this.mainLooper.stop();
                this.state = 'NORMAL_START';
            } else if (pct === 100) {
                const slowIntervalMs = (ttlMs ?? 10000) * 2;

                if (this.state === 'PENDING_START') {
                    if (loopStats.interval === slowIntervalMs) {
                        //in prior loop, interval was set to slow, to allow for backend to update
                        //net-start status. It appears that the net-start status is still pending.
                        //so lets signal that we are in an abnormal start state.
                        this.state = 'ABNORMAL_START';
                        //while in abnormal start stats, lets check for backend start at the faster (default) interval
                        this.mainLooper.setInterval(this.defaultIntervalMs);
                    } else {
                        //first time we have hit 100% so lets slow down the loop to give the backend
                        //a chance to update the net-start status.
                        //the slow interval only happens once.
                        this.mainLooper.setInterval(slowIntervalMs);
                    }
                }
            }

            this.width = pct;
        });
    }

    protected onConnected(): void {
        this.startMainLooper();
    }

    protected onDisconnected(): void {}

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netstart-progress', NetStartProgress, store);
    }
}

export class NetControlUsage extends NetControlMember {
    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} .command-label {
                color: var(--hl-light);
                font-weight: 600;
            }
            #${this.defaultElementId} .optional {
                font-style: italic;
                color: var(--hl-tertiary);

            }
            #${this.defaultElementId} .argument {
                color: var(--hl-secondary);
                font-family: monospace;
                font-weight: 400;
            }
            #${this.defaultElementId} {
                display: flex;        
                justify-content: flex-start;
                align-items: center;
            }
            #${this.defaultElementId} .expandIconContainer {
                display: flex;
                justify-content: center;
                cursor: pointer;
            }
            #${this.defaultElementId} .headerAndTextContainer {
                display: flex; /* This is what we'll toggle with JS */
                flex-direction: column;
                justify-content: center;
                align-items: center;            
            }
            #${this.defaultElementId} svg {
                display: block;
                padding-right: 10px;
                width: 1.20em; 
                height: 1.20em;
            }
            #${this.defaultElementId} code {
                font-family: monospace;
                font-weight: 400;
                white-space: nowrap;
                color: var(--hl-secondary);
            }
            #${this.defaultElementId} img {
                cursor: pointer;
                width: 75%;
            }
        </style>
        <div id="${this.defaultElementId}">
            <div class="expandIconContainer">
                <span class="expandedIcon hideOnCollapse" role="button" tabindex="0" aria-label="Hide usage text">
                    <span aria-hidden="true">${getIconSvg('bi-dash-circle')}</span>
                </span>
                <span class="collapsedIcon d-none hideOnExpand" role="button" tabindex="0" aria-label="Show usage text">
                    <span aria-hidden="true">${getIconSvg('bi-plus-circle')}</span>
                </span>
            </div>
            <div class="headerAndTextContainer">
                <div class="usage-header hideOnCollapse">
                    <img src="/img/cheat-sheet-dark.png" alt="Open command documentation cheat sheet" />
                </div>
                <div class="help-cmd d-none hideOnExpand" aria-live="polite">
                    ${this.formatUsage('help: ? [ <command> ]')}
                </div>
                <div class="usage-text hideOnCollapse" aria-label="Command usage help">
                    <!-- Usage will be injected here -->
                </div>                
            </div>     
        </div>
    `;
    }

    private collapse(value: boolean, save = true) {
        if (save) prefs.usageCollapsed = value;

        if (value) {
            this.root.querySelectorAll('.hideOnCollapse').forEach(element => element.classList.add('d-none'));
            this.root.querySelectorAll('.hideOnExpand').forEach(element => element.classList.remove('d-none'));
        } else {
            this.root.querySelectorAll('.hideOnCollapse').forEach(element => element.classList.remove('d-none'));
            this.root.querySelectorAll('.hideOnExpand').forEach(element => element.classList.add('d-none'));
        }
    }

    private toggleExpandCollapse = (): void => {
        this.collapse(!prefs.usageCollapsed);
    };

    private handleCommandHelpClick = (): void => {
        const { cmdHelpUrl } = serverInfo;
        if (cmdHelpUrl) {
            window.open(cmdHelpUrl, '_blank');
        }
    };

    protected didMyDataSegmentChange(): boolean {
        return this.didMyStatusChange();
    }

    protected formatUsage(text: string): string {
        const commands = text.split(', ');
        const formattedCommands = commands.map(command => {
            const [label, usage] = command.split(': ');
            const formattedLabel = `<span class="command-label">${label}</span>`;

            if (!usage) {
                return formattedLabel; // or handle the case where usage is undefined
            }

            let formattedUsage = usage
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\[([^\]]+)\]/g, '<span class="optional">[$1]</span>')
                .replace(/&lt;([^&]+)&gt;/g, '<span class="argument">&lt;$1&gt;</span>');
            formattedUsage = `<code>${formattedUsage}</code>`;
            return `${formattedLabel}: ${formattedUsage}`;
        });
        return formattedCommands.join(', ');
    }

    protected render(): void {
        this.cmd
            .usageText()
            .then(text => {
                const usageTextElement = this.root.querySelector('.usage-text') as HTMLElement;
                if (!usageTextElement) {
                    throw new Error('Usage text element is not defined in widget, render()');
                }

                usageTextElement.innerHTML = this.formatUsage(text);
            })
            .catch(error => {
                logger.error(`Error getting command list in widget: ${error}`);
            });
    }

    protected onConnected(): void {
        if (window.innerWidth < 768) {
            // If the screen is small, collapse the usage text temporarily
            this.collapse(true, false);
        } else {
            this.collapse(prefs.usageCollapsed);
        }

        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onConnected()`);
            return;
        }

        const expandIconContainer = this.defaultElement.querySelector('.expandIconContainer');
        if (expandIconContainer) {
            expandIconContainer.addEventListener('click', this.toggleExpandCollapse);
        }

        const imgElement = this.defaultElement.querySelector('img');
        if (imgElement) {
            imgElement.addEventListener('click', this.handleCommandHelpClick);
        }
    }

    protected onDisconnected(): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onDisconnected()`);
            return;
        }

        const expandIconContainer = this.defaultElement.querySelector('.expandIconContainer');
        if (expandIconContainer) {
            expandIconContainer.removeEventListener('click', this.toggleExpandCollapse);
        }

        const imgElement = this.defaultElement.querySelector('img');
        if (imgElement) {
            imgElement.removeEventListener('click', this.handleCommandHelpClick);
        }
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netcontrol-usage', NetControlUsage, store);
    }
}

export class NetControlForm extends NetControlMember {
    protected getTemplate(): string {
        return /*html*/ `
    <style>
        /* Style for the response container */
        #${this.defaultElementId} .response {
            margin-top: .75em; /* Add some space above the response */
            display: flex;
            width: 100%; /* Use 100% of the parent's width */
            justify-content: space-between; /* Space out the children */
            align-items: center; /* Center align the items vertically */
            position: relative; /* Make it a positioned element for the overlay */
            
        }

        /* Style for the overlay */
        #${this.defaultElementId} .response .overlay {
            position: absolute; /* Position it absolutely within the response div */
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1; /* Ensure it is above the response text */
            border-radius: 6px;
            background: var(--hl-response-status-overlay);
        }

        #${this.defaultElementId} .response .overlay.error {
            background: linear-gradient(
                135deg,
                rgba(243, 29, 82, 0.15) 0%,
                rgba(0, 0, 0, 0.2) 50%,
                rgba(243, 29, 82, 0.15) 100%
            );
            border: 1px solid rgba(243, 29, 82, 0.3);
        }

        #${this.defaultElementId} .response .overlay.success {
            background: linear-gradient(
                135deg,
                rgba(60, 206, 60, 0.15) 0%,
                rgba(0, 0, 0, 0.2) 50%,
                rgba(60, 206, 60, 0.15) 100%
            );
            border: 1px solid rgba(60, 206, 60, 0.3);
        }

        /* Center the response text and allow it to take up the available space */
        #${this.defaultElementId} .response .response-text {
            text-align: center; /* Center the text */
        }

        /* Style for the input within the form */
        #${this.defaultElementId} input[type="text"] {
            border-radius: 5px;
            box-sizing: border-box; /* Include padding and border in the element's size */
            background-color: black; /* Set the background color to black */
            color: var(--hl-light); /* Set the text color */
            font-size: 1.20em; /* Set the font size */
            font-style: italic; /* Set the font style to italic */
            border: none; /* Remove default border */
            width: 100%; /* Use 100% of the parent's width */
            padding: 8px; /* Add some padding inside the input */
            border: 1px solid transparent; /* Set initial border to transparent */
            transition: border 0.4s; /* Add transition for border */            
        }
        /* Style for the placeholder text */
        #${this.defaultElementId} input[type="text"]::placeholder {
            color: var(--hl-tertiary); /* Color for the placeholder text */
        }
        #${this.defaultElementId} input[type="text"]:focus {
            border: 1px solid var(--hl-light); /* Change the border color */
            outline: none; /* Remove the default outline */
        }
        #${this.defaultElementId} .brace {
            display: inline-block;
            padding: 0 5px;
        }
        #${this.defaultElementId} .brace.open {
            margin-right: 10px;
        }
        #${this.defaultElementId} .brace.close {
            margin-left: 10px;
        }
    </style>
    <div id="${this.defaultElementId}">   
        <form>
            <label for="cmdLine" class="d-none">Command prompt</label>
            <input type="text" id="cmdLine" aria-label="Command Prompt">
        </form>
        <div class="response">
            <div class="overlay"></div>
            <span class="brace open">{</span>
            <code class="response-text"></code>
            <span class="brace close">}</span>
        </div>
    </div>
    `;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.didMyStatusChange();
    }

    protected render(onConnected: boolean): void {
        if (onConnected) {
            return;
        }

        const input = this.root.querySelector('#cmdLine') as HTMLInputElement;
        if (!input) {
            throw new Error('Input element is not defined in widget, render()');
        }

        let prompt = '';

        if (this.iAmCheckedInAdmin) {
            input.disabled = false;
            input.focus();

            if (!this.store?.stations.mine) {
                throw new Error('My station is not defined in widget, render()');
            }

            const { level } = this.store?.stations.mine;

            if (this.store?.stations.mine) {
                prompt = `${level === 0 ? '☆' : ''}>`;
            }

            input.placeholder = prompt;
        } else {
            input.placeholder = 'X>';
            input.disabled = true;
        }
    }

    public applyFocus() {
        const input = this.root.querySelector('#cmdLine') as HTMLInputElement;
        if (!input) {
            throw new Error('Input element is not defined in widget, focus()');
        }
        input.focus();
    }

    protected respond(response: string, type?: 'error' | 'success'): void {
        const responseText = this.root.querySelector('.response-text') as HTMLElement;
        if (!responseText) {
            throw new Error('Response element is not defined in widget, respond()');
        }

        // Set aria-live according to type
        if (type === 'error') {
            responseText.setAttribute('aria-live', 'assertive');
        } else {
            responseText.setAttribute('aria-live', 'polite');
        }

        responseText.textContent = response;

        const overlay = this.root.querySelector('.overlay') as HTMLElement;
        if (!overlay) {
            throw new Error('Overlay element is not defined in widget, respond()');
        }

        overlay.classList.remove('error', 'success');

        if (type === 'error') {
            overlay.classList.add('error');
        } else if (type === 'success') {
            overlay.classList.add('success');
        }
    }

    protected onConnected(): void {
        this.defaultElement?.querySelector('form')?.addEventListener('submit', e => {
            e.preventDefault();
            const input = this.defaultElement?.querySelector('input') as HTMLInputElement;
            if (!input) {
                throw new Error('Input element is not defined in widget, onConnected()');
            }

            if (!this.store) {
                throw new Error('Store is not defined in widget, onConnected()');
            }

            const { value } = input;
            if (!value) {
                return;
            }

            input.value = '';

            this.respond('processing...');

            this.cmd
                .exec(value.trim())
                .then(response => {
                    this.respond(response.message, 'success');
                })
                .catch(error => {
                    input.value = value;

                    if (isEndPointResponseError(error)) {
                        this.respond(error.message, 'error');
                    } else {
                        if (error instanceof Error) {
                            if (error.message === 'Failed to fetch') {
                                this.respond('Network error', 'error');
                            } else {
                                this.respond(error.message, 'error');
                            }
                        }
                        logger.error(`Error executing command in widget: ${error}`);
                    }
                });
        });
    }
    protected onDisconnected(): void {}

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netcontrol-form', NetControlForm, store);
    }
}

export class NetControlPanel extends NetControlMember {
    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                display: none;
                width: 92%;
                flex-direction: column;
                position: absolute; /* Position it absolutely */
                top: 0px; /* Adjust as needed */
                left: 50%; /* Center It */
                transform: translateX(-50%); /* Offset by half its width */
                background: var(--hl-quaternary);
                border: 1px solid rgba(220, 131, 53, 0.25);
                border-radius: 8px;
                padding: 1em;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                z-index: 1000; /* Ensure it is above other elements */
                opacity: 0; /* Start hidden */
                transition: opacity .25s ease-in-out; /* Fade transition */
            }
            #${this.defaultElementId}.visible {
                opacity: 1; /* Fade in */
            }
            #${this.defaultElementId} .close-button {
                color: var(--hl-light);
                position: absolute;
                top: 10px;
                right: 10px;
                background: none;
                border: none;
                cursor: pointer;
            }
            #${this.defaultElementId} .close-button svg {
                width: 1.5em; 
                height: 1.5em;
            }
            #${this.defaultElementId} hl-netcontrol-usage {
                margin: 5px 0;
            }
            @media (min-width: 768px) {
                #${this.defaultElementId} hl-netcontrol-usage {                    
                    margin: 10px 0;
                }
                #${this.defaultElementId} {
                    width: 75%;
                }
            }
            @media (min-width: 992px) {
                #${this.defaultElementId} hl-netcontrol-usage {                    
                    margin: 12px 0;
                }
                #${this.defaultElementId} {
                    width: 60%;
                }
            }
            @media (min-width: 1200px) {
                #${this.defaultElementId} hl-netcontrol-usage {                    
                    margin: 15px 0;
                }
                #${this.defaultElementId} {
                    width: 40%;
                }
            }

        </style>
        <div id="${this.defaultElementId}">

            <div>✋: <em><hl-state-list group="hand-up"></hl-state-list></em></div>


            <hl-netcontrol-usage></hl-netcontrol-usage>
            <hl-netcontrol-form></hl-netcontrol-form>

            <button class="close-button" aria-label="close control panel">${getIconSvg('bi-x-circle-fill')}</button>
        </div>
    `;
    }

    public open(): void {
        if (this.isOpen) {
            return;
        }

        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, open()');
        }

        this.defaultElement.style.display = 'flex';

        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, open()');
        }
        this.defaultElement.classList.add('visible');

        this.applyFocus();
    }

    public close(): void {
        if (!this.isOpen) {
            return;
        }

        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, close()');
        }

        this.defaultElement.classList.remove('visible');
        this.defaultElement.addEventListener(
            'transitionend',
            () => {
                if (!this.defaultElement) {
                    throw new Error('Default element is not defined in widget, close()');
                }
                this.defaultElement.style.display = 'none';
            },
            { once: true }
        );
    }

    private get isOpen(): boolean {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, isOpen()');
        }

        return this.defaultElement.classList.contains('visible');
    }

    public toggle(): void {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    protected didMyDataSegmentChange(): boolean {
        return this.didMyStatusChange();
    }

    protected render(onConnected: boolean): void {
        if (onConnected) {
            return;
        }

        if (this.iAmCheckedInAdmin) {
            this.open();
        } else {
            this.close();
        }
    }

    public applyFocus(): void {
        const form = this.defaultElement?.querySelector('hl-netcontrol-form') as NetControlForm;
        if (!form) {
            throw new Error('Form element is not defined in widget, applyFocus()');
        }
        form.applyFocus();
    }

    protected onConnected(): void {
        this.defaultElement?.querySelector('.close-button')?.addEventListener('click', () => this.close());
    }
    protected onDisconnected(): void {
        this.defaultElement?.querySelector('.close-button')?.removeEventListener('click', () => this.close());
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netcontrol-panel', NetControlPanel, store);
    }
}

export class NetControlButton extends NetControlMember {
    protected netControlPanelElement: NetControlPanel | null = null;
    private label = ['Net', 'Logger', 'Relay', 'User'] as const;

    constructor() {
        super(EncapsulationMode.Open);
    }

    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                background: linear-gradient(135deg, 
                    rgba(220, 131, 53, 0.15) 0%, 
                    rgba(220, 131, 53, 0.25) 100%
                );
                border: 1px solid rgba(220, 131, 53, 0.4);
                color: var(--hl-light);
                border-radius: 20px;
                padding: 4px 16px;
                font-size: 0.85rem;
                transition: all 0.2s ease;
            }
            #${this.defaultElementId}:hover {
                background: linear-gradient(135deg, 
                    rgba(220, 131, 53, 0.25) 0%, 
                    rgba(220, 131, 53, 0.35) 100%
                );
                border-color: rgba(220, 131, 53, 0.6);
                box-shadow: 0 0 8px rgba(220, 131, 53, 0.3);
            }
        </style>

        <button id="${this.defaultElementId}" class="btn btn-sm fade-in d-none" type="button">               
            <slot></slot>
        </button>
    `;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.didMyStatusChange();
    }

    protected render(onConnected: boolean): void {
        if (onConnected) {
            return;
        }

        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }

        if (!this.store?.stations) {
            logger.warn(`Store is not defined in ${this.constructor.name}, render()`);
            return;
        }

        const { mine } = this.store.stations;

        if (!mine) {
            logger.warn(
                `My station is not defined in ${this.constructor.name}, render(). Waiting for initial response from /presence?`
            );
            return;
        }

        if (!this.netControlPanelElement) {
            this.netControlPanelElement = document.querySelector('hl-netcontrol-panel') as NetControlPanel;
        }

        if (this.iAmCheckedInAdmin) {
            this.defaultElement.textContent = `${this.label[mine.level]} Control Panel`;
            this.defaultElement.classList.remove('d-none');
        } else {
            this.defaultElement.classList.add('d-none');
        }
    }

    private handleClick = (): void => {
        if (!this.netControlPanelElement) {
            throw new Error('Net Control Panel is not defined in widget, render()');
        }
        this.netControlPanelElement.toggle();
    };

    protected onConnected(): void {
        this.addEventListener('click', this.handleClick);
    }

    protected onDisconnected(): void {
        this.removeEventListener('click', this.handleClick);
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netcontrol-button', NetControlButton, store);
    }
}
