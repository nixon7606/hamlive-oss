/* hamlive-oss — MIT License. See LICENSE. */

/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-this-alias */
import { Client, NPID } from '#@client/types/commonTypes.js';
import { EndPointClient, generateUUID } from '#@client/lib/clientUtils.js';
import { LiveNetPresenceReactiveStore } from '#@client/lib/stores.js';
import { createLogger } from '#@client/lib/logger.js';
import { serverInfo } from '#@client/lib/serverInfo.js';

const logger = createLogger('lib/presence.ts');
/*
 * The Presence Class communicates client presence to the server using
 * several utilities:
 *
 * 1. ReactiveStore: Enables short polling via Looper.
 *
 * 2. LiveNetPresenceReactiveStore: Configured to poll instead of
 *    subscribing to the SSE path.
 *
 * 3. /api/presence/ requests: Have TTLs set to "away" time minus 3
 *    seconds. Looper uses TTL to schedule requests before the client is
 *    considered "away".
 *
 * 4. newData subscriptions: Used to initially extract callSign from the presence
 *    response. The subscription is immediately cancelled after the first
 *    invocation.
 *
 * Note: The client callSign is not part of the SSE payload as it's client-specific.
 * It's primarily used by LiveNetReactiveStore for making client-specific data readily
 * available in data structures.
 *
 * The client property is a promise for use in LiveNetReactiveStore (callsign is passed
 * to LiveNetReactiveStore constructor). This allows for non-blocking execution, as the
 * promise will likely have resolved by the time it's needed.
 */

export class Presence {
    protected readonly ep: EndPointClient;
    protected readonly store: LiveNetPresenceReactiveStore;
    public readonly client: Promise<Client>;
    private lastResume = Date.now(); // avoid immediate resume

    constructor(protected npid: NPID) {
        // redirectOnNotFound is set to '/views/dashboard', to handle homepage return on net-close
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
        // The compensatory scheduler in ReactiveStore (via Looper) reduces the need to aggressively contact the presence endpoint.
        // Adding these event listeners helps if the client regains presence early in a polling cycle.
        this.addResumeEventListener(document, 'visibilitychange', () => document.visibilityState === 'visible');
        this.addResumeEventListener(window, 'focus');
        this.addResumeEventListener(window, 'pageshow', (event?: Event) => (event as PageTransitionEvent).persisted);
    }

    private addResumeEventListener(
        target: Document | Window,
        eventName: keyof DocumentEventMap | keyof WindowEventMap,
        condition: (event?: Event) => boolean = () => true
    ) {
        target.addEventListener(eventName, event => {
            if (condition(event)) {
                this.handleResume(eventName);
            }
        });
    }

    private handleResume = (listenerName: keyof DocumentEventMap | keyof WindowEventMap) => {
        //This buffer % should come form flexOpts eventually (common between this file, realtimeClients.ts, liveNetController.js and frequency.js)
        const AWAY_BUFFER_PCT = 20;
        const adjustedAwayInMs = serverInfo.awayInMs * (1 - AWAY_BUFFER_PCT / 100); // 80% of awayInMs

        if (Date.now() - this.lastResume < adjustedAwayInMs) {
            // 80% of awayInMs has not passed since last resume
            return;
        }

        logger.info(`Signaling presence on ${listenerName} event`);
        this.ep.show().catch(error => {
            logger.error('Error while contacting presence endpoint:', error);
        });

        this.lastResume = Date.now();
    };

    private clientSubscription() {
        return new Promise<Client>(resolve => {
            const self = this;
            this.store.subscribe({
                uuid: generateUUID(),
                async newData() {
                    //We only run once:
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
