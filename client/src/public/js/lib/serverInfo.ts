/* hamlive-oss — MIT License. See LICENSE. */

import { ServerInfo } from '#@client/types/commonTypes.js';
import { isServerInfo } from '#@client/types/commonTypesupport.js';

export const serverInfo: Readonly<ServerInfo> = (() => {
    const metaElem = document.querySelector<HTMLElement>('#serverInfo');

    if (!metaElem) {
        throw new Error('serverInfo() could not find HTMLElement with id #serverInfo');
    }

    const { dataset } = metaElem;

    if (!(typeof dataset['ts'] === 'string')) {
        throw new Error(`serverInfo(): expected ts string for parseInt(), but received ${dataset['ts']}`);
    }

    const si = {
        ...dataset,
        // nodeEnv and logLevel are intentionally NOT exposed in the server-info
        // <meta> (not a client concern; dropped for hardening). Default them to
        // safe values here so their absence — or an empty LOG_LEVEL — can never
        // fail validation and take down all page JS (which breaks login, etc.).
        nodeEnv: dataset['nodeEnv'] === 'development' ? 'development' : 'production',
        logLevel: dataset['logLevel'] === 'debug' ? 'debug' : 'info',
        requestRateFactor: parseInt(dataset['requestRateFactor'] || '5'),
        httpClientTimeout: parseInt(dataset['httpClientTimeout'] || '2000'),
        awayInMs: parseInt(dataset['awayInMs'] || '20000'),
        isLoggedIn: dataset['isLoggedIn'] === 'true',
        newAccount: dataset['newAccount'] === 'true',
        okToAdvertise: dataset['okToAdvertise'] === 'true',
        callSign: dataset['callSign'] || null,
        userId: dataset['userId'] || null,
        displayName: dataset['displayName'] || null,
        chat: dataset['chat'] === 'true',
        analytics: dataset['analytics'] === 'true',
        ts: new Date(parseInt(dataset['ts']))
    };

    //Test
    if (isServerInfo(si)) {
        if (si.nodeEnv === 'development') {
            console.table(si);
        } else {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { okToAdvertise, ...rest } = si;
            console.table(rest);
        }

        return si;
    } else {
        throw new Error('serverInfo(): serverInfo type validation error');
    }
})();
