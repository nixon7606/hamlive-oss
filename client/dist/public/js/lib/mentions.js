export function parseMentions(text, knownCallSigns) {
    const segments = [];
    const mentioned = new Set();
    const re = /@([A-Za-z0-9/]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const cs = m[1].toUpperCase();
        if (!knownCallSigns.has(cs))
            continue;
        if (m.index > last)
            segments.push({ type: 'text', value: text.slice(last, m.index) });
        segments.push({ type: 'mention', value: m[0] });
        mentioned.add(cs);
        last = m.index + m[0].length;
    }
    if (last < text.length)
        segments.push({ type: 'text', value: text.slice(last) });
    return { segments, mentioned };
}
//# sourceMappingURL=mentions.js.map