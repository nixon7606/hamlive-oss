import { StoreSubscriber, ReactiveStore, NewDataReturnType, LiveNetReactiveStore, PropertiesOfInterest, StateGroupKey, ReadonlyStateGroup } from '#@client/lib/stores.js';
import { EndPointResponse, Station } from '#@client/types/commonTypes.js';
import { SimpleInteractions, SimpleInteractionMethodNames, DefaultStateTypes } from '#@client/types/clientTypes.js';
import { InteractionClient, AdminClient, getIconSvg } from '#@client/lib/clientUtils.js';
export declare enum EncapsulationMode {
    Open = "open",
    Closed = "closed"
}
interface DynamicElementConstructorWithInit<T extends ReactiveStore<EndPointResponse>> {
    new (): HamLiveElement<T>;
    init: (store: T) => void;
}
export declare abstract class HamLiveElement<T extends ReactiveStore<EndPointResponse>> extends HTMLElement implements StoreSubscriber {
    protected encapsulate: Readonly<EncapsulationMode>;
    private _store;
    static readonly storeMap: Map<string, ReactiveStore<EndPointResponse>>;
    private _shadowRoot;
    readonly uuid: string;
    protected readonly defaultElementId: string;
    protected defaultElement: HTMLElement | null;
    static sharedStylesPromise: Promise<CSSStyleSheet>;
    constructor(encapsulate?: Readonly<EncapsulationMode>);
    protected set root(node: HTMLElement | ShadowRoot | null);
    protected get root(): HTMLElement | ShadowRoot;
    private setupWidgetRoot;
    private subscribeToStore;
    private unsubscribeFromStore;
    protected set store(store: T | null);
    protected get store(): T | null;
    protected abstract getTemplate(): string;
    protected abstract didMyDataSegmentChange(): boolean;
    protected abstract render(onConnected: boolean): void;
    protected abstract onConnected(): void;
    protected abstract onDisconnected(): void;
    newData(): NewDataReturnType;
    set online(online: boolean);
    get online(): boolean;
    protected removeAllDefaultElementChildren(): void;
    protected appendToDefaultElement(child: HTMLElement | DocumentFragment): void;
    protected replaceAllDefaultElementChildrenWith(child: HTMLElement | DocumentFragment): void;
    protected static initElement<T extends ReactiveStore<EndPointResponse>>(tagName: string, elementClass: DynamicElementConstructorWithInit<T>, store: T): Promise<void>;
    private assignDefaultElement;
    protected applyTemplate(): void;
    connectedCallback(): Promise<void>;
    disconnectedCallback(): void;
}
export interface ButtonBarInsert extends HTMLElement {
    toolTipText: string;
}
export declare abstract class BaseInsert<T extends ReactiveStore<EndPointResponse>> extends HamLiveElement<T> implements ButtonBarInsert {
    abstract toolTipText: string;
    protected abstract iconColor: string;
    protected abstract getIcon(): ReturnType<typeof getIconSvg>;
    protected abstract toggleState: () => void;
    protected getTemplate(): string;
    protected renderIcon(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
}
type StationIcon = (typeof LiveNetElement.ICONS)[keyof typeof LiveNetElement.ICONS];
export declare abstract class LiveNetElement extends HamLiveElement<LiveNetReactiveStore> implements SimpleInteractions<Promise<DefaultStateTypes>> {
    protected ia: InteractionClient;
    static ICONS: {
        readonly netcontrol: "bi-mic-fill";
        readonly netlogger: "bi-journal-check";
        readonly netuser: "bi-person-check";
        readonly netrelay: "bi-intersect";
        readonly online: "bi-eye-fill";
        readonly default: "";
    };
    protected readonly roleToIcon: {
        readonly netcontrol: "bi-mic-fill";
        readonly netlogger: "bi-journal-check";
        readonly netuser: "bi-person-check";
        readonly netrelay: "bi-intersect";
    };
    protected getStationIcon(station: Station): StationIcon;
    protected stationIsVisible(station: Station): boolean;
    private simpleInteractionWrapper;
    highlight(callSign: string, state?: DefaultStateTypes): Promise<boolean>;
    hand(callSign: string, state?: DefaultStateTypes): Promise<boolean>;
    checkState(callSign: string, state?: DefaultStateTypes): Promise<boolean | null>;
    sigReport(callSign: string, report: string): Promise<void>;
}
export declare abstract class StateGroupReport extends LiveNetElement {
    private isSettingGroup;
    protected abstract getReport(stateGroup: ReadonlyStateGroup): string;
    static get observedAttributes(): string[];
    attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void;
    private handleGroupAttributeChange;
    private logInvalidGroupValue;
    set group(value: string);
    get group(): StateGroupKey | null;
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
}
export declare abstract class NetControlMember extends LiveNetElement {
    protected readonly cmd: AdminClient;
    protected didMyStatusChange(): boolean;
    protected get iAmCheckedInAdmin(): boolean;
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
export declare abstract class StationTableMember extends LiveNetElement {
    callSign: string | null;
    static readonly styleCache: Map<"netcontrol-online-null" | "netcontrol-online-false" | "netcontrol-online-true" | "netcontrol-offline-null" | "netcontrol-offline-false" | "netcontrol-offline-true" | "netlogger-online-null" | "netlogger-online-false" | "netlogger-online-true" | "netlogger-offline-null" | "netlogger-offline-false" | "netlogger-offline-true" | "netrelay-online-null" | "netrelay-online-false" | "netrelay-online-true" | "netrelay-offline-null" | "netrelay-offline-false" | "netrelay-offline-true" | "netuser-online-null" | "netuser-online-false" | "netuser-online-true" | "netuser-offline-null" | "netuser-offline-false" | "netuser-offline-true", CellContentStyling>;
    protected set defaultElementCursorisPointer(pointer: boolean);
    private handleClickType;
    protected highlightClick: (e: Event) => void;
    protected handClick: (e: Event) => void;
    protected checkStateClick: (e: Event) => void;
    protected handleClick: (type: SimpleInteractionMethodNames, e: Event) => void;
    protected get iAmStation(): boolean;
    protected get iHaveMorePrivs(): boolean;
    protected getStationColor(station: Station): 'primary' | 'secondary' | 'light' | 'success' | 'tertiary' | 'quaternary' | 'danger';
    stationIsBold(station: Station): boolean;
    getStationOpacity(station: Station): number;
    stationIsItalicized(station: Station): boolean;
    stationIsLinethrough(station: Station): boolean;
    protected getStyling(station: Station): CellContentStyling;
    protected applyStyling(element: HTMLElement, styling: Omit<CellContentStyling, 'icon'>): void;
    protected haveThisStationPropertiesChanged(properties: PropertiesOfInterest[]): boolean;
    protected get station(): Readonly<Station> | null;
    protected get stationPrior(): Readonly<Station> | null;
}
export {};
//# sourceMappingURL=base.d.ts.map