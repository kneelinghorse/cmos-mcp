/**
 * cmos_decisions_list Tool Tests
 *
 * Tests for the strategic decisions listing tool.
 *
 * @module tests/tools/cmos/cmos-decisions-list
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosDecisionsList,
  cmosDecisionsListToolDefinition,
  formatDecisionsListForLLM,
  type CmosDecisionsListParams,
  type CmosDecisionsListResult,
} from '../../../src/tools/cmos/cmos-decisions-list';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

describe('cmos_decisions_list', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-decisions-list-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        mission_id TEXT,
        session_id TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      INSERT INTO strategic_decisions (decision_text, created_at, project_domain, sprint_id, mission_id)
      VALUES
        ('Use TypeScript for all new tools', '2024-01-15T10:00:00Z', 'cmos-mcp', 'sprint-14', 's14-m01'),
        ('Implement pagination for all list operations', '2024-01-14T09:00:00Z', 'cmos-mcp', 'sprint-14', NULL),
        ('Follow CmosToolResult pattern', '2024-01-13T08:00:00Z', 'general', 'sprint-13', NULL),
        ('Use SQLite for local storage', '2024-01-12T07:00:00Z', 'ai-studio', 'sprint-13', NULL),
        ('Adopt better-sqlite3 for sync operations', '2024-01-11T06:00:00Z', 'cmos-mcp', 'sprint-12', NULL);

      INSERT INTO metadata (key, value) VALUES ('project_domain', 'cmos-mcp');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic listing', () => {
    it('should list all decisions when no filters applied', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(5);
      expect(result.data?.totalCount).toBe(5);
    });

    it('should return empty list for empty database', async () => {
      const emptyProjectRoot = path.join(tempDir, 'empty-project');
      const emptyDbDir = path.join(emptyProjectRoot, 'cmos', 'db');
      fs.mkdirSync(emptyDbDir, { recursive: true });
      const emptyDbPath = path.join(emptyDbDir, 'cmos.sqlite');
      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          context_id TEXT NOT NULL DEFAULT 'master_context',
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sprint_id TEXT,
          snapshot_id INTEGER,
          project_domain TEXT,
          mission_id TEXT
        );
      `);
      db.close();

      const result = await cmosDecisionsListWithDb(emptyDbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should respect pageSize parameter', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { pageSize: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(2);
      expect(result.data?.totalCount).toBe(5);
      expect(result.data?.pageSize).toBe(2);
      expect(result.data?.hasMore).toBe(true);
    });

    it('should use default pageSize of 20', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.pageSize).toBe(20);
    });

    it('should order by created_at descending', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const dates = result.data?.decisions.map((d) => d.createdAt);
      // First should be most recent
      expect(dates?.[0]).toBe('2024-01-15T10:00:00Z');
      expect(dates?.[dates.length - 1]).toBe('2024-01-11T06:00:00Z');
    });
  });

  describe('missionId in results', () => {
    it('should include missionId when present', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const withMission = result.data?.decisions.find((d) => d.missionId === 's14-m01');
      expect(withMission).toBeDefined();
      expect(withMission?.decision).toBe('Use TypeScript for all new tools');
    });

    it('should return null missionId when not set', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const withoutMission = result.data?.decisions.filter((d) => d.missionId === null);
      expect(withoutMission?.length).toBe(4);
    });
  });

  describe('domain filtering', () => {
    it('should filter by domain', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { domain: 'cmos-mcp' });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(3);
      expect(result.data?.decisions.every((d) => d.domain === 'cmos-mcp')).toBe(true);
    });

    it('should return empty for non-existent domain', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { domain: 'nonexistent' });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('sprint filtering', () => {
    it('should filter by sprintId', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(2);
      expect(result.data?.decisions.every((d) => d.sprintId === 'sprint-14')).toBe(true);
    });

    it('should return empty for non-existent sprint', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { sprintId: 'sprint-99' });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(0);
    });

    it('should surface session-only decisions for sprint-scoped queries', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2024-01-15T08:00:00Z', '2024-01-15T09:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Session-only review decision',
            timestamp: '2024-01-15T09:00:00Z',
          },
        ])
      );
      db.close();

      const result = await cmosDecisionsListWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(
        result.data?.decisions.some((d) => d.decision === 'Session-only review decision')
      ).toBe(true);
      expect(
        result.data?.decisions.find((d) => d.decision === 'Session-only review decision')?.source
      ).toBe('session_capture');
    });

    it('should not duplicate a decision already extracted for the same session', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2024-01-15T08:00:00Z', '2024-01-15T09:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Already extracted decision',
            timestamp: '2024-01-15T09:00:00Z',
          },
        ])
      );
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, project_domain, sprint_id, session_id)
         VALUES ('Already extracted decision', '2024-01-15T09:00:00Z', 'cmos-mcp', 'sprint-14', 'review-14')`
      ).run();
      db.close();

      const result = await cmosDecisionsListWithDb(dbPath, { sprintId: 'sprint-14' });
      const duplicates =
        result.data?.decisions.filter((d) => d.decision === 'Already extracted decision') ?? [];

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].source).toBe('strategic');
    });
  });

  describe('date filtering', () => {
    it('should filter by since date', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { since: '2024-01-14T00:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(2);
    });

    it('should filter by until date', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { until: '2024-01-12T12:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(2);
    });

    it('should filter by date range', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {
        since: '2024-01-12T00:00:00Z',
        until: '2024-01-14T12:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(3);
    });
  });

  describe('pagination', () => {
    it('should paginate results', async () => {
      const page1 = await cmosDecisionsListWithDb(dbPath, { page: 1, pageSize: 2 });
      const page2 = await cmosDecisionsListWithDb(dbPath, { page: 2, pageSize: 2 });
      const page3 = await cmosDecisionsListWithDb(dbPath, { page: 3, pageSize: 2 });

      expect(page1.data?.decisions).toHaveLength(2);
      expect(page1.data?.page).toBe(1);
      expect(page1.data?.hasMore).toBe(true);

      expect(page2.data?.decisions).toHaveLength(2);
      expect(page2.data?.page).toBe(2);
      expect(page2.data?.hasMore).toBe(true);

      expect(page3.data?.decisions).toHaveLength(1);
      expect(page3.data?.page).toBe(3);
      expect(page3.data?.hasMore).toBe(false);

      // Ensure no overlap
      const allIds = [
        ...page1.data!.decisions.map((d) => d.id),
        ...page2.data!.decisions.map((d) => d.id),
        ...page3.data!.decisions.map((d) => d.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    });
  });

  describe('combined filters', () => {
    it('should filter by domain and sprint', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {
        domain: 'cmos-mcp',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisions).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosDecisionsList({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosDecisionsListToolDefinition.name).toBe('cmos_decisions_list');
    });

    it('should have description', () => {
      expect(cmosDecisionsListToolDefinition.description).toBeTruthy();
      expect(cmosDecisionsListToolDefinition.description).toContain('decision');
    });

    it('should have valid input schema', () => {
      expect(cmosDecisionsListToolDefinition.inputSchema.type).toBe('object');
      expect(cmosDecisionsListToolDefinition.inputSchema.properties).toBeDefined();
      expect(cmosDecisionsListToolDefinition.inputSchema.properties.domain).toBeDefined();
      expect(cmosDecisionsListToolDefinition.inputSchema.properties.sprintId).toBeDefined();
      expect(cmosDecisionsListToolDefinition.inputSchema.properties.page).toBeDefined();
      expect(cmosDecisionsListToolDefinition.inputSchema.properties.pageSize).toBeDefined();
    });
  });

  describe('formatDecisionsListForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, {});
      const formatted = formatDecisionsListForLLM(result);

      expect(formatted).toContain('Strategic Decisions');
      expect(formatted).toContain('TypeScript');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await cmosDecisionsList({ projectRoot: emptyDir });
        const formatted = formatDecisionsListForLLM(result);

        expect(formatted).toContain('Failed');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show pagination info', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { pageSize: 2 });
      const formatted = formatDecisionsListForLLM(result);

      expect(formatted).toContain('page');
    });

    it('should show message for empty results', async () => {
      const result = await cmosDecisionsListWithDb(dbPath, { domain: 'nonexistent' });
      const formatted = formatDecisionsListForLLM(result);

      expect(formatted).toContain('No decisions found');
    });
  });
});

/**
 * Helper to run cmosDecisionsList with explicit database path.
 */
async function cmosDecisionsListWithDb(
  dbPath: string,
  params: Omit<CmosDecisionsListParams, 'projectRoot'>
): Promise<CmosToolResult<CmosDecisionsListResult>> {
  return cmosDecisionsList({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
