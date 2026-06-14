import { createLogger } from '#@client/lib/logger.js';
import { getIconSvg, getNpid } from '#@client/lib/clientUtils.js';
import { LiveNetElement, EncapsulationMode } from './base.js';
const logger = createLogger('lib/widgets/utils.ts');
export class NetworkStatus extends HTMLElement {
    updateOnlineStatus = () => {
        document.body.classList.toggle('offline', !navigator.onLine);
    };
    connectedCallback() {
        this.updateOnlineStatus();
        window.addEventListener('online', this.updateOnlineStatus);
        window.addEventListener('offline', this.updateOnlineStatus);
    }
    disconnectedCallback() {
        window.removeEventListener('online', this.updateOnlineStatus);
        window.removeEventListener('offline', this.updateOnlineStatus);
    }
    static init() {
        customElements.define('hl-network-status', NetworkStatus);
    }
}
export class StatsTable extends HTMLElement {
    constructor() {
        super();
        try {
            const shadowRoot = this.attachShadow({ mode: 'closed' });
            shadowRoot.innerHTML = this.getTemplate();
        }
        catch (error) {
            logger.error('Failed to attach shadow root:', error);
        }
    }
    getTemplate() {
        return `
            <style>
            :host {
                --hl-primary-dark: #9e5f26; /* Darkened by 10% */
                --hl-secondary-dark: #4f868b; /* Darkened by 10% */
                --hl-tertiary-dark: #754f8f; /* Darkened by 10% */
                --hl-success-dark: #2b922b; /* Darkened by 10% */
            }
            .stats-container {
                border-radius: 8px;
                border: 1px solid rgba(163, 118, 195, 0.2);
                padding: 8px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                border-radius: 25px/8px; /* Apply elliptical border-radius to the table */
                overflow: hidden; /* Ensure rounded corners are visible */
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); /* Add a subtle shadow */
            }
            .label-cell {
                border-radius: 25px/8px;
            }
            td {
                white-space: nowrap;
                max-height: 2rem;
                font-size: 1rem;
                padding: 0.5rem;
                vertical-align: middle; 
            }
            .bg-secondary {
                background: radial-gradient(circle at top left, rgba(79, 134, 139, 0.6), rgba(110, 184, 192, 0.4));
            }
            .bg-tertiary {
                background: radial-gradient(circle at top left, rgba(117, 79, 143, 0.6), rgba(163, 118, 195, 0.4));
            }
            .bg-success {
                background: radial-gradient(circle at top left, rgba(43, 146, 43, 0.6), rgba(60, 206, 60, 0.4));
            }
            .bg-primary {
                background: radial-gradient(circle at top left, rgba(158, 95, 38, 0.6), rgba(220, 131, 53, 0.4));
            }
            .text-secondary {
                color: var(--hl-secondary-dark);
            }
            .text-tertiary {
                color: var(--hl-tertiary-dark);
            }
            .text-success {
                color: var(--hl-success-dark);
            }
            .text-primary {
                color: var(--hl-primary-dark);
            }
            .icon {
                margin-right: 0.5rem;
                vertical-align: middle; /* Align icons vertically with text */
            }
            </style>
            <div class="stats-container">
                <table>
                <tr>
                    <td class="bg-secondary label-cell">                        
                    <span class="opaque">${getIconSvg('bi-mic-fill')} NCS<span>
                    </td>
                    <td class="text-secondary">
                    <em>
                        <slot name="ncs"></slot>
                    </em>
                    </td>
                </tr>
                <tr>
                    <td class="bg-tertiary label-cell">                    
                    ${getIconSvg('bi-journal-check')} Logger:
                    </td>
                    <td class="text-tertiary">
                    <em>
                        <slot name="loggers"></slot>
                    </em>
                    </td>
                </tr>
                <tr>
                    <td class="bg-success label-cell">
                    ${getIconSvg('bi-intersect')} Relays:
                    </td>
                    <td class="text-success">
                    <em>
                        <slot name="relays"></slot>
                    </em>
                    </td>
                </tr>
                <tr>
                    <td class="bg-primary label-cell">                        
                    ${getIconSvg('bi-person-check')} Count:
                    </td>
                    <td class="text-primary">
                    <em>
                        <slot name="count"></slot>
                    </em>
                    </td>
                </tr>
                </table>
            </div>
        `;
    }
    static init() {
        customElements.define('hl-stats-table', StatsTable);
    }
}
export class ButtonBar extends LiveNetElement {
    tooltipInstances = new Map();
    constructor() {
        super(EncapsulationMode.Open);
    }
    wrapWithButton(element) {
        const button = document.createElement('button');
        button.classList.add('btn', 'btn-outline-primary', 'hasToolTip');
        button.type = 'button';
        button.setAttribute('data-bs-toggle', 'tooltip');
        button.setAttribute('data-bs-placement', 'bottom');
        button.setAttribute('title', element.toolTipText);
        button.setAttribute('aria-label', element.toolTipText);
        button.appendChild(element);
        const tooltipInstance = new window.bootstrap.Tooltip(button);
        button.addEventListener('click', event => {
            if (event.target === button) {
                event.stopPropagation();
                const customEvent = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
                element.dispatchEvent(customEvent);
            }
            tooltipInstance.hide();
        });
        this.tooltipInstances.set(button, tooltipInstance);
        return button;
    }
    getTemplate() {
        return `
        <style>
            /* Add your component styles here */
             #${this.defaultElementId} {                
                height: 38px;
                padding: 0 8px;
                border-radius: 8px;
                border: 1px solid rgba(220, 131, 53, 0.2);
                color: inherit;
            }
            #${this.defaultElementId} .btn {
                background: transparent;
                border: none;
                border-radius: 0;
            }
            #${this.defaultElementId} .btn:not(:last-child) {
                border-right: 1px solid rgba(240, 238, 222, 0.15);
            }
            #${this.defaultElementId} .btn:hover {
                background: rgba(220, 131, 53, 0.15);
            }
        </style>
        <div id="${this.defaultElementId}" class="btn-group" role="group" aria-label="Station Actions">                
        </div>
    `;
    }
    didMyDataSegmentChange() {
        return this.store?.version === 1;
    }
    render(onConnected) {
        if (onConnected) {
            const autoScrollElem = document.createElement('hl-autoscroll-insert');
            const handElem = document.createElement('hl-hand-insert');
            this.defaultElement?.appendChild(this.wrapWithButton(autoScrollElem));
            this.defaultElement?.appendChild(this.wrapWithButton(handElem));
        }
        else if (!this.store?.mainCache?.net.permanent) {
            logger.debug('This net is not permanent, adding favorite insert button');
            const favElem = document.createElement('hl-fav-insert');
            favElem.npid = getNpid();
            this.defaultElement?.appendChild(this.wrapWithButton(favElem));
        }
    }
    onConnected() { }
    onDisconnected() {
        this.tooltipInstances.forEach(tooltipInstance => {
            tooltipInstance.dispose();
        });
        this.tooltipInstances.clear();
    }
    static async init(store) {
        await this.initElement('button-bar', ButtonBar, store);
    }
}
export class HandInsert extends LiveNetElement {
    toolTipText = 'Raise/Lower Your Hand';
    getTemplate() {
        return `
        <style>
        </style>

        <span id="${this.defaultElementId}"></span>
    `;
    }
    didMyDataSegmentChange() {
        return this.store?.stations.haveMyStationPropertiesChanged(['hand']) ?? false;
    }
    getIcon() {
        return this.store?.stations.mine?.hand ? '👊' : '✋';
    }
    toggleState = () => {
        logger.debug('Toggling hand state');
        if (!this.isCallSignDefined()) {
            logger.warn('Call sign is not defined in HandInsert widget, toggleState()');
            return;
        }
        const callSign = this.store?.stations.mine?.callSign;
        if (!callSign) {
            logger.warn('Call sign is not defined in HandInsert widget, toggleState()');
            return;
        }
        this.updateHandState(callSign).catch(error => {
            logger.error(`Error updating hand state for ${callSign} in widget: ${error}`);
        });
    };
    isCallSignDefined() {
        return !!this.store?.stations.mine?.callSign;
    }
    async updateHandState(callSign) {
        try {
            await this.hand(callSign, null);
        }
        catch (error) {
            logger.error(`Error updating hand state for ${callSign} in widget: ${String(error)}`);
        }
    }
    render() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, renderIcon()`);
            return;
        }
        if (!this.store?.ready) {
            return;
        }
        this.defaultElement.innerHTML = this.getIcon();
    }
    onConnected() {
        this.addEventListener('click', this.toggleState);
    }
    onDisconnected() {
        this.removeEventListener('click', this.toggleState);
    }
    static async init(store) {
        await this.initElement('hand-insert', HandInsert, store);
    }
}
//# sourceMappingURL=utils.js.map