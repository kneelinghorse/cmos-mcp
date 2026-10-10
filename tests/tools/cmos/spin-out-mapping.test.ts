// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A new copy cannot inherit unrelated target references or claim a source proposal approval.
// ABOUTME: Explicit column coverage and collision mutations keep the copy contract fail-closed.
import Database from 'better-sqlite3';
import { allocateSpinOutIds, mapSpinOutRows } from '../../../src/tools/cmos/spin-out-mapping';
import { captureSpinOutManifest } from '../../../src/tools/cmos/spin-out-manifest';
import {
  SPIN_OUT_COLUMN_POLICIES,
  isSpinOutReferenceColumn,
} from '../../../src/tools/cmos/spin-out-columns';
import { citationCandidates } from '../../../src/tools/cmos/decision-citations';
import { computeContentHash } from '../../../src/tools/cmos/schema-migrations';
import {
  canonicalRecordFields,
  extractRecordLinkCandidates,
} from '../../../src/tools/cmos/record-link-extractor';
import type {
  SpinOutSourceSnapshot,
  SpinOutSourceRow,
  SpinOutIdMapping,
  SpinOutMappingContext,
  SpinOutReader,
  SpinOutSqlValue,
  SpinOutKind,
} from '../../../src/tools/cmos/spin-out-types';

const older = new Date(Date.now() - 30000).toISOString();
const newer = new Date(Date.now() - 10000).toISOString();
const context: SpinOutMappingContext = {
  operationId: 'fork-test',
  source: { projectId: 'source', root: '/source', storePath: '/source/cmos/db/cmos.sqlite' },
  target: { projectId: 'target', root: '/target', storePath: '/target/cmos/db/cmos.sqlite' },
  sourceUri: 'cmos://owner/source',
  masterContextId: 'master_context',
};
function row(
  kind: SpinOutKind,
  id: string | number,
  overrides: Record<string, SpinOutSqlValue> = {}
): SpinOutSourceRow {
  const values: Record<string, SpinOutSqlValue> = Object.fromEntries(
    Object.keys(SPIN_OUT_COLUMN_POLICIES[kind]).map((key) => [key, null])
  );
  Object.assign(
    values,
    {
      id,
      created_at: older,
      project_id: 'source',
      status: kind === 'mission' ? 'Queued' : 'active',
      author_user_id: 'external-user',
    },
    overrides
  );
  return { key: { kind, id } as SpinOutSourceRow['key'], values };
}
function fixture(): { snapshot: SpinOutSourceSnapshot; mapping: SpinOutIdMapping[] } {
  const rows = [
    row('mission', 'm1', {
      name: 'Original',
      sprint_id: 's1',
      metadata: '{"custom":17}',
      domain_fields: '{"blocker":"see decision #12","ticket":12}',
    }),
    row('decision', 12, {
      decision_text: 'Earlier choice',
      mission_id: 'm1',
      project_domain: 'design',
    }),
    row('learning', 13, { content: 'Earlier lesson', mission_id: 'm1', category: 'technical' }),
    row('next-step', 14, {
      content: 'Earlier task',
      mission_id: 'm1',
      session_id: 'session',
      carried_to_sprint: 's2',
    }),
    row('decision', 20, {
      decision_text: 'decisions #12-13; learning #13; next-step #14',
      created_at: newer,
      mission_id: 'm1',
      superseded_by: 12,
      context_id: 'other',
      snapshot_id: 50,
      author_session_id: 'session',
      sprint_id: 's1',
      evidence: '[{"type":"tracelab","id":"uuid-12"}]',
      source_chunk_ids: '["chunk-12"]',
      approval_mode: 'approved',
      approval_draft: 'P12',
      approval_words: 'Yes: decision #12 exactly.',
      alternatives: '["decision #12","#13"]',
      context_text: 'd:12',
      consequences: 'l:13',
      deciders: '["operator"]',
      content_hash: 'old-hash',
      last_embedded_hash: 'old-embedding',
    }),
  ];
  return {
    snapshot: {
      sourceProjectId: 'source',
      selectionDescriptor: { missionIds: ['m1'], decisionIds: [20] },
      columns: {
        mission: Object.keys(SPIN_OUT_COLUMN_POLICIES.mission),
        decision: Object.keys(SPIN_OUT_COLUMN_POLICIES.decision),
        learning: Object.keys(SPIN_OUT_COLUMN_POLICIES.learning),
        'next-step': Object.keys(SPIN_OUT_COLUMN_POLICIES['next-step']),
      },
      rows,
      dependencies: [{ from_id: 'm1', to_id: 'outside', type: 'Blocks' }],
      collisionInventory: [
        { kind: 'decision', id: 12, created_at: older, project_id: 'source' },
        { kind: 'learning', id: 13, created_at: older, project_id: null },
        { kind: 'next_step', id: 14, created_at: older, project_id: 'source' },
        { kind: 'decision', id: 20, created_at: newer, project_id: 'source' },
      ],
    },
    mapping: rows.map(({ key }) => ({
      source: key,
      target:
        key.kind === 'mission'
          ? { kind: 'mission', id: 'm1-2' }
          : { kind: key.kind, id: key.id + 100 },
    })),
  };
}
function mapped(snapshot: SpinOutSourceSnapshot, mapping: SpinOutIdMapping[]) {
  const result = mapSpinOutRows(snapshot, mapping, context);
  if (!result.success || !result.data) throw new Error(result.error?.message ?? 'mapping failed');
  return result.data;
}

it('classifies the exact 31 reference columns, with complements also declared', () => {
  const counts = Object.values(SPIN_OUT_COLUMN_POLICIES).map(
    (columns) => Object.keys(columns).filter(isSpinOutReferenceColumn).length
  );
  expect(counts).toEqual([6, 10, 6, 7]);
  expect(counts.reduce((a, b) => a + b, 2)).toBe(31); // two dependency endpoints
  expect(SPIN_OUT_COLUMN_POLICIES.decision).toMatchObject({
    approval_words: 'keep',
    approval_draft: 'null',
    source_chunk_ids: 'keep',
    alternatives: 'text-array',
    content_hash: 'hash',
    last_embedded_hash: 'null',
  });
});
it('maps selected local scalar references, removes uncopied refs and defers forward decision FKs', () => {
  const { snapshot, mapping } = fixture();
  const plan = mapped(snapshot, mapping);
  const decision = plan.rows.find((entry) => entry.source.id === 20)!.values;
  expect(decision).toMatchObject({
    id: 120,
    context_id: 'master_context',
    mission_id: 'm1-2',
    sprint_id: null,
    snapshot_id: null,
    author_session_id: null,
    superseded_by: null,
    author_user_id: 'external-user',
    created_at: newer,
  });
  expect(plan.deferredSupersessions).toEqual([{ id: 120, supersededBy: 112 }]);
  expect(plan.rows.find((entry) => entry.source.kind === 'next-step')!.values).toMatchObject({
    session_id: null,
    carried_to_sprint: null,
    mission_id: 'm1-2',
  });
  for (const entry of plan.rows)
    for (const field of [
      'project_id',
      'stable_event_id',
      'occurred_at',
      'origin_seq',
      'event_type',
      'schema_version',
    ])
      expect(entry.values).not.toHaveProperty(field);
  expect(plan.boundaryDependencies).toEqual(snapshot.dependencies);
});
it('preserves exact approval quotes and external references with source-scoped original provenance', () => {
  const { snapshot, mapping } = fixture();
  const plan = mapped(snapshot, mapping);
  const decision = plan.rows.find((entry) => entry.source.id === 20)!.values;
  expect(decision).toMatchObject({
    approval_mode: 'approved',
    approval_words: 'Yes: decision #12 exactly.',
    approval_draft: null,
    source_chunk_ids: '["chunk-12"]',
  });
  expect(JSON.parse(decision.evidence as string)).toEqual([
    { type: 'tracelab', id: 'uuid-12' },
    { type: 'cmos', id: 'cmos://owner/source#decision-20' },
  ]);
  expect(plan.provenance.find((entry) => entry.sourceId === 20)).toMatchObject({
    originalProjectId: 'source',
    originalApproval: { mode: 'approved', draft: 'P12', words: 'Yes: decision #12 exactly.' },
    originalReferences: { snapshot_id: 50, mission_id: 'm1', source_chunk_ids: '["chunk-12"]' },
  });
});
it('resolves spans before allocation, expands mixed ranges and keeps canonical array items independent', () => {
  const { snapshot, mapping } = fixture();
  const plan = mapped(snapshot, mapping);
  const decision = plan.rows.find((entry) => entry.source.id === 20)!.values;
  expect(decision.decision_text).toContain('d:112');
  expect(decision.decision_text).toContain('cmos://owner/source#decision-13');
  expect(citationCandidates(decision.decision_text as string)).toEqual([
    { prefix: 'd', id: 112 },
    { prefix: 'l', id: 113 },
    { prefix: 'n', id: 114 },
  ]);
  expect(JSON.parse(decision.alternatives as string)).toEqual(['decision — d:112', '— l:113']);
  expect(decision.content_hash).toBe(
    computeContentHash(decision.decision_text as string, 'general')
  );
  expect(decision.last_embedded_hash).toBeNull();
});
it('foreign row origin cannot borrow source-local scalar or citation references', () => {
  const { snapshot, mapping } = fixture();
  const foreign = {
    ...snapshot,
    rows: snapshot.rows.map((entry) =>
      entry.key.id === 20 ? { ...entry, values: { ...entry.values, project_id: 'foreign' } } : entry
    ),
  };
  const plan = mapped(foreign, mapping);
  const values = plan.rows.find((entry) => entry.source.id === 20)!.values;
  expect(values.mission_id).toBeNull();
  expect(plan.deferredSupersessions).toEqual([]);
  expect(citationCandidates(values.decision_text as string)).toEqual([]);
  expect(plan.provenance.find((entry) => entry.sourceId === 20)?.originalProjectId).toBe('foreign');
});
it.each(['constraint', 'feedback'] as const)(
  'does not turn an ambiguous bare id into a target-local %s collision',
  (kind) => {
    const { snapshot, mapping } = fixture();
    const altered = {
      ...snapshot,
      collisionInventory: [
        ...snapshot.collisionInventory,
        { kind, id: 13, created_at: kind === 'constraint' ? null : older, project_id: null },
      ],
    };
    const plan = mapped(altered, mapping);
    const values = plan.rows.find((entry) => entry.source.id === 20)!.values;
    expect(JSON.parse(values.alternatives as string)[1]).toMatch(/^cmos:\/\//);
    expect(citationCandidates(JSON.parse(values.alternatives as string)[1])).toEqual([]);
  }
);
it('preserves malformed JSON as source provenance without losing its original bytes', () => {
  const { snapshot, mapping } = fixture();
  const altered = {
    ...snapshot,
    rows: snapshot.rows.map((entry) =>
      entry.key.kind === 'mission'
        ? {
            ...entry,
            values: {
              ...entry.values,
              metadata: '{bad json',
              domain_fields: '{"ticket":12,"unknown":"#12"}',
            },
          }
        : entry
    ),
  };
  const plan = mapped(altered, mapping);
  const mission = plan.rows.find((entry) => entry.source.kind === 'mission')!.values;
  expect(JSON.parse(mission.metadata as string).source).toMatchObject({
    projectId: 'source',
    id: 'm1',
  });
  expect(mission.domain_fields).toBe('{"ticket":12,"unknown":"#12"}');
  expect(
    plan.provenance.find((entry) => entry.kind === 'mission')!.originalReferences.metadata
  ).toBe('{bad json');
});
it.each(['{"note":"See; decision #12"}', '["See; decision #12",1,"#13"]'])(
  'rewrites noncanonical rich JSON as the same raw field that target retrieval will parse: %s',
  (alternatives) => {
    const { snapshot, mapping } = fixture();
    const altered = {
      ...snapshot,
      rows: snapshot.rows.map((entry) =>
        entry.key.id === 20 ? { ...entry, values: { ...entry.values, alternatives } } : entry
      ),
    };
    const values = mapped(altered, mapping).rows.find((entry) => entry.source.id === 20)!.values;
    const graph = extractRecordLinkCandidates(
      canonicalRecordFields('decision', { decision_text: '', alternatives: values.alternatives }),
      { kind: 'decision', id: 120, project_id: 'target', created_at: newer },
      [
        { kind: 'decision', id: 12, project_id: 'target', created_at: older },
        { kind: 'decision', id: 112, project_id: 'target', created_at: older },
        { kind: 'learning', id: 113, project_id: 'target', created_at: older },
      ],
      'target'
    );
    expect(graph.links.some((edge) => edge.to_kind === 'decision' && edge.to_id === 112)).toBe(
      true
    );
    expect(graph.links.some((edge) => edge.to_id === 12)).toBe(false);
  }
);
it('copies only dependencies with two selected local mission endpoints', () => {
  const { snapshot, mapping } = fixture();
  const second = row('mission', 'm2', { name: 'Second' });
  const altered = {
    ...snapshot,
    rows: [...snapshot.rows, second],
    dependencies: [...snapshot.dependencies, { from_id: 'm1', to_id: 'm2', type: 'Blocks' }],
  };
  const plan = mapped(altered, [
    ...mapping,
    { source: second.key, target: { kind: 'mission', id: 'm2' } },
  ]);
  expect(plan.dependencies).toEqual([{ from_id: 'm1-2', to_id: 'm2', type: 'Blocks' }]);
  expect(plan.boundaryDependencies).toHaveLength(1);
});
it('refuses unknown columns, malformed ids, mismatched mapping kinds and missing mappings', () => {
  const { snapshot, mapping } = fixture();
  const unknown = {
    ...snapshot,
    columns: { ...snapshot.columns, decision: [...snapshot.columns.decision, 'new_local_id'] },
  };
  expect(mapSpinOutRows(unknown, mapping, context).success).toBe(false);
  expect(mapSpinOutRows(snapshot, mapping.slice(1), context).success).toBe(false);
  expect(
    mapSpinOutRows(
      snapshot,
      [{ source: mapping[0].source, target: { kind: 'decision', id: 1 } }, ...mapping.slice(1)],
      context
    ).success
  ).toBe(false);
  const invalid = {
    ...snapshot,
    rows: [{ ...snapshot.rows[1], key: { kind: 'decision' as const, id: NaN } }],
  };
  expect(mapSpinOutRows(invalid, [], context).success).toBe(false);
});
it('previews historical session_id aliases read-only, retaining provenance and clearing the local reference', () => {
  const { snapshot, mapping } = fixture();
  const legacy = {
    ...snapshot,
    columns: {
      ...snapshot.columns,
      decision: snapshot.columns.decision.map((column) =>
        column === 'author_session_id' ? 'session_id' : column
      ),
      learning: snapshot.columns.learning.map((column) =>
        column === 'author_session_id' ? 'session_id' : column
      ),
    },
    rows: snapshot.rows.map((entry) => {
      if (entry.key.kind !== 'decision' && entry.key.kind !== 'learning') return entry;
      const { author_session_id, ...values } = entry.values;
      return { ...entry, values: { ...values, session_id: author_session_id } };
    }),
  };
  const plan = mapped(legacy, mapping);
  const decision = plan.rows.find((entry) => entry.source.id === 20)!.values;
  expect(decision.author_session_id).toBeNull();
  expect(decision).not.toHaveProperty('session_id');
  expect(
    plan.provenance.find((entry) => entry.sourceId === 20)?.originalReferences.session_id
  ).toBe('session');
});
it('binds unselected collision identities and full row payloads into a stable manifest', () => {
  const { snapshot } = fixture();
  const original = captureSpinOutManifest(snapshot);
  expect(
    captureSpinOutManifest({
      ...snapshot,
      rows: [...snapshot.rows].reverse(),
      collisionInventory: [...snapshot.collisionInventory].reverse(),
    }).hash
  ).toBe(original.hash);
  expect(
    captureSpinOutManifest({
      ...snapshot,
      collisionInventory: [
        ...snapshot.collisionInventory,
        { kind: 'feedback', id: 12, created_at: null, project_id: null },
      ],
    }).hash
  ).not.toBe(original.hash);
  expect(
    captureSpinOutManifest({
      ...snapshot,
      rows: snapshot.rows.map((entry) => ({
        ...entry,
        values: { ...entry.values, author_user_id: 'changed' },
      })),
    }).hash
  ).not.toBe(original.hash);
  expect(
    captureSpinOutManifest({ ...snapshot, selectionDescriptor: { missionIds: ['m1', 'new'] } }).hash
  ).not.toBe(original.hash);
});
it('allocates above existing numeric ids and chooses the first free mission suffix without writes', () => {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE missions(id TEXT); INSERT INTO missions VALUES('m1'),('m1-1'); CREATE TABLE strategic_decisions(id INTEGER); INSERT INTO strategic_decisions VALUES(200); CREATE TABLE learnings(id INTEGER); CREATE TABLE next_steps(id INTEGER); CREATE TABLE contexts(id TEXT); INSERT INTO contexts VALUES('master_context');"
  );
  const target = {
    path: '/test.sqlite',
    getMany: (sql: string, params: unknown[] = []) => ({
      success: true,
      data: db.prepare(sql).all(...params),
    }),
    getOne: (sql: string, params: unknown[] = []) => ({
      success: true,
      data: db.prepare(sql).get(...params),
    }),
  } as SpinOutReader;
  const { snapshot } = fixture();
  const result = allocateSpinOutIds(target, snapshot);
  expect(result.success).toBe(true);
  expect(result.data).toEqual([
    { source: { kind: 'decision', id: 12 }, target: { kind: 'decision', id: 201 } },
    { source: { kind: 'decision', id: 20 }, target: { kind: 'decision', id: 202 } },
    { source: { kind: 'learning', id: 13 }, target: { kind: 'learning', id: 1 } },
    { source: { kind: 'mission', id: 'm1' }, target: { kind: 'mission', id: 'm1-2' } },
    { source: { kind: 'next-step', id: 14 }, target: { kind: 'next-step', id: 1 } },
  ]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM strategic_decisions').get()).toEqual({ n: 1 });
  db.exec('DELETE FROM contexts');
  expect(allocateSpinOutIds(target, snapshot).success).toBe(false);
  db.close();
});
it('reserves every originally free selected mission ID before assigning collision suffixes', () => {
  const { snapshot } = fixture();
  const second = row('mission', 'm1-1', { name: 'An originally free ID' });
  const target = {
    path: '/test.sqlite',
    getOne: () => ({ success: true, data: { id: 'master_context' } }),
    getMany: (sql: string) => ({
      success: true,
      data: sql === 'SELECT id FROM missions' ? [{ id: 'm1' }] : [],
    }),
  } as unknown as SpinOutReader;
  const result = allocateSpinOutIds(target, { ...snapshot, rows: [snapshot.rows[0], second] });
  expect(result.data).toEqual([
    { source: { kind: 'mission', id: 'm1' }, target: { kind: 'mission', id: 'm1-2' } },
    { source: { kind: 'mission', id: 'm1-1' }, target: { kind: 'mission', id: 'm1-1' } },
  ]);
});
