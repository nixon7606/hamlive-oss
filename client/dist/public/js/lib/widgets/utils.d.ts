import { LiveNetReactiveStore } from '#@client/lib/stores.js';
import { LiveNetElement, ButtonBarInsert } from './base.js';
export declare class NetworkStatus extends HTMLElement {
    private updateOnlineStatus;
    connectedCallback(): void;
    disconnectedCallback(): void;
    static init(): void;
}
export declare class StatsTable extends HTMLElement {
    constructor();
    private getTemplate;
    static init(): void;
}
export declare class ButtonBar extends LiveNetElement {
    private tooltipInstances;
    constructor();
    protected wrapWithButton(element: ButtonBarInsert): HTMLButtonElement;
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class HandInsert extends LiveNetElement implements ButtonBarInsert {
    toolTipText: string;
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected getIcon(): string;
    private toggleState;
    private isCallSignDefined;
    private updateHandState;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
//# sourceMappingURL=utils.d.ts.map