export const SELF_DELETE_WINDOW_MS = 15 * 60 * 1000;
export function withinSelfDeleteWindow(createdAt, nowMs = Date.now()) {
    if (!createdAt)
        return false;
    const ts = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
    if (Number.isNaN(ts))
        return false;
    return nowMs - ts < SELF_DELETE_WINDOW_MS;
}
//# sourceMappingURL=selfDelete.js.map