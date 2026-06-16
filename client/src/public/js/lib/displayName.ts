/* hamlive-oss — MIT License. See LICENSE. */

/**
 * Build the sender label shown above a chat message. Combines the operator's
 * name and callsign as "Name(CALL)" when both are present and distinct, so the
 * chat reads e.g. "Wayne(N0AD)". Falls back to whichever is available.
 *
 * The returned string is later passed through formatUsername(), which styles
 * the "(CALL)" portion — so the parenthesised shape here is intentional.
 */
export function buildSenderLabel(
    displayName: string | undefined,
    callSign: string | undefined
): string {
    const name = (displayName || '').trim();
    const call = (callSign || '').trim();
    if (name && call && name.toUpperCase() !== call.toUpperCase()) {
        return `${name}(${call})`;
    }
    return call || name || 'Unknown';
}
