// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m02 — the #853 fold. Proves cmos_review, cmos_mission(status), and
// cmos_session(start) all name the SAME current sprint on a two-Active store.

/**
 * Cross-surface current-sprint agreement (s77-m02).
 *
 * The s75 #853 divergence: onboard's picker ordered `start_date DESC` (newest) and
 * mission-status' ordered `start_date ASC` (oldest), so on a two-Active store they
 * named different sprints. This test seeds two Active sprints with distinct real
 * activity and asserts the canonical resolver + all three surfaces agree on the
 * higher-activity sprint — then flips which sprint is more recent and re-asserts
 * the winner flips everywhere (Fork 1b: tie-break by real activity, not start_date).
 *
 * @module tests/tools/cmos/current-sprint-cross-surface
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withClient } from '../../../src/tools/cmos/client';
import { createSuccess } from '../../../src/tools/cmos/errors';
import { resolveCurrentSprintId } from '../../../src/tools/cmos/current-sprint';
import { cmosReview } from '../../../src/tools/cmos/cmos-review';
import { cmosMissionStatus } from '../../../src/tools/cmos/cmos-mission-status';
import { cmosSessionStart } from '../../../src/tools/cmos/cmos-session-start';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

/**
 * Seed a store with two Active sprints. sprint-a's newest activity is `aActivity`,
 * sprint-b's is `bActivity` (both via a Completed mission's completed_at). Each
 * sprint also has a Queued mission so both qualify as explicitly-open, forcing the
 * Step-2 real-activity tie-break to decide.
 */
function seedTwoActive(dir: string, aActivity: string, bActivity: string): string {
  const dbDir = path.join(dir, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT,
      start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id), name TEXT NOT NULL,
      status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT,
      success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT
    );
    CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT REFERENCES sprints(id),
      started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active',
      summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT
    );
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context',
      decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    INSERT INTO metadata (key, value) VALUES ('project_name','Cross-surface'),('project_id','cross-surface');

    -- Both Active. sprint-a starts LATER than sprint-b, so a naive start_date DESC
    -- picker would prefer sprint-a and start_date ASC would prefer sprint-b — the
    -- exact #853 split. Real activity (below) is what must decide instead.
    INSERT INTO sprints (id, title, status, focus, start_date) VALUES
      ('sprint-a', 'Sprint A', 'Active', 'A focus', '2026-06-15'),
      ('sprint-b', 'Sprint B', 'Active', 'B focus', '2026-06-05');

    INSERT INTO missions (id, sprint_id, name, status, completed_at, objective) VALUES
      ('a-done', 'sprint-a', 'A done', 'Completed', '${aActivity}', 'done'),
      ('a-queued', 'sprint-a', 'A queued', 'Queued', NULL, 'todo'),
      ('b-done', 'sprint-b', 'B done', 'Completed', '${bActivity}', 'done'),
      ('b-queued', 'sprint-b', 'B queued', 'Queued', NULL, 'todo');

    INSERT INTO contexts (id, source_path, content, updated_at) VALUES
      ('master_context','context/master_context.json',
       '{"project_identity":{"name":"Cross-surface","description":"x","status":"active_development"}}',
       '2026-06-01T00:00:00Z');
  `);
  db.close();
  return dbPath;
}

/** Resolve the current sprint id directly through the canonical resolver. */
async function resolveVia(dbPath: string): Promise<string | null> {
  const r = await withClient((client) => createSuccess(resolveCurrentSprintId(client)), { dbPath });
  return r.data ?? null;
}

describe('cross-surface current-sprint agreement (s77-m02)', () => {
  const dirs: string[] = [];

  function freshDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-xsurface-'));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    while (dirs.length) {
      fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
    CmosDetector.resetInstance();
  });

  it('resolver + review + mission-status + session-start all name the higher-activity sprint', async () => {
    const dir = freshDir();
    // sprint-b has newer activity (2026-06-10 > 2026-06-01) despite an earlier start_date.
    const dbPath = seedTwoActive(dir, '2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z');

    expect(await resolveVia(dbPath)).toBe('sprint-b');

    const review = await cmosReview({ projectRoot: dir });
    expect(review.success).toBe(true);
    expect(review.data?.sprint?.id).toBe('sprint-b');

    CmosDetector.resetInstance();
    const status = await cmosMissionStatus({ projectRoot: dir });
    expect(status.success).toBe(true);
    expect(status.data?.activeSprint?.id).toBe('sprint-b');

    // session-start mutates (inserts a session), so drive it LAST on this store.
    CmosDetector.resetInstance();
    const started = await cmosSessionStart({ type: 'custom', title: 'x', projectRoot: dir });
    expect(started.success).toBe(true);
    expect(started.data?.sprintId).toBe('sprint-b');
    expect(started.data?.sprintAutoTagged).toBe(true);
  });

  it('the winner flips on every surface when the newer-activity sprint flips', async () => {
    // Fresh store, activity flipped: sprint-a is now the more recent (2026-06-20 > 2026-06-10).
    const dir = freshDir();
    const dbPath = seedTwoActive(dir, '2026-06-20T00:00:00Z', '2026-06-10T00:00:00Z');

    expect(await resolveVia(dbPath)).toBe('sprint-a');

    const review = await cmosReview({ projectRoot: dir });
    expect(review.data?.sprint?.id).toBe('sprint-a');

    CmosDetector.resetInstance();
    const status = await cmosMissionStatus({ projectRoot: dir });
    expect(status.data?.activeSprint?.id).toBe('sprint-a');

    CmosDetector.resetInstance();
    const started = await cmosSessionStart({ type: 'custom', title: 'x', projectRoot: dir });
    expect(started.data?.sprintId).toBe('sprint-a');
    expect(started.data?.sprintAutoTagged).toBe(true);
  });
});
