/**
 * Tests for listAudit actor/action filtering and CSV export.
 * Uses mongodb-memory-server wired via a fresh connection per suite.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
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

// Register AdminAudit model against the default mongoose connection
const AdminAudit = mongoose.models.AdminAudit || mongoose.model('AdminAudit', adminAuditSchema);

const { listAudit } = require('../../../server/dist/controllers/adminController');

let mongoServer;

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { _id: new mongoose.Types.ObjectId(), email: 'tester@x.com' }; next(); });
app.get('/audit', listAudit);

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await AdminAudit.deleteMany({});
});

// Seed helper
async function seedAudit(docs) {
    return AdminAudit.insertMany(docs);
}

// ── Test 1: ?action=grant-admin filters correctly ────────────────────────────

test('?action=grant-admin returns only grant-admin entries; total reflects filter', async () => {
    await seedAudit([
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '1', targetLabel: 'alice@x.com' },
        { action: 'revoke-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '2', targetLabel: 'bob@x.com' },
        { action: 'grant-admin', actorLabel: 'superadmin@example.com', targetType: 'user', targetId: '3', targetLabel: 'carol@x.com' },
        { action: 'delete-user', actorLabel: 'admin@example.com', targetType: 'user', targetId: '4', targetLabel: 'dave@x.com' },
    ]);

    const res = await request(app).get('/audit').query({ action: 'grant-admin' });

    expect(res.status).toBe(200);
    const msg = res.body.message;
    expect(msg.total).toBe(2);
    expect(msg.entries).toHaveLength(2);
    expect(msg.entries.every(e => e.action === 'grant-admin')).toBe(true);
});

// ── Test 2: ?actor=admin@ case-insensitive substring match ───────────────────

test('?actor=admin@ returns only entries whose actorLabel contains it (case-insensitive)', async () => {
    await seedAudit([
        { action: 'grant-admin', actorLabel: 'Admin@Example.com', targetType: 'user', targetId: '1', targetLabel: 'alice@x.com' },
        { action: 'lock-user',   actorLabel: 'superadmin@example.com', targetType: 'user', targetId: '2', targetLabel: 'bob@x.com' },
        { action: 'delete-user', actorLabel: 'operator@other.com', targetType: 'user', targetId: '3', targetLabel: 'carol@x.com' },
    ]);

    const res = await request(app).get('/audit').query({ actor: 'admin@' });

    expect(res.status).toBe(200);
    const msg = res.body.message;
    // 'Admin@Example.com' and 'superadmin@example.com' both contain 'admin@' (case-insensitive)
    expect(msg.total).toBe(2);
    expect(msg.entries).toHaveLength(2);
    expect(msg.entries.every(e => e.actorLabel.toLowerCase().includes('admin@'))).toBe(true);
});

// ── Test 3: ?format=csv returns CSV with header row and seeded entry ──────────

test('?format=csv responds with text/csv, header row, and seeded entry data', async () => {
    await seedAudit([
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: 'abc123', targetLabel: 'alice@x.com', details: 'promoted' },
    ]);

    const res = await request(app).get('/audit').query({ format: 'csv' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/admin-audit\.csv/);

    // Header row must be present
    expect(res.text).toMatch(/createdAt,actorLabel,action,targetType,targetId,targetLabel,details/);

    // Seeded data must appear
    expect(res.text).toMatch(/admin@example\.com/);
    expect(res.text).toMatch(/grant-admin/);
    expect(res.text).toMatch(/alice@x\.com/);
    expect(res.text).toMatch(/promoted/);
});

// ── Test 4: from/to build an inclusive createdAt range ───────────────────────

test('from/to build an inclusive createdAt range', async () => {
    await seedAudit([
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '1', targetLabel: 'alice@x.com', createdAt: new Date('2026-06-30T12:00:00.000Z') },
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '2', targetLabel: 'bob@x.com', createdAt: new Date('2026-07-01T00:00:00.000Z') },
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '3', targetLabel: 'carol@x.com', createdAt: new Date('2026-07-02T23:59:59.999Z') },
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '4', targetLabel: 'dave@x.com', createdAt: new Date('2026-07-03T00:00:00.001Z') },
    ]);

    const res = await request(app).get('/audit').query({ from: '2026-07-01', to: '2026-07-02' });

    expect(res.status).toBe(200);
    const msg = res.body.message;
    expect(msg.total).toBe(2);
    expect(msg.entries.map(e => e.targetId).sort()).toEqual(['2', '3']);
});

// ── Test 5: invalid dates are ignored ─────────────────────────────────────────

test('invalid dates are ignored', async () => {
    await seedAudit([
        { action: 'grant-admin', actorLabel: 'admin@example.com', targetType: 'user', targetId: '1', targetLabel: 'alice@x.com' },
    ]);

    const res = await request(app).get('/audit').query({ from: 'notadate' });

    expect(res.status).toBe(200);
    expect(res.body.message.total).toBe(1);
});

// ── Test 6: response carries the distinct actions list ────────────────────────

test('response carries the distinct actions list', async () => {
    await seedAudit([
        { action: 'b-action', actorLabel: 'admin@example.com', targetType: 'user', targetId: '1', targetLabel: 'alice@x.com' },
        { action: 'a-action', actorLabel: 'admin@example.com', targetType: 'user', targetId: '2', targetLabel: 'bob@x.com' },
    ]);

    const res = await request(app).get('/audit');

    expect(res.status).toBe(200);
    expect(res.body.message.actions).toEqual(['a-action', 'b-action']);
});
