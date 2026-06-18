/* hamlive-oss — MIT License. See LICENSE. */

const request = require('supertest');
const express = require('express');
const { magicLoginLimiter, MAX_PER_WINDOW } = require('../../../server/dist/lib/magicLoginLimiter');

function buildApp() {
    const app = express();
    app.post('/magiclogin', magicLoginLimiter, (req, res) => res.json({ ok: true }));
    return app;
}

describe('magicLoginLimiter — keyed per real client IP, generous for shared networks', () => {
    test("one IP exhausting its quota must NOT block a different visitor (the ::1 shared-bucket bug)", async () => {
        const app = buildApp();
        // Hammer one visitor well past any reasonable limit.
        for (let i = 0; i < 30; i++) {
            await request(app).post('/magiclogin').set('CF-Connecting-IP', '203.0.113.10');
        }
        // A genuinely different visitor must still be able to request a sign-in link.
        const res = await request(app).post('/magiclogin').set('CF-Connecting-IP', '198.51.100.20');
        expect(res.status).toBe(200);
    });

    test('limit is generous enough not to punish shared/NAT networks (clubs, events, public Wi-Fi)', () => {
        expect(MAX_PER_WINDOW).toBeGreaterThanOrEqual(15);
    });

    test('still blocks a genuine single-IP flood, with the sign-in message', async () => {
        const app = buildApp();
        const ip = '203.0.113.77';
        let last;
        for (let i = 0; i < MAX_PER_WINDOW + 1; i++) {
            last = await request(app).post('/magiclogin').set('CF-Connecting-IP', ip);
        }
        expect(last.status).toBe(429);
        expect(last.body.error).toMatch(/too many sign-in/i);
    });
});
