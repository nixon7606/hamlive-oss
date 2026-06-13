# Admin Hardening (Audit Log + Guardrails + User Search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make delegating admin safe and the site manageable: an audit trail of privileged actions, lockout guardrails, and a searchable/paginated user list.

**Architecture:** A new `adminAudit` collection + a `recordAudit(req, {...})` helper invoked from privileged admin actions, surfaced in a read-only Audit tab. Guardrails in `updateUser`/`deleteUser` prevent self-lockout and last-admin removal. `listUsers` gains search + pagination. All endpoints stay superUser-gated.

**Tech Stack:** Node/Express, Mongoose 6, EJS, TypeScript (client→dist), Jest+Supertest+mongodb-memory-server.

**Scope:** Part 2 of `docs/superpowers/specs/2026-06-12-admin-email-observability-and-management-design.md`.

---

### Task 1: Audit log + lockout guardrails (backend)

**Files:** Create `server/dist/models/adminAudit.js`; Modify `server/dist/controllers/adminController.js`; Modify `server/dist/routes/adminRoutes.js`; Test `tests/server/routes/adminAuditGuardrails.test.js`.

- [ ] **Step 1 — `adminAudit` model** (`server/dist/models/adminAudit.js`), mirroring the `emailLog` model style (modelMaker, `{ timestamps: true }`):
```js
/* hamlive-oss — MIT License. See LICENSE. */
const { modelMaker } = require('../lib/modelMaker');
const { Schema } = require('mongoose');
const adminAuditSchema = new Schema({
    actorId:     { type: Schema.Types.ObjectId, ref: 'UserProfile' },
    actorLabel:  { type: String },          // actor email/callsign at action time
    action:      { type: String, required: true },   // e.g. grant-admin, revoke-admin, lock-user, delete-user, delete-net, resend-login, unsuppress
    targetType:  { type: String },          // 'user' | 'net' | 'email'
    targetId:    { type: String },
    targetLabel: { type: String },
    details:     { type: String }
}, { timestamps: true });
adminAuditSchema.index({ createdAt: -1 });
module.exports = { getAdminAudit: db => modelMaker({ db, m: 'AdminAudit', s: adminAuditSchema }), adminAuditSchema };
```

- [ ] **Step 2 — `recordAudit` helper + requires** in `adminController.js` (add `const { getAdminAudit } = require('../models/adminAudit');` with the other requires). Fire-and-forget so auditing never breaks the action:
```js
function recordAudit(req, entry) {
    try {
        const AdminAudit = getAdminAudit();
        AdminAudit.create({
            actorId: req.user && req.user._id,
            actorLabel: (req.user && (req.user.email || req.user.callSign)) || 'unknown',
            ...entry
        }).catch(err => logger.error(`recordAudit failed: ${err.message}`));
    } catch (err) { logger.error(`recordAudit failed: ${err.message}`); }
}
```

- [ ] **Step 3 — Guardrails in `updateUser`.** Before applying updates, load the target and enforce:
  - Self-lockout: if `String(id) === String(req.user._id)` and (`updates.superUser === false` or `updates.locked === true`) → throw `Error('You cannot remove your own admin or lock your own account.')`.
  - Last-admin: if `updates.superUser === false` and the target is currently `superUser`, count superusers; if `<= 1` → throw `Error('Cannot remove the last remaining admin.')`.
  Implement by fetching the target first (`const target = await UserProfile.findById(id).lean();` → 404 if missing), running the checks, then the existing `findByIdAndUpdate`. After a successful update, `recordAudit` the change:
```js
        // (after the successful update, before return)
        if (updates.superUser !== undefined && updates.superUser !== target.superUser) {
            recordAudit(req, { action: updates.superUser ? 'grant-admin' : 'revoke-admin', targetType: 'user', targetId: String(id), targetLabel: user.email || user.callSign });
        }
        if (updates.locked !== undefined && updates.locked !== target.locked) {
            recordAudit(req, { action: updates.locked ? 'lock-user' : 'unlock-user', targetType: 'user', targetId: String(id), targetLabel: user.email || user.callSign });
        }
```

- [ ] **Step 4 — Guardrails + audit in `deleteUser`.** Fetch target first; if target `superUser` and superuser count `<= 1` → throw `Error('Cannot delete the last remaining admin.')`. Also if `String(id) === String(req.user._id)` → throw `Error('Use account settings to delete your own account.')`. Then delete; then `recordAudit(req, { action: 'delete-user', targetType: 'user', targetId: String(id), targetLabel: user.email || user.callSign })`.

- [ ] **Step 5 — Audit the other privileged actions:** in `deleteNet` → `recordAudit(req,{action:'delete-net',targetType:'net',targetId:String(req.params.id),targetLabel:<net title if available>})`; in `resendSignInLink` → `recordAudit(req,{action:'resend-login',targetType:'email',targetLabel:email})`; in `unsuppressEmail` → `recordAudit(req,{action:'unsuppress',targetType:'email',targetLabel:email,details:list})`.

- [ ] **Step 6 — Audit list endpoint** `listAudit` (paginated, newest first):
```js
const listAudit = async (req, res) => {
    handleRequest(res, async () => {
        const AdminAudit = getAdminAudit();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const [entries, total] = await Promise.all([
            AdminAudit.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            AdminAudit.countDocuments({})
        ]);
        return { message: { entries, total, page, limit } };
    }, 'admin: listAudit');
};
```
Add `listAudit` (and keep all existing) to `module.exports`. Register `router.get('/audit', listAudit)` in `adminRoutes.js` (under the gate).

- [ ] **Step 7 — Test** (`tests/server/routes/adminAuditGuardrails.test.js`): mount `updateUser`/`deleteUser`/`listAudit` on a bare app (mock `responseUtils.handleRequest` per existing tests; register `UserProfile` + `AdminAudit` models against mongodb-memory-server). Cases:
  - updateUser revoking own admin (`req.user._id === id`, `superUser:false`) → 500/error, user unchanged.
  - updateUser revoking the only admin → error.
  - updateUser granting admin to a normal user → succeeds AND writes an `adminaudits` entry with `action:'grant-admin'`.
  - deleteUser on the last admin → error.
  - listAudit returns entries newest-first with `{entries,total,page,limit}`.
  (For `req.user`, pass a stub `req.user = { _id, email }`.)
  Run fail-then-pass; then `npx jest` green except pre-existing `localChat`.

- [ ] **Step 8 — Commit:** `git add` the model, controller, routes, test → `git commit -m "feat(admin): audit log + lockout guardrails"`.

---

### Task 2: User search + pagination (backend)

**Files:** Modify `server/dist/controllers/adminController.js` (`listUsers`); Test `tests/server/routes/adminUserSearch.test.js`.

- [ ] **Step 1 — Failing test** (`adminUserSearch.test.js`): seed several users; assert `listUsers` with `?search=` filters (case-insensitive on email/callSign/displayName) and `?page=/?limit=` paginates; response is `{ message: { users, total, page, limit } }`.

- [ ] **Step 2 — Implement** — replace `listUsers` body:
```js
const listUsers = async (req, res) => {
    handleRequest(res, async () => {
        const UserProfile = getUserProfile();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const search = String(req.query.search || '').trim();
        let filter = {};
        if (search) {
            const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter = { $or: [{ email: rx }, { callSign: rx }, { displayName: rx }] };
        }
        const sel = 'email callSign displayName location lastIp locked superUser newAccount policyConsent flaggedForDeletion createdAt lastLogin';
        const [users, total] = await Promise.all([
            UserProfile.find(filter).select(sel).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            UserProfile.countDocuments(filter)
        ]);
        return { message: { users, total, page, limit } };
    }, 'admin: listUsers');
};
```
(Note: the search regex is NOT anchored — substring match — but IS escaped, so no injection/ReDoS.)

- [ ] **Step 3 — Run tests; full suite green; commit** `feat(admin): user search + pagination`.

(NOTE: this changes the `/api/admin/users` response from an array to `{ users, total, page, limit }` — the client Users tab MUST be updated in Task 3. The Email tab's callsign resolution uses `UserProfile` directly, not this endpoint, so it's unaffected.)

---

### Task 3: Admin UI — Audit tab, user search/pagination, grant-admin confirm (frontend)

**Files:** Modify `server/dist/views/admin.ejs`; Modify `client/src/public/js/byView/admin/main.ts` (→ recompile to dist). No inline handlers (CSP); reuse `esc`/`API`/`statusMsg`.

- [ ] **Step 1 — `admin.ejs`:** (a) In the Users panel header area, add a search input `#user-search-input` + a pagination bar `#users-pagination` (prev/next buttons `data-users-page="prev|next"` + a `#users-page-info` span). (b) Add an **Audit** tab button (`#audit-tab`, `data-bs-target="#audit-panel"`) after the Email tab, and an `#audit-panel` tab-pane with `#audit-results` + `#audit-pagination` (prev/next `data-audit-page` + `#audit-page-info`).

- [ ] **Step 2 — `main.ts` `loadUsers`:** read `data.message.users` (was `data.message`); track `let usersPage = 1; let usersSearch = '';`. Build the query `?search=${encodeURIComponent(usersSearch)}&page=${usersPage}` ; render the table as today from `data.message.users`; update `#users-page-info` (`page X · N total`) and enable/disable prev/next from `total`/`limit`. Keep `usersCache = data.message.users` (the delete/edit delegation reads it).

- [ ] **Step 3 — `main.ts` wiring (in DOMContentLoaded):** debounced `#user-search-input` input → set `usersSearch`, reset `usersPage=1`, `loadUsers()`; delegated/direct clicks on `[data-users-page]` → adjust `usersPage`, `loadUsers()`. Add `loadAudit()` (fetch `${API}/audit?page=${auditPage}`, render a table: Time · Actor · Action · Target from `entries`; update `#audit-page-info`; prev/next via `[data-audit-page]`); load it on `shown.bs.tab` of `#audit-tab`. All via `addEventListener`.

- [ ] **Step 4 — Grant-admin confirm:** in `editUser`, store the loaded `superUser` (e.g. `let editUserWasSuper = !!user.superUser;`). In the `edit-save-btn` handler, if `#edit-superuser.checked !== editUserWasSuper`, `if (!confirm(`${checked ? 'Grant' : 'Revoke'} admin for this user?`)) return;` before the PATCH. (`confirm` is allowed; it's not an inline handler.)

- [ ] **Step 5 — Recompile** (`npx tsc -p client/tsconfig.json`, exit 0); verify dist has `loadAudit`/`data-users-page`/`data-audit-page` and `onclick=` count 0; EJS compiles.

- [ ] **Step 6 — Behavioral check** (harness like prior tasks; stub `fetch` so `/users` returns `{message:{users:[…],total:60,page:1,limit:50}}` and `/audit` returns `{message:{entries:[{createdAt:Date.now(),actorLabel:'a@x',action:'grant-admin',targetLabel:'b@x'}],total:1,page:1,limit:50}}`; assert the users table renders, page-info shows total, the Audit tab table renders). Report what you verified.

- [ ] **Step 7 — Commit** `feat(admin): Audit tab + user search/pagination + grant-admin confirm`.

---

## Self-Review
**Coverage:** audit model+helper+wiring+endpoint (T1), guardrails self-lockout/last-admin (T1), user search+pagination (T2), Audit tab + search/pagination UI + grant-admin confirm (T3). **Consistency:** `/api/admin/users` shape change (array→`{users,total,page,limit}`) made in T2 and consumed in T3; `/api/admin/audit` returns `{entries,total,page,limit}` (T1) consumed in T3; `recordAudit` actions named consistently. **Deploy:** no new dependency; server + EJS + client JS change → pull + restart + Cloudflare purge of `/js/byView/admin/main.js`.
