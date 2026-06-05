/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

import { HttpClient } from '#@client/lib/old__clientUtils.js';

(async function () {
    const magicHttpClient = new HttpClient('magicLogin', `/auth/magiclogin`);

    document.getElementById('magic-auth').addEventListener('submit', async e => {
        e.preventDefault();

        const inputElem = e.target.querySelector('input');

        try {
            const { status, data } = await magicHttpClient.create({
                destination: inputElem.value
            });

            if (data.success) {
                // Local test drive: when email delivery is off, the server returns the
                // sign-in link directly so the user doesn't need to read server logs.
                if (data.devMagicLink) {
                    inputElem.setAttribute('class', 'form-control text-success small');
                    inputElem.value = 'Email not configured — use the link below';

                    const container = document.getElementById('dev-magic-link');
                    if (container) {
                        container.innerHTML = '';
                        const link = document.createElement('a');
                        link.href = data.devMagicLink;
                        link.textContent = 'Click here to finish signing in →';
                        link.setAttribute('class', 'btn btn-sm btn-success w-100');
                        container.appendChild(link);
                    }
                    return;
                }

                inputElem.setAttribute('class', 'border text-success border-success small form-control');

                inputElem.value = 'Mail sent';

                console.log(`Magic link code:${data.code}`);

                setTimeout(_ => {
                    inputElem.setAttribute('class', 'form-control small text-success');
                    inputElem.value = '(Check spam folder)';
                    setTimeout(() => {
                        inputElem.setAttribute('class', 'form-control text-primary');
                        inputElem.value = '';
                    }, 1200);
                }, 1500);
            }
        } catch (err) {
            inputElem.value = 'Error';
            inputElem.setAttribute('class', 'border text-danger border-danger form-control');

            setTimeout(_ => {
                inputElem.setAttribute('class', 'form-control');
                inputElem.value = '';
            }, 2500);

            console.error(err);
        }
    });
})();
