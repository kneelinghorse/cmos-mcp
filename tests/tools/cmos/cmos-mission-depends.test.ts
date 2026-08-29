/**
 * cmos_mission_depends Tool Tests
 *
 * Comprehensive tests for the mission dependency creation tool.
 *
 * @module tests/tools/cmos/cmos-mission-depends
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

import {
  cmosMissionDepends,
  cmosMissionDependsToolDefinition,
  formatMissionDependsForLLM,
  VALID_DEPENDENCY_TYPES,
  type MissionDependsResult,
  type CmosMissionDependsParams,
  type DependencyType,
} from '../../../src/tools/cmos/cmos-mission-depends';

const EXPECTED_DEPENDENCY_DISCLOSURE =
  'Dependency relationships are recorded for ordering and graph expansion; they are not enforced at mission start or completion.';

/**
 * Helper to create test database.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-depends-test-'));
  const dbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
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

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT INTO metadata (key, value)
    VALUES ('project_id', 'depends-test-project'),
           ('project_name', 'Depends Test Project');

    -- Insert test sprint
    INSERT INTO sprints (id, title, focus, status)
    VALUES ('sprint-14', 'Sprint 14 - Testing', 'Test dependencies', 'Active');

    -- Insert test missions
    INSERT INTO missions (id, sprint_id, name, status, objective)
    VALUES
      ('m-01', 'sprint-14', 'Mission 1', 'Queued', 'First mission'),
      ('m-02', 'sprint-14', 'Mission 2', 'Queued', 'Second mission'),
      ('m-03', 'sprint-14', 'Mission 3', 'Queued', 'Third mission'),
      ('m-04', 'sprint-14', 'Mission 4', 'Queued', 'Fourth mission');

    -- Insert existing dependency for collision test
    INSERT INTO mission_dependencies (from_id, to_id, type)
    VALUES ('m-01', 'm-02', 'Requires');
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
 * Helper to call cmosMissionDepends with explicit dbPath.
 */
async function callMissionDepends(
  dbPath: string,
  params: Omit<CmosMissionDependsParams, 'projectRoot'>
): Promise<CmosToolResult<MissionDependsResult>> {
  const projectRoot = path.resolve(path.dirname(dbPath), '..', '..');
  return cmosMissionDepends({ ...params, projectRoot });
}

describe('cmos_mission_depends', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path - dependency creation', () => {
    it.each([
      { fromId: 'm-02', toId: 'm-03', type: 'Blocks' },
      { fromId: 'm-03', toId: 'm-04', type: 'Requires' },
      { fromId: 'm-02', toId: 'm-04', type: 'Enables' },
    ] as const)('should create a $type dependency with an honest receipt', async (params) => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: params.fromId,
        toId: params.toId,
        type: params.type,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(params);
      expect(result.data?.message).toContain(params.type);
      expect(result.data?.message).toContain(EXPECTED_DEPENDENCY_DISCLOSURE);

      const row = testDb.db
        .prepare('SELECT * FROM mission_dependencies WHERE from_id = ? AND to_id = ?')
        .get(params.fromId, params.toId) as { type: string };
      expect(row.type).toBe(params.type);
    });

    it('should trim whitespace from mission IDs', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: '  m-03  ',
        toId: '  m-04  ',
        type: 'Blocks',
      });

      expect(result.success).toBe(true);
      expect(result.data?.fromId).toBe('m-03');
      expect(result.data?.toId).toBe('m-04');

      const row = testDb.db
        .prepare('SELECT * FROM mission_dependencies WHERE from_id = ? AND to_id = ?')
        .get('m-03', 'm-04');
      expect(row).toBeDefined();
    });
  });

  describe('happy path - event logging', () => {
    it('should log dependency creation event', async () => {
      await callMissionDepends(testDb.dbPath, {
        fromId: 'm-03',
        toId: 'm-04',
        type: 'Requires',
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE action = ?')
        .get('dependency') as {
        status: string;
        summary: string;
        raw_event: string;
      };

      expect(event).toBeDefined();
      expect(event.status).toBe('dependency_created');
      expect(event.summary).toContain('m-03');
      expect(event.summary).toContain('m-04');
      expect(event.summary).toContain('Requires');

      const rawEvent = JSON.parse(event.raw_event);
      expect(rawEvent.tool).toBe('cmos_mission_depends');
      expect(rawEvent.fromId).toBe('m-03');
      expect(rawEvent.toId).toBe('m-04');
      expect(rawEvent.type).toBe('Requires');
    });
  });

  describe('error cases - missing parameters', () => {
    it('should return error for missing fromId', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: '',
        toId: 'm-02',
        type: 'Blocks',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('fromId');
    });

    it('should return error for missing toId', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-01',
        toId: '',
        type: 'Blocks',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('toId');
    });

    it('should return error for missing type', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-01',
        toId: 'm-02',
        type: undefined as unknown as DependencyType,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('type');
    });
  });

  describe('error cases - validation', () => {
    it('should return error for non-existent fromId mission', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'nonexistent',
        toId: 'm-02',
        type: 'Blocks',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return error for non-existent toId mission', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-01',
        toId: 'nonexistent',
        type: 'Blocks',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return error for duplicate dependency', async () => {
      // m-01 -> m-02 already exists in setup
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-01',
        toId: 'm-02',
        type: 'Blocks', // Different type, same pair
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('already exists');
    });

    it('should return error for self-dependency', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-01',
        toId: 'm-01',
        type: 'Blocks',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('cannot depend on itself');
    });

    it('should return error for invalid dependency type', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-01',
        toId: 'm-03',
        type: 'InvalidType' as DependencyType,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.validValues).toContain('Blocks');
      expect(result.error?.validValues).toContain('Requires');
      expect(result.error?.validValues).toContain('Enables');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionDependsToolDefinition.name).toBe('cmos_mission_depends');
    });

    it('should have comprehensive description', () => {
      expect(cmosMissionDependsToolDefinition.description).toContain('dependency');
      expect(cmosMissionDependsToolDefinition.description).toContain('Validates');
      expect(cmosMissionDependsToolDefinition.description).toContain('Blocks');
      expect(cmosMissionDependsToolDefinition.description).toContain('Requires');
      expect(cmosMissionDependsToolDefinition.description).toContain('Enables');
      expect(cmosMissionDependsToolDefinition.description).toContain(
        EXPECTED_DEPENDENCY_DISCLOSURE
      );
    });

    it('should require fromId, toId, and type', () => {
      expect(cmosMissionDependsToolDefinition.inputSchema.required).toContain('fromId');
      expect(cmosMissionDependsToolDefinition.inputSchema.required).toContain('toId');
      expect(cmosMissionDependsToolDefinition.inputSchema.required).toContain('type');
    });

    it('should have type enum with valid values', () => {
      const typeProp = cmosMissionDependsToolDefinition.inputSchema.properties.type;
      expect(typeProp.enum).toContain('Blocks');
      expect(typeProp.enum).toContain('Requires');
      expect(typeProp.enum).toContain('Enables');
    });
  });

  describe('formatMissionDependsForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: 'm-03',
        toId: 'm-04',
        type: 'Blocks',
      });

      const formatted = formatMissionDependsForLLM(result);

      expect(formatted).toContain('Dependency created');
      expect(formatted).toContain('From: m-03');
      expect(formatted).toContain('To: m-04');
      expect(formatted).toContain('Type: Blocks');
      expect(formatted).toContain(EXPECTED_DEPENDENCY_DISCLOSURE);
    });

    it('should format error result', async () => {
      const result = await callMissionDepends(testDb.dbPath, {
        fromId: '',
        toId: 'm-02',
        type: 'Blocks',
      });

      const formatted = formatMissionDependsForLLM(result);

      expect(formatted).toContain('Failed to create mission dependency');
      expect(formatted).toContain('Error:');
      expect(formatted).toContain('Suggestion');
    });
  });

  describe('VALID_DEPENDENCY_TYPES export', () => {
    it('should export valid dependency types', () => {
      expect(VALID_DEPENDENCY_TYPES).toContain('Blocks');
      expect(VALID_DEPENDENCY_TYPES).toContain('Requires');
      expect(VALID_DEPENDENCY_TYPES).toContain('Enables');
      expect(VALID_DEPENDENCY_TYPES.length).toBe(3);
    });
  });
});
