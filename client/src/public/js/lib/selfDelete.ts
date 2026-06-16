/* hamlive-oss — MIT License. See LICENSE. */

/** Authors may delete their OWN chat messages for this long after sending. */
export const SELF_DELETE_WINDOW_MS = 15 * 60 * 1000;

/**
 * True when a message authored by the current user is still young enough for
 * the author to self-delete. NCS deletion is unlimited and does not use this.
 *
 * @param createdAt the message timestamp (ISO string or Date)
 * @param nowMs     current time in ms (injectable for testing; defaults to Date.now())
 */
export function withinSelfDeleteWindow(
    createdAt: string | Date | undefined,
    nowMs: number = Date.now()
): boolean {
    if (!createdAt) return false;
    const ts = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
    if (Number.isNaN(ts)) return false;
    return nowMs - ts < SELF_DELETE_WINDOW_MS;
}
