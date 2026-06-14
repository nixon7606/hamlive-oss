/**
 * Tests for admin audit log + lockout guardrails.
 * Uses mongodb-memory-server (wired in via tests/server/setup.js).
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { userProfileSchema } = require('../../../server/dist/models/userProfile');
const { adminAuditSchema } = require('../../../server/dist/models/adminAudit');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
    handleRequest: (res, fn) => { fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message })); }
}));
jest.mock('../../../server/dist/routes/authRoutes', () => ({
    sendMagicSignInLink: jest.fn(async () => ({}))
}));
jest.mock('../../../server/dist/lib/sendgridSuppression', () => ({
    getSuppressions: jest.fn(async () => []),
    removeSuppression: jest.fn(async () => {}),
    LISTS: []
}));

// Register models against the default mongoose connection
// (setup.js sets MONGO_URI env; we connect in beforeAll)
const UserProfile = mongoose.models.UserProfile || mongoose.model('UserProfile', userProfileSchema);
const AdminAudit = mongoose.models.AdminAudit || mongoose.model('AdminAudit', adminAuditSchema);

const { updateUser, deleteUser, listAudit } = require('../../../server/dist/controllers/adminController');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    // Clear collections between tests
    await mongoose.connection.db.collection('userprofiles').deleteMany({});
    await AdminAudit.deleteMany({});
});

// Helper: insert a user document directly (bypassing model validators)
async function insertUser(data) {
    const result = await mongoose.connection.db.collection('userprofiles').insertOne(data);
    return { ...data, _id: result.insertedId };
}

// Build an app with a stub req.user injected via middleware
function buildApp(reqUser, handler, method = 'patch', path = '/users/:id') {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = reqUser; next(); });
    if (method === 'patch') app.patch(path, handler);
    else if (method === 'delete') app.delete(path, handler);
    else if (method === 'get') app.get(path, handler);
    return app;
}

// ── Case 1: updateUser rejects revoking own admin ────────────────────────────

test('updateUser: self-demote (revoke own admin) is rejected', async () => {
    const adminId = new mongoose.Types.ObjectId();
    await insertUser({ _id: adminId, email: 'admin@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Admin' });

    const app = buildApp({ _id: adminId, email: 'admin@x.com' }, updateUser);
    const res = await request(app).patch(`/users/${adminId}`).send({ superUser: false });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/remove your own admin/);

    // User should remain superUser
    const u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: adminId });
    expect(u.superUser).toBe(true);
});

// ── Case 2: updateUser rejects revoking the only admin ───────────────────────

test('updateUser: revoking the last remaining admin is rejected', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await insertUser({ _id: actorId, email: 'actor@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Actor' });
    await insertUser({ _id: targetId, email: 'target@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Target' });

    // Remove the actor from superUser count so only target is left
    await mongoose.connection.db.collection('userprofiles').updateOne({ _id: actorId }, { $set: { superUser: false } });

    const app = buildApp({ _id: actorId, email: 'actor@x.com' }, updateUser);
    const res = await request(app).patch(`/users/${targetId}`).send({ superUser: false });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/last remaining admin/);

    const u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u.superUser).toBe(true);
});

// ── Case 3: updateUser granting admin succeeds + writes audit row ─────────────

test('updateUser: grant-admin succeeds and writes an adminaudits entry', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await insertUser({ _id: actorId, email: 'actor@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Actor' });
    await insertUser({ _id: targetId, email: 'normal@x.com', superUser: false, lastAuthVia: 'email', displayName: 'Normal' });

    const app = buildApp({ _id: actorId, email: 'actor@x.com' }, updateUser);
    const res = await request(app).patch(`/users/${targetId}`).send({ superUser: true });

    expect(res.status).toBe(200);
    expect(res.body.message.superUser).toBe(true);

    // Allow the fire-and-forget audit write to settle
    await new Promise(r => setTimeout(r, 100));

    const auditRow = await AdminAudit.findOne({ action: 'grant-admin' }).lean();
    expect(auditRow).not.toBeNull();
    expect(auditRow.targetId).toBe(String(targetId));
    expect(auditRow.actorLabel).toBe('actor@x.com');
});

// ── Case 4: deleteUser rejects deleting the last admin ───────────────────────

test('deleteUser: deleting the last remaining admin is rejected', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await insertUser({ _id: actorId, email: 'actor@x.com', superUser: false, lastAuthVia: 'email', displayName: 'Actor' });
    await insertUser({ _id: targetId, email: 'lastadmin@x.com', superUser: true, lastAuthVia: 'email', displayName: 'LastAdmin' });

    const app = buildApp({ _id: actorId, email: 'actor@x.com' }, deleteUser, 'delete');
    const res = await request(app).delete(`/users/${targetId}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/last remaining admin/);

    // User should still exist
    const u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u).not.toBeNull();
});

// ── Case 6: updateUser ban sets lockedUntil; unban clears it ─────────────────

test('updateUser: ban sets locked + lockedUntil; unban clears lockedUntil', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await insertUser({ _id: actorId, email: 'actor@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Actor' });
    await insertUser({ _id: targetId, email: 'goog@x.com', superUser: false, locked: false, lastAuthVia: 'google', displayName: 'Goog' });

    const app = buildApp({ _id: actorId, email: 'actor@x.com' }, updateUser);

    // Ban with a future expiry
    const when = '2030-01-01T00:00:00.000Z';
    const banRes = await request(app).patch(`/users/${targetId}`).send({ locked: true, lockedUntil: when });
    expect(banRes.status).toBe(200);
    let u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u.locked).toBe(true);
    expect(new Date(u.lockedUntil).toISOString()).toBe(when);

    // Unban clears the expiry
    const unbanRes = await request(app).patch(`/users/${targetId}`).send({ locked: false });
    expect(unbanRes.status).toBe(200);
    u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u.locked).toBe(false);
    expect(u.lockedUntil).toBeNull();
});

// ── Case 7: updateUser permanent re-ban clears stale lockedUntil ─────────────

test('updateUser: permanent re-ban (locked:true, no lockedUntil) clears a stale expiry', async () => {
    const actorId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await insertUser({ _id: actorId, email: 'actor2@x.com', superUser: true, lastAuthVia: 'email', displayName: 'Actor2' });
    // Target already has a timed ban on the books
    await insertUser({ _id: targetId, email: 'stale@x.com', superUser: false, locked: true, lockedUntil: new Date('2030-01-01T00:00:00.000Z'), lastAuthVia: 'google', displayName: 'Stale' });

    const app = buildApp({ _id: actorId, email: 'actor2@x.com' }, updateUser);
    const res = await request(app).patch(`/users/${targetId}`).send({ locked: true });
    expect(res.status).toBe(200);
    const u = await mongoose.connection.db.collection('userprofiles').findOne({ _id: targetId });
    expect(u.locked).toBe(true);
    expect(u.lockedUntil).toBeNull();
});

// ── Case 5: listAudit returns entries newest-first ────────────────────────────

test('listAudit returns entries newest-first with {entries,total,page,limit}', async () => {
    const now = Date.now();
    await AdminAudit.create({ action: 'grant-admin', actorLabel: 'a@x.com', createdAt: new Date(now - 2000) });
    await AdminAudit.create({ action: 'revoke-admin', actorLabel: 'a@x.com', createdAt: new Date(now - 1000) });
    await AdminAudit.create({ action: 'delete-user', actorLabel: 'a@x.com', createdAt: new Date(now) });

    const actorId = new mongoose.Types.ObjectId();
    const app = buildApp({ _id: actorId, email: 'a@x.com' }, listAudit, 'get', '/audit');
    const res = await request(app).get('/audit');

    expect(res.status).toBe(200);
    const msg = res.body.message;
    expect(msg).toHaveProperty('entries');
    expect(msg).toHaveProperty('total', 3);
    expect(msg).toHaveProperty('page', 1);
    expect(msg).toHaveProperty('limit', 50);
    expect(msg.entries).toHaveLength(3);
    // Newest first
    expect(msg.entries[0].action).toBe('delete-user');
    expect(msg.entries[1].action).toBe('revoke-admin');
    expect(msg.entries[2].action).toBe('grant-admin');
});
