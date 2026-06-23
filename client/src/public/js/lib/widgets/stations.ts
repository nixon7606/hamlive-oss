/* hamlive-oss — MIT License. See LICENSE. */

import { createLogger } from '#@client/lib/logger.js';
import { UserAgentPersistentPreferences, getIconSvg, schedule, SchedulingMethod } from '#@client/lib/clientUtils.js';
import { LiveNetReactiveStore } from '#@client/lib/stores.js';
import { LiveNetElement, StationTableMember } from './base.js';

const logger = createLogger('lib/widgets/stations.ts');
const prefs = new UserAgentPersistentPreferences();

function escapeHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

export class AvatarCell extends StationTableMember {
    private defaultPhoto = '/img/marconi_88x96.jpg';

    private get photoUrl(): string {
        return this.store?.ready ? (this.station?.photo ?? this.defaultPhoto) : this.defaultPhoto;
    }

    private get isOnline(): boolean {
        return this.station?.presence === 'online';
    }

    protected getTemplate(): string {
        return /*html*/ `
        <style>
            @keyframes throb {
                0%, 100% {
                    transform: scale(1);
                }
                50% {
                    transform: scale(1.1);
                }
            }
          .onlinestatus-icon {
                position: absolute;
                top: 63%;
                left: 55%;
                margin: 0;
                opacity: 0; /* Start with icons hidden */
                visibility: hidden; /* Ensure they don't block interaction */
                transition: opacity 1.25s ease-in, visibility 1.25s ease-in;
                font-size: 0.9rem;
            }
            .onlinestatus-icon.visible {
                opacity: 1;
                visibility: visible;
            }
            .onlinestatus-icon.online.visible {
                animation: throb 1.7s infinite;
            }
            .onlinestatus-icon.offline.visible {
                opacity: 0.65;
            }
            .hand-icon {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-125%, -50%);
                margin: 0;
                opacity: 1;
                transition: opacity 0.5s ease-in-out;
                font-size: 1.9rem;   
            }
            .hand-icon.hand-is-down {
                opacity: 0;
            }
            #${this.defaultElementId} {
                display: flex; /* Enable Flexbox */
                align-items: center; /* Center vertically */
                justify-content: center; /* Center horizontally (optional) */ 
                position: relative;

            }
            #${this.defaultElementId} img {
                padding: 10px;
                width: 55px;
                height: 55px;
                border-radius: 50%;
            }

        </style>

        <div id="${this.defaultElementId}">
            <span class="onlinestatus-icon online">🟢</span> <!-- Online Icon -->
            <span class="onlinestatus-icon offline">⚪️</span> <!-- Offline Icon -->
            <span class="hand-icon hand-is-down">✋</span>
            <img referrerPolicy="no-referrer" src="${this.photoUrl}">
        </div>
        `;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.haveThisStationPropertiesChanged(['photo', 'hand', 'presence']);
    }

    protected render(): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }

        // Handle photo change
        this.defaultElement.querySelector('img')!.src = this.photoUrl;

        // Handle hand change
        this.defaultElement.querySelector('.hand-icon')!.classList.toggle('hand-is-down', !this.station?.hand);

        // Handle presence change
        const onlineIconElement = this.defaultElement.querySelector('.onlinestatus-icon.online');
        const offlineIconElement = this.defaultElement.querySelector('.onlinestatus-icon.offline');
        if (!onlineIconElement || !offlineIconElement) {
            logger.warn(`Online status elements are not defined in ${this.constructor.name}, render()`);
            return;
        }

        onlineIconElement.classList.toggle('visible', this.isOnline);
        offlineIconElement.classList.toggle('visible', !this.isOnline);

        this.defaultElementCursorisPointer = Boolean(
            this.iAmStation || (this.store?.stations.iAmAdmin && this.store.stations.iAmCheckedIn)
        );
    }

    protected onConnected(): void {
        this.addEventListener('click', this.handClick);
    }

    protected onDisconnected(): void {
        this.removeEventListener('click', this.handClick);
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('avatarcell', AvatarCell, store);
    }
}

export class CallSignCell extends StationTableMember {
    protected getTemplate = (): string => {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                display: grid;
                align-items: center;
                justify-items: start;
                padding: 10px;
                /* Remaining styles by applyStyling() */
            }
            .inline-icon {
                display: inline-flex;
                align-items: center;
            }
            .inline-icon svg {
                margin-top: 2px;
                margin-left: 5px;
                color: var(--hl-light);
            }
        </style>

        <div id="${this.defaultElementId}">
        </div>
        `;
    };

    protected didMyDataSegmentChange(): boolean {
        return this.haveThisStationPropertiesChanged(['role', 'callSign', 'checkedState', 'presence']);
    }

    protected render(): void {
        if (!this.station) {
            logger.warn(`Station is not defined in ${this.constructor.name}, render()`);
            return;
        }

        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }

        const styling = this.getStyling(this.station);
        const { icon, ...styleProps } = styling;
        this.applyStyling(this.defaultElement, styleProps);

        if (!this.callSign) {
            throw new Error('Call sign is not defined in CallSignCell widget, render()');
        }

        this.defaultElement.innerHTML = `
            <span class="inline-icon">
                ${escapeHtml(this.callSign)} ${icon && getIconSvg(icon)}
            </span>
        `;

        this.defaultElementCursorisPointer = Boolean(
            this.store?.stations.iAmCheckedIn && this.store?.stations.iAmAdmin && this.station?.checkedState
        );
    }

    protected onConnected(): void {
        this.addEventListener('click', this.highlightClick);
        this.addEventListener('contextmenu', this.checkStateClick);
    }

    protected onDisconnected(): void {
        this.removeEventListener('click', this.highlightClick);
        this.removeEventListener('contextmenu', this.checkStateClick);
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('callsigncell', CallSignCell, store);
    }
}

export class NameCell extends StationTableMember {
    private tooltipEl: HTMLElement | null = null;
    private scrollDismissHandler: (() => void) | null = null;
    private clickDismissHandler: ((e: Event) => void) | null = null;
    private _tooltipShowHandler: (() => void) | null = null;
    private tooltipVisible = false;
    private scrollTarget: EventTarget | null = null;
    private windowFallbackBound = false;

    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                display: grid;
                align-items: center;
                justify-items: start;
                padding: 10px;
                /* Remaining styles by applyStyling() */
            }
            .namecell-tooltip {
                position: absolute;
                z-index: 999;
                background-color: #333;
                color: #fff;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 0.85rem;
                white-space: nowrap;
                pointer-events: none;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
                display: none;
            }
        </style>

        <div id="${this.defaultElementId}">
        </div>
        `;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.haveThisStationPropertiesChanged(['location', 'displayName', 'role', 'checkedState', 'presence']);
    }

    private showTooltip(): void {
        if (!this.defaultElement || this.tooltipVisible) return;
        this.tooltipVisible = true;

        if (!this.tooltipEl) {
            this.tooltipEl = document.createElement('div');
            this.tooltipEl.className = 'namecell-tooltip';
            // Insert into the same parent so scroll context is correct
            this.defaultElement.parentElement?.appendChild(this.tooltipEl);
        }

        this.tooltipEl.textContent = this.station?.location ?? '🚫';

        // Position below the name cell using viewport coords
        const rect = this.defaultElement.getBoundingClientRect();
        this.tooltipEl.style.left = rect.left + 'px';
        this.tooltipEl.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        this.tooltipEl.style.display = 'block';
    }

    private hideTooltip(): void {
        if (this.tooltipEl) {
            this.tooltipEl.style.display = 'none';
        }
        this.tooltipVisible = false;
    }

    private disposeTooltip(): void {
        if (this.tooltipEl) {
            this.tooltipEl.remove();
            this.tooltipEl = null;
        }
        this.tooltipVisible = false;
        this._tooltipShowHandler = null;
    }

    protected render(onConnected: boolean): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }

        // The name and styling are cheap, idempotent writes, so paint them from the
        // current station on EVERY render. A cell rebuilt while the store already
        // holds data connects via render(false) (not render(true), see base
        // connectedCallback), so gating these writes on a per-cycle "displayName
        // changed" flag left freshly-rebuilt cells blank until the name happened to
        // change — the roster "all names vanish on update" bug. Writing
        // unconditionally makes the cell a pure function of current state.
        this.defaultElement.textContent = `${this.station?.displayName ?? ''}`;
        if (this.station) {
            this.applyStyling(this.defaultElement, this.getStyling(this.station));
        }

        // Update tooltip content if visible (location may have changed)
        if (this.tooltipVisible && this.tooltipEl) {
            this.tooltipEl.textContent = this.station?.location ?? '🚫';
        }
    }

    protected onConnected(): void {
        // Resolve the scroll container that should dismiss the tooltip.
        //
        // CRITICAL: `this.defaultElement` lives inside this component's CLOSED
        // shadow root. Walking up its `.parentElement` chain never escapes the
        // shadow boundary (a shadow root has no parentElement), so the old walk
        // always hit null and fell back to `window` on every platform — which is
        // why scroll-to-dismiss never fired on the real `.height-40vh` scroller.
        //
        // `this` (the <hl-namecell> custom element host) IS in the light DOM, so
        // we walk up from the host to find the nearest vertical scroll ancestor.
        let scrollTarget: EventTarget | null = null;
        let el: HTMLElement | null = this as unknown as HTMLElement;
        while (el && el !== document.documentElement) {
            const oy = getComputedStyle(el).overflowY;
            if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
                scrollTarget = el;
                break;
            }
            el = el.parentElement;
        }
        scrollTarget ??= window;

        this.scrollDismissHandler = () => this.hideTooltip();
        scrollTarget.addEventListener('scroll', this.scrollDismissHandler, { passive: true });
        // iOS Safari does not reliably fire 'scroll' during an active touch drag.
        // 'touchmove' fires continuously while the user drags their finger.
        scrollTarget.addEventListener('touchmove', this.scrollDismissHandler, { passive: true });
        this.scrollTarget = scrollTarget;

        // Belt-and-suspenders: also dismiss on window scroll/touchmove in case the
        // resolved container is ever wrong. Skip if the target already IS window
        // (no double-binding). Tracked separately so cleanup removes exactly what
        // it added.
        if (scrollTarget !== window) {
            window.addEventListener('scroll', this.scrollDismissHandler, { passive: true });
            window.addEventListener('touchmove', this.scrollDismissHandler, { passive: true });
            this.windowFallbackBound = true;
        }

        // Dismiss on any tap/click outside the name cell
        this.clickDismissHandler = (e: Event) => {
            if (this.defaultElement && !this.defaultElement.contains(e.target as Node)) {
                this.hideTooltip();
            }
        };
        document.addEventListener('click', this.clickDismissHandler);
        // Show tooltip on click/tap of the name cell
        this._tooltipShowHandler = () => this.showTooltip();
        if (this.defaultElement) {
            this.defaultElement.addEventListener('click', this._tooltipShowHandler);
        }
    }

    protected onDisconnected(): void {
        this.hideTooltip();
        if (this.scrollDismissHandler) {
            if (this.scrollTarget) {
                this.scrollTarget.removeEventListener('scroll', this.scrollDismissHandler);
                this.scrollTarget.removeEventListener('touchmove', this.scrollDismissHandler);
            }
            if (this.windowFallbackBound) {
                window.removeEventListener('scroll', this.scrollDismissHandler);
                window.removeEventListener('touchmove', this.scrollDismissHandler);
            }
            this.scrollDismissHandler = null;
        }
        this.scrollTarget = null;
        this.windowFallbackBound = false;
        if (this.clickDismissHandler) {
            document.removeEventListener('click', this.clickDismissHandler);
            this.clickDismissHandler = null;
        }
        if (this.defaultElement && this._tooltipShowHandler) {
            this.defaultElement.removeEventListener('click', this._tooltipShowHandler);
        }
        this._tooltipShowHandler = null;
    }

    // Kept for compatibility; delegates to disposeTooltip.
    private cleanupTooltip(): void {
        this.disposeTooltip();
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('namecell', NameCell, store);
    }
}

export class SigReportCell extends StationTableMember {
    private lastSigReportType: string | null = null;
    private restrictedSigReports: boolean | null = null;

    protected getTemplate(): string {
        return /*html*/ `
        <style>
            ${this.getInputStyles()}
        </style>
        <form id="${this.defaultElementId}">
            <input type="text" placeholder="..." size="4" aria-label="Input Signal Report">
        </form>
        `;
    }

    private getInputStyles(): string {
        return /*css*/ `
            #${this.defaultElementId} input {
                color: var(--hl-light);
                font-size: 1rem;
                background: black;
                padding: 10px;
                border: 1px solid #777;
                border-radius: 5px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                transition: border-color 0.4s, box-shadow 0.4s;
            }
            #${this.defaultElementId} input::placeholder {
                color: gray;
            }
            #${this.defaultElementId} input:focus {
                border-color: var(--hl-light);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                outline: none;
            }
            #${this.defaultElementId} input:disabled {
                background: #333;
                color: #777;
            }
        `;
    }

    private haveNetSigReportAttribsChanged(): boolean {
        const sigReportType = this.store?.mainCache?.net.sigReportType ?? null;
        const restrictedSigReports = this.store?.mainCache?.net.restrictedSigReports ?? null;

        const hasChanged =
            sigReportType !== this.lastSigReportType || restrictedSigReports !== this.restrictedSigReports;

        this.lastSigReportType = sigReportType;
        this.restrictedSigReports = restrictedSigReports;

        return hasChanged;
    }

    private updateVisibility(): void {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, updateVisibility()');
        }

        this.style.display = this.store?.mainCache?.net.sigReportType === null ? 'none' : 'block';
    }

    private updateInputPlaceholderValue(input: HTMLInputElement): void {
        input.placeholder = this.store?.mainCache?.net.sigReportType ?? '...';
    }

    private indicateInputValueChange(): void {
        if (this.store && this.store.version <= 1) {
            return;
        }

        const input = this.getInputElement();
        const { averageSigReport } = this.station ?? {};
        const { averageSigReport: priorAverageSigReport } = this.stationPrior ?? {};

        if (this.store?.ready && typeof averageSigReport === 'string' && averageSigReport !== priorAverageSigReport) {
            this.updateInputBorderStyle(input, 'success');
        }
    }

    private updateInputValue(input: HTMLInputElement, value?: string): void {
        input.value = value ?? this.station?.averageSigReport ?? '';
    }

    private updateInputState(input: HTMLInputElement): void {
        const restrictedSigReports = this.store?.mainCache?.net.restrictedSigReports ?? false;
        const isNetControl = this.store?.stations.mine?.role === 'netcontrol';
        const isCheckedStateFalse = this.station?.checkedState === false;

        input.disabled =
            (restrictedSigReports && !isNetControl) ||
            isCheckedStateFalse ||
            this.store?.mainCache?.net.sigReportType === null;
    }

    private updateInputBorderStyle(input: HTMLInputElement, applyTemp?: 'success' | 'danger'): void {
        const borderStyles = {
            default: { color: 'rgba(240, 238, 222, 0.15)', style: 'solid', width: '1px' },
            hasSigReport: { color: 'var(--hl-tertiary)', style: 'solid', width: '2px' },
            success: { color: 'var(--hl-success)', style: 'solid', width: '2px' },
            danger: { color: 'var(--hl-danger)', style: 'solid', width: '2px' }
        };

        let borderStyle = borderStyles.default;

        if (applyTemp) {
            borderStyle = applyTemp === 'success' ? borderStyles.success : borderStyles.danger;
            setTimeout(() => this.updateInputBorderStyle(input), 2500);
        } else {
            if (!this.station) {
                throw new Error('Station is null in SigReportCell widget, updateInputBorderStyle()');
            }

            borderStyle = this.station.averageSigReport ? borderStyles.hasSigReport : borderStyles.default;
            if (this.station.checkedState === false) borderStyle = borderStyles.default;
        }

        input.style.borderColor = borderStyle.color;
        input.style.borderStyle = borderStyle.style;
        input.style.borderWidth = borderStyle.width;
    }

    private handleInputFocus = (e: FocusEvent): void => {
        const input = e.target as HTMLInputElement;
        input.style.borderColor = 'var(--hl-light)';
        input.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
        input.style.borderWidth = '1px';
        input.style.outline = 'none';
        this.updateInputValue(input, '');
    };

    private handleInputBlur = (e: FocusEvent): void => {
        const input = e.target as HTMLInputElement;
        this.updateInputBorderStyle(input);
        this.updateInputPlaceholderValue(input);
        this.updateInputValue(input);
    };

    private handleSubmit = (e: Event): void => {
        e.preventDefault();
        const input = this.getInputElement();

        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, handleSubmit()');
        }

        this.sigReport(this.callSign, input.value.trim())
            .then(() => {
                input.blur();
                this.updateInputBorderStyle(input, 'success');
                this.updateInputValue(input, input.value.trim());
            })
            .catch(error => {
                logger.error(`Error updating sigReport for ${this.callSign} in widget: ${error}`);
                this.updateInputBorderStyle(input, 'danger');
            });
    };

    private getInputElement(): HTMLInputElement {
        const input = this.defaultElement?.querySelector('input');
        if (!input) {
            throw new Error('Input element is not defined in widget');
        }
        return input;
    }

    protected didMyDataSegmentChange(): boolean {
        return (
            this.haveNetSigReportAttribsChanged() ||
            this.haveThisStationPropertiesChanged(['checkedState', 'averageSigReport'])
        );
    }

    protected render(): void {
        const input = this.getInputElement();
        this.updateInputPlaceholderValue(input);
        this.updateInputState(input);
        this.updateInputBorderStyle(input);
        this.updateInputValue(input);
        this.updateVisibility();
        this.indicateInputValueChange();
    }

    protected onConnected(): void {
        const input = this.getInputElement();
        input.addEventListener('focus', this.handleInputFocus);
        input.addEventListener('blur', this.handleInputBlur);
        this.defaultElement?.addEventListener('submit', this.handleSubmit);
    }

    protected onDisconnected(): void {
        const input = this.getInputElement();
        input.removeEventListener('focus', this.handleInputFocus);
        input.removeEventListener('blur', this.handleInputBlur);
        this.defaultElement?.removeEventListener('submit', this.handleSubmit);
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('sigreportcell', SigReportCell, store);
    }
}
export class StationRow extends StationTableMember {
    private readonly cellTypes = ['avatar', 'callsign', 'name', 'sigreport'] as const;

    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                padding-right: 20px;
                align-items: center;
                border: 1px solid transparent;
                border-bottom: 1px solid rgba(240, 238, 222, 0.15);
                justify-items: center; /* Center contents horizontally */
                text-align: center; /* Center text horizontally */
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
            }
            .highlighted-${this.uuid} {
                background-image: linear-gradient(to right, var(--hl-quaternary), var(--hl-quaternary), #333, #555, var(--hl-quaternary));
            }
        </style>
        <div id="${this.defaultElementId}"></div>`;
    }

    private createCell<T extends StationTableMember>(type: string): T {
        const cell = document.createElement(`hl-${type}cell`) as T;
        cell.callSign = this.callSign || '';
        return cell;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.haveThisStationPropertiesChanged(['highlight', 'role', 'checkedState', 'presence']);
    }

    protected render(_onConnected: boolean): void {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, render()');
        }

        // Highlight and opacity are cheap, idempotent writes, so paint them from the
        // current station on EVERY render. Like NameCell, a row rebuilt while the
        // store already holds data connects via render(false), so gating these on a
        // per-cycle change flag left a rebuilt checked-out row un-dimmed (and a
        // highlighted row un-highlighted) until those props happened to change.
        this.defaultElement.classList.toggle(`highlighted-${this.uuid}`, Boolean(this.station?.highlight));
        if (this.station) {
            this.defaultElement.style.opacity = String(this.getStyling(this.station).opacity);
        }
    }

    protected onConnected(): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onConnected()`);
            return;
        }
        this.cellTypes.forEach(type => {
            this.defaultElement?.appendChild(this.createCell(type));
        });
    }

    protected onDisconnected(): void {
        // Remove all cells from the row
        this.removeAllDefaultElementChildren();
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('stationrow', StationRow, store);
    }
}

export class StationTable extends LiveNetElement {
    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
            display: grid;
            width: 100%;
            height: 100%;
            
            /* center table */
            color: var(--hl-light)
            }
        </style>

        <div id="${this.defaultElementId}">
        </div>
        `;
    }

    // Helper function to create a station row
    private createStationRow(callSign: string, isLastNonCheckedOutAttendee = false): StationRow {
        const stationRow = document.createElement('hl-stationrow') as StationRow;
        stationRow.callSign = callSign;
        isLastNonCheckedOutAttendee && stationRow.classList.add('last-non-checkedout-attendee');
        return stationRow;
    }

    protected didMyDataSegmentChange(): boolean {
        return Boolean(
            this.store?.stations.getGroup('attendees')?.newData || this.store?.stations.getGroup('checked-out')?.newData
        );
    }

    protected onConnected(): void {}
    protected onDisconnected(): void {}

    protected render(onConnected: boolean): void {
        if (onConnected) {
            return;
        }

        if (this.store?.ready) {
            const fragment = this.createDocumentFragmentWithStations();
            this.replaceAllDefaultElementChildrenWith(fragment);
            this.scrollToLastNonCheckedOutAttendee();
        }
    }

    private createDocumentFragmentWithStations(): DocumentFragment {
        const fragment = document.createDocumentFragment();

        this.store?.stations.list.forEach(station =>
            fragment.appendChild(
                this.createStationRow(station.callSign, station.callSign === this.lastNonCheckedOutAttendee)
            )
        );

        return fragment;
    }

    private get lastNonCheckedOutAttendee(): string | undefined {
        const stations = this.store?.stations.list ?? [];
        const lastNonCheckedOutStation = stations.filter(station => station.checkedState !== false).pop();
        return lastNonCheckedOutStation?.callSign;
    }

    private scrollToLastNonCheckedOutAttendee(): void {
        if (!prefs.autoScrollStationTable) {
            return;
        }

        const lastNonCheckedOutAttendeeElement = this.defaultElement?.querySelector('.last-non-checkedout-attendee');
        if (lastNonCheckedOutAttendeeElement) {
            schedule(() => {
                lastNonCheckedOutAttendeeElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'end',
                    inline: 'nearest'
                });
            }, SchedulingMethod.NextAnimationFrame);
        }
    }

    public static async init(store: LiveNetReactiveStore): Promise<void> {
        await this.initElement('stationtable', StationTable, store);
    }
}
