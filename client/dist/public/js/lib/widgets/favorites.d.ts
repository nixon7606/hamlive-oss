import { getIconSvg } from '#@client/lib/clientUtils.js';
import { FavoritesReactiveStore } from '#@client/lib/stores.js';
import { NPID } from '#@client/types/commonTypes.js';
import { HamLiveElement, BaseInsert, ButtonBarInsert } from './base.js';
export declare class FavoriteInsert extends BaseInsert<FavoritesReactiveStore> implements ButtonBarInsert {
    toolTipText: string;
    protected iconColor: string;
    private state;
    private _npid;
    private fc;
    protected getIcon(): ReturnType<typeof getIconSvg>;
    protected toggleState: () => void;
    set npid(npid: NPID);
    get npid(): Readonly<NPID> | null;
    private get storeDiffers();
    protected didMyDataSegmentChange(): boolean;
    protected render(): void;
    static init(store: FavoritesReactiveStore): Promise<void>;
}
export declare class AutoScrollInsert extends HTMLElement implements ButtonBarInsert {
    toolTipText: string;
    private iconColor;
    private _shadowRoot;
    constructor();
    private handleIconClick;
    private getTemplate;
    private getIcon;
    private renderIcon;
    connectedCallback(): void;
    disconnectedCallback(): void;
    static init(): void;
}
export declare class FavoritesList extends HamLiveElement<FavoritesReactiveStore> {
    protected getTemplate(): string;
    protected didMyDataSegmentChange(): boolean;
    protected render(onConnected: boolean): void;
    private createHeaderRow;
    private createRowElement;
    private createCellElement;
    private createTitleAndFavElement;
    private createParenElement;
    private createDetailsElement;
    protected onConnected(): void;
    protected onDisconnected(): void;
    static init(store: FavoritesReactiveStore): Promise<void>;
}
//# sourceMappingURL=favorites.d.ts.map