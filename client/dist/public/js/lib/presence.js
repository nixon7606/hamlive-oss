import { EndPointClient, generateUUID } from '#@client/lib/clientUtils.js';
import { LiveNetPresenceReactiveStore } from '#@client/lib/stores.js';
import { createLogger } from '#@client/lib/logger.js';
import { serverInfo } from '#@client/lib/serverInfo.js';
const logger = createLogger('lib/presence.ts');
export class Presence {
    npid;
    ep;
    store;
    client;
    lastResume = Date.now();
    constructor(npid) {
        this.npid = npid;
        this.ep = new EndPointClient('/api/presence/livenets', {
            redirectOnNotFound: '/views/dashboard',
            redirectOnNonJson: '/views/dashboard'
        })
            .id(npid.toString() || '')
            .p('capturePresence', 'true');
        this.store = new LiveNetPresenceReactiveStore(this.ep);
        this.client = this.clientSubscription();
        this.store.init().catch(error => {
            logger.error('Failed to initialize Presence Store in constructor:', error);
        });
        this.addResumeEventListener(document, 'visibilitychange', () => document.visibilityState === 'visible');
        this.addResumeEventListener(window, 'focus');
        this.addResumeEventListener(window, 'pageshow', (event) => event.persisted);
    }
    addResumeEventListener(target, eventName, condition = () => true) {
        target.addEventListener(eventName, event => {
            if (condition(event)) {
                this.handleResume(eventName);
            }
        });
    }
    handleResume = (listenerName) => {
        const AWAY_BUFFER_PCT = 20;
        const adjustedAwayInMs = serverInfo.awayInMs * (1 - AWAY_BUFFER_PCT / 100);
        if (Date.now() - this.lastResume < adjustedAwayInMs) {
            return;
        }
        logger.info(`Signaling presence on ${listenerName} event`);
        this.ep.show().catch(error => {
            logger.error('Error while contacting presence endpoint:', error);
        });
        this.lastResume = Date.now();
    };
    clientSubscription() {
        return new Promise(resolve => {
            const self = this;
            this.store.subscribe({
                uuid: generateUUID(),
                async newData() {
                    self.store.unsubscribe(this);
                    if (!self.store.mainCache) {
                        throw new Error('mainCache is not defined in presence store');
                    }
                    resolve(self.store.mainCache.client);
                },
                online: true
            });
        });
    }
}
//# sourceMappingURL=presence.js.map