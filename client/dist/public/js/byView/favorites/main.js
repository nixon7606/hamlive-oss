import { EndPointClient, initAndLogError } from '#@client/lib/clientUtils.js';
import { FavoritesReactiveStore } from '#@client/lib/stores.js';
import { FavoriteInsert, FavoritesList } from '#@client/lib/widgets.js';
import { SystemNotificationManager } from '#@client/lib/systemNotifications.js';
void initAndLogError(async () => {
    const notificationManager = new SystemNotificationManager();
    await notificationManager.checkAndDisplayNotifications();
});
const favoritesEp = new EndPointClient('/api/data/follow');
const favoritesStore = new FavoritesReactiveStore(favoritesEp);
await initAndLogError(() => FavoriteInsert.init(favoritesStore));
void initAndLogError(() => FavoritesList.init(favoritesStore));
void initAndLogError(() => favoritesStore.init());
//# sourceMappingURL=main.js.map