/* hamlive-oss — MIT License. See LICENSE. */

const { shouldKeepInRoster, ROSTER_GONE_AFTER_MS } = require('../../../server/dist/lib/rosterMembership');

describe('shouldKeepInRoster — roster membership is decoupled from the 25s presence dot', () => {
    const SECONDS = 1000;

    test('keeps a non-checked-in viewer who has only briefly gone idle (the lobby bug)', () => {
        // checkedState === null (just viewing, not checked in), idle 40s — past the 25s
        // "away" presence cutoff but nowhere near actually gone. Must stay in the roster.
        expect(shouldKeepInRoster(null, 40 * SECONDS)).toBe(true);
    });

    test('drops a non-checked-in viewer only after they are really gone', () => {
        // Idle well beyond the gone window — they have closed the tab / left.
        expect(shouldKeepInRoster(null, ROSTER_GONE_AFTER_MS + 1)).toBe(false);
    });

    test('keeps a checked-in station no matter how long idle', () => {
        expect(shouldKeepInRoster(true, 10 * 60 * SECONDS)).toBe(true);
    });

    test('keeps a checked-out station no matter how long idle', () => {
        expect(shouldKeepInRoster(false, 10 * 60 * SECONDS)).toBe(true);
    });

    test('keeps a freshly-arrived non-checked-in viewer', () => {
        expect(shouldKeepInRoster(null, 0)).toBe(true);
    });

    test('drops a station net control just cleared with `ui`, even if recently seen', () => {
        // clearedByNc === true: an undo-check-in must vanish immediately rather than
        // ride the lurker grace window — so a typo'd check-in disappears at once.
        expect(shouldKeepInRoster(null, 0, true)).toBe(false);
        expect(shouldKeepInRoster(null, 40 * SECONDS, true)).toBe(false);
    });

    test('a checked-in/out station ignores the cleared-by-NC mark', () => {
        // The check-state branch wins first; the mark only matters for null state.
        expect(shouldKeepInRoster(true, 0, true)).toBe(true);
        expect(shouldKeepInRoster(false, 0, true)).toBe(true);
    });

    test('an un-marked lurker still gets the grace window (flicker fix preserved)', () => {
        expect(shouldKeepInRoster(null, 40 * SECONDS, false)).toBe(true);
        expect(shouldKeepInRoster(null, ROSTER_GONE_AFTER_MS + 1, false)).toBe(false);
    });

    test('gone window is generous enough to absorb heartbeat jitter (>> 25s away cutoff)', () => {
        expect(ROSTER_GONE_AFTER_MS).toBeGreaterThanOrEqual(120 * SECONDS);
    });
});
