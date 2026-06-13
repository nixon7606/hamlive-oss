/* hamlive-oss — MIT License. See LICENSE. */
/**
 * QoL-A security hardening unit tests.
 *
 * Coverage:
 *  1. sanitizeNotes(undefined) / sanitizeNotes(null) return '' (guard fix)
 *  2. sanitizeNotes('<b>hi</b><script>x</script>') strips <script>, keeps <b>
 *
 * handleRequest internal-vs-intentional logic: that path is tested by reading
 * the source — the isInternal heuristic switches the client message in
 * production but does not alter the 500 status or the server-side log. Unit
 * testing it in isolation would require mocking process.env.NODE_ENV and the
 * mongoose error constructors; skipping here per the task spec.
 */

const { sanitizeNotes } = require('../../../server/dist/lib/serverUtils');

describe('sanitizeNotes — undefined/null guard', () => {
    test('sanitizeNotes(undefined) returns empty string', () => {
        expect(sanitizeNotes(undefined)).toBe('');
    });

    test('sanitizeNotes(null) returns empty string', () => {
        expect(sanitizeNotes(null)).toBe('');
    });

    test('sanitizeNotes() with no argument returns empty string', () => {
        expect(sanitizeNotes()).toBe('');
    });
});

describe('sanitizeNotes — valid string still sanitizes', () => {
    test('strips <script> tag while keeping allowed tags like <b>', () => {
        const input = '<b>hi</b><script>x</script>';
        const result = sanitizeNotes(input);
        // <b> is in the allowedTags list, so its content should survive
        expect(result).toContain('hi');
        // <script> must be stripped
        expect(result).not.toContain('<script>');
        expect(result).not.toContain('</script>');
        // Verify the full expected output shape (sanitize-html keeps <b>)
        expect(result).toMatch(/<b>hi<\/b>/);
    });

    test('sanitizeNotes with plain text returns the text unchanged', () => {
        const result = sanitizeNotes('hello world');
        expect(result).toBe('hello world');
    });

    test('sanitizeNotes converts newlines to empty (strips \\n)', () => {
        const result = sanitizeNotes('line1\nline2');
        expect(result).toBe('line1line2');
    });
});
