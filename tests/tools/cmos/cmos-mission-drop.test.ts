// ABOUTME: Integration tests for cmos-mission-drop — verifies Dropped state transition, error cases, and event logging.
// ABOUTME: Uses a real SQLite temp database to test the full handler stack.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../../src/intelligence/project-registry';
import {
  cmosMissionDrop,
  formatMissionDropForLLM,
  type MissionDropResult,
} from '../../../src/tools/cmos/cmos-mission-drop';
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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-drop-test-'));
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
      ('m-deferred',    'sprint-1', 'Deferred Mission',    'Deferred'),
      ('m-completed',   'sprint-1', 'Completed Mission',   'Completed'),
      ('m-dropped',     'sprint-1', 'Already Dropped',     'Dropped');
  `);
  db.close();

  CmosDetector.resetInstance();

  return {
    projectRoot,
    dbPath,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function getMissionStatus(dbPath: string, missionId: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

function getDropEvent(dbPath: string, missionId: string): Record<string, unknown> | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT raw_event FROM session_events WHERE mission = ? AND action = 'drop' ORDER BY id DESC LIMIT 1`
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

describe('cmosMissionDrop', () => {
  let env: TestEnv;

  beforeEach(() => {
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  // --- Happy paths ---

  it('drops a Queued mission', async () => {
    const result = await cmosMissionDrop({ missionId: 'm-queued', projectRoot: env.projectRoot });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Dropped');
    expect(result.data?.previousStatus).toBe('Queued');
    expect(getMissionStatus(env.dbPath, 'm-queued')).toBe('Dropped');
  });

  it('drops a Current mission', async () => {
    const result = await cmosMissionDrop({ missionId: 'm-current', projectRoot: env.projectRoot });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Dropped');
    expect(getMissionStatus(env.dbPath, 'm-current')).toBe('Dropped');
  });

  it('drops an In Progress mission', async () => {
    const result = await cmosMissionDrop({
      missionId: 'm-in-progress',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Dropped');
    expect(getMissionStatus(env.dbPath, 'm-in-progress')).toBe('Dropped');
  });

  it('drops a Blocked mission', async () => {
    const result = await cmosMissionDrop({ missionId: 'm-blocked', projectRoot: env.projectRoot });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Dropped');
    expect(getMissionStatus(env.dbPath, 'm-blocked')).toBe('Dropped');
  });

  it('drops a Deferred mission', async () => {
    const result = await cmosMissionDrop({
      missionId: 'm-deferred',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.currentStatus).toBe('Dropped');
    expect(getMissionStatus(env.dbPath, 'm-deferred')).toBe('Dropped');
  });

  it('records the reason in result and domain_fields', async () => {
    const result = await cmosMissionDrop({
      missionId: 'm-queued',
      reason: 'No longer relevant',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(true);
    expect(result.data?.reason).toBe('No longer relevant');

    const db = new Database(env.dbPath, { readonly: true });
    const row = db
      .prepare('SELECT domain_fields, notes FROM missions WHERE id = ?')
      .get('m-queued') as { domain_fields: string; notes: string } | undefined;
    db.close();

    const domainFields = JSON.parse(row!.domain_fields);
    expect(domainFields.droppedReason).toBe('No longer relevant');
    expect(domainFields.droppedFromStatus).toBe('Queued');
    expect(row!.notes).toContain('[Dropped]');
    expect(row!.notes).toContain('No longer relevant');
  });

  it('records drop with null reason when no reason given', async () => {
    const result = await cmosMissionDrop({ missionId: 'm-queued', projectRoot: env.projectRoot });
    expect(result.success).toBe(true);
    expect(result.data?.reason).toBeNull();
  });

  it('logs a session_events row with action=drop', async () => {
    await cmosMissionDrop({ missionId: 'm-queued', projectRoot: env.projectRoot });
    const event = getDropEvent(env.dbPath, 'm-queued');
    expect(event).not.toBeNull();
    expect(event!['tool']).toBe('cmos_mission_drop');
    expect(event!['newStatus']).toBe('Dropped');
    expect(event!['previousStatus']).toBe('Queued');
  });

  it('includes droppedAt timestamp in result', async () => {
    const before = new Date().toISOString();
    const result = await cmosMissionDrop({ missionId: 'm-queued', projectRoot: env.projectRoot });
    const after = new Date().toISOString();
    expect(result.data?.droppedAt).toBeDefined();
    expect(result.data!.droppedAt >= before).toBe(true);
    expect(result.data!.droppedAt <= after).toBe(true);
  });

  // --- Error cases ---

  it('returns MISSION_INVALID_STATE when already Dropped', async () => {
    const result = await cmosMissionDrop({
      missionId: 'm-dropped',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_STATE);
  });

  it('returns MISSION_INVALID_TRANSITION when dropping Completed mission', async () => {
    const result = await cmosMissionDrop({
      missionId: 'm-completed',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
  });

  it('returns MISSION_NOT_FOUND for unknown mission ID', async () => {
    const result = await cmosMissionDrop({
      missionId: 'nonexistent',
      projectRoot: env.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
  });

  it('returns MISSING_PARAMETER when missionId is empty', async () => {
    const result = await cmosMissionDrop({ missionId: '', projectRoot: env.projectRoot });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
  });
});

// ---------------------------------------------------------------------------
// Formatter tests
// ---------------------------------------------------------------------------

describe('formatMissionDropForLLM', () => {
  it('formats a successful drop result', () => {
    const result: CmosToolResult<MissionDropResult> = {
      success: true,
      data: {
        missionId: 's12-m05',
        previousStatus: 'Queued',
        currentStatus: 'Dropped',
        reason: 'Superseded by s12-m06',
        message: "Mission 's12-m05' has been dropped",
        droppedAt: '2024-01-15T10:00:00.000Z',
      },
    };

    const output = formatMissionDropForLLM(result);
    expect(output).toContain('s12-m05');
    expect(output).toContain('Queued → Dropped');
    expect(output).toContain('Superseded by s12-m06');
  });

  it('formats an error result', () => {
    const result: CmosToolResult<MissionDropResult> = {
      success: false,
      error: {
        code: 'MISSION_INVALID_STATE',
        message: "Mission 's12-m05' is already Dropped",
        currentState: 'Dropped',
      },
    };

    const output = formatMissionDropForLLM(result);
    expect(output).toContain('Failed to drop mission');
    expect(output).toContain("Mission 's12-m05' is already Dropped");
  });

  it('omits reason line when no reason provided', () => {
    const result: CmosToolResult<MissionDropResult> = {
      success: true,
      data: {
        missionId: 's12-m05',
        previousStatus: 'In Progress',
        currentStatus: 'Dropped',
        reason: null,
        message: "Mission 's12-m05' has been dropped",
        droppedAt: '2024-01-15T10:00:00.000Z',
      },
    };

    const output = formatMissionDropForLLM(result);
    expect(output).not.toContain('Reason:');
  });
});
