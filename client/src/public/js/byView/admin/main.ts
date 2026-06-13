// @ts-nocheck
/* hamlive-oss — MIT License. See LICENSE. */

'use strict';

/**
 * Admin panel — user and net management (superUser only).
 */

const API = '/api/admin';

// Cache the most recently loaded rows so action handlers can look up labels by
// id without re-interpolating strings into HTML attributes.
let usersCache: any[] = [];
let netsCache: any[] = [];
let currentEmailRecipient = '';

function statusMsg(text: string, type: string = 'info') {
    const el = document.getElementById('admin-status');
    if (el) {
        el.innerHTML = `<span class="text-${type}">${text}</span>`;
        setTimeout(() => { el.innerHTML = ''; }, 5000);
    }
}

function esc(s: string): string {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
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
        const res = await fetch(`${API}/users`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const users = data.message || [];
        usersCache = users;
        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No users found</td></tr>';
            return;
        }
        tbody.innerHTML = users.map((u: any) => {
            const badges = [];
            if (u.locked) badges.push('<span class="badge badge-locked">Locked</span>');
            if (u.superUser) badges.push('<span class="badge badge-super">Admin</span>');
            if (u.newAccount) badges.push('<span class="badge badge-new">New</span>');
            if (u.flaggedForDeletion) badges.push('<span class="badge badge-flagged">Flagged</span>');
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
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Loading...</td></tr>';
    try {
        const res = await fetch(`${API}/nets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const nets = data.message || [];
        netsCache = nets;
        if (nets.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No net profiles found</td></tr>';
            return;
        }
        tbody.innerHTML = nets.map((n: any) => {
            const owners = (n.owners || []).map((o: any) => o.callSign || o.email).join(', ') || '-';
            const freqMode = `<span class="freq-mode">${esc(n.frequency || '—')} / ${esc(n.mode || '—')}</span>`;

            let statusBadge = '<span class="badge bg-secondary">Inactive</span>';
            if (n.hasLiveNet) {
                if (n.liveNetStatus === 'waiting') statusBadge = '<span class="badge badge-waiting">Waiting</span>';
                else statusBadge = '<span class="badge badge-live">Live</span>';
            }

            let scheduleInfo = '<span class="text-muted">—</span>';
            if (n.schedule && n.schedule.enabled) {
                const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                const day = days[n.schedule.dayOfWeek] || '?';
                const h = String(n.schedule.hour || 0).padStart(2, '0');
                const m = String(n.schedule.minute || 0).padStart(2, '0');
                scheduleInfo = `<span class="badge badge-scheduled">${day} ${h}:${m}</span>`;
            }

            const created = n.createdAt ? new Date(n.createdAt).toLocaleDateString() : '-';
            return `<tr>
                <td><strong>${esc(n.title)}</strong></td>
                <td>${freqMode}</td>
                <td>${esc(owners)}</td>
                <td>${statusBadge}</td>
                <td>${scheduleInfo}</td>
                <td>${created}</td>
                <td>
                    <button class="btn btn-sm btn-outline-warning me-1" data-action="manage-schedule" data-id="${n._id}" title="Manage Schedule"><i class="bi bi-calendar-week"></i></button>
                    <button class="btn btn-sm btn-outline-danger" data-action="delete-net" data-id="${n._id}" title="Delete Net"><i class="bi bi-trash"></i></button>
                </td>
            </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Failed to load nets</td></tr>';
        statusMsg(`Error loading nets: ${(err as Error).message}`, 'danger');
    }
}

/* ── Email Delivery ── */

const EVENT_COLORS: Record<string, string> = {
    delivered: 'success', open: 'info', click: 'info',
    bounce: 'danger', dropped: 'danger', spamreport: 'danger', blocked: 'danger',
    deferred: 'warning', processed: 'secondary', queued: 'secondary'
};

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
        const banner = resolved
            ? `<div class="small text-secondary mb-2">Showing mail for <strong>${esc(resolved.callSign)}</strong> — ${esc(resolved.email)}</div>`
            : '';
        const logs = (data.message && data.message.logs) || [];
        const events = (data.message && data.message.events) || [];
        if (logs.length === 0) {
            if (notFound === 'callsign') {
                box.innerHTML = '<p class="text-muted">No account found for callsign "' + esc(recipient) + '". Try their email address, or use Recent Sends below.</p>';
                return;
            }
            box.innerHTML = `<p class="text-muted">No emails found for ${esc(recipient)}.</p>`; return;
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
        const controls = `<div class="mb-3"><button class="app-btn app-btn-primary app-btn-sm" data-email-action="resend">Resend sign-in link</button></div>`;
        box.innerHTML = banner + controls + supHtml + logsHtml;
    } catch (err) {
        box.innerHTML = `<p class="text-danger">Error: ${esc((err as Error).message)}</p>`;
    }
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
                <td>${esc(r.type)}</td>
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
        const res = await fetch(`${API}/users`);
        const data = await res.json();
        const users = data.message || [];
        const user = users.find((u: any) => u._id === id);
        if (!user) { statusMsg('User not found', 'danger'); return; }
        currentUserId = id;
        (document.getElementById('edit-user-id') as HTMLInputElement).value = id;
        (document.getElementById('edit-email') as HTMLInputElement).value = user.email || '';
        (document.getElementById('edit-callsign') as HTMLInputElement).value = user.callSign || '';
        (document.getElementById('edit-displayname') as HTMLInputElement).value = user.displayName || '';
        (document.getElementById('edit-location') as HTMLInputElement).value = user.location || '';
        (document.getElementById('edit-locked') as HTMLInputElement).checked = !!user.locked;
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
                    minute
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
        statusMsg(`Net "${currentNetTitle}" deleted`, 'success');
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
            case 'manage-schedule':
                manageSchedule(id, n ? n.title : '');
                break;
            case 'delete-net':
                confirmNetDelete(id, n ? n.title : 'this net');
                break;
        }
    });

    // Tab switching — reload data when tabs change
    document.getElementById('nets-tab')?.addEventListener('shown.bs.tab', () => {
        loadNets();
    });
    document.getElementById('users-tab')?.addEventListener('shown.bs.tab', () => {
        loadUsers();
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
                statusMsg('Sign-in link resent', 'success');
            } else if (action === 'unsuppress') {
                const list = btn.getAttribute('data-list');
                const res = await fetch(`${API}/email/unsuppress`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, list })
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Failed');
                statusMsg('Suppression removed and link resent', 'success');
                loadEmailActivity(email);
            }
        } catch (err) {
            statusMsg(`Error: ${(err as Error).message}`, 'danger');
        } finally {
            btn.disabled = false;
        }
    });

    (document.getElementById('edit-save-btn') as HTMLButtonElement)?.addEventListener('click', async () => {
        const id = (document.getElementById('edit-user-id') as HTMLInputElement).value;
        if (!id) return;
        const payload = {
            displayName: (document.getElementById('edit-displayname') as HTMLInputElement).value.trim(),
            callSign: (document.getElementById('edit-callsign') as HTMLInputElement).value.trim(),
            location: (document.getElementById('edit-location') as HTMLInputElement).value.trim(),
            locked: (document.getElementById('edit-locked') as HTMLInputElement).checked,
            superUser: (document.getElementById('edit-superuser') as HTMLInputElement).checked
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
    document.getElementById('recent-load-btn')?.addEventListener('click', () => loadRecentEmails(recentRangeFromControls()));
    document.getElementById('recent-csv-btn')?.addEventListener('click', () => {
        const range = lastRecentRange.from ? lastRecentRange : recentRangeFromControls();
        window.location.href = `${API}/email/recent?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&format=csv`;
    });
});
