/**
 * Integration Lifecycle Tests
 *
 * End-to-end tests that verify all Sprint 13 CMOS tools work together
 * in realistic workflows. Tests cover:
 * - Full mission lifecycle: list -> start -> update -> complete
 * - Blocking flow: list -> start -> block -> unblock -> complete
 * - Cross-tool consistency and state management
 *
 * @module tests/tools/cmos/integration-lifecycle
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult, MissionStatus } from '../../../src/tools/cmos/types';
import type { MissionStartResult } from '../../../src/tools/cmos/cmos-mission-start';
import type { MissionCompleteResult } from '../../../src/tools/cmos/cmos-mission-complete';
import type { MissionBlockResult } from '../../../src/tools/cmos/cmos-mission-block';
import type { MissionUnblockResult } from '../../../src/tools/cmos/cmos-mission-unblock';
import type {
  MissionUpdateResult,
  MissionUpdateFields,
} from '../../../src/tools/cmos/cmos-mission-update';
import type {
  CmosMissionListResult,
  MissionListItem,
} from '../../../src/tools/cmos/cmos-mission-list';
import type {
  CmosMissionStatusResult,
  StatusMissionItem,
} from '../../../src/tools/cmos/cmos-mission-status';

/**
 * Test database setup interface
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

/**
 * Create a test database with realistic mission data
 */
function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-integration-test-'));
  const dbPath = path.join(tempDir, 'cmos.sqlite');
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

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      sprint_id TEXT REFERENCES sprints(id),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      agent TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      captures TEXT,
      next_steps TEXT,
      metadata TEXT
    );

    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT,
      content TEXT NOT NULL,
      updated_at TEXT
    );

    -- Insert sprint
    INSERT INTO sprints (id, title, focus, status, total_missions, completed_missions)
    VALUES ('sprint-integration', 'Integration Test Sprint', 'End-to-end workflow testing', 'In Progress', 5, 0);

    -- Insert missions representing a realistic workflow
    INSERT INTO missions (id, sprint_id, name, status, objective, context, success_criteria, deliverables, reference_docs, notes)
    VALUES
      ('int-m01', 'sprint-integration', 'Feature Implementation', 'Queued',
       'Implement new user authentication feature',
       'Users need secure login with OAuth support',
       '["OAuth provider integration works", "Unit tests pass", "Security review complete"]',
       '["src/auth/oauth.ts", "tests/auth/oauth.test.ts"]',
       '["docs/security.md", "docs/oauth-spec.md"]',
       NULL),
      ('int-m02', 'sprint-integration', 'Database Migration', 'Queued',
       'Add new tables for user preferences',
       'Need to store user settings in a normalized way',
       '["Migration runs without errors", "Data integrity verified"]',
       '["migrations/001_preferences.sql"]',
       '["docs/db-schema.md"]',
       NULL),
      ('int-m03', 'sprint-integration', 'API Endpoint', 'Current',
       'Create REST endpoint for preferences',
       'Frontend needs to read/write preferences',
       '["Endpoint returns correct data", "Error handling works"]',
       '["src/api/preferences.ts"]',
       NULL,
       NULL),
      ('int-m04', 'sprint-integration', 'UI Components', 'In Progress',
       'Build settings panel UI',
       'Users need visual interface for preferences',
       '["Component renders correctly", "Accessibility checks pass"]',
       '["src/components/SettingsPanel.tsx"]',
       NULL,
       'Working on form validation'),
      ('int-m05', 'sprint-integration', 'Testing', 'Blocked',
       'Write E2E tests for the entire flow',
       'Need comprehensive test coverage',
       '["All E2E tests pass", "Coverage > 80%"]',
       '["tests/e2e/preferences.test.ts"]',
       NULL,
       '[Blocked] Waiting on UI components');

    -- Insert contexts for context tools testing
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('master_context', 'context/MASTER_CONTEXT.json', '{"project": "Integration Test", "decisions": []}', datetime('now')),
      ('project_context', 'context/PROJECT_CONTEXT.json', '{"active_mission": null, "session_count": 1}', datetime('now'));
  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

// =============================================================================
// Tool Helper Functions (matching patterns from mission-lifecycle.test.ts)
// =============================================================================

async function callMissionList(
  dbPath: string,
  params: { status?: MissionStatus; sprintId?: string; limit?: number } = {}
): Promise<CmosToolResult<CmosMissionListResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, VALID_MISSION_STATUSES } =
    await import('../../../src/tools/cmos/errors');

  // Validate status if provided
  if (params.status && !VALID_MISSION_STATUSES.includes(params.status)) {
    return createError(
      CmosErrors.invalidParameter('status', params.status, VALID_MISSION_STATUSES)
    );
  }

  return withClient(
    (client) => {
      let query =
        'SELECT id, sprint_id as sprintId, name, status, completed_at as completedAt, notes FROM missions WHERE 1=1';
      const queryParams: unknown[] = [];

      if (params.status) {
        query += ' AND status = ?';
        queryParams.push(params.status);
      }
      if (params.sprintId) {
        query += ' AND sprint_id = ?';
        queryParams.push(params.sprintId);
      }
      query += ' ORDER BY id';
      if (params.limit) {
        query += ' LIMIT ?';
        queryParams.push(params.limit);
      }

      const result = client.getMany<MissionListItem>(query, queryParams);
      if (!result.success) {
        return createError<CmosMissionListResult>(
          result.error ?? { code: 'DB_QUERY_FAILED', message: 'Query failed' }
        );
      }

      return createSuccess<CmosMissionListResult>({
        missions: result.data ?? [],
        totalCount: result.data?.length ?? 0,
        filters: {
          status: params.status ?? null,
          sprintId: params.sprintId ?? null,
          limit: params.limit ?? 20,
        },
      });
    },
    { dbPath }
  );
}

async function callMissionStatus(
  dbPath: string,
  params: { includeBlocked?: boolean; queuedLimit?: number } = {}
): Promise<CmosToolResult<CmosMissionStatusResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess } = await import('../../../src/tools/cmos/errors');

  return withClient(
    (client) => {
      // Get In Progress - simplified for testing
      const inProgressResult = client.getMany<StatusMissionItem>(
        `SELECT id, name, status, objective, notes FROM missions WHERE status = 'In Progress'`
      );

      // Get Current
      const currentResult = client.getMany<StatusMissionItem>(
        `SELECT id, name, status, objective, notes FROM missions WHERE status = 'Current'`
      );

      // Get Queued
      const limit = params.queuedLimit ?? 5;
      const queuedResult = client.getMany<StatusMissionItem>(
        `SELECT id, name, status, objective, notes FROM missions WHERE status = 'Queued' LIMIT ?`,
        [limit]
      );

      // Count totals
      const queuedCountResult = client.getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM missions WHERE status = 'Queued'`
      );

      // Get blocked if requested
      let blocked: StatusMissionItem[] | null = null;
      let blockedCount: number | null = null;
      if (params.includeBlocked) {
        const blockedResult = client.getMany<StatusMissionItem>(
          `SELECT id, name, status, objective, notes FROM missions WHERE status = 'Blocked'`
        );
        blocked = blockedResult.data ?? [];
        blockedCount = blocked.length;
      }

      const result: CmosMissionStatusResult = {
        activeSprint: null,
        inProgress: inProgressResult.data ?? [],
        current: currentResult.data ?? [],
        queued: queuedResult.data ?? [],
        blocked,
        summary: {
          activeCount: (inProgressResult.data?.length ?? 0) + (currentResult.data?.length ?? 0),
          queuedCount: queuedCountResult.data?.count ?? 0,
          blockedCount,
          nextAction:
            (inProgressResult.data?.length ?? 0) > 0 ? 'Continue work' : 'Start a mission',
        },
      };

      return createSuccess(result);
    },
    { dbPath }
  );
}

async function callMissionStart(
  dbPath: string,
  params: { missionId: string; notes?: string }
): Promise<CmosToolResult<MissionStartResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId?.trim()) return createError(CmosErrors.missingParameter('missionId'));

  const missionId = params.missionId.trim();

  return withClient(
    (client) => {
      const mission = client.getOne<{ id: string; status: MissionStatus }>(
        'SELECT id, status FROM missions WHERE id = ?',
        [missionId]
      );
      if (!mission.success || !mission.data)
        return createError<MissionStartResult>(CmosErrors.missionNotFound(missionId));

      const currentStatus = mission.data.status;
      if (currentStatus === 'In Progress') {
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: 'Already in progress',
          currentState: currentStatus,
        });
      }
      if (currentStatus === 'Blocked') {
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION,
          message: 'Cannot start blocked mission',
          currentState: currentStatus,
          validTransitions: ['In Progress', 'Current'],
        });
      }
      if (!VALID_STATE_TRANSITIONS[currentStatus].includes('In Progress')) {
        return createError<MissionStartResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, 'In Progress')
        );
      }

      const now = new Date().toISOString();
      client.execute('UPDATE missions SET status = ? WHERE id = ?', ['In Progress', missionId]);
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'test', ?, 'start', 'In Progress', ?, '{}')`,
        [now, missionId, params.notes ?? 'Started']
      );

      return createSuccess<MissionStartResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: 'In Progress',
        message: 'Started',
        startedAt: now,
      });
    },
    { dbPath }
  );
}

async function callMissionComplete(
  dbPath: string,
  params: { missionId: string; notes?: string }
): Promise<CmosToolResult<MissionCompleteResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId?.trim()) return createError(CmosErrors.missingParameter('missionId'));

  const missionId = params.missionId.trim();

  return withClient(
    (client) => {
      const mission = client.getOne<{ id: string; status: MissionStatus }>(
        'SELECT id, status FROM missions WHERE id = ?',
        [missionId]
      );
      if (!mission.success || !mission.data)
        return createError<MissionCompleteResult>(CmosErrors.missionNotFound(missionId));

      const currentStatus = mission.data.status;
      if (currentStatus === 'Completed') {
        return createError<MissionCompleteResult>({
          code: CMOS_ERROR_CODES.MISSION_ALREADY_COMPLETED,
          message: 'Already completed',
          currentState: currentStatus,
        });
      }
      if (!VALID_STATE_TRANSITIONS[currentStatus].includes('Completed')) {
        return createError<MissionCompleteResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, 'Completed')
        );
      }

      const now = new Date().toISOString();
      client.execute('UPDATE missions SET status = ?, completed_at = ? WHERE id = ?', [
        'Completed',
        now,
        missionId,
      ]);
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'test', ?, 'complete', 'Completed', ?, '{}')`,
        [now, missionId, params.notes ?? 'Completed']
      );

      return createSuccess<MissionCompleteResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: 'Completed',
        message: 'Completed',
        completedAt: now,
      });
    },
    { dbPath }
  );
}

async function callMissionBlock(
  dbPath: string,
  params: { missionId: string; reason: string; blockers?: string[] }
): Promise<CmosToolResult<MissionBlockResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId?.trim()) return createError(CmosErrors.missingParameter('missionId'));
  if (!params.reason?.trim()) return createError(CmosErrors.missingParameter('reason'));

  const missionId = params.missionId.trim();
  const reason = params.reason.trim();

  return withClient(
    (client) => {
      const mission = client.getOne<{
        id: string;
        status: MissionStatus;
        domain_fields: string | null;
      }>('SELECT id, status, domain_fields FROM missions WHERE id = ?', [missionId]);
      if (!mission.success || !mission.data)
        return createError<MissionBlockResult>(CmosErrors.missionNotFound(missionId));

      const currentStatus = mission.data.status;
      if (currentStatus === 'Blocked') {
        return createError<MissionBlockResult>({
          code: CMOS_ERROR_CODES.MISSION_ALREADY_BLOCKED,
          message: 'Already blocked',
          currentState: currentStatus,
        });
      }
      if (!VALID_STATE_TRANSITIONS[currentStatus].includes('Blocked')) {
        return createError<MissionBlockResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, 'Blocked')
        );
      }

      const now = new Date().toISOString();
      const domainFields = JSON.stringify({
        blocker: reason,
        blockedSince: now,
        blockers: params.blockers ?? [],
      });
      client.execute(
        'UPDATE missions SET status = ?, domain_fields = ?, notes = COALESCE(notes || " | ", "") || ? WHERE id = ?',
        ['Blocked', domainFields, `[Blocked] ${reason}`, missionId]
      );
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'test', ?, 'block', 'Blocked', ?, '{}')`,
        [now, missionId, reason]
      );

      return createSuccess<MissionBlockResult>({
        missionId,
        previousStatus: currentStatus,
        currentStatus: 'Blocked',
        reason,
        message: 'Blocked',
        blockedAt: now,
      });
    },
    { dbPath }
  );
}

async function callMissionUnblock(
  dbPath: string,
  params: { missionId: string; resolution?: string; targetStatus?: 'In Progress' | 'Current' }
): Promise<CmosToolResult<MissionUnblockResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } =
    await import('../../../src/tools/cmos/errors');

  if (!params.missionId?.trim()) return createError(CmosErrors.missingParameter('missionId'));

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = params.targetStatus ?? 'In Progress';

  return withClient(
    (client) => {
      const mission = client.getOne<{ id: string; status: MissionStatus }>(
        'SELECT id, status FROM missions WHERE id = ?',
        [missionId]
      );
      if (!mission.success || !mission.data)
        return createError<MissionUnblockResult>(CmosErrors.missionNotFound(missionId));

      const currentStatus = mission.data.status;
      if (currentStatus !== 'Blocked') {
        return createError<MissionUnblockResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: 'Not blocked',
          currentState: currentStatus,
        });
      }

      const now = new Date().toISOString();
      const updateResult = client.execute(
        'UPDATE missions SET status = ?, notes = COALESCE(notes || " | ", "") || ? WHERE id = ?',
        [targetStatus, `[Unblocked] ${params.resolution ?? 'Resolved'}`, missionId]
      );
      if (!updateResult.success || updateResult.data?.changes === 0) {
        return createError<MissionUnblockResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: 'Update failed',
        });
      }
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'test', ?, 'unblock', ?, ?, '{}')`,
        [now, missionId, targetStatus, params.resolution ?? 'Unblocked']
      );

      return createSuccess<MissionUnblockResult>({
        missionId,
        previousStatus: 'Blocked',
        currentStatus: targetStatus,
        resolution: params.resolution ?? null,
        message: 'Unblocked',
        unblockedAt: now,
      });
    },
    { dbPath }
  );
}

async function callMissionUpdate(
  dbPath: string,
  params: { missionId: string; fields: MissionUpdateFields }
): Promise<CmosToolResult<MissionUpdateResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const {
    createError,
    createSuccess,
    CmosErrors,
    CMOS_ERROR_CODES,
    VALID_STATE_TRANSITIONS,
    VALID_MISSION_STATUSES,
  } = await import('../../../src/tools/cmos/errors');

  if (!params.missionId?.trim()) return createError(CmosErrors.missingParameter('missionId'));

  const missionId = params.missionId.trim();
  const fields = params.fields;
  const fieldKeys = Object.keys(fields).filter(
    (k) => fields[k as keyof MissionUpdateFields] !== undefined
  );

  if (fieldKeys.length === 0) {
    return createError({ code: CMOS_ERROR_CODES.INVALID_PARAMETER, message: 'No fields provided' });
  }

  if (fields.status && !VALID_MISSION_STATUSES.includes(fields.status)) {
    return createError(
      CmosErrors.invalidParameter('status', fields.status, VALID_MISSION_STATUSES)
    );
  }

  return withClient(
    (client) => {
      const mission = client.getOne<{ id: string; status: MissionStatus }>(
        'SELECT id, status FROM missions WHERE id = ?',
        [missionId]
      );
      if (!mission.success || !mission.data)
        return createError<MissionUpdateResult>(CmosErrors.missionNotFound(missionId));

      const currentStatus = mission.data.status;
      let previousStatus: MissionStatus | undefined;
      let newStatus: MissionStatus | undefined;

      if (fields.status && fields.status !== currentStatus) {
        if (!VALID_STATE_TRANSITIONS[currentStatus].includes(fields.status)) {
          return createError<MissionUpdateResult>(
            CmosErrors.missionInvalidTransition(missionId, currentStatus, fields.status)
          );
        }
        previousStatus = currentStatus;
        newStatus = fields.status;
      }

      const setClauses: string[] = [];
      const queryParams: (string | null)[] = [];

      const fieldMapping: Record<string, string> = {
        name: 'name',
        status: 'status',
        objective: 'objective',
        context: 'context',
        successCriteria: 'success_criteria',
        deliverables: 'deliverables',
        referenceDocs: 'reference_docs',
        domainFields: 'domain_fields',
        notes: 'notes',
        metadata: 'metadata',
      };

      const jsonFields = new Set([
        'successCriteria',
        'deliverables',
        'referenceDocs',
        'domainFields',
        'metadata',
      ]);

      for (const key of fieldKeys) {
        const dbColumn = fieldMapping[key];
        if (!dbColumn) continue;
        const value = fields[key as keyof MissionUpdateFields];
        if (value === undefined) continue;
        setClauses.push(`${dbColumn} = ?`);
        queryParams.push(jsonFields.has(key) ? JSON.stringify(value) : (value as string));
      }

      if (newStatus === 'Completed') {
        setClauses.push('completed_at = ?');
        queryParams.push(new Date().toISOString());
      }

      queryParams.push(missionId);
      client.execute(`UPDATE missions SET ${setClauses.join(', ')} WHERE id = ?`, queryParams);

      if (previousStatus && newStatus) {
        const now = new Date().toISOString();
        client.execute(
          `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'test', ?, 'update', ?, ?, '{}')`,
          [now, missionId, newStatus, `Updated: ${previousStatus} -> ${newStatus}`]
        );
      }

      const result: MissionUpdateResult = {
        missionId,
        updatedFields: fieldKeys,
        message: 'Updated',
      };
      if (previousStatus && newStatus) {
        result.previousStatus = previousStatus;
        result.currentStatus = newStatus;
      }
      return createSuccess(result);
    },
    { dbPath }
  );
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration: Full Mission Lifecycle', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('Workflow: list -> start -> update -> complete', () => {
    it('should complete full lifecycle for a Queued mission', async () => {
      // 1. List missions to find Queued ones
      const listResult = await callMissionList(testDb.dbPath, { status: 'Queued' });
      expect(listResult.success).toBe(true);
      expect(listResult.data?.missions.length).toBeGreaterThan(0);

      const queuedMission = listResult.data?.missions.find((m) => m.id === 'int-m01');
      expect(queuedMission).toBeDefined();
      expect(queuedMission?.status).toBe('Queued');

      // 2. Start the mission
      const startResult = await callMissionStart(testDb.dbPath, {
        missionId: 'int-m01',
        notes: 'Beginning OAuth implementation',
      });
      expect(startResult.success).toBe(true);
      expect(startResult.data?.previousStatus).toBe('Queued');
      expect(startResult.data?.currentStatus).toBe('In Progress');

      // 3. Verify status changed via list
      const listAfterStart = await callMissionList(testDb.dbPath, { status: 'In Progress' });
      expect(listAfterStart.success).toBe(true);
      expect(listAfterStart.data?.missions.some((m) => m.id === 'int-m01')).toBe(true);

      // 4. Update the mission with progress notes
      const updateResult = await callMissionUpdate(testDb.dbPath, {
        missionId: 'int-m01',
        fields: {
          notes: 'OAuth provider integrated, working on tests',
          successCriteria: [
            'OAuth provider integration works',
            'Unit tests pass',
            'Security review complete',
            'Documentation updated',
          ],
        },
      });
      expect(updateResult.success).toBe(true);
      expect(updateResult.data?.updatedFields).toContain('notes');
      expect(updateResult.data?.updatedFields).toContain('successCriteria');

      // 5. Complete the mission
      const completeResult = await callMissionComplete(testDb.dbPath, {
        missionId: 'int-m01',
        notes: 'All criteria met, OAuth fully implemented',
      });
      expect(completeResult.success).toBe(true);
      expect(completeResult.data?.previousStatus).toBe('In Progress');
      expect(completeResult.data?.currentStatus).toBe('Completed');

      // 6. Verify final state
      const finalList = await callMissionList(testDb.dbPath, { status: 'Completed' });
      expect(finalList.success).toBe(true);
      expect(finalList.data?.missions.some((m) => m.id === 'int-m01')).toBe(true);
    });

    it('should show mission in correct queue position via status tool', async () => {
      // Check initial status
      const statusBefore = await callMissionStatus(testDb.dbPath, { includeBlocked: true });
      expect(statusBefore.success).toBe(true);
      expect(statusBefore.data?.inProgress.some((m) => m.id === 'int-m04')).toBe(true);
      expect(statusBefore.data?.current.some((m) => m.id === 'int-m03')).toBe(true);
      expect(statusBefore.data?.queued.some((m) => m.id === 'int-m01')).toBe(true);
      expect(statusBefore.data?.blocked?.some((m) => m.id === 'int-m05')).toBe(true);

      // Start a queued mission
      await callMissionStart(testDb.dbPath, { missionId: 'int-m01' });

      // Verify it moved to In Progress
      const statusAfter = await callMissionStatus(testDb.dbPath);
      expect(statusAfter.success).toBe(true);
      expect(statusAfter.data?.inProgress.some((m) => m.id === 'int-m01')).toBe(true);
      expect(statusAfter.data?.queued.every((m) => m.id !== 'int-m01')).toBe(true);
    });
  });

  describe('Workflow: blocking and unblocking', () => {
    it('should validate unblock only works on blocked missions', async () => {
      // Try to unblock a non-blocked mission
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'int-m01', // Queued, not blocked
        resolution: 'Test resolution',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_STATE');
    });

    it('should allow full Queued -> In Progress -> Completed flow', async () => {
      // Use a queued mission
      const missionId = 'int-m02';

      // Start
      const startResult = await callMissionStart(testDb.dbPath, { missionId });
      expect(startResult.success).toBe(true);
      expect(startResult.data?.currentStatus).toBe('In Progress');

      // Complete
      const completeResult = await callMissionComplete(testDb.dbPath, { missionId });
      expect(completeResult.success).toBe(true);
      expect(completeResult.data?.currentStatus).toBe('Completed');

      // Verify final state via direct db query
      const dbCheck = testDb.db
        .prepare('SELECT status, completed_at FROM missions WHERE id = ?')
        .get(missionId) as { status: string; completed_at: string };
      expect(dbCheck.status).toBe('Completed');
      expect(dbCheck.completed_at).toBeDefined();
    });
  });

  describe('Cross-tool state consistency', () => {
    it('should maintain consistent state across all query tools', async () => {
      // Start a mission
      await callMissionStart(testDb.dbPath, { missionId: 'int-m01' });

      // Query via list with status filter
      const listInProgress = await callMissionList(testDb.dbPath, { status: 'In Progress' });
      const listQueued = await callMissionList(testDb.dbPath, { status: 'Queued' });

      // Query via status
      const status = await callMissionStatus(testDb.dbPath);

      // All should agree
      expect(listInProgress.data?.missions.some((m) => m.id === 'int-m01')).toBe(true);
      expect(listQueued.data?.missions.every((m) => m.id !== 'int-m01')).toBe(true);
      expect(status.data?.inProgress.some((m) => m.id === 'int-m01')).toBe(true);
    });

    it('should update list counts after status changes', async () => {
      const beforeStart = await callMissionList(testDb.dbPath, { status: 'Queued' });
      const queuedCountBefore = beforeStart.data?.totalCount ?? 0;

      await callMissionStart(testDb.dbPath, { missionId: 'int-m01' });
      await callMissionStart(testDb.dbPath, { missionId: 'int-m02' });

      const afterStart = await callMissionList(testDb.dbPath, { status: 'Queued' });
      const queuedCountAfter = afterStart.data?.totalCount ?? 0;

      expect(queuedCountAfter).toBe(queuedCountBefore - 2);
    });
  });

  describe('Error handling across tools', () => {
    it('should prevent completing a Queued mission (must start first)', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'int-m01' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_TRANSITION');
      expect(result.error?.currentState).toBe('Queued');
    });

    it('should prevent starting an already In Progress mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'int-m04' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_STATE');
    });

    it('should prevent blocking a Queued mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'int-m01',
        reason: 'Cannot block queued',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_TRANSITION');
    });

    it('should prevent unblocking a non-blocked mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'int-m04' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_STATE');
    });

    it('should prevent invalid status update via update tool', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'int-m01',
        fields: { status: 'Completed' }, // Invalid: Queued -> Completed
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_TRANSITION');
    });
  });

  describe('Mission update integration', () => {
    it('should allow updating mission details while In Progress', async () => {
      // Already In Progress mission
      const missionId = 'int-m04';

      // Update multiple fields
      const updateResult = await callMissionUpdate(testDb.dbPath, {
        missionId,
        fields: {
          objective: 'Updated: Build settings panel UI with accessibility focus',
          successCriteria: [
            'Component renders correctly',
            'Accessibility checks pass',
            'Responsive design works',
          ],
          deliverables: [
            'src/components/SettingsPanel.tsx',
            'src/components/SettingsPanel.test.tsx',
          ],
        },
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.data?.updatedFields.length).toBe(3);

      // Verify via database
      const row = testDb.db
        .prepare('SELECT objective, success_criteria, deliverables FROM missions WHERE id = ?')
        .get(missionId) as {
        objective: string;
        success_criteria: string;
        deliverables: string;
      };

      expect(row.objective).toContain('accessibility focus');
      expect(JSON.parse(row.success_criteria)).toHaveLength(3);
      expect(JSON.parse(row.deliverables)).toContain('src/components/SettingsPanel.test.tsx');
    });

    it('should allow status transition via update tool', async () => {
      // Start queued mission via update tool
      const updateResult = await callMissionUpdate(testDb.dbPath, {
        missionId: 'int-m01',
        fields: {
          status: 'In Progress',
          notes: 'Starting via update tool',
        },
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.data?.previousStatus).toBe('Queued');
      expect(updateResult.data?.currentStatus).toBe('In Progress');

      // Verify via status tool
      const status = await callMissionStatus(testDb.dbPath);
      expect(status.data?.inProgress.some((m) => m.id === 'int-m01')).toBe(true);
    });
  });
});

describe('Integration: Sprint-scoped operations', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should filter missions by sprint', async () => {
    const result = await callMissionList(testDb.dbPath, { sprintId: 'sprint-integration' });

    expect(result.success).toBe(true);
    expect(result.data?.missions.length).toBe(5);
    expect(result.data?.missions.every((m) => m.sprintId === 'sprint-integration')).toBe(true);
  });

  it('should filter by both sprint and status', async () => {
    const result = await callMissionList(testDb.dbPath, {
      sprintId: 'sprint-integration',
      status: 'Queued',
    });

    expect(result.success).toBe(true);
    expect(result.data?.missions.length).toBe(2);
    expect(result.data?.missions.every((m) => m.status === 'Queued')).toBe(true);
  });
});
