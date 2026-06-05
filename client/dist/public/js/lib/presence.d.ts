import { Client, NPID } from '#@client/types/commonTypes.js';
import { EndPointClient } from '#@client/lib/clientUtils.js';
import { LiveNetPresenceReactiveStore } from '#@client/lib/stores.js';
export declare class Presence {
    protected npid: NPID;
    protected readonly ep: EndPointClient;
    protected readonly store: LiveNetPresenceReactiveStore;
    readonly client: Promise<Client>;
    private lastResume;
    constructor(npid: NPID);
    private addResumeEventListener;
    private handleResume;
    private clientSubscription;
}
//# sourceMappingURL=presence.d.ts.map