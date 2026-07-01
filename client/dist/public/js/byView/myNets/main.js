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
    window.modeHandler();
    document.getElementById('input_schedule_enabled').checked = false;
    document.getElementById('schedule_settings').style.display = 'none';
});
document.getElementById('netowner_reset_btn')?.addEventListener('click', () => {
    netOwnerFormState.mode = 'new';
});
document.getElementById('input_mode')?.addEventListener('change', () => {
    window.modeHandler();
});
window.netProfileFormState = netProfileFormState;
window.formShow = function (id) {
    const netProfileDivElem = document.getElementById('formContainerNetProfile');
    const netProfilecurrentClass = netProfileDivElem.getAttribute('class');
    const netOwnerDivElem = document.getElementById('formContainerNetOwner');
    const netOwnerCurrentClass = netOwnerDivElem.getAttribute('class');
    if (id === 'formContainerNetProfile') {
        netProfileDivElem.setAttribute('class', netProfilecurrentClass.replace(' d-none', ''));
        if (!netOwnerCurrentClass.includes('d-none')) {
            netOwnerDivElem.setAttribute('class', netOwnerCurrentClass + ' d-none');
        }
    }
    else if (id === 'formContainerNetOwner') {
        netOwnerDivElem.setAttribute('class', netOwnerCurrentClass.replace(' d-none', ''));
        if (!netProfilecurrentClass.includes('d-none')) {
            netProfileDivElem.setAttribute('class', netProfilecurrentClass + ' d-none');
        }
    }
    else {
        console.error('formShow function received unknown form id');
    }
};
window.modeHandler = function () {
    const mode = document.getElementById('input_mode').value;
    const modeDetailsInputElem = document.getElementById('input_modedetails');
    const isNewMode = netProfileFormState.mode === 'new';
    modeDetailsInputElem.required = mode === 'CUSTOM';
    if (isNewMode && (mode === 'CUSTOM' || mode === 'Reflector')) {
        const message = mode === 'CUSTOM'
            ? 'use mode details field to specify mode name'
            : 'use mode details field to specify reflector name';
        netProfileFormState.mesg('info', message);
    }
};
function refreshNetList() {
    const oldList = document.getElementById('netList');
    if (oldList)
        oldList.remove();
    const netListContainerElem = document.getElementById('netListContainer');
    if (!netListContainerElem._hlDelegated) {
        netListContainerElem._hlDelegated = true;
        netListContainerElem.addEventListener('click', (e) => {
            const el = e.target.closest('[data-net-action]');
            if (!el || !netListContainerElem.contains(el))
                return;
            const id = el.getAttribute('data-net-id');
            switch (el.getAttribute('data-net-action')) {
                case 'edit':
                    e.preventDefault();
                    window.netProfileEditByID(id);
                    window.formShow('formContainerNetProfile');
                    break;
                case 'delete':
                    e.preventDefault();
                    window.netProfileDelByID(id);
                    window.formShow('formContainerNetProfile');
                    break;
                case 'coowner':
                    e.preventDefault();
                    window.netOwnerFormPrep(id, el.getAttribute('data-net-title') || '');
                    window.formShow('formContainerNetOwner');
                    break;
                case 'start-live':
                    location.href = `/views/livenet/${id}`;
                    break;
            }
        });
    }
    netProfileApi
        .index()
        .then((netProfiles) => {
        console.table(netProfiles.data);
        const netListUlElem = document.createElement('ul');
        netListUlElem.setAttribute('id', 'netList');
        netListUlElem.setAttribute('class', 'list-unstyled');
        const netListColumnElem = document.getElementById('netListColumn');
        const currentClass = netListColumnElem.getAttribute('class');
        if (!Array.isArray(netProfiles.data.netlist))
            throw new Error('expected netlist to be an array');
        if (netProfiles.data.netlist.length < 1) {
            netListColumnElem.setAttribute('class', currentClass + ' d-none');
        }
        if (netProfiles.data.netlist.length > 0) {
            netListColumnElem.setAttribute('class', currentClass.replace(' d-none', ''));
        }
        netProfiles.data.netlist.forEach((netProfile) => {
            if (!netProfile || !netProfile._id)
                return;
            const modalCollectionElem = document.getElementById('modal-collection');
            const modalTemplateElem = document.getElementById('modal-template');
            const modalClone = modalTemplateElem.cloneNode(true);
            modalClone.id = `modal-${netProfile._id}`;
            const modalLabelElem = modalClone.querySelector('#modalNetStart');
            modalLabelElem.textContent = `${netProfile.title}: going LIVE!`;
            const netStartFormElem = modalClone.querySelector('#netstart_form');
            const netStartFormOutputElem = modalClone.querySelector('#netstart_form_output');
            netStartFormElem.setAttribute('id', `netstart_form-${netProfile._id}`);
            netStartFormElem.addEventListener('submit', (e) => {
                e.preventDefault();
                const formDataToSend = new FormData(netStartFormElem);
                const liveNetApi = new HttpClient('livenet', `/api/data/livenets/${netProfile._id}`);
                const dataPayload = {
                    countdownTimer: formDataToSend.get('countdown-timer')
                };
                liveNetApi
                    .create(dataPayload)
                    .then((req) => {
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
                            window.location.replace(req.data.url);
                        }, 1000);
                    }
                    else {
                        window.location.replace(req.data.url);
                    }
                })
                    .catch((error) => {
                    if (error.response.data.errorMessage) {
                        netStartFormOutputElem.setAttribute('class', 'text-danger');
                        netStartFormOutputElem.textContent = error.response.data.errorMessage;
                        console.error(error.response.data.errorMessage);
                    }
                    else {
                        netStartFormOutputElem.setAttribute('class', 'text-danger');
                        netStartFormOutputElem.textContent = error;
                        console.error(error);
                    }
                });
            });
            modalCollectionElem.appendChild(modalClone);
            const liElem = document.createElement('li');
            const buttonStartElem = document.createElement('button');
            const aEditElem = document.createElement('a');
            const aDeleteElem = document.createElement('a');
            const aNetOwnerElem = document.createElement('a');
            if (!netProfile.liveNet) {
                buttonStartElem.setAttribute('class', 'btn btn-small btn-outline-secondary');
                buttonStartElem.setAttribute('data-bs-toggle', 'modal');
                buttonStartElem.setAttribute('data-bs-target', `#modal-${netProfile._id}`);
            }
            else {
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
            netListUlElem.append(liElem);
            netListContainerElem.append(netListUlElem);
        });
    })
        .catch((err) => {
        console.error(err);
    });
}
window.netOwnerFormPrep = function (id, name) {
    document.getElementById('netowner_form_title').textContent = `Additional Owner for ${name}`;
    document.getElementById('input_npid_for_netowner').value = id;
    netOwnerFormState.mesg('info', 'enter email address');
};
window.netProfileEditByID = async function (id) {
    const res = await netProfileApi.show(id);
    console.debug('Retreived record to edit: ', res.data);
    netProfileFormState.mode = 'edit';
    document.getElementById('input_title').value = res.data.title;
    document.getElementById('input_frequency').value = res.data.frequency;
    document.getElementById('input_mode').value = res.data.mode;
    document.getElementById('input_restricted_sigrep').checked = res.data?.restrictedSigReports ? true : false;
    document.getElementById('input_auto_in').checked = res.data?.autoIn ? true : false;
    document.getElementById('input_modedetails').value = res.data.modeDetails;
    tinymce.get('input_notes').setContent(res.data.notes);
    document.getElementById('input_npid_for_netprofile').value = res.data._id;
    window.modeHandler();
    const sched = res.data.schedule;
    const schedEnabledEl = document.getElementById('input_schedule_enabled');
    const schedSettingsEl = document.getElementById('schedule_settings');
    if (sched && sched.enabled) {
        schedEnabledEl.checked = true;
        schedSettingsEl.style.display = 'block';
        document.getElementById('input_schedule_dow').value = String(sched.dayOfWeek ?? 0);
        if (sched.hour !== undefined && sched.minute !== undefined) {
            document.getElementById('input_schedule_time').value =
                `${String(sched.hour).padStart(2, '0')}:${String(sched.minute).padStart(2, '0')}`;
        }
        document.getElementById('input_schedule_tz').value = sched.timezone || 'UTC';
        document.getElementById('input_schedule_notify').value = String(sched.notifyBeforeMinutes ?? 30);
        document.getElementById('input_schedule_notify_enabled').checked =
            sched.notifyBeforeEnabled !== false;
    }
    else {
        schedEnabledEl.checked = false;
        schedSettingsEl.style.display = 'none';
    }
};
window.netProfileDelByID = async function (id) {
    const res = await netProfileApi.delete(id);
    console.debug(res.data);
    refreshNetList();
};
function np_submitHandler(e) {
    e.preventDefault();
    const formDataToSend = new FormData(document.getElementById('netprofile_form'));
    const id = document.getElementById('input_npid_for_netprofile').value;
    const dataPayload = {
        title: formDataToSend.get('title'),
        frequency: formDataToSend.get('frequency'),
        mode: formDataToSend.get('mode'),
        restrictedSigReports: formDataToSend.get('restricted_sigrep') ? true : false,
        autoIn: formDataToSend.get('auto_in') ? true : false,
        notes: tinymce.get('input_notes').getContent(),
        modeDetails: formDataToSend.get('modedetails')
    };
    const schedEnabled = document.getElementById('input_schedule_enabled').checked;
    const tz = document.getElementById('input_schedule_tz').value;
    let schedule = { enabled: false, timezone: tz };
    if (schedEnabled) {
        const timeVal = document.getElementById('input_schedule_time').value;
        let hour = 0, minute = 0;
        if (timeVal) {
            const p = timeVal.split(':');
            hour = parseInt(p[0], 10);
            minute = parseInt(p[1], 10);
        }
        schedule = {
            dayOfWeek: parseInt(document.getElementById('input_schedule_dow').value, 10),
            hour, minute,
            timezone: document.getElementById('input_schedule_tz').value,
            notifyBeforeMinutes: parseInt(document.getElementById('input_schedule_notify').value, 10) || 30,
            notifyBeforeEnabled: document.getElementById('input_schedule_notify_enabled').checked,
            enabled: true
        };
    }
    dataPayload.schedule = schedule;
    const form = document.getElementById('netprofile_form');
    const submitBtn = form.querySelector('button[type="submit"]');
    const isEdit = netProfileFormState.mode === 'edit';
    if (!isEdit && netProfileFormState.mode !== 'new') {
        console.error('No valid form mode for upload');
        return;
    }
    if (submitBtn)
        submitBtn.disabled = true;
    const request = isEdit ? netProfileApi.update(dataPayload, id) : netProfileApi.create(dataPayload);
    request
        .then((req) => {
        console.debug(isEdit ? 'Update: ' : 'Create: ', req);
        netProfileFormState.mesg('info', isEdit ? 'Net updated successfully' : 'Net created successfully');
        refreshNetList();
        form.reset();
        try {
            tinymce.get('input_notes')?.setContent('');
        }
        catch { }
        document.getElementById('input_npid_for_netprofile').value = '';
        document.getElementById('input_schedule_enabled').checked = false;
        document.getElementById('schedule_settings').style.display = 'none';
        netProfileFormState.mode = 'new';
        window.modeHandler();
    })
        .catch((error) => {
        const msg = error?.response?.data?.errorMessage || error?.message || 'Save failed';
        netProfileFormState.mesg('error', msg);
        console.error(msg);
    })
        .finally(() => {
        if (submitBtn)
            submitBtn.disabled = false;
    });
}
function netowner_submitHandler(e) {
    e.preventDefault();
    const formDataToSend = new FormData(document.getElementById('netowner_form'));
    const id = formDataToSend.get('npid_for_netowner');
    const dataPayload = {
        email: formDataToSend.get('email')
    };
    axios
        .post(`/api/data/netprofiles/addnetowner/${id}`, dataPayload)
        .then((req) => {
        console.debug('Adding Net Owner: ', req);
        netOwnerFormState.mesg('info', 'Success: User will see ownership of this net in their account also');
        setTimeout(() => {
            location.reload();
        }, 6500);
    })
        .catch((error) => {
        if (error.response.data.errorMessage) {
            netOwnerFormState.mesg('error', error.response.data.errorMessage);
            console.error(error.response.data.errorMessage);
        }
        else {
            netOwnerFormState.mesg('error', error);
            console.error(error);
        }
    });
}
document.getElementById('netprofile_form').addEventListener('submit', np_submitHandler);
document.getElementById('netowner_form').addEventListener('submit', netowner_submitHandler);
window.formShow('formContainerNetProfile');
refreshNetList();
netProfileFormState.mode = 'new';
netOwnerFormState.mode = 'new';
setTimeout(() => {
    if (netProfileFormState.mode === 'new') {
        tinymce
            .get('input_notes')
            .setContent('Net Control should change this SAMPLE text to relevant info about the club/net. The contents here will be displayed to net attendees, momentarily, when the live net page loads<p>Echolink: XX#XX-L</p>\n<p><em>this is italicized</em></p>');
    }
}, 2000);
document.getElementById('input_schedule_enabled').addEventListener('change', function () {
    document.getElementById('schedule_settings').style.display = this.checked ? 'block' : 'none';
});
//# sourceMappingURL=main.js.map