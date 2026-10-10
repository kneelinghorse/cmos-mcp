// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Frozen retrieval evidence must preserve temporal exclusions and source provenance.
// ABOUTME: Status reconstruction is explicit and hash drift fails before benchmark execution.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { CmosDatabaseClient } from '../../src/tools/cmos/client';
import { CMOS_SCHEMA } from '../../src/tools/cmos/schema';
import { ensureVectorStorage } from '../../src/tools/cmos/schema-migrations';
import * as recordLinks from '../../src/tools/cmos/record-links';
import * as extractor from '../../src/tools/cmos/record-link-extractor';
import { loadLinkInventory } from '../../src/tools/cmos/record-link-store';

const {
  checkedJson,
  stateAt,
  priorLocalRows,
  createSlice,
} = require('../../scripts/retrieval-quality-fixture');
const { buildLabels } = require('../../scripts/build-retrieval-labels');
const now = Date.now();
const date = (offset: number) => new Date(now + offset).toISOString();

describe('temporal benchmark evidence', () => {
  it.each([false, true])(
    'retains collision identities without admitting excluded text (persisted graph=%s)',
    async (includeLinks) => {
      const decision = (id: number, extra: Record<string, unknown> = {}) => ({
        id,
        decision_text: 'Eligible architecture.',
        context_text: null,
        alternatives: null,
        consequences: null,
        deciders: null,
        status: 'active',
        created_at: date(-3000),
        sprint_id: null,
        superseded_by: null,
        project_id: 'local',
        ...extra,
      });
      const learning = (id: number, extra: Record<string, unknown> = {}) => ({
        id,
        content: 'Eligible architecture.',
        status: 'active',
        created_at: date(-3000),
        sprint_id: null,
        project_id: 'local',
        ...extra,
      });
      const decisions = [
        ...[10, 11, 12, 13, 14, 17].map((id) => decision(id)),
        decision(15, { project_id: 'foreign', decision_text: 'Forbiddenquartz d:10.' }),
        decision(16, { created_at: null, decision_text: 'Forbiddenquartz d:10.' }),
        decision(50, {
          decision_text: 'Use #10, #11, #12, #13, #14, #15, #16 and #17.',
          context_text: 'Keep d:10 and l:15.',
          consequences: 'Reject d:15 and l:10; reject d:16 and l:11.',
          created_at: date(-1000),
          project_id: null,
        }),
        decision(60, { decision_text: 'Forbiddenquartz query.', created_at: date(0) }),
        decision(61, { decision_text: 'Forbiddenquartz future.', created_at: date(1) }),
      ];
      const learnings = [
        learning(10, { project_id: 'foreign', content: 'Forbiddenquartz d:10.' }),
        learning(11, { created_at: 'invalid', content: 'Forbiddenquartz d:10.' }),
        learning(15, { project_id: null }),
        learning(16),
        learning(17, { created_at: date(1), content: 'Forbiddenquartz future collision.' }),
      ];
      const corpus = {
        projectId: 'local',
        decisions,
        learnings,
        missions: [],
        sprints: [],
        collisionInventory: {
          strategic_decisions: decisions,
          learnings,
          constraints: [{ id: 12, created_at: 'invalid', project_id: 'local' }],
          next_steps: [{ id: 13, created_at: null, project_id: null }],
          agent_feedback: [{ id: 14, created_at: null, project_id: 'foreign' }],
        },
      };
      const source = {
        CMOS_SCHEMA,
        CmosDatabaseClient,
        ensureVectorStorage,
        moduleAt: () => recordLinks,
      };
      const slice = await createSlice(source, corpus, includeLinks);
      try {
        slice.fill({ kind: 'decision', rowId: 60, cutoff: now });
        const inventory = loadLinkInventory(slice.client);
        expect(inventory.identities.map((row) => `${row.kind}:${row.id}`).sort()).toEqual(
          [
            ...[10, 11, 12, 13, 14, 15, 16, 17, 50].map((id) => `decision:${id}`),
            ...[10, 11, 15, 16].map((id) => `learning:${id}`),
            'constraint:12',
            'next_step:13',
            'feedback:14',
          ].sort()
        );
        const graph = recordLinks.readRecordLinks(slice.client);
        expect(graph.available).toBe(true);
        expect(graph.mode).toBe(includeLinks ? 'persisted' : 'typed-fallback');
        const targets = graph.links.map((edge) => `${edge.to_kind}:${edge.to_id}`).sort();
        expect(targets).toEqual(
          (includeLinks
            ? ['decision:10', 'decision:17', 'learning:15']
            : ['decision:10', 'learning:15']
          ).sort()
        );
        const label = buildLabels(corpus, extractor).queries.find(
          (row: { id: string }) => row.id === 'decision:50'
        );
        expect(label.positiveIds).toEqual(['d:10', 'd:17', 'l:15']);
        for (const table of ['decisions_fts', 'learnings_fts']) {
          expect(
            slice.db
              .prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`)
              .all('Forbiddenquartz')
          ).toEqual([]);
        }
        expect(
          slice.db
            .prepare("SELECT id FROM strategic_decisions WHERE status <> 'superseded' ORDER BY id")
            .all()
        ).toEqual([10, 11, 12, 13, 14, 17, 50].map((id) => ({ id })));
        expect(
          slice.db
            .prepare("SELECT id FROM learnings WHERE status <> 'superseded' ORDER BY id")
            .all()
        ).toEqual([{ id: 15 }, { id: 16 }]);
        // A new slice must replace the prior inventory, never retain a now-future source.
        slice.fill({ kind: 'decision', rowId: 50, cutoff: now - 1000 });
        expect(recordLinks.readRecordLinks(slice.client).links).toEqual([]);
      } finally {
        slice.close();
      }
    }
  );

  it('excludes the citing row, future rows, unknown dates, and foreign text before indexing', () => {
    const rows = [
      { id: 1, created_at: date(-5), project_id: 'local' },
      { id: 2, created_at: date(-4), project_id: null },
      { id: 3, created_at: date(-3), project_id: 'foreign' },
      { id: 4, created_at: date(0), project_id: 'local' },
      { id: 5, created_at: null, project_id: 'local' },
      { id: 6, created_at: 'invalid', project_id: 'local' },
      { id: 7, created_at: date(-1), project_id: 'local' },
    ];
    expect(priorLocalRows(rows, now, 'local', 7).map((row: { id: number }) => row.id)).toEqual([
      1, 2,
    ]);
  });

  it('does not activate a superseder at or after the query cutoff', () => {
    const row = { status: 'superseded', superseded_by: 2, sprint_id: 's1' };
    const decisions = new Map([[2, { created_at: date(0) }]]);
    expect(stateAt(row, now, decisions, new Map())).toEqual({
      status: 'active',
      supersededBy: null,
    });
    decisions.set(2, { created_at: date(-1) });
    expect(stateAt(row, now, decisions, new Map())).toEqual({
      status: 'superseded',
      supersededBy: 2,
    });
  });

  it('uses known closure only for pointerless supersession and states unknown history as active', () => {
    const row = { status: 'superseded', superseded_by: null, sprint_id: 's1' };
    expect(stateAt(row, now, new Map(), new Map())).toEqual({
      status: 'active',
      supersededBy: null,
    });
    const sprints = new Map([['s1', { end_date: date(-1) }]]);
    expect(stateAt(row, now, new Map(), sprints)).toEqual({
      status: 'superseded',
      supersededBy: null,
    });
    expect(stateAt({ ...row, status: 'archived' }, now, new Map(), sprints).status).toBe(
      'archived'
    );
  });

  it('refuses corrupt fixture bytes rather than silently regenerating labels', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-retrieval-hash-'));
    const file = path.join(dir, 'fixture.json');
    try {
      const raw = '{"fixed":true}\n';
      const sha = crypto.createHash('sha256').update(raw).digest('hex');
      fs.writeFileSync(file, raw);
      expect(checkedJson(file, sha)).toEqual({ fixed: true });
      fs.writeFileSync(file, '{"fixed":false}\n');
      expect(() => checkedJson(file, sha)).toThrow(/hash/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes loaded source through symlinked roots and detects a later source change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-retrieval-source-'));
    const sourceRoot = path.join(dir, 'source');
    const linkedRoot = path.join(dir, 'linked');
    const modules = [
      'tools/cmos/fts5-retriever',
      'tools/cmos/client',
      'tools/cmos/schema',
      'tools/cmos/schema-migrations',
      'tools/cmos/relevance-surfacing',
      'tools/cmos/first-prompt-recall',
      'tools/cmos/tool-call-context',
      'cli',
    ];
    try {
      for (const name of modules) {
        const file = path.join(sourceRoot, 'src', name + '.ts');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          name.endsWith('fts5-retriever')
            ? 'export class HybridRetriever { async embedQuery() { return null; } }\n'
            : 'export {};\n'
        );
      }
      fs.symlinkSync(sourceRoot, linkedRoot, 'dir');
      const code = `const fs=require('fs'); const {loadSource}=require(process.argv[1]);
        const source=loadSource(process.argv[2]);
        const count=Object.keys(source.verify()).length;
        fs.appendFileSync(process.argv[3], '\\n// mutation');
        let rejected=false;try{source.verify();}catch(e){rejected=/source changed/.test(e.message);}
        source.restore();process.stdout.write(JSON.stringify({count,rejected}));`;
      const output = execFileSync(
        process.execPath,
        [
          '-e',
          code,
          path.resolve('scripts/retrieval-quality-fixture.js'),
          linkedRoot,
          path.join(sourceRoot, 'src/tools/cmos/fts5-retriever.ts'),
        ],
        { encoding: 'utf8' }
      );
      expect(JSON.parse(output)).toEqual({ count: modules.length, rejected: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
