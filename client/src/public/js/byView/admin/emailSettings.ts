/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

// TinyMCE is loaded via the featureTinyMceJs partial included in admin.ejs.
// Declare a minimal ambient interface so we can call it without @ts-nocheck.
interface TinyMCEEditor {
    getContent(): string;
    setContent(html: string): void;
    remove(): void;
}

declare const tinymce: {
    init(config: Record<string, unknown>): Promise<TinyMCEEditor[]>;
    get(id: string): TinyMCEEditor | null;
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function qs<T extends Element>(sel: string, parent: ParentNode = document): T | null {
    return parent.querySelector<T>(sel);
}

function setVal(name: string, value: string | number | null | undefined): void {
    const inp = qs<HTMLInputElement>(`[name="${name}"]`);
    if (inp) inp.value = String(value ?? '');
}

function val(form: HTMLFormElement, name: string): string {
    return qs<HTMLInputElement>(`[name="${name}"]`, form)?.value?.trim() ?? '';
}

function setRadio(name: string, value: string): void {
    const r = qs<HTMLInputElement>(`[name="${name}"][value="${value}"]`);
    if (r) r.checked = true;
}

function toggleSmtpFields(provider: string): void {
    const wrap = el('smtp-fields');
    if (wrap) wrap.hidden = provider !== 'smtp';
    const tf = el('tracking-fields');
    if (tf) tf.hidden = provider !== 'smtp';
}

function showStatus(id: string, text: string): void {
    const e = el(id);
    if (!e) return;
    e.textContent = text;
    setTimeout(() => { if (e.textContent === text) e.textContent = ''; }, 5000);
}

function escHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function escAttr(s: string): string {
    return s.replace(/["'<>&]/g, (c): string => {
        const map: Record<string, string> = {
            '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '&': '&amp;',
        };
        return map[c] ?? c;
    });
}

// ── API helper ────────────────────────────────────────────────────────────────

// Server failures arrive as body.errorMessage (handleRequest → sendError).
export function apiErrorMessage(body: unknown): string {
    if (body && typeof body === 'object') {
        const msg = (body as { errorMessage?: unknown }).errorMessage;
        if (typeof msg === 'string' && msg.length) return msg;
    }
    return 'request failed';
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`/api/admin/email${path}`, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        ...init,
    });
    const body = await res.json() as { message?: unknown };
    if (!res.ok) throw new Error(apiErrorMessage(body));
    return body.message;
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface SmtpConfig {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    fromOverride?: string;
    passwordSet?: boolean;
    passwordInvalid?: boolean;
}

interface TrackingConfig {
    enabled?: boolean;
    host?: string;
    port?: number;
    user?: string;
    tlsVerify?: boolean;
    tokenSet?: boolean;
    tokenInvalid?: boolean;
}

interface EmailSettingsResponse {
    provider?: string;
    smtp?: SmtpConfig;
    tracking?: TrackingConfig;
    envFallback?: { sendgrid?: boolean };
}

interface TemplateSummary {
    key: string;
    label: string;
    subject: string;
    updatedAt?: string;
}

interface TemplateDetail {
    key?: string;
    label?: string;
    subject: string;
    html: string;
    variables?: string[];
    sample?: Record<string, string>;
}

interface TestResult {
    sent: boolean;
    via?: string;
    error?: string;
}

// ── Delivery tracking sub-section ─────────────────────────────────────────────

function fillTracking(t: TrackingConfig): void {
    const en = qs<HTMLInputElement>('[name=trackingEnabled]');
    if (en) en.checked = t.enabled ?? false;
    setVal('trackingHost', t.host ?? '');
    setVal('trackingPort', t.port ?? 2083);
    setVal('trackingUser', t.user ?? '');
    const tls = qs<HTMLInputElement>('[name=trackingTlsVerify]');
    if (tls) tls.checked = t.tlsVerify !== false;
    const st = el('tracking-token-status');
    if (st) {
        st.textContent = t.tokenInvalid
            ? '⚠ stored token can no longer be decrypted (encryption key changed) — re-enter it'
            : t.tokenSet ? 'token is set' : 'no token set';
    }
}

// ── Provider sub-section ──────────────────────────────────────────────────────

async function initProviderSection(): Promise<void> {
    const settings = await api('/settings') as EmailSettingsResponse;
    const smtp = settings.smtp ?? {};

    setRadio('provider', settings.provider ?? 'console');
    setVal('host', smtp.host ?? '');
    setVal('port', smtp.port ?? 587);

    const secureEl = qs<HTMLInputElement>('[name=secure]');
    if (secureEl) secureEl.checked = smtp.secure ?? false;

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

    // Provider radio toggles smtp field visibility
    const panel = el('email-settings-panel');
    panel?.querySelectorAll<HTMLInputElement>('[name=provider]').forEach(r => {
        r.addEventListener('change', e => toggleSmtpFields((e.target as HTMLInputElement).value));
    });

    // Save provider settings
    el('email-provider-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target as HTMLFormElement;
        const password = val(f, 'password');
        const smtpFields: Record<string, unknown> = {
            host: val(f, 'host'),
            port: Number(val(f, 'port')),
            secure: qs<HTMLInputElement>('[name=secure]', f)?.checked ?? false,
            user: val(f, 'user'),
            fromOverride: val(f, 'fromOverride'),
        };
        if (password) smtpFields['password'] = password;
        try {
            await api('/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    provider: qs<HTMLInputElement>('[name=provider]:checked', f)?.value ?? 'console',
                    smtp: smtpFields,
                }),
            });
            showStatus('email-settings-status', 'Saved. New provider applies to the next email — no restart needed.');
            const pwEl = qs<HTMLInputElement>('[name=password]', f);
            if (pwEl) pwEl.value = '';
            if (password) {
                const pwStat = el('smtp-password-status');
                if (pwStat) pwStat.textContent = 'password is set';
            }
        } catch (err) {
            showStatus('email-settings-status', `Error: ${(err as Error).message}`);
        }
    });

    // Send test (provider panel)
    el('email-test-send')?.addEventListener('click', async () => {
        const key = (el('email-test-key') as HTMLSelectElement | null)?.value ?? 'magic-link';
        try {
            const r = await api('/test', { method: 'POST', body: JSON.stringify({ key }) }) as TestResult;
            showStatus('email-test-status', r.sent ? `Sent via ${r.via ?? '?'}` : `Not sent: ${r.error ?? 'unknown'}`);
        } catch (err) {
            showStatus('email-test-status', `Error: ${(err as Error).message}`);
        }
    });

    // Save tracking settings
    el('email-tracking-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target as HTMLFormElement;
        const token = val(f, 'trackingToken');
        const tracking: Record<string, unknown> = {
            enabled: qs<HTMLInputElement>('[name=trackingEnabled]', f)?.checked ?? false,
            host: val(f, 'trackingHost'),
            port: Number(val(f, 'trackingPort')) || 2083,
            user: val(f, 'trackingUser'),
            tlsVerify: qs<HTMLInputElement>('[name=trackingTlsVerify]', f)?.checked ?? true,
        };
        if (token) tracking['token'] = token;
        try {
            const s = await api('/settings', { method: 'PUT', body: JSON.stringify({ tracking }) }) as EmailSettingsResponse;
            showStatus('tracking-status', 'Saved.');
            const tokEl = qs<HTMLInputElement>('[name=trackingToken]', f);
            if (tokEl) tokEl.value = '';
            fillTracking(s.tracking ?? {});
        } catch (err) {
            showStatus('tracking-status', `Error: ${(err as Error).message}`);
        }
    });

    // Test tracking connection
    el('tracking-test-btn')?.addEventListener('click', async () => {
        showStatus('tracking-status', 'Testing…');
        try {
            const r = await api('/tracking/test', { method: 'POST', body: '{}' }) as { ok?: boolean; rows?: number; fromSender?: number; error?: string };
            showStatus('tracking-status', r.ok ? `OK — ${r.rows} tracked rows, ${r.fromSender} from your sender` : `Failed: ${r.error ?? 'unknown'}`);
        } catch (err) {
            showStatus('tracking-status', `Error: ${(err as Error).message}`);
        }
    });
}

// ── Template editor ───────────────────────────────────────────────────────────

let currentKey = '';
let richActive = false;

function htmlVal(): string {
    if (richActive) {
        const te = tinymce.get('et-rich-editor');
        if (te) return te.getContent();
    }
    return (el('et-html') as HTMLTextAreaElement | null)?.value ?? '';
}

function loadTemplate(key: string, t: TemplateDetail): void {
    currentKey = key;
    const titleEl = el('et-title');
    if (titleEl) titleEl.textContent = t.label ?? key;
    const varsEl = el('et-vars');
    if (varsEl) varsEl.textContent = (t.variables ?? []).join(', ') || '(none)';
    const subjectEl = el('et-subject') as HTMLInputElement | null;
    if (subjectEl) subjectEl.value = t.subject;
    const htmlEl = el('et-html') as HTMLTextAreaElement | null;
    if (htmlEl) htmlEl.value = t.html;
    if (richActive) tinymce.get('et-rich-editor')?.setContent(t.html);
    const editorWrap = el('email-template-editor');
    if (editorWrap) editorWrap.hidden = false;
}

// Apply only the subject + html from a reset/preview response — preserves the
// already-displayed label and variables list (which the reset endpoint does not
// return; GET /templates/:key provides them).
function applySubjectHtml(subject: string, html: string): void {
    const subjectEl = el('et-subject') as HTMLInputElement | null;
    if (subjectEl) subjectEl.value = subject;
    const htmlEl = el('et-html') as HTMLTextAreaElement | null;
    if (htmlEl) htmlEl.value = html;
    if (richActive) tinymce.get('et-rich-editor')?.setContent(html);
}

async function initTemplateEditor(): Promise<void> {
    const data = await api('/templates') as { templates?: TemplateSummary[] };
    const listEl = el('email-template-list');
    if (!listEl) return;

    const templates = data.templates ?? [];
    listEl.innerHTML = templates.length
        ? templates.map(t =>
            `<li><a href="#" data-key="${escAttr(t.key)}">${escHtml(t.label)}</a> <span class="text-muted small">${escHtml(t.subject)}</span></li>`
        ).join('')
        : '<li class="text-muted">No templates found.</li>';

    // Click to load template into editor
    listEl.addEventListener('click', async e => {
        const a = (e.target as HTMLElement).closest('a[data-key]') as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        const key = a.getAttribute('data-key') ?? '';
        try {
            const t = await api(`/templates/${encodeURIComponent(key)}`) as TemplateDetail;
            loadTemplate(key, t);
        } catch (err) {
            console.error('Template load error:', err);
        }
    });

    // Source mode toggle (textarea visible)
    el('et-mode-source')?.addEventListener('click', () => {
        if (!richActive) return;
        const content = tinymce.get('et-rich-editor')?.getContent() ?? '';
        const htmlEl = el('et-html') as HTMLTextAreaElement | null;
        if (htmlEl) { htmlEl.value = content; htmlEl.hidden = false; }
        tinymce.get('et-rich-editor')?.remove();
        richActive = false;
        const richDiv = el('et-rich');
        if (richDiv) richDiv.hidden = true;
        el('et-mode-source')?.classList.add('active');
        el('et-mode-rich')?.classList.remove('active');
    });

    // Rich mode toggle (TinyMCE)
    el('et-mode-rich')?.addEventListener('click', async () => {
        if (richActive) return;
        const htmlEl = el('et-html') as HTMLTextAreaElement | null;
        const content = htmlEl?.value ?? '';
        if (htmlEl) htmlEl.hidden = true;

        const richDiv = el('et-rich');
        if (richDiv) {
            richDiv.hidden = false;
            let ta = richDiv.querySelector<HTMLTextAreaElement>('#et-rich-editor');
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
        } catch (err) {
            // Revert visibility on failure
            if (htmlEl) htmlEl.hidden = false;
            const richDiv2 = el('et-rich');
            if (richDiv2) richDiv2.hidden = true;
            console.error('TinyMCE init failed:', err);
        }
    });

    // Preview — renders current subject/html in the iframe
    el('et-preview')?.addEventListener('click', async () => {
        if (!currentKey) return;
        const subjectEl = el('et-subject') as HTMLInputElement | null;
        try {
            const r = await api(`/templates/${encodeURIComponent(currentKey)}/preview`, {
                method: 'POST',
                body: JSON.stringify({ subject: subjectEl?.value ?? '', html: htmlVal() }),
            }) as { subject: string; html: string };
            const frame = el('et-preview-frame') as HTMLIFrameElement | null;
            if (frame) frame.srcdoc = r.html;
        } catch (err) {
            showStatus('et-status', `Preview error: ${(err as Error).message}`);
        }
    });

    // Send test using the current template key
    el('et-test')?.addEventListener('click', async () => {
        if (!currentKey) return;
        try {
            const r = await api('/test', {
                method: 'POST', body: JSON.stringify({ key: currentKey }),
            }) as TestResult;
            showStatus('et-status', r.sent ? `Sent via ${r.via ?? '?'}` : `Not sent: ${r.error ?? 'unknown'}`);
        } catch (err) {
            showStatus('et-status', `Error: ${(err as Error).message}`);
        }
    });

    // Reset to default — only updates subject + html; label/vars stay intact
    el('et-reset')?.addEventListener('click', async () => {
        if (!currentKey) return;
        if (!confirm('Reset this template to the built-in default? Your changes will be lost.')) return;
        try {
            const t = await api(`/templates/${encodeURIComponent(currentKey)}/reset`, {
                method: 'POST',
            }) as { subject: string; html: string };
            applySubjectHtml(t.subject, t.html);
            showStatus('et-status', 'Reset to default.');
        } catch (err) {
            showStatus('et-status', `Reset error: ${(err as Error).message}`);
        }
    });

    // Save template
    el('et-save')?.addEventListener('click', async () => {
        if (!currentKey) return;
        const subjectEl = el('et-subject') as HTMLInputElement | null;
        try {
            await api(`/templates/${encodeURIComponent(currentKey)}`, {
                method: 'PUT',
                body: JSON.stringify({ subject: subjectEl?.value ?? '', html: htmlVal() }),
            });
            showStatus('et-status', 'Template saved.');
        } catch (err) {
            showStatus('et-status', `Save error: ${(err as Error).message}`);
        }
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function initEmailSettings(): Promise<void> {
    if (!el('email-settings-panel')) return; // not on this page
    try { await initProviderSection(); } catch (err) { console.error('initProviderSection:', err); }
    try { await initTemplateEditor(); } catch (err) { console.error('initTemplateEditor:', err); }
}
