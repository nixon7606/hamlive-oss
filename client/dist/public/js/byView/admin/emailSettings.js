'use strict';
function el(id) {
    return document.getElementById(id);
}
function qs(sel, parent = document) {
    return parent.querySelector(sel);
}
function setVal(name, value) {
    const inp = qs(`[name="${name}"]`);
    if (inp)
        inp.value = String(value ?? '');
}
function val(form, name) {
    return qs(`[name="${name}"]`, form)?.value?.trim() ?? '';
}
function setRadio(name, value) {
    const r = qs(`[name="${name}"][value="${value}"]`);
    if (r)
        r.checked = true;
}
function toggleSmtpFields(provider) {
    const wrap = el('smtp-fields');
    if (wrap)
        wrap.hidden = provider !== 'smtp';
    const tf = el('tracking-fields');
    if (tf)
        tf.hidden = provider !== 'smtp';
}
function showStatus(id, text) {
    const e = el(id);
    if (!e)
        return;
    e.textContent = text;
    setTimeout(() => { if (e.textContent === text)
        e.textContent = ''; }, 5000);
}
function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
function escAttr(s) {
    return s.replace(/["'<>&]/g, (c) => {
        const map = {
            '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '&': '&amp;',
        };
        return map[c] ?? c;
    });
}
export function apiErrorMessage(body) {
    if (body && typeof body === 'object') {
        const msg = body.errorMessage;
        if (typeof msg === 'string' && msg.length)
            return msg;
    }
    return 'request failed';
}
async function api(path, init) {
    const res = await fetch(`/api/admin/email${path}`, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        ...init,
    });
    const body = await res.json();
    if (!res.ok)
        throw new Error(apiErrorMessage(body));
    return body.message;
}
function fillTracking(t) {
    const en = qs('[name=trackingEnabled]');
    if (en)
        en.checked = t.enabled ?? false;
    setVal('trackingHost', t.host ?? '');
    setVal('trackingPort', t.port ?? 2083);
    setVal('trackingUser', t.user ?? '');
    const tls = qs('[name=trackingTlsVerify]');
    if (tls)
        tls.checked = t.tlsVerify !== false;
    const st = el('tracking-token-status');
    if (st) {
        st.textContent = t.tokenInvalid
            ? '⚠ stored token can no longer be decrypted (encryption key changed) — re-enter it'
            : t.tokenSet ? 'token is set' : 'no token set';
    }
}
async function initProviderSection() {
    const settings = await api('/settings');
    const smtp = settings.smtp ?? {};
    setRadio('provider', settings.provider ?? 'console');
    setVal('host', smtp.host ?? '');
    setVal('port', smtp.port ?? 587);
    const secureEl = qs('[name=secure]');
    if (secureEl)
        secureEl.checked = smtp.secure ?? false;
    setVal('user', smtp.user ?? '');
    setVal('fromOverride', smtp.fromOverride ?? '');
    const pwStatus = el('smtp-password-status');
    if (pwStatus) {
        pwStatus.textContent = smtp.passwordInvalid
            ? '⚠ stored password can no longer be decrypted (encryption key changed) — re-enter it'
            : smtp.passwordSet ? 'password is set' : 'no password set';
    }
    toggleSmtpFields(settings.provider ?? 'console');
    fillTracking(settings.tracking ?? {});
    const panel = el('email-settings-panel');
    panel?.querySelectorAll('[name=provider]').forEach(r => {
        r.addEventListener('change', e => toggleSmtpFields(e.target.value));
    });
    el('email-provider-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const password = val(f, 'password');
        const smtpFields = {
            host: val(f, 'host'),
            port: Number(val(f, 'port')),
            secure: qs('[name=secure]', f)?.checked ?? false,
            user: val(f, 'user'),
            fromOverride: val(f, 'fromOverride'),
        };
        if (password)
            smtpFields['password'] = password;
        try {
            await api('/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    provider: qs('[name=provider]:checked', f)?.value ?? 'console',
                    smtp: smtpFields,
                }),
            });
            showStatus('email-settings-status', 'Saved. New provider applies to the next email — no restart needed.');
            const pwEl = qs('[name=password]', f);
            if (pwEl)
                pwEl.value = '';
            if (password) {
                const pwStat = el('smtp-password-status');
                if (pwStat)
                    pwStat.textContent = 'password is set';
            }
        }
        catch (err) {
            showStatus('email-settings-status', `Error: ${err.message}`);
        }
    });
    el('email-test-send')?.addEventListener('click', async () => {
        const key = el('email-test-key')?.value ?? 'magic-link';
        try {
            const r = await api('/test', { method: 'POST', body: JSON.stringify({ key }) });
            showStatus('email-test-status', r.sent ? `Sent via ${r.via ?? '?'}` : `Not sent: ${r.error ?? 'unknown'}`);
        }
        catch (err) {
            showStatus('email-test-status', `Error: ${err.message}`);
        }
    });
    el('email-tracking-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const token = val(f, 'trackingToken');
        const tracking = {
            enabled: qs('[name=trackingEnabled]', f)?.checked ?? false,
            host: val(f, 'trackingHost'),
            port: Number(val(f, 'trackingPort')) || 2083,
            user: val(f, 'trackingUser'),
            tlsVerify: qs('[name=trackingTlsVerify]', f)?.checked ?? true,
        };
        if (token)
            tracking['token'] = token;
        try {
            const s = await api('/settings', { method: 'PUT', body: JSON.stringify({ tracking }) });
            showStatus('tracking-status', 'Saved.');
            const tokEl = qs('[name=trackingToken]', f);
            if (tokEl)
                tokEl.value = '';
            fillTracking(s.tracking ?? {});
        }
        catch (err) {
            showStatus('tracking-status', `Error: ${err.message}`);
        }
    });
    el('tracking-test-btn')?.addEventListener('click', async () => {
        showStatus('tracking-status', 'Testing…');
        try {
            const r = await api('/tracking/test', { method: 'POST', body: '{}' });
            showStatus('tracking-status', r.ok ? `OK — ${r.rows} tracked rows, ${r.fromSender} from your sender` : `Failed: ${r.error ?? 'unknown'}`);
        }
        catch (err) {
            showStatus('tracking-status', `Error: ${err.message}`);
        }
    });
}
let currentKey = '';
let richActive = false;
function htmlVal() {
    if (richActive) {
        const te = tinymce.get('et-rich-editor');
        if (te)
            return te.getContent();
    }
    return el('et-html')?.value ?? '';
}
function loadTemplate(key, t) {
    currentKey = key;
    const titleEl = el('et-title');
    if (titleEl)
        titleEl.textContent = t.label ?? key;
    const varsEl = el('et-vars');
    if (varsEl)
        varsEl.textContent = (t.variables ?? []).join(', ') || '(none)';
    const subjectEl = el('et-subject');
    if (subjectEl)
        subjectEl.value = t.subject;
    const htmlEl = el('et-html');
    if (htmlEl)
        htmlEl.value = t.html;
    if (richActive)
        tinymce.get('et-rich-editor')?.setContent(t.html);
    const editorWrap = el('email-template-editor');
    if (editorWrap)
        editorWrap.hidden = false;
}
function applySubjectHtml(subject, html) {
    const subjectEl = el('et-subject');
    if (subjectEl)
        subjectEl.value = subject;
    const htmlEl = el('et-html');
    if (htmlEl)
        htmlEl.value = html;
    if (richActive)
        tinymce.get('et-rich-editor')?.setContent(html);
}
async function initTemplateEditor() {
    const data = await api('/templates');
    const listEl = el('email-template-list');
    if (!listEl)
        return;
    const templates = data.templates ?? [];
    listEl.innerHTML = templates.length
        ? templates.map(t => `<li><a href="#" data-key="${escAttr(t.key)}">${escHtml(t.label)}</a> <span class="text-muted small">${escHtml(t.subject)}</span></li>`).join('')
        : '<li class="text-muted">No templates found.</li>';
    listEl.addEventListener('click', async (e) => {
        const a = e.target.closest('a[data-key]');
        if (!a)
            return;
        e.preventDefault();
        const key = a.getAttribute('data-key') ?? '';
        try {
            const t = await api(`/templates/${encodeURIComponent(key)}`);
            loadTemplate(key, t);
        }
        catch (err) {
            console.error('Template load error:', err);
        }
    });
    el('et-mode-source')?.addEventListener('click', () => {
        if (!richActive)
            return;
        const content = tinymce.get('et-rich-editor')?.getContent() ?? '';
        const htmlEl = el('et-html');
        if (htmlEl) {
            htmlEl.value = content;
            htmlEl.hidden = false;
        }
        tinymce.get('et-rich-editor')?.remove();
        richActive = false;
        const richDiv = el('et-rich');
        if (richDiv)
            richDiv.hidden = true;
        el('et-mode-source')?.classList.add('active');
        el('et-mode-rich')?.classList.remove('active');
    });
    el('et-mode-rich')?.addEventListener('click', async () => {
        if (richActive)
            return;
        const htmlEl = el('et-html');
        const content = htmlEl?.value ?? '';
        if (htmlEl)
            htmlEl.hidden = true;
        const richDiv = el('et-rich');
        if (richDiv) {
            richDiv.hidden = false;
            let ta = richDiv.querySelector('#et-rich-editor');
            if (!ta) {
                ta = document.createElement('textarea');
                ta.id = 'et-rich-editor';
                richDiv.appendChild(ta);
            }
            ta.value = content;
        }
        try {
            await tinymce.init({
                selector: '#et-rich-editor',
                skin_url: '/tinymce/skins/hl',
                content_css: 'dark',
                plugins: 'lists',
                toolbar: 'bullist numlist | bold italic underline',
                menubar: '',
                statusbar: false,
                promotion: false,
            });
            richActive = true;
            el('et-mode-rich')?.classList.add('active');
            el('et-mode-source')?.classList.remove('active');
        }
        catch (err) {
            if (htmlEl)
                htmlEl.hidden = false;
            const richDiv2 = el('et-rich');
            if (richDiv2)
                richDiv2.hidden = true;
            console.error('TinyMCE init failed:', err);
        }
    });
    el('et-preview')?.addEventListener('click', async () => {
        if (!currentKey)
            return;
        const subjectEl = el('et-subject');
        try {
            const r = await api(`/templates/${encodeURIComponent(currentKey)}/preview`, {
                method: 'POST',
                body: JSON.stringify({ subject: subjectEl?.value ?? '', html: htmlVal() }),
            });
            const frame = el('et-preview-frame');
            if (frame)
                frame.srcdoc = r.html;
        }
        catch (err) {
            showStatus('et-status', `Preview error: ${err.message}`);
        }
    });
    el('et-test')?.addEventListener('click', async () => {
        if (!currentKey)
            return;
        try {
            const r = await api('/test', {
                method: 'POST', body: JSON.stringify({ key: currentKey }),
            });
            showStatus('et-status', r.sent ? `Sent via ${r.via ?? '?'}` : `Not sent: ${r.error ?? 'unknown'}`);
        }
        catch (err) {
            showStatus('et-status', `Error: ${err.message}`);
        }
    });
    el('et-reset')?.addEventListener('click', async () => {
        if (!currentKey)
            return;
        if (!confirm('Reset this template to the built-in default? Your changes will be lost.'))
            return;
        try {
            const t = await api(`/templates/${encodeURIComponent(currentKey)}/reset`, {
                method: 'POST',
            });
            applySubjectHtml(t.subject, t.html);
            showStatus('et-status', 'Reset to default.');
        }
        catch (err) {
            showStatus('et-status', `Reset error: ${err.message}`);
        }
    });
    el('et-save')?.addEventListener('click', async () => {
        if (!currentKey)
            return;
        const subjectEl = el('et-subject');
        try {
            await api(`/templates/${encodeURIComponent(currentKey)}`, {
                method: 'PUT',
                body: JSON.stringify({ subject: subjectEl?.value ?? '', html: htmlVal() }),
            });
            showStatus('et-status', 'Template saved.');
        }
        catch (err) {
            showStatus('et-status', `Save error: ${err.message}`);
        }
    });
}
export async function initEmailSettings() {
    if (!el('email-settings-panel'))
        return;
    try {
        await initProviderSection();
    }
    catch (err) {
        console.error('initProviderSection:', err);
    }
    try {
        await initTemplateEditor();
    }
    catch (err) {
        console.error('initTemplateEditor:', err);
    }
}
//# sourceMappingURL=emailSettings.js.map