// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Citation labels share production grammar and prove origin/time/ambiguity boundaries.
// ABOUTME: Canonical fields stay separate so unrelated array items cannot inherit a namespace.
import {
  canonicalRecordFields,
  extractRecordLinkCandidates,
} from '../../../src/tools/cmos/record-link-extractor';

const older = new Date(Date.now() - 20000).toISOString();
const newer = new Date(Date.now() - 10000).toISOString();
const source = { kind: 'decision', id: 100, created_at: newer, project_id: 'local' };
const inventory = [
  { kind: 'decision' as const, id: 12, created_at: older, project_id: 'local' },
  { kind: 'learning' as const, id: 13, created_at: older, project_id: null },
  { kind: 'decision' as const, id: 14, created_at: older, project_id: 'local' },
  { kind: 'feedback' as const, id: 14, created_at: older, project_id: 'foreign' },
];
const parse = (fields: readonly string[]) =>
  extractRecordLinkCandidates(fields, source, inventory, 'local');
it('resolves typed and unique bare endpoints once, preferring typed evidence', () => {
  expect(parse(['#12', 'decision #12', '#13', '#14']).links).toEqual([
    { from_kind: 'decision', from_id: 100, to_kind: 'decision', to_id: 12, resolution: 'typed' },
    { from_kind: 'decision', from_id: 100, to_kind: 'learning', to_id: 13, resolution: 'bare' },
  ]);
  expect(parse(['#14']).discarded.ambiguous).toBe(1);
});
it('preserves code, foreign, unsupported-kind and list barriers for bare fallback', () => {
  expect(
    parse([
      'PR #12, #13; feedback #12; rule #12; practice #13; constraint #12, #13; Stage1 decision #12; foreign #13; `#12`; [#13](https://x.test); d:12-14; #12.5; #9007199254740992',
    ]).links
  ).toEqual([]);
});
it('separates canonical fields and array items before parsing', () => {
  const fields = canonicalRecordFields('decision', {
    decision_text: 'decision #12',
    context_text: '#13',
    alternatives: JSON.stringify(['learning #13', '#12']),
    consequences: null,
    deciders: null,
    approval_words: 'decision #14',
  });
  expect(fields).toEqual(['decision #12', '#13', 'learning #13', '#12']);
  expect(parse(fields).links).toHaveLength(2);
  expect(parse(fields).links.find((x) => x.to_id === 13)?.resolution).toBe('typed');
  expect(parse(['decision #12', '#13']).links.find((x) => x.to_id === 13)?.to_kind).toBe(
    'learning'
  );
  expect(canonicalRecordFields('learning', { content: 'lesson #13' })).toEqual(['lesson #13']);
});
it('requires both local endpoints and strictly earlier known timestamps', () => {
  expect(
    extractRecordLinkCandidates(['d:12'], { ...source, project_id: 'foreign' }, inventory, 'local')
      .links
  ).toEqual([]);
  expect(
    extractRecordLinkCandidates(['d:12'], { ...source, created_at: null }, inventory, 'local')
      .discarded.unknownTime
  ).toBe(1);
  const targets = [
    { ...inventory[0], created_at: null },
    { kind: 'learning' as const, id: 13, created_at: newer, project_id: null },
    { kind: 'decision' as const, id: 15, created_at: older, project_id: 'foreign' },
  ];
  const result = extractRecordLinkCandidates(['d:12 l:13 d:15 d:16'], source, targets, 'local');
  expect(result.links).toEqual([]);
  expect(result.discarded).toMatchObject({ unknownTime: 1, foreign: 1, missing: 1 });
});
it('typed fallback excludes bare edges but keeps supported explicit kinds', () => {
  expect(
    extractRecordLinkCandidates(['#12; l:13'], source, inventory, 'local', {
      typedOnly: true,
    }).links.map((x) => x.to_id)
  ).toEqual([13]);
});
it('allows query pseudo-sources and legacy origins without admitting future text', () => {
  expect(
    extractRecordLinkCandidates(
      ['decision #12'],
      { ...source, kind: 'mission', project_id: null },
      inventory,
      'local'
    ).links[0].from_kind
  ).toBe('mission');
  expect(
    parse(['⟪untrusted, from proj:x⟫ d:12 ⟪/untrusted⟫ l:13']).links.map((x) => x.to_id)
  ).toEqual([13]);
});

it('does not invent temporal membership for unknown collision timestamps', () => {
  const result = extractRecordLinkCandidates(
    ['#12'],
    source,
    [...inventory, { kind: 'constraint', id: 12, created_at: null, project_id: null }],
    'local'
  );
  expect(result.links).toEqual([]);
  expect(result.discarded.unknownTime).toBe(1);
});

it('blocks named foreign bare attributions and their lists while keeping ordinary local prose', () => {
  expect(
    parse([
      'Stage1 #12',
      'TraceLab #12/#13',
      "TraceLab's prior #12, #13",
      'project Stage1 #12',
      'foreign #12 and #13',
      "Stage1's decisions #12",
      'TraceLab (learning #13)',
    ]).links
  ).toEqual([]);
  expect(
    parse(['Follow #12', 'See earlier #13', 'this #12', 'local #13']).links.map(
      (edge) => edge.to_id
    )
  ).toEqual([12, 13]);
  expect(parse(['TraceLab #12, #13. #12']).links.map((edge) => edge.to_id)).toEqual([12]);
});

it('uses the typed parser conservative qualifier policy for lowercase and possessive bare attributions', () => {
  expect(
    parse(['stage1 #12', 'cmos-dashboard #12/#13', 'tracelab’s #12', 'tracelab prior #12, #13'])
      .links
  ).toEqual([]);
  expect(
    parse(['follow #12', 'referenced #13', 'per #12', 'local #13']).links.map((edge) => edge.to_id)
  ).toEqual([12, 13]);
});

it('keeps known citation connectives from absorbing an earlier prose subject', () => {
  expect(
    parse([
      'Implementation notes per #12',
      'shape options (per #13)',
      'ordinary notes (see prior #12)',
    ]).links.map((edge) => edge.to_id)
  ).toEqual([12, 13]);
  expect(parse(['foreign per #12', 'PR per #13', 'stage1 prior #12']).links).toEqual([]);
});

it('does not materialize local edges from foreign parenthetical or malformed bare ranges', () => {
  const result = parse([
    'foreign project stage1 (decision #12)',
    'upstream prior service (l:13)',
    '#12-13x',
    '#12–#13_bad',
  ]);
  expect(result.links).toEqual([]);
  expect(result.discarded.unsupported).toBe(4);
  expect(parse(['#12-13']).links.map((edge) => edge.to_id)).toEqual([12, 13]);
});
