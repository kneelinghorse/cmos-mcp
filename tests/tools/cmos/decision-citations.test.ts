// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Typed citation parsing preserves namespaces without interpreting bare or foreign numbers.
// ABOUTME: Bounded ranges and continuations encode the explicit-reference contract used by recall and rules.

import { typedCitations, decisionCitations } from '../../../src/tools/cmos/decision-citations';

describe('typed citations', () => {
  it('keeps explicit namespaces and deduplicates continuations in appearance order', () => {
    expect(
      typedCitations(
        'Per decisions #12, #13 and #12; learning #7; constraint #8; next-step #9. d:14 l:7 c:8 n:9'
      )
    ).toEqual(['d:12', 'd:13', 'l:7', 'c:8', 'n:9', 'd:14']);
    expect(decisionCitations('ruling #21–23; learning #21; #99')).toEqual([21, 22, 23]);
  });

  it('does not turn namespace lookalikes, bare numbers, malformed ranges or issue links into edges', () => {
    expect(
      typedCitations(
        'PR #12, #13; feedback #14; FD#15; decision #0; decision #5-1000; decision #9-2; decision #12.5; #100; https://example.test/decision#16; [decision #17](https://example.test/issues/17); d:9007199254740992'
      )
    ).toEqual([]);
  });

  it('rejects qualified foreign references without rejecting ordinary connective phrases', () => {
    expect(
      typedCitations(
        'Stage1 decision #12; sibling decision #13; foreign learning #14; other-project:d:15; this decision #16; follow decision #17; per recorded decision #18; prior learning #19'
      )
    ).toEqual(['d:16', 'd:17', 'd:18', 'l:19']);
  });

  it('does not inherit types across sentence, code, or unrelated-word boundaries', () => {
    expect(
      typedCitations(
        'decision #12. #13; learning #14 references #15; `decision #16`;\n```\nconstraint #17\n```\nconstraint #18'
      )
    ).toEqual(['d:12', 'l:14', 'c:18']);
  });
});

it('keeps an explicit parenthetical citation separate from the preceding prose qualifier', () => {
  expect(
    typedCitations('The exclusion logic (decision #12). Keep decisions active (#13, #14).')
  ).toEqual(['d:12', 'd:13', 'd:14']);
});

it('keeps a foreign qualifier attached through modifiers and typed-prefix spellings', () => {
  expect(
    typedCitations(
      'Stage1 earlier decision #12; sibling prior learning #13; foreign d:14; Stage1 l:15; this prior decision #16'
    )
  ).toEqual(['d:16']);
});

it('treats reference connectives as boundaries instead of absorbing the preceding subject', () => {
  expect(
    typedCitations('Long implementation notes per prior decision #12; records from learning #13.')
  ).toEqual(['d:12', 'l:13']);
});

it('does not let parentheses erase an explicit project or foreign qualifier', () => {
  expect(
    typedCitations('Stage1 (decision #12); foreign (learning #13); logic (constraint #14)')
  ).toEqual(['c:14']);
});

it('never derives local rule or decision citations from foreign provenance fences', () => {
  expect(
    typedCitations(
      '⟪untrusted, from proj:Stage1⟫ Follow decision #12. constraint #13. ⟪/untrusted⟫ Learning #14.'
    )
  ).toEqual(['l:14']);
});

it('does not inherit a citation type through masked inline code', () => {
  expect(typedCitations('decision #12; `unrelated code` #13')).toEqual(['d:12']);
});

it('masks multiline and unfinished foreign fences conservatively', () => {
  expect(
    typedCitations(
      '[UNTRUSTED DATA — from proj:other] decision #12 [END UNTRUSTED DATA] constraint #13'
    )
  ).toEqual(['c:13']);
  expect(typedCitations('⟪untrusted, from proj:other⟫ d:12')).toEqual([]);
  expect(typedCitations('[UNTRUSTED DATA — malformed d:12')).toEqual([]);
});

it('rejects unsupported colon-form ranges without accepting their first endpoint', () => {
  expect(typedCitations('d:12-9999; l:13–15; c:14 - #19')).toEqual([]);
});

it('retains explicit foreign attribution before a lowercase parenthetical label', () => {
  expect(
    typedCitations(
      'foreign project stage1 (decision #12); foreign stage1 (d:13); upstream prior service (learning #14)'
    )
  ).toEqual([]);
  expect(
    typedCitations(
      'The exclusion logic (decision #12); local notes (learning #13); the record a project keeps (decision #14)'
    )
  ).toEqual(['d:12', 'l:13', 'd:14']);
});

it('rejects malformed hash ranges as a whole rather than accepting the first endpoint', () => {
  expect(typedCitations('decision #12-13x; learning #14–#15_bad')).toEqual([]);
  expect(typedCitations('decisions #12-13; learning #14–#15')).toEqual([
    'd:12',
    'd:13',
    'l:14',
    'l:15',
  ]);
});
