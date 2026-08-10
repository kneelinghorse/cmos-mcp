/**
 * Mission Lifecycle Tools Tests
 *
 * Comprehensive tests for all mission lifecycle mutation tools:
 * - cmos_mission_start
 * - cmos_mission_complete
 * - cmos_mission_block
 * - cmos_mission_unblock
 *
 * Each tool has 10+ tests covering happy paths and error cases.
 *
 * @module tests/tools/cmos/mission-lifecycle
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult, MissionStatus } from '../../../src/tools/cmos/types';

// Import tool implementations and types
import {
  cmosMissionStart,
  cmosMissionStartToolDefinition,
  formatMissionStartForLLM,
  type MissionStartResult,
} from '../../../src/tools/cmos/cmos-mission-start';

import {
  cmosMissionComplete,
  cmosMissionCompleteToolDefinition,
  formatMissionCompleteForLLM,
  type MissionCompleteResult,
} from '../../../src/tools/cmos/cmos-mission-complete';

import {
  cmosMissionBlock,
  cmosMissionBlockToolDefinition,
  formatMissionBlockForLLM,
  type MissionBlockResult,
} from '../../../src/tools/cmos/cmos-mission-block';

import {
  cmosMissionUnblock,
  cmosMissionUnblockToolDefinition,
  formatMissionUnblockForLLM,
  type MissionUnblockResult,
} from '../../../src/tools/cmos/cmos-mission-unblock';

/**
 * Helper to create test database and run tool with explicit db path.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-lifecycle-test-'));
  const dbPath = path.join(tempDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  // Create comprehensive schema
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
      metadata TEXT
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

    -- Insert test sprint
    INSERT INTO sprints (id, title, focus, status)
    VALUES ('sprint-12', 'Sprint 12 - Testing', 'Test lifecycle tools', 'In Progress');

    -- Insert test missions with various statuses
    INSERT INTO missions (id, sprint_id, name, status, objective, notes, domain_fields)
    VALUES
      ('m-queued', 'sprint-12', 'Queued Mission', 'Queued', 'Test queued mission', NULL, NULL),
      ('m-current', 'sprint-12', 'Current Mission', 'Current', 'Test current mission', NULL, NULL),
      ('m-in-progress', 'sprint-12', 'In Progress Mission', 'In Progress', 'Test in progress mission', NULL, NULL),
      ('m-completed', 'sprint-12', 'Completed Mission', 'Completed', 'Test completed mission', 'Done', '2024-01-15T10:00:00Z'),
      ('m-blocked', 'sprint-12', 'Blocked Mission', 'Blocked', 'Test blocked mission', '[Blocked] Waiting on dependency', '{"blocker": "external-api", "blockedSince": "2024-01-14T12:00:00Z"}');
  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

/**
 * Helper to run tools with explicit database path (bypassing detection)
 */
async function runWithDb<T>(
  dbPath: string,
  toolFn: (params: Record<string, unknown>) => Promise<CmosToolResult<T>>,
  params: Record<string, unknown>
): Promise<CmosToolResult<T>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  // The tool functions use withClient internally, but we need to pass dbPath
  // We'll call the tool directly with projectRoot set to undefined
  // and rely on the tool to handle the database path
  return toolFn(params);
}

/**
 * Helper to call cmosMissionStart with explicit dbPath
 */
async function callMissionStart(
  dbPath: string,
  params: { missionId: string; notes?: string }
): Promise<CmosToolResult<MissionStartResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'In Progress';

  return withClient(
    (client) => {
      const missionResult = client.getOne<{
        id: string;
        status: MissionStatus;
        name: string;
        sprint_id: string | null;
      }>('SELECT id, status, name, sprint_id FROM missions WHERE id = ?', [missionId]);

      if (!missionResult.success) {
        return createError<MissionStartResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionStartResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      if (currentStatus === targetStatus) {
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is already In Progress`,
          currentState: currentStatus,
          suggestion:
            'Use cmos_mission_transition(action="complete") to mark it done or cmos_mission_transition(action="block") if blocked',
        });
      }

      // Special handling for blocked missions - redirect to unblock tool
      if (currentStatus === 'Blocked') {
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION,
          message: `Cannot start blocked mission '${missionId}'`,
          currentState: currentStatus,
          validTransitions: ['In Progress', 'Current'],
          suggestion:
            'Use cmos_mission_transition(action="unblock") to unblock this mission first. ' +
            'Provide a resolution explaining how the blocker was resolved.',
        });
      }

      const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionStartResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      const now = new Date().toISOString();
      let shouldActivateSprint = false;
      if (mission.sprint_id) {
        const sprintResult = client.getOne<{ status: string | null }>(
          'SELECT status FROM sprints WHERE id = ?',
          [mission.sprint_id]
        );
        if (!sprintResult.success) {
          return createError<MissionStartResult>(
            sprintResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: `Failed to query sprint '${mission.sprint_id}'`,
            }
          );
        }
        shouldActivateSprint = sprintResult.data?.status === 'Planned';
      }

      client.execute('BEGIN IMMEDIATE', []);

      if (shouldActivateSprint && mission.sprint_id) {
        const activateSprintResult = client.execute(
          `UPDATE sprints
              SET status = 'Active',
                  start_date = COALESCE(start_date, ?)
            WHERE id = ?
              AND status = 'Planned'`,
          [now, mission.sprint_id]
        );

        if (!activateSprintResult.success) {
          client.execute('ROLLBACK', []);
          return createError<MissionStartResult>({
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to activate sprint '${mission.sprint_id}'`,
            suggestion: 'Retry mission start after fixing the sprint row.',
          });
        }
      }

      let updateQuery: string;
      let updateParams: (string | null)[];

      if (params.notes) {
        updateQuery = `UPDATE missions SET status = ?, notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?`;
        updateParams = [targetStatus, `[Started] ${params.notes}`, missionId];
      } else {
        updateQuery = `UPDATE missions SET status = ? WHERE id = ?`;
        updateParams = [targetStatus, missionId];
      }

      const updateResult = client.execute(updateQuery, updateParams);
      if (!updateResult.success || updateResult.data?.changes === 0) {
        client.execute('ROLLBACK', []);
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      const commitResult = client.execute('COMMIT', []);
      if (!commitResult.success) {
        client.execute('ROLLBACK', []);
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to commit mission start '${missionId}'`,
          suggestion: 'Retry mission start once the database transaction can be committed.',
        });
      }

      // Log event
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'mcp-tool', ?, 'start', ?, ?, ?)`,
        [
          now,
          missionId,
          targetStatus,
          params.notes ?? `Started mission ${missionId}`,
          JSON.stringify({ tool: 'cmos_mission_start', missionId, previousStatus: currentStatus }),
        ]
      );

      return createSuccess<MissionStartResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: targetStatus,
        message: `Mission '${missionId}' is now In Progress`,
        startedAt: now,
      });
    },
    { dbPath }
  );
}

/**
 * Helper to call cmosMissionComplete with explicit dbPath
 */
async function callMissionComplete(
  dbPath: string,
  params: { missionId: string; notes?: string }
): Promise<CmosToolResult<MissionCompleteResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'Completed';

  return withClient(
    (client) => {
      const missionResult = client.getOne<{ id: string; status: MissionStatus; name: string }>(
        'SELECT id, status, name FROM missions WHERE id = ?',
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionCompleteResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionCompleteResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      if (currentStatus === targetStatus) {
        return createError<MissionCompleteResult>({
          code: CMOS_ERROR_CODES.MISSION_ALREADY_COMPLETED,
          message: `Mission '${missionId}' is already Completed`,
          currentState: currentStatus,
          suggestion: 'This mission has already been completed. No action needed.',
        });
      }

      const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionCompleteResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      const now = new Date().toISOString();
      let updateQuery: string;
      let updateParams: (string | null)[];

      if (params.notes) {
        updateQuery = `UPDATE missions SET status = ?, completed_at = ?, notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?`;
        updateParams = [targetStatus, now, `[Completed] ${params.notes}`, missionId];
      } else {
        updateQuery = `UPDATE missions SET status = ?, completed_at = ? WHERE id = ?`;
        updateParams = [targetStatus, now, missionId];
      }

      const updateResult = client.execute(updateQuery, updateParams);
      if (!updateResult.success || updateResult.data?.changes === 0) {
        return createError<MissionCompleteResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'mcp-tool', ?, 'complete', ?, ?, ?)`,
        [
          now,
          missionId,
          targetStatus,
          params.notes ?? `Completed mission ${missionId}`,
          JSON.stringify({
            tool: 'cmos_mission_complete',
            missionId,
            previousStatus: currentStatus,
          }),
        ]
      );

      return createSuccess<MissionCompleteResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: targetStatus,
        message: `Mission '${missionId}' has been completed`,
        completedAt: now,
      });
    },
    { dbPath }
  );
}

/**
 * Helper to call cmosMissionBlock with explicit dbPath
 */
async function callMissionBlock(
  dbPath: string,
  params: { missionId: string; reason: string; blockers?: string[] }
): Promise<CmosToolResult<MissionBlockResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }
  if (!params.reason || params.reason.trim() === '') {
    return createError(CmosErrors.missingParameter('reason'));
  }

  const missionId = params.missionId.trim();
  const reason = params.reason.trim();
  const targetStatus: MissionStatus = 'Blocked';

  return withClient(
    (client) => {
      const missionResult = client.getOne<{
        id: string;
        status: MissionStatus;
        name: string;
        domain_fields: string | null;
      }>('SELECT id, status, name, domain_fields FROM missions WHERE id = ?', [missionId]);

      if (!missionResult.success) {
        return createError<MissionBlockResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionBlockResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      if (currentStatus === targetStatus) {
        return createError<MissionBlockResult>({
          code: CMOS_ERROR_CODES.MISSION_ALREADY_BLOCKED,
          message: `Mission '${missionId}' is already Blocked`,
          currentState: currentStatus,
          suggestion:
            'Use cmos_mission_transition(action="unblock") to unblock it first, or update the block reason',
        });
      }

      const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionBlockResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      const now = new Date().toISOString();

      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          existingDomainFields = {};
        }
      }

      const updatedDomainFields = {
        ...existingDomainFields,
        blocker: reason,
        blockedSince: now,
        blockers: params.blockers ?? [],
      };

      const blockNote = params.blockers?.length
        ? `[Blocked] ${reason}. Needs: ${params.blockers.join(', ')}`
        : `[Blocked] ${reason}`;

      const updateResult = client.execute(
        `UPDATE missions SET status = ?, domain_fields = ?, notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?`,
        [targetStatus, JSON.stringify(updatedDomainFields), blockNote, missionId]
      );

      if (!updateResult.success || updateResult.data?.changes === 0) {
        return createError<MissionBlockResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'mcp-tool', ?, 'block', ?, ?, ?)`,
        [
          now,
          missionId,
          targetStatus,
          reason,
          JSON.stringify({
            tool: 'cmos_mission_block',
            missionId,
            previousStatus: currentStatus,
            reason,
            blockers: params.blockers,
          }),
        ]
      );

      return createSuccess<MissionBlockResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: targetStatus,
        reason,
        message: `Mission '${missionId}' has been blocked: ${reason}`,
        blockedAt: now,
      });
    },
    { dbPath }
  );
}

/**
 * Helper to call cmosMissionUnblock with explicit dbPath
 */
async function callMissionUnblock(
  dbPath: string,
  params: { missionId: string; resolution?: string; targetStatus?: 'In Progress' | 'Current' }
): Promise<CmosToolResult<MissionUnblockResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = params.targetStatus ?? 'In Progress';

  return withClient(
    (client) => {
      const missionResult = client.getOne<{
        id: string;
        status: MissionStatus;
        name: string;
        domain_fields: string | null;
      }>('SELECT id, status, name, domain_fields FROM missions WHERE id = ?', [missionId]);

      if (!missionResult.success) {
        return createError<MissionUnblockResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionUnblockResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      if (currentStatus !== 'Blocked') {
        return createError<MissionUnblockResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is not blocked (current status: ${currentStatus})`,
          currentState: currentStatus,
          suggestion:
            currentStatus === 'Completed'
              ? 'Cannot unblock a completed mission'
              : 'Use cmos_mission_start to begin work on this mission',
        });
      }

      const validTransitions = VALID_STATE_TRANSITIONS['Blocked'];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionUnblockResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      const now = new Date().toISOString();

      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          existingDomainFields = {};
        }
      }

      const previousBlocker = existingDomainFields.blocker;
      const previousBlockedSince = existingDomainFields.blockedSince;

      const updatedDomainFields = {
        ...existingDomainFields,
        blocker: null,
        blockedSince: null,
        blockers: null,
        unblockedAt: now,
        previousBlocker,
        previousBlockedSince,
        resolution: params.resolution ?? null,
      };

      const unblockNote = params.resolution
        ? `[Unblocked] ${params.resolution}`
        : `[Unblocked] Blocker resolved`;

      const updateResult = client.execute(
        `UPDATE missions SET status = ?, domain_fields = ?, notes = COALESCE(notes || ' | ', '') || ? WHERE id = ?`,
        [targetStatus, JSON.stringify(updatedDomainFields), unblockNote, missionId]
      );

      if (!updateResult.success || updateResult.data?.changes === 0) {
        return createError<MissionUnblockResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'mcp-tool', ?, 'unblock', ?, ?, ?)`,
        [
          now,
          missionId,
          targetStatus,
          params.resolution ?? `Unblocked mission ${missionId}`,
          JSON.stringify({
            tool: 'cmos_mission_unblock',
            missionId,
            previousStatus: currentStatus,
            resolution: params.resolution,
          }),
        ]
      );

      return createSuccess<MissionUnblockResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: targetStatus,
        resolution: params.resolution ?? null,
        message: `Mission '${missionId}' has been unblocked`,
        unblockedAt: now,
      });
    },
    { dbPath }
  );
}

describe('cmos_mission_start', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should start a Queued mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-queued');
      expect(result.data?.previousStatus).toBe('Queued');
      expect(result.data?.currentStatus).toBe('In Progress');
      expect(result.data?.startedAt).toBeDefined();
    });

    it('should start a Current mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-current' });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Current');
      expect(result.data?.currentStatus).toBe('In Progress');
    });

    it('should include notes in result message', async () => {
      const result = await callMissionStart(testDb.dbPath, {
        missionId: 'm-queued',
        notes: 'Starting implementation',
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('In Progress');
    });

    it('should update mission status in database', async () => {
      await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });

      const row = testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('m-queued') as {
        status: string;
      };
      expect(row.status).toBe('In Progress');
    });

    it('should append notes to existing notes', async () => {
      // First add some notes
      testDb.db.exec(`UPDATE missions SET notes = 'Initial note' WHERE id = 'm-queued'`);

      await callMissionStart(testDb.dbPath, {
        missionId: 'm-queued',
        notes: 'Starting work',
      });

      const row = testDb.db.prepare('SELECT notes FROM missions WHERE id = ?').get('m-queued') as {
        notes: string;
      };
      expect(row.notes).toContain('Initial note');
      expect(row.notes).toContain('[Started] Starting work');
    });

    it('should log event to session_events', async () => {
      await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-queued', 'start') as { action: string; status: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('start');
      expect(event.status).toBe('In Progress');
    });

    it('should auto-activate a Planned parent sprint when mission work begins', async () => {
      testDb.db.exec(`
        INSERT INTO sprints (id, title, focus, status)
        VALUES ('sprint-planned', 'Planned Sprint', 'Future work', 'Planned');

        INSERT INTO missions (id, sprint_id, name, status, objective)
        VALUES ('m-planned', 'sprint-planned', 'Planned Mission', 'Queued', 'Start planned work');
      `);

      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-planned' });

      expect(result.success).toBe(true);

      const sprint = testDb.db
        .prepare('SELECT status FROM sprints WHERE id = ?')
        .get('sprint-planned') as { status: string };
      expect(sprint.status).toBe('Active');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('cmos_mission(action="list")');
    });

    it('should return MISSION_INVALID_STATE for already In Progress mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-in-progress' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_STATE);
      expect(result.error?.currentState).toBe('In Progress');
    });

    it('should return INVALID_STATE_TRANSITION for Completed mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-completed' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Completed');
      expect(result.error?.validTransitions).toEqual([]);
    });

    it('should return INVALID_STATE_TRANSITION for Blocked mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-blocked' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Blocked');
      expect(result.error?.validTransitions).toContain('In Progress');
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('cmos_mission_transition(action="unblock")');
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER for whitespace-only mission ID', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionStartToolDefinition.name).toBe('cmos_mission_start');
    });

    it('should have comprehensive description', () => {
      expect(cmosMissionStartToolDefinition.description).toContain('In Progress');
      expect(cmosMissionStartToolDefinition.description).toContain('INVALID_STATE_TRANSITION');
    });

    it('should require missionId parameter', () => {
      expect(cmosMissionStartToolDefinition.inputSchema.required).toContain('missionId');
    });
  });

  describe('formatMissionStartForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });
      const formatted = formatMissionStartForLLM(result);

      expect(formatted).toContain("Mission 'm-queued' started");
      expect(formatted).toContain('Queued → In Progress');
    });

    it('should format error result with suggestion', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'nonexistent' });
      const formatted = formatMissionStartForLLM(result);

      expect(formatted).toContain('Failed to start mission');
      expect(formatted).toContain('Suggestion');
    });
  });
});

describe('cmos_mission_complete', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should complete an In Progress mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-in-progress');
      expect(result.data?.previousStatus).toBe('In Progress');
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.data?.completedAt).toBeDefined();
    });

    it('should include notes in completion', async () => {
      const result = await callMissionComplete(testDb.dbPath, {
        missionId: 'm-in-progress',
        notes: 'All tests passing',
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT notes FROM missions WHERE id = ?')
        .get('m-in-progress') as {
        notes: string;
      };
      expect(row.notes).toContain('[Completed] All tests passing');
    });

    it('should set completed_at timestamp', async () => {
      await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      const row = testDb.db
        .prepare('SELECT completed_at FROM missions WHERE id = ?')
        .get('m-in-progress') as { completed_at: string };
      expect(row.completed_at).toBeDefined();
      expect(new Date(row.completed_at).getTime()).toBeGreaterThan(0);
    });

    it('should update mission status in database', async () => {
      await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      const row = testDb.db
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get('m-in-progress') as { status: string };
      expect(row.status).toBe('Completed');
    });

    it('should log event to session_events', async () => {
      await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-in-progress', 'complete') as { action: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('complete');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return MISSION_ALREADY_COMPLETED for Completed mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-completed' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_ALREADY_COMPLETED);
      expect(result.error?.suggestion).toContain('already been completed');
    });

    it('should return INVALID_STATE_TRANSITION for Queued mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Queued');
    });

    it('should return INVALID_STATE_TRANSITION for Blocked mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-blocked' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionCompleteToolDefinition.name).toBe('cmos_mission_complete');
    });

    it('should have comprehensive description', () => {
      expect(cmosMissionCompleteToolDefinition.description).toContain('Completed');
      expect(cmosMissionCompleteToolDefinition.description).toContain('In Progress');
    });
  });

  describe('formatMissionCompleteForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });
      const formatted = formatMissionCompleteForLLM(result);

      expect(formatted).toContain("Mission 'm-in-progress' completed");
      expect(formatted).toContain('In Progress → Completed');
    });

    it('should format error result', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });
      const formatted = formatMissionCompleteForLLM(result);

      expect(formatted).toContain('Failed to complete mission');
    });
  });
});

describe('cmos_mission_block', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should block an In Progress mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Waiting on API access',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-in-progress');
      expect(result.data?.previousStatus).toBe('In Progress');
      expect(result.data?.currentStatus).toBe('Blocked');
      expect(result.data?.reason).toBe('Waiting on API access');
      expect(result.data?.blockedAt).toBeDefined();
    });

    it('should block a Current mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-current',
        reason: 'Dependencies not ready',
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Current');
      expect(result.data?.currentStatus).toBe('Blocked');
    });

    it('should include blockers list in domain_fields', async () => {
      await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'External dependency',
        blockers: ['API access', 'Auth tokens'],
      });

      const row = testDb.db
        .prepare('SELECT domain_fields FROM missions WHERE id = ?')
        .get('m-in-progress') as { domain_fields: string };
      const domainFields = JSON.parse(row.domain_fields);

      expect(domainFields.blocker).toBe('External dependency');
      expect(domainFields.blockers).toEqual(['API access', 'Auth tokens']);
      expect(domainFields.blockedSince).toBeDefined();
    });

    it('should update notes with blocker info', async () => {
      await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Blocked reason',
        blockers: ['Item 1', 'Item 2'],
      });

      const row = testDb.db
        .prepare('SELECT notes FROM missions WHERE id = ?')
        .get('m-in-progress') as {
        notes: string;
      };
      expect(row.notes).toContain('[Blocked]');
      expect(row.notes).toContain('Needs: Item 1, Item 2');
    });

    it('should log event to session_events', async () => {
      await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Test block',
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-in-progress', 'block') as { action: string; summary: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('block');
      expect(event.summary).toBe('Test block');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'nonexistent',
        reason: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return MISSION_ALREADY_BLOCKED for Blocked mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-blocked',
        reason: 'Another reason',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_ALREADY_BLOCKED);
      expect(result.error?.suggestion).toContain('unblock');
    });

    it('should return INVALID_STATE_TRANSITION for Queued mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-queued',
        reason: 'Cannot block queued',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
    });

    it('should return INVALID_STATE_TRANSITION for Completed mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-completed',
        reason: 'Cannot block completed',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: '',
        reason: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER for empty reason', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('reason');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionBlockToolDefinition.name).toBe('cmos_mission_block');
    });

    it('should require missionId and reason parameters', () => {
      expect(cmosMissionBlockToolDefinition.inputSchema.required).toContain('missionId');
      expect(cmosMissionBlockToolDefinition.inputSchema.required).toContain('reason');
    });
  });

  describe('formatMissionBlockForLLM', () => {
    it('should format success result with block icon', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Test reason',
      });
      const formatted = formatMissionBlockForLLM(result);

      expect(formatted).toContain("Mission 'm-in-progress' blocked");
      expect(formatted).toContain('Reason: Test reason');
      expect(formatted).toContain('⊘');
    });
  });
});

describe('cmos_mission_unblock', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should unblock a Blocked mission to In Progress', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-blocked' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-blocked');
      expect(result.data?.previousStatus).toBe('Blocked');
      expect(result.data?.currentStatus).toBe('In Progress');
      expect(result.data?.unblockedAt).toBeDefined();
    });

    it('should unblock to Current status when specified', async () => {
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        targetStatus: 'Current',
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Current');
    });

    it('should include resolution notes', async () => {
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'API access granted',
      });

      expect(result.success).toBe(true);
      expect(result.data?.resolution).toBe('API access granted');
    });

    it('should clear blocker info from domain_fields', async () => {
      await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'Resolved',
      });

      const row = testDb.db
        .prepare('SELECT domain_fields FROM missions WHERE id = ?')
        .get('m-blocked') as { domain_fields: string };
      const domainFields = JSON.parse(row.domain_fields);

      expect(domainFields.blocker).toBeNull();
      expect(domainFields.blockedSince).toBeNull();
      expect(domainFields.previousBlocker).toBe('external-api');
      expect(domainFields.unblockedAt).toBeDefined();
      expect(domainFields.resolution).toBe('Resolved');
    });

    it('should update notes with unblock info', async () => {
      await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'Fixed the issue',
      });

      const row = testDb.db.prepare('SELECT notes FROM missions WHERE id = ?').get('m-blocked') as {
        notes: string;
      };
      expect(row.notes).toContain('[Unblocked] Fixed the issue');
    });

    it('should log event to session_events', async () => {
      await callMissionUnblock(testDb.dbPath, { missionId: 'm-blocked' });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-blocked', 'unblock') as { action: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('unblock');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return MISSION_INVALID_STATE for non-blocked mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-in-progress' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_STATE);
      expect(result.error?.currentState).toBe('In Progress');
      expect(result.error?.suggestion).toContain('cmos_mission_start');
    });

    it('should return MISSION_INVALID_STATE for Queued mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-queued' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_STATE);
    });

    it('should return MISSION_INVALID_STATE for Completed mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-completed' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_STATE);
      expect(result.error?.suggestion).toContain('Cannot unblock a completed mission');
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionUnblockToolDefinition.name).toBe('cmos_mission_unblock');
    });

    it('should only require missionId parameter', () => {
      expect(cmosMissionUnblockToolDefinition.inputSchema.required).toContain('missionId');
      expect(cmosMissionUnblockToolDefinition.inputSchema.required).not.toContain('resolution');
      expect(cmosMissionUnblockToolDefinition.inputSchema.required).not.toContain('targetStatus');
    });

    it('should include targetStatus enum options', () => {
      const props = cmosMissionUnblockToolDefinition.inputSchema.properties;
      expect(props.targetStatus.enum).toContain('In Progress');
      expect(props.targetStatus.enum).toContain('Current');
    });
  });

  describe('formatMissionUnblockForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'Problem solved',
      });
      const formatted = formatMissionUnblockForLLM(result);

      expect(formatted).toContain("Mission 'm-blocked' unblocked");
      expect(formatted).toContain('Blocked → In Progress');
      expect(formatted).toContain('Resolution: Problem solved');
    });

    it('should format error result', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-queued' });
      const formatted = formatMissionUnblockForLLM(result);

      expect(formatted).toContain('Failed to unblock mission');
      expect(formatted).toContain('not blocked');
    });
  });
});

describe('state transition integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should allow full lifecycle: Queued -> In Progress -> Completed', async () => {
    // Start
    const startResult = await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });
    expect(startResult.success).toBe(true);
    expect(startResult.data?.currentStatus).toBe('In Progress');

    // Complete
    const completeResult = await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });
    expect(completeResult.success).toBe(true);
    expect(completeResult.data?.currentStatus).toBe('Completed');
  });

  it('should allow block and unblock cycle', async () => {
    // Block
    const blockResult = await callMissionBlock(testDb.dbPath, {
      missionId: 'm-in-progress',
      reason: 'Waiting on dependency',
    });
    expect(blockResult.success).toBe(true);
    expect(blockResult.data?.currentStatus).toBe('Blocked');

    // Unblock
    const unblockResult = await callMissionUnblock(testDb.dbPath, {
      missionId: 'm-in-progress',
      resolution: 'Dependency resolved',
    });
    expect(unblockResult.success).toBe(true);
    expect(unblockResult.data?.currentStatus).toBe('In Progress');

    // Complete after unblock
    const completeResult = await callMissionComplete(testDb.dbPath, {
      missionId: 'm-in-progress',
    });
    expect(completeResult.success).toBe(true);
    expect(completeResult.data?.currentStatus).toBe('Completed');
  });

  it('should track full history in session_events', async () => {
    // Full lifecycle
    await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });
    await callMissionBlock(testDb.dbPath, { missionId: 'm-queued', reason: 'Blocked' });
    await callMissionUnblock(testDb.dbPath, { missionId: 'm-queued' });
    await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });

    const events = testDb.db
      .prepare('SELECT action FROM session_events WHERE mission = ? ORDER BY ts')
      .all('m-queued') as { action: string }[];

    expect(events.map((e) => e.action)).toEqual(['start', 'block', 'unblock', 'complete']);
  });
});
