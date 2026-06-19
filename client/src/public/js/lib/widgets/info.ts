/* hamlive-oss — MIT License. See LICENSE. */

import { createLogger } from '#@client/lib/logger.js';
import { LiveNetReactiveStore, ReadonlyStateGroup } from '#@client/lib/stores.js';
import { NetInfo } from '#@client/types/commonTypes.js';
import { LiveNetElement, StateGroupReport, EncapsulationMode } from './base.js';
import type * as bootstrap from 'bootstrap';

const logger = createLogger('lib/widgets/info.ts');

export class StateList extends StateGroupReport {
    protected getReport(stateGroup: ReadonlyStateGroup): string {
        return Array.from(stateGroup).join(', ');
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('state-list', StateList, store);
    }
}

export class StateCount extends StateGroupReport {
    protected getReport(stateGroup: ReadonlyStateGroup): string {
        return stateGroup.size.toString();
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('state-count', StateCount, store);
    }
}

export class NetNotes extends LiveNetElement {
    private tooltip: bootstrap.Tooltip | null = null;
    private bsCollapse: bootstrap.Collapse | null = null;
    private priorNotes: string = '';
    private priorTitle: string = '';

    constructor() {
        super(EncapsulationMode.Open);
    }

    protected getTemplate(): string {
        return /*html*/ `
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

    protected didMyDataSegmentChange(): boolean {
        return this.hasDataChanged('notes', this.priorNotes) || this.hasDataChanged('title', this.priorTitle);
    }

    protected render(): void {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in render()');
            return;
        }

        this.hasDataChanged('title', this.priorTitle, true) && this.updateTitle();
        this.hasDataChanged('notes', this.priorNotes, true) && this.updateNotes();
    }

    protected onConnected(): void {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in onConnected()');
            return;
        }

        this.tooltip = new window.bootstrap.Tooltip(this.defaultElement);
    }

    protected onDisconnected(): void {
        this.tooltip?.dispose();
        this.tooltip = null;
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netnotes', NetNotes, store);
    }

    protected hasDataChanged(key: 'notes' | 'title', priorValue: string, overwritePrior: boolean = false): boolean {
        if (!this.store?.mainCache) {
            return true;
        }

        const currentValue = this.store.mainCache.net[key];
        const haveChanged = currentValue !== priorValue;
        if (overwritePrior) {
            if (key === 'notes') {
                this.priorNotes = currentValue;
            } else {
                this.priorTitle = currentValue;
            }
        }
        return haveChanged;
    }

    private updateTitle(): void {
        const accordionTitleElem = this.defaultElement?.querySelector('#accordion-title') as HTMLElement;
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

    private updateNotes(): void {
        const notesContentElem = this.defaultElement?.querySelector('#notes-content') as HTMLElement;
        const accordionContainerElem = this.defaultElement?.querySelector('#accordion-container') as HTMLElement;

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
    private priorNetDetails: NetInfo | null = null;

    protected getTemplate(): string {
        return /*html*/ `
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

    protected get netInfoHasChanged(): boolean {
        if (!this.store?.mainCache || !this.priorNetDetails) {
            this.priorNetDetails = this.store?.mainCache?.net ?? null;
            logger.debug(`Apparent first run of ${this.constructor.name}, netInfoHasChanged(). Returning true`);
            return true;
        }

        const hasChanged = this.store.cachePropertyHasChanged('net', this.priorNetDetails);

        if (hasChanged) this.priorNetDetails = this.store?.mainCache?.net ?? null;

        return hasChanged;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.netInfoHasChanged;
    }

    protected render(): void {
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

    private buildFrequencyAndTimeString(net: NetInfo): string {
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
            approximateStartTime = approximateStartTime.replace(/^0/, ''); // Remove leading zero from hours
            freqAndTime += ` @ ${approximateStartTime}`;
        }

        return freqAndTime;
    }

    private calculateApproximateStartTime(
        createdAt: NetInfo['createdAt'],
        countdownTimer: NetInfo['countdownTimer']
    ): string {
        const startTime = new Date(createdAt);
        startTime.setMinutes(startTime.getMinutes() + countdownTimer);
        startTime.setSeconds(0, 0); // Set seconds and milliseconds to 0
        return startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }

    protected onConnected(): void {}
    protected onDisconnected(): void {}

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('netinfo', NetDetails, store);
    }
}
