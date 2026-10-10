// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Copy rewrites need original spans without changing the production citation grammar.
// ABOUTME: Ranges share one span and masked examples preserve offsets but never become references.
import { citationCandidates, citationSpans } from '../../../src/tools/cmos/decision-citations';

it('groups inherited range members under their original source span', () => {
  const text = 'Keep decisions #12–14, #18; learning #21 and #22.';
  expect(citationSpans(text)).toEqual([
    { start: 15, end: 21, prefix: 'd', ids: [12, 13, 14] },
    { start: 23, end: 26, prefix: 'd', ids: [18] },
    { start: 37, end: 40, prefix: 'l', ids: [21] },
    { start: 45, end: 48, prefix: 'l', ids: [22] },
  ]);
});
it('retains original offsets after masking code, URLs and untrusted source text', () => {
  const text = '`decision #2` https://x.test/#3 ⟪untrusted⟫ d:4 ⟪/untrusted⟫ decision #12';
  const spans = citationSpans(text);
  expect(spans).toHaveLength(1);
  expect(text.slice(spans[0].start, spans[0].end)).toBe('#12');
  expect(spans[0].prefix).toBe('d');
});
// Literal candidate outputs captured from d8f4c9d before the span refactor. This is independent
// of the projection implementation; the immutable private V5 bridge checks the full label corpus.
it.each([
  {
    text: 'decisions #12-14, #16; learning #20 / #21',
    expected: [
      ['d', 12],
      ['d', 13],
      ['d', 14],
      ['d', 16],
      ['l', 20],
      ['l', 21],
    ],
  },
  {
    text: 'foreign project stage1 (decision #12), #13; local #14',
    expected: [
      ['blocked', 12],
      [null, 13],
      [null, 14],
    ],
  },
  {
    text: '#12-13x; d:12-14; decision #15.5',
    expected: [
      ['blocked', 12],
      ['blocked', 12],
      ['blocked', 15],
    ],
  },
  {
    text: 'PR #12 and #13; constraint #14; n:15; #16',
    expected: [
      ['blocked', 12],
      ['blocked', 13],
      ['c', 14],
      ['n', 15],
      ['n', 16],
    ],
  },
  {
    text: 'stage1 #12; tracelab’s #13; use #14; (#15)',
    expected: [
      ['blocked', 12],
      ['blocked', 13],
      [null, 14],
      [null, 15],
    ],
  },
  { text: '```decision #12``` decision #13; [#14](https://x.test)', expected: [['d', 13]] },
  {
    text: 'decision #12\n#13; decision #9007199254740992; #20-40',
    expected: [
      ['d', 12],
      ['d', 13],
    ],
  },
])('preserves the independently captured candidate meaning: $text', ({ text, expected }) => {
  const candidates = expected.map(([prefix, id]) => ({ prefix, id }));
  expect(citationCandidates(text)).toEqual(candidates);
  expect(
    citationSpans(text).flatMap(({ prefix, ids }) => ids.map((id) => ({ prefix, id })))
  ).toEqual(candidates);
});
