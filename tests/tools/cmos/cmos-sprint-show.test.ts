/**
 * cmos_sprint_show Tool Tests
 *
 * Comprehensive tests for the sprint show tool.
 *
 * @module tests/tools/cmos/cmos-sprint-show
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprintShow,
  cmosSprintShowToolDefinition,
  formatSprintShowForLLM,
  type CmosSprintShowParams,
  type SprintShowResult,
} from '../../../src/tools/cmos/cmos-sprint-show';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { SPRINT_SUMMARY_VIEW_SQL } from '../../../src/tools/cmos/schema';

describe('cmos_sprint_show', () => {
  let tempDir: string;
  let dbPath: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprint-show-test-'));
    projectRoot = tempDir;
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
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

      ${SPRINT_SUMMARY_VIEW_SQL}

      INSERT INTO sprints (id, title, focus, status, start_date, end_date)
      VALUES
        ('sprint-14', 'Sprint 14', 'Sprint CRUD Tools', 'Active', '2025-12-10', '2025-12-15'),
        ('sprint-13', 'Sprint 13', 'Session Tools', 'Completed', '2025-12-08', '2025-12-10');

      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES
        ('s14-m01', 'sprint-14', 'Prune Tools', 'Completed', 'Remove deprecated tools'),
        ('s14-m02', 'sprint-14', 'Sprint CRUD', 'In Progress', 'Implement sprint tools'),
        ('s14-m03', 'sprint-14', 'Mission Creation', 'Queued', 'Add mission creation'),
        ('s13-m01', 'sprint-13', 'Lifecycle Tools', 'Completed', 'Implement lifecycle'),
        ('s13-m02', 'sprint-13', 'Context Tools', 'Completed', 'Implement context');

      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, project_domain)
      VALUES ('Decision 1', '2025-12-12T09:00:00Z', 'sprint-14', 'cmos-mcp');

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

  describe('basic functionality', () => {
    it('should return sprint details with missions', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('sprint-14');
      expect(result.data?.title).toBe('Sprint 14');
      expect(result.data?.focus).toBe('Sprint CRUD Tools');
      expect(result.data?.status).toBe('Active');
      expect(result.data?.missions).toHaveLength(3);
    });

    it('should include correct mission statistics', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.totalMissions).toBe(3);
      expect(result.data?.completedMissions).toBe(1);
      expect(result.data?.activeMissions).toBe(1);
    });

    it('should include decisions count', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsCount).toBe(1);
      expect(result.data?.sessionDecisionsCount).toBe(0);
      expect(result.data?.totalDecisionsCount).toBe(1);
    });

    it('should include date range', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.startDate).toBe('2025-12-10');
      expect(result.data?.endDate).toBe('2025-12-15');
    });
  });

  describe('mission ordering', () => {
    it('should order missions by status priority', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      const statuses = result.data?.missions.map((m) => m.status);

      // In Progress first, then Queued, then Completed
      expect(statuses?.[0]).toBe('In Progress');
      expect(statuses?.[1]).toBe('Queued');
      expect(statuses?.[2]).toBe('Completed');
    });

    it('should expose session-derived decision counts when sprint sessions include uncopied decisions', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2025-12-12T10:00:00Z', '2025-12-12T11:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Session-only sprint review decision',
            timestamp: '2025-12-12T11:00:00Z',
          },
        ])
      );
      db.close();

      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsCount).toBe(1);
      expect(result.data?.sessionDecisionsCount).toBe(1);
      expect(result.data?.totalDecisionsCount).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should return error for non-existent sprint', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SPRINT_NOT_FOUND);
      expect(result.error?.suggestion).toContain('cmos_sprint');
    });

    it('should return error for missing sprintId', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosSprintShow({ sprintId: 'sprint-14', projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSprintShowToolDefinition.name).toBe('cmos_sprint_show');
    });

    it('should require sprintId parameter', () => {
      expect(cmosSprintShowToolDefinition.inputSchema.required).toContain('sprintId');
    });

    it('should have description', () => {
      expect(cmosSprintShowToolDefinition.description).toBeTruthy();
      expect(cmosSprintShowToolDefinition.description).toContain('sprint');
    });
  });

  describe('formatSprintShowForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('Sprint: sprint-14');
      expect(formatted).toContain('Sprint 14');
      expect(formatted).toContain('Focus');
      expect(formatted).toContain('Progress');
      expect(formatted).toContain('Missions');
    });

    it('should format strategic and session-derived decision counts distinctly', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2025-12-12T10:00:00Z', '2025-12-12T11:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Session-only sprint review decision',
            timestamp: '2025-12-12T11:00:00Z',
          },
        ])
      );
      db.close();

      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('1 strategic, 1 session-derived (2 total)');
    });

    it('should format error result', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'nonexistent' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });

    it('should show mission details', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('s14-m01');
      expect(formatted).toContain('Prune Tools');
      expect(formatted).toContain('s14-m02');
    });

    it('should show status icons for missions', async () => {
      const result = await cmosSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toMatch(/[○◉◐✓⊘]/);
    });
  });
});

/**
 * Helper to run cmosSprintShow with explicit database path.
 */
async function cmosSprintShowWithDb(
  dbPath: string,
  params: CmosSprintShowParams
): Promise<CmosToolResult<SprintShowResult>> {
  return cmosSprintShow({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
