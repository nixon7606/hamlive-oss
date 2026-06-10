/* hamlive-oss — MIT License. See LICENSE. */

const emailRateLimiter = require('../../../server/dist/lib/emailRateLimiter');

beforeEach(() => {
    emailRateLimiter.resetAll();
});

describe('emailRateLimiter', () => {
    describe('checkAndRecordSend()', () => {
        it('allows the first send to a recipient', () => {
            const result = emailRateLimiter.checkAndRecordSend('first@test.com');
            expect(result.allowed).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('blocks a second send within the cooldown window', () => {
            emailRateLimiter.checkAndRecordSend('block@test.com');
            const result = emailRateLimiter.checkAndRecordSend('block@test.com');
            expect(result.allowed).toBe(false);
            expect(result.reason).toMatch(/Cooldown active/);
        });

        it('allows sends to different recipients', () => {
            const r1 = emailRateLimiter.checkAndRecordSend('alice@test.com');
            const r2 = emailRateLimiter.checkAndRecordSend('bob@test.com');
            expect(r1.allowed).toBe(true);
            expect(r2.allowed).toBe(true);
        });
    });

    describe('checkBulk()', () => {
        it('allows multiple unique recipients', () => {
            const { allowed, blocked } = emailRateLimiter.checkBulk([
                'a@test.com',
                'b@test.com',
                'c@test.com'
            ]);
            expect(allowed).toHaveLength(3);
            expect(blocked).toHaveLength(0);
        });

        it('blocks duplicate sends across bulk calls', () => {
            emailRateLimiter.checkBulk(['dup@test.com']);
            const { allowed, blocked } = emailRateLimiter.checkBulk([
                'dup@test.com',
                'other@test.com'
            ]);
            expect(allowed).toEqual(['other@test.com']);
            expect(blocked).toHaveLength(1);
            expect(blocked[0].recipient).toBe('dup@test.com');
        });
    });

    describe('getCooldownRemaining()', () => {
        it('returns 0 for a recipient never sent to', () => {
            expect(emailRateLimiter.getCooldownRemaining('unknown@test.com')).toBe(0);
        });

        it('returns > 0 for a recipient in cooldown', () => {
            emailRateLimiter.checkAndRecordSend('cooldown@test.com');
            const remaining = emailRateLimiter.getCooldownRemaining('cooldown@test.com');
            expect(remaining).toBeGreaterThan(0);
        });

        it('returns 0 after cooldown is cleared', () => {
            emailRateLimiter.checkAndRecordSend('clear@test.com');
            emailRateLimiter.clearCooldown('clear@test.com');
            expect(emailRateLimiter.getCooldownRemaining('clear@test.com')).toBe(0);
        });
    });

    describe('config defaults', () => {
        it('returns 5-minute window by default', () => {
            expect(emailRateLimiter.getWindowMs()).toBe(5 * 60 * 1000);
        });

        it('returns max 1 per window by default', () => {
            expect(emailRateLimiter.getMaxPerWindow()).toBe(1);
        });
    });
});
