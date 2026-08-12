// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m05 REAL-STORE positive fire — cmos_sprint(analytics, limit=N) must return the
// ABOUTME: NEWEST N sprints, on a tmpdir COPY of the live cmos.sqlite, and must not move a trend.

/**
 * Sprint 86 m05 — the analytics window, proven where it actually runs.
 *
 * THE DEFECT (next-step #514). `getSprintDataPoints` built `ORDER BY sprint_id ASC
 * ${limitClause}`, so `cmos_sprint(action="analytics", limit=N)` returned the OLDEST N sprints
 * while the highlights it generated described them as "across recent sprints". This is not a
 * stale number — it is a wrong-direction one. Measured on the live store: `limit=8` reported
 * velocity trending DOWN 44% where the unlimited call reports stable +8%.
 *
 * WHY A REAL STORE AND NOT A FIXTURE (agents.md Process Hardening #4, decision #926 #3).
 * The fix is gated on a DB query against the `sprint_summary` VIEW, and tests/helpers/seedCmosDb
 * says in its own header that it is not a real store: it applies CMOS_SCHEMA, which declares six
 * FKs on strategic_decisions where the live store carries three, and it writes contexts
 * source_path values the live store's rows do not carry. A fixture proves the ordering logic; it
 * cannot prove the view exists with these columns in a store that has been migrated across 86
 * sprints. So the window assertion runs against a COPY of cmos/db/cmos.sqlite.
 *
 * THE LIVE STORE'S MEASURED SHAPE (2026-08-12, this machine):
 *   sprint_summary holds 78 rows, 77 matching `status IN ('Completed','Active')`,
 *   spanning sprint-09 … sprint-86.
 *   `ORDER BY sprint_id ASC  LIMIT 5` → sprint-09, -10, -11, -12, -13   ← the defect
 *   `ORDER BY sprint_id DESC LIMIT 5` → sprint-86, -85, -84, -83, -82   ← the window we want
 * DELTA AGAINST THE BUILD PLAN, recorded per its standing instruction: the plan states 76 rows
 * match the filter; the measured count is 77. The plan's figure was taken before sprint-86 was
 * set Active, and Active is inside the filter. Nothing downstream depends on the exact count —
 * both the plan's assertion and this one are about WHICH ids come back, and those are unchanged.
 *
 * THE OTHER HALF — over stdio against the built dist/ — lives in
 * tests/e2e/analytics-window.e2e.ts, because the default `npm test` CI job does not build dist/.
 * Neither substitutes for the other: this file proves the SQL matches a real store's columns,
 * that one proves the `limit` param survives the MCP dispatch boundary.
 *
 * NEVER AGAINST THE LIVE FILE. Everything below runs on an `mkdtempSync` copy.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cmosSprintAnalytics } from '../../../src/tools/cmos/cmos-sprint-analytics';
import { seedCmosDb } from '../../helpers/seedCmosDb';

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
function copyLiveStore(): string {
  const projectRoot = mkTmp('cmos-m05-analytics-');
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${LIVE_DB}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `cmos.sqlite${suffix}`));
  }
  return projectRoot;
}

describe('analytics window — real-store positive fire (s86-m05)', () => {
  // NO SILENT FAIL-OPEN (agents.md Process Hardening #4). If the live store is not where this
  // test expects it, that is a failure of the test's premise and must be visible — not a skip
  // that reports green while proving nothing.
  it('has the live store it claims to be testing against', () => {
    expect(fs.existsSync(LIVE_DB)).toBe(true);
  });

  it('returns the NEWEST sprints for a bounded call, not the oldest', () => {
    const projectRoot = copyLiveStore();

    // Ground the expectation in the copy itself rather than in a hardcoded id list, so this
    // assertion keeps meaning as sprints are added. The pre-fix behaviour is computed here too,
    // which is what makes the final assertion a statement about DIRECTION and not about ids.
    const db = new Database(path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite'), {
      readonly: true,
    });
    const newestFive = db
      .prepare(
        `SELECT sprint_id FROM sprint_summary WHERE status IN ('Completed','Active')
         ORDER BY sprint_id DESC LIMIT 5`
      )
      .all()
      .map((r) => (r as { sprint_id: string }).sprint_id);
    const oldestFive = db
      .prepare(
        `SELECT sprint_id FROM sprint_summary WHERE status IN ('Completed','Active')
         ORDER BY sprint_id ASC LIMIT 5`
      )
      .all()
      .map((r) => (r as { sprint_id: string }).sprint_id);
    db.close();

    return cmosSprintAnalytics({ projectRoot, limit: 5 }).then((result) => {
      expect(result.success).toBe(true);
      const ids = result.data?.sprints.map((s) => s.sprintId) ?? [];

      // The window is the newest five, and it is handed back OLDEST-FIRST — the ordering
      // computeTrendDirection depends on.
      expect(ids).toEqual([...newestFive].reverse());

      // The ORIGINAL DEFECT, asserted as a disjointness rather than by naming sprint ids.
      // Hardcoding 'sprint-86' / 'sprint-82' here would be a time-bomb: it passes today and
      // fails the moment sprint-87 opens, for a reason that has nothing to do with this code
      // (agents.md engineering conventions — no hardcoded values that age out). The claim that
      // actually matters is that the bounded call returns the NEWEST window and not the OLDEST
      // one, and on a 77-sprint store those two windows share no members at all.
      expect(newestFive).not.toEqual(oldestFive);
      for (const oldId of oldestFive) expect(ids).not.toContain(oldId);

      // The answer now names the window it describes, rather than calling it "recent".
      expect(result.data?.window.requestedLimit).toBe(5);
      expect(result.data?.window.sprintCount).toBe(5);
      expect(result.data?.window.newestSprintId).toBe(newestFive[0]);
      expect(result.data?.window.oldestSprintId).toBe(ids[0]);
    });
  });

  it('leaves the unlimited call unchanged (limitClause is empty, outer ASC preserves order)', async () => {
    const projectRoot = copyLiveStore();
    const db = new Database(path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite'), {
      readonly: true,
    });
    const allAsc = db
      .prepare(
        `SELECT sprint_id FROM sprint_summary WHERE status IN ('Completed','Active')
         ORDER BY sprint_id ASC`
      )
      .all()
      .map((r) => (r as { sprint_id: string }).sprint_id);
    db.close();

    const result = await cmosSprintAnalytics({ projectRoot });
    expect(result.data?.sprints.map((s) => s.sprintId)).toEqual(allAsc);
    expect(result.data?.window.requestedLimit).toBeNull();
    expect(result.data?.window.sprintCount).toBe(allAsc.length);
  });
});

/**
 * TREND INVARIANCE — the assertion that makes the subquery form mandatory.
 *
 * computeTrendDirection compares the average of the FIRST half of the array to the SECOND half,
 * so an oldest-first array is what "trend" means. Flipping `ORDER BY sprint_id ASC` to `DESC`
 * would fix the window and silently INVERT every reported direction — a worse bug than the one
 * it fixed, and one no id assertion can see. On a monotonically-improving fixture the direction
 * from a bounded call must equal the direction from the unlimited call; a bare DESC flip turns
 * "increasing" into "decreasing" and fails here.
 */
describe('analytics trend invariance under a bounded window (s86-m05)', () => {
  it('reports the same velocity direction bounded and unbounded', async () => {
    const projectRoot = mkTmp('cmos-m05-trend-');
    const dbPath = seedCmosDb(projectRoot, { projectName: 'Trend Fixture' });

    const db = new Database(dbPath);
    // Ten sprints, each with TEN missions of which n are Completed: sprint-01 completes 1 of 10,
    // sprint-10 completes 10 of 10. Zero-padded so the lexicographic sprint_id ordering holds.
    //
    // The constant denominator is deliberate. An earlier fixture gave sprint n exactly n missions
    // and marked ALL of them Completed, so completionRate was 100% in every sprint and the
    // completionRate arm of the invariance assertion compared 'stable' to 'stable' — it could not
    // fail, whatever the ordering did. Holding the total fixed and varying the completed count
    // makes BOTH velocity and completion rate genuinely rise, so both arms can catch an inversion.
    const addSprint = db.prepare(
      `INSERT INTO sprints (id, title, status, focus) VALUES (?, ?, 'Completed', 'fixture')`
    );
    const addMission = db.prepare(
      `INSERT INTO missions (id, name, status, sprint_id, objective) VALUES (?, ?, ?, ?, 'fixture')`
    );
    const tx = db.transaction(() => {
      for (let n = 1; n <= 10; n++) {
        const sprintId = `sprint-${String(n).padStart(2, '0')}`;
        addSprint.run(sprintId, `Sprint ${n}`);
        for (let m = 0; m < 10; m++) {
          addMission.run(
            `${sprintId}-m${m}`,
            `mission ${m}`,
            m < n ? 'Completed' : 'Queued',
            sprintId
          );
        }
      }
    });
    tx();
    db.close();

    const unlimited = await cmosSprintAnalytics({ projectRoot });
    const bounded = await cmosSprintAnalytics({ projectRoot, limit: 6 });

    // Premise check: BOTH trends must actually move, or "identical direction" is satisfied
    // vacuously by two 'stable' readings and the assertion proves nothing.
    expect(unlimited.data?.trends.velocity.direction).toBe('increasing');
    expect(unlimited.data?.trends.completionRate.direction).toBe('increasing');

    expect(bounded.data?.trends.velocity.direction).toBe(unlimited.data?.trends.velocity.direction);
    expect(bounded.data?.trends.completionRate.direction).toBe(
      unlimited.data?.trends.completionRate.direction
    );

    // …and the bounded call really was bounded, to the NEWEST six.
    expect(bounded.data?.sprints.map((s) => s.sprintId)).toEqual([
      'sprint-05',
      'sprint-06',
      'sprint-07',
      'sprint-08',
      'sprint-09',
      'sprint-10',
    ]);
  });
});
