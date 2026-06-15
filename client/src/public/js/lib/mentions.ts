/* hamlive-oss — MIT License. See LICENSE. */

export interface MentionSegment {
    type: 'text' | 'mention';
    value: string;
}

export interface ParsedMentions {
    segments: MentionSegment[];
    mentioned: Set<string>;
}

/**
 * Tokenize chat message text into text/mention segments. A token of the form
 * @<callsign-chars> becomes a 'mention' segment ONLY when its uppercased value
 * is in knownCallSigns; otherwise it stays plain text. `mentioned` is the set of
 * uppercased callsigns actually mentioned. Pure: does NO HTML escaping — the
 * caller escapes text segments before inserting into the DOM.
 */
export function parseMentions(text: string, knownCallSigns: Set<string>): ParsedMentions {
    const segments: MentionSegment[] = [];
    const mentioned = new Set<string>();
    const re = /@([A-Za-z0-9/]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const cs = m[1]!.toUpperCase();
        if (!knownCallSigns.has(cs)) continue;
        if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) });
        segments.push({ type: 'mention', value: m[0] });
        mentioned.add(cs);
        last = m.index + m[0].length;
    }
    if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
    return { segments, mentioned };
}
