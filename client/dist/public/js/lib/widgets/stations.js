import { createLogger } from '#@client/lib/logger.js';
import { UserAgentPersistentPreferences, getIconSvg, schedule, SchedulingMethod } from '#@client/lib/clientUtils.js';
import { LiveNetElement, StationTableMember } from './base.js';
const logger = createLogger('lib/widgets/stations.ts');
const prefs = new UserAgentPersistentPreferences();
function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}
export class AvatarCell extends StationTableMember {
    defaultPhoto = '/img/marconi_88x96.jpg';
    get photoUrl() {
        return this.store?.ready ? (this.station?.photo ?? this.defaultPhoto) : this.defaultPhoto;
    }
    get isOnline() {
        return this.station?.presence === 'online';
    }
    getTemplate() {
        return `
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
    didMyDataSegmentChange() {
        return this.haveThisStationPropertiesChanged(['photo', 'hand', 'presence']);
    }
    render() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }
        this.defaultElement.querySelector('img').src = this.photoUrl;
        this.defaultElement.querySelector('.hand-icon').classList.toggle('hand-is-down', !this.station?.hand);
        const onlineIconElement = this.defaultElement.querySelector('.onlinestatus-icon.online');
        const offlineIconElement = this.defaultElement.querySelector('.onlinestatus-icon.offline');
        if (!onlineIconElement || !offlineIconElement) {
            logger.warn(`Online status elements are not defined in ${this.constructor.name}, render()`);
            return;
        }
        onlineIconElement.classList.toggle('visible', this.isOnline);
        offlineIconElement.classList.toggle('visible', !this.isOnline);
        this.defaultElementCursorisPointer = Boolean(this.iAmStation || (this.store?.stations.iAmAdmin && this.store.stations.iAmCheckedIn));
    }
    onConnected() {
        this.addEventListener('click', this.handClick);
    }
    onDisconnected() {
        this.removeEventListener('click', this.handClick);
    }
    static async init(store) {
        await this.initElement('avatarcell', AvatarCell, store);
    }
}
export class CallSignCell extends StationTableMember {
    getTemplate = () => {
        return `
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
    didMyDataSegmentChange() {
        return this.haveThisStationPropertiesChanged(['role', 'callSign', 'checkedState', 'presence']);
    }
    render() {
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
        this.defaultElementCursorisPointer = Boolean(this.store?.stations.iAmCheckedIn && this.store?.stations.iAmAdmin && this.station?.checkedState);
    }
    onConnected() {
        this.addEventListener('click', this.highlightClick);
        this.addEventListener('contextmenu', this.checkStateClick);
    }
    onDisconnected() {
        this.removeEventListener('click', this.highlightClick);
        this.removeEventListener('contextmenu', this.checkStateClick);
    }
    static async init(store) {
        await this.initElement('callsigncell', CallSignCell, store);
    }
}
export class NameCell extends StationTableMember {
    tooltipEl = null;
    scrollDismissHandler = null;
    clickDismissHandler = null;
    _tooltipShowHandler = null;
    tooltipVisible = false;
    scrollTarget = null;
    getTemplate() {
        return `\n        <style>\n            #${this.defaultElementId} {\n                display: grid;\n                align-items: center;\n                justify-items: start;\n                padding: 10px;\n                /* Remaining styles by applyStyling() */\n            }\n            .namecell-tooltip {\n                position: absolute;\n                z-index: 999;\n                background-color: #333;\n                color: #fff;\n                padding: 4px 8px;\n                border-radius: 4px;\n                font-size: 0.85rem;\n                white-space: nowrap;\n                pointer-events: none;\n                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);\n                display: none;\n            }\n        </style>\n\n        <div id="${this.defaultElementId}">\n        </div>\n        `;
    }
    didMyDataSegmentChange() {
        return this.haveThisStationPropertiesChanged(['location', 'displayName', 'role', 'checkedState', 'presence']);
    }
    showTooltip() {
        if (!this.defaultElement || this.tooltipVisible) return;
        this.tooltipVisible = true;
        if (!this.tooltipEl) {
            this.tooltipEl = document.createElement('div');
            this.tooltipEl.className = 'namecell-tooltip';
            this.defaultElement.parentElement?.appendChild(this.tooltipEl);
        }
        this.tooltipEl.textContent = this.station?.location ?? '🚫';
        const rect = this.defaultElement.getBoundingClientRect();
        this.tooltipEl.style.left = rect.left + 'px';
        this.tooltipEl.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        this.tooltipEl.style.display = 'block';
    }
    hideTooltip() {
        if (this.tooltipEl) {
            this.tooltipEl.style.display = 'none';
        }
        this.tooltipVisible = false;
    }
    disposeTooltip() {
        if (this.tooltipEl) {
            this.tooltipEl.remove();
            this.tooltipEl = null;
        }
        this.tooltipVisible = false;
        this._tooltipShowHandler = null;
    }
    render(onConnected) {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }
        this.defaultElement.textContent = `${this.station?.displayName ?? ''}`;
        if (this.station) {
            this.applyStyling(this.defaultElement, this.getStyling(this.station));
        }
        if (this.tooltipVisible && this.tooltipEl) {
            this.tooltipEl.textContent = this.station?.location ?? '🚫';
        }
    }
    onConnected() {
        let scrollTarget = null;
        let el = this.defaultElement;
        while (el && el !== document.documentElement) {
            const style = getComputedStyle(el);
            const oy = style.overflowY;
            if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
                scrollTarget = el;
                break;
            }
            el = el.parentElement;
        }
        scrollTarget ??= window;
        this.scrollDismissHandler = () => this.hideTooltip();
        scrollTarget.addEventListener('scroll', this.scrollDismissHandler, { passive: true });
        scrollTarget.addEventListener('touchmove', this.scrollDismissHandler, { passive: true });
        this.scrollTarget = scrollTarget;
        this.clickDismissHandler = (e) => {
            if (this.defaultElement && !this.defaultElement.contains(e.target)) {
                this.hideTooltip();
            }
        };
        document.addEventListener('click', this.clickDismissHandler);
        this._tooltipShowHandler = () => this.showTooltip();
        if (this.defaultElement) {
            this.defaultElement.addEventListener('click', this._tooltipShowHandler);
        }
    }
    onDisconnected() {
        this.hideTooltip();
        if (this.scrollDismissHandler && this.scrollTarget) {
            this.scrollTarget.removeEventListener('scroll', this.scrollDismissHandler);
            this.scrollTarget.removeEventListener('touchmove', this.scrollDismissHandler);
            this.scrollDismissHandler = null;
        }
        this.scrollTarget = null;
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
    cleanupTooltip() {
        this.disposeTooltip();
    }
    static async init(store) {
        await this.initElement('namecell', NameCell, store);
    }
}
export class SigReportCell extends StationTableMember {
    lastSigReportType = null;
    restrictedSigReports = null;
    getTemplate() {
        return `
        <style>
            ${this.getInputStyles()}
        </style>
        <form id="${this.defaultElementId}">
            <input type="text" placeholder="..." size="4" aria-label="Input Signal Report">
        </form>
        `;
    }
    getInputStyles() {
        return `
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
    haveNetSigReportAttribsChanged() {
        const sigReportType = this.store?.mainCache?.net.sigReportType ?? null;
        const restrictedSigReports = this.store?.mainCache?.net.restrictedSigReports ?? null;
        const hasChanged = sigReportType !== this.lastSigReportType || restrictedSigReports !== this.restrictedSigReports;
        this.lastSigReportType = sigReportType;
        this.restrictedSigReports = restrictedSigReports;
        return hasChanged;
    }
    updateVisibility() {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, updateVisibility()');
        }
        this.style.display = this.store?.mainCache?.net.sigReportType === null ? 'none' : 'block';
    }
    updateInputPlaceholderValue(input) {
        input.placeholder = this.store?.mainCache?.net.sigReportType ?? '...';
    }
    indicateInputValueChange() {
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
    updateInputValue(input, value) {
        input.value = value ?? this.station?.averageSigReport ?? '';
    }
    updateInputState(input) {
        const restrictedSigReports = this.store?.mainCache?.net.restrictedSigReports ?? false;
        const isNetControl = this.store?.stations.mine?.role === 'netcontrol';
        const isCheckedStateFalse = this.station?.checkedState === false;
        input.disabled =
            (restrictedSigReports && !isNetControl) ||
                isCheckedStateFalse ||
                this.store?.mainCache?.net.sigReportType === null;
    }
    updateInputBorderStyle(input, applyTemp) {
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
        }
        else {
            if (!this.station) {
                throw new Error('Station is null in SigReportCell widget, updateInputBorderStyle()');
            }
            borderStyle = this.station.averageSigReport ? borderStyles.hasSigReport : borderStyles.default;
            if (this.station.checkedState === false)
                borderStyle = borderStyles.default;
        }
        input.style.borderColor = borderStyle.color;
        input.style.borderStyle = borderStyle.style;
        input.style.borderWidth = borderStyle.width;
    }
    handleInputFocus = (e) => {
        const input = e.target;
        input.style.borderColor = 'var(--hl-light)';
        input.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
        input.style.borderWidth = '1px';
        input.style.outline = 'none';
        this.updateInputValue(input, '');
    };
    handleInputBlur = (e) => {
        const input = e.target;
        this.updateInputBorderStyle(input);
        this.updateInputPlaceholderValue(input);
        this.updateInputValue(input);
    };
    handleSubmit = (e) => {
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
    getInputElement() {
        const input = this.defaultElement?.querySelector('input');
        if (!input) {
            throw new Error('Input element is not defined in widget');
        }
        return input;
    }
    didMyDataSegmentChange() {
        return (this.haveNetSigReportAttribsChanged() ||
            this.haveThisStationPropertiesChanged(['checkedState', 'averageSigReport']));
    }
    render() {
        const input = this.getInputElement();
        this.updateInputPlaceholderValue(input);
        this.updateInputState(input);
        this.updateInputBorderStyle(input);
        this.updateInputValue(input);
        this.updateVisibility();
        this.indicateInputValueChange();
    }
    onConnected() {
        const input = this.getInputElement();
        input.addEventListener('focus', this.handleInputFocus);
        input.addEventListener('blur', this.handleInputBlur);
        this.defaultElement?.addEventListener('submit', this.handleSubmit);
    }
    onDisconnected() {
        const input = this.getInputElement();
        input.removeEventListener('focus', this.handleInputFocus);
        input.removeEventListener('blur', this.handleInputBlur);
        this.defaultElement?.removeEventListener('submit', this.handleSubmit);
    }
    static async init(store) {
        await this.initElement('sigreportcell', SigReportCell, store);
    }
}
export class StationRow extends StationTableMember {
    cellTypes = ['avatar', 'callsign', 'name', 'sigreport'];
    getTemplate() {
        return `
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
    createCell(type) {
        const cell = document.createElement(`hl-${type}cell`);
        cell.callSign = this.callSign || '';
        return cell;
    }
    didMyDataSegmentChange() {
        return this.haveThisStationPropertiesChanged(['highlight', 'role', 'checkedState', 'presence']);
    }
    render(_onConnected) {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, render()');
        }
        this.defaultElement.classList.toggle(`highlighted-${this.uuid}`, Boolean(this.station?.highlight));
        if (this.station) {
            this.defaultElement.style.opacity = String(this.getStyling(this.station).opacity);
        }
    }
    onConnected() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onConnected()`);
            return;
        }
        this.cellTypes.forEach(type => {
            this.defaultElement?.appendChild(this.createCell(type));
        });
    }
    onDisconnected() {
        this.removeAllDefaultElementChildren();
    }
    static async init(store) {
        await this.initElement('stationrow', StationRow, store);
    }
}
export class StationTable extends LiveNetElement {
    getTemplate() {
        return `
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
    createStationRow(callSign, isLastNonCheckedOutAttendee = false) {
        const stationRow = document.createElement('hl-stationrow');
        stationRow.callSign = callSign;
        isLastNonCheckedOutAttendee && stationRow.classList.add('last-non-checkedout-attendee');
        return stationRow;
    }
    didMyDataSegmentChange() {
        return Boolean(this.store?.stations.getGroup('attendees')?.newData || this.store?.stations.getGroup('checked-out')?.newData);
    }
    onConnected() { }
    onDisconnected() { }
    render(onConnected) {
        if (onConnected) {
            return;
        }
        if (this.store?.ready) {
            const fragment = this.createDocumentFragmentWithStations();
            this.replaceAllDefaultElementChildrenWith(fragment);
            this.scrollToLastNonCheckedOutAttendee();
        }
    }
    createDocumentFragmentWithStations() {
        const fragment = document.createDocumentFragment();
        this.store?.stations.list.forEach(station => fragment.appendChild(this.createStationRow(station.callSign, station.callSign === this.lastNonCheckedOutAttendee)));
        return fragment;
    }
    get lastNonCheckedOutAttendee() {
        const stations = this.store?.stations.list ?? [];
        const lastNonCheckedOutStation = stations.filter(station => station.checkedState !== false).pop();
        return lastNonCheckedOutStation?.callSign;
    }
    scrollToLastNonCheckedOutAttendee() {
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
    static async init(store) {
        await this.initElement('stationtable', StationTable, store);
    }
}
//# sourceMappingURL=stations.js.map