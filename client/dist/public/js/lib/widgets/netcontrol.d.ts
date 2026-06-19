import { LiveNetReactiveStore } from '#@client/lib/stores.js';
import { LiveNetElement, NetControlMember } from './base.js';
export declare class NetStartProgress extends LiveNetElement {
    private defaultIntervalMs;
    private _width;
    private _state;
    private readonly mainLooper;
    constructor();
    private set width(value);
    private get width();
    private set state(value);
    private get state();
    private gracePeriodPercentComplete;
    protected getTemplate(): string;
    private renderBarWidth;
    private renderBarStyle;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    private startMainLooper;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class NetControlUsage extends NetControlMember {
    protected getTemplate(): string;
    private collapse;
    private toggleExpandCollapse;
    private handleCommandHelpClick;
    protected didMyDataSegmentChange(): boolean;
    protected formatUsage(text: string): string;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class NetControlForm extends NetControlMember {
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    applyFocus(): void;
    protected respond(response: string, type?: 'error' | 'success'): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class NetControlPanel extends NetControlMember {
    protected getTemplate(): string;
    open(): void;
    close(): void;
    private get isOpen();
    toggle(): void;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    applyFocus(): void;
    private handleCloseClick;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class NetControlButton extends NetControlMember {
    protected netControlPanelElement: NetControlPanel | null;
    private label;
    constructor();
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    private handleClick;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
//# sourceMappingURL=netcontrol.d.ts.map