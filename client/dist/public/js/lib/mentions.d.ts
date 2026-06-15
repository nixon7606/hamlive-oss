export interface MentionSegment {
    type: 'text' | 'mention';
    value: string;
}
export interface ParsedMentions {
    segments: MentionSegment[];
    mentioned: Set<string>;
}
export declare function parseMentions(text: string, knownCallSigns: Set<string>): ParsedMentions;
//# sourceMappingURL=mentions.d.ts.map