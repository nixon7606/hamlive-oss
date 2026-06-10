/* hamlive-oss — MIT License. See LICENSE. */

/* eslint-disable @typescript-eslint/require-await */
import {
    StoreSubscriber,
    ReactiveStore,
    NewDataReturnType,
    LiveNetReactiveStore,
    PropertiesOfInterest,
    isStateGroupKey,
    StateGroupKey,
    ReadonlyStateGroup
} from '#@client/lib/stores.js';
import {
    EndPointResponse,
    Station,
    RstReportBase,
    StrengthTone,
} from '#@client/types/commonTypes.js';
import {
    isRstReportBase,
    isRstReportBaseWithTone,
} from '#@client/types/commonTypesupport.js';
import { SimpleInteractions, SimpleInteractionMethodNames, DefaultStateTypes } from '#@client/types/clientTypes.js';
import {
    generateUUID,
    InteractionClient,
    AdminClient,
    getIconSvg,
} from '#@client/lib/clientUtils.js';

import { createLogger } from '#@client/lib/logger.js';

const logger = createLogger('lib/widgets/base.ts');

export enum EncapsulationMode {
    Open = 'open',
    Closed = 'closed'
}

interface DynamicElementConstructorWithInit<T extends ReactiveStore<EndPointResponse>> {
    new (): HamLiveElement<T>;
    init: (store: T) => void;
}

export abstract class HamLiveElement<T extends ReactiveStore<EndPointResponse>>
    extends HTMLElement
    implements StoreSubscriber
{
    private _store: T | null = null;
    static readonly storeMap: Map<string, ReactiveStore<EndPointResponse>> = new Map();
    private _shadowRoot: ShadowRoot | null = null;
    public readonly uuid: string = generateUUID();
    protected readonly defaultElementId: string = `default-${this.uuid}`;
    protected defaultElement: HTMLElement | null = null;

    static sharedStylesPromise: Promise<CSSStyleSheet> = (async () => {
        let sheet: CSSStyleSheet | null = null;

        try {
            sheet = new CSSStyleSheet();
        } catch (err) {
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
            } catch (error) {
                if (error instanceof Error) {
                    logger.error(`Error importing shared styles: ${error.message}`);
                } else if (typeof error === 'string') {
                    logger.error(`Error importing shared styles: ${error}`);
                }
            }
        }

        if (!sheet) {
            throw new Error('CSSStyleSheet could not be created.');
        }

        return sheet;
    })();

    constructor(protected encapsulate: Readonly<EncapsulationMode> = EncapsulationMode.Closed) {
        super();
    }

    protected set root(node: HTMLElement | ShadowRoot | null) {
        if (this.encapsulate === EncapsulationMode.Closed) {
            this._shadowRoot = node instanceof ShadowRoot ? node : null;
        } else {
            this._shadowRoot = null;
        }
    }

    protected get root(): HTMLElement | ShadowRoot {
        return this.encapsulate !== EncapsulationMode.Open ? this._shadowRoot! : this;
    }

    private async setupWidgetRoot(): Promise<void> {
        if (this.encapsulate === EncapsulationMode.Closed) {
            this.root = this.attachShadow({ mode: 'closed' });
            this.root.adoptedStyleSheets = [await HamLiveElement.sharedStylesPromise];
        } else {
            logger.warn(`${this.constructor.name} using light DOM`);
            this.root = this;
        }
    }

    private subscribeToStore(store: T): void {
        // logger.debug(`${this.constructor.name} subscribing to ${store.constructor.name}`);
        store.subscribe(this);
        this._store = store;
    }

    private unsubscribeFromStore(): void {
        if (this._store) {
            // logger.debug(`${this.constructor.name} unsubscribing from ${this._store.constructor.name}`);
            this._store.unsubscribe(this);
            this._store = null;
        } else {
            logger.warn('Store is already null, cannot unsubscribe');
        }
    }

    protected set store(store: T | null) {
        if (store) {
            this.subscribeToStore(store);
        } else {
            this.unsubscribeFromStore();
        }
    }

    protected get store(): T | null {
        return this._store;
    }

    //Widgets must implement:
    protected abstract getTemplate(): string;
    protected abstract didMyDataSegmentChange(): boolean;
    protected abstract render(onConnected: boolean): void;
    protected abstract onConnected(): void;
    protected abstract onDisconnected(): void;

    public async newData(): NewDataReturnType {
        if (this.store?.mainCache) {
            if (this.didMyDataSegmentChange()) {
                logger.info(`My segment of the store changed in ${this.constructor.name} widget`);
                return this.render(false);
            }
        } else {
            throw new Error('Store is not defined in widget, newData()');
        }
    }

    public set online(online: boolean) {
        if (this.defaultElement) {
            if (!online) {
                this.defaultElement.classList.add('offline');
                logger.debug(`${this.constructor.name} is offline`);
            } else {
                this.defaultElement.classList.remove('offline');
                logger.debug(`${this.constructor.name} is online`);
            }
        }
    }

    public get online(): boolean {
        return !this.classList.contains('offline');
    }

    protected removeAllDefaultElementChildren(): void {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in widget, removeAllDefaultElementChildren()');
            return;
        }

        while (this.defaultElement.firstChild) {
            this.defaultElement.removeChild(this.defaultElement.firstChild);
        }
    }

    protected appendToDefaultElement(child: HTMLElement | DocumentFragment): void {
        if (!this.defaultElement) {
            logger.warn('Default element is not defined in widget, appendToDefaultElement()');
            return;
        }

        this.defaultElement.appendChild(child);
    }

    protected replaceAllDefaultElementChildrenWith(child: HTMLElement | DocumentFragment): void {
        this.removeAllDefaultElementChildren();
        this.appendToDefaultElement(child);
    }

    protected static async initElement<T extends ReactiveStore<EndPointResponse>>(
        tagName: string,
        elementClass: DynamicElementConstructorWithInit<T>,
        store: T
    ): Promise<void> {
        const prefixedTagName = `hl-${tagName}` as const;

        HamLiveElement.storeMap.set(prefixedTagName.toLowerCase(), store);

        window.customElements.define(prefixedTagName, elementClass);
        await customElements.whenDefined(prefixedTagName);

        // logger.debug(`${elementClass.name} element initialized successfully`);
    }

    private assignDefaultElement(): void {
        this.defaultElement = this.defaultElement || this.root.querySelector(`#${this.defaultElementId}`);
    }

    protected applyTemplate(): void {
        const template = document.createElement('template');
        template.innerHTML = this.getTemplate();

        if (template.content.querySelector(this.tagName.toLowerCase())) {
            throw new Error(
                `Recursive template detected in ${this.tagName}. A custom element should not contain its own tag in its template.`
            );
        }

        // Clear any existing children of this.root
        this.root.innerHTML = '';

        this.root.append(template.content.cloneNode(true));
    }

    public async connectedCallback(): Promise<void> {
        // store setup:
        const store = HamLiveElement.storeMap.get(this.tagName.toLowerCase());
        if (!store) {
            throw new Error(`Store not assigned to ${this.tagName}`);
        }
        if (!(store instanceof ReactiveStore)) {
            throw new Error(`Store for ${this.tagName} is not an instance of ReactiveStore`);
        }

        // root setup:
        await this.setupWidgetRoot();
        this.applyTemplate(); // populate root with per-component template
        this.assignDefaultElement();

        // callback hook for subclasses:
        this.onConnected();

        //subscribe to store
        this.store = store as T;

        // render: We call render to handle cases where a widget is destroyed and recreated,
        // but no new data is necessarily available. This is less about the initial render
        // on the initial page load and more about the render that occurs when a widget is
        // reconnected to the DOM after being disconnected.
        this.render(true);
    }

    public disconnectedCallback(): void {
        logger.debug(`${this.constructor.name} disconnected from the DOM`);
        this.store = null;
        this.onDisconnected();
    }
}

export interface ButtonBarInsert extends HTMLElement {
    toolTipText: string;
}

export abstract class BaseInsert<T extends ReactiveStore<EndPointResponse>>
    extends HamLiveElement<T>
    implements ButtonBarInsert
{
    public abstract toolTipText: string;
    protected abstract iconColor: string;
    protected abstract getIcon(): ReturnType<typeof getIconSvg>;
    protected abstract toggleState: () => void;

    protected getTemplate(): string {
        return /*html*/ `
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

    protected renderIcon(): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, renderIcon()`);
            return;
        }

        this.defaultElement.innerHTML = this.getIcon();
    }

    protected onConnected(): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onConnected()`);
            return;
        }
        this.renderIcon();
        this.addEventListener('click', this.toggleState);
    }

    protected onDisconnected(): void {
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, onDisconnected()`);
            return;
        }
        this.removeEventListener('click', this.toggleState);
    }
}

type StationIcon = (typeof LiveNetElement.ICONS)[keyof typeof LiveNetElement.ICONS];

export abstract class LiveNetElement
    extends HamLiveElement<LiveNetReactiveStore>
    implements SimpleInteractions<Promise<DefaultStateTypes>>
{
    protected ia = new InteractionClient();

    static ICONS = {
        netcontrol: 'bi-mic-fill',
        netlogger: 'bi-journal-check',
        netuser: 'bi-person-check',
        netrelay: 'bi-intersect',
        online: 'bi-eye-fill',
        default: '' // this effects the visibility of the station, see stationIsVisible() below
    } as const;

    protected readonly roleToIcon = {
        netcontrol: LiveNetElement.ICONS.netcontrol,
        netlogger: LiveNetElement.ICONS.netlogger,
        netuser: LiveNetElement.ICONS.netuser,
        netrelay: LiveNetElement.ICONS.netrelay
    } as const;

    protected getStationIcon(station: Station): StationIcon {
        const { role, checkedState, presence } = station;
        if (checkedState === true) {
            return this.roleToIcon[role] || LiveNetElement.ICONS.default;
        } else if (checkedState === null) {
            return presence === 'online' ? LiveNetElement.ICONS.online : LiveNetElement.ICONS.default;
        } else {
            return LiveNetElement.ICONS.default;
        }
    }

    protected stationIsVisible(station: Station): boolean {
        return Boolean(this.getStationIcon(station));
    }

    private async simpleInteractionWrapper(
        action: SimpleInteractionMethodNames,
        callSign: string,
        state?: DefaultStateTypes
    ): Promise<DefaultStateTypes> {
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
        } catch (error) {
            if (error instanceof Error) {
                logger.error(
                    `Error updating ${action} for ${callSign} in ${this.constructor.name} widget: ${error.message}`
                );
            }
            logger.info(`Reverting ${action} for ${callSign} in ${this.constructor.name} widget`);
            this.store[action](callSign, null);
        }

        return ret;
    }

    public async highlight(callSign: string, state?: DefaultStateTypes): Promise<boolean> {
        return (await this.simpleInteractionWrapper('highlight', callSign, state)) ?? false;
    }

    public async hand(callSign: string, state?: DefaultStateTypes): Promise<boolean> {
        return (await this.simpleInteractionWrapper('hand', callSign, state)) ?? false;
    }

    public async checkState(callSign: string, state?: DefaultStateTypes): Promise<boolean | null> {
        return this.simpleInteractionWrapper('checkState', callSign, state);
    }

    public async sigReport(callSign: string, report: string): Promise<void> {
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

        await this.ia.sigReport(callSign, rstReport as RstReportBase | (RstReportBase & { t: StrengthTone }));
    }
}

export abstract class StateGroupReport extends LiveNetElement {
    // The `isSettingGroup` flag is used to prevent a recursive loop that occurs when setting the `group` attribute.
    // Without this flag, setting the `group` attribute within the `set group` method triggers the `attributeChangedCallback`,
    // which in turn calls the `handleGroupAttributeChange` method. This method sets the `group` attribute again, causing
    // the `attributeChangedCallback` to be called repeatedly, leading to a "Maximum call stack size exceeded" error.
    // By using the `isSettingGroup` flag, we can prevent this recursive loop. The flag is set to `true` before setting
    // the attribute and reset to `false` afterward. If the flag is already `true`, the `set group` method returns immediately,
    // avoiding the recursive call.
    private isSettingGroup = false;

    protected abstract getReport(stateGroup: ReadonlyStateGroup): string;

    static get observedAttributes(): string[] {
        return ['group'];
    }

    attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
        if (name === 'group' && newValue) {
            this.handleGroupAttributeChange(newValue);
        }
    }

    private handleGroupAttributeChange(newValue: string): void {
        if (isStateGroupKey(newValue)) {
            this.group = newValue;
        } else {
            this.logInvalidGroupValue(newValue);
        }
    }

    private logInvalidGroupValue(value: string): void {
        logger.warn(`Invalid group attribute value: ${value} in ${this.constructor.name}`);
    }

    set group(value: string) {
        if (this.isSettingGroup) return;

        if (isStateGroupKey(value)) {
            this.isSettingGroup = true;
            this.setAttribute('group', value);
            this.isSettingGroup = false;
        } else {
            this.logInvalidGroupValue(value);
        }
    }

    get group(): StateGroupKey | null {
        return this.getAttribute('group') as StateGroupKey | null;
    }

    protected getTemplate(): string {
        return /*html*/ `
        <style>
        </style>
        <span id="${this.defaultElementId}"></span>
    `;
    }

    protected didMyDataSegmentChange(): boolean {
        return Boolean(this.group && this.store?.stations.getGroup(this.group)?.newData);
    }

    protected render(onConnected: boolean): void {
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
        // this.defaultElement.textContent = Array.from(callSigns).join(', ');
    }

    protected onConnected(): void {
        // Implement logic to run when the element is connected to the DOM
    }

    protected onDisconnected(): void {
        // Implement logic to run when the element is disconnected from the DOM
    }

    // public static async init(store: LiveNetReactiveStore): Promise<void> {
    //     await this.initElement('stategroup-report', StateGroupReport, store);
    // }
}

export abstract class NetControlMember extends LiveNetElement {
    protected readonly cmd: AdminClient = new AdminClient();

    protected didMyStatusChange(): boolean {
        try {
            return this.store?.stations.haveMyStationPropertiesChanged(['role', 'checkedState']) ?? false;
        } catch (error) {
            if (error instanceof Error) {
                logger.warn(error.message);
            }
            return false;
        }
    }

    protected get iAmCheckedInAdmin(): boolean {
        let iAmAdmin: boolean;
        let iAmCheckedIn: boolean;

        try {
            ({ iAmAdmin, iAmCheckedIn } = this.store?.stations ?? { iAmAdmin: false, iAmCheckedIn: false });
        } catch (error) {
            if (error instanceof Error)
                logger.warn(`In widget ${this.constructor.name} : iAmCheckedInAdmin(): ${error.message}`);
            return false;
        }

        return iAmAdmin && iAmCheckedIn;
    }
}

type CellContentStyling = {
    icon: StationIcon;
    color: `var(--hl-${Exclude<ReturnType<StationTableMember['getStationColor']>, ''> | 'danger'})`;
    fontStyle: 'italic' | 'normal';
    fontWeight: 'bold' | 'normal';
    textDecoration: 'line-through' | 'none';
    opacity: number;
    visible: boolean;
};

type StyleKey = `${Station['role']}-${Station['presence']}-${Station['checkedState']}`;

export abstract class StationTableMember extends LiveNetElement {
    public callSign: string | null = null;
    static readonly styleCache = new Map<StyleKey, CellContentStyling>();

    protected set defaultElementCursorisPointer(pointer: boolean) {
        if (!this.defaultElement) {
            throw new Error('Default element is not defined in widget, defaultElementCursorisPointer()');
        }
        this.defaultElement.style.cursor = pointer ? 'pointer' : 'default';
    }

    private handleClickType =
        (type: SimpleInteractionMethodNames) =>
        (e: Event): void => {
            this.handleClick(type, e);
        };

    // Handlers can't be anonymous (otherwise they can't be removed) or take arguments,
    // so we need a named function for each type of interaction (vs simply using
    // handleClick(type, e) directly on the event listener).

    protected highlightClick = this.handleClickType('highlight');
    protected handClick = this.handleClickType('hand');
    protected checkStateClick = this.handleClickType('checkState');

    protected handleClick = (type: SimpleInteractionMethodNames, e: Event): void => {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, handleClick()');
        }

        if (!this.store) {
            throw new Error('Store is not defined in widget, handleClick()');
        }

        const target = e.target as HTMLElement;
        logger.debug(
            `click event on target: ${target.tagName} with class: ${target.className} in widget: ${this.constructor.name}`
        );

        const isCheckState = type === 'checkState';
        const isHighlightOrCheckState = type === 'highlight' || isCheckState;
        const isHand = type === 'hand';

        if (isCheckState) {
            if (!this.iHaveMorePrivs) {
                // Load the context menu and return
                logger.warn('Cannot check out station with equal or greater privileges');
                return;
            }

            if (!this.iAmStation) {
                // Inhibit context menu if the target station is not me
                e.preventDefault();
            } else {
                // Load the context menu and return
                logger.warn('Cannot check out self');
                return;
            }

            // Inhibit context menu if the target station has less privileges than me
            e.preventDefault();
        }

        const { iAmCheckedIn, iAmAdmin } = this.store.stations;
        const theyAreCheckedIn = this.station?.checkedState === true;

        //highlight and checkOuts can only be performed on checkedIn stations
        if (isHighlightOrCheckState && iAmCheckedIn && iAmAdmin && theyAreCheckedIn) {
            const param = isCheckState ? false : null;
            this[type](this.callSign, param).catch(error => {
                logger.error(`Error updating ${type} state for ${this.callSign} in widget: ${error}`);
            });
            //hand can only be performed regardless of checkedState
        } else if (isHand && ((iAmCheckedIn && iAmAdmin) || this.iAmStation)) {
            this[type](this.callSign, null).catch(error => {
                logger.error(`Error updating ${type} state for ${this.callSign} in widget: ${error}`);
            });
        }
    };

    protected get iAmStation(): boolean {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, iAmStation()');
        }
        return this.callSign === this.store?.stations.mine?.callSign;
    }

    protected get iHaveMorePrivs(): boolean {
        if (!this.station || !this.store?.stations.mine) {
            throw new Error('Station or mine is not defined in widget, iHaveMorePrivs()');
        }
        return this.store.stations.mine.level < this.station.level;
    }

    protected getStationColor(
        station: Station
    ): 'primary' | 'secondary' | 'light' | 'success' | 'tertiary' | 'quaternary' | 'danger' {
        const { role, checkedState, presence } = station;

        if (checkedState === null) {
            return presence === 'online' ? 'light' : 'danger';
        }

        if (checkedState === false) {
            return 'light';
        }

        const roleColorMap: Record<string, 'primary' | 'secondary' | 'tertiary' | 'success' | undefined> = {
            netuser: 'primary',
            netcontrol: 'secondary',
            netlogger: 'tertiary',
            netrelay: 'success',
            default: undefined
        };

        return roleColorMap[role] || 'danger';
    }

    stationIsBold(station: Station): boolean {
        return typeof station.checkedState === 'boolean';
    }
    getStationOpacity(station: Station): number {
        return station.checkedState === false ? 0.5 : 1;
    }

    stationIsItalicized(station: Station): boolean {
        return station.checkedState !== true;
    }

    stationIsLinethrough(station: Station): boolean {
        return station.checkedState === false;
    }

    protected getStyling(station: Station): CellContentStyling {
        const { role, presence, checkedState } = station;

        // Create a unique key based on the properties
        const styleKey: StyleKey = `${role}-${presence}-${checkedState}`;

        if (StationTableMember.styleCache.has(styleKey)) {
            // logger.debug(`Using memoized styling for ${role}, ${presence}, check:${checkedState}`);
            return StationTableMember.styleCache.get(styleKey)!;
        }

        const styling: CellContentStyling = {
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

    protected applyStyling(element: HTMLElement, styling: Omit<CellContentStyling, 'icon'>): void {
        if (!element.style) {
            throw new Error('The element does not have a style tag in widget, applyStyling()');
        }
        element.style.fontWeight = styling.fontWeight;
        element.style.color = styling.color;
        element.style.fontStyle = styling.fontStyle;
        element.style.textDecoration = styling.textDecoration;
    }

    protected haveThisStationPropertiesChanged(properties: PropertiesOfInterest[]): boolean {
        if (!this.callSign) {
            throw new Error('Call sign is not defined in widget, havePropertiesChanged()');
        }

        return this.store?.stations.havePropertiesChanged(properties, this.callSign) ?? false;
    }

    protected get station() {
        if (!this.callSign) {
            throw new Error('Call sign is not *yet defined in widget, getThisStation()');
        }

        if (!this.store) {
            logger.warn(`Store is not defined in ${this.constructor.name}, getThisStation()`);
            return null;
        }

        return this.store.stations.get(this.callSign);
    }

    protected get stationPrior() {
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
