import { LiveNetReactiveStore } from '#@client/lib/stores.js';
import { LiveNetElement, StationTableMember } from './base.js';
export declare class AvatarCell extends StationTableMember {
    private defaultPhoto;
    private get photoUrl();
    private get isOnline();
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class CallSignCell extends StationTableMember {
    protected getTemplate: () => string;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class NameCell extends StationTableMember {
    private tooltip;
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    private refreshTooltip;
    protected render(onConnected: boolean): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    private cleanupTooltip;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class SigReportCell extends StationTableMember {
    private lastSigReportType;
    private restrictedSigReports;
    protected getTemplate(): string;
    private getInputStyles;
    private haveNetSigReportAttribsChanged;
    private updateVisibility;
    private updateInputPlaceholderValue;
    private indicateInputValueChange;
    private updateInputValue;
    private updateInputState;
    private updateInputBorderStyle;
    private handleInputFocus;
    private handleInputBlur;
    private handleSubmit;
    private getInputElement;
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class StationRow extends StationTableMember {
    private readonly cellTypes;
    protected getTemplate(): string;
    private createCell;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
export declare class StationTable extends LiveNetElement {
    protected getTemplate(): string;
    private createStationRow;
    protected didMyDataSegmentChange(): boolean;
    protected onConnected(): void;
    protected onDisconnected(): void;
    protected render(onConnected: boolean): void;
    private createDocumentFragmentWithStations;
    private get lastNonCheckedOutAttendee();
    private scrollToLastNonCheckedOutAttendee;
    static init(store: LiveNetReactiveStore): Promise<void>;
}
//# sourceMappingURL=stations.d.ts.map