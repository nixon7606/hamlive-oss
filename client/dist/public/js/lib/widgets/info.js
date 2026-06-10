import { createLogger } from '#@client/lib/logger.js';
import { LiveNetElement, StateGroupReport, EncapsulationMode } from './base.js';
const logger = createLogger('lib/widgets/info.ts');
export class StateList extends StateGroupReport {
    getReport(stateGroup) {
        return Array.from(stateGroup).join(', ');
    }
    static async init(store) {
        await this.initElement('state-list', StateList, store);
    }
}
export class StateCount extends StateGroupReport {
    getReport(stateGroup) {
        return stateGroup.size.toString();
    }
    static async init(store) {
        await this.initElement('state-count', StateCount, store);
    }
}
export class NetNotes extends LiveNetElement {
    tooltip = null;
    bsCollapse = null;
    priorNotes = '';
    priorTitle = '';
    constructor() {
        super(EncapsulationMode.Open);
    }
    getTemplate() {
        return `
        <style>
            /* Be careful here, this is in the light dom */
        </style>
        <div id="${this.defaultElementId}" class="hasToolTip" data-bs-toggle="tooltip" data-bs-placement="top" title="Click For Net Details">
            <div class="accordion accordion-flush" id="notes-accordion">
                <div class="accordion-item">
                    <h2 class="accordion-header">
                    <button class="accordion-button collapsed p-1" type="button" data-bs-toggle="collapse" data-bs-target="#accordion-container">
                        <h3 class="text-light p-2 fst-italic" id="accordion-title" aria-hidden="true"></h3>
                    </button>
                    </h2>
                    <div id="accordion-container" class="accordion-collapse collapse" data-bs-parent="#notes-accordion">
                        <div class="accordion-body font-monospace">
                            <code id="notes-content" class="text-tertiary"></code>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    }
    didMyDataSegmentChange() {
        return this.hasDataChanged('notes', this.priorNotes) || this.hasDataChanged('title', this.priorTitle);
    }
    render() {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in render()');
            return;
        }
        this.hasDataChanged('title', this.priorTitle, true) && this.updateTitle();
        this.hasDataChanged('notes', this.priorNotes, true) && this.updateNotes();
    }
    onConnected() {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in onConnected()');
            return;
        }
        this.tooltip = new window.bootstrap.Tooltip(this.defaultElement);
    }
    onDisconnected() {
        this.tooltip?.dispose();
        this.tooltip = null;
    }
    static async init(store) {
        await this.initElement('netnotes', NetNotes, store);
    }
    hasDataChanged(key, priorValue, overwritePrior = false) {
        if (!this.store?.mainCache) {
            return true;
        }
        const currentValue = this.store.mainCache.net[key];
        const haveChanged = currentValue !== priorValue;
        if (overwritePrior) {
            if (key === 'notes') {
                this.priorNotes = currentValue;
            }
            else {
                this.priorTitle = currentValue;
            }
        }
        return haveChanged;
    }
    updateTitle() {
        const accordionTitleElem = this.defaultElement?.querySelector('#accordion-title');
        if (!accordionTitleElem) {
            logger.warn('Accordion title element is not defined in updateTitle()');
            return;
        }
        if (!this.store?.mainCache) {
            accordionTitleElem.textContent = 'Loading...';
            return;
        }
        const { title } = this.store.mainCache.net;
        accordionTitleElem.textContent = title;
    }
    updateNotes() {
        const notesContentElem = this.defaultElement?.querySelector('#notes-content');
        const accordionContainerElem = this.defaultElement?.querySelector('#accordion-container');
        if (!notesContentElem || !accordionContainerElem) {
            logger.warn('Notes content or accordion container element is not defined in updateNotes()');
            return;
        }
        if (!this.store?.mainCache) {
            notesContentElem.textContent = 'Loading...';
            return;
        }
        const { notes } = this.store.mainCache.net;
        if (!notes || notes === '') {
            notesContentElem.textContent = 'No notes available';
            return;
        }
        notesContentElem.innerHTML = notes;
        this.bsCollapse = new window.bootstrap.Collapse(accordionContainerElem, {
            toggle: false
        });
        if (notes.length && window.innerWidth >= 768 && !this.store.stations.iAmAdmin) {
            this.bsCollapse.show();
            setTimeout(() => {
                this.bsCollapse?.hide();
            }, 9000);
        }
    }
}
export class NetDetails extends LiveNetElement {
    priorNetDetails = null;
    getTemplate() {
        return `
            <style>
                /* Add your component styles here */
            #${this.defaultElementId} {
                color: var(--hl-light);
                white-space: nowrap;

            }         
            </style>
            <span id="${this.defaultElementId}">
            </span>
        `;
    }
    get netInfoHasChanged() {
        if (!this.store?.mainCache || !this.priorNetDetails) {
            this.priorNetDetails = this.store?.mainCache?.net ?? null;
            logger.debug(`Apparent first run of ${this.constructor.name}, netInfoHasChanged(). Returning true`);
            return true;
        }
        const hasChanged = this.store.cachePropertyHasChanged('net', this.priorNetDetails);
        if (hasChanged)
            this.priorNetDetails = this.store?.mainCache?.net ?? null;
        return hasChanged;
    }
    didMyDataSegmentChange() {
        return this.netInfoHasChanged;
    }
    render() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }
        if (!this.store?.mainCache) {
            this.defaultElement.textContent = 'Loading...';
            return;
        }
        const net = this.store.mainCache.net;
        if (!net) {
            logger.warn('No net data in store');
            return;
        }
        this.defaultElement.textContent = this.buildFrequencyAndTimeString(net);
    }
    buildFrequencyAndTimeString(net) {
        const { mode, frequency, modeDetails, permanent, createdAt, countdownTimer } = net;
        let freqAndTime = '';
        switch (mode) {
            case 'CUSTOM':
                freqAndTime = frequency ? `${frequency} ${modeDetails}` : `${modeDetails}`;
                break;
            case 'Reflector':
                freqAndTime = `${modeDetails}`;
                break;
            default:
                freqAndTime = `${frequency} ${mode}${modeDetails ? ` - ${modeDetails}` : ''}`;
                break;
        }
        if (!permanent) {
            let approximateStartTime = this.calculateApproximateStartTime(createdAt, countdownTimer);
            approximateStartTime = approximateStartTime.replace(/^0/, '');
            freqAndTime += ` @ ${approximateStartTime}`;
        }
        return freqAndTime;
    }
    calculateApproximateStartTime(createdAt, countdownTimer) {
        const startTime = new Date(createdAt);
        startTime.setMinutes(startTime.getMinutes() + countdownTimer);
        startTime.setSeconds(0, 0);
        return startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    onConnected() { }
    onDisconnected() { }
    static async init(store) {
        await this.initElement('netinfo', NetDetails, store);
    }
}
export class RoleStats extends LiveNetElement {
    getTemplate() {
        return `
        <style>
            /* Add your component styles here */
        </style>
        <em id="${this.defaultElementId}">
            Count ${this.store?.stations.getGroup('checked-in-ever')?.size ?? 0}
                
        </em>
    `;
    }
    didMyDataSegmentChange() {
        return this.store?.stations.getGroup('checked-in-ever')?.newData ?? false;
    }
    render() {
        logger.debug('RoleStats widget: render()');
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }
        this.defaultElement.textContent = `Count ${this.store?.stations.getGroup('checked-in-ever')?.size ?? 0}`;
    }
    onConnected() { }
    onDisconnected() { }
    static async init(store) {
        await this.initElement('rolestats', RoleStats, store);
    }
}
//# sourceMappingURL=info.js.map