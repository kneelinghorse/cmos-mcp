// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m08 — the sprint_summary counting rule and its migration: five row shapes, four
// ABOUTME: store shapes, and a positive fire on a COPY of the real store (never the live one).

/**
 * Sprint 86 m08 Part B.
 *
 * THE DEFECT. `total_missions` was `COUNT(m.id)` over an unfiltered LEFT JOIN, so a sprint that
 * parked work honestly was punished for it: sprint-85 read 9 total / 5 completed = 56% while
 * every mission it actually owned was Completed. Parked work is now excluded from the
 * denominator and reported in its own `parked_missions` column — visible, just not counted
 * against.
 *
 * WHY EACH CLAUSE OF THE DDL GETS ITS OWN ROW SHAPE HERE. The obvious form of this fix is wrong
 * three ways, and each way is silent:
 *
 *   - `COUNT(CASE WHEN m.status NOT IN ('Deferred','Dropped') …)` drops a NULL-status row from
 *     BOTH counts (SQL `NULL NOT IN (…)` and `NULL IN (…)` are both NULL), so the two stop
 *     summing to the row count and nobody notices;
 *   - it also counts a case-drifted 'deferred' as NON-parked — the exact drift the case-folded
 *     helpers exist to prevent;
 *   - and the obvious COALESCE/UPPER repair then reports total_missions = 1 for a sprint with
 *     ZERO missions, because the LEFT JOIN's phantom row coalesces to '' which is NOT IN the
 *     exclusion list.
 *
 * The invariant that catches all three at once — `total + parked = COUNT(m.id)` — is asserted
 * per shape here and across every sprint of a real store below.
 *
 * THE MIGRATION IS TESTED ON STORE SHAPES, NOT JUST ON A FRESH FIXTURE. `CREATE VIEW IF NOT
 * EXISTS` never updates an existing view, so a fresh-fixture-only test would pass while every
 * store in the fleet kept the old rule. The four shapes below are the ones that actually exist:
 * an old view, an already-current view, a same-named base TABLE (this repo's own fixtures do
 * that), and a partial store missing the base tables entirely.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ensureSprintSummaryView } from '../../../src/tools/cmos/schema-migrations';
import { SPRINT_SUMMARY_VIEW_SQL } from '../../../src/tools/cmos/schema';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');

const tmpDirs: string[] = [];
const routedRealStoreCopies: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** The view definition as it stood before s86-m08 — the shape every existing store carries. */
const OLD_VIEW_SQL = `CREATE VIEW IF NOT EXISTS sprint_summary AS
SELECT
  s.id AS sprint_id,
  s.title,
  s.status,
  s.focus,
  s.start_date,
  s.end_date,
  COUNT(m.id) AS total_missions,
  COUNT(CASE WHEN m.status = 'Completed' THEN 1 END) AS completed_missions,
  COUNT(CASE WHEN m.status = 'Blocked' THEN 1 END) AS blocked_missions,
  COUNT(CASE WHEN m.status IN ('Current', 'In Progress') THEN 1 END) AS active_missions,
  (
    SELECT COUNT(DISTINCT sd.id)
    FROM strategic_decisions sd
    WHERE sd.sprint_id = s.id
  ) AS decisions_count
FROM sprints s
LEFT JOIN missions m ON m.sprint_id = s.id
GROUP BY s.id, s.title, s.status, s.focus, s.start_date, s.end_date;`;

const BASE_TABLES = `
  CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT,
    start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
  CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id),
    name TEXT NOT NULL, status TEXT, completed_at TEXT, notes TEXT, started_at TEXT, updated_at TEXT,
    objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT,
    domain_fields TEXT, metadata TEXT, created_at TEXT);
  CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, sprint_id TEXT);
`;

/** A store carrying every status shape the rule has to get right. */
function shapesStore(viewSql: string): string {
  const dir = mkTmp('cmos-m08-shapes-');
  const dbPath = path.join(dir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(BASE_TABLES);
  db.exec(viewSql);
  db.exec(`
    INSERT INTO sprints (id, title, status) VALUES
      ('s-mixed', 'Mixed', 'Completed'),
      ('s-empty', 'No missions at all', 'Completed');
    INSERT INTO missions (id, sprint_id, name, status) VALUES
      ('m1', 's-mixed', 'Completed row',    'Completed'),
      ('m2', 's-mixed', 'Deferred row',     'Deferred'),
      ('m3', 's-mixed', 'NULL status row',  NULL),
      ('m4', 's-mixed', 'case-drifted row', 'deferred'),
      ('m5', 's-mixed', 'Archived row',     'Archived');
  `);
  db.close();
  return dbPath;
}

function readSummary(
  dbPath: string,
  sprintId: string
): { total: number; parked: number; completed: number; rows: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const view = db
      .prepare(
        `SELECT total_missions, parked_missions, completed_missions FROM sprint_summary WHERE sprint_id = ?`
      )
      .get(sprintId) as {
      total_missions: number;
      parked_missions: number;
      completed_missions: number;
    };
    const rows = (
      db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE sprint_id = ?`).get(sprintId) as {
        n: number;
      }
    ).n;
    return {
      total: view.total_missions,
      parked: view.parked_missions,
      completed: view.completed_missions,
      rows,
    };
  } finally {
    db.close();
  }
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── the counting rule ──────────────────────────────────────────────────────

describe('sprint_summary counting rule (s86-m08 Part B)', () => {
  it('counts each status shape the way the rule says, and total + parked = rows', () => {
    const dbPath = shapesStore(SPRINT_SUMMARY_VIEW_SQL);
    const mixed = readSummary(dbPath, 's-mixed');

    // Completed + NULL-status + Archived are work the sprint owned; the two Deferred rows
    // (one of them case-drifted) are parked.
    expect(mixed).toMatchObject({ total: 3, parked: 2, completed: 1, rows: 5 });
    // The invariant that catches a NULL-status row vanishing from both counts.
    expect(mixed.total + mixed.parked).toBe(mixed.rows);
  });

  it('reports 0/0 for a sprint with no missions — not 1, which the naive repair gives', () => {
    const dbPath = shapesStore(SPRINT_SUMMARY_VIEW_SQL);
    expect(readSummary(dbPath, 's-empty')).toMatchObject({ total: 0, parked: 0, rows: 0 });
  });

  it('the OLD rule really did differ — the fix is not a no-op dressed as one', () => {
    const dbPath = shapesStore(OLD_VIEW_SQL);
    const db = new Database(dbPath, { readonly: true });
    try {
      const old = db
        .prepare(`SELECT total_missions FROM sprint_summary WHERE sprint_id = 's-mixed'`)
        .get() as { total_missions: number };
      // Every row counted, parked work included: 5 instead of 3.
      expect(old.total_missions).toBe(5);
      // And the column the new rule adds does not exist at all on the old shape.
      expect(() => db.prepare(`SELECT parked_missions FROM sprint_summary`).get()).toThrow();
    } finally {
      db.close();
    }
  });
});

// ─── the migration, per store shape ─────────────────────────────────────────

describe('ensureSprintSummaryView (s86-m08)', () => {
  async function clientFor(dbPath: string, readonly = false): Promise<CmosDatabaseClient> {
    const created = await CmosDatabaseClient.create({ dbPath, readonly });
    if (!created.success || !created.data) {
      throw new Error(`could not open ${dbPath}: ${created.error?.message ?? 'unknown'}`);
    }
    return created.data;
  }

  it('(a) upgrades a store carrying the OLD view', async () => {
    const dbPath = shapesStore(OLD_VIEW_SQL);
    const client = await clientFor(dbPath);
    try {
      const result = ensureSprintSummaryView(client);
      expect(result.alreadyCurrent).toBe(false);
      expect(result.warnings ?? []).toHaveLength(0);
    } finally {
      client.close();
    }
    // The upgraded store now answers with the new rule.
    expect(readSummary(dbPath, 's-mixed')).toMatchObject({ total: 3, parked: 2 });
  });

  it('(b) is a NO-OP on the second call — a read path must not write forever', async () => {
    const dbPath = shapesStore(OLD_VIEW_SQL);
    const client = await clientFor(dbPath);
    try {
      ensureSprintSummaryView(client);
      const before = new Database(dbPath, { readonly: true });
      const sqlBefore = (
        before.prepare(`SELECT sql FROM sqlite_master WHERE name='sprint_summary'`).get() as {
          sql: string;
        }
      ).sql;
      before.close();

      const second = ensureSprintSummaryView(client);
      expect(second.alreadyCurrent).toBe(true);

      const after = new Database(dbPath, { readonly: true });
      const sqlAfter = (
        after.prepare(`SELECT sql FROM sqlite_master WHERE name='sprint_summary'`).get() as {
          sql: string;
        }
      ).sql;
      after.close();
      expect(sqlAfter).toBe(sqlBefore);
    } finally {
      client.close();
    }
  });

  it('(c) leaves a same-named base TABLE completely alone, and says so', async () => {
    const dir = mkTmp('cmos-m08-table-');
    const dbPath = path.join(dir, 'cmos.sqlite');
    const db = new Database(dbPath);
    db.exec(BASE_TABLES);
    db.exec(`CREATE TABLE sprint_summary (sprint_id TEXT PRIMARY KEY, total_missions INTEGER);`);
    db.prepare(`INSERT INTO sprint_summary VALUES ('s-1', 42)`).run();
    db.close();

    const client = await clientFor(dbPath);
    try {
      const result = ensureSprintSummaryView(client);
      // Never silently: a shape it cannot upgrade is disclosed, not swallowed.
      expect(result.warnings?.join(' ')).toContain('not a view');
    } finally {
      client.close();
    }

    const after = new Database(dbPath, { readonly: true });
    try {
      const row = after
        .prepare(`SELECT type FROM sqlite_master WHERE name='sprint_summary'`)
        .get() as { type: string };
      expect(row.type).toBe('table');
      // And its DATA survives — dropping a user's base table on a READ path would be a
      // data-loss event, which is why the branch exists at all.
      expect(
        (
          after.prepare(`SELECT total_missions FROM sprint_summary`).get() as {
            total_missions: number;
          }
        ).total_missions
      ).toBe(42);
    } finally {
      after.close();
    }
  });

  it('(d) does not throw on a partial store whose base tables are absent', async () => {
    const dir = mkTmp('cmos-m08-partial-');
    const dbPath = path.join(dir, 'cmos.sqlite');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);`);
    db.close();

    const client = await clientFor(dbPath);
    try {
      // SQLite permits CREATE VIEW over tables that do not exist — the error surfaces at query
      // time, not definition time — so a foreign/partial fleet store is safe to touch.
      expect(() => ensureSprintSummaryView(client)).not.toThrow();
    } finally {
      client.close();
    }
  });

  it('(e) on a READ-ONLY store, surfaces the stale view instead of throwing or lying', async () => {
    const dbPath = shapesStore(OLD_VIEW_SQL);
    // s87-m03 (#535) — THE WORKAROUND THAT USED TO BE HERE IS GONE, and its removal is the proof.
    // This test used to pre-open the store and set `journal_mode = WAL` by hand, with a comment
    // explaining why: `ensureConnection` issued that pragma UNCONDITIONALLY, the pragma is itself
    // a write, and on a delete-mode store it therefore failed the OPEN before any migration could
    // run. The comment filed it as a next-step and worked around it. The guard now reads the
    // journal mode first and only writes it on a writable connection whose mode differs, so a
    // delete-mode store opens read-only on its own — and this leg proves it by no longer helping.
    const client = await clientFor(dbPath, true);
    try {
      const result = ensureSprintSummaryView(client);
      expect(result.alreadyCurrent).toBe(false);
      // The operator is told their totals are the OLD rule rather than being handed a number
      // that quietly means something else — and nothing throws.
      expect(result.warnings?.join(' ')).toMatch(/stale|could not/i);
    } finally {
      client.close();
    }

    // The read-only store was NOT modified.
    const after = new Database(dbPath, { readonly: true });
    try {
      const row = after
        .prepare(`SELECT sql FROM sqlite_master WHERE name='sprint_summary'`)
        .get() as { sql: string };
      expect(row.sql).not.toContain('parked_missions');
    } finally {
      after.close();
    }
  });
});

// ─── the positive fire, on a COPY of the real store ─────────────────────────

describe('real-store fire: an EXISTING store upgrades and stays consistent (s86-m08)', () => {
  let copyPath: string;

  beforeAll(() => {
    if (!fs.existsSync(LIVE_DB)) {
      throw new Error(
        `live store not found at ${LIVE_DB}. This fire test must not skip: a mock-client test ` +
          `cannot catch a wrong-column/wrong-table SQL bug, which is the whole reason the gate exists.`
      );
    }
    // A COPY under os.tmpdir(), never the live path — the real-store guard refuses it under Jest,
    // and this suite must never be the reason the operator's store changes.
    const dir = mkTmp('cmos-m08-realstore-');
    copyPath = path.join(dir, 'cmos.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${LIVE_DB}${suffix}`;
      if (fs.existsSync(src)) fs.copyFileSync(src, `${copyPath}${suffix}`);
    }
    routedRealStoreCopies.push(copyPath);
    // Reset the COPY to the pre-m08 view. The rows are why this test wants the real store; the
    // stale view is a precondition it must ESTABLISH, not inherit. Inheriting it made the test a
    // hostage to a mutable tracked artifact: the live store carried the old view until the s86
    // close committed one that had already migrated, and the precondition then failed forever —
    // on a fresh clone and in CI, unclearable by re-running. This is the same trap the
    // private-copy routing assertion below already defused for itself.
    const reset = new Database(copyPath);
    reset.exec(`DROP VIEW IF EXISTS sprint_summary;`);
    reset.exec(OLD_VIEW_SQL);
    reset.close();
  });

  it('carries the OLD view before the migration runs', () => {
    const db = new Database(copyPath, { readonly: true });
    try {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name='sprint_summary'`).get() as {
        sql: string;
      };
      // Proves the fire below is a genuine upgrade and not a fresh-store tautology.
      expect(row.sql).toContain('COUNT(m.id) AS total_missions');
      expect(row.sql).not.toContain('parked_missions');
    } finally {
      db.close();
    }
  });

  it('upgrades on a read, and every sprint then satisfies total + parked = rows', async () => {
    const created = await CmosDatabaseClient.create({ dbPath: copyPath });
    expect(created.success).toBe(true);
    const client = created.data!;
    try {
      ensureSprintSummaryView(client);
    } finally {
      client.close();
    }

    const db = new Database(copyPath, { readonly: true });
    try {
      const violations = db
        .prepare(
          `SELECT v.sprint_id
             FROM sprint_summary v
             JOIN (SELECT s.id AS sid, COUNT(m.id) AS n
                     FROM sprints s LEFT JOIN missions m ON m.sprint_id = s.id
                    GROUP BY s.id) c ON c.sid = v.sprint_id
            WHERE v.total_missions + v.parked_missions <> c.n`
        )
        .all() as Array<{ sprint_id: string }>;
      expect(violations).toEqual([]);

      // The sprints whose totals MOVE, asserted as an exact SET. The earlier form — "every row
      // WHERE parked > 0 has parked > 0" — could not fail; this one goes red if the counting
      // rule ever starts excluding a different status.
      const moved = db
        .prepare(
          `SELECT sprint_id, total_missions, parked_missions FROM sprint_summary
                   WHERE parked_missions > 0 ORDER BY sprint_id`
        )
        .all() as Array<{ sprint_id: string; total_missions: number; parked_missions: number }>;
      expect(moved).toEqual([
        { sprint_id: 'sprint-54', total_missions: 3, parked_missions: 2 },
        { sprint_id: 'sprint-79', total_missions: 6, parked_missions: 1 },
        { sprint_id: 'sprint-85', total_missions: 5, parked_missions: 4 },
      ]);
    } finally {
      db.close();
    }
  });

  it('sprint-85 reads 5 total / 5 completed / 4 parked — 100%, with the parked work shown', () => {
    const db = new Database(copyPath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT total_missions, completed_missions, parked_missions
             FROM sprint_summary WHERE sprint_id = 'sprint-85'`
        )
        .get() as {
        total_missions: number;
        completed_missions: number;
        parked_missions: number;
      };
      // The number the whole mission exists for: 9/5 = 56% becomes 5/5 = 100%, and the four
      // dropped missions stay bound to the sprint that dropped them, surfaced as parked.
      expect(row).toEqual({ total_missions: 5, completed_missions: 5, parked_missions: 4 });
    } finally {
      db.close();
    }
  });
});

// ─── why the BINDING fix is load-bearing, not just the denominator ──────────

/**
 * The denominator fix alone would have been a half-answer, and these two legs are how we know.
 *
 * Leg 1: parked work stays bound to the sprint that parked it, so completing the RE-CREATED
 * missions must move only the sprint that actually did them. If the four dropped rows still
 * counted, sprint-85's numerator would drift upward for work it did not do.
 *
 * Leg 2: a mission bound to the WRONG sprint corrupts provenance, not just a percentage.
 * `resolveCurrentSprintId` step 1 answers with the sprint of any In Progress mission, so the
 * binding decides which sprint the system believes is current — and therefore which sprint_id
 * gets stamped on everything captured in that session.
 */
describe('the binding, not just the denominator (s86-m08)', () => {
  let copyPath: string;

  beforeAll(() => {
    const dir = mkTmp('cmos-m08-binding-');
    copyPath = path.join(dir, 'cmos.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${LIVE_DB}${suffix}`;
      if (fs.existsSync(src)) fs.copyFileSync(src, `${copyPath}${suffix}`);
    }
    routedRealStoreCopies.push(copyPath);
    // Set the copy to the CURRENT view, the way a reader's first call would, then work on it.
    // Stated as an action rather than as a claim about what the copy arrived carrying: the
    // tracked store's own view has changed once already (see the beforeAll above).
    const db = new Database(copyPath);
    db.exec('DROP VIEW IF EXISTS sprint_summary;');
    db.exec(SPRINT_SUMMARY_VIEW_SQL);
    db.close();
  });

  function summary(sprintId: string): { total: number; completed: number; parked: number } {
    const db = new Database(copyPath, { readonly: true });
    try {
      const r = db
        .prepare(
          `SELECT total_missions, completed_missions, parked_missions FROM sprint_summary WHERE sprint_id = ?`
        )
        .get(sprintId) as {
        total_missions: number;
        completed_missions: number;
        parked_missions: number;
      };
      return {
        total: r.total_missions,
        completed: r.completed_missions,
        parked: r.parked_missions,
      };
    } finally {
      db.close();
    }
  }

  it('completing the re-created missions moves ONLY the sprint that did them', () => {
    const before85 = summary('sprint-85');
    expect(before85).toEqual({ total: 5, completed: 5, parked: 4 });

    // Complete every still-open sprint-86 mission on the copy.
    const db = new Database(copyPath);
    db.prepare(
      `UPDATE missions SET status = 'Completed' WHERE sprint_id = 'sprint-86' AND status <> 'Completed'`
    ).run();
    db.close();

    // sprint-85 is untouched: the four dropped rows are ITS parked work and stay that way.
    expect(summary('sprint-85')).toEqual(before85);

    const after86 = summary('sprint-86');
    expect(after86.completed).toBe(after86.total);
    expect(after86.total).toBeGreaterThan(0);
  });

  it('the sprint a mission is BOUND to is the sprint the system calls current', async () => {
    // Park every mission, then make exactly one In Progress on sprint-86.
    const db = new Database(copyPath);
    db.prepare(`UPDATE missions SET status = 'Completed' WHERE status = 'In Progress'`).run();
    db.prepare(
      `UPDATE missions SET status = 'In Progress' WHERE id = (SELECT id FROM missions WHERE sprint_id = 'sprint-86' LIMIT 1)`
    ).run();
    db.close();

    const created = await CmosDatabaseClient.create({ dbPath: copyPath });
    expect(created.success).toBe(true);
    const client = created.data!;
    try {
      const { resolveCurrentSprintId } = await import('../../../src/tools/cmos/current-sprint');
      // Step 1 of the resolver answers from the mission's BINDING. Had that mission still been
      // bound to a closed sprint, the closed sprint would be "current" — and every decision
      // captured in the session would carry its id.
      expect(resolveCurrentSprintId(client)).toBe('sprint-86');
    } finally {
      client.close();
    }
  });

  it('a CLOSED sprint really would win that resolution — which is what move exists to prevent', async () => {
    const db = new Database(copyPath);
    db.prepare(`UPDATE missions SET status = 'Completed' WHERE status = 'In Progress'`).run();
    // Re-bind the same mission to a Completed sprint, the exact state the move action refuses
    // to create. 'Completed' is NOT in the resolver's excluded set.
    db.prepare(
      `UPDATE missions SET sprint_id = 'sprint-85', status = 'In Progress'
        WHERE id = (SELECT id FROM missions WHERE sprint_id = 'sprint-86' LIMIT 1)`
    ).run();
    db.close();

    const created = await CmosDatabaseClient.create({ dbPath: copyPath });
    const client = created.data!;
    try {
      const { resolveCurrentSprintId } = await import('../../../src/tools/cmos/current-sprint');
      const resolved = resolveCurrentSprintId(client);
      // The harm, demonstrated rather than asserted: a CLOSED sprint becomes "current".
      expect(resolved).toBe('sprint-85');
    } finally {
      client.close();
    }
  });
});

// ─── the degradation path: a store the migration REFUSES to fix still answers ───

/**
 * The critic's blocking finding, pinned. `ensureSprintSummaryView` is documented as allowed to
 * fail — it leaves a same-named base table alone, cannot write to a read-only store, and its
 * DROP can lose a race for the write lock. The first cut of this mission then had all three
 * readers SELECT `parked_missions` unconditionally, so on exactly those stores
 * `cmos_sprint(list|show)` stopped answering at all: a REGRESSION, since they answered fine
 * before the column existed. Worse, the migration's warning — the one fact that explains the
 * failure — was dropped on the error path.
 */
describe('a store the migration cannot upgrade still gets an answer (s86-m08 critic)', () => {
  /** A project ROOT (not a bare db path) so the detector resolves it the way a real call does. */
  function tableShapedStore(): string {
    const projectRoot = mkTmp('cmos-m08-degrade-');
    const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(BASE_TABLES);
    // The shape this repo's own fixtures create, and the one the migration protects.
    db.exec(`CREATE TABLE sprint_summary (
      sprint_id TEXT PRIMARY KEY, title TEXT, status TEXT, focus TEXT,
      start_date TEXT, end_date TEXT,
      total_missions INTEGER DEFAULT 0, completed_missions INTEGER DEFAULT 0,
      blocked_missions INTEGER DEFAULT 0, active_missions INTEGER DEFAULT 0,
      decisions_count INTEGER DEFAULT 0
    );`);
    db.prepare(
      `INSERT INTO sprint_summary (sprint_id, title, status, total_missions, completed_missions)
       VALUES ('sprint-legacy', 'Legacy shape', 'Completed', 7, 5)`
    ).run();
    db.close();
    return projectRoot;
  }

  it('cmos_sprint(list) ANSWERS, reports parked as 0, and says why', async () => {
    const projectRoot = tableShapedStore();
    CmosDetector.resetInstance();
    const { cmosSprintList } = await import('../../../src/tools/cmos/cmos-sprint-list');
    const result = await cmosSprintList({ projectRoot });

    // Before the fix this was a bare DB_SCHEMA_MISMATCH with no explanation.
    expect(result.success).toBe(true);
    const sprint = result.data!.sprints.find((s) => s.id === 'sprint-legacy')!;
    expect(sprint.totalMissions).toBe(7);
    expect(sprint.parkedMissions).toBe(0);
    // The zero is disclosed as a zero we cannot vouch for, not presented as a measurement.
    expect(result.warnings?.join(' ')).toContain('not a view');
  });

  it('cmos_sprint(show) ANSWERS on the same store', async () => {
    const projectRoot = tableShapedStore();
    CmosDetector.resetInstance();
    const { cmosSprintShow } = await import('../../../src/tools/cmos/cmos-sprint-show');
    const result = await cmosSprintShow({ sprintId: 'sprint-legacy', projectRoot });

    expect(result.success).toBe(true);
    expect(result.data!.parkedMissions).toBe(0);
    expect(result.warnings?.join(' ')).toContain('not a view');
  });

  it('cmos_sprint(analytics) never reports "no completed sprints" for a store it could not read', async () => {
    const projectRoot = mkTmp('cmos-m08-unreadable-');
    const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(BASE_TABLES);
    // A base table MISSING the columns analytics selects: the read will fail, not return zero rows.
    db.exec(`CREATE TABLE sprint_summary (sprint_id TEXT PRIMARY KEY, title TEXT);`);
    db.prepare(`INSERT INTO sprint_summary VALUES ('sprint-x', 'X')`).run();
    db.close();

    CmosDetector.resetInstance();
    const { cmosSprintAnalytics } = await import('../../../src/tools/cmos/cmos-sprint-analytics');
    const result = await cmosSprintAnalytics({ projectRoot });

    // An unreadable store and an empty one are different facts; the answer must not confuse them.
    const text = JSON.stringify(result.data?.highlights ?? []);
    expect(text).not.toContain('No completed sprints found for analysis.');
    expect(result.warnings?.join(' ')).toMatch(/could not be read/i);
  });
});

describe('s88-m03 — real-store-derived writes stay on suite-private copies', () => {
  it('routes both real-store mutation scenarios away from the shared live file', () => {
    expect(routedRealStoreCopies).toHaveLength(2);
    expect(
      routedRealStoreCopies.every(
        (dbPath) =>
          path.resolve(dbPath) !== path.resolve(LIVE_DB) &&
          tmpDirs.some((dir) => path.resolve(dbPath).startsWith(`${path.resolve(dir)}${path.sep}`))
      )
    ).toBe(true);
  });
});
