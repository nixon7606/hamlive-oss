export function buildSenderLabel(displayName, callSign) {
    const name = (displayName || '').trim();
    const call = (callSign || '').trim();
    if (name && call && name.toUpperCase() !== call.toUpperCase()) {
        return `${name}(${call})`;
    }
    return call || name || 'Unknown';
}
//# sourceMappingURL=displayName.js.map