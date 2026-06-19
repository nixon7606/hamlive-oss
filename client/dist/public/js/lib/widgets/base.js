import { ReactiveStore, isStateGroupKey } from '#@client/lib/stores.js';
import { isRstReportBase, isRstReportBaseWithTone, } from '#@client/types/commonTypesupport.js';
import { generateUUID, InteractionClient, AdminClient, } from '#@client/lib/clientUtils.js';
import { createLogger } from '#@client/lib/logger.js';
const logger = createLogger('lib/widgets/base.ts');
export var EncapsulationMode;
(function (EncapsulationMode) {
    EncapsulationMode["Open"] = "open";
    EncapsulationMode["Closed"] = "closed";
})(EncapsulationMode || (EncapsulationMode = {}));
export class HamLiveElement extends HTMLElement {
    encapsulate;
    _store = null;
    static storeMap = new Map();
    _shadowRoot = null;
    uuid = generateUUID();
    defaultElementId = `default-${this.uuid}`;
    defaultElement = null;
    static sharedStylesPromise = (async () => {
        let sheet = null;
        try {
            sheet = new CSSStyleSheet();
        }
        catch (err) {
            window.alert('Your browser does not support CSSStyleSheet(). Please use a modern browser.');
            if (err instanceof Error) {
                logger.error(`Error creating new CSSStyleSheet: ${err.message}`);
            }
        }
        if (sheet) {
            try {
                const response = await fetch('/css/widgets.css');
                if (!response.ok) {
                    throw new Error(`Failed to fetch CSS: ${response.statusText}`);
                }
                const cssText = await response.text();
                await sheet.replace(cssText);
            }
            catch (error) {
                if (error instanceof Error) {
                    logger.error(`Error importing shared styles: ${error.message}`);
                }
                else if (typeof error === 'string') {
                    logger.error(`Error importing shared styles: ${error}`);
                }
            }
        }
        if (!sheet) {
            throw new Error('CSSStyleSheet could not be created.');
        }
        return sheet;
    })();
    constructor(encapsulate = EncapsulationMode.Closed) {
        super();
        this.encapsulate = encapsulate;
    }
    set root(node) {
        if (this.encapsulate === EncapsulationMode.Closed) {
            this._shadowRoot = node instanceof ShadowRoot ? node : null;
        }
        else {
            this._shadowRoot = null;
        }
    }
    get root() {
        return this.encapsulate !== EncapsulationMode.Open ? this._shadowRoot : this;
    }
    async setupWidgetRoot() {
        if (this.encapsulate === EncapsulationMode.Closed) {
            this.root = this.attachShadow({ mode: 'closed' });
            this.root.adoptedStyleSheets = [await HamLiveElement.sharedStylesPromise];
        }
        else {
            logger.warn(`${this.constructor.name} using light DOM`);
            this.root = this;
        }
    }
    subscribeToStore(store) {
        store.subscribe(this);
        this._store = store;
    }
    unsubscribeFromStore() {
        if (this._store) {
            this._store.unsubscribe(this);
            this._store = null;
        }
        else {
            logger.warn('Store is already null, cannot unsubscribe');
        }
    }
    set store(store) {
        if (store) {
            this.subscribeToStore(store);
        }
        else {
            this.unsubscribeFromStore();
        }
    }
    get store() {
        return this._store;
    }
    async newData() {
        if (this.store?.mainCache) {
            if (this.didMyDataSegmentChange()) {
                logger.info(`My segment of the store changed in ${this.constructor.name} widget`);
                return this.render(false);
            }
        }
        else {
            throw new Error('Store is not defined in widget, newData()');
        }
    }
    set online(online) {
        if (this.defaultElement) {
            if (!online) {
                this.defaultElement.classList.add('offline');
                logger.debug(`${this.constructor.name} is offline`);
            }
            else {
                this.defaultElement.classList.remove('offline');
                logger.debug(`${this.constructor.name} is online`);
            }
        }
    }
    removeAllDefaultElementChildren() {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in widget, removeAllDefaultElementChildren()');
            return;
        }
        while (this.defaultElement.firstChild) {
            this.defaultElement.removeChild(this.defaultElement.firstChild);
        }
    }
    appendToDefaultElement(child) {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in widget, appendToDefaultElement()');
            return;
        }
        this.defaultElement.appendChild(child);
    }
    replaceAllDefaultElementChildrenWith(child) {
        this.removeAllDefaultElementChildren();
        this.appendToDefaultElement(child);
    }
    static async initElement(tagName, elementClass, store) {
        const prefixedTagName = `hl-${tagName}`;
        HamLiveElement.storeMap.set(prefixedTagName.toLowerCase(), store);
        window.customElements.define(prefixedTagName, elementClass);
        await customElements.whenDefined(prefixedTagName);
    }
    assignDefaultElement() {
        this.defaultElement = this.defaultElement || this.root.querySelector(`#${this.defaultElementId}`);
    }
    applyTemplate() {
        const template = document.createElement('template');
        template.innerHTML = this.getTemplate();
        if (template.content.querySelector(this.tagName.toLowerCase())) {
            throw new Error(`Recursive template detected in ${this.tagName}. A custom element should not contain its own tag in its template.`);
        }
        this.root.innerHTML = '';
        this.root.append(template.content.cloneNode(true));
    }
    async connectedCallback() {
        const store = HamLiveElement.storeMap.get(this.tagName.toLowerCase());
        if (!store) {
            throw new Error(`Store not assigned to ${this.tagName}`);
        }
        if (!(store instanceof ReactiveStore)) {
            throw new Error(`Store for ${this.tagName} is not an instance of ReactiveStore`);
        }
        await this.setupWidgetRoot();
        this.applyTemplate();
        this.assignDefaultElement();
        this.onConnected();
        this.store = store;
        if (this.store?.ready) {
            this.render(false);
        }
        else {
            this.render(true);
        }
    }
    disconnectedCallback() {
        logger.debug(`${this.constructor.name} disconnected from the DOM`);
        this.store = null;
        this.onDisconnected();
    }
}
export class BaseInsert extends HamLiveElement {
    getTemplate() {
        return `
        <style>
            /* Add your component styles here */
            #${this.defaultElementId} svg {
                color: ${this.iconColor};
            }
        </style>
        <span id="${this.defaultElementId}">
            ${this.getIcon()}
        </span>
    `;
    }
    renderIcon() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, renderIcon()`);
            return;
        }
        this.defaultElement.innerHTML = this.getIcon();
    }
    onConnected() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onConnected()`);
            return;
        }
        this.renderIcon();
        this.addEventListener('click', this.toggleState);
    }
    onDisconnected() {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onDisconnected()`);
            return;
        }
        this.removeEventListener('click', this.toggleState);
    }
}
export class LiveNetElement extends HamLiveElement {
    ia = new InteractionClient();
    static ICONS = {
        netcontrol: 'bi-mic-fill',
        netlogger: 'bi-journal-check',
        netuser: 'bi-person-check',
        netrelay: 'bi-intersect',
        online: 'bi-eye-fill',
        default: ''
    };
    roleToIcon = {
        netcontrol: LiveNetElement.ICONS.netcontrol,
        netlogger: LiveNetElement.ICONS.netlogger,
        netuser: LiveNetElement.ICONS.netuser,
        netrelay: LiveNetElement.ICONS.netrelay
    };
    getStationIcon(station) {
        const { role, checkedState, presence } = station;
        if (checkedState === true) {
            return this.roleToIcon[role] || LiveNetElement.ICONS.default;
        }
        else if (checkedState === null) {
            return presence === 'online' ? LiveNetElement.ICONS.online : LiveNetElement.ICONS.default;
        }
        else {
            return LiveNetElement.ICONS.default;
        }
    }
    stationIsVisible(station) {
        return Boolean(this.getStationIcon(station));
    }
    async simpleInteractionWrapper(action, callSign, state) {
        if (!this.store) {
            throw new Error(`Store is not ready in widget, ${action}`);
        }
        const ret = this.store[action](callSign, state);
        if (typeof state === 'undefined' || ret === null) {
            return ret;
        }
        try {
            await this.ia[action](callSign, ret);
            logger.debug(`${action} updated for ${callSign} in ${this.constructor.name} widget`);
        }
        catch (error) {
            if (error instanceof Error) {
                logger.error(`Error updating ${action} for ${callSign} in ${this.constructor.name} widget: ${error.message}`);
            }
            logger.info(`Reverting ${action} for ${callSign} in ${this.constructor.name} widget`);
            this.store[action](callSign, null);
        }
        return ret;
    }
    async highlight(callSign, state) {
        return (await this.simpleInteractionWrapper('highlight', callSign, state)) ?? false;
    }
    async hand(callSign, state) {
        return (await this.simpleInteractionWrapper('hand', callSign, state)) ?? false;
    }
    async checkState(callSign, state) {
        return this.simpleInteractionWrapper('checkState', callSign, state);
    }
    async sigReport(callSign, report) {
        const rStr = report.trim()[0];
        const sStr = report.trim()[1];
        const tStr = report.trim()[2];
        if (!rStr || !sStr) {
            throw new Error('Invalid RST values');
        }
        const r = parseInt(rStr);
        const s = parseInt(sStr);
        const t = tStr ? parseInt(tStr) : undefined;
        const rstReport = { r, s, t };
        if (!isRstReportBase(rstReport) && !isRstReportBaseWithTone(rstReport)) {
            throw new Error(`Invalid RST report: ${JSON.stringify(rstReport)} in ${this.constructor.name}`);
        }
        await this.ia.sigReport(callSign, rstReport);
    }
}
export class StateGroupReport extends LiveNetElement {
    isSettingGroup = false;
    static get observedAttributes() {
        return ['group'];
    }
    attributeChangedCallback(name, _oldValue, newValue) {
        if (name === 'group' && newValue) {
            this.handleGroupAttributeChange(newValue);
        }
    }
    handleGroupAttributeChange(newValue) {
        if (isStateGroupKey(newValue)) {
            this.group = newValue;
        }
        else {
            this.logInvalidGroupValue(newValue);
        }
    }
    logInvalidGroupValue(value) {
        logger.warn(`Invalid group attribute value: ${value} in ${this.constructor.name}`);
    }
    set group(value) {
        if (this.isSettingGroup)
            return;
        if (isStateGroupKey(value)) {
            this.isSettingGroup = true;
            this.setAttribute('group', value);
            this.isSettingGroup = false;
        }
        else {
            this.logInvalidGroupValue(value);
        }
    }
    get group() {
        return this.getAttribute('group');
    }
    getTemplate() {
        return `
        <style>
        </style>
        <span id="${this.defaultElementId}"></span>
    `;
    }
    didMyDataSegmentChange() {
        return Boolean(this.group && this.store?.stations.getGroup(this.group)?.newData);
    }
    render(onConnected) {
        if (onConnected) {
            return;
        }
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in render()');
            return;
        }
        if (!this.group) {
            logger.warn(`Missing group attribute on ${this.constructor.name}`);
            return;
        }
        const callSigns = this.store?.stations.getGroup(this.group);
        if (!callSigns) {
            logger.debug(`No call signs found for group ${this.group}`);
            return;
        }
        this.defaultElement.textContent = this.getReport(callSigns);
    }
    onConnected() {
    }
    onDisconnected() {
    }
}
export class NetControlMember extends LiveNetElement {
    cmd = new AdminClient();
    didMyStatusChange() {
        try {
            return this.store?.stations.haveMyStationPropertiesChanged(['role', 'checkedState']) ?? false;
        }
        catch (error) {
            if (error instanceof Error) {
                logger.warn(error.message);
            }
            return false;
        }
    }
    get iAmCheckedInAdmin() {
        let iAmAdmin;
        let iAmCheckedIn;
        try {
            ({ iAmAdmin, iAmCheckedIn } = this.store?.stations ?? { iAmAdmin: false, iAmCheckedIn: false });
        }
        catch (error) {
            if (error instanceof Error)
                logger.warn(`In widget ${this.constructor.name} : iAmCheckedInAdmin(): ${error.message}`);
            return false;
        }
        return iAmAdmin && iAmCheckedIn;
    }
}
export class StationTableMember extends LiveNetElement {
    callSign = null;
    static styleCache = new Map();
    set defaultElementCursorisPointer(pointer) {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, defaultElementCursorisPointer()');
        }
        this.defaultElement.style.cursor = pointer ? 'pointer' : 'default';
    }
    handleClickType = (type) => (e) => {
        this.handleClick(type, e);
    };
    highlightClick = this.handleClickType('highlight');
    handClick = this.handleClickType('hand');
    checkStateClick = this.handleClickType('checkState');
    handleClick = (type, e) => {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, handleClick()');
        }
        if (!this.store) {
            throw new Error('Store is not defined in widget, handleClick()');
        }
        const target = e.target;
        logger.debug(`click event on target: ${target.tagName} with class: ${target.className} in widget: ${this.constructor.name}`);
        const isCheckState = type === 'checkState';
        const isHighlightOrCheckState = type === 'highlight' || isCheckState;
        const isHand = type === 'hand';
        if (isCheckState) {
            if (!this.iHaveMorePrivs) {
                logger.warn('Cannot check out station with equal or greater privileges');
                return;
            }
            if (!this.iAmStation) {
                e.preventDefault();
            }
            else {
                logger.warn('Cannot check out self');
                return;
            }
            e.preventDefault();
        }
        const { iAmCheckedIn, iAmAdmin } = this.store.stations;
        const theyAreCheckedIn = this.station?.checkedState === true;
        if (isHighlightOrCheckState && iAmCheckedIn && iAmAdmin && theyAreCheckedIn) {
            const param = isCheckState ? false : null;
            this[type](this.callSign, param).catch(error => {
                logger.error(`Error updating ${type} state for ${this.callSign} in widget: ${error}`);
            });
        }
        else if (isHand && ((iAmCheckedIn && iAmAdmin) || this.iAmStation)) {
            this[type](this.callSign, null).catch(error => {
                logger.error(`Error updating ${type} state for ${this.callSign} in widget: ${error}`);
            });
        }
    };
    get iAmStation() {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, iAmStation()');
        }
        return this.callSign === this.store?.stations.mine?.callSign;
    }
    get iHaveMorePrivs() {
        if (!this.station || !this.store?.stations.mine) {
            throw new Error('Station or mine is not defined in widget, iHaveMorePrivs()');
        }
        return this.store.stations.mine.level < this.station.level;
    }
    getStationColor(station) {
        const { role, checkedState, presence } = station;
        if (checkedState === null) {
            return presence === 'online' ? 'light' : 'danger';
        }
        if (checkedState === false) {
            return 'light';
        }
        const roleColorMap = {
            netuser: 'primary',
            netcontrol: 'secondary',
            netlogger: 'tertiary',
            netrelay: 'success',
            default: undefined
        };
        return roleColorMap[role] || 'danger';
    }
    stationIsBold(station) {
        return typeof station.checkedState === 'boolean';
    }
    getStationOpacity(station) {
        return station.checkedState === false ? 0.5 : 1;
    }
    stationIsItalicized(station) {
        return station.checkedState !== true;
    }
    stationIsLinethrough(station) {
        return station.checkedState === false;
    }
    getStyling(station) {
        const { role, presence, checkedState } = station;
        const styleKey = `${role}-${presence}-${checkedState}`;
        if (StationTableMember.styleCache.has(styleKey)) {
            return StationTableMember.styleCache.get(styleKey);
        }
        const styling = {
            icon: this.getStationIcon(station),
            color: `var(--hl-${this.getStationColor(station)})`,
            fontStyle: this.stationIsItalicized(station) ? 'italic' : 'normal',
            fontWeight: this.stationIsBold(station) ? 'bold' : 'normal',
            opacity: this.getStationOpacity(station),
            visible: this.stationIsVisible(station),
            textDecoration: this.stationIsLinethrough(station) ? 'line-through' : 'none'
        };
        StationTableMember.styleCache.set(styleKey, styling);
        return styling;
    }
    applyStyling(element, styling) {
        if (!element.style) {
            throw new Error('The element does not have a style tag in widget, applyStyling()');
        }
        element.style.fontWeight = styling.fontWeight;
        element.style.color = styling.color;
        element.style.fontStyle = styling.fontStyle;
        element.style.textDecoration = styling.textDecoration;
    }
    haveThisStationPropertiesChanged(properties) {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, havePropertiesChanged()');
        }
        return this.store?.stations.havePropertiesChanged(properties, this.callSign) ?? false;
    }
    get station() {
        if (!this.callSign) {
            throw new Error('Call sign is not *yet defined in widget, getThisStation()');
        }
        if (!this.store) {
            logger.warn(`Store is not defined in ${this.constructor.name}, getThisStation()`);
            return null;
        }
        return this.store.stations.get(this.callSign);
    }
    get stationPrior() {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, getThisStationPrior()');
        }
        if (!this.store) {
            logger.warn(`Store is not defined in ${this.constructor.name}, getThisStationPrior()`);
            return null;
        }
        return this.store.stations.getPrior(this.callSign);
    }
}
//# sourceMappingURL=base.js.map