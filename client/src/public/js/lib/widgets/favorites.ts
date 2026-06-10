/* hamlive-oss — MIT License. See LICENSE. */

import { createLogger } from '#@client/lib/logger.js';
import { UserAgentPersistentPreferences, getIconSvg, FavoriteClient } from '#@client/lib/clientUtils.js';
import { FavoritesReactiveStore } from '#@client/lib/stores.js';
import { NPID } from '#@client/types/commonTypes.js';
import { isNpid } from '#@client/types/commonTypesupport.js';
import { HamLiveElement, BaseInsert, ButtonBarInsert } from './base.js';

const logger = createLogger('lib/widgets/favorites.ts');
const prefs = new UserAgentPersistentPreferences();

export class FavoriteInsert extends BaseInsert<FavoritesReactiveStore> implements ButtonBarInsert {
    public toolTipText = 'Click to Follow/Unfollow';
    protected iconColor = 'var(--hl-tertiary)';
    private state = false;
    private _npid: NPID | null = null;
    private fc = new FavoriteClient();

    protected getIcon(): ReturnType<typeof getIconSvg> {
        return getIconSvg(this.state ? 'bi-star-fill' : 'bi-star');
    }

    protected toggleState = (): void => {
        this.store?.delayServerDataIngest();
        this.state = !this.state;
        this.renderIcon();
        if (this.npid) this.fc.set(this.npid, this.state);
    };

    public set npid(npid: NPID) {
        if (!isNpid(npid)) {
            throw new Error('Invalid NPID in Favorite widget, set npid()');
        }
        this._npid = npid;
    }

    public get npid(): Readonly<NPID> | null {
        return this._npid;
    }

    private get storeDiffers(): boolean {
        if (!this.store?.ready) {
            logger.warn(`Store is not *yet ready in ${this.constructor.name}, storeDiffers()`);
            return false;
        }
        return this.npid ? this.store?.state(this.npid) !== this.state : false;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.storeDiffers;
    }

    protected render(): void {
        if (this.store?.ready && this.storeDiffers) {
            this.state = !this.state;
        }
        this.renderIcon();
    }

    public static async init(store: FavoritesReactiveStore): Promise<void> {
        await this.initElement('fav-insert', FavoriteInsert, store);
    }
}

export class AutoScrollInsert extends HTMLElement implements ButtonBarInsert {
    public toolTipText = 'Toggle Autoscroll';
    private iconColor = 'var(--hl-secondary)';
    private _shadowRoot: ShadowRoot | null = null;

    constructor() {
        super();
        try {
            this._shadowRoot = this.attachShadow({ mode: 'closed' });
            this._shadowRoot.innerHTML = this.getTemplate();
        } catch (error) {
            logger.error('Failed to attach shadow root:', error);
        }
    }

    private handleIconClick = (): void => {
        prefs.autoScrollStationTable = !prefs.autoScrollStationTable;
        this.renderIcon();
    };

    private getTemplate(): string {
        return /*html*/ `
            <style>
                svg {
                    color: ${this.iconColor};
                }
            </style>
            ${this.getIcon()}
        `;
    }

    private getIcon(): ReturnType<typeof getIconSvg> {
        return prefs.autoScrollStationTable ? getIconSvg('bi-chevron-double-down') : getIconSvg('bi-chevron-contract');
    }

    private renderIcon(): void {
        if (!this._shadowRoot) {
            logger.warn(`Shadow root is not defined in ${this.constructor.name}, renderIcon()`);
            return;
        }
        this._shadowRoot.innerHTML = this.getTemplate();
    }

    connectedCallback(): void {
        this.addEventListener('click', this.handleIconClick);
    }

    disconnectedCallback(): void {
        this.removeEventListener('click', this.handleIconClick);
    }

    static init(): void {
        customElements.define('hl-autoscroll-insert', AutoScrollInsert);
    }
}


export class FavoritesList extends HamLiveElement<FavoritesReactiveStore> {
    protected getTemplate(): string {
        return /*html*/ `
        <style>
            #${this.defaultElementId} {
                display: grid;
                margin: 0 auto;
                color: var(--hl-light);
            }
            #${this.defaultElementId} .header {
                font-weight: bold;
                font-style: italic;
                color: var(--hl-secondary);
            }
            #${this.defaultElementId} .row {
                padding-right: 20px;
                align-items: center;
                border: 1px solid transparent;
                border-bottom: 1px solid rgba(240, 238, 222, 0.15);
                display: grid;
                grid-template-columns: 1fr 1fr;
            }
            #${this.defaultElementId} .cell {
                display: grid;
                align-items: center;
                justify-items: start;
                padding: 10px;
                white-space: nowrap;
            }
            #${this.defaultElementId} .cell.end {
                justify-items: end;
            }
            #${this.defaultElementId} hl-fav {
                margin-right: 4px;
            }
            #${this.defaultElementId} .details {
                color: var(--hl-secondary);
                font-size: 0.8em;
                font-style: italic;
            }
            #${this.defaultElementId} .parens {
                padding: 0 4px;
                color: var(--hl-light);
                font-size: 0.8em;
            }
        </style>
        <div id="${this.defaultElementId}"></div>
    `;
    }

    protected didMyDataSegmentChange(): boolean {
        return this.store?.favoritesListChanged ?? false;
    }

    protected render(onConnected: boolean): void {
        if (onConnected) {
            return;
        }

        logger.debug('FavoritesList widget: render()');
        if (!this.defaultElement) {
            logger.warn(`Default element is not defined in ${this.constructor.name}, render()`);
            return;
        }

        const { netlist } = this.store?.mainCache?.message ?? { netlist: [] };

        if (netlist && netlist.length === 0) {
            this.defaultElement.textContent = 'Follow/Favorite some nets to see them here.';
            return;
        }

        const fragment = document.createDocumentFragment();
        fragment.appendChild(this.createHeaderRow());

        netlist.forEach(({ id, title, followCount, mode }) => {
            const row = this.createRowElement();
            row.appendChild(this.createCellElement(this.createTitleAndFavElement(id, title, mode)));
            row.appendChild(this.createCellElement(followCount.toString(), true));
            fragment.appendChild(row);
        });

        this.replaceAllDefaultElementChildrenWith(fragment);
    }

    private createHeaderRow(): HTMLDivElement {
        const row = this.createRowElement();
        row.classList.add('header');
        row.appendChild(this.createCellElement('Net'));
        row.appendChild(this.createCellElement('Followers', true));
        return row;
    }

    private createRowElement(): HTMLDivElement {
        const row = document.createElement('div');
        row.classList.add('row');
        return row;
    }

    private createCellElement(content: string | HTMLElement, end: boolean = false): HTMLDivElement {
        const cell = document.createElement('div');
        cell.classList.add('cell');
        if (end) {
            cell.classList.add('end');
        }
        if (typeof content === 'string') {
            cell.textContent = content;
        } else {
            cell.appendChild(content);
        }
        return cell;
    }

    private createTitleAndFavElement(id: NPID, title: string, mode: string): HTMLSpanElement {
        const span = document.createElement('span');
        span.textContent = title;

        const fav = document.createElement('hl-fav-insert') as FavoriteInsert;
        fav.npid = id;
        span.appendChild(fav);

        span.appendChild(this.createParenElement('('));
        span.appendChild(this.createDetailsElement(mode));
        span.appendChild(this.createParenElement(')'));

        return span;
    }

    private createParenElement(content: string): HTMLSpanElement {
        const span = document.createElement('span');
        span.classList.add('parens');
        span.textContent = content;
        return span;
    }

    private createDetailsElement(content: string): HTMLSpanElement {
        const span = document.createElement('span');
        span.classList.add('details');
        span.textContent = content;
        return span;
    }

    protected onConnected(): void {}
    protected onDisconnected(): void {}

    public static async init(store: FavoritesReactiveStore): Promise<void> {
        await this.initElement('favlist', FavoritesList, store);
    }
}
