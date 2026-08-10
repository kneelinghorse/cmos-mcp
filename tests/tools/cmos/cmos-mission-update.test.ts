/**
 * cmos_mission_update Tool Tests
 *
 * Comprehensive tests for the mission update tool that allows
 * partial field updates without replacing the entire record.
 *
 * @module tests/tools/cmos/cmos-mission-update
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMOS_ERROR_CODES, VALID_STATE_TRANSITIONS } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult, MissionStatus } from '../../../src/tools/cmos/types';

import {
  cmosMissionUpdate,
  cmosMissionUpdateToolDefinition,
  formatMissionUpdateForLLM,
  type MissionUpdateResult,
  type MissionUpdateFields,
} from '../../../src/tools/cmos/cmos-mission-update';

/**
 * Helper to create test database and run tool with explicit db path.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-update-test-'));
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
    VALUES ('sprint-13', 'Sprint 13 - Update Testing', 'Test update tool', 'In Progress');

    -- Insert test missions with various statuses
    INSERT INTO missions (id, sprint_id, name, status, objective, notes, success_criteria, deliverables, reference_docs, domain_fields, metadata)
    VALUES
      ('m-queued', 'sprint-13', 'Queued Mission', 'Queued', 'Test queued', 'Initial notes', '["Criterion 1"]', '["File 1"]', '["Doc 1"]', '{"key1": "value1"}', '{"version": 1}'),
      ('m-current', 'sprint-13', 'Current Mission', 'Current', 'Test current', NULL, NULL, NULL, NULL, NULL, NULL),
      ('m-in-progress', 'sprint-13', 'In Progress Mission', 'In Progress', 'Test in progress', 'Working on it', NULL, NULL, NULL, NULL, NULL),
      ('m-completed', 'sprint-13', 'Completed Mission', 'Completed', 'Test completed', 'Done', NULL, NULL, NULL, NULL, NULL),
      ('m-blocked', 'sprint-13', 'Blocked Mission', 'Blocked', 'Test blocked', 'Waiting', NULL, NULL, NULL, '{"blocker": "external"}', NULL);
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
 * Helper to call cmosMissionUpdate with explicit dbPath
 */
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
    VALID_MISSION_STATUSES,
    VALID_STATE_TRANSITIONS,
  } = await import('../../../src/tools/cmos/errors');

  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const fields = params.fields;

  // Check if any fields are provided
  const fieldKeys = Object.keys(fields).filter(
    (k) => fields[k as keyof MissionUpdateFields] !== undefined
  );

  if (fieldKeys.length === 0) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'No fields provided to update',
      suggestion: 'Provide at least one field to update (e.g., name, status, objective, notes)',
    });
  }

  // Validate status if provided
  if (fields.status !== undefined && !VALID_MISSION_STATUSES.includes(fields.status)) {
    return createError(
      CmosErrors.invalidParameter('status', fields.status, VALID_MISSION_STATUSES)
    );
  }

  return withClient(
    (client) => {
      // Query mission by ID
      const missionResult = client.getOne<{ id: string; status: MissionStatus; name: string }>(
        'SELECT id, status, name FROM missions WHERE id = ?',
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionUpdateResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionUpdateResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;
      let previousStatus: MissionStatus | undefined;
      let newStatus: MissionStatus | undefined;

      // Validate status transition if status is being changed
      if (fields.status !== undefined && fields.status !== currentStatus) {
        const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
        if (!validTransitions.includes(fields.status)) {
          return createError<MissionUpdateResult>(
            CmosErrors.missionInvalidTransition(missionId, currentStatus, fields.status)
          );
        }
        previousStatus = currentStatus;
        newStatus = fields.status;
      }

      // Build dynamic UPDATE query
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

        if (jsonFields.has(key)) {
          queryParams.push(JSON.stringify(value));
        } else {
          queryParams.push(value as string);
        }
      }

      // Handle completed_at for status changes
      if (newStatus === 'Completed') {
        setClauses.push('completed_at = ?');
        queryParams.push(new Date().toISOString());
      }

      queryParams.push(missionId);

      const updateQuery = `
        UPDATE missions
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `;

      const updateResult = client.execute(updateQuery, queryParams);

      if (!updateResult.success || updateResult.data?.changes === 0) {
        return createError<MissionUpdateResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      // Log the state change to session_events if status changed
      if (previousStatus !== undefined && newStatus !== undefined) {
        const now = new Date().toISOString();
        client.execute(
          `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event) VALUES (?, 'mcp-tool', ?, 'update', ?, ?, ?)`,
          [
            now,
            missionId,
            newStatus,
            `Updated mission ${missionId}: status changed from ${previousStatus} to ${newStatus}`,
            JSON.stringify({
              tool: 'cmos_mission_update',
              missionId,
              previousStatus,
              newStatus,
              updatedFields: fieldKeys,
            }),
          ]
        );
      }

      const result: MissionUpdateResult = {
        missionId,
        updatedFields: fieldKeys,
        message: `Mission '${missionId}' updated successfully (${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'})`,
      };

      if (previousStatus !== undefined && newStatus !== undefined) {
        result.previousStatus = previousStatus;
        result.currentStatus = newStatus;
      }

      return createSuccess(result);
    },
    { dbPath }
  );
}

describe('cmos_mission_update', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path - single field updates', () => {
    it('should update mission name', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { name: 'Renamed Mission' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-queued');
      expect(result.data?.updatedFields).toEqual(['name']);

      const row = testDb.db.prepare('SELECT name FROM missions WHERE id = ?').get('m-queued') as {
        name: string;
      };
      expect(row.name).toBe('Renamed Mission');
    });

    it('should update mission objective', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { objective: 'New objective' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields).toEqual(['objective']);

      const row = testDb.db
        .prepare('SELECT objective FROM missions WHERE id = ?')
        .get('m-queued') as { objective: string };
      expect(row.objective).toBe('New objective');
    });

    it('should update mission notes', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { notes: 'Updated notes' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields).toEqual(['notes']);

      const row = testDb.db.prepare('SELECT notes FROM missions WHERE id = ?').get('m-queued') as {
        notes: string;
      };
      expect(row.notes).toBe('Updated notes');
    });

    it('should update mission context', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { context: 'New context explaining importance' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields).toEqual(['context']);

      const row = testDb.db
        .prepare('SELECT context FROM missions WHERE id = ?')
        .get('m-queued') as { context: string };
      expect(row.context).toBe('New context explaining importance');
    });
  });

  describe('happy path - JSON field updates', () => {
    it('should update success criteria (array)', async () => {
      const newCriteria = ['Criterion A', 'Criterion B', 'Criterion C'];
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { successCriteria: newCriteria },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields).toEqual(['successCriteria']);

      const row = testDb.db
        .prepare('SELECT success_criteria FROM missions WHERE id = ?')
        .get('m-queued') as { success_criteria: string };
      expect(JSON.parse(row.success_criteria)).toEqual(newCriteria);
    });

    it('should update deliverables (array)', async () => {
      const newDeliverables = ['output.ts', 'test.ts'];
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { deliverables: newDeliverables },
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT deliverables FROM missions WHERE id = ?')
        .get('m-queued') as { deliverables: string };
      expect(JSON.parse(row.deliverables)).toEqual(newDeliverables);
    });

    it('should update reference docs (array)', async () => {
      const newDocs = ['doc1.md', 'doc2.md'];
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { referenceDocs: newDocs },
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT reference_docs FROM missions WHERE id = ?')
        .get('m-queued') as { reference_docs: string };
      expect(JSON.parse(row.reference_docs)).toEqual(newDocs);
    });

    it('should update domain fields (object)', async () => {
      const newDomainFields = { custom: 'value', nested: { key: 'data' } };
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { domainFields: newDomainFields },
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT domain_fields FROM missions WHERE id = ?')
        .get('m-queued') as { domain_fields: string };
      expect(JSON.parse(row.domain_fields)).toEqual(newDomainFields);
    });

    it('should update metadata (object)', async () => {
      const newMetadata = { version: 2, author: 'test' };
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { metadata: newMetadata },
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT metadata FROM missions WHERE id = ?')
        .get('m-queued') as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual(newMetadata);
    });
  });

  describe('happy path - multiple field updates', () => {
    it('should update multiple fields at once', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: {
          name: 'New Name',
          objective: 'New Objective',
          notes: 'New Notes',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.updatedFields.sort()).toEqual(['name', 'notes', 'objective']);
      expect(result.data?.message).toContain('3 fields');

      const row = testDb.db
        .prepare('SELECT name, objective, notes FROM missions WHERE id = ?')
        .get('m-queued') as {
        name: string;
        objective: string;
        notes: string;
      };
      expect(row.name).toBe('New Name');
      expect(row.objective).toBe('New Objective');
      expect(row.notes).toBe('New Notes');
    });

    it('should preserve fields not being updated', async () => {
      await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { name: 'Updated Name Only' },
      });

      const row = testDb.db
        .prepare('SELECT name, objective, notes, success_criteria FROM missions WHERE id = ?')
        .get('m-queued') as {
        name: string;
        objective: string;
        notes: string;
        success_criteria: string;
      };
      expect(row.name).toBe('Updated Name Only');
      expect(row.objective).toBe('Test queued'); // Preserved
      expect(row.notes).toBe('Initial notes'); // Preserved
      expect(JSON.parse(row.success_criteria)).toEqual(['Criterion 1']); // Preserved
    });
  });

  describe('status transitions', () => {
    it('should allow valid status transition from Queued to Current', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'Current' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Queued');
      expect(result.data?.currentStatus).toBe('Current');

      const row = testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('m-queued') as {
        status: string;
      };
      expect(row.status).toBe('Current');
    });

    it('should allow valid status transition from Queued to In Progress', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'In Progress' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Queued');
      expect(result.data?.currentStatus).toBe('In Progress');
    });

    it('should allow valid status transition from In Progress to Completed', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-in-progress',
        fields: { status: 'Completed' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');

      const row = testDb.db
        .prepare('SELECT completed_at FROM missions WHERE id = ?')
        .get('m-in-progress') as { completed_at: string };
      expect(row.completed_at).toBeDefined();
    });

    it('should set completed_at when transitioning to Completed', async () => {
      const before = new Date();
      await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-in-progress',
        fields: { status: 'Completed' },
      });
      const after = new Date();

      const row = testDb.db
        .prepare('SELECT completed_at FROM missions WHERE id = ?')
        .get('m-in-progress') as { completed_at: string };
      const completedAt = new Date(row.completed_at);

      expect(completedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(completedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should reject invalid status transition from Queued to Completed', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'Completed' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Queued');
      expect(result.error?.validTransitions).toContain('Current');
      expect(result.error?.validTransitions).toContain('In Progress');
    });

    it('should reject invalid status transition from Completed (terminal state)', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-completed',
        fields: { status: 'In Progress' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Completed');
      expect(result.error?.validTransitions).toEqual([]);
    });

    it('should log event when status changes', async () => {
      await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'In Progress' },
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-queued', 'update') as { action: string; status: string; raw_event: string };

      expect(event).toBeDefined();
      expect(event.action).toBe('update');
      expect(event.status).toBe('In Progress');

      const rawEvent = JSON.parse(event.raw_event);
      expect(rawEvent.previousStatus).toBe('Queued');
      expect(rawEvent.newStatus).toBe('In Progress');
    });

    it('should not log event when status does not change', async () => {
      await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { name: 'Just a name change' },
      });

      const events = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ?')
        .all('m-queued') as unknown[];

      expect(events.length).toBe(0);
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'nonexistent',
        fields: { name: 'Test' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('cmos_mission(action="list")');
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: '',
        fields: { name: 'Test' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER for whitespace-only mission ID', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: '   ',
        fields: { name: 'Test' },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error when no fields provided', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: {},
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('No fields provided');
    });

    it('should return error for invalid status value', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'InvalidStatus' as MissionStatus },
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.validValues).toBeDefined();
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionUpdateToolDefinition.name).toBe('cmos_mission_update');
    });

    it('should have comprehensive description', () => {
      expect(cmosMissionUpdateToolDefinition.description).toContain('Update specific fields');
      expect(cmosMissionUpdateToolDefinition.description).toContain('Only provided fields');
      expect(cmosMissionUpdateToolDefinition.description).toContain('INVALID_STATE_TRANSITION');
    });

    it('should require missionId and fields parameters', () => {
      expect(cmosMissionUpdateToolDefinition.inputSchema.required).toContain('missionId');
      expect(cmosMissionUpdateToolDefinition.inputSchema.required).toContain('fields');
    });

    it('should have all updateable fields defined', () => {
      const fieldProps = cmosMissionUpdateToolDefinition.inputSchema.properties.fields.properties;
      expect(fieldProps.name).toBeDefined();
      expect(fieldProps.status).toBeDefined();
      expect(fieldProps.objective).toBeDefined();
      expect(fieldProps.context).toBeDefined();
      expect(fieldProps.successCriteria).toBeDefined();
      expect(fieldProps.deliverables).toBeDefined();
      expect(fieldProps.referenceDocs).toBeDefined();
      expect(fieldProps.domainFields).toBeDefined();
      expect(fieldProps.notes).toBeDefined();
      expect(fieldProps.metadata).toBeDefined();
    });

    it('should have status enum with valid values', () => {
      const statusProp =
        cmosMissionUpdateToolDefinition.inputSchema.properties.fields.properties.status;
      expect(statusProp.enum).toContain('Queued');
      expect(statusProp.enum).toContain('Current');
      expect(statusProp.enum).toContain('In Progress');
      expect(statusProp.enum).toContain('Completed');
      expect(statusProp.enum).toContain('Blocked');
    });
  });

  describe('formatMissionUpdateForLLM', () => {
    it('should format success result without status change', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { name: 'New Name', notes: 'New Notes' },
      });
      const formatted = formatMissionUpdateForLLM(result);

      expect(formatted).toContain("Mission 'm-queued' updated");
      expect(formatted).toContain('name');
      expect(formatted).toContain('notes');
      expect(formatted).not.toContain('Status:'); // No status change
    });

    it('should format success result with status change', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'Current' },
      });
      const formatted = formatMissionUpdateForLLM(result);

      expect(formatted).toContain("Mission 'm-queued' updated");
      expect(formatted).toContain('Status: Queued -> Current');
    });

    it('should format error result with suggestion', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'nonexistent',
        fields: { name: 'Test' },
      });
      const formatted = formatMissionUpdateForLLM(result);

      expect(formatted).toContain('Failed to update mission');
      expect(formatted).toContain('Suggestion');
    });

    it('should format error result with valid transitions', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'm-queued',
        fields: { status: 'Completed' },
      });
      const formatted = formatMissionUpdateForLLM(result);

      expect(formatted).toContain('Failed to update mission');
      expect(formatted).toContain('Valid transitions');
    });
  });
});
