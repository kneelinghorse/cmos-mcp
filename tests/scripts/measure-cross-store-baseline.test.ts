/**
 * Tests for the Sprint 69 m01 cross-store baseline measurement script.
 *
 * Covers: percentile accuracy, mutable-write counting from DURABLE domain-table
 * signals (and the ADR 6.3 exclusion of state-machine transitions from the
 * soft-lock surface), the four-query fan-out simulation against a synthetic
 * multi-store fixture, per-store failure isolation (open failure + query
 * failure), and JSON report schema stability.
 *
 * @module tests/scripts/measure-cross-store-baseline
 */

import Database from 'better-sqlite3';
import {
  percentile,
  classifyStatus,
  computeMutableShare,
  countStoreWrites,
  materializeDefaultQueries,
  buildReport,
  type StoreOpener,
  type StoreWriteCounts,
} from '../../scripts/measure-cross-store-baseline';
import { CmosDatabaseClient } from '../../src/tools/cmos/client';
import { createSeededCmosProject, type SeededCmosProject } from '../helpers/seedCmosDb';

// Fixed clock so the 30-day window + ISO timestamps are deterministic.
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const isoDaysBefore = (days: number): string => new Date(NOW - days * 86400000).toISOString();

interface StoreSeed {
  projectName: string;
  decisions: { text: string; daysAgo: number; evidence?: string; supersededBy?: number }[];
  missions: { id: string; name: string; status: string; started?: boolean; completed?: boolean }[];
  sprints: { id: string; title: string; status: string }[];
  learnings: { content: string; category: string }[];
  identitySnapshots: number;
}

async function seedStore(seed: StoreSeed): Promise<SeededCmosProject> {
  const project = await createSeededCmosProject(
    { projectName: seed.projectName },
    'baseline-test-'
  );
  const db = new Database(project.dbPath);
  // Real CMOS stores are always WAL (the client forces it on write-open); match
  // that so the script's read-only opens (which run `journal_mode=WAL`) succeed.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  const dec = db.prepare(
    'INSERT INTO strategic_decisions (decision_text, created_at, evidence, superseded_by) VALUES (?, ?, ?, ?)'
  );
  for (const d of seed.decisions) {
    dec.run(d.text, isoDaysBefore(d.daysAgo), d.evidence ?? null, d.supersededBy ?? null);
  }
  const mis = db.prepare(
    'INSERT INTO missions (id, name, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const m of seed.missions) {
    mis.run(
      m.id,
      m.name,
      m.status,
      m.started ? isoDaysBefore(2) : null,
      m.completed ? isoDaysBefore(1) : null
    );
  }
  const spr = db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)');
  for (const s of seed.sprints) spr.run(s.id, s.title, s.status);
  const lrn = db.prepare('INSERT INTO learnings (content, category, created_at) VALUES (?, ?, ?)');
  for (const l of seed.learnings) lrn.run(l.content, l.category, isoDaysBefore(2));
  const snap = db.prepare(
    'INSERT INTO context_snapshots (context_id, content_hash, content, created_at) VALUES (?, ?, ?, ?)'
  );
  for (let i = 0; i < seed.identitySnapshots; i += 1) {
    snap.run('project_identity', `hash-${i}`, '{}', isoDaysBefore(3));
  }
  db.close();
  return project;
}

const zeroCounts: StoreWriteCounts = {
  decisions: 0,
  learnings: 0,
  missions: 0,
  sprints: 0,
  sessions: 0,
  nextSteps: 0,
  constraints: 0,
  contextSnapshots: 0,
  missionsStarted: 0,
  missionsCompleted: 0,
  sprintsCompleted: 0,
  sessionsCompleted: 0,
  decisionsSuperseded: 0,
  identitySnapshots: 0,
};

describe('measure-cross-store-baseline', () => {
  describe('percentile', () => {
    it('returns 0 for an empty sample and the value for a singleton', () => {
      expect(percentile([], 95)).toBe(0);
      expect(percentile([5], 95)).toBe(5);
    });

    it('linearly interpolates p95 of 1..10', () => {
      // rank = 0.95 * 9 = 8.55 → between index 8 (9) and 9 (10): 9*0.45 + 10*0.55
      expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBeCloseTo(9.55, 5);
    });

    it('is order-independent (sorts internally)', () => {
      expect(percentile([10, 1, 5, 3, 8], 50)).toBeCloseTo(5, 5);
    });
  });

  describe('classifyStatus', () => {
    it('maps value to ok/approaching/exceeded', () => {
      expect(classifyStatus(5, 15, 25)).toBe('ok');
      expect(classifyStatus(15, 15, 25)).toBe('approaching');
      expect(classifyStatus(30, 15, 25)).toBe('exceeded');
    });
  });

  describe('computeMutableShare', () => {
    it('computes overall share and EXCLUDES state-machine transitions from the soft-lock surface', () => {
      const counts: StoreWriteCounts = {
        ...zeroCounts,
        decisions: 8,
        learnings: 4,
        missions: 10,
        sprints: 5,
        sessions: 6,
        missionsStarted: 4,
        missionsCompleted: 3,
        sprintsCompleted: 2,
        sessionsCompleted: 2,
        decisionsSuperseded: 1,
      };
      const result = computeMutableShare(counts);

      // overall: append = 8+4+10+5+6 = 33, transition = 4+3+2+2+1 = 12, total 45.
      expect(result.overall.appendWrites).toBe(33);
      expect(result.overall.transitionWrites).toBe(12);
      expect(result.overall.sharePct).toBeCloseTo(26.67, 1);
      expect(result.overall.status).toBe('exceeded');

      // soft-lock surface counts ONLY sprintsCompleted (2). The 10 mission/session/
      // decision transitions are excluded per ADR 6.3 — the key assertion.
      expect(result.softLock.surfaceWrites).toBe(2);
      expect(result.softLock.byTable.missions.surfaceWrites).toBe(0);
      expect(result.softLock.byTable.missions.totalWrites).toBe(17); // 10 + started 4 + completed 3
      expect(result.softLock.byTable.sprints.surfaceWrites).toBe(2);
      expect(result.softLock.byTable.sprints.totalWrites).toBe(7); // 5 + completed 2
    });

    it('reports status=unavailable (not a confident 0% ok) for a corpus with no writes', () => {
      const result = computeMutableShare(zeroCounts);
      expect(result.overall.sharePct).toBe(0);
      expect(result.overall.status).toBe('unavailable');
      expect(result.softLock.status).toBe('unavailable');
    });
  });

  describe('countStoreWrites', () => {
    let project: SeededCmosProject;
    afterEach(async () => {
      if (project) await project.cleanup();
    });

    it('reads durable genesis + transition signals from a real store', async () => {
      project = await seedStore({
        projectName: 'durable-count',
        decisions: [
          { text: 'd1', daysAgo: 5 },
          { text: 'd2', daysAgo: 4, supersededBy: 1 },
          { text: 'd3', daysAgo: 3 },
        ],
        missions: [
          { id: 'm1', name: 'started one', status: 'In Progress', started: true },
          { id: 'm2', name: 'done one', status: 'Completed', started: true, completed: true },
        ],
        sprints: [
          { id: 's1', title: 'active', status: 'Active' },
          { id: 's2', title: 'done', status: 'Completed' },
        ],
        learnings: [{ content: 'l1', category: 'technical' }],
        identitySnapshots: 2,
      });
      const res = await CmosDatabaseClient.create({ dbPath: project.dbPath, readonly: true });
      expect(res.success).toBe(true);
      const client = res.data!;
      try {
        const c = countStoreWrites(client);
        expect(c.decisions).toBe(3);
        expect(c.decisionsSuperseded).toBe(1);
        expect(c.missions).toBe(2);
        expect(c.missionsStarted).toBe(2);
        expect(c.missionsCompleted).toBe(1);
        expect(c.sprints).toBe(2);
        expect(c.sprintsCompleted).toBe(1);
        expect(c.learnings).toBe(1);
        expect(c.identitySnapshots).toBe(2);
      } finally {
        client.close();
      }
    });
  });

  describe('buildReport (four-query fan-out simulation)', () => {
    let stores: SeededCmosProject[] = [];
    let emptyStore: SeededCmosProject;

    beforeEach(async () => {
      const a = await seedStore({
        projectName: 'store-a',
        decisions: [{ text: 'A decision', daysAgo: 5, evidence: '[{"id":"x"}]' }],
        missions: [{ id: 'a-m01', name: 'Active A', status: 'In Progress', started: true }],
        sprints: [{ id: 'a-s1', title: 'A sprint', status: 'Completed' }],
        learnings: [{ content: 'Learn A', category: 'technical' }],
        identitySnapshots: 1,
      });
      const b = await seedStore({
        projectName: 'store-b',
        decisions: [{ text: 'B decision', daysAgo: 3 }],
        missions: [{ id: 'b-m01', name: 'Active B', status: 'Current' }],
        sprints: [],
        learnings: [{ content: 'Learn B', category: 'process' }],
        identitySnapshots: 0,
      });
      const c = await seedStore({
        projectName: 'store-c',
        decisions: [
          { text: 'C decision', daysAgo: 1, evidence: '[{"id":"y"}]' },
          { text: 'C decision 2', daysAgo: 10, supersededBy: 1 },
        ],
        missions: [],
        sprints: [],
        learnings: [{ content: 'Learn C', category: 'technical' }],
        identitySnapshots: 0,
      });
      stores = [a, b, c];

      // A 4th store that is reachable + opens but has no CMOS tables, to exercise
      // per-query failure isolation.
      emptyStore = await createSeededCmosProject({ projectName: 'empty' }, 'baseline-empty-');
      const edb = new Database(emptyStore.dbPath);
      edb.pragma('journal_mode = WAL');
      edb.exec(
        'DROP TABLE IF EXISTS strategic_decisions; DROP TABLE IF EXISTS missions; DROP TABLE IF EXISTS learnings;'
      );
      edb.close();
    });

    afterEach(async () => {
      await Promise.all([...stores, emptyStore].map((s) => s.cleanup()));
      stores = [];
    });

    function reachableList(): { projectRoot: string; dbPath: string }[] {
      return [...stores, emptyStore].map((s) => ({ projectRoot: s.projectRoot, dbPath: s.dbPath }));
    }

    it('aggregates durable write counts and runs the four named queries across stores', async () => {
      const report = await buildReport(reachableList(), [], 4, materializeDefaultQueries(NOW), {
        now: NOW,
        configSource: 'test',
        runsPerQuery: 3,
      });

      expect(report.schemaVersion).toBe(1);
      expect(report.stores.queried).toBe(4);
      expect(report.stores.reachable).toBe(4);

      // Aggregate durable counts:
      //  append = decisions 4 + learnings 3 + missions 2 + sprints 1 + contextSnapshots 1 = 11
      //  transition = missionsStarted 1 + sprintsCompleted 1 + decisionsSuperseded 1 = 3
      //  soft-lock surface = sprintsCompleted 1 (mission/decision transitions excluded)
      expect(report.mutableWriteShare.overall.appendWrites).toBe(11);
      expect(report.mutableWriteShare.overall.transitionWrites).toBe(3);
      expect(report.mutableWriteShare.softLock.surfaceWrites).toBe(1);

      const byKey = Object.fromEntries(report.fanInLatency.queries.map((q) => [q.key, q]));
      expect(report.fanInLatency.queries).toHaveLength(4);
      // Decisions in last 30d: A1 + B1 + C2 = 4 (all within window). Empty store errors.
      expect(byKey['decisions_last_30d'].resultCount).toBe(4);
      expect(byKey['decisions_last_30d'].storesQueried).toBe(3);
      expect(byKey['decisions_last_30d'].storeErrors).toBe(1);
      // Active missions: A(In Progress) + B(Current) = 2.
      expect(byKey['active_missions'].resultCount).toBe(2);
      // Learnings tagged 'technical': A + C = 2 (B is 'process').
      expect(byKey['learnings_by_tag'].resultCount).toBe(2);
      // Decisions with evidence: A + C(first) = 2 (B and C's superseded one have none).
      expect(byKey['decision_citations'].resultCount).toBe(2);
    });

    it('isolates a store that fails to OPEN into openErrors (custom opener)', async () => {
      const realOpener: StoreOpener = async (dbPath) => {
        const res = await CmosDatabaseClient.create({ dbPath, readonly: true });
        return res.success && res.data
          ? { client: res.data }
          : { error: res.error?.message ?? 'x' };
      };
      const failPath = stores[1].dbPath;
      const opener: StoreOpener = async (dbPath) =>
        dbPath === failPath ? { error: 'simulated open failure' } : realOpener(dbPath);

      const report = await buildReport(reachableList(), [], 4, materializeDefaultQueries(NOW), {
        now: NOW,
        configSource: 'test',
        runsPerQuery: 1,
        openStore: opener,
      });

      expect(report.stores.queried).toBe(3); // 4 reachable - 1 open failure
      expect(report.stores.openErrors).toEqual([
        { projectRoot: stores[1].projectRoot, reason: 'simulated open failure' },
      ]);
    });

    it('produces a structurally stable report across repeated runs', async () => {
      const opts = { now: NOW, configSource: 'test', runsPerQuery: 2 };
      const r1 = await buildReport(reachableList(), [], 4, materializeDefaultQueries(NOW), opts);
      const r2 = await buildReport(reachableList(), [], 4, materializeDefaultQueries(NOW), opts);

      // Zero out the only non-deterministic fields (wall-clock latency) and assert
      // the entire rest of the report — shape AND values — is identical.
      const normalize = (r: typeof r1): unknown => {
        const clone = JSON.parse(JSON.stringify(r));
        clone.meta.durationMs = 0;
        clone.fanInLatency.aggregateP95Ms = 0;
        clone.fanInLatency.status = 'ok';
        for (const q of clone.fanInLatency.queries) {
          q.coldMs = 0;
          q.warmP95Ms = 0;
          q.p95Ms = 0;
          q.status = 'ok';
        }
        return clone;
      };
      expect(normalize(r1)).toEqual(normalize(r2));
    });
  });
});
