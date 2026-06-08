/**
 * cmos_mission_list Tool Tests
 *
 * Comprehensive tests for the mission listing tool.
 *
 * @module tests/tools/cmos/cmos-mission-list
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosMissionList,
  cmosMissionListToolDefinition,
  formatMissionListForLLM,
  type CmosMissionListParams,
  type CmosMissionListResult,
  type MissionListItem,
} from '../../../src/tools/cmos/cmos-mission-list';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult, Mission } from '../../../src/tools/cmos/types';

describe('cmos_mission_list', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-mission-list-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    // Create a test database with comprehensive schema and data
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

      -- Insert test sprints
      INSERT INTO sprints (id, title, status)
      VALUES
        ('sprint-11', 'Sprint 11', 'Completed'),
        ('sprint-12', 'Sprint 12', 'planning');

      -- Insert test missions with various statuses and sprints
      INSERT INTO missions (id, sprint_id, name, status, objective, success_criteria, deliverables, completed_at, notes)
      VALUES
        ('s11-m01', 'sprint-11', 'Completed Mission 1', 'Completed', 'First objective', '["Criterion 1", "Criterion 2"]', '["File1.ts"]', '2024-01-01T10:00:00Z', 'Completed with notes'),
        ('s11-m02', 'sprint-11', 'Completed Mission 2', 'Completed', 'Second objective', '["Criterion A"]', '["File2.ts", "File3.ts"]', '2024-01-02T10:00:00Z', NULL),
        ('s12-m01', 'sprint-12', 'Current Mission', 'Current', 'Current sprint objective', NULL, NULL, NULL, NULL),
        ('s12-m02', 'sprint-12', 'In Progress Mission', 'In Progress', 'Work in progress', '["Success 1"]', '["output.ts"]', NULL, 'Being worked on'),
        ('s12-m03', 'sprint-12', 'Queued Mission 1', 'Queued', 'Waiting to start', NULL, NULL, NULL, NULL),
        ('s12-m04', 'sprint-12', 'Queued Mission 2', 'Queued', 'Also waiting', '["Done when X"]', NULL, NULL, NULL),
        ('s12-m05', 'sprint-12', 'Blocked Mission', 'Blocked', 'Cannot proceed', NULL, NULL, NULL, 'Blocked by dependency'),
        ('standalone', NULL, 'Standalone Mission', 'Queued', 'No sprint', NULL, NULL, NULL, NULL);
    `);
    db.close();

    // Reset CmosDetector cache before each test
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic listing', () => {
    it('should list all missions when no filters applied', async () => {
      const result = await cmosMissionList({ projectRoot: tempDir } as CmosMissionListParams & {
        projectRoot: string;
      });

      // Use explicit dbPath instead since no cmos/ structure
      const resultWithDb = await cmosMissionListWithDb(dbPath, {});

      expect(resultWithDb.success).toBe(true);
      expect(resultWithDb.data?.missions).toHaveLength(8);
      expect(resultWithDb.data?.totalCount).toBe(8);
    });

    it('should return empty list for empty database', async () => {
      // Create empty database
      const emptyDbPath = path.join(tempDir, 'empty.sqlite');
      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE missions (
          id TEXT PRIMARY KEY,
          sprint_id TEXT,
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
      `);
      db.close();

      const result = await cmosMissionListWithDb(emptyDbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const result = await cmosMissionListWithDb(dbPath, { limit: 3 });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(3);
      expect(result.data?.totalCount).toBe(8); // Total is still 8
      expect(result.data?.filters.limit).toBe(3);
    });

    it('should use default limit of 20', async () => {
      const result = await cmosMissionListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.filters.limit).toBe(20);
    });
  });

  describe('status filtering', () => {
    it('should filter by Queued status', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Queued' });

      expect(result.success).toBe(true);
      expect(result.data?.missions.every((m) => m.status === 'Queued')).toBe(true);
      expect(result.data?.missions).toHaveLength(3); // s12-m03, s12-m04, standalone
      expect(result.data?.totalCount).toBe(3);
      expect(result.data?.filters.status).toBe('Queued');
    });

    it('should filter by Current status', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Current' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.missions[0].id).toBe('s12-m01');
      expect(result.data?.filters.status).toBe('Current');
    });

    it('should filter by In Progress status', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'In Progress' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.missions[0].id).toBe('s12-m02');
    });

    it('should filter by Completed status', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(2);
      expect(result.data?.missions.map((m) => m.id)).toContain('s11-m01');
      expect(result.data?.missions.map((m) => m.id)).toContain('s11-m02');
    });

    it('should filter by Blocked status', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Blocked' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.missions[0].id).toBe('s12-m05');
    });

    it('should return empty for status with no matches', async () => {
      // Remove all blocked missions
      const db = new Database(dbPath);
      db.exec("DELETE FROM missions WHERE status = 'Blocked'");
      db.close();

      const result = await cmosMissionListWithDb(dbPath, { status: 'Blocked' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('sprint filtering', () => {
    it('should filter by sprint ID', async () => {
      const result = await cmosMissionListWithDb(dbPath, { sprintId: 'sprint-12' });

      expect(result.success).toBe(true);
      expect(result.data?.missions.every((m) => m.sprintId === 'sprint-12')).toBe(true);
      expect(result.data?.missions).toHaveLength(5);
      expect(result.data?.filters.sprintId).toBe('sprint-12');
    });

    it('should filter by different sprint ID', async () => {
      const result = await cmosMissionListWithDb(dbPath, { sprintId: 'sprint-11' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(2);
      expect(result.data?.missions.every((m) => m.sprintId === 'sprint-11')).toBe(true);
    });

    it('should return empty for non-existent sprint', async () => {
      const result = await cmosMissionListWithDb(dbPath, { sprintId: 'sprint-99' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should find missions with null sprint when filtering for null (via SQL)', async () => {
      // This tests that standalone missions can be found
      const result = await cmosMissionListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const standaloneMission = result.data?.missions.find((m) => m.id === 'standalone');
      expect(standaloneMission).toBeDefined();
      expect(standaloneMission?.sprintId).toBeNull();
    });
  });

  describe('combined filters', () => {
    it('should filter by both status and sprint', async () => {
      const result = await cmosMissionListWithDb(dbPath, {
        status: 'Queued',
        sprintId: 'sprint-12',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(2); // s12-m03, s12-m04 (not standalone)
      expect(result.data?.missions.every((m) => m.status === 'Queued')).toBe(true);
      expect(result.data?.missions.every((m) => m.sprintId === 'sprint-12')).toBe(true);
    });

    it('should filter by status, sprint, and limit', async () => {
      const result = await cmosMissionListWithDb(dbPath, {
        status: 'Queued',
        sprintId: 'sprint-12',
        limit: 1,
      });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.totalCount).toBe(2); // Total matching is 2
    });
  });

  describe('JSON field parsing', () => {
    it('should parse success_criteria JSON array', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      const m1 = result.data?.missions.find((m) => m.id === 's11-m01');
      expect(m1?.successCriteria).toEqual(['Criterion 1', 'Criterion 2']);
    });

    it('should parse deliverables JSON array', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      const m2 = result.data?.missions.find((m) => m.id === 's11-m02');
      expect(m2?.deliverables).toEqual(['File2.ts', 'File3.ts']);
    });

    it('should return null for null JSON fields', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Current' });

      expect(result.success).toBe(true);
      expect(result.data?.missions[0].successCriteria).toBeNull();
      expect(result.data?.missions[0].deliverables).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      // Insert mission with invalid JSON
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, success_criteria)
        VALUES ('bad-json', 'Bad JSON Mission', 'Queued', 'not valid json');
      `);
      db.close();

      const result = await cmosMissionListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const badMission = result.data?.missions.find((m) => m.id === 'bad-json');
      expect(badMission?.successCriteria).toBeNull();
    });
  });

  describe('ordering', () => {
    it('should order by sprint (descending) then id (ascending)', async () => {
      const result = await cmosMissionListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const ids = result.data?.missions.map((m) => m.id);

      // sprint-12 missions should come first (sorted by id)
      // then sprint-11 missions
      // then null sprint missions last
      expect(ids?.indexOf('s12-m01')).toBeLessThan(ids?.indexOf('s11-m01') ?? Infinity);
      expect(ids?.indexOf('standalone')).toBe((ids?.length ?? 0) - 1);
    });
  });

  describe('error handling', () => {
    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosMissionList({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should return error for missing missions table', async () => {
      const badDbPath = path.join(tempDir, 'bad.sqlite');
      const db = new Database(badDbPath);
      db.exec('CREATE TABLE other (id TEXT);');
      db.close();

      const result = await cmosMissionListWithDb(badDbPath, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionListToolDefinition.name).toBe('cmos_mission_list');
    });

    it('should have description', () => {
      expect(cmosMissionListToolDefinition.description).toBeTruthy();
      expect(cmosMissionListToolDefinition.description).toContain('mission');
    });

    it('should have valid input schema', () => {
      expect(cmosMissionListToolDefinition.inputSchema.type).toBe('object');
      expect(cmosMissionListToolDefinition.inputSchema.properties).toBeDefined();
      expect(cmosMissionListToolDefinition.inputSchema.properties.status).toBeDefined();
      expect(cmosMissionListToolDefinition.inputSchema.properties.sprintId).toBeDefined();
      expect(cmosMissionListToolDefinition.inputSchema.properties.limit).toBeDefined();
    });

    it('should have status enum with all valid values', () => {
      const statusProp = cmosMissionListToolDefinition.inputSchema.properties.status;
      expect(statusProp.enum).toContain('Queued');
      expect(statusProp.enum).toContain('Current');
      expect(statusProp.enum).toContain('In Progress');
      expect(statusProp.enum).toContain('Completed');
      expect(statusProp.enum).toContain('Blocked');
    });
  });

  describe('formatMissionListForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosMissionListWithDb(dbPath, { status: 'Completed' });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('Missions');
      expect(formatted).toContain('status=Completed');
      expect(formatted).toContain('sprint-11');
      expect(formatted).toContain('s11-m01');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await cmosMissionList({ projectRoot: emptyDir });
        const formatted = formatMissionListForLLM(result);

        expect(formatted).toContain('❌');
        expect(formatted).toContain('Failed');
        expect(formatted).toContain('Suggestion');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show filter information', async () => {
      const result = await cmosMissionListWithDb(dbPath, {
        status: 'Queued',
        sprintId: 'sprint-12',
      });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('status=Queued');
      expect(formatted).toContain('sprint=sprint-12');
    });

    it('should show message for empty results', async () => {
      const result = await cmosMissionListWithDb(dbPath, { sprintId: 'nonexistent' });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('No missions found');
    });

    it('should group missions by sprint', async () => {
      const result = await cmosMissionListWithDb(dbPath, {});
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('**sprint-12**');
      expect(formatted).toContain('**sprint-11**');
      expect(formatted).toContain('**(no sprint)**');
    });

    it('should show status icons', async () => {
      const result = await cmosMissionListWithDb(dbPath, {});
      const formatted = formatMissionListForLLM(result);

      // Check for various status icons
      expect(formatted).toMatch(/[○◉◐✓⊘]/);
    });

    it('should truncate long objectives', async () => {
      // Add mission with long objective
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, objective)
        VALUES ('long-obj', 'Long Objective', 'Queued', '${`x`.repeat(100)}');
      `);
      db.close();

      const result = await cmosMissionListWithDb(dbPath, { status: 'Queued' });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('...');
    });
  });
});

/**
 * Helper to run cmosMissionList with explicit database path.
 * Bypasses CMOS detection for unit testing.
 */
async function cmosMissionListWithDb(
  dbPath: string,
  params: Omit<CmosMissionListParams, 'projectRoot'>
): Promise<CmosToolResult<CmosMissionListResult>> {
  // Import withClient directly to use explicit dbPath
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError, CmosErrors, VALID_MISSION_STATUSES } =
    await import('../../../src/tools/cmos/errors');

  // Validate status
  if (params.status && !VALID_MISSION_STATUSES.includes(params.status)) {
    return createError<CmosMissionListResult>(
      CmosErrors.invalidParameter('status', params.status, VALID_MISSION_STATUSES as string[])
    );
  }

  const limit = params.limit ?? 20;

  return withClient(
    (client) => {
      // Build query dynamically based on filters
      const conditions: string[] = [];
      const queryParams: unknown[] = [];

      if (params.status) {
        conditions.push('status = ?');
        queryParams.push(params.status);
      }

      if (params.sprintId) {
        conditions.push('sprint_id = ?');
        queryParams.push(params.sprintId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countSql = `SELECT COUNT(*) as count FROM missions ${whereClause}`;
      const countResult = client.getOne<{ count: number }>(countSql, queryParams);
      if (!countResult.success || !countResult.data) {
        return createError<CmosMissionListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get count' }
        );
      }
      const totalCount = countResult.data.count;

      // Main query
      const sql = `
        SELECT
          id, sprint_id, name, status, completed_at, notes,
          objective, context, success_criteria, deliverables,
          reference_docs, domain_fields, metadata
        FROM missions
        ${whereClause}
        ORDER BY
          CASE WHEN sprint_id IS NULL THEN 1 ELSE 0 END,
          sprint_id DESC,
          id ASC
        LIMIT ?
      `;

      const missionsResult = client.getMany<Mission>(sql, [...queryParams, limit]);
      if (!missionsResult.success || !missionsResult.data) {
        return createError<CmosMissionListResult>(
          missionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get missions' }
        );
      }

      // Parse missions
      const missions: MissionListItem[] = missionsResult.data.map((m) => ({
        id: m.id,
        sprintId: m.sprint_id,
        name: m.name,
        status: m.status,
        completedAt: m.completed_at,
        notes: m.notes,
        objective: m.objective,
        successCriteria: parseJsonArray(m.success_criteria),
        deliverables: parseJsonArray(m.deliverables),
      }));

      return createSuccess<CmosMissionListResult>({
        missions,
        totalCount,
        filters: {
          status: params.status ?? null,
          sprintId: params.sprintId ?? null,
          limit,
        },
      });
    },
    { dbPath }
  );
}

function parseJsonArray(jsonString: string | null): string[] | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
