// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m03 REAL-STORE positive fires — the four newly-reachable params proven by raw
// ABOUTME: SELECT read-back on a tmpdir COPY of the live cmos.sqlite, never on a fixture alone.

/**
 * Sprint 86 m03 — the standing gate's real-store half (agents.md Process Hardening #4,
 * decision #926 #3).
 *
 * WHY A FIXTURE IS NOT ENOUGH, measured rather than asserted. All four capabilities this mission
 * makes reachable are gated on a DB column or query — `learnings.evergreen`,
 * `constraints.expires_at`, an `agent_feedback` row, and a status-filtered FTS query. A seeded
 * fixture is provably not a real store even after s86-m01's Step 5: `src/tools/cmos/schema.ts`
 * declares SIX foreign keys on `strategic_decisions` while the live store carries THREE, and the
 * live `master_context` and `project_context` rows carry an EMPTY `source_path` where init writes
 * one (`project_identity`, the third row, does carry its path). s80-m07 shipped a
 * `deleted_at` predicate against a column that exists in no schema, dead on arrival, through
 * exactly this gap. So a green fixture test is not evidence.
 *
 * WHY THE READ-BACK IS RAW SQL AND NOT THE RESPONSE. Asserting on the tool's own response passes
 * against the very bug this mission fixes: before m03 the reaffirm router dropped `evergreen`, the
 * handler never saw it, and the call returned `success: true` with nothing written. Only
 * `SELECT evergreen FROM learnings WHERE id = ?` can tell those two worlds apart.
 *
 * WHY EACH FIRE DRIVES THE ROUTER, NOT THE HANDLER. A handler-only test is what let `statusFilter`,
 * `expiresAt` and `agentFeedback` all ship dead — the handlers accepted them the whole time.
 * Every fire below enters through the consolidated router (`cmosLearnings`, `cmosContext`,
 * `cmosSession`) so deleting a forwarding line turns it red.
 *
 * NEVER AGAINST THE LIVE FILE. Every fire runs on an `mkdtempSync` copy, and the final test
 * asserts the live store's mtime and byte size are unchanged by this run.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cmosLearnings } from '../../../src/tools/cmos/cmos-learnings';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Copy the live store into a temp project root. The live file is never opened for writing. */
function copyLiveStore(): { projectRoot: string; dbPath: string } {
  const projectRoot = mkTmp('cmos-m03-realstore-');
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${LIVE_DB}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `cmos.sqlite${suffix}`));
  }
  return { projectRoot, dbPath: path.join(dbDir, 'cmos.sqlite') };
}

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Insert an active session so capture/complete have somewhere to land. Schema-aware like m02b's. */
function seedActiveSession(dbPath: string, sessionId: string): void {
  withDb(dbPath, (db) => {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    const names = ['id', 'type', 'title', 'sprint_id', 'started_at', 'agent', 'status', 'captures'];
    const values: unknown[] = [
      sessionId,
      'build',
      'm03 real-store fire',
      null,
      new Date().toISOString(),
      'jest',
      'active',
      '[]',
    ];
    if (columns.has('project_id')) {
      const projectId =
        (
          db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
            | { value: string }
            | undefined
        )?.value ?? 'test-project';
      names.push(
        'project_id',
        'stable_event_id',
        'occurred_at',
        'origin_seq',
        'event_type',
        'schema_version'
      );
      values.push(
        projectId,
        `TEST${sessionId.replace(/\D/g, '')}`.padEnd(26, '0'),
        Date.now(),
        1,
        'session_started',
        1
      );
    }
    db.prepare(
      `INSERT INTO sessions (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    ).run(...values);
  });
}

let live = false;
let liveStat: { size: number; mtimeMs: number } | undefined;

beforeAll(() => {
  live = fs.existsSync(LIVE_DB);
  if (live) {
    const s = fs.statSync(LIVE_DB);
    liveStat = { size: s.size, mtimeMs: s.mtimeMs };
  }
});

describe('s86-m03 real-store fires: the four params reach the database (tmpdir copy)', () => {
  it('FIRE 1 — reaffirm(evergreen=true) writes the column; false clears it; omitted leaves it byte-identical', async () => {
    if (!live) return; // the live store is absent in a clean checkout; the fixture suites still gate
    const { projectRoot, dbPath } = copyLiveStore();

    const baseline = withDb(dbPath, (db) =>
      db.prepare('SELECT COUNT(*) AS total, SUM(evergreen = 1) AS ever FROM learnings').get()
    ) as { total: number; ever: number };
    // Recorded so a future reader can tell a real corpus from a fixture at a glance.
    expect(baseline.total).toBeGreaterThan(100);

    const target = withDb(dbPath, (db) =>
      db.prepare('SELECT id FROM learnings WHERE evergreen = 0 ORDER BY id LIMIT 1').get()
    ) as { id: number } | undefined;
    expect(target).toBeDefined();
    const id = target!.id;

    const readEvergreen = () =>
      (
        withDb(dbPath, (db) =>
          db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(id)
        ) as { evergreen: number }
      ).evergreen;
    const readReviewedAt = () =>
      (
        withDb(dbPath, (db) =>
          db.prepare('SELECT last_reviewed_at FROM learnings WHERE id = ?').get(id)
        ) as { last_reviewed_at: string | null }
      ).last_reviewed_at;

    expect(readEvergreen()).toBe(0);

    // true → 1, through the ROUTER. Deleting `evergreen: params.evergreen` from
    // cmos-learnings.ts's reaffirm literal fails exactly here.
    const setTrue = await cmosLearnings({
      action: 'reaffirm',
      learningId: id,
      evergreen: true,
      projectRoot,
    });
    expect(setTrue.success).toBe(true);
    expect(readEvergreen()).toBe(1);
    // The response pair is derived by `=== 1`, never a truthy cast, so it is a real boolean.
    const d1 = setTrue.data as unknown as { previousEvergreen: boolean; newEvergreen: boolean };
    expect(d1.previousEvergreen).toBe(false);
    expect(d1.newEvergreen).toBe(true);

    // false → 0.
    const setFalse = await cmosLearnings({
      action: 'reaffirm',
      learningId: id,
      evergreen: false,
      projectRoot,
    });
    expect(setFalse.success).toBe(true);
    expect(readEvergreen()).toBe(0);
    const d2 = setFalse.data as unknown as { previousEvergreen: boolean; newEvergreen: boolean };
    expect(d2.previousEvergreen).toBe(true);
    expect(d2.newEvergreen).toBe(false);

    // Omitted → BYTE-IDENTICAL. This is the arm that proves the conditional UPDATE: a handler that
    // always wrote `evergreen = ?` would clobber the flag on every plain reaffirm.
    withDb(dbPath, (db) => db.prepare('UPDATE learnings SET evergreen = 1 WHERE id = ?').run(id));
    const before = readEvergreen();
    const reviewedBefore = readReviewedAt();
    const omitted = await cmosLearnings({ action: 'reaffirm', learningId: id, projectRoot });
    expect(omitted.success).toBe(true);
    expect(readEvergreen()).toBe(before);
    // …and the Sprint-52 behaviour is intact: the review clock still moved.
    expect(readReviewedAt()).not.toBe(reviewedBefore);
  }, 60_000);

  it('FIRE 2 — statusFilter=["superseded"] recalls a decision the default ["active"] search cannot', async () => {
    if (!live) return;
    const { projectRoot, dbPath } = copyLiveStore();

    const counts = withDb(dbPath, (db) =>
      db.prepare('SELECT status, COUNT(*) AS n FROM strategic_decisions GROUP BY status').all()
    ) as Array<{ status: string; n: number }>;
    const superseded = counts.find((c) => c.status === 'superseded')?.n ?? 0;
    expect(superseded).toBeGreaterThan(0);

    // Derive the probe term from the copy rather than hardcoding one: pick a superseded decision
    // and a distinctive word from it that NO non-superseded row contains. A hardcoded term would
    // rot the first time the corpus changed, and this assertion is about recall, not vocabulary.
    const candidates = withDb(dbPath, (db) =>
      db
        .prepare(`SELECT id, decision_text FROM strategic_decisions WHERE status = 'superseded'`)
        .all()
    ) as Array<{ id: number; decision_text: string }>;

    let term: string | undefined;
    for (const row of candidates) {
      const words = [...new Set(row.decision_text.match(/[A-Za-z]{7,}/g) ?? [])];
      for (const w of words) {
        const other = withDb(dbPath, (db) =>
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM strategic_decisions
               WHERE status != 'superseded' AND decision_text LIKE ?`
            )
            .get(`%${w}%`)
        ) as { n: number };
        if (other.n === 0) {
          term = w;
          break;
        }
      }
      if (term) break;
    }
    expect(term).toBeDefined();

    const search = (statusFilter?: string[]) =>
      cmosContext({
        action: 'search',
        query: term!,
        searchTypes: ['decision'],
        searchLimit: 25,
        ...(statusFilter ? { statusFilter } : {}),
        projectRoot,
      });

    const withoutFilter = await search();
    expect(withoutFilter.success).toBe(true);
    const defaulted = withoutFilter.data as unknown as {
      results: Array<{ id?: string | number }>;
      options: { statusFilter: string[] };
    };
    // The ['active'] default survives — this is the pre-m03 world, and it is still the default.
    expect(defaulted.options.statusFilter).toEqual(['active']);
    expect(defaulted.results.length).toBe(0);

    // With the filter the same query reaches the superseded corpus. Before m03 this was
    // unreachable from any caller: the handler supported it, the router declared nothing.
    const withFilter = await search(['superseded']);
    expect(withFilter.success).toBe(true);
    const filtered = withFilter.data as unknown as {
      results: Array<{ id?: string | number }>;
      options: { statusFilter: string[] };
    };
    expect(filtered.options.statusFilter).toEqual(['superseded']);
    expect(filtered.results.length).toBeGreaterThan(0);
  }, 60_000);

  it('FIRE 3 — expiresAt reaches constraints.expires_at through BOTH write paths', async () => {
    if (!live) return;
    const { projectRoot, dbPath } = copyLiveStore();

    const baseline = withDb(dbPath, (db) =>
      db
        .prepare('SELECT COUNT(*) AS total, SUM(expires_at IS NOT NULL) AS dated FROM constraints')
        .get()
    ) as { total: number; dated: number | null };
    // Live baseline: constraints exist, none of them carries an expiry — because no caller could
    // set one. Nothing is backfilled; these fires only prove the path is now open.
    expect(baseline.dated ?? 0).toBe(0);

    const EXPIRY_A = '2027-01-15T00:00:00.000Z';
    const EXPIRY_B = '2027-06-30T00:00:00.000Z';

    // PATH 1 — the DIRECT write at capture time.
    const s1 = 'PS-2099-01-01-901';
    seedActiveSession(dbPath, s1);
    const direct = await cmosSession({
      action: 'capture',
      sessionId: s1,
      category: 'constraint',
      content: 'm03 fire: direct constraint write with an expiry',
      expiresAt: EXPIRY_A,
      projectRoot,
    });
    expect(direct.success).toBe(true);
    const directRow = withDb(dbPath, (db) =>
      db
        .prepare(
          `SELECT expires_at FROM constraints WHERE content LIKE '%direct constraint write%'`
        )
        .get()
    ) as { expires_at: string | null } | undefined;
    expect(directRow?.expires_at).toBe(EXPIRY_A);

    // PATH 2 — the SESSION-COMPLETE extraction, a SECOND and INDEPENDENT drop. cmos-session-capture
    // never persisted `expiresAt` onto the stored capture blob, so cmos-session-complete's
    // `(capture as {expiresAt?: string}).expiresAt` was permanently undefined. Forwarding the
    // router param alone makes PATH 1 pass while this stays dead — which is exactly why both
    // paths are asserted separately rather than one standing in for the other.
    const s2 = 'PS-2099-01-01-902';
    seedActiveSession(dbPath, s2);
    const captured = await cmosSession({
      action: 'capture',
      sessionId: s2,
      category: 'constraint',
      content: 'm03 fire: extracted at session close with an expiry',
      expiresAt: EXPIRY_B,
      projectRoot,
    });
    expect(captured.success).toBe(true);

    // The blob itself must carry it, or the extraction has nothing to read.
    const blob = withDb(dbPath, (db) =>
      db.prepare('SELECT captures FROM sessions WHERE id = ?').get(s2)
    ) as { captures: string };
    const parsed = JSON.parse(blob.captures) as Array<{ expiresAt?: string }>;
    expect(parsed.some((c) => c.expiresAt === EXPIRY_B)).toBe(true);

    const completed = await cmosSession({
      action: 'complete',
      sessionId: s2,
      summary: 'm03 fire: close the session so the constraint is extracted',
      projectRoot,
    });
    expect(completed.success).toBe(true);

    const extracted = withDb(dbPath, (db) =>
      db
        .prepare(
          `SELECT expires_at FROM constraints WHERE content LIKE '%extracted at session close%'`
        )
        .all()
    ) as Array<{ expires_at: string | null }>;
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted.some((r) => r.expires_at === EXPIRY_B)).toBe(true);
  }, 60_000);

  it("FIRE 4 — agentFeedback files an agent_feedback row whose tool_name is exactly 'cmos_session'", async () => {
    if (!live) return;
    const { projectRoot, dbPath } = copyLiveStore();

    const before = withDb(dbPath, (db) =>
      db.prepare('SELECT tool_name, COUNT(*) AS n FROM agent_feedback GROUP BY tool_name').all()
    ) as Array<{ tool_name: string; n: number }>;
    // Live baseline: every existing row came from cmos_mission_transition, because the session
    // surface was declared in the docs and unreachable in fact.
    expect(before.every((r) => r.tool_name === 'cmos_mission_transition')).toBe(true);
    expect(before.some((r) => r.tool_name === 'cmos_session')).toBe(false);

    const sid = 'PS-2099-01-01-903';
    seedActiveSession(dbPath, sid);
    const result = await cmosSession({
      action: 'complete',
      sessionId: sid,
      summary: 'm03 fire: close a session carrying agent feedback',
      agentFeedback: 'm03 fire: the session surface can finally write to this channel.',
      projectRoot,
    });
    expect(result.success).toBe(true);

    const rows = withDb(dbPath, (db) =>
      db.prepare(`SELECT tool_name, body FROM agent_feedback WHERE body LIKE '%m03 fire%'`).all()
    ) as Array<{ tool_name: string; body: string }>;
    expect(rows).toHaveLength(1);
    // EXACTLY the registered name. It was hardcoded 'cmos_session_complete' — a tool the server no
    // longer publishes — so merely forwarding the param would have filed a durable row stamped
    // with a retired tool: this sprint's defect class inside its own fix.
    expect(rows[0].tool_name).toBe('cmos_session');
  }, 60_000);

  it('FIRE 5 — UN-MIGRATED STORE: reaffirm(evergreen) succeeds where the evergreen column does not exist', async () => {
    if (!live) return;
    const { projectRoot, dbPath } = copyLiveStore();

    // Reproduce a store predating s61-m03 by dropping the column from a SECOND copy. The index
    // goes first — SQLite refuses to drop a column an index still references, and s61-m03's
    // migration created both together, so a pre-s61 store has neither.
    withDb(dbPath, (db) => {
      db.exec('DROP INDEX IF EXISTS idx_learnings_evergreen');
      db.exec('ALTER TABLE learnings DROP COLUMN evergreen');
    });
    const columnsBefore = withDb(dbPath, (db) =>
      (db.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    expect(columnsBefore).not.toContain('evergreen');

    const id = (
      withDb(dbPath, (db) => db.prepare('SELECT id FROM learnings ORDER BY id LIMIT 1').get()) as {
        id: number;
      }
    ).id;

    // Without `ensureLearningsTable(client)` beside the reaffirm handler's existing
    // `ensureReviewTimestamps(client)`, this throws `no such column: evergreen`. The two columns
    // are created by DIFFERENT migrations, which is the trap this leg exists to catch.
    const result = await cmosLearnings({
      action: 'reaffirm',
      learningId: id,
      evergreen: true,
      projectRoot,
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`reaffirm failed on un-migrated store: ${JSON.stringify(result.error)}`);
    }

    const columnsAfter = withDb(dbPath, (db) =>
      (db.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    expect(columnsAfter).toContain('evergreen');
    const written = withDb(dbPath, (db) =>
      db.prepare('SELECT evergreen FROM learnings WHERE id = ?').get(id)
    ) as { evergreen: number };
    expect(written.evergreen).toBe(1);
  }, 60_000);

  it('the LIVE store was never written to by this suite', () => {
    if (!live) return;
    const now = fs.statSync(LIVE_DB);
    expect(now.size).toBe(liveStat!.size);
    expect(now.mtimeMs).toBe(liveStat!.mtimeMs);
  });
});
