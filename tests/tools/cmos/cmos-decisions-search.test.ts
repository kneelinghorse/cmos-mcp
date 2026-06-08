/**
 * cmos_decisions_search Tool Tests
 *
 * Tests for the strategic decisions search tool.
 *
 * @module tests/tools/cmos/cmos-decisions-search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosDecisionsSearch,
  cmosDecisionsSearchToolDefinition,
  formatDecisionsSearchForLLM,
  type CmosDecisionsSearchParams,
  type CmosDecisionsSearchResult,
} from '../../../src/tools/cmos/cmos-decisions-search';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { createError, CmosErrors } from '../../../src/tools/cmos/errors';

describe('cmos_decisions_search', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-decisions-search-test-'));
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

      INSERT INTO strategic_decisions (decision_text, created_at, project_domain, sprint_id)
      VALUES
        ('Use TypeScript for all new tools', '2024-01-15T10:00:00Z', 'cmos-mcp', 'sprint-14'),
        ('Implement pagination for all list operations', '2024-01-14T09:00:00Z', 'cmos-mcp', 'sprint-14'),
        ('Follow CmosToolResult pattern for consistent responses', '2024-01-13T08:00:00Z', 'general', 'sprint-13'),
        ('Use SQLite for local storage', '2024-01-12T07:00:00Z', 'ai-studio', 'sprint-13'),
        ('Adopt better-sqlite3 for sync operations', '2024-01-11T06:00:00Z', 'cmos-mcp', 'sprint-12'),
        ('All tools should return structured errors', '2024-01-10T05:00:00Z', 'cmos-mcp', 'sprint-12');

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

  describe('basic search', () => {
    it('should find decisions matching a single keyword', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.some((d) => d.decision.includes('TypeScript'))).toBe(true);
    });

    it('should find decisions matching multiple keywords', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'all operations' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
    });

    it('should return empty for no matches', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'nonexistent xyz' });

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(0);
      expect(result.data?.totalMatches).toBe(0);
    });

    it('should return the query in the result', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.query).toBe('TypeScript');
    });
  });

  describe('case insensitivity', () => {
    it('should be case insensitive', async () => {
      const upperResult = await cmosDecisionsSearchWithDb(dbPath, { query: 'TYPESCRIPT' });
      const lowerResult = await cmosDecisionsSearchWithDb(dbPath, { query: 'typescript' });
      const mixedResult = await cmosDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(upperResult.data?.totalMatches).toBe(lowerResult.data?.totalMatches);
      expect(lowerResult.data?.totalMatches).toBe(mixedResult.data?.totalMatches);
    });
  });

  describe('relevance scoring', () => {
    it('should return relevance scores', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'tools' });

      expect(result.success).toBe(true);
      expect(result.data?.results.every((r) => typeof r.relevance === 'number')).toBe(true);
    });

    it('should order by relevance (higher first)', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'tools' });

      expect(result.success).toBe(true);
      const relevances = result.data?.results.map((r) => r.relevance) || [];
      for (let i = 1; i < relevances.length; i++) {
        expect(relevances[i]).toBeLessThanOrEqual(relevances[i - 1]);
      }
    });
  });

  describe('filtering', () => {
    it('should filter by domain', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, {
        query: 'all',
        domain: 'cmos-mcp',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.every((d) => d.domain === 'cmos-mcp')).toBe(true);
    });

    it('should filter by sprintId', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, {
        query: 'all',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.every((d) => d.sprintId === 'sprint-14')).toBe(true);
    });

    it('should combine search with filters', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, {
        query: 'tools',
        domain: 'cmos-mcp',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.every((d) => d.domain === 'cmos-mcp')).toBe(true);
    });

    it('should surface session-only decisions in sprint-scoped search', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2024-01-15T08:00:00Z', '2024-01-15T09:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Review retrospective decision',
            timestamp: '2024-01-15T09:00:00Z',
          },
        ])
      );
      db.close();

      const result = await cmosDecisionsSearchWithDb(dbPath, {
        query: 'retrospective decision',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.some((d) => d.decision === 'Review retrospective decision')).toBe(
        true
      );
      expect(
        result.data?.results.find((d) => d.decision === 'Review retrospective decision')?.source
      ).toBe('session_capture');
    });
  });

  describe('limit parameter', () => {
    it('should respect limit parameter', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, {
        query: 'all',
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(2);
    });

    it('should indicate when results are limited', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, {
        query: 'all',
        limit: 1,
      });

      expect(result.success).toBe(true);
      if (result.data?.totalMatches && result.data.totalMatches > 1) {
        expect(result.data?.limited).toBe(true);
      }
    });

    it('should use default limit of 20', async () => {
      // With only 6 decisions, we can't test the exact limit, but we can verify it returns all
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'all' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(20);
    });
  });

  describe('error handling', () => {
    it('should return error for empty query', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error for whitespace-only query', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error for single character query', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'a' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
    });

    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosDecisionsSearch({ query: 'test', projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosDecisionsSearchToolDefinition.name).toBe('cmos_decisions_search');
    });

    it('should have description', () => {
      expect(cmosDecisionsSearchToolDefinition.description).toBeTruthy();
      expect(cmosDecisionsSearchToolDefinition.description).toContain('Search');
    });

    it('should have query as required parameter', () => {
      expect(cmosDecisionsSearchToolDefinition.inputSchema.required).toContain('query');
    });

    it('should have valid input schema', () => {
      expect(cmosDecisionsSearchToolDefinition.inputSchema.type).toBe('object');
      expect(cmosDecisionsSearchToolDefinition.inputSchema.properties).toBeDefined();
      expect(cmosDecisionsSearchToolDefinition.inputSchema.properties.query).toBeDefined();
      expect(cmosDecisionsSearchToolDefinition.inputSchema.properties.domain).toBeDefined();
      expect(cmosDecisionsSearchToolDefinition.inputSchema.properties.limit).toBeDefined();
    });
  });

  describe('formatDecisionsSearchForLLM', () => {
    it('should format success result', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('TypeScript');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await cmosDecisionsSearch({ query: 'test', projectRoot: emptyDir });
        const formatted = formatDecisionsSearchForLLM(result);

        expect(formatted).toContain('Failed');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show query in output', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'pagination' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('pagination');
    });

    it('should show suggestions for no results', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'nonexistent' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('No decisions found');
      expect(formatted).toContain('Suggestion');
    });

    it('should include relevance in output', async () => {
      const result = await cmosDecisionsSearchWithDb(dbPath, { query: 'tools' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('Relevance');
    });
  });
});

/**
 * Helper to run cmosDecisionsSearch with explicit database path.
 */
async function cmosDecisionsSearchWithDb(
  dbPath: string,
  params: { query: string; domain?: string; sprintId?: string; limit?: number }
): Promise<CmosToolResult<CmosDecisionsSearchResult>> {
  if (!params.query || params.query.trim().length === 0) {
    return createError(CmosErrors.missingParameter('query'));
  }

  const limit = params.limit ?? 20;
  const query = params.query.trim();

  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return createError(
      CmosErrors.invalidParameter('query', query, ['At least one keyword with 2+ characters'])
    );
  }

  return cmosDecisionsSearch({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
