import { createLogger } from '#@client/lib/logger.js';
import { UserAgentPersistentPreferences, getIconSvg, FavoriteClient } from '#@client/lib/clientUtils.js';
import { isNpid } from '#@client/types/commonTypesupport.js';
import { HamLiveElement, BaseInsert } from './base.js';
const logger = createLogger('lib/widgets/favorites.ts');
const prefs = new UserAgentPersistentPreferences();
export class FavoriteInsert extends BaseInsert {
    toolTipText = 'Click to Follow/Unfollow';
    iconColor = 'var(--hl-tertiary)';
    state = false;
    _npid = null;
    fc = new FavoriteClient();
    getIcon() {
        return getIconSvg(this.state ? 'bi-star-fill' : 'bi-star');
    }
    toggleState = () => {
        this.store?.delayServerDataIngest();
        this.state = !this.state;
        this.renderIcon();
        if (this.npid)
            this.fc.set(this.npid, this.state);
    };
    set npid(npid) {
        if (!isNpid(npid)) {
            throw new Error('Invalid NPID in Favorite widget, set npid()');
        }
        this._npid = npid;
    }
    get npid() {
        return this._npid;
    }
    get storeDiffers() {
        if (!this.store?.ready) {
            logger.warn(`Store is not *yet ready in ${this.constructor.name}, storeDiffers()`);
            return false;
        }
        return this.npid ? this.store?.state(this.npid) !== this.state : false;
    }
    didMyDataSegmentChange() {
        return this.storeDiffers;
    }
    render() {
        if (this.store?.ready && this.storeDiffers) {
            this.state = !this.state;
        }
        this.renderIcon();
    }
    static async init(store) {
        await this.initElement('fav-insert', FavoriteInsert, store);
    }
}
export class AutoScrollInsert extends HTMLElement {
    toolTipText = 'Toggle Autoscroll';
    iconColor = 'var(--hl-secondary)';
    _shadowRoot = null;
    constructor() {
        super();
        try {
            this._shadowRoot = this.attachShadow({ mode: 'closed' });
            this._shadowRoot.innerHTML = this.getTemplate();
        }
        catch (error) {
            logger.error('Failed to attach shadow root:', error);
        }
    }
    handleIconClick = () => {
        prefs.autoScrollStationTable = !prefs.autoScrollStationTable;
        this.renderIcon();
    };
    getTemplate() {
        return `
            <style>
                svg {
                    color: ${this.iconColor};
                }
            </style>
            ${this.getIcon()}
        `;
    }
    getIcon() {
        return prefs.autoScrollStationTable ? getIconSvg('bi-chevron-double-down') : getIconSvg('bi-chevron-contract');
    }
    renderIcon() {
        if (!this._shadowRoot) {
            logger.warn(`Shadow root is not defined in ${this.constructor.name}, renderIcon()`);
            return;
        }
        this._shadowRoot.innerHTML = this.getTemplate();
    }
    connectedCallback() {
        this.addEventListener('click', this.handleIconClick);
    }
    disconnectedCallback() {
        this.removeEventListener('click', this.handleIconClick);
    }
    static init() {
        customElements.define('hl-autoscroll-insert', AutoScrollInsert);
    }
}
export class FavoritesList extends HamLiveElement {
    getTemplate() {
        return `
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
    didMyDataSegmentChange() {
        return this.store?.favoritesListChanged ?? false;
    }
    render(onConnected) {
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
    createHeaderRow() {
        const row = this.createRowElement();
        row.classList.add('header');
        row.appendChild(this.createCellElement('Net'));
        row.appendChild(this.createCellElement('Followers', true));
        return row;
    }
    createRowElement() {
        const row = document.createElement('div');
        row.classList.add('row');
        return row;
    }
    createCellElement(content, end = false) {
        const cell = document.createElement('div');
        cell.classList.add('cell');
        if (end) {
            cell.classList.add('end');
        }
        if (typeof content === 'string') {
            cell.textContent = content;
        }
        else {
            cell.appendChild(content);
        }
        return cell;
    }
    createTitleAndFavElement(id, title, mode) {
        const span = document.createElement('span');
        span.textContent = title;
        const fav = document.createElement('hl-fav-insert');
        fav.npid = id;
        span.appendChild(fav);
        span.appendChild(this.createParenElement('('));
        span.appendChild(this.createDetailsElement(mode));
        span.appendChild(this.createParenElement(')'));
        return span;
    }
    createParenElement(content) {
        const span = document.createElement('span');
        span.classList.add('parens');
        span.textContent = content;
        return span;
    }
    createDetailsElement(content) {
        const span = document.createElement('span');
        span.classList.add('details');
        span.textContent = content;
        return span;
    }
    onConnected() { }
    onDisconnected() { }
    static async init(store) {
        await this.initElement('favlist', FavoritesList, store);
    }
}
//# sourceMappingURL=favorites.js.map