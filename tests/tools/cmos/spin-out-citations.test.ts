// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Source-scope proof prevents copied text from citing colliding target IDs accidentally.
// ABOUTME: External references, malformed references and masked examples retain their exact bytes.
import { rewriteSpinOutText } from '../../../src/tools/cmos/spin-out-citations';
import { citationCandidates } from '../../../src/tools/cmos/decision-citations';
import type {
  SpinOutSourceRow,
  SpinOutSourceSnapshot,
  SpinOutIdMapping,
  SpinOutMappingContext,
} from '../../../src/tools/cmos/spin-out-types';
const older = new Date(Date.now() - 20000).toISOString();
const newer = new Date(Date.now() - 10000).toISOString();
const row: SpinOutSourceRow = {
  key: { kind: 'decision', id: 90 },
  values: { id: 90, project_id: 'source', created_at: newer },
};
const context: SpinOutMappingContext = {
  operationId: 'copy',
  source: { projectId: 'source', root: '/source', storePath: '/source/db' },
  target: { projectId: 'target', root: '/target', storePath: '/target/db' },
  sourceUri: 'cmos://owner/source',
  masterContextId: 'master_context',
};
const snapshot: SpinOutSourceSnapshot = {
  sourceProjectId: 'source',
  columns: { mission: [], decision: [], learning: [], 'next-step': [] },
  selectionDescriptor: {},
  rows: [row],
  dependencies: [],
  collisionInventory: [
    { kind: 'decision', id: 12, project_id: 'source', created_at: older },
    { kind: 'learning', id: 13, project_id: null, created_at: older },
    { kind: 'next_step', id: 14, project_id: 'source', created_at: older },
    { kind: 'constraint', id: 15, project_id: 'source', created_at: older },
  ],
};
const mapping: SpinOutIdMapping[] = [
  { source: { kind: 'decision', id: 12 }, target: { kind: 'decision', id: 112 } },
  { source: { kind: 'learning', id: 13 }, target: { kind: 'learning', id: 113 } },
  { source: { kind: 'next-step', id: 14 }, target: { kind: 'next-step', id: 114 } },
];
const rewrite = (text: string, source = row, inventory = snapshot.collisionInventory) =>
  rewriteSpinOutText(
    text,
    source,
    { ...snapshot, collisionInventory: inventory },
    mapping,
    context
  );

it.each([
  'PR #12 and #13; ADR #12; GitHub issue #13',
  'decision #12-13x; d:12-14; #12.5; #9007199254740992',
  'Stage1 decision #12, #13; foreign project stage1 (decision #12)',
  '`d:12`; [decision #12](https://example.test); ⟪untrusted⟫ l:13 ⟪/untrusted⟫',
])('preserves already inert references instead of changing their external meaning: %s', (text) => {
  expect(rewrite(text)).toEqual({ text, report: { rewritten: 0, qualified: 0 } });
});
it('keeps typed d/l/n replacements readable and active while constraints remain source scoped', () => {
  const result = rewrite('d:12; l:13; n:14; c:15');
  expect(result.text).toBe('— d:112; — l:113; — n:114; cmos://owner/source#constraint-15');
  expect(citationCandidates(result.text)).toEqual([
    { prefix: 'd', id: 112 },
    { prefix: 'l', id: 113 },
    { prefix: 'n', id: 114 },
  ]);
});
it('rejects unknown/equal/future target time, foreign endpoint origin, and unknown source time', () => {
  for (const target of [
    { ...snapshot.collisionInventory[0], created_at: null },
    { ...snapshot.collisionInventory[0], created_at: newer },
    { ...snapshot.collisionInventory[0], project_id: 'foreign' },
  ])
    expect(citationCandidates(rewrite('d:12', row, [target]).text)).toEqual([]);
  expect(
    citationCandidates(
      rewrite('d:12', { ...row, values: { ...row.values, created_at: null } }).text
    )
  ).toEqual([]);
});
it('qualifies an entire foreign-origin row without borrowing the source store identity', () => {
  const foreign = { ...row, values: { ...row.values, project_id: 'foreign' } };
  expect(citationCandidates(rewrite('d:12; #13; n:14', foreign).text)).toEqual([]);
  expect(rewrite('d:12; #13; n:14', foreign).report).toEqual({ rewritten: 0, qualified: 3 });
});
it('qualifies missing, uncopied and ambiguous numbers before any target collision is considered', () => {
  const inventory = [
    ...snapshot.collisionInventory,
    { kind: 'decision' as const, id: 17, created_at: older, project_id: 'source' },
    { kind: 'feedback' as const, id: 13, created_at: null, project_id: null },
  ];
  const result = rewrite('#13; d:17; #99', row, inventory);
  expect(result.report).toEqual({ rewritten: 0, qualified: 3 });
  expect(citationCandidates(result.text)).toEqual([]);
});
