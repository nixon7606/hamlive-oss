import { parseMentions } from '../../../client/src/public/js/lib/mentions';

const known = new Set(['KD5SPR', 'N0AD']);

test('no mentions: single text segment, empty mentioned', () => {
  const r = parseMentions('hello there', known);
  expect(r.segments).toEqual([{ type: 'text', value: 'hello there' }]);
  expect(r.mentioned.size).toBe(0);
});

test('one known mention splits into text + mention segments', () => {
  const r = parseMentions('hi @KD5SPR ok', known);
  expect(r.segments).toEqual([
    { type: 'text', value: 'hi ' },
    { type: 'mention', value: '@KD5SPR' },
    { type: 'text', value: ' ok' }
  ]);
  expect([...r.mentioned]).toEqual(['KD5SPR']);
});

test('unknown token stays plain text', () => {
  const r = parseMentions('hi @NOBODY', known);
  expect(r.segments).toEqual([{ type: 'text', value: 'hi @NOBODY' }]);
  expect(r.mentioned.size).toBe(0);
});

test('matching is case-insensitive but preserves typed casing', () => {
  const r = parseMentions('yo @kd5spr', known);
  expect(r.segments[1]).toEqual({ type: 'mention', value: '@kd5spr' });
  expect([...r.mentioned]).toEqual(['KD5SPR']);
});

test('multiple mentions and trailing punctuation', () => {
  const r = parseMentions('@N0AD and @KD5SPR!', known);
  expect([...r.mentioned].sort()).toEqual(['KD5SPR', 'N0AD']);
  expect(r.segments[r.segments.length - 1]).toEqual({ type: 'text', value: '!' });
});

test('a lone @ with no callsign is plain text', () => {
  const r = parseMentions('email me @ home', known);
  expect(r.mentioned.size).toBe(0);
  expect(r.segments).toEqual([{ type: 'text', value: 'email me @ home' }]);
});
