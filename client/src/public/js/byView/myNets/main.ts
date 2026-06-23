// @ts-nocheck
/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

tinymce.init({
    selector: 'textarea#input_notes',
    skin_url: '/tinymce/skins/hl',
    content_css: 'dark',
    plugins: 'lists',
    toolbar: 'bullist italic',
    menubar: '',
    statusbar: false,
    promotion: false,
    max_height: 235
});

import { HttpClient, FormState } from '#@client/lib/old__clientUtils.js';

const netProfileFormState = new FormState('netprofile', 'new');
const netOwnerFormState = new FormState('netowner', 'new');
const netProfileApi = new HttpClient('netprofile', '/api/data/netprofiles');

document.getElementById('netprofile_reset_btn')?.addEventListener('click', () => {
    netProfileFormState.mode = 'new';
    (window as any).modeHandler();
    (document.getElementById('input_schedule_enabled') as HTMLInputElement).checked = false;
    (document.getElementById('schedule_settings') as HTMLElement).style.display = 'none';
});
document.getElementById('netowner_reset_btn')?.addEventListener('click', () => {
    netOwnerFormState.mode = 'new';
});
// Mode dropdown toggles required/optional fields. Wired here (not inline onchange)
// because the CSP (script-src-attr 'none') blocks inline event-handler attributes.
document.getElementById('input_mode')?.addEventListener('change', () => {
    (window as any).modeHandler();
});

//Once we moved to es6 module imports, functions defined in modules are in their own namespace. In order to be accessible by
//things like onClick(), the functions needed to be exposed to 'window':
(window as any).netProfileFormState = netProfileFormState;
//That said, I really should do away with the onClick() stuff and write event handlers for this
//See: https://stackoverflow.com/questions/44590393/es6-modules-undefined-onclick-function-after-import
//
// Brief desc of:
// netListColumn-->netListContainer-->netListUL
//
// The Column is hidden/unhidden based on if there
// is actual netlist data returned from the server
//
// The Container simply is the parent of the netListUL
//
// The UL is made every time the list is retreived

(window as any).formShow = function (id: string) {
    const netProfileDivElem = document.getElementById('formContainerNetProfile')!;
    const netProfilecurrentClass = netProfileDivElem.getAttribute('class')!;

    const netOwnerDivElem = document.getElementById('formContainerNetOwner')!;
    const netOwnerCurrentClass = netOwnerDivElem.getAttribute('class')!;

    if (id === 'formContainerNetProfile') {
        netProfileDivElem.setAttribute('class', netProfilecurrentClass.replace(' d-none', ''));

        if (!netOwnerCurrentClass.includes('d-none')) {
            netOwnerDivElem.setAttribute('class', netOwnerCurrentClass + ' d-none');
        }
    } else if (id === 'formContainerNetOwner') {
        netOwnerDivElem.setAttribute('class', netOwnerCurrentClass.replace(' d-none', ''));

        if (!netProfilecurrentClass.includes('d-none')) {
            netProfileDivElem.setAttribute('class', netProfilecurrentClass + ' d-none');
        }
    } else {
        console.error('formShow function received unknown form id');
    }
};

(window as any).modeHandler = function () {
    const mode = (document.getElementById('input_mode') as HTMLSelectElement).value;
    const modeDetailsInputElem = document.getElementById('input_modedetails') as HTMLInputElement;
    const isNewMode = netProfileFormState.mode === 'new';

    modeDetailsInputElem.required = mode === 'CUSTOM';

    if (isNewMode && (mode === 'CUSTOM' || mode === 'Reflector')) {
        const message =
            mode === 'CUSTOM'
                ? 'use mode details field to specify mode name'
                : 'use mode details field to specify reflector name';
        netProfileFormState.mesg('info', message);
    }
};

function refreshNetList() {
    //clear prior UL 'netList'
    const oldList = document.getElementById('netList');
    if (oldList) oldList.remove();

    // netListContainerElem is the parent of netListUlElem,
    // we create the UL each time and append to the div
    // container

    const netListContainerElem = document.getElementById('netListContainer')!;

    if (!(netListContainerElem as any)._hlDelegated) {
        (netListContainerElem as any)._hlDelegated = true;
        netListContainerElem.addEventListener('click', (e: Event) => {
            const el = (e.target as HTMLElement).closest('[data-net-action]') as HTMLElement | null;
            if (!el || !netListContainerElem.contains(el)) return;
            const id = el.getAttribute('data-net-id') as string;
            switch (el.getAttribute('data-net-action')) {
                case 'edit':
                    e.preventDefault();
                    (window as any).netProfileEditByID(id);
                    (window as any).formShow('formContainerNetProfile');
                    break;
                case 'delete':
                    e.preventDefault();
                    (window as any).netProfileDelByID(id);
                    (window as any).formShow('formContainerNetProfile');
                    break;
                case 'coowner':
                    e.preventDefault();
                    (window as any).netOwnerFormPrep(id, el.getAttribute('data-net-title') || '');
                    (window as any).formShow('formContainerNetOwner');
                    break;
                case 'start-live':
                    location.href = `/views/livenet/${id}`;
                    break;
            }
        });
    }

    // get all netprofiles from server:
    netProfileApi
        .index()
        .then((netProfiles: any) => {
            console.table(netProfiles.data);

            // create our UL from current netprofiles data
            const netListUlElem = document.createElement('ul');
            netListUlElem.setAttribute('id', 'netList');
            netListUlElem.setAttribute('class', 'list-unstyled');

            const netListColumnElem = document.getElementById('netListColumn')!;
            const currentClass = netListColumnElem.getAttribute('class')!;
            // use bootstrap to set display:none when there are no
            // items in the list (allowing form to move left)

            if (!Array.isArray(netProfiles.data.netlist)) throw new Error('expected netlist to be an array');

            if (netProfiles.data.netlist.length < 1) {
                netListColumnElem.setAttribute('class', currentClass + ' d-none');
            }
            if (netProfiles.data.netlist.length > 0) {
                netListColumnElem.setAttribute('class', currentClass.replace(' d-none', ''));
            }

            netProfiles.data.netlist.forEach((netProfile: any) => {
                // Defensive: skip any null/empty entry (e.g. a dangling myNets
                // ref to a deleted net) so one bad row can't crash the page.
                if (!netProfile || !netProfile._id) return;
                //For each net profile, construct a list item and create
                // a net start modal

                // BEGIN MODALS:
                const modalCollectionElem = document.getElementById('modal-collection')!;
                const modalTemplateElem = document.getElementById('modal-template') as HTMLTemplateElement;
                const modalClone = modalTemplateElem.cloneNode(true) as HTMLElement;
                modalClone.id = `modal-${netProfile._id}`;
                // Clone master modal template:
                const modalLabelElem = modalClone.querySelector('#modalNetStart')!;
                modalLabelElem.textContent = `${netProfile.title}: going LIVE!`;

                //Modal "Net Start" Form
                const netStartFormElem = modalClone.querySelector('#netstart_form') as HTMLFormElement;
                const netStartFormOutputElem = modalClone.querySelector('#netstart_form_output')!;
                netStartFormElem.setAttribute('id', `netstart_form-${netProfile._id}`);

                netStartFormElem.addEventListener('submit', (e: Event) => {
                    e.preventDefault();

                    const formDataToSend = new FormData(netStartFormElem);
                    const liveNetApi = new HttpClient('livenet', `/api/data/livenets/${netProfile._id}`);

                    const dataPayload = {
                        countdownTimer: formDataToSend.get('countdown-timer')
                    };

                    liveNetApi
                        .create(dataPayload)
                        .then((req: any) => {
                            console.debug('livenet controller response', req);

                            if (typeof gtag === 'function') {
                                console.debug(`send analytics`);

                                gtag('event', 'net_start', {
                                    event_category: 'net_actions',
                                    event_label: `${netProfile.title}`,
                                    event_callback: function () {
                                        window.location.replace(req.data.url);
                                    }
                                });

                                setTimeout(() => {
                                    //redir anyway (if browser blocks tracking (gtag above))
                                    window.location.replace(req.data.url);
                                }, 1000);
                            } else {
                                window.location.replace(req.data.url);
                            }
                        })
                        .catch((error: any) => {
                            if (error.response.data.errorMessage) {
                                netStartFormOutputElem.setAttribute('class', 'text-danger');
                                netStartFormOutputElem.textContent = error.response.data.errorMessage;
                                console.error(error.response.data.errorMessage);
                            } else {
                                netStartFormOutputElem.setAttribute('class', 'text-danger');
                                netStartFormOutputElem.textContent = error;
                                console.error(error);
                            }
                        });
                });

                modalCollectionElem.appendChild(modalClone);

                // END MODALS

                // BEGIN LIST ITEM CONSTRUCTION
                const liElem = document.createElement('li');
                const buttonStartElem = document.createElement('button');
                const aEditElem = document.createElement('a');
                const aDeleteElem = document.createElement('a');
                const aNetOwnerElem = document.createElement('a');

                if (!netProfile.liveNet) {
                    buttonStartElem.setAttribute('class', 'btn btn-small btn-outline-secondary');
                    buttonStartElem.setAttribute('data-bs-toggle', 'modal');
                    buttonStartElem.setAttribute('data-bs-target', `#modal-${netProfile._id}`);
                } else {
                    buttonStartElem.setAttribute('class', 'btn btn-small btn-outline-danger');
                    buttonStartElem.setAttribute('data-net-action', 'start-live');
                    buttonStartElem.setAttribute('data-net-id', netProfile._id);
                }

                const iconElem = document.createElement('i');
                iconElem.setAttribute('class', 'bi bi-power');
                buttonStartElem.appendChild(iconElem);
                liElem.appendChild(buttonStartElem);
                liElem.append(' ');
                liElem.append(netProfile.title);
                liElem.setAttribute('class', 'text-light');

                const smallElem = document.createElement('small');
                smallElem.setAttribute('class', 'text-muted');
                liElem.appendChild(smallElem);
                smallElem.append(' (');
                aEditElem.setAttribute('href', '#');
                aEditElem.setAttribute('data-net-action', 'edit');
                aEditElem.setAttribute('data-net-id', netProfile._id);
                aEditElem.textContent = 'edit';
                smallElem.appendChild(aEditElem);
                smallElem.append(') ');

                if (!netProfile.liveNet) {
                    smallElem.append(' (');
                    aDeleteElem.setAttribute('href', '#');
                    aDeleteElem.setAttribute('data-net-action', 'delete');
                    aDeleteElem.setAttribute('data-net-id', netProfile._id);
                    aDeleteElem.textContent = 'delete';
                    smallElem.appendChild(aDeleteElem);
                    smallElem.append(') ');
                }

                smallElem.append(' (');
                aNetOwnerElem.setAttribute('href', '#');
                aNetOwnerElem.setAttribute('data-net-action', 'coowner');
                aNetOwnerElem.setAttribute('data-net-id', netProfile._id);
                aNetOwnerElem.setAttribute('data-net-title', netProfile.title);
                aNetOwnerElem.textContent = '+co-owner';
                smallElem.appendChild(aNetOwnerElem);
                smallElem.append(') ');

                // END LIST ITEM CONSTRUCTION
                netListUlElem.append(liElem);
                // add newly formed UL to container div
                netListContainerElem.append(netListUlElem);
            });
        })
        .catch((err: any) => {
            console.error(err);
        });
}

(window as any).netOwnerFormPrep = function (id: string, name: string) {
    document.getElementById('netowner_form_title')!.textContent = `Additional Owner for ${name}`;
    (document.getElementById('input_npid_for_netowner') as HTMLInputElement).value = id;
    netOwnerFormState.mesg('info', 'enter email address');
};

//called by netlist "edit" link
(window as any).netProfileEditByID = async function (id: string) {
    const res = await netProfileApi.show(id);
    console.debug('Retreived record to edit: ', res.data);
    netProfileFormState.mode = 'edit';

    (document.getElementById('input_title') as HTMLInputElement).value = res.data.title;
    (document.getElementById('input_frequency') as HTMLInputElement).value = res.data.frequency;
    (document.getElementById('input_mode') as HTMLSelectElement).value = res.data.mode;
    (document.getElementById('input_restricted_sigrep') as HTMLInputElement).checked = res.data?.restrictedSigReports ? true : false;
    (document.getElementById('input_auto_in') as HTMLInputElement).checked = res.data?.autoIn ? true : false;
    (document.getElementById('input_modedetails') as HTMLInputElement).value = res.data.modeDetails;
    tinymce.get('input_notes').setContent(res.data.notes);

    (document.getElementById('input_npid_for_netprofile') as HTMLInputElement).value = res.data._id;
    (window as any).modeHandler();

    const sched = res.data.schedule;
    const schedEnabledEl = document.getElementById('input_schedule_enabled') as HTMLInputElement;
    const schedSettingsEl = document.getElementById('schedule_settings') as HTMLElement;
    if (sched && sched.enabled) {
        schedEnabledEl.checked = true;
        schedSettingsEl.style.display = 'block';
        (document.getElementById('input_schedule_dow') as HTMLSelectElement).value = String(sched.dayOfWeek ?? 0);
        if (sched.hour !== undefined && sched.minute !== undefined) {
            (document.getElementById('input_schedule_time') as HTMLInputElement).value =
                `${String(sched.hour).padStart(2, '0')}:${String(sched.minute).padStart(2, '0')}`;
        }
        (document.getElementById('input_schedule_tz') as HTMLSelectElement).value = sched.timezone || 'America/Denver';
        (document.getElementById('input_schedule_notify') as HTMLInputElement).value = String(sched.notifyBeforeMinutes ?? 30);
    } else {
        schedEnabledEl.checked = false;
        schedSettingsEl.style.display = 'none';
    }
};

//called by netlist "delete" link
(window as any).netProfileDelByID = async function (id: string) {
    const res = await netProfileApi.delete(id);
    console.debug(res.data);
    refreshNetList();
};

// main form handler (for POST and PATCH methods)
function np_submitHandler(e: Event) {
    e.preventDefault();

    const formDataToSend = new FormData(document.getElementById('netprofile_form') as HTMLFormElement);

    const id = (document.getElementById('input_npid_for_netprofile') as HTMLInputElement).value;

    const dataPayload = {
        title: formDataToSend.get('title') as string,
        frequency: formDataToSend.get('frequency') as string,
        mode: formDataToSend.get('mode') as string,
        restrictedSigReports: formDataToSend.get('restricted_sigrep') ? true : false,
        autoIn: formDataToSend.get('auto_in') ? true : false,
        notes: tinymce.get('input_notes').getContent(),
        modeDetails: formDataToSend.get('modedetails') as string
    };

    const schedEnabled = document.getElementById('input_schedule_enabled').checked;
        const tz = document.getElementById('input_schedule_tz').value;
        let schedule = { enabled: false, timezone: tz };
        if (schedEnabled) {
        const timeVal = (document.getElementById('input_schedule_time') as HTMLInputElement).value;
        let hour = 0, minute = 0;
        if (timeVal) { const p = timeVal.split(':'); hour = parseInt(p[0], 10); minute = parseInt(p[1], 10); }
        schedule = {
            dayOfWeek: parseInt((document.getElementById('input_schedule_dow') as HTMLSelectElement).value, 10),
            hour, minute,
            timezone: (document.getElementById('input_schedule_tz') as HTMLSelectElement).value,
            notifyBeforeMinutes: parseInt((document.getElementById('input_schedule_notify') as HTMLInputElement).value, 10) || 30,
            enabled: true
        };
    }
    (dataPayload as any).schedule = schedule;

    const form = document.getElementById('netprofile_form') as HTMLFormElement;
    const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;

    const isEdit = netProfileFormState.mode === 'edit';
    if (!isEdit && netProfileFormState.mode !== 'new') {
        console.error('No valid form mode for upload');
        return;
    }

    // Disable the button while the request is in flight so a second click can't
    // fire a duplicate create (which previously surfaced as a confusing
    // "net already named …" error).
    if (submitBtn) submitBtn.disabled = true;

    const request = isEdit ? netProfileApi.update(dataPayload, id) : netProfileApi.create(dataPayload);

    request
        .then((req: any) => {
            console.debug(isEdit ? 'Update: ' : 'Create: ', req);
            netProfileFormState.mesg('info', isEdit ? 'Net updated successfully' : 'Net created successfully');
            refreshNetList();
            // Reset the form for the next entry (clears fields so a re-submit
            // can't duplicate the net) and return to "new" mode.
            form.reset();
            try { tinymce.get('input_notes')?.setContent(''); } catch { /* editor may not be ready */ }
            (document.getElementById('input_npid_for_netprofile') as HTMLInputElement).value = '';
            (document.getElementById('input_schedule_enabled') as HTMLInputElement).checked = false;
            (document.getElementById('schedule_settings') as HTMLElement).style.display = 'none';
            netProfileFormState.mode = 'new';
            (window as any).modeHandler();
        })
        .catch((error: any) => {
            const msg = error?.response?.data?.errorMessage || error?.message || 'Save failed';
            netProfileFormState.mesg('error', msg);
            console.error(msg);
        })
        .finally(() => {
            if (submitBtn) submitBtn.disabled = false;
        });
}

function netowner_submitHandler(e: Event) {
    e.preventDefault();

    const formDataToSend = new FormData(document.getElementById('netowner_form') as HTMLFormElement);

    const id = formDataToSend.get('npid_for_netowner') as string;

    const dataPayload = {
        email: formDataToSend.get('email') as string
    };

    axios
        .post(`/api/data/netprofiles/addnetowner/${id}`, dataPayload)
        .then((req: any) => {
            console.debug('Adding Net Owner: ', req);
            netOwnerFormState.mesg('info', 'Success: User will see ownership of this net in their account also');
            setTimeout(() => {
                location.reload();
            }, 6500);
        })
        .catch((error: any) => {
            if (error.response.data.errorMessage) {
                netOwnerFormState.mesg('error', error.response.data.errorMessage);
                console.error(error.response.data.errorMessage);
            } else {
                netOwnerFormState.mesg('error', error);
                console.error(error);
            }
        });
}

document.getElementById('netprofile_form')!.addEventListener('submit', np_submitHandler);
document.getElementById('netowner_form')!.addEventListener('submit', netowner_submitHandler);

//init
(window as any).formShow('formContainerNetProfile');
refreshNetList();
netProfileFormState.mode = 'new';
netOwnerFormState.mode = 'new';

setTimeout(() => {
    if (netProfileFormState.mode === 'new') {
        tinymce
            .get('input_notes')
            .setContent(
                'Net Control should change this SAMPLE text to relevant info about the club/net. The contents here will be displayed to net attendees, momentarily, when the live net page loads<p>Echolink: XX#XX-L</p>\n<p><em>this is italicized</em></p>'
            );
    }
}, 2000);

/* ── Schedule toggle ── */

(document.getElementById('input_schedule_enabled') as HTMLInputElement).addEventListener('change', function (this: HTMLInputElement) {
    (document.getElementById('schedule_settings') as HTMLElement).style.display = this.checked ? 'block' : 'none';
});
