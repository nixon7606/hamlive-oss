import { LiveNetReactiveStore, ReadonlyStateGroup } from '#@client/lib/stores.js';
import { LiveNetElement, StateGroupReport } from './base.js';
export declare class StateList extends StateGroupReport {
    protected getReport(stateGroup: ReadonlyStateGroup): string;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class StateCount extends StateGroupReport {
    protected getReport(stateGroup: ReadonlyStateGroup): string;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class NetNotes extends LiveNetElement {
    private tooltip;
    private bsCollapse;
    private priorNotes;
    private priorTitle;
    constructor();
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
    protected hasDataChanged(key: 'notes' | 'title', priorValue: string, overwritePrior?: boolean): boolean;
    private updateTitle;
    private updateNotes;
}
export declare class NetDetails extends LiveNetElement {
    private priorNetDetails;
    protected getTemplate(): string;
    protected get netInfoHasChanged(): boolean;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    private buildFrequencyAndTimeString;
    private calculateApproximateStartTime;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class RoleStats extends LiveNetElement {
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
//# sourceMappingURL=info.d.ts.map