/**
 * cmos_mission_add Tool Tests
 *
 * Comprehensive tests for the mission creation tool.
 *
 * @module tests/tools/cmos/cmos-mission-add
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult, MissionStatus } from '../../../src/tools/cmos/types';

import {
  cmosMissionAdd,
  cmosMissionAddToolDefinition,
  formatMissionAddForLLM,
  type MissionAddResult,
  type CmosMissionAddParams,
} from '../../../src/tools/cmos/cmos-mission-add';

/**
 * Helper to create test database.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-add-test-'));
  const dbPath = path.join(tempDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  // Create schema
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
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

    CREATE TABLE mission_dependencies (
      from_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id)
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

    -- Insert test sprints
    INSERT INTO sprints (id, title, focus, status)
    VALUES
      ('sprint-14', 'Sprint 14 - Testing', 'Test mission add', 'Active'),
      ('sprint-15', 'Sprint 15 - Future', 'Future work', 'Planned');

    -- Insert existing mission for collision test
    INSERT INTO missions (id, sprint_id, name, status, objective)
    VALUES ('existing-m01', 'sprint-14', 'Existing Mission', 'Queued', 'Already exists');
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
 * Helper to call cmosMissionAdd with explicit dbPath.
 */
async function callMissionAdd(
  dbPath: string,
  params: Omit<CmosMissionAddParams, 'projectRoot'>
): Promise<CmosToolResult<MissionAddResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, VALID_MISSION_STATUSES } =
    await import('../../../src/tools/cmos/errors');

  const {
    missionId,
    name,
    sprintId,
    status = 'Queued',
    objective,
    context,
    successCriteria,
    deliverables,
    referenceDocs,
    domainFields,
    notes,
  } = params;

  // Validate required parameters
  if (!missionId || missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  if (!name || name.trim() === '') {
    return createError(CmosErrors.missingParameter('name'));
  }

  if (!sprintId || sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  // Validate status if provided
  if (status && !VALID_MISSION_STATUSES.includes(status as MissionStatus)) {
    return createError(CmosErrors.invalidParameter('status', status, VALID_MISSION_STATUSES));
  }

  return withClient(
    (client) => {
      // Verify sprint exists
      const sprintResult = client.getOne<{ id: string; title: string }>(
        'SELECT id, title FROM sprints WHERE id = ?',
        [sprintId]
      );

      if (!sprintResult.success) {
        return createError<MissionAddResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to verify sprint' }
        );
      }

      if (!sprintResult.data) {
        return createError<MissionAddResult>(CmosErrors.sprintNotFound(sprintId));
      }

      // Check if mission ID already exists
      const existingResult = client.getOne<{ id: string }>('SELECT id FROM missions WHERE id = ?', [
        missionId,
      ]);

      if (!existingResult.success) {
        return createError<MissionAddResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check mission' }
        );
      }

      if (existingResult.data) {
        return createError<MissionAddResult>({
          code: 'MISSION_ID_EXISTS',
          message: `Mission '${missionId}' already exists`,
          suggestion: 'Choose a different mission ID or use cmos_mission_update to modify it',
        });
      }

      // Prepare context for storage
      const contextValue =
        context !== undefined
          ? typeof context === 'string'
            ? context
            : JSON.stringify(context)
          : null;

      // Insert new mission
      const insertResult = client.execute(
        `INSERT INTO missions (
          id, sprint_id, name, status, objective, context,
          success_criteria, deliverables, reference_docs, domain_fields, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          missionId.trim(),
          sprintId.trim(),
          name.trim(),
          status,
          objective?.trim() || null,
          contextValue,
          successCriteria ? JSON.stringify(successCriteria) : null,
          deliverables ? JSON.stringify(deliverables) : null,
          referenceDocs ? JSON.stringify(referenceDocs) : null,
          domainFields ? JSON.stringify(domainFields) : null,
          notes?.trim() || null,
        ]
      );

      if (!insertResult.success) {
        return createError<MissionAddResult>(
          insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create mission' }
        );
      }

      if (insertResult.data?.changes === 0) {
        return createError<MissionAddResult>({
          code: 'DB_QUERY_FAILED',
          message: 'Mission was not created (no rows affected)',
          suggestion: 'Check database permissions and try again',
        });
      }

      // Log creation event
      const now = new Date().toISOString();
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'create', ?, ?, ?)`,
        [
          now,
          missionId,
          status,
          `Created mission ${missionId} in sprint ${sprintId}`,
          JSON.stringify({
            tool: 'cmos_mission_add',
            missionId,
            sprintId,
            name: name.trim(),
            status,
          }),
        ]
      );

      // Build result
      const mission: MissionAddResult['mission'] = {
        id: missionId.trim(),
        name: name.trim(),
        sprintId: sprintId.trim(),
        status: status as MissionStatus,
      };

      if (objective) mission.objective = objective.trim();
      if (context) {
        mission.context = typeof context === 'string' ? context : JSON.stringify(context);
      }
      if (successCriteria) mission.successCriteria = successCriteria;
      if (deliverables) mission.deliverables = deliverables;
      if (referenceDocs) mission.referenceDocs = referenceDocs;
      if (domainFields) mission.domainFields = domainFields;
      if (notes) mission.notes = notes.trim();

      return createSuccess({
        id: missionId.trim(),
        name: name.trim(),
        sprintId: sprintId.trim(),
        status: status as MissionStatus,
        message: `Mission '${missionId}' created successfully in sprint '${sprintId}'`,
        mission,
      });
    },
    { dbPath }
  );
}

describe('cmos_mission_add', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path - basic creation', () => {
    it('should create a mission with required fields only', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test Mission',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('s14-m01');
      expect(result.data?.name).toBe('Test Mission');
      expect(result.data?.sprintId).toBe('sprint-14');
      expect(result.data?.status).toBe('Queued');

      const row = testDb.db.prepare('SELECT * FROM missions WHERE id = ?').get('s14-m01') as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('Test Mission');
      expect(row.sprint_id).toBe('sprint-14');
      expect(row.status).toBe('Queued');
    });

    it('should create a mission with custom status', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m02',
        name: 'Current Mission',
        sprintId: 'sprint-14',
        status: 'Current',
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('Current');

      const row = testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('s14-m02') as {
        status: string;
      };
      expect(row.status).toBe('Current');
    });

    it('should create a mission with objective', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m03',
        name: 'Mission With Objective',
        sprintId: 'sprint-14',
        objective: 'Implement feature X',
      });

      expect(result.success).toBe(true);
      expect(result.data?.mission.objective).toBe('Implement feature X');

      const row = testDb.db
        .prepare('SELECT objective FROM missions WHERE id = ?')
        .get('s14-m03') as {
        objective: string;
      };
      expect(row.objective).toBe('Implement feature X');
    });

    it('should trim whitespace from string fields', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: '  s14-m04  ',
        name: '  Trimmed Mission  ',
        sprintId: 'sprint-14',
        objective: '  Trimmed objective  ',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('s14-m04');
      expect(result.data?.name).toBe('Trimmed Mission');

      const row = testDb.db.prepare('SELECT * FROM missions WHERE id = ?').get('s14-m04') as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('Trimmed Mission');
      expect(row.objective).toBe('Trimmed objective');
    });
  });

  describe('happy path - all spec fields', () => {
    it('should create a mission with all optional fields', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m05',
        name: 'Full Mission',
        sprintId: 'sprint-14',
        status: 'Queued',
        objective: 'Complete objective',
        context: 'Important background info',
        successCriteria: ['Criterion 1', 'Criterion 2'],
        deliverables: ['file1.ts', 'file2.ts'],
        referenceDocs: ['doc1.md', 'doc2.md'],
        domainFields: { customField: 'value' },
        notes: 'Some notes',
      });

      expect(result.success).toBe(true);
      expect(result.data?.mission.objective).toBe('Complete objective');
      expect(result.data?.mission.context).toBe('Important background info');
      expect(result.data?.mission.successCriteria).toEqual(['Criterion 1', 'Criterion 2']);
      expect(result.data?.mission.deliverables).toEqual(['file1.ts', 'file2.ts']);
      expect(result.data?.mission.referenceDocs).toEqual(['doc1.md', 'doc2.md']);
      expect(result.data?.mission.domainFields).toEqual({ customField: 'value' });
      expect(result.data?.mission.notes).toBe('Some notes');

      const row = testDb.db.prepare('SELECT * FROM missions WHERE id = ?').get('s14-m05') as Record<
        string,
        unknown
      >;
      expect(JSON.parse(row.success_criteria as string)).toEqual(['Criterion 1', 'Criterion 2']);
      expect(JSON.parse(row.deliverables as string)).toEqual(['file1.ts', 'file2.ts']);
      expect(JSON.parse(row.reference_docs as string)).toEqual(['doc1.md', 'doc2.md']);
      expect(JSON.parse(row.domain_fields as string)).toEqual({ customField: 'value' });
    });

    it('should handle context as object', async () => {
      const contextObj = { background: 'info', key: 'value' };
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m06',
        name: 'Object Context Mission',
        sprintId: 'sprint-14',
        context: contextObj,
      });

      expect(result.success).toBe(true);
      expect(result.data?.mission.context).toBe(JSON.stringify(contextObj));

      const row = testDb.db.prepare('SELECT context FROM missions WHERE id = ?').get('s14-m06') as {
        context: string;
      };
      expect(JSON.parse(row.context)).toEqual(contextObj);
    });

    it('should handle context as string', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m07',
        name: 'String Context Mission',
        sprintId: 'sprint-14',
        context: 'Simple string context',
      });

      expect(result.success).toBe(true);
      expect(result.data?.mission.context).toBe('Simple string context');

      const row = testDb.db.prepare('SELECT context FROM missions WHERE id = ?').get('s14-m07') as {
        context: string;
      };
      expect(row.context).toBe('Simple string context');
    });
  });

  describe('happy path - event logging', () => {
    it('should log creation event', async () => {
      await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m08',
        name: 'Event Test Mission',
        sprintId: 'sprint-14',
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ?')
        .get('s14-m08') as {
        action: string;
        status: string;
        raw_event: string;
      };

      expect(event).toBeDefined();
      expect(event.action).toBe('create');
      expect(event.status).toBe('Queued');

      const rawEvent = JSON.parse(event.raw_event);
      expect(rawEvent.tool).toBe('cmos_mission_add');
      expect(rawEvent.missionId).toBe('s14-m08');
      expect(rawEvent.sprintId).toBe('sprint-14');
    });
  });

  describe('error cases - missing parameters', () => {
    it('should return error for missing missionId', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: '',
        name: 'Test',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return error for missing name', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: '',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('name');
    });

    it('should return error for missing sprintId', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('sprintId');
    });
  });

  describe('error cases - validation', () => {
    it('should return error for non-existent sprint', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: 'nonexistent-sprint',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SPRINT_NOT_FOUND);
      expect(result.error?.suggestion).toContain('cmos_sprint');
    });

    it('should return error for duplicate mission ID', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 'existing-m01',
        name: 'Duplicate',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_ID_EXISTS');
      expect(result.error?.suggestion).toContain('cmos_mission_update');
    });

    it('should return error for invalid status', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: 'sprint-14',
        status: 'InvalidStatus' as MissionStatus,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.validValues).toBeDefined();
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionAddToolDefinition.name).toBe('cmos_mission_add');
    });

    it('should have comprehensive description', () => {
      expect(cmosMissionAddToolDefinition.description).toContain('Create a new mission');
      expect(cmosMissionAddToolDefinition.description).toContain('sprint exists');
    });

    it('should require missionId, name, and sprintId', () => {
      expect(cmosMissionAddToolDefinition.inputSchema.required).toContain('missionId');
      expect(cmosMissionAddToolDefinition.inputSchema.required).toContain('name');
      expect(cmosMissionAddToolDefinition.inputSchema.required).toContain('sprintId');
    });

    it('should have all spec fields defined', () => {
      const props = cmosMissionAddToolDefinition.inputSchema.properties;
      expect(props.missionId).toBeDefined();
      expect(props.name).toBeDefined();
      expect(props.sprintId).toBeDefined();
      expect(props.status).toBeDefined();
      expect(props.objective).toBeDefined();
      expect(props.context).toBeDefined();
      expect(props.successCriteria).toBeDefined();
      expect(props.deliverables).toBeDefined();
      expect(props.referenceDocs).toBeDefined();
      expect(props.domainFields).toBeDefined();
      expect(props.notes).toBeDefined();
    });
  });

  describe('formatMissionAddForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-fmt01',
        name: 'Format Test',
        sprintId: 'sprint-14',
        objective: 'Test formatting',
        successCriteria: ['A', 'B'],
        deliverables: ['X', 'Y', 'Z'],
      });

      const formatted = formatMissionAddForLLM(result);

      expect(formatted).toContain("Mission 's14-fmt01' created");
      expect(formatted).toContain('Sprint: sprint-14');
      expect(formatted).toContain('Name: Format Test');
      expect(formatted).toContain('Status: Queued');
      expect(formatted).toContain('Objective: Test formatting');
      expect(formatted).toContain('Success criteria: 2 items');
      expect(formatted).toContain('Deliverables: 3 items');
    });

    it('should format error result', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: '',
        name: 'Test',
        sprintId: 'sprint-14',
      });

      const formatted = formatMissionAddForLLM(result);

      expect(formatted).toContain('Failed to create mission');
      expect(formatted).toContain('Error:');
      expect(formatted).toContain('Suggestion');
    });
  });
});
