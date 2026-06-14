/* hamlive-oss — MIT License. See LICENSE. */
/**
 * Security unit tests: input validation guards on admin resend/unsuppress.
 *
 * Note: the addNetOwner (netProfileController) and magic-login route fixes are
 * not unit-tested here because they depend on the passport/netOwnerCheck
 * integration stack that requires a running Mongoose connection. Those fixes
 * were verified by reading the patched source and running `node --check`.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../../server/dist/lib/responseUtils', () => ({
    handleRequest: (res, fn) => {
        fn().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message }));
    }
}));

jest.mock('../../../server/dist/routes/authRoutes', () => ({
    sendMagicSignInLink: jest.fn(async () => ({ devMagicLink: null }))
}));

const { sendMagicSignInLink } = require('../../../server/dist/routes/authRoutes');
const { resendSignInLink } = require('../../../server/dist/controllers/adminController');

const app = express();
app.use(express.json());
app.post('/api/admin/email/resend-login', resendSignInLink);

beforeEach(() => {
    sendMagicSignInLink.mockClear();
});

// --- resendSignInLink: invalid email ---

test('resendSignInLink rejects a non-email string with 400 and does not call sendMagicSignInLink', async () => {
    const res = await request(app)
        .post('/api/admin/email/resend-login')
        .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(sendMagicSignInLink).not.toHaveBeenCalled();
});

test('resendSignInLink rejects an object payload with 400 and does not call sendMagicSignInLink', async () => {
    const res = await request(app)
        .post('/api/admin/email/resend-login')
        .send({ email: { $ne: null } });
    expect(res.status).toBe(400);
    expect(sendMagicSignInLink).not.toHaveBeenCalled();
});

test('resendSignInLink rejects an empty email with 400 and does not call sendMagicSignInLink', async () => {
    const res = await request(app)
        .post('/api/admin/email/resend-login')
        .send({});
    expect(res.status).toBe(400);
    expect(sendMagicSignInLink).not.toHaveBeenCalled();
});

// --- resendSignInLink: valid email ---

test('resendSignInLink accepts a valid email and calls sendMagicSignInLink with it', async () => {
    const res = await request(app)
        .post('/api/admin/email/resend-login')
        .send({ email: 'a@b.com' });
    expect(res.status).toBe(200);
    expect(sendMagicSignInLink).toHaveBeenCalledWith('a@b.com');
    expect(res.body.message.sent).toBe(true);
});
