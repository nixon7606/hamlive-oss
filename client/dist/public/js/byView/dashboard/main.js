/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

import { HttpClient, FavClient, Looper } from '#@client/lib/old__clientUtils.js';
import { serverInfo } from '#@client/lib/serverInfo.js';

(async function () {
    const liveNetApi = new HttpClient('livenet', '/api/data/livenets');
    const favorites = new FavClient(1000, 1);
    const rowCollectionElem = document.getElementById('dashItemsContainer');
    const rowTemplateElem = document.getElementById('netTemplate');
    let liveNetsLastHash;

    async function updateLiveNetsFromServer() {
        let liveNets;

        try {
            liveNets = await liveNetApi.index();
        } catch (error) {
            if (error.response?.data?.errorMessage) {
                console.error(error.response.data.errorMessage);
            } else {
                console.error(error);
            }
        }

        const delMe = document.querySelectorAll('.liveNetRow');

        if (!liveNets?.data) {
            return undefined;
        }

        if (liveNetsLastHash != liveNets.data.hash) {
            console.log('NEW Data, data signature changed');

            liveNets.data.netlist.forEach(liveNet => {
                if (!liveNet.closing) {
                    const rowTemplateClone = rowTemplateElem.cloneNode(true);
                    rowTemplateClone.id = `row-${liveNet.id}`;
                    rowTemplateClone.classList.add('liveNetRow');

                    const netTitleElem = rowTemplateClone.querySelector('#title');
                    const titleLinkElem = rowTemplateClone.querySelector('#title-link');
                    netTitleElem.innerText = liveNet.title;
                    const netFreqElem = rowTemplateClone.querySelector('#frequency');
                    const onAirImgElem = rowTemplateClone.querySelector('#onairimg');

                    const iconElem = rowTemplateClone.querySelector('.favicon');
                    iconElem.id = `fav-${liveNet.id}`;
                    if (liveNet.permanent) {
                        iconElem.classList.add('d-none');
                    }

                    if (!liveNet.frequency || parseInt(liveNet.frequency) == 0) {
                        liveNet.frequency = '';
                    }

                    netFreqElem.innerText =
                        liveNet.mode === 'CUSTOM'
                            ? `${liveNet.frequency} ${liveNet.modeDetails}`
                            : liveNet.mode === 'Reflector'
                              ? `${liveNet.modeDetails}`
                              : `${liveNet.frequency} ${liveNet.mode}`;

                    let startTime = new Date(liveNet.createdAt);

                    startTime.setMinutes(startTime.getMinutes() + liveNet.countdownTimer);

                    const startTimeElem = rowTemplateClone.querySelector('#startTime');

                    if (liveNet.started) {
                        startTimeElem.innerHTML = '[ <em>In Progress</em> ]';

                        if (liveNet.permanent === true) {
                            onAirImgElem.setAttribute('src', '/img/on-air-active2-locked.png');
                        } else {
                            onAirImgElem.setAttribute('src', '/img/on-air-active2.png');
                        }

                        onAirImgElem.classList.add('onair-glow');

                        // Replace 'text-muted' with 'text-light' using classList
                        titleLinkElem.classList.remove('text-muted');
                        titleLinkElem.classList.add('text-light');
                    } else {
                        startTimeElem.innerText = '@' + startTime.toLocaleTimeString([], { timeStyle: 'short' });
                    }

                    titleLinkElem.setAttribute('href', liveNet.url);
                    rowCollectionElem.appendChild(rowTemplateClone);
                }
            });

            delMe.forEach(div => {
                rowCollectionElem.removeChild(div);
            });

            document.querySelectorAll('.liveNetRow').forEach(row => {
                row.classList.remove('d-none');
            });

            return (liveNetsLastHash = liveNets.data.hash);
        } else {
            return undefined;
        }
    }

    rowCollectionElem.addEventListener('click', favorites.handler.bind(favorites));

    const loop = new Looper({
        label: 'Nets Update',
        refresh: 30000 / serverInfo.requestRateFactor,
        exec: async ({ i }) => {
            let sig;
            if (Boolean((sig = await updateLiveNetsFromServer()))) {
                console.debug(`updated dom for hash ${sig}`);
            }

            favorites.interval(i);
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
