/* hamlive-oss — MIT License. See LICENSE. */

// How long a non-checked-in viewer ("lurker") may sit idle before we treat them
// as actually gone and drop them from the roster. This is deliberately decoupled
// from the short "away" presence cutoff (awayInMs, ~25s) that only greys the
// presence dot. Keying roster *membership* off the 25s cutoff made present-but-idle
// viewers (and even yourself, on SSE pushes) flicker out of the list whenever a
// heartbeat landed late. The membership decision uses this longer "really gone"
// window so idle lobby-sitters stay visible until they have genuinely left.
const ROSTER_GONE_AFTER_MS = 180000; // 3 minutes

/**
 * Decide whether a station stays in the live-net roster.
 *
 * @param {boolean|null} checkedState - true (checked in), false (checked out), or null (viewing only).
 * @param {number} lastSeenDeltaMs - ms since the station's lastSeen.
 * @param {number} [goneAfterMs] - idle window after which a non-checked-in viewer is dropped.
 * @returns {boolean} true to keep the station in the roster.
 */
const shouldKeepInRoster = (checkedState, lastSeenDeltaMs, goneAfterMs = ROSTER_GONE_AFTER_MS) => {
    // Checked-in (true) and checked-out (false) stations always remain on the roster.
    if (checkedState !== null) {
        return true;
    }

    // A viewer who has never been seen (no/invalid lastSeen) has just arrived — keep them.
    if (typeof lastSeenDeltaMs !== 'number' || Number.isNaN(lastSeenDeltaMs)) {
        return true;
    }

    // Non-checked-in viewers stay until idle past the "really gone" window.
    return lastSeenDeltaMs <= goneAfterMs;
};

module.exports = { shouldKeepInRoster, ROSTER_GONE_AFTER_MS };
