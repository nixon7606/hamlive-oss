/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

import { HttpClient, Looper, FavClient } from '#@client/lib/old__clientUtils.js';
import { serverInfo } from '#@client/lib/serverInfo.js';

(async function () {
    const id = window.location.pathname.split('/')[3];
    const netProfileDetailApi = new HttpClient('netProfileDetail', `/api/data/netprofiles/${id}`);
    const favorites = new FavClient(20000 / serverInfo.requestRateFactor, 4);
    const favIconElem = document.getElementById('fav-' + id);
    favIconElem.addEventListener('click', favorites.handler.bind(favorites));

    const loop = new Looper({
        label: 'Net polling',
        refresh: 20000 / serverInfo.requestRateFactor,
        exec: async ({ i }) => {
            const np = await netProfileDetailApi.index();
            document.getElementById('netTitle').innerText = `${np.data.title}`;

            favorites.interval(i);

            np.data.live === true && location.reload(true);
        }
    });

    try {
        await loop.run();
    } catch (error) {
        if (error.response?.data?.errorMessage) {
            console.error(error.response.data.errorMessage);
        } else {
            console.error(error);
        }
    }
})();
