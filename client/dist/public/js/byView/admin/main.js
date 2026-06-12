'use strict';
const API = '/api/admin';
let usersCache = [];
let netsCache = [];
function statusMsg(text, type = 'info') {
    const el = document.getElementById('admin-status');
    if (el) {
        el.innerHTML = `<span class="text-${type}">${text}</span>`;
        setTimeout(() => { el.innerHTML = ''; }, 5000);
    }
}
function esc(s) {
    if (!s)
        return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
async function loadStats() {
    try {
        const res = await fetch(`${API}/stats`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const s = data.message || {};
        document.getElementById('stat-users').textContent = s.totalUsers ?? '-';
        document.getElementById('stat-nets').textContent = s.totalNets ?? '-';
        document.getElementById('stat-live').textContent = s.liveNetsCount ?? '-';
        document.getElementById('stat-scheduled').textContent = s.scheduledNetsCount ?? '-';
    }
    catch (err) {
        console.error('Stats error:', err);
    }
}
async function loadUsers() {
    const tbody = document.getElementById('admin-users-tbody');
    if (!tbody)
        return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Loading...</td></tr>';
    try {
        const res = await fetch(`${API}/users`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const users = data.message || [];
        usersCache = users;
        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No users found</td></tr>';
            return;
        }
        tbody.innerHTML = users.map((u) => {
            const badges = [];
            if (u.locked)
                badges.push('<span class="badge badge-locked">Locked</span>');
            if (u.superUser)
                badges.push('<span class="badge badge-super">Admin</span>');
            if (u.newAccount)
                badges.push('<span class="badge badge-new">New</span>');
            if (u.flaggedForDeletion)
                badges.push('<span class="badge badge-flagged">Flagged</span>');
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
    }
    catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Failed to load users</td></tr>';
        statusMsg(`Error loading users: ${err.message}`, 'danger');
    }
}
async function loadNets() {
    const tbody = document.getElementById('admin-nets-tbody');
    if (!tbody)
        return;
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Loading...</td></tr>';
    try {
        const res = await fetch(`${API}/nets`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const nets = data.message || [];
        netsCache = nets;
        if (nets.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No net profiles found</td></tr>';
            return;
        }
        tbody.innerHTML = nets.map((n) => {
            const owners = (n.owners || []).map((o) => o.callSign || o.email).join(', ') || '-';
            const freqMode = `<span class="freq-mode">${esc(n.frequency || '—')} / ${esc(n.mode || '—')}</span>`;
            let statusBadge = '<span class="badge bg-secondary">Inactive</span>';
            if (n.hasLiveNet) {
                if (n.liveNetStatus === 'waiting')
                    statusBadge = '<span class="badge badge-waiting">Waiting</span>';
                else
                    statusBadge = '<span class="badge badge-live">Live</span>';
            }
            let scheduleInfo = '<span class="text-muted">—</span>';
            if (n.schedule && n.schedule.enabled) {
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
    }
    catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Failed to load nets</td></tr>';
        statusMsg(`Error loading nets: ${err.message}`, 'danger');
    }
}
let currentUserId = null;
let currentUserEmail = '';
async function editUser(id) {
    try {
        const res = await fetch(`${API}/users`);
        const data = await res.json();
        const users = data.message || [];
        const user = users.find((u) => u._id === id);
        if (!user) {
            statusMsg('User not found', 'danger');
            return;
        }
        currentUserId = id;
        document.getElementById('edit-user-id').value = id;
        document.getElementById('edit-email').value = user.email || '';
        document.getElementById('edit-callsign').value = user.callSign || '';
        document.getElementById('edit-displayname').value = user.displayName || '';
        document.getElementById('edit-location').value = user.location || '';
        document.getElementById('edit-locked').checked = !!user.locked;
        document.getElementById('edit-superuser').checked = !!user.superUser;
        const modal = new bootstrap.Modal(document.getElementById('editUserModal'));
        modal.show();
    }
    catch (err) {
        statusMsg(`Error loading user: ${err.message}`, 'danger');
    }
}
async function confirmDelete(id, label) {
    currentUserId = id;
    document.getElementById('delete-user-body').textContent = `Are you sure you want to delete ${label}? This cannot be undone.`;
    const modal = new bootstrap.Modal(document.getElementById('deleteUserModal'));
    modal.show();
}
async function manageSchedule(id, title) {
    document.getElementById('sched-net-id').value = id;
    document.getElementById('sched-net-title').textContent = title;
    try {
        const res = await fetch(`${API}/nets`);
        const data = await res.json();
        const nets = data.message || [];
        const net = nets.find((n) => n._id === id);
        if (!net) {
            statusMsg('Net not found', 'danger');
            return;
        }
        const s = net.schedule || {};
        document.getElementById('sched-enabled').checked = !!s.enabled;
        document.getElementById('sched-day').value = s.dayOfWeek ?? 0;
        if (s.hour !== undefined && s.minute !== undefined) {
            document.getElementById('sched-time').value = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
        }
        document.getElementById('sched-status').textContent = s.enabled ? 'Active' : 'Disabled';
        document.getElementById('sched-status').className = s.enabled ? 'text-success' : 'text-muted';
    }
    catch (err) {
        statusMsg(`Error: ${err.message}`, 'danger');
    }
    const modal = new bootstrap.Modal(document.getElementById('scheduleModal'));
    modal.show();
}
document.getElementById('sched-save-btn')?.addEventListener('click', async () => {
    const id = document.getElementById('sched-net-id').value;
    const enabled = document.getElementById('sched-enabled').checked;
    const timeVal = document.getElementById('sched-time').value;
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
                    dayOfWeek: parseInt(document.getElementById('sched-day').value, 10),
                    hour,
                    minute
                }
            })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed');
        }
        bootstrap.Modal.getInstance(document.getElementById('scheduleModal'))?.hide();
        statusMsg('Schedule updated', 'success');
        loadNets();
        loadStats();
    }
    catch (err) {
        statusMsg(`Error: ${err.message}`, 'danger');
    }
});
let currentNetId = null;
let currentNetTitle = '';
function confirmNetDelete(id, title) {
    currentNetId = id;
    currentNetTitle = title;
    document.getElementById('delete-net-body').textContent = `Delete net "${title}"? This will also delete any associated live net and cannot be undone.`;
    const modal = new bootstrap.Modal(document.getElementById('deleteNetModal'));
    modal.show();
}
document.getElementById('delete-net-confirm-btn')?.addEventListener('click', async () => {
    if (!currentNetId)
        return;
    try {
        const res = await fetch(`${API}/nets/${currentNetId}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Delete failed');
        }
        bootstrap.Modal.getInstance(document.getElementById('deleteNetModal'))?.hide();
        statusMsg(`Net "${currentNetTitle}" deleted`, 'success');
        loadNets();
        loadStats();
    }
    catch (err) {
        statusMsg(`Error: ${err.message}`, 'danger');
    }
    currentNetId = null;
});
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    loadUsers();
    const usersTbody = document.getElementById('admin-users-tbody');
    usersTbody?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn || !usersTbody.contains(btn))
            return;
        const id = btn.getAttribute('data-id');
        switch (btn.getAttribute('data-action')) {
            case 'edit-user':
                editUser(id);
                break;
            case 'delete-user': {
                const u = usersCache.find((x) => x._id === id);
                confirmDelete(id, u ? (u.callSign || u.email) : 'this user');
                break;
            }
        }
    });
    const netsTbody = document.getElementById('admin-nets-tbody');
    netsTbody?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn || !netsTbody.contains(btn))
            return;
        const id = btn.getAttribute('data-id');
        const n = netsCache.find((x) => x._id === id);
        switch (btn.getAttribute('data-action')) {
            case 'manage-schedule':
                manageSchedule(id, n ? n.title : '');
                break;
            case 'delete-net':
                confirmNetDelete(id, n ? n.title : 'this net');
                break;
        }
    });
    document.getElementById('nets-tab')?.addEventListener('shown.bs.tab', () => {
        loadNets();
    });
    document.getElementById('users-tab')?.addEventListener('shown.bs.tab', () => {
        loadUsers();
    });
    document.getElementById('edit-save-btn')?.addEventListener('click', async () => {
        const id = document.getElementById('edit-user-id').value;
        if (!id)
            return;
        const payload = {
            displayName: document.getElementById('edit-displayname').value.trim(),
            callSign: document.getElementById('edit-callsign').value.trim(),
            location: document.getElementById('edit-location').value.trim(),
            locked: document.getElementById('edit-locked').checked,
            superUser: document.getElementById('edit-superuser').checked
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
            bootstrap.Modal.getInstance(document.getElementById('editUserModal'))?.hide();
            statusMsg('User updated successfully', 'success');
            loadUsers();
            loadStats();
        }
        catch (err) {
            statusMsg(`Error saving: ${err.message}`, 'danger');
        }
    });
    document.getElementById('delete-confirm-btn')?.addEventListener('click', async () => {
        if (!currentUserId)
            return;
        try {
            const res = await fetch(`${API}/users/${currentUserId}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Delete failed');
            }
            bootstrap.Modal.getInstance(document.getElementById('deleteUserModal'))?.hide();
            statusMsg('User deleted', 'success');
            loadUsers();
            loadStats();
        }
        catch (err) {
            statusMsg(`Error deleting: ${err.message}`, 'danger');
        }
        currentUserId = null;
    });
});
//# sourceMappingURL=main.js.map