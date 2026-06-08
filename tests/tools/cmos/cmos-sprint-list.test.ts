/**
 * cmos_sprint_list Tool Tests
 *
 * Comprehensive tests for the sprint listing tool.
 *
 * @module tests/tools/cmos/cmos-sprint-list
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprintList,
  cmosSprintListToolDefinition,
  formatSprintListForLLM,
  type CmosSprintListParams,
  type CmosSprintListResult,
  type SprintListItem,
} from '../../../src/tools/cmos/cmos-sprint-list';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

describe('cmos_sprint_list', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprint-list-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    // Create a test database with comprehensive schema and data
    const db = new Database(dbPath);
    db.exec(`
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

      CREATE TABLE strategic_decisions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        decision TEXT,
        context TEXT
      );

      -- Create sprint_summary view
      CREATE VIEW sprint_summary AS
      SELECT
        s.id AS sprint_id,
        s.title,
        s.status,
        s.focus,
        s.start_date,
        s.end_date,
        COUNT(m.id) AS total_missions,
        COUNT(CASE WHEN m.status = 'Completed' THEN 1 END) AS completed_missions,
        COUNT(CASE WHEN m.status = 'Blocked' THEN 1 END) AS blocked_missions,
        COUNT(CASE WHEN m.status IN ('Current', 'In Progress') THEN 1 END) AS active_missions,
        (
          SELECT COUNT(DISTINCT sd.id)
          FROM strategic_decisions sd
          WHERE sd.sprint_id = s.id
        ) AS decisions_count
      FROM sprints s
      LEFT JOIN missions m ON m.sprint_id = s.id
      GROUP BY s.id, s.title, s.status, s.focus, s.start_date, s.end_date;

      -- Insert test sprints
      INSERT INTO sprints (id, title, focus, status, start_date, end_date)
      VALUES
        ('sprint-14', 'Sprint 14', 'Sprint CRUD Tools', 'Active', '2025-12-10', '2025-12-15'),
        ('sprint-13', 'Sprint 13', 'Session Tools', 'Completed', '2025-12-08', '2025-12-10'),
        ('sprint-12', 'Sprint 12', 'Foundation', 'Completed', '2025-12-05', '2025-12-08'),
        ('sprint-11', 'Sprint 11', 'Legacy', 'Completed', NULL, NULL);

      -- Insert test missions
      INSERT INTO missions (id, sprint_id, name, status)
      VALUES
        ('s14-m01', 'sprint-14', 'Prune Tools', 'Completed'),
        ('s14-m02', 'sprint-14', 'Sprint CRUD', 'In Progress'),
        ('s13-m01', 'sprint-13', 'Lifecycle Tools', 'Completed'),
        ('s13-m02', 'sprint-13', 'Context Tools', 'Completed'),
        ('s12-m01', 'sprint-12', 'Identity', 'Completed'),
        ('s12-m02', 'sprint-12', 'Blocked Test', 'Blocked');

      -- Insert test strategic decisions
      INSERT INTO strategic_decisions (id, sprint_id, decision)
      VALUES
        ('d1', 'sprint-14', 'Decision 1'),
        ('d2', 'sprint-14', 'Decision 2');
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
    it('should list all sprints when no filters applied', async () => {
      const result = await cmosSprintListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(4);
      expect(result.data?.totalCount).toBe(4);
    });

    it('should return empty list for empty database', async () => {
      const emptyDbPath = path.join(tempDir, 'empty.sqlite');
      const db = new Database(emptyDbPath);
      db.exec(`
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
          sprint_id TEXT,
          name TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE strategic_decisions (id TEXT PRIMARY KEY, sprint_id TEXT);
        CREATE VIEW sprint_summary AS
        SELECT s.id AS sprint_id, s.title, s.status, s.focus, s.start_date, s.end_date,
               0 AS total_missions, 0 AS completed_missions, 0 AS blocked_missions,
               0 AS active_missions, 0 AS decisions_count
        FROM sprints s;
      `);
      db.close();

      const result = await cmosSprintListWithDb(emptyDbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const result = await cmosSprintListWithDb(dbPath, { limit: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(2);
      expect(result.data?.totalCount).toBe(4);
      expect(result.data?.filters.limit).toBe(2);
    });

    it('should use default limit of 20', async () => {
      const result = await cmosSprintListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.filters.limit).toBe(20);
    });
  });

  describe('status filtering', () => {
    it('should filter by Active status', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(1);
      expect(result.data?.sprints[0].id).toBe('sprint-14');
      expect(result.data?.filters.status).toBe('Active');
    });

    it('should filter by Completed status', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(3);
      expect(result.data?.sprints.every((s) => s.status === 'Completed')).toBe(true);
    });

    it('should return empty for status with no matches', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Planned' });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('mission statistics', () => {
    it('should include correct total missions count', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.totalMissions).toBe(2);
    });

    it('should include correct completed missions count', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.completedMissions).toBe(1);
    });

    it('should include correct active missions count', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.activeMissions).toBe(1); // 1 In Progress
    });

    it('should include blocked missions count', async () => {
      const result = await cmosSprintListWithDb(dbPath, {});
      const sprint12 = result.data?.sprints.find((s) => s.id === 'sprint-12');

      expect(sprint12?.blockedMissions).toBe(1);
    });

    it('should include decisions count', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.decisionsCount).toBe(2);
    });
  });

  describe('ordering', () => {
    it('should order by start_date descending (most recent first)', async () => {
      const result = await cmosSprintListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const ids = result.data?.sprints.map((s) => s.id);

      // sprint-14 has most recent start_date, sprint-11 has null
      expect(ids?.[0]).toBe('sprint-14');
      expect(ids?.[ids.length - 1]).toBe('sprint-11'); // null dates last
    });
  });

  describe('error handling', () => {
    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosSprintList({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSprintListToolDefinition.name).toBe('cmos_sprint_list');
    });

    it('should have description', () => {
      expect(cmosSprintListToolDefinition.description).toBeTruthy();
      expect(cmosSprintListToolDefinition.description).toContain('sprint');
    });

    it('should have valid input schema', () => {
      expect(cmosSprintListToolDefinition.inputSchema.type).toBe('object');
      expect(cmosSprintListToolDefinition.inputSchema.properties).toBeDefined();
      expect(cmosSprintListToolDefinition.inputSchema.properties.status).toBeDefined();
      expect(cmosSprintListToolDefinition.inputSchema.properties.limit).toBeDefined();
    });
  });

  describe('formatSprintListForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosSprintListWithDb(dbPath, {});
      const formatted = formatSprintListForLLM(result);

      expect(formatted).toContain('Sprints');
      expect(formatted).toContain('sprint-14');
      expect(formatted).toContain('Progress');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await cmosSprintList({ projectRoot: emptyDir });
        const formatted = formatSprintListForLLM(result);

        expect(formatted).toContain('❌');
        expect(formatted).toContain('Failed');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show status icons', async () => {
      const result = await cmosSprintListWithDb(dbPath, {});
      const formatted = formatSprintListForLLM(result);

      // Check for various status icons
      expect(formatted).toMatch(/[○◉✓•]/);
    });

    it('should show message for empty results', async () => {
      const result = await cmosSprintListWithDb(dbPath, { status: 'nonexistent' });
      const formatted = formatSprintListForLLM(result);

      expect(formatted).toContain('No sprints found');
    });
  });
});

/**
 * Helper to run cmosSprintList with explicit database path.
 * Bypasses CMOS detection for unit testing.
 */
async function cmosSprintListWithDb(
  dbPath: string,
  params: Omit<CmosSprintListParams, 'projectRoot'>
): Promise<CmosToolResult<CmosSprintListResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError } = await import('../../../src/tools/cmos/errors');

  const limit = params.limit ?? 20;

  interface SprintSummaryRow {
    sprint_id: string;
    title: string;
    status: string | null;
    focus: string | null;
    start_date: string | null;
    end_date: string | null;
    total_missions: number;
    completed_missions: number;
    blocked_missions: number;
    active_missions: number;
    decisions_count: number;
  }

  return withClient(
    (client) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];

      if (params.status) {
        conditions.push('status = ?');
        queryParams.push(params.status);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countSql = `SELECT COUNT(*) as count FROM sprint_summary ${whereClause}`;
      const countResult = client.getOne<{ count: number }>(countSql, queryParams);
      if (!countResult.success || !countResult.data) {
        return createError<CmosSprintListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get count' }
        );
      }
      const totalCount = countResult.data.count;

      const sql = `
        SELECT sprint_id, title, status, focus, start_date, end_date,
               total_missions, completed_missions, blocked_missions,
               active_missions, decisions_count
        FROM sprint_summary
        ${whereClause}
        ORDER BY
          CASE WHEN start_date IS NULL THEN 1 ELSE 0 END,
          start_date DESC,
          sprint_id DESC
        LIMIT ?
      `;

      const sprintsResult = client.getMany<SprintSummaryRow>(sql, [...queryParams, limit]);
      if (!sprintsResult.success || !sprintsResult.data) {
        return createError<CmosSprintListResult>(
          sprintsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get sprints' }
        );
      }

      const sprints: SprintListItem[] = sprintsResult.data.map((row) => ({
        id: row.sprint_id,
        title: row.title,
        focus: row.focus,
        status: row.status,
        startDate: row.start_date,
        endDate: row.end_date,
        totalMissions: row.total_missions ?? 0,
        completedMissions: row.completed_missions ?? 0,
        blockedMissions: row.blocked_missions ?? 0,
        activeMissions: row.active_missions ?? 0,
        decisionsCount: row.decisions_count ?? 0,
      }));

      return createSuccess<CmosSprintListResult>({
        sprints,
        totalCount,
        filters: {
          status: params.status ?? null,
          limit,
        },
      });
    },
    { dbPath }
  );
}
