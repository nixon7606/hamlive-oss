import { EndPointClient, getNpid, initAndLogError } from '#@client/lib/clientUtils.js';
import { LiveNetReactiveStore, FavoritesReactiveStore } from '#@client/lib/stores.js';
import { Presence } from '#@client/lib/presence.js';
import { SystemNotificationManager } from '#@client/lib/systemNotifications.js';
import { ChatWidget } from '#@client/lib/chat.js';
import { StateList, StateCount, StatsTable, NetDetails, NetNotes, NetStartProgress, NetControlUsage, NetControlForm, NetControlPanel, NetControlButton, StationTable, StationRow, AvatarCell, CallSignCell, NameCell, SigReportCell, FavoriteInsert, AutoScrollInsert, HandInsert, ButtonBar, NetworkStatus } from '#@client/lib/widgets.js';
const NPID = getNpid();
const { client } = new Presence(NPID);
const livenetEp = new EndPointClient('/api/data/livenets').id(NPID.toString()).p('capturePresence', 'false');
const liveNetStore = new LiveNetReactiveStore(livenetEp, true);
const favoritesEp = new EndPointClient('/api/data/follow');
const favoritesStore = new FavoritesReactiveStore(favoritesEp, false);
void initAndLogError(() => StatsTable.init());
void initAndLogError(() => NetworkStatus.init());
void initAndLogError(() => AutoScrollInsert.init());
void initAndLogError(() => StateList.init(liveNetStore));
void initAndLogError(() => StateCount.init(liveNetStore));
void initAndLogError(() => NetNotes.init(liveNetStore));
void initAndLogError(() => NetDetails.init(liveNetStore));
void initAndLogError(() => NetStartProgress.init(liveNetStore));
void initAndLogError(() => NetControlForm.init(liveNetStore));
void initAndLogError(() => NetControlPanel.init(liveNetStore));
void initAndLogError(() => NetControlButton.init(liveNetStore));
void initAndLogError(() => FavoriteInsert.init(favoritesStore));
void initAndLogError(() => HandInsert.init(liveNetStore));
void initAndLogError(() => ButtonBar.init(liveNetStore));
await Promise.all([
    initAndLogError(() => AvatarCell.init(liveNetStore)),
    initAndLogError(() => CallSignCell.init(liveNetStore)),
    initAndLogError(() => NameCell.init(liveNetStore)),
    initAndLogError(() => SigReportCell.init(liveNetStore))
]);
await initAndLogError(() => StationRow.init(liveNetStore));
void initAndLogError(() => StationTable.init(liveNetStore));
void initAndLogError(async () => {
    const notificationManager = new SystemNotificationManager();
    await notificationManager.checkAndDisplayNotifications();
});
void initAndLogError(() => liveNetStore.init(client));
void initAndLogError(() => favoritesStore.init());
const { level } = await client;
void initAndLogError(() => NetControlUsage.init(liveNetStore));
void initAndLogError(() => ChatWidget.init(liveNetStore, level));
//# sourceMappingURL=main.js.map