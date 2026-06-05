/* hamlive-oss — MIT License. See LICENSE. */

import { EndPointClient, initAndLogError } from '#@client/lib/clientUtils.js';
import { FavoritesReactiveStore } from '#@client/lib/stores.js';
import { FavoriteInsert, FavoritesList } from '#@client/lib/widgets.js';
import { SystemNotificationManager } from '#@client/lib/systemNotifications.js';

// Check for system notifications
void initAndLogError(async () => {
    const notificationManager = new SystemNotificationManager();
    await notificationManager.checkAndDisplayNotifications();
});

// Assign endpoint to store
const favoritesEp = new EndPointClient('/api/data/follow');
const favoritesStore = new FavoritesReactiveStore(favoritesEp);

// Initialize Widgets
await initAndLogError(() => FavoriteInsert.init(favoritesStore));
void initAndLogError(() => FavoritesList.init(favoritesStore));

// Initialize FavoritesStore
void initAndLogError(() => favoritesStore.init());
