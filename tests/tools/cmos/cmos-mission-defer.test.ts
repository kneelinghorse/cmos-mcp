// ABOUTME: Integration tests for cmos-mission-defer — verifies Deferred state transition, error cases, and event logging.
// ABOUTME: Uses a real SQLite temp database to test the full handler stack.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import {
  cmosMissionDefer,
  formatMissionDeferForLLM,
  type MissionDeferResult,
} from '../../../src/tools/cmos/cmos-mission-defer';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestEnv {
  projectRoot: string;
  dbPath: string;
  cleanup: () => void;
}

function createTestEnv(): TestEnv {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-defer-test-'));
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

    INSERT INTO sprints (id, title, status) VALUES ('sprint-1', 'Test Sprint', 'Active');
    INSERT INTO missions (id, sprint_id, name, status) VALUES
      ('m-queued',      'sprint-1', 'Queued Mission',      'Queued'),
      ('m-current',     'sprint-1', 'Current Mission',     'Current'),
      ('m-in-progress', 'sprint-1', 'In Progress Mission', 'In Progress'),
      ('m-blocked',     'sprint-1', 'Blocked Mission',     'Blocked'),
      ('m-deferred',    'sprint-1', 'Already Deferred',    'Deferred'),
      ('m-completed',   'sprint-1', 'Completed Mission',   'Completed'),
      ('m-dropped',     'sprint-1', 'Dropped Mission',     'Dropped');
  `);
  db.close();

  CmosDetector.resetInstance();

  return {
    projectRoot,
    dbPath,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function getMissionRow(
  dbPath: string,
  missionId: string
): { status: string; notes: string | null; domain_fields: string | null } | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT status, notes, domain_fields FROM missions WHERE id = ?')
      .get(missionId) as
      | { status: string; notes: string | null; domain_fields: string | null }
      | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

function getDeferEvent(dbPath: string, missionId: string): Record<string, unknown> | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT raw_event FROM session_events WHERE mission = ? AND action = 'defer' ORDER BY id DESC LIMIT 1`
      )
      .get(missionId) as { raw_event: string } | undefined;
    return row ? JSON.parse(row.raw_event) : null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cmosMissionDefer', () => {
  let env: TestEnv;

  beforeEach(() => {
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  // --- Happy paths ---

  it('defers a Queued mission', async () => {
    const result = await cmosMissionDefer({ missionId: 'm-queued', projectRoot: env.projectRoot });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Deferred');
    expect(result.data?.previousStatus).toBe('Queued');
    expect(getMissionRow(env.dbPath, 'm-queued')?.status).toBe('Deferred');
  });

  it('defers a Current mission', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-current',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Deferred');
  });

  it('defers an In Progress mission', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-in-progress',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Deferred');
  });

  it('defers a Blocked mission', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-blocked',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Deferred');
  });

  it('stores reason and deferUntil in domain_fields', async () => {
    await cmosMissionDefer({
      missionId: 'm-queued',
      reason: 'Waiting for partner team',
      deferUntil: 'after sprint 49',
      projectRoot: env.projectRoot,
    });

    const row = getMissionRow(env.dbPath, 'm-queued');
    const domainFields = JSON.parse(row!.domain_fields!);
    expect(domainFields.deferredReason).toBe('Waiting for partner team');
    expect(domainFields.deferUntil).toBe('after sprint 49');
    expect(domainFields.deferredFromStatus).toBe('Queued');
  });

  it('includes deferUntil hint in notes', async () => {
    await cmosMissionDefer({
      missionId: 'm-queued',
      reason: 'Blocked on API',
      deferUntil: 'when API ships',
      projectRoot: env.projectRoot,
    });

    const row = getMissionRow(env.dbPath, 'm-queued');
    expect(row!.notes).toContain('[Deferred]');
    expect(row!.notes).toContain('until: when API ships');
  });

  it('returns deferUntil in result data', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-queued',
      deferUntil: 'Q3',
      projectRoot: env.projectRoot,
    });
    expect(result.data?.deferUntil).toBe('Q3');
  });

  it('returns null deferUntil when not provided', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-queued',
      projectRoot: env.projectRoot,
    });
    expect(result.data?.deferUntil).toBeNull();
  });

  it('logs a session_events row with action=defer', async () => {
    await cmosMissionDefer({ missionId: 'm-queued', projectRoot: env.projectRoot });
    const event = getDeferEvent(env.dbPath, 'm-queued');
    expect(event).not.toBeNull();
    expect(event!['tool']).toBe('cmos_mission_defer');
    expect(event!['newStatus']).toBe('Deferred');
    expect(event!['previousStatus']).toBe('Queued');
  });

  it('includes deferredAt timestamp in result', async () => {
    const before = new Date().toISOString();
    const result = await cmosMissionDefer({
      missionId: 'm-queued',
      projectRoot: env.projectRoot,
    });
    const after = new Date().toISOString();
    expect(result.data?.deferredAt).toBeDefined();
    expect(result.data!.deferredAt >= before).toBe(true);
    expect(result.data!.deferredAt <= after).toBe(true);
  });

  // --- Error cases ---

  it('returns MISSION_INVALID_STATE when already Deferred', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-deferred',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_STATE);
  });

  it('returns MISSION_INVALID_TRANSITION when deferring Completed mission', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-completed',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
  });

  it('returns MISSION_INVALID_TRANSITION when deferring Dropped mission', async () => {
    const result = await cmosMissionDefer({
      missionId: 'm-dropped',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
  });

  it('returns MISSION_NOT_FOUND for unknown mission ID', async () => {
    const result = await cmosMissionDefer({
      missionId: 'nonexistent',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
  });

  it('returns MISSING_PARAMETER when missionId is empty', async () => {
    const result = await cmosMissionDefer({ missionId: '', projectRoot: env.projectRoot });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
  });
});

// ---------------------------------------------------------------------------
// Formatter tests
// ---------------------------------------------------------------------------

describe('formatMissionDeferForLLM', () => {
  it('formats a successful defer result', () => {
    const result: CmosToolResult<MissionDeferResult> = {
      success: true,
      data: {
        missionId: 's12-m05',
        previousStatus: 'Queued',
        currentStatus: 'Deferred',
        reason: 'Waiting on partner team',
        deferUntil: 'after sprint 49',
        message: "Mission 's12-m05' has been deferred",
        deferredAt: '2024-01-15T10:00:00.000Z',
      },
    };

    const output = formatMissionDeferForLLM(result);
    expect(output).toContain('s12-m05');
    expect(output).toContain('Queued → Deferred');
    expect(output).toContain('Waiting on partner team');
    expect(output).toContain('after sprint 49');
  });

  it('formats an error result', () => {
    const result: CmosToolResult<MissionDeferResult> = {
      success: false,
      error: {
        code: 'MISSION_INVALID_STATE',
        message: "Mission 's12-m05' is already Deferred",
        currentState: 'Deferred',
      },
    };

    const output = formatMissionDeferForLLM(result);
    expect(output).toContain('Failed to defer mission');
    expect(output).toContain("Mission 's12-m05' is already Deferred");
  });

  it('omits deferUntil line when not provided', () => {
    const result: CmosToolResult<MissionDeferResult> = {
      success: true,
      data: {
        missionId: 's12-m05',
        previousStatus: 'In Progress',
        currentStatus: 'Deferred',
        reason: null,
        deferUntil: null,
        message: "Mission 's12-m05' has been deferred",
        deferredAt: '2024-01-15T10:00:00.000Z',
      },
    };

    const output = formatMissionDeferForLLM(result);
    expect(output).not.toContain('Re-queue when:');
  });
});
