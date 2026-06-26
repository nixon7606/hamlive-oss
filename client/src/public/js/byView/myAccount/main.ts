// @ts-nocheck
/* hamlive-oss — MIT License. See LICENSE. */

import { HttpClient, FormState } from '#@client/lib/old__clientUtils.js';

const userProfileFormState = new FormState('userprofile', 'new');
const userProfileApi = new HttpClient('userprofile', '/api/data/userprofiles');
const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const consent_modal = new bootstrap.Modal(document.getElementById('consent_modal'));

// Server-side maxlength for `location` (see server/dist/models/userProfile.js).
// QRZ auto-fill sets the field's value programmatically, which bypasses the
// input's HTML maxlength, so we truncate here as a hard backstop.
const LOCATION_MAX = 60;

// Show a server-provided validation message (duplicate callsign, location too
// long, …) in a prominent popup. Falls back silently if the modal is absent.
function showValidationPopup(message: string) {
    const el = document.getElementById('validation_modal');
    if (!el) return;
    const body = document.getElementById('validation_modal_body');
    if (body) body.textContent = message;
    bootstrap.Modal.getOrCreateInstance(el).show();
}

function getConsent(done) {
    consent_modal.show();

    document.getElementById('consent_accept').addEventListener('click', () => {
        consent_modal.hide();
        done(true);
    });

    document.getElementById('consent_decline').addEventListener('click', () => {
        consent_modal.hide();
        done(false);
    });
}

function lookupLocationFromCallSign(callSign: string, targetInput?: HTMLInputElement) {
    if (!callSign || callSign.length < 3) return;

    const el = targetInput || (document.getElementById('input_location') as HTMLInputElement);
    const btn = document.getElementById('qr_lookup_btn') as HTMLButtonElement;

    el.value = '';
    el.placeholder = 'Looking up...';
    userProfileFormState.mesg('info', `Looking up ${callSign} on QRZ...`);
    if (btn) btn.disabled = true;

    const savedCallSign = callSign;

    axios
        .get(`/api/util/qrz-location?callsign=${encodeURIComponent(callSign)}`)
        .then(result => {
            // Guard against stale response if user changed callsign during lookup
            const currentCallSign = ((document.getElementById('input_callsign') as HTMLInputElement)?.value || '').toUpperCase();
            if (currentCallSign !== savedCallSign.toUpperCase()) {
                el.placeholder = 'Location ...';
                userProfileFormState.mesg('info', 'Callsign changed during lookup — skipped');
                if (btn) btn.disabled = false;
                return;
            }

            if (result.data && result.data.location) {
                el.value = String(result.data.location).slice(0, LOCATION_MAX);
                userProfileFormState.mesg('info', `Location: ${el.value} (from QRZ)`);
            } else {
                el.placeholder = 'Location ...';
                userProfileFormState.mesg('info', 'No location found on QRZ — enter manually');
            }
        })
        .catch(error => {
            el.placeholder = 'Location ...';
            const msg = error.response?.data?.errorMessage || error.message || 'Unknown error';
            userProfileFormState.mesg('error', `QRZ lookup failed: ${msg}`);
            console.error('QRZ lookup error', msg);
        })
        .finally(() => {
            if (btn) btn.disabled = false;
        });
}

userProfileApi.index().then((userProfile: any) => {
    // Auto-lookup QRZ location when user has a callsign but no location
    if (userProfile.data.callSign && (!userProfile.data.location || userProfile.data.location === '')) {
        lookupLocationFromCallSign(userProfile.data.callSign);
    }

    if (userProfile.data.policyConsent) {
        if (userProfile.data.newAccount) {
            userProfileFormState.mode = 'new';
            userProfileFormState.mesg('info', 'Callsign Required for Net Attendance');
            (document.getElementById('input_display_name') as HTMLInputElement).value = userProfile.data.displayName;
            (document.getElementById('input_id') as HTMLInputElement).value = userProfile.data._id;
        } else {
            userProfileFormState.mode = 'edit';

            if (userProfile.data.flaggedForDeletion) {
                userProfileFormState.mesg('error', 'Account Flagged For Deletion');
            }

            (document.getElementById('input_display_name') as HTMLInputElement).value = userProfile.data.displayName;
            (document.getElementById('input_callsign') as HTMLInputElement).value = userProfile.data.callSign;
            (document.getElementById('input_location') as HTMLInputElement).value = userProfile.data.location || '';
            (document.getElementById('input_id') as HTMLInputElement).value = userProfile.data._id;
        }

        if (urlParams.has('cswarn')) {
            userProfileFormState.mesg('error', 'Callsign Required for Net Attendance');
        }
    } else {
        getConsent(consent => {
            if (consent) {
                userProfileFormState.mode = 'new';
                userProfileFormState.mesg('info', 'Callsign Required for Net Attendance');
                (document.getElementById('input_display_name') as HTMLInputElement).value = userProfile.data.displayName;
                (document.getElementById('input_id') as HTMLInputElement).value = userProfile.data._id;

                userProfileApi
                    .update(
                        {
                            policyConsent: true
                        },
                        userProfile.data._id
                    )
                    .then((req: any) => {
                        console.debug('PATCH-ed Policy Consent: true');
                        userProfileFormState.mesg('info', 'policy consent saved');

                        if (typeof gtag === 'function') {
                            console.debug(`send analytics`);

                            gtag('event', 'sign_up');
                        }

                        const locationElem = document.getElementById('input_location') as HTMLInputElement;
                        const callSignElem = document.getElementById('input_callsign') as HTMLInputElement;

                        if ((!locationElem.value || locationElem.value.length === 0) && callSignElem && callSignElem.value) {
                            lookupLocationFromCallSign(callSignElem.value, locationElem);
                        }
                    })
                    .catch((error: any) => {
                        if (error.response.data.errorMessage) {
                            userProfileFormState.mesg('error', error.response.data.errorMessage);
                            console.error(error.response.data.errorMessage);
                        } else {
                            userProfileFormState.mesg('error', 'error');
                        }

                        console.error('Error', error.message);
                    });
            } else {
                userProfileApi
                    .delete(userProfile.data._id)
                    .then((req: any) => {
                        console.debug('deleted');
                        userProfileFormState.mesg('error', 'deleted');

                        if (typeof gtag === 'function') {
                            console.debug(`send analytics`);

                            gtag('event', 'consent_declined');
                        }

                        setTimeout(() => {
                            window.location.replace('/logout');
                        }, 3500);
                    })
                    .catch((error: any) => {
                        if (error.response.data.errorMessage) {
                            userProfileFormState.mesg('error', error.response.data.errorMessage);
                            console.error(error.response.data.errorMessage);
                        } else {
                            userProfileFormState.mesg('error', 'error');
                        }

                        console.error('Error', error.message);
                    });
            }
        });
    }
});

// Auto-lookup QRZ location as soon as a valid callsign is entered
let callsignDebounce: ReturnType<typeof setTimeout>;
(document.getElementById('input_callsign') as HTMLInputElement)?.addEventListener('input', function (this: HTMLInputElement) {
    clearTimeout(callsignDebounce);
    const callSign = this.value.trim().toUpperCase();
    if (callSign.length < 3) return;

    callsignDebounce = setTimeout(() => {
        const locationEl = document.getElementById('input_location') as HTMLInputElement;
        lookupLocationFromCallSign(callSign, locationEl);
    }, 500); // 500ms debounce — one API call after they stop typing
});

// Hook up the QRZ lookup button
(document.getElementById('qr_lookup_btn') as HTMLButtonElement)?.addEventListener('click', function () {
    const callSignEl = document.getElementById('input_callsign') as HTMLInputElement;
    if (!callSignEl || !callSignEl.value || callSignEl.value.length < 3) {
        userProfileFormState.mesg('error', 'Enter a callsign first');
        return;
    }
    lookupLocationFromCallSign(callSignEl.value);
});

document.getElementById('userprofile_form')!.addEventListener('submit', (e: Event) => {
    e.preventDefault();

    const formDataToSend = new FormData(document.getElementById('userprofile_form') as HTMLFormElement);

    const id = (document.getElementById('input_id') as HTMLInputElement).value;

    const dataPayload = {
        displayName: formDataToSend.get('display_name') as string,
        callSign: formDataToSend.get('callsign') as string,
        location: formDataToSend.get('location') as string,
        newAccount: false
    };

    console.log('Data Payload Sending:', dataPayload);

    // Show loading state
    const saveBtn = document.getElementById('userprofile_form')!.querySelector('button[type="submit"]') as HTMLButtonElement;
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    userProfileApi
        .update(dataPayload, id)
        .then((req: any) => {
            console.debug('Update: ', req);
            saveBtn.textContent = 'Saved!';
            setTimeout(() => {
                window.location.replace('/views/dashboard');
            }, 500);
        })
        .catch((error: any) => {
            if (error.response.data.errorMessage) {
                userProfileFormState.mesg('error', error.response.data.errorMessage);
                showValidationPopup(error.response.data.errorMessage);
                console.error(error.response.data.errorMessage);
            } else {
                userProfileFormState.mesg('error', 'error');
            }

            console.error('Error', error.message);

            // Restore save button
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;

            setTimeout(() => {
                userProfileFormState.mode = 'edit';
            }, 15000);
        });
});
