// @ts-nocheck
/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

import { expiryFromPreset } from '#@client/lib/clientUtils.js';
import { initEmailSettings } from './emailSettings.js';

/**
 * Admin panel — user and net management (superUser only).
 */

const API = '/api/admin';

// Cache the most recently loaded rows so action handlers can look up labels by
// id without re-interpolating strings into HTML attributes.
let usersCache: any[] = [];
let netsCache: any[] = [];
let netsSortMode = 'active'; // 'active' | field name
let netsSortDir: 'asc' | 'desc' | null = null;
let currentEmailRecipient = '';

// User search + pagination state
let usersPage = 1;
let usersSearch = '';
let usersTotal = 0;
let usersLimit = 50;
let usersSortField = 'createdAt';
let usersSortDir: 'asc' | 'desc' = 'desc';

// Audit pagination + filter state
let auditPage = 1;
let auditTotal = 0;
let auditLimit = 50;
let auditActor = '';
let auditAction = '';

// Build the actor/action query suffix shared by the audit list and CSV export.
function auditFilterQuery(): string {
    let q = '';
    if (auditActor) q += `&actor=${encodeURIComponent(auditActor)}`;
    if (auditAction) q += `&action=${encodeURIComponent(auditAction)}`;
    return q;
}

// Grant-admin confirm state
let editUserWasSuper = false;

function statusMsg(text: string, type: string = 'info') {
    // NOTE: `type` must always be a hardcoded literal (e.g. 'success', 'danger') — never user data.
    const el = document.getElementById('admin-status');
    if (el) {
        el.innerHTML = `<span class="text-${type}">${esc(text)}</span>`;
        setTimeout(() => { el.innerHTML = ''; }, 5000);
    }
}

function esc(s: string): string {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function setBanUiState(banned: boolean, lockedUntil: string | null): void {
    const hidden = document.getElementById('edit-locked') as HTMLInputElement | null;
    const btn = document.getElementById('edit-ban-btn') as HTMLButtonElement | null;
    const status = document.getElementById('edit-ban-status') as HTMLElement | null;
    const wrap = document.getElementById('edit-ban-expiry-wrap') as HTMLElement | null;
    if (!hidden || !btn || !status || !wrap) return;
    hidden.value = banned ? 'true' : 'false';
    btn.textContent = banned ? 'Unban' : 'Ban';
    btn.classList.toggle('btn-outline-danger', !banned);
    btn.classList.toggle('btn-outline-success', banned);
    status.textContent = banned
        ? (lockedUntil ? `Banned until ${new Date(lockedUntil).toLocaleString()}` : 'Banned (permanent)')
        : '';
    wrap.style.display = banned ? 'block' : 'none';
    // Reset the duration picker to a clean default each time state is set, so a
    // previous user's "custom" selection/visibility never leaks into this modal.
    const duration = document.getElementById('edit-lock-duration') as HTMLSelectElement | null;
    const custom = document.getElementById('edit-lock-custom') as HTMLInputElement | null;
    if (duration) duration.value = 'permanent';
    if (custom) { custom.value = ''; custom.style.display = 'none'; }
}

/* ── Stats ── */

async function loadStats() {
    try {
        const res = await fetch(`${API}/stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const s = data.message || {};
        (document.getElementById('stat-users') as HTMLElement).textContent = s.totalUsers ?? '-';
        (document.getElementById('stat-nets') as HTMLElement).textContent = s.totalNets ?? '-';
        (document.getElementById('stat-live') as HTMLElement).textContent = s.liveNetsCount ?? '-';
        (document.getElementById('stat-scheduled') as HTMLElement).textContent = s.scheduledNetsCount ?? '-';
        const bounces = s.recentBounces ?? 0;
        (document.getElementById('stat-bounces') as HTMLElement).textContent = bounces;
        document.getElementById('stat-bounces-card')?.classList.toggle('stat-alert', bounces > 0);
    } catch (err) {
        console.error('Stats error:', err);
    }
}

/* ── Users ── */

async function loadUsers() {
    const tbody = document.getElementById('admin-users-tbody') as HTMLTableSectionElement;
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Loading...</td></tr>';
    try {
        const res = await fetch(`${API}/users?search=${encodeURIComponent(usersSearch)}&page=${usersPage}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const users = (data.message && data.message.users) || [];
        usersCache = users;
        usersTotal = (data.message && data.message.total) || 0;
        usersLimit = (data.message && data.message.limit) || 50;
        setSortIndicator('admin-users-tbody', usersSortField, usersSortDir);
        const sortedUsers = sortData(users, usersSortField, usersSortDir);

        // Update pagination info
        const pageInfo = document.getElementById('users-page-info');
        if (pageInfo) pageInfo.textContent = `Page ${usersPage} · ${usersTotal} users`;
        const prevBtn = document.getElementById('users-prev') as HTMLButtonElement | null;
        const nextBtn = document.getElementById('users-next') as HTMLButtonElement | null;
        if (prevBtn) prevBtn.disabled = usersPage <= 1;
        if (nextBtn) nextBtn.disabled = usersPage * usersLimit >= usersTotal;

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No users found</td></tr>';
            return;
        }
        tbody.innerHTML = sortedUsers.map((u: any) => {
            const badges = [];
            if (u.locked) badges.push(`<span class="badge badge-locked">${u.lockedUntil ? 'Locked until ' + new Date(u.lockedUntil).toLocaleDateString() : 'Locked'}</span>`);
            if (u.superUser) badges.push('<span class="badge badge-super">Admin</span>');
            if (u.newAccount) badges.push('<span class="badge badge-new">New</span>');
            if (u.flaggedForDeletion) badges.push('<span class="badge badge-flagged">Flagged</span>');
            badges.push(u.lastAuthVia === 'google'
                ? '<span class="badge badge-google">Google</span>'
                : '<span class="badge badge-email">Email</span>');
            const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-';
            const ip = u.lastIp || '-';
            return `<tr>
                <td>${esc(u.email)}</td>
                <td><strong>${esc(u.callSign || '-')}</strong></td>
                <td>${esc(u.displayName || '-')}</td>
                <td>${esc(u.location || '-')}</td>
                <td class="ip-cell">${esc(ip)}</td>
                <td>${badges.join(' ') || '<span class="text-muted">Active</span>'}</td>
                <td>${created}</td>
                <td>
                    <button class="btn btn-sm btn-outline-light me-1" data-action="edit-user" data-id="${u._id}" title="Edit"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-outline-info me-1" data-action="email-history" data-id="${u._id}" title="View email history"><i class="bi bi-envelope"></i></button>
                    <button class="btn btn-sm btn-outline-danger" data-action="delete-user" data-id="${u._id}" title="Delete"><i class="bi bi-trash"></i></button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Failed to load users</td></tr>';
        statusMsg(`Error loading users: ${(err as Error).message}`, 'danger');
    }
}

/* ── Nets ── */

async function loadNets() {
    const tbody = document.getElementById('admin-nets-tbody') as HTMLTableSectionElement;
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Loading...</td></tr>';
    try {
        const res = await fetch(`${API}/nets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const nets = data.message || [];
        netsCache = nets;
        const sorted = sortNets(nets, netsSortMode, netsSortDir);
        setSortIndicator('admin-nets-tbody', netsSortMode, netsSortDir);
        if (sorted.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No net profiles found</td></tr>';
            return;
        }
        tbody.innerHTML = sorted.map((n: any) => {
            const owners = (n.owners || []).map((o: any) => o.callSign || o.email).join(', ') || '-';
            const freqMode = `<span class="freq-mode">${esc(n.frequency || '—')} / ${esc(n.mode || '—')}</span>`;

            let statusBadge = '<span class="badge bg-secondary">Inactive</span>';
            if (n.hasLiveNet) {
                if (n.liveNetStatus === 'waiting') statusBadge = '<span class="badge badge-waiting">Waiting</span>';
                else statusBadge = '<span class="badge badge-live">Live</span>';
            }

            const permBadge = n.permanent
                ? '<span class="badge badge-locked">Perm</span>'
                : '<span class="text-muted">—</span>';

            let scheduleInfo = '<span class="text-muted">—</span>';
            if (n.schedule && n.schedule.enabled) {
                const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                const day = days[n.schedule.dayOfWeek] || '?';
                const h = String(n.schedule.hour || 0).padStart(2, '0');
                const m = String(n.schedule.minute || 0).padStart(2, '0');
                scheduleInfo = `<span class="badge badge-scheduled">${day} ${h}:${m}</span>`;
            }

            const permBtnLabel = n.permanent ? 'Un-perm' : 'Perm';
            const permBtnClass = n.permanent ? 'btn-outline-success' : 'btn-outline-warning';

            const created = n.createdAt ? new Date(n.createdAt).toLocaleDateString() : '-';
            return `<tr>
                <td><strong>${esc(n.title)}</strong></td>
                <td>${freqMode}</td>
                <td>${esc(owners)}</td>
                <td>${statusBadge}</td>
                <td>${permBadge}</td>
                <td>${scheduleInfo}</td>
                <td>${created}</td>
                <td>
                    <button class="btn btn-sm ${permBtnClass} me-1" data-action="toggle-perm" data-id="${n._id}" title="Toggle permanent">${permBtnLabel}</button>
                    <button class="btn btn-sm btn-outline-warning me-1" data-action="manage-schedule" data-id="${n._id}" title="Manage Schedule"><i class="bi bi-calendar-week"></i></button>
                    <button class="btn btn-sm btn-outline-danger" data-action="delete-net" data-id="${n._id}" title="Delete Net"><i class="bi bi-trash"></i></button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Failed to load nets</td></tr>';
        statusMsg(`Error loading nets: ${(err as Error).message}`, 'danger');
    }
}

/* ── Sort helpers ── */

function getSortValue(obj: any, field: string): any {
    if (field === 'status') {
        if (obj.hasLiveNet && obj.liveNetStatus === 'live') return 0;
        if (obj.hasLiveNet && obj.liveNetStatus === 'waiting') return 1;
        if (obj.locked) return 2;
        if (obj.superUser) return 3;
        return 4;
    }
    if (field === 'permanent') return obj.permanent ? 0 : 1;
    if (field === 'schedule') return (obj.schedule && obj.schedule.enabled) ? 0 : 1;
    if (field === 'ip') return obj.lastIp || '';
    if (field === 'createdAt') return obj.createdAt ? new Date(obj.createdAt).getTime() : 0;
    if (field === 'frequency') {
        const f = parseFloat(obj.frequency);
        return isNaN(f) ? 9999 : f;
    }
    return (obj[field] || '').toString().toLowerCase();
}

function sortData(data: any[], field: string, dir: 'asc' | 'desc' | null): any[] {
    if (!field || !dir) return data;
    return [...data].sort((a, b) => {
        const va = getSortValue(a, field);
        const vb = getSortValue(b, field);
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
    });
}

function sortNets(nets: any[], mode: string, dir: 'asc' | 'desc' | null): any[] {
    if (mode === 'active') {
        return [...nets].sort((a, b) => {
            // Live first, then waiting, then permanent, then inactive by created
            const aScore = a.hasLiveNet && a.liveNetStatus === 'live' ? 0
                : a.hasLiveNet && a.liveNetStatus === 'waiting' ? 1
                : a.permanent ? 2
                : 3;
            const bScore = b.hasLiveNet && b.liveNetStatus === 'live' ? 0
                : b.hasLiveNet && b.liveNetStatus === 'waiting' ? 1
                : b.permanent ? 2
                : 3;
            if (aScore !== bScore) return aScore - bScore;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
    }
    return sortData(nets, mode, dir || 'asc');
}

function setSortIndicator(tbodyId: string, field: string, dir: 'asc' | 'desc' | null) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const table = tbody.closest('table');
    if (!table) return;
    table.querySelectorAll('thead th[data-sort-field]').forEach(th => {
        const f = th.getAttribute('data-sort-field');
        if (f === field && dir) {
            th.setAttribute('data-sort-dir', dir);
        } else {
            th.removeAttribute('data-sort-dir');
        }
    });
}

/* ── Audit Log ── */

async function loadAudit() {
    const box = document.getElementById('audit-results');
    if (!box) return;
    box.innerHTML = '<p class="text-muted">Loading…</p>';
    try {
        const res = await fetch(`${API}/audit?page=${auditPage}${auditFilterQuery()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const entries = (data.message && data.message.entries) || [];
        auditTotal = (data.message && data.message.total) || 0;
        auditLimit = (data.message && data.message.limit) || 50;

        // Update pagination info
        const pageInfo = document.getElementById('audit-page-info');
        if (pageInfo) pageInfo.textContent = `Page ${auditPage} · ${auditTotal} entries`;
        const auditPrev = document.querySelector('button[data-audit-page="prev"]') as HTMLButtonElement | null;
        const auditNext = document.querySelector('button[data-audit-page="next"]') as HTMLButtonElement | null;
        if (auditPrev) auditPrev.disabled = auditPage <= 1;
        if (auditNext) auditNext.disabled = auditPage * auditLimit >= auditTotal;

        if (entries.length === 0) {
            box.innerHTML = '<p class="text-muted">No audit entries found.</p>';
            return;
        }
        box.innerHTML = `<table class="table table-dark table-striped table-hover admin-table"><thead><tr>
            <th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${
            entries.map((e: any) => {
                const time = e.createdAt ? new Date(e.createdAt).toLocaleString() : '-';
                const target = e.targetLabel
                    ? (e.details ? `${esc(e.targetLabel)} — ${esc(e.details)}` : esc(e.targetLabel))
                    : (e.targetId ? esc(e.targetId) : '-');
                return `<tr>
                    <td>${esc(time)}</td>
                    <td>${esc(e.actorLabel || '-')}</td>
                    <td>${esc(e.action || '-')}</td>
                    <td>${target}</td>
                </tr>`;
            }).join('')
        }</tbody></table>`;
    } catch (err) {
        box.innerHTML = `<p class="text-danger">Error: ${esc((err as Error).message)}</p>`;
    }
}

/* ── Email Delivery ── */

const EVENT_COLORS: Record<string, string> = {
    delivered: 'success', open: 'info', click: 'info',
    bounce: 'danger', dropped: 'danger', spamreport: 'danger', blocked: 'danger',
    deferred: 'warning', processed: 'secondary', queued: 'secondary'
};

// Switch to the Email tab and look up a recipient — used by the per-user
// "view email history" button in the Users table.
function showEmailHistory(email: string) {
    const tabBtn = document.getElementById('email-tab');
    if (tabBtn && (window as any).bootstrap?.Tab) {
        (window as any).bootstrap.Tab.getOrCreateInstance(tabBtn).show();
    }
    const input = document.getElementById('email-search-input') as HTMLInputElement | null;
    if (input) input.value = email;
    loadEmailActivity(email);
}

async function loadEmailActivity(recipient: string) {
    const box = document.getElementById('email-results');
    if (!box) return;
    if (!recipient) { box.innerHTML = '<p class="text-muted">Enter an email address to look up.</p>'; return; }
    currentEmailRecipient = recipient;
    box.innerHTML = '<p class="text-muted">Loading…</p>';
    try {
        const res = await fetch(`${API}/email?recipient=${encodeURIComponent(recipient)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const resolved = data.message && data.message.resolved;
        const notFound = data.message && data.message.notFound;
        // When a callsign resolved to an account, act on its real email for
        // resend/unsuppress (not the raw callsign the admin typed).
        if (resolved && resolved.email) currentEmailRecipient = resolved.email;
        const banner = resolved
            ? `<div class="small text-secondary mb-2">Showing mail for <strong>${esc(resolved.callSign)}</strong> — ${esc(resolved.email)}</div>`
            : '';
        const logs = (data.message && data.message.logs) || [];
        const events = (data.message && data.message.events) || [];

        // Suppressions and controls render regardless of whether send logs
        // exist — a suppressed address often has no recent send history but is
        // exactly the case an admin needs to see and clear.
        const suppressions = (data.message && data.message.suppressions) || [];
        const supHtml = suppressions.length
            ? `<div class="app-card mb-2" style="border-color: var(--hl-danger);">
                 <div class="text-danger"><strong>Suppressed by SendGrid</strong> — future mail is being dropped:</div>
                 ${suppressions.map((s: any) => `<div class="small mt-1 d-flex justify-content-between align-items-center">
                     <span><span class="badge bg-danger">${esc(s.list)}</span> ${s.reason ? esc(s.reason) : ''}</span>
                     <button class="app-btn app-btn-sm" data-email-action="unsuppress" data-list="${esc(s.list)}">Remove &amp; resend</button>
                   </div>`).join('')}
               </div>`
            : '';
        // Only offer resend when we have an actual address to send to.
        const controls = currentEmailRecipient.includes('@')
            ? `<div class="mb-3"><button class="app-btn app-btn-primary app-btn-sm" data-email-action="resend">Resend sign-in link</button></div>`
            : '';

        if (logs.length === 0) {
            if (notFound === 'callsign' && suppressions.length === 0) {
                box.innerHTML = '<p class="text-muted">No account found for callsign "' + esc(recipient) + '". Try their email address, or use Recent Sends below.</p>';
                return;
            }
            const note = `<p class="text-muted">No send history recorded for ${esc(currentEmailRecipient)}.</p>`;
            box.innerHTML = banner + controls + supHtml + note;
            return;
        }
        const byBatch: Record<string, any[]> = {};
        for (const ev of events) { (byBatch[ev.batchId] = byBatch[ev.batchId] || []).push(ev); }
        const logsHtml = logs.map((l: any) => {
            const evs = (byBatch[l.batchId] || []).map((ev: any) => {
                const color = EVENT_COLORS[ev.event] || 'secondary';
                const when = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '';
                return `<div class="small mb-1"><span class="badge bg-${color}">${esc(ev.event)}</span> <span class="text-muted">${when}</span>${ev.reason ? ' — ' + esc(ev.reason) : ''}</div>`;
            }).join('') || '<div class="small text-muted">No delivery events recorded yet.</div>';
            const sent = l.createdAt ? new Date(l.createdAt).toLocaleString() : '';
            return `<div class="app-card mb-2">
                <div><strong>${esc(l.subject || l.type)}</strong> <span class="text-muted small">(${esc(l.type)})</span></div>
                <div class="small text-muted">Sent ${sent} · status: ${esc(l.status)}${l.sgMessageId ? ' · id ' + esc(l.sgMessageId) : ''}</div>
                <div class="mt-2">${evs}</div>
            </div>`;
        }).join('');
        box.innerHTML = banner + controls + supHtml + logsHtml;
    } catch (err) {
        box.innerHTML = `<p class="text-danger">Error: ${esc((err as Error).message)}</p>`;
    }
}

/**
 * Show a magic sign-in link in the email results panel as a click-to-copy element.
 * Used when SendGrid is enabled (production) — the admin can copy the link and
 * manually deliver it to a user whose email is bouncing.
 */
function showCopyableLink(link: string, email: string) {
    const box = document.getElementById('email-results');
    if (!box) return;
    const card = document.createElement('div');
    card.className = 'app-card mb-2';
    card.style.borderColor = '#ffc107';
    const linkId = `magic-link-${Date.now()}`;
    card.innerHTML = `<div class="text-warning small mb-1"><i class="bi bi-link-45deg"></i> Magic sign-in for <strong>${esc(email)}</strong> (click to copy):</div>
        <div class="magic-link-copy" id="${linkId}" style="cursor:pointer; word-break:break-all; font-family:monospace; font-size:12px; color:var(--hl-tertiary);" title="Click to copy magic link">${esc(link)}</div>
        <div class="text-success copy-confirm small mt-1" style="display:none;"><i class="bi bi-check-circle"></i> Copied!</div>`;
    const copyTarget = card.querySelector('.magic-link-copy') as HTMLElement;
    const confirm = card.querySelector('.copy-confirm') as HTMLElement;
    copyTarget.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(link);
        } catch {
            // Fallback for non-HTTPS / older browsers
            const ta = document.createElement('textarea');
            ta.value = link;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        confirm.style.display = 'block';
        setTimeout(() => { confirm.style.display = 'none'; }, 2000);
    });
    box.insertBefore(card, box.firstChild);
    statusMsg('Magic link ready — click to copy', 'success');
}

/* ── Recent Sends ── */

function recentRangeFromControls(presetDays?: number): { from: string; to: string } {
    const to = new Date();
    let from: Date;
    if (presetDays) {
        from = new Date(Date.now() - presetDays * 24 * 3600 * 1000);
    } else {
        const f = (document.getElementById('recent-from') as HTMLInputElement).value;
        const t = (document.getElementById('recent-to') as HTMLInputElement).value;
        from = f ? new Date(f + 'T00:00:00') : new Date(Date.now() - 24 * 3600 * 1000);
        if (t) to.setTime(new Date(t + 'T23:59:59').getTime());
    }
    return { from: from.toISOString(), to: to.toISOString() };
}

let lastRecentRange = { from: '', to: '' };

async function loadRecentEmails(range: { from: string; to: string }) {
    lastRecentRange = range;
    const box = document.getElementById('recent-results');
    const sum = document.getElementById('recent-summary');
    if (!box || !sum) return;
    box.innerHTML = '<p class="text-muted">Loading…</p>'; sum.innerHTML = '';
    try {
        const res = await fetch(`${API}/email/recent?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const rows = (data.message && data.message.rows) || [];
        const summary = (data.message && data.message.summary) || {};
        const capped = data.message && data.message.capped;
        if (rows.length === 0) { box.innerHTML = '<p class="text-muted">No sends in this window.</p>'; return; }
        sum.innerHTML = `${rows.length} sent` + Object.keys(summary).map(k => ` · ${esc(k)}: ${summary[k]}`).join('') + (capped ? ' · <span class="text-warning">(capped at 1000 — narrow the range or use CSV)</span>' : '');
        box.innerHTML = `<table class="table table-dark table-striped table-hover admin-table"><thead><tr>
            <th>Time</th><th>Recipient</th><th>Type</th><th>Subject</th><th>Status</th></tr></thead><tbody>${
            rows.map((r: any) => `<tr>
                <td>${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</td>
                <td>${esc(r.recipient)}</td>
                <td>${r.type === 'magic-login'
        ? `<span class="magic-link-copy-recent" data-action="copy-magic-link" data-recipient="${esc(r.recipient)}" style="cursor:pointer; text-decoration:underline; text-decoration-style:dotted;" title="Click to copy magic sign-in link">${esc(r.type)}</span>`
        : esc(r.type)}</td>
                <td>${esc(r.subject || '')}</td>
                <td><span class="badge bg-${EVENT_COLORS[r.status] || 'secondary'}">${esc(r.status)}</span></td>
            </tr>`).join('')}</tbody></table>`;
    } catch (err) {
        box.innerHTML = `<p class="text-danger">Error: ${esc((err as Error).message)}</p>`;
    }
}

/* ── User Edit / Delete ── */

let currentUserId: string | null = null;
let currentUserEmail = '';

async function editUser(id: string) {
    try {
        const user = usersCache.find((u: any) => u._id === id);
        if (!user) { statusMsg('User not found', 'danger'); return; }
        currentUserId = id;
        editUserWasSuper = !!user.superUser;
        (document.getElementById('edit-user-id') as HTMLInputElement).value = id;
        (document.getElementById('edit-email') as HTMLInputElement).value = user.email || '';
        (document.getElementById('edit-callsign') as HTMLInputElement).value = user.callSign || '';
        (document.getElementById('edit-displayname') as HTMLInputElement).value = user.displayName || '';
        (document.getElementById('edit-location') as HTMLInputElement).value = user.location || '';
        setBanUiState(!!user.locked, user.lockedUntil || null);
        (document.getElementById('edit-superuser') as HTMLInputElement).checked = !!user.superUser;
        const modal = new bootstrap.Modal(document.getElementById('editUserModal')!);
        modal.show();
    } catch (err) {
        statusMsg(`Error loading user: ${(err as Error).message}`, 'danger');
    }
}

async function confirmDelete(id: string, label: string) {
    currentUserId = id;
    document.getElementById('delete-user-body')!.textContent = `Are you sure you want to delete ${label}? This cannot be undone.`;
    const modal = new bootstrap.Modal(document.getElementById('deleteUserModal')!);
    modal.show();
}

/* ── Permanent Toggle ── */

async function togglePermanent(id: string, title: string) {
    const n = netsCache.find((x: any) => x._id === id);
    if (!n) { statusMsg('Net not found', 'danger'); return; }
    const newVal = !n.permanent;
    try {
        const res = await fetch(`${API}/nets/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permanent: newVal })
        });
        if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed'); }
        statusMsg(`Net "${title}" ${newVal ? 'set as permanent' : 'no longer permanent'}`, 'success');
        loadNets();
        loadStats();
    } catch (err) {
        statusMsg(`Error: ${(err as Error).message}`, 'danger');
    }
}

/* ── Schedule Management ── */

async function manageSchedule(id: string, title: string) {
    (document.getElementById('sched-net-id') as HTMLInputElement).value = id;
    document.getElementById('sched-net-title')!.textContent = title;
    try {
        const res = await fetch(`${API}/nets`);
        const data = await res.json();
        const nets = data.message || [];
        const net = nets.find((n: any) => n._id === id);
        if (!net) { statusMsg('Net not found', 'danger'); return; }
        const s = net.schedule || {};
        (document.getElementById('sched-enabled') as HTMLInputElement).checked = !!s.enabled;
        (document.getElementById('sched-day') as HTMLSelectElement).value = s.dayOfWeek ?? 0;
        if (s.hour !== undefined && s.minute !== undefined) {
            (document.getElementById('sched-time') as HTMLInputElement).value = `${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')}`;
        }
        (document.getElementById('sched-tz') as HTMLSelectElement).value = s.timezone || 'UTC';
        document.getElementById('sched-status')!.textContent = s.enabled ? 'Active' : 'Disabled';
        document.getElementById('sched-status')!.className = s.enabled ? 'text-success' : 'text-muted';
    } catch (err) {
        statusMsg(`Error: ${(err as Error).message}`, 'danger');
    }
    const modal = new bootstrap.Modal(document.getElementById('scheduleModal')!);
    modal.show();
}

(document.getElementById('sched-save-btn') as HTMLButtonElement)?.addEventListener('click', async () => {
    const id = (document.getElementById('sched-net-id') as HTMLInputElement).value;
    const enabled = (document.getElementById('sched-enabled') as HTMLInputElement).checked;
    const timeVal = (document.getElementById('sched-time') as HTMLInputElement).value;
    let hour = 0, minute = 0;
    if (timeVal) {
        const p = timeVal.split(':');
        hour = parseInt(p[0], 10);
        minute = parseInt(p[1], 10);
    }
    try {
        const res = await fetch(`${API}/nets/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                schedule: {
                    enabled,
                    dayOfWeek: parseInt((document.getElementById('sched-day') as HTMLSelectElement).value, 10),
                    hour,
                    minute,
                    timezone: (document.getElementById('sched-tz') as HTMLSelectElement).value
                }
            })
        });
        if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed'); }
        bootstrap.Modal.getInstance(document.getElementById('scheduleModal')!)?.hide();
        statusMsg('Schedule updated', 'success');
        loadNets();
        loadStats();
    } catch (err) {
        statusMsg(`Error: ${(err as Error).message}`, 'danger');
    }
});

let currentNetId: string | null = null;
let currentNetTitle = '';

function confirmNetDelete(id: string, title: string) {
    currentNetId = id;
    currentNetTitle = title;
    document.getElementById('delete-net-body')!.textContent = `Delete net "${title}"? This will also delete any associated live net and cannot be undone.`;
    const modal = new bootstrap.Modal(document.getElementById('deleteNetModal')!);
    modal.show();
}

(document.getElementById('delete-net-confirm-btn') as HTMLButtonElement)?.addEventListener('click', async () => {
    if (!currentNetId) return;
    try {
        const res = await fetch(`${API}/nets/${currentNetId}`, { method: 'DELETE' });
        if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Delete failed'); }
        bootstrap.Modal.getInstance(document.getElementById('deleteNetModal')!)?.hide();
        statusMsg(`Net "${currentNetTitle}" deleted`, 'success'); // statusMsg() escapes its text
        loadNets();
        loadStats();
    } catch (err) {
        statusMsg(`Error: ${(err as Error).message}`, 'danger');
    }
    currentNetId = null;
});

// Event handlers
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadUsers();

    // Delegated row-action handlers. Listeners live on the <tbody> (which is
    // not replaced when its rows re-render) and read data-* attributes, so no
    // inline onclick is needed — keeps us compatible with the CSP
    // (script-src-attr 'none' blocks inline event handlers).
    const usersTbody = document.getElementById('admin-users-tbody');
    usersTbody?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
        if (!btn || !usersTbody.contains(btn)) return;
        const id = btn.getAttribute('data-id') as string;
        switch (btn.getAttribute('data-action')) {
            case 'edit-user':
                editUser(id);
                break;
            case 'email-history': {
                const u = usersCache.find((x: any) => x._id === id);
                if (u && u.email) showEmailHistory(u.email);
                break;
            }
            case 'delete-user': {
                const u = usersCache.find((x: any) => x._id === id);
                confirmDelete(id, u ? (u.callSign || u.email) : 'this user');
                break;
            }
        }
    });

    const netsTbody = document.getElementById('admin-nets-tbody');
    netsTbody?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
        if (!btn || !netsTbody.contains(btn)) return;
        const id = btn.getAttribute('data-id') as string;
        const n = netsCache.find((x: any) => x._id === id);
        switch (btn.getAttribute('data-action')) {
            case 'toggle-perm':
                togglePermanent(id, n ? n.title : '');
                break;
            case 'manage-schedule':
                manageSchedule(id, n ? n.title : '');
                break;
            case 'delete-net':
                confirmNetDelete(id, n ? n.title : 'this net');
                break;
        }
    });

    // Column header click — sort users or nets
    document.addEventListener('click', (e) => {
        const th = (e.target as HTMLElement).closest('th[data-sort-field]') as HTMLElement | null;
        if (!th) return;
        const field = th.getAttribute('data-sort-field') || '';
        const table = th.closest('table');
        if (!table) return;
        const tableId = table.id || '';

        if (tableId === 'admin-users-tbody' || table.closest('#users-panel')) {
            if (usersSortField === field) {
                usersSortDir = usersSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                usersSortField = field;
                usersSortDir = 'asc';
            }
            usersPage = 1;
            loadUsers();
        } else if (tableId === 'admin-nets-tbody' || table.closest('#nets-panel')) {
            if (netsSortMode === field) {
                // Same field: toggle asc → desc → active
                if (netsSortDir === 'asc') {
                    netsSortDir = 'desc';
                } else {
                    netsSortMode = 'active';
                    netsSortDir = null;
                }
            } else {
                // New field: set to ascending
                netsSortMode = field;
                netsSortDir = 'asc';
            }
            loadNets();
        }
    });

    // User search — debounced input
    let userSearchTimer: ReturnType<typeof setTimeout> | null = null;
    document.getElementById('user-search-input')?.addEventListener('input', (e) => {
        if (userSearchTimer) clearTimeout(userSearchTimer);
        userSearchTimer = setTimeout(() => {
            usersSearch = (e.target as HTMLInputElement).value.trim();
            usersPage = 1;
            loadUsers();
        }, 300);
    });

    // User pagination clicks
    document.getElementById('users-prev')?.addEventListener('click', () => {
        usersPage = Math.max(1, usersPage - 1);
        loadUsers();
    });
    document.getElementById('users-next')?.addEventListener('click', () => {
        usersPage++;
        loadUsers();
    });

    // Audit pagination clicks (delegated on document since buttons are inside tab-pane)
    document.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button[data-audit-page]') as HTMLButtonElement | null;
        if (!btn) return;
        const dir = btn.getAttribute('data-audit-page');
        if (dir === 'prev') auditPage = Math.max(1, auditPage - 1);
        else if (dir === 'next') auditPage++;
        loadAudit();
    });

    // Audit filters
    const applyAuditFilters = () => {
        auditActor = (document.getElementById('audit-actor-input') as HTMLInputElement | null)?.value.trim() || '';
        auditAction = (document.getElementById('audit-action-input') as HTMLInputElement | null)?.value.trim() || '';
        auditPage = 1;
        loadAudit();
    };
    document.getElementById('audit-apply-btn')?.addEventListener('click', applyAuditFilters);
    document.getElementById('audit-action-input')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') applyAuditFilters();
    });
    document.getElementById('audit-actor-input')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') applyAuditFilters();
    });
    document.getElementById('audit-clear-btn')?.addEventListener('click', () => {
        const actorEl = document.getElementById('audit-actor-input') as HTMLInputElement | null;
        const actionEl = document.getElementById('audit-action-input') as HTMLInputElement | null;
        if (actorEl) actorEl.value = '';
        if (actionEl) actionEl.value = '';
        auditActor = ''; auditAction = ''; auditPage = 1;
        loadAudit();
    });
    document.getElementById('audit-csv-btn')?.addEventListener('click', () => {
        window.location.href = `${API}/audit?format=csv${auditFilterQuery()}`;
    });

    // Tab switching — reload data when tabs change
    document.getElementById('nets-tab')?.addEventListener('shown.bs.tab', () => {
        loadNets();
    });
    document.getElementById('users-tab')?.addEventListener('shown.bs.tab', () => {
        loadUsers();
    });
    document.getElementById('audit-tab')?.addEventListener('shown.bs.tab', () => {
        loadAudit();
    });

    document.getElementById('email-search-btn')?.addEventListener('click', () => {
        const v = (document.getElementById('email-search-input') as HTMLInputElement).value.trim();
        loadEmailActivity(v);
    });
    document.getElementById('email-search-input')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
            loadEmailActivity((e.target as HTMLInputElement).value.trim());
        }
    });

    const emailResults = document.getElementById('email-results');
    emailResults?.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('button[data-email-action]') as HTMLButtonElement | null;
        if (!btn || !emailResults.contains(btn)) return;
        const action = btn.getAttribute('data-email-action');
        const email = currentEmailRecipient;
        if (!email) return;
        btn.disabled = true;
        try {
            if (action === 'resend') {
                const res = await fetch(`${API}/email/resend-login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed');
                const body = await res.json();
                const devMagicLink = body.message && body.message.devMagicLink;
                if (devMagicLink) {
                    showCopyableLink(devMagicLink, email);
                } else {
                    statusMsg('Sign-in link resent', 'success');
                }
            } else if (action === 'unsuppress') {
                const list = btn.getAttribute('data-list');
                const res = await fetch(`${API}/email/unsuppress`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, list })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed');
                const body = await res.json();
                const devMagicLink = body.message && body.message.devMagicLink;
                if (devMagicLink) {
                    showCopyableLink(devMagicLink, email);
                } else {
                    statusMsg('Suppression removed and link resent', 'success');
                }
                loadEmailActivity(email);
            }
        } catch (err) {
            statusMsg(`Error: ${(err as Error).message}`, 'danger');
        } finally {
            btn.disabled = false;
        }
    });

    // Recent Sends table: click magic-login type cell to mint a fresh single-use
    // link and copy it — generate-only, so no email is sent to a bouncing address.
    const recentResults = document.getElementById('recent-results');
    recentResults?.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest('[data-action="copy-magic-link"]') as HTMLElement | null;
        if (!el) return;
        const recipient = el.getAttribute('data-recipient');
        if (!recipient) return;
        const origText = el.textContent;
        el.textContent = '…';
        try {
            const res = await fetch(`${API}/email/generate-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: recipient })
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed');
            const body = await res.json();
            const devMagicLink = body.message && body.message.devMagicLink;
            if (devMagicLink) {
                try {
                    await navigator.clipboard.writeText(devMagicLink);
                } catch {
                    const ta = document.createElement('textarea');
                    ta.value = devMagicLink;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                el.textContent = 'Copied!';
                el.style.color = '#3cce3c';
                setTimeout(() => { el.textContent = origText; el.style.color = ''; }, 1500);
            } else {
                el.textContent = origText;
                statusMsg('Link generated but could not be read from the response', 'warning');
            }
        } catch (err) {
            el.textContent = origText;
            statusMsg(`Error: ${(err as Error).message}`, 'danger');
        }
    });

    document.getElementById('edit-ban-btn')?.addEventListener('click', () => {
        const hidden = document.getElementById('edit-locked') as HTMLInputElement | null;
        if (!hidden) return;
        const nowBanned = hidden.value !== 'true'; // toggle
        setBanUiState(nowBanned, null);
    });
    document.getElementById('edit-lock-duration')?.addEventListener('change', e => {
        const custom = document.getElementById('edit-lock-custom') as HTMLInputElement;
        custom.style.display = (e.target as HTMLSelectElement).value === 'custom' ? 'block' : 'none';
    });

    (document.getElementById('edit-save-btn') as HTMLButtonElement)?.addEventListener('click', async () => {
        const id = (document.getElementById('edit-user-id') as HTMLInputElement).value;
        if (!id) return;
        const superUserChecked = (document.getElementById('edit-superuser') as HTMLInputElement).checked;
        if (superUserChecked !== editUserWasSuper) {
            if (!confirm((superUserChecked ? 'Grant' : 'Revoke') + ' admin for this user?')) return;
        }
        const payload = {
            displayName: (document.getElementById('edit-displayname') as HTMLInputElement).value.trim(),
            callSign: (document.getElementById('edit-callsign') as HTMLInputElement).value.trim(),
            location: (document.getElementById('edit-location') as HTMLInputElement).value.trim(),
            locked: (document.getElementById('edit-locked') as HTMLInputElement).value === 'true',
            lockedUntil: (document.getElementById('edit-locked') as HTMLInputElement).value === 'true'
                ? expiryFromPreset(
                    (document.getElementById('edit-lock-duration') as HTMLSelectElement).value,
                    (document.getElementById('edit-lock-custom') as HTMLInputElement).value)
                : null,
            superUser: superUserChecked
        };
        try {
            const res = await fetch(`${API}/users/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Save failed');
            }
            bootstrap.Modal.getInstance(document.getElementById('editUserModal')!)?.hide();
            statusMsg('User updated successfully', 'success');
            loadUsers();
            loadStats();
        } catch (err) {
            statusMsg(`Error saving: ${(err as Error).message}`, 'danger');
        }
    });

    (document.getElementById('delete-confirm-btn') as HTMLButtonElement)?.addEventListener('click', async () => {
        if (!currentUserId) return;
        try {
            const res = await fetch(`${API}/users/${currentUserId}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Delete failed');
            }
            bootstrap.Modal.getInstance(document.getElementById('deleteUserModal')!)?.hide();
            statusMsg('User deleted', 'success');
            loadUsers();
            loadStats();
        } catch (err) {
            statusMsg(`Error deleting: ${(err as Error).message}`, 'danger');
        }
        currentUserId = null;
    });

    const emailPanel = document.getElementById('email-panel');
    emailPanel?.addEventListener('click', (e) => {
        const preset = (e.target as HTMLElement).closest('button[data-recent-preset]') as HTMLButtonElement | null;
        if (preset && emailPanel.contains(preset)) {
            loadRecentEmails(recentRangeFromControls(parseInt(preset.getAttribute('data-recent-preset') as string, 10)));
        }
    });
    // First open of the Email tab: show the last 24h of sends by default
    // (also fires when the Users-table "view email history" jump opens the tab).
    document.getElementById('email-tab')?.addEventListener('shown.bs.tab', () => {
        loadRecentEmails(recentRangeFromControls(1));
    }, { once: true });
    document.getElementById('recent-load-btn')?.addEventListener('click', () => loadRecentEmails(recentRangeFromControls()));
    document.getElementById('recent-csv-btn')?.addEventListener('click', () => {
        const range = lastRecentRange.from ? lastRecentRange : recentRangeFromControls();
        window.location.href = `${API}/email/recent?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&format=csv`;
    });

    // Email Settings UI (provider config + template editor)
    initEmailSettings().catch(err => console.error('initEmailSettings failed', err));
});
