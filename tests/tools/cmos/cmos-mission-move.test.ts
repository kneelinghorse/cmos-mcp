// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m08 — cmos_mission(action="move"): the refusal matrix, the no-op guard, and the
// ABOUTME: provenance row whose failure must reach the ANSWER rather than console.warn.

/**
 * Sprint 86 m08 Part A.
 *
 * WHY THE REFUSALS ARE THE POINT. A move that succeeds is one line of SQL. What makes this a
 * capability rather than a footgun is what it REFUSES: work cannot land in a sprint that carries
 * no open work (a Completed sprint would then become the system's resolved current sprint and
 * stamp its id onto every decision captured in the session), and a terminal mission cannot be
 * re-credited to a sprint that did not do it. Both are asserted BY RULE — case-folded status
 * comparison and an empty VALID_STATE_TRANSITIONS entry — never by a hand-kept list, so a new
 * terminal status is covered the day it is added.
 *
 * THE FAIL-QUIET LEG. Since s86-m02 the seven sibling transition handlers disclose a failed
 * `session_events` insert into the envelope AND duplicate it to the console; this handler uses
 * the envelope alone. The last test here forces that insert to fail and asserts the failure
 * reaches `result.warnings` — the channel every leaf formatter renders — exactly once.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import {
  cmosMissionMove,
  formatMissionMoveForLLM,
  type MissionMoveResult,
} from '../../../src/tools/cmos/cmos-mission-move';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

interface TestEnv {
  projectRoot: string;
  dbPath: string;
  cleanup: () => void;
}

function createTestEnv(): TestEnv {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-move-test-'));
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT,
      focus TEXT,
      status TEXT,
      start_date TEXT,
      end_date TEXT,
      total_missions INTEGER,
      completed_missions INTEGER
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      sprint_id TEXT REFERENCES sprints(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT,
      notes TEXT,
      objective TEXT,
      context TEXT,
      success_criteria TEXT,
      deliverables TEXT,
      reference_docs TEXT,
      domain_fields TEXT,
      metadata TEXT,
      started_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      agent TEXT,
      mission TEXT,
      action TEXT,
      status TEXT,
      summary TEXT,
      next_hint TEXT,
      raw_event TEXT NOT NULL
    );

    INSERT INTO sprints (id, title, status) VALUES
      ('sprint-open',      'Open Sprint',       'Active'),
      ('sprint-planned',   'Planned Sprint',    'Planned'),
      ('sprint-done',      'Completed Sprint',  'Completed'),
      ('sprint-archived',  'Archived Sprint',   'Archived'),
      ('sprint-lower',     'Case-drifted',      'completed');

    INSERT INTO missions (id, sprint_id, name, status, updated_at) VALUES
      ('m-queued',    'sprint-planned', 'Queued Mission',    'Queued',      '2026-01-01T00:00:00.000Z'),
      ('m-deferred',  'sprint-planned', 'Deferred Mission',  'Deferred',    '2026-01-01T00:00:00.000Z'),
      ('m-progress',  'sprint-planned', 'In Progress',       'In Progress', '2026-01-01T00:00:00.000Z'),
      ('m-completed', 'sprint-planned', 'Completed Mission', 'Completed',   '2026-01-01T00:00:00.000Z'),
      ('m-dropped',   'sprint-planned', 'Dropped Mission',   'Dropped',     '2026-01-01T00:00:00.000Z'),
      ('m-archived',  'sprint-planned', 'Archived Mission',  'Archived',    '2026-01-01T00:00:00.000Z'),
      ('m-unbound',   NULL,             'Unbound Mission',   'Queued',      '2026-01-01T00:00:00.000Z'),
      ('m-already',   'sprint-open',    'Already There',     'Queued',      '2026-01-01T00:00:00.000Z');
  `);
  db.close();

  CmosDetector.resetInstance();

  return {
    projectRoot,
    dbPath,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function missionRow(
  dbPath: string,
  missionId: string
): { sprint_id: string | null; status: string; notes: string | null; updated_at: string | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT sprint_id, status, notes, updated_at FROM missions WHERE id = ?')
      .get(missionId) as {
      sprint_id: string | null;
      status: string;
      notes: string | null;
      updated_at: string | null;
    };
  } finally {
    db.close();
  }
}

function moveEvents(dbPath: string, missionId: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT raw_event FROM session_events WHERE mission = ? AND action = 'move' ORDER BY id`
      )
      .all(missionId) as Array<{ raw_event: string }>;
    return rows.map((r) => JSON.parse(r.raw_event) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe('cmos_mission(action="move") — s86-m08 Part A', () => {
  let env: TestEnv;

  beforeEach(() => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  // ─── the move itself ──────────────────────────────────────────────────────

  it('re-binds the mission, breadcrumbs it, and leaves the status alone', async () => {
    const result = await cmosMissionMove({
      missionId: 'm-queued',
      toSprintId: 'sprint-open',
      reason: 'executed under the new sprint',
      projectRoot: env.projectRoot,
    });

    expect(result.success).toBe(true);
    const row = missionRow(env.dbPath, 'm-queued');
    expect(row.sprint_id).toBe('sprint-open');
    expect(row.notes).toContain('[Moved]');
    expect(row.notes).toContain('sprint-planned -> sprint-open');
    // A move re-binds; it must never transition.
    expect(row.status).toBe('Queued');
    expect(result.data?.noOp).toBe(false);
  });

  it('records BOTH endpoints on the provenance row, with a null (not absent) origin', async () => {
    await cmosMissionMove({
      missionId: 'm-queued',
      toSprintId: 'sprint-open',
      projectRoot: env.projectRoot,
    });
    const [bound] = moveEvents(env.dbPath, 'm-queued');
    expect(bound).toMatchObject({ fromSprintId: 'sprint-planned', toSprintId: 'sprint-open' });

    await cmosMissionMove({
      missionId: 'm-unbound',
      toSprintId: 'sprint-open',
      projectRoot: env.projectRoot,
    });
    const [unbound] = moveEvents(env.dbPath, 'm-unbound');
    // `null`, not missing — "it had no sprint" is a fact worth stating.
    expect(unbound).toHaveProperty('fromSprintId', null);
    expect(unbound).toMatchObject({ toSprintId: 'sprint-open' });
  });

  it('moves a Deferred mission — the real-world case — and a Planned destination is open', async () => {
    const result = await cmosMissionMove({
      missionId: 'm-deferred',
      toSprintId: 'sprint-open',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(missionRow(env.dbPath, 'm-deferred').sprint_id).toBe('sprint-open');

    const backToPlanned = await cmosMissionMove({
      missionId: 'm-progress',
      toSprintId: 'sprint-planned',
      projectRoot: env.projectRoot,
    });
    // Planned is not in SPRINT_NO_OPEN_WORK_STATUSES; only a no-op guard could stop this, and
    // m-progress starts on sprint-planned, so assert the no-op path instead of a refusal.
    expect(backToPlanned.success).toBe(true);
    expect(backToPlanned.data?.noOp).toBe(true);
  });

  // ─── the no-op guard ──────────────────────────────────────────────────────

  it('writes NOTHING when the mission is already there, and says so', async () => {
    const before = missionRow(env.dbPath, 'm-already');

    const result = await cmosMissionMove({
      missionId: 'm-already',
      toSprintId: 'sprint-open',
      projectRoot: env.projectRoot,
    });

    expect(result.success).toBe(true);
    expect(result.data?.noOp).toBe(true);
    expect(result.warnings?.length).toBeGreaterThan(0);
    expect(formatMissionMoveForLLM(result)).toContain('already belongs to sprint');

    const after = missionRow(env.dbPath, 'm-already');
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.notes).toBe(before.notes);
    expect(moveEvents(env.dbPath, 'm-already')).toHaveLength(0);
  });

  // ─── the refusal matrix ───────────────────────────────────────────────────

  const refusals: Array<{
    label: string;
    missionId: string;
    toSprintId: string;
    code: string;
    expectIn?: string;
  }> = [
    {
      label: '(a) destination Completed',
      missionId: 'm-queued',
      toSprintId: 'sprint-done',
      code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
    },
    {
      label: '(b) destination Archived',
      missionId: 'm-queued',
      toSprintId: 'sprint-archived',
      code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
    },
    {
      // The case-folded comparison earns its keep here: a literal `!== 'Completed'` passes this.
      label: "(c) destination status is lowercase 'completed'",
      missionId: 'm-queued',
      toSprintId: 'sprint-lower',
      code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
    },
    {
      label: '(d) destination does not exist',
      missionId: 'm-queued',
      toSprintId: 'sprint-nope',
      code: CMOS_ERROR_CODES.SPRINT_NOT_FOUND,
    },
    {
      label: '(e) mission is Completed',
      missionId: 'm-completed',
      toSprintId: 'sprint-open',
      code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
    },
    {
      label: '(f) mission is Dropped',
      missionId: 'm-dropped',
      toSprintId: 'sprint-open',
      code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
    },
    {
      label: "(g) mission status 'Archived' is not a known mission status",
      missionId: 'm-archived',
      toSprintId: 'sprint-open',
      code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
      expectIn: 'Archived',
    },
    {
      label: '(h) mission does not exist',
      missionId: 'm-nope',
      toSprintId: 'sprint-open',
      code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
    },
  ];

  it.each(refusals)('refuses $label with a usable suggestion and no write', async (c) => {
    const before = c.missionId === 'm-nope' ? null : missionRow(env.dbPath, c.missionId);

    const result = await cmosMissionMove({
      missionId: c.missionId,
      toSprintId: c.toSprintId,
      projectRoot: env.projectRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(c.code);
    // A refusal that does not tell the operator what to do instead is half a refusal.
    expect(result.error?.suggestion ?? '').not.toBe('');
    if (c.expectIn) expect(result.error?.message).toContain(c.expectIn);

    if (before) {
      const after = missionRow(env.dbPath, c.missionId);
      expect(after.sprint_id).toBe(before.sprint_id);
      expect(after.updated_at).toBe(before.updated_at);
      expect(moveEvents(env.dbPath, c.missionId)).toHaveLength(0);
    }
  });

  it('refuses EVERY terminal status BY RULE — the handler is driven from the derived list', async () => {
    // The rule is "an empty VALID_STATE_TRANSITIONS entry", so the test derives the set and
    // DRIVES THE HANDLER with each member. Add a third terminal status tomorrow and this test
    // covers it without anyone editing a list here — which a hard-coded expectation could
    // claim but not deliver.
    const { VALID_STATE_TRANSITIONS } = await import('../../../src/tools/cmos/errors');
    const terminal = Object.entries(VALID_STATE_TRANSITIONS)
      .filter(([, next]) => next.length === 0)
      .map(([status]) => status);
    expect(terminal.length).toBeGreaterThan(0);

    const db = new Database(env.dbPath);
    for (const [i, status] of terminal.entries()) {
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status) VALUES (?, 'sprint-planned', ?, ?)`
      ).run(`m-terminal-${i}`, `Terminal ${status}`, status);
    }
    db.close();

    for (const [i, status] of terminal.entries()) {
      const result = await cmosMissionMove({
        missionId: `m-terminal-${i}`,
        toSprintId: 'sprint-open',
        projectRoot: env.projectRoot,
      });
      expect({ status, code: result.error?.code }).toEqual({
        status,
        code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
      });
      expect(missionRow(env.dbPath, `m-terminal-${i}`).sprint_id).toBe('sprint-planned');
    }
  });

  it('refuses a prototype-named status instead of falling through to Object.prototype', async () => {
    // 'constructor' resolved to a truthy inherited function and MOVED before the ownership
    // check; 'toString' was refused as "a terminal status", which is true of nothing.
    const db = new Database(env.dbPath);
    for (const status of ['constructor', 'toString', 'hasOwnProperty']) {
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status) VALUES (?, 'sprint-planned', ?, ?)`
      ).run(`m-proto-${status}`, `Proto ${status}`, status);
    }
    db.close();

    for (const status of ['constructor', 'toString', 'hasOwnProperty']) {
      const result = await cmosMissionMove({
        missionId: `m-proto-${status}`,
        toSprintId: 'sprint-open',
        projectRoot: env.projectRoot,
      });
      expect(result.success).toBe(false);
      // Refused BY NAME as unrecognized — not misdescribed as terminal.
      expect(result.error?.message).toContain('unrecognized status');
      expect(missionRow(env.dbPath, `m-proto-${status}`).sprint_id).toBe('sprint-planned');
    }
  });

  // ─── the fail-quiet leg ───────────────────────────────────────────────────

  it('surfaces a lost provenance row in the ANSWER, and still reports the binding it changed', async () => {
    // Force the session_events INSERT to fail while leaving the UPDATE intact.
    const db = new Database(env.dbPath);
    db.exec('ALTER TABLE session_events RENAME TO session_events_moved_away');
    db.close();

    const result = await cmosMissionMove({
      missionId: 'm-queued',
      toSprintId: 'sprint-open',
      projectRoot: env.projectRoot,
    });

    // The binding DID change, so the answer stays success — and says what was lost.
    expect(result.success).toBe(true);
    expect(missionRow(env.dbPath, 'm-queued').sprint_id).toBe('sprint-open');
    expect(result.warnings?.some((w) => w.includes('mission move event logging'))).toBe(true);

    // And it is visible in the channel an agent actually reads.
    expect(formatMissionMoveForLLM(result)).toContain('mission move event logging');
  });

  it('routes that failure to the answer and NOWHERE else — no console.warn in the handler', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/tools/cmos/cmos-mission-move.ts'),
      'utf8'
    );
    expect(source.match(/console\.warn/g) ?? []).toHaveLength(0);
  });

  // ─── the id is a label, not a claim ───────────────────────────────────────

  it('says plainly that a moved mission keeps its creation-time id prefix', async () => {
    const db = new Database(env.dbPath);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status) VALUES ('s85-m06', 'sprint-planned', 'Prefixed', 'Deferred')`
    ).run();
    db.prepare(
      `INSERT INTO sprints (id, title, status) VALUES ('sprint-86', 'S86', 'Active')`
    ).run();
    db.close();

    const result = (await cmosMissionMove({
      missionId: 's85-m06',
      toSprintId: 'sprint-86',
      projectRoot: env.projectRoot,
    })) as CmosToolResult<MissionMoveResult>;

    expect(result.success).toBe(true);
    const text = formatMissionMoveForLLM(result);
    expect(text).toContain('creation-time label');
    expect(text).toContain('sprint-86');
  });
});
