// ABOUTME: s85-m04 real-store positive-fire for mission_id (#487) — the mission -> row trail
// ABOUTME: must survive the CONSOLIDATED router, an un-migrated store, and the dedup ordering.

/**
 * Sprint 85 m04 — `mission_id` provenance, proven against a real store.
 *
 * WHY A REAL STORE, AND WHY THE ROUTER (decision #926 #3). The coverage guard in
 * event-type-coverage.test.ts asserts `mission_id` appears in the SQL TEXT. It never checks the
 * VALUE bound to the placeholder — cmos-session-complete's capture-sourced next_steps insert
 * carried the column in its list throughout the whole period next_steps accumulated 493 NULLs.
 * And `cmos-session.ts` declared `missionId`, forwarded it to `capture`, and did NOT forward it
 * to `complete`: wiring the handler alone passes every handler-level test and ships DEAD over
 * MCP, returning no error because mission_id simply stays null. That is the s80-m07 shape.
 *
 * So these tests drive the CONSOLIDATED `cmosSession({action:'complete', …})` router — never
 * `cmosSessionComplete` directly — and assert with raw SELECTs.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { seedCmosDb } from '../../helpers/seedCmosDb';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';
import { cmosDecisions } from '../../../src/tools/cmos/cmos-decisions';
import { cmosLearnings } from '../../../src/tools/cmos/cmos-learnings';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

/** A store with one Active sprint and two missions, one of them In Progress. */
async function makeStore(opts: { dropDecisionMissionId?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cmos-m04-'));
  roots.push(root);
  const dbPath = seedCmosDb(root, { projectName: 'm04-fixture', projectId: 'm04-fixture' });

  const db = new Database(dbPath);
  // s86-m01: the local master_context/project_context INSERT OR IGNORE that used to
  // sit here is gone — seedCmosDb writes all three contexts rows itself now.
  db.prepare(
    `INSERT INTO sprints (id, title, focus, status, start_date) VALUES ('sp-1','S1','f','Active','2026-01-01')`
  ).run();
  db.prepare(
    `INSERT INTO missions (id, name, sprint_id, status, created_at) VALUES ('m-x','Mission X','sp-1','In Progress','2026-01-01T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO missions (id, name, sprint_id, status, created_at) VALUES ('m-y','Mission Y','sp-1','Queued','2026-01-01T00:00:00Z')`
  ).run();

  if (opts.dropDecisionMissionId) {
    // PATH 1 — an UN-MIGRATED store: strategic_decisions.mission_id rides the v2.1 migration,
    // so remove it. The handler must LAND the column via ensureMissionIdColumn rather than
    // throwing "no such column".
    //
    // Three real properties of this schema make the removal fiddly, and getting it wrong makes
    // the FIXTURE fail rather than the product:
    //   - ALTER ... DROP COLUMN is refused: mission_id appears in a FOREIGN KEY.
    //   - DROP TABLE is refused: the sprint_summary VIEW references the table.
    //   - CREATE TABLE AS SELECT loses every column constraint, which then breaks the firehose
    //     migration's DDL parser (it requires a bare `occurred_at INTEGER` to constrain).
    // So rebuild from the REAL DDL with the mission_id column and its FK line removed, keeping
    // every other constraint byte-identical.
    const originalDdl = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='strategic_decisions'`)
        .get() as { sql: string }
    ).sql;
    const viewSql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='view' AND name='sprint_summary'`)
        .get() as { sql?: string } | undefined
    )?.sql;

    const ddlWithoutMission = originalDdl
      .split('\n')
      .filter(
        (line) => !/^\s*mission_id\s/.test(line) && !/FOREIGN KEY\s*\(\s*mission_id/.test(line)
      )
      .join('\n')
      .replace('CREATE TABLE strategic_decisions', 'CREATE TABLE sd_new')
      .replace('CREATE TABLE IF NOT EXISTS strategic_decisions', 'CREATE TABLE sd_new');

    const keptCols = (
      db.prepare(`PRAGMA table_info('strategic_decisions')`).all() as { name: string }[]
    )
      .map((c) => c.name)
      .filter((n) => n !== 'mission_id');

    db.exec('PRAGMA foreign_keys = OFF');
    if (viewSql) db.exec('DROP VIEW sprint_summary');
    db.exec('DROP INDEX IF EXISTS idx_strategic_decisions_mission');
    db.exec(ddlWithoutMission);
    db.exec(
      `INSERT INTO sd_new (${keptCols.join(', ')}) SELECT ${keptCols.join(', ')} FROM strategic_decisions`
    );
    db.exec('DROP TABLE strategic_decisions');
    db.exec('ALTER TABLE sd_new RENAME TO strategic_decisions');
    if (viewSql) db.exec(viewSql);
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.close();
  return root;
}

function raw<T>(root: string, sql: string): T[] {
  const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function indexNames(root: string): string[] {
  return raw<{ name: string }>(
    root,
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%mission%'"
  ).map((r) => r.name);
}

describe('s85-m04 mission_id provenance (real store, consolidated router)', () => {
  it('POSITIVE FIRE: complete(missionId) stamps BOTH strategic_decisions and next_steps', async () => {
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });

    const done = await cmosSession({
      action: 'complete',
      summary: 'm04 close',
      missionId: 'm-x',
      decisions: ['m04 decision from the decisions[] param'],
      nextSteps: ['m04 next step from the nextSteps[] param'],
      projectRoot: root,
    });
    expect(done.success).toBe(true);

    const decisions = raw<{ decision_text: string; mission_id: string | null }>(
      root,
      'SELECT decision_text, mission_id FROM strategic_decisions'
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].mission_id).toBe('m-x');

    const steps = raw<{ content: string; mission_id: string | null }>(
      root,
      'SELECT content, mission_id FROM next_steps'
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].mission_id).toBe('m-x');
  });

  it('UN-MIGRATED STORE: the decisions insert LANDS the column instead of throwing', async () => {
    const root = await makeStore({ dropDecisionMissionId: true });
    const before = raw<{ name: string }>(root, `PRAGMA table_info('strategic_decisions')`).map(
      (c) => c.name
    );
    expect(before).not.toContain('mission_id');

    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    const done = await cmosSession({
      action: 'complete',
      summary: 'unmigrated',
      missionId: 'm-x',
      decisions: ['decision on an un-migrated store'],
      projectRoot: root,
    });
    expect(done.success).toBe(true);

    const after = raw<{ name: string }>(root, `PRAGMA table_info('strategic_decisions')`).map(
      (c) => c.name
    );
    expect(after).toContain('mission_id');
    const rows = raw<{ mission_id: string | null }>(
      root,
      'SELECT mission_id FROM strategic_decisions'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mission_id).toBe('m-x');
  });

  it('ORDERING HAZARD: identical text in nextSteps[] and a stamped capture yields ONE stamped row', async () => {
    // Both loops dedup on (content_hash, session_id). The mission-bearing capture loop now runs
    // FIRST, so the stamped row wins instead of being shadowed by its unstamped twin.
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    const SHARED = 'ship the ordering fix';
    await cmosSession({
      action: 'capture',
      category: 'next-step',
      content: SHARED,
      missionId: 'm-y',
      projectRoot: root,
    });
    await cmosSession({
      action: 'complete',
      summary: 'ordering',
      nextSteps: [SHARED],
      projectRoot: root,
    });

    const steps = raw<{ content: string; mission_id: string | null }>(
      root,
      `SELECT content, mission_id FROM next_steps WHERE content = '${SHARED}'`
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].mission_id).toBe('m-y');
  });

  it('PER-CAPTURE missionId WINS over the call-level default for next-steps', async () => {
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    await cmosSession({
      action: 'capture',
      category: 'next-step',
      content: 'belongs to Y',
      missionId: 'm-y',
      projectRoot: root,
    });
    await cmosSession({
      action: 'complete',
      summary: 'precedence',
      missionId: 'm-x',
      nextSteps: ['belongs to X'],
      projectRoot: root,
    });

    const byContent = Object.fromEntries(
      raw<{ content: string; mission_id: string | null }>(
        root,
        'SELECT content, mission_id FROM next_steps'
      ).map((r) => [r.content, r.mission_id])
    );
    expect(byContent['belongs to Y']).toBe('m-y');
    expect(byContent['belongs to X']).toBe('m-x');
  });

  it('WARNINGS LEVER: warns on a decision capture with no missionId while a mission is open', async () => {
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });

    const warned = await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'unstamped decision',
      projectRoot: root,
    });
    expect((warned.warnings ?? []).some((w) => /m-x/.test(w) && /missionId/.test(w))).toBe(true);

    // Supplying it silences the warning.
    const quiet = await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'stamped decision',
      missionId: 'm-x',
      projectRoot: root,
    });
    expect((quiet.warnings ?? []).some((w) => /missionId/.test(w))).toBe(false);

    // A NEXT-STEP capture NEVER warns: 96.4% are born when zero mission is in progress.
    const step = await cmosSession({
      action: 'capture',
      category: 'next-step',
      content: 'a next step',
      projectRoot: root,
    });
    expect((step.warnings ?? []).some((w) => /missionId/.test(w))).toBe(false);
  });

  it('WARNINGS LEVER: silent when NO mission is In Progress or Current', async () => {
    const root = await makeStore();
    const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    db.prepare("UPDATE missions SET status = 'Completed'").run();
    db.close();

    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    const res = await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'no open mission',
      projectRoot: root,
    });
    expect((res.warnings ?? []).some((w) => /missionId/.test(w))).toBe(false);
  });

  it('ROUND TRIP: all three list surfaces filter to exactly the stamped rows', async () => {
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'decision for X',
      missionId: 'm-x',
      projectRoot: root,
    });
    await cmosSession({
      action: 'capture',
      category: 'learning',
      content: 'learning for X',
      missionId: 'm-x',
      projectRoot: root,
    });
    await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'decision for Y',
      missionId: 'm-y',
      projectRoot: root,
    });
    await cmosSession({
      action: 'complete',
      summary: 'round trip',
      missionId: 'm-x',
      nextSteps: ['next step for X'],
      projectRoot: root,
    });

    const dl = await cmosDecisions({ action: 'list', missionId: 'm-x', projectRoot: root });
    const dRows = (dl.data as { decisions?: Array<{ decision?: string }> })?.decisions ?? [];
    expect(dRows.map((d) => d.decision)).toEqual(['decision for X']);

    const ll = await cmosLearnings({ action: 'list', missionId: 'm-x', projectRoot: root });
    const lRows = (ll.data as { learnings?: Array<{ content?: string }> })?.learnings ?? [];
    expect(lRows.map((l) => l.content)).toEqual(['learning for X']);

    const ns = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'list',
      missionId: 'm-x',
      projectRoot: root,
    });
    const nRows = (ns.data as { items?: Array<{ content?: string }> })?.items ?? [];
    expect(nRows.map((n) => n.content)).toEqual(['next step for X']);
  });

  it('ROUND TRIP: the next_steps filter works on BOTH the pending and explicit-status branches', async () => {
    // The old implementation had two hardcoded SQL literals — one inlining status='pending',
    // one binding it. A filter added to only one branch would be invisible. Assert both.
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    await cmosSession({
      action: 'complete',
      summary: 'branches',
      missionId: 'm-x',
      nextSteps: ['pending step for X'],
      projectRoot: root,
    });

    const pending = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'list',
      missionId: 'm-x',
      projectRoot: root,
    });
    expect(((pending.data as { items?: unknown[] })?.items ?? []).length).toBe(1);

    const explicit = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'list',
      nextStepStatus: 'pending',
      missionId: 'm-x',
      projectRoot: root,
    });
    expect(((explicit.data as { items?: unknown[] })?.items ?? []).length).toBe(1);

    // A mission with no rows returns none rather than everything.
    const none = await cmosContext({
      action: 'next_steps',
      nextStepAction: 'list',
      missionId: 'm-y',
      projectRoot: root,
    });
    expect(((none.data as { items?: unknown[] })?.items ?? []).length).toBe(0);
  });

  it('INDEXES: idx_learnings_mission and idx_next_steps_mission exist on a fresh seed store', async () => {
    const root = await makeStore();
    // Drive one write so the lazily-created tables (and their indexes) are ensured.
    await cmosSession({ action: 'start', type: 'planning', title: 'idx', projectRoot: root });
    await cmosSession({
      action: 'capture',
      category: 'learning',
      content: 'seed a learning',
      missionId: 'm-x',
      projectRoot: root,
    });
    await cmosSession({
      action: 'complete',
      summary: 'idx',
      nextSteps: ['seed a next step'],
      projectRoot: root,
    });

    const idx = indexNames(root);
    expect(idx).toContain('idx_learnings_mission');
    expect(idx).toContain('idx_next_steps_mission');
  });

  it('INDEXES: both land on a MIGRATED store that lacked them', async () => {
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'idx2', projectRoot: root });
    await cmosSession({
      action: 'capture',
      category: 'learning',
      content: 'first learning',
      projectRoot: root,
    });
    await cmosSession({ action: 'complete', summary: 'x', nextSteps: ['s'], projectRoot: root });

    // Simulate the pre-m04 live-store state: drop the two indexes, then drive another write.
    const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    db.exec('DROP INDEX IF EXISTS idx_learnings_mission');
    db.exec('DROP INDEX IF EXISTS idx_next_steps_mission');
    db.close();
    expect(indexNames(root)).not.toContain('idx_learnings_mission');

    await cmosSession({ action: 'start', type: 'planning', title: 'idx3', projectRoot: root });
    await cmosSession({
      action: 'capture',
      category: 'learning',
      content: 'second learning',
      projectRoot: root,
    });
    await cmosSession({ action: 'complete', summary: 'y', nextSteps: ['t'], projectRoot: root });

    const idx = indexNames(root);
    expect(idx).toContain('idx_learnings_mission');
    expect(idx).toContain('idx_next_steps_mission');
  });

  it('existing NULL-mission_id rows survive untouched and are EXCLUDED by the filter, not errored', async () => {
    const root = await makeStore();
    await cmosSession({ action: 'start', type: 'planning', title: 'm04', projectRoot: root });
    await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'unstamped historical decision',
      projectRoot: root,
    });
    await cmosSession({
      action: 'capture',
      category: 'decision',
      content: 'stamped decision',
      missionId: 'm-x',
      projectRoot: root,
    });
    await cmosSession({ action: 'complete', summary: 'coexist', projectRoot: root });

    expect(raw<{ n: number }>(root, 'SELECT COUNT(*) n FROM strategic_decisions')[0].n).toBe(2);

    const filtered = await cmosDecisions({ action: 'list', missionId: 'm-x', projectRoot: root });
    expect(filtered.success).toBe(true);
    const rows = (filtered.data as { decisions?: Array<{ decision?: string }> })?.decisions ?? [];
    expect(rows.map((d) => d.decision)).toEqual(['stamped decision']);

    // Unfiltered still returns both — the historical row is excluded, not deleted.
    const all = await cmosDecisions({ action: 'list', projectRoot: root });
    expect(((all.data as { decisions?: unknown[] })?.decisions ?? []).length).toBe(2);
  });
});
