/**
 * Tests for GET /api/admin/users — search + pagination.
 * Uses mongodb-memory-server; mocks handleRequest like the other admin tests.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

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

// Register UserProfile model against the default mongoose connection
const { getUserProfile } = require('../../../server/dist/models/userProfile');
getUserProfile();

const { listUsers } = require('../../../server/dist/controllers/adminController');

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
    await mongoose.connection.db.collection('userprofiles').deleteMany({});
});

// Helper: insert a raw doc bypassing validators
async function insertUser(data) {
    const result = await mongoose.connection.db.collection('userprofiles').insertOne(data);
    return { ...data, _id: result.insertedId };
}

function buildApp() {
    const app = express();
    app.use(express.json());
    app.get('/users', listUsers);
    return app;
}

// Seed users with varying createdAt so sort order is deterministic
async function seedUsers() {
    const now = Date.now();
    const users = [
        { email: 'alice@example.com', callSign: 'KC0AAA', displayName: 'Alice Foo', lastAuthVia: 'email', createdAt: new Date(now - 5000) },
        { email: 'bob@example.com',   callSign: 'KC0BBB', displayName: 'Bob Bar',   lastAuthVia: 'email', createdAt: new Date(now - 4000) },
        { email: 'carol@example.com', callSign: 'W1CCC',  displayName: 'Carol Baz', lastAuthVia: 'email', createdAt: new Date(now - 3000) },
        { email: 'dave@example.com',  callSign: 'W1DDD',  displayName: 'Dave Qux',  lastAuthVia: 'email', createdAt: new Date(now - 2000) },
        { email: 'eve@example.com',   callSign: 'KC0EEE', displayName: 'Eve Zap',   lastAuthVia: 'email', createdAt: new Date(now - 1000) },
    ];
    for (const u of users) await insertUser(u);
    return users;
}

// ── Test 1: No params → returns all users with pagination metadata ─────────────

test('no params → returns {users, total, page:1, limit:50} with all seeded users newest-first', async () => {
    await seedUsers();
    const app = buildApp();
    const res = await request(app).get('/users');

    expect(res.status).toBe(200);
    const msg = res.body.message;
    expect(msg).toHaveProperty('users');
    expect(msg).toHaveProperty('total', 5);
    expect(msg).toHaveProperty('page', 1);
    expect(msg).toHaveProperty('limit', 50);
    expect(Array.isArray(msg.users)).toBe(true);
    expect(msg.users).toHaveLength(5);
    // Newest first (Eve has highest createdAt)
    expect(msg.users[0].email).toBe('eve@example.com');
});

// ── Test 2: ?search=KC0 → only matching users, total reflects filtered count ───

test('?search=KC0 → returns only users whose callSign/email/displayName matches (case-insensitive)', async () => {
    await seedUsers();
    const app = buildApp();
    const res = await request(app).get('/users').query({ search: 'KC0' });

    expect(res.status).toBe(200);
    const msg = res.body.message;
    expect(msg).toHaveProperty('total', 3);  // KC0AAA, KC0BBB, KC0EEE
    expect(msg).toHaveProperty('page', 1);
    expect(msg).toHaveProperty('limit', 50);
    expect(msg.users).toHaveLength(3);
    const callSigns = msg.users.map(u => u.callSign).sort();
    expect(callSigns).toEqual(['KC0AAA', 'KC0BBB', 'KC0EEE'].sort());
});

// ── Test 3: ?page=2&limit=2 → second page, correct skip/total ─────────────────

test('?page=2&limit=2 → returns second page with skip=2, total=5', async () => {
    await seedUsers();
    const app = buildApp();
    const res = await request(app).get('/users').query({ page: 2, limit: 2 });

    expect(res.status).toBe(200);
    const msg = res.body.message;
    expect(msg).toHaveProperty('page', 2);
    expect(msg).toHaveProperty('limit', 2);
    expect(msg).toHaveProperty('total', 5);
    expect(msg.users).toHaveLength(2);
    // Sorted newest-first: [Eve, Dave, Carol, Bob, Alice]
    // Page 2 (skip=2, limit=2) → [Carol, Bob]
    const emails = msg.users.map(u => u.email);
    expect(emails).toContain('carol@example.com');
    expect(emails).toContain('bob@example.com');
});
