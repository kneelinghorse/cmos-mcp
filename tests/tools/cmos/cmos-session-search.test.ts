/**
 * cmos_session_search Tool Tests
 *
 * Tests for session search functionality.
 *
 * @module tests/tools/cmos/cmos-session-search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSessionSearch,
  cmosSessionSearchToolDefinition,
  formatSessionSearchForLLM,
  VALID_SESSION_TYPES,
  type CmosSessionSearchResult,
} from '../../../src/tools/cmos/cmos-session-search';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('cmos_session_search', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-session-search-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      -- Insert test data
      INSERT INTO sprints (id, title, status)
      VALUES ('sprint-14', 'Sprint 14', 'Current');

      INSERT INTO sessions (id, type, title, sprint_id, started_at, status, summary, captures)
      VALUES
        ('PS-001', 'planning', 'Sprint Planning Session', 'sprint-14', '2024-01-15T09:00:00Z', 'completed', 'Planned sprint 14 with TypeScript focus', '[{"category":"decision","content":"Use TypeScript for all tools","timestamp":"2024-01-15T09:30:00Z"},{"category":"learning","content":"SQLite is fast enough","timestamp":"2024-01-15T09:45:00Z"}]'),
        ('PS-002', 'review', 'Code Review Session', 'sprint-14', '2024-01-16T10:00:00Z', 'completed', 'Reviewed mission implementation code', '[{"category":"decision","content":"Add error handling","timestamp":"2024-01-16T10:30:00Z"},{"category":"constraint","content":"Must maintain backward compatibility","timestamp":"2024-01-16T10:45:00Z"}]'),
        ('PS-003', 'research', 'Database Research', 'sprint-14', '2024-01-17T14:00:00Z', 'active', NULL, '[{"category":"learning","content":"SQLite WAL mode improves performance","timestamp":"2024-01-17T14:30:00Z"},{"category":"next-step","content":"Implement caching layer","timestamp":"2024-01-17T14:45:00Z"}]'),
        ('PS-004', 'planning', 'Feature Planning', 'sprint-14', '2024-01-18T09:00:00Z', 'completed', 'Planned search functionality', '[{"category":"context","content":"Search needs to be fast","timestamp":"2024-01-18T09:30:00Z"}]');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic search functionality', () => {
    it('should search across session titles', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.some((r) => r.title.includes('Planning'))).toBe(true);
    });

    it('should search across session summaries', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results[0].matchedIn).toContain('summary');
    });

    it('should search across captures', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'SQLite' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(2); // PS-001 and PS-003
      expect(result.data?.results[0].matchedIn).toContain('captures');
    });

    it('should return matched captures with highlights', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results[0].matchedCaptures.length).toBeGreaterThan(0);
      expect(result.data?.results[0].matchedCaptures[0].highlight).toBeDefined();
    });

    it('should rank results by relevance', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'SQLite' });

      expect(result.success).toBe(true);
      // Results should be ordered by relevance (descending)
      const relevances = result.data?.results.map((r) => r.relevance) ?? [];
      for (let i = 1; i < relevances.length; i++) {
        expect(relevances[i]).toBeLessThanOrEqual(relevances[i - 1]);
      }
    });
  });

  describe('filtering', () => {
    it('should filter by capture category', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'SQLite',
        category: 'learning',
      });

      expect(result.success).toBe(true);
      // Only captures with category 'learning' should be in matchedCaptures
      for (const session of result.data?.results ?? []) {
        for (const capture of session.matchedCaptures) {
          expect(capture.category).toBe('learning');
        }
      }
    });

    it('should filter by session type', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'session',
        type: 'planning',
      });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(session.type).toBe('planning');
      }
    });

    it('should filter by date range (since)', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'session',
        since: '2024-01-17',
      });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(new Date(session.startedAt) >= new Date('2024-01-17')).toBe(true);
      }
    });

    it('should filter by date range (until)', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'session',
        until: '2024-01-16T12:00:00Z',
      });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(new Date(session.startedAt) <= new Date('2024-01-16T12:00:00Z')).toBe(true);
      }
    });

    it('should apply multiple filters', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'Planning',
        type: 'planning',
        since: '2024-01-15',
      });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(session.type).toBe('planning');
        expect(new Date(session.startedAt) >= new Date('2024-01-15')).toBe(true);
      }
    });
  });

  describe('pagination', () => {
    it('should respect limit parameter', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'session',
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(2);
    });

    it('should indicate when results are limited', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'session',
        limit: 1,
      });

      expect(result.success).toBe(true);
      if (result.data?.totalMatches && result.data.totalMatches > 1) {
        expect(result.data?.limited).toBe(true);
      }
    });

    it('should default limit to 20', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'session' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(20);
    });
  });

  describe('error handling', () => {
    it('should return error for empty query', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: '' });

      expect(result.success).toBe(false);
    });

    it('should return empty results for non-matching query', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'xyznonexistent' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(0);
      expect(result.data?.totalMatches).toBe(0);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSessionSearchToolDefinition.name).toBe('cmos_session_search');
    });

    it('should have description', () => {
      expect(cmosSessionSearchToolDefinition.description).toBeTruthy();
      expect(cmosSessionSearchToolDefinition.description.toLowerCase()).toContain('search');
    });

    it('should require query parameter', () => {
      expect(cmosSessionSearchToolDefinition.inputSchema.required).toContain('query');
    });

    it('should have valid session types', () => {
      expect(VALID_SESSION_TYPES).toContain('planning');
      expect(VALID_SESSION_TYPES).toContain('review');
      expect(VALID_SESSION_TYPES).toContain('research');
    });
  });

  describe('formatSessionSearchForLLM', () => {
    it('should format search results', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'Planning' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('Planning');
    });

    it('should show filter information', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, {
        query: 'test',
        type: 'planning',
      });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('type: planning');
    });

    it('should show matched captures', async () => {
      const result = await cmosSessionSearchWithDb(dbPath, { query: 'TypeScript' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('decision');
    });
  });
});

/**
 * Helper to run cmosSessionSearch with explicit database path.
 */
async function cmosSessionSearchWithDb(
  dbPath: string,
  params: {
    query: string;
    category?: 'decision' | 'learning' | 'constraint' | 'context' | 'next-step';
    type?: 'planning' | 'review' | 'research' | 'onboarding' | 'check-in' | 'custom';
    since?: string;
    until?: string;
    limit?: number;
  }
): Promise<{
  success: boolean;
  data?: CmosSessionSearchResult;
  error?: { code: string; message: string };
}> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError, CmosErrors } = await import('../../../src/tools/cmos/errors');

  if (!params.query || params.query.trim().length === 0) {
    return createError(CmosErrors.missingParameter('query'));
  }

  const limit = params.limit ?? 20;
  const query = params.query.trim().toLowerCase();
  const keywords = query.split(/\s+/).filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return createError(
      CmosErrors.invalidParameter('query', query, ['At least one keyword with 2+ characters'])
    );
  }

  return withClient(
    (client) => {
      // Build WHERE clauses
      const clauses: string[] = [];
      const queryParams: (string | number)[] = [];

      if (params.type) {
        clauses.push('type = ?');
        queryParams.push(params.type);
      }

      if (params.since) {
        clauses.push('started_at >= ?');
        queryParams.push(params.since);
      }

      if (params.until) {
        clauses.push('started_at <= ?');
        queryParams.push(params.until);
      }

      // Build search condition
      const searchConditions: string[] = [];
      for (const keyword of keywords) {
        searchConditions.push(
          `(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(COALESCE(captures, '')) LIKE ?)`
        );
        queryParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
      }

      if (searchConditions.length > 0) {
        clauses.push(`(${searchConditions.join(' AND ')})`);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      // Get sessions
      interface SessionRow {
        id: string;
        type: string;
        title: string;
        status: string;
        sprint_id: string | null;
        started_at: string;
        completed_at: string | null;
        summary: string | null;
        captures: string | null;
      }

      const result = client.getMany<SessionRow>(
        `SELECT id, type, title, status, sprint_id, started_at, completed_at, summary, captures
         FROM sessions ${whereClause} ORDER BY started_at DESC LIMIT ?`,
        [...queryParams, limit + 10]
      );

      if (!result.success || !result.data) {
        return createSuccess<CmosSessionSearchResult>({
          query: params.query,
          results: [],
          totalMatches: 0,
          limited: false,
          filters: {
            category: params.category,
            type: params.type,
            since: params.since,
            until: params.until,
          },
        });
      }

      // Process results
      interface ParsedCapture {
        category: string;
        content: string;
        timestamp: string;
      }

      interface ProcessedResult {
        id: string;
        type: string;
        title: string;
        status: string;
        sprintId: string | null;
        startedAt: string;
        completedAt: string | null;
        summary: string | null;
        captureCount: number;
        matchedCaptures: Array<{
          category: 'decision' | 'learning' | 'constraint' | 'context' | 'next-step';
          content: string;
          timestamp: string;
          highlight: string;
        }>;
        matchedIn: ('title' | 'summary' | 'captures')[];
        relevance: number;
      }

      const processedResults: ProcessedResult[] = [];

      for (const row of result.data) {
        let captures: ParsedCapture[] = [];
        try {
          captures = JSON.parse(row.captures || '[]');
        } catch {
          captures = [];
        }

        if (params.category) {
          captures = captures.filter((c) => c.category === params.category);
        }

        const matchedIn: ('title' | 'summary' | 'captures')[] = [];
        let relevance = 0;

        const titleLower = row.title.toLowerCase();
        for (const keyword of keywords) {
          if (titleLower.includes(keyword)) {
            if (!matchedIn.includes('title')) matchedIn.push('title');
            relevance += 3;
          }
        }

        const summaryLower = (row.summary || '').toLowerCase();
        for (const keyword of keywords) {
          if (summaryLower.includes(keyword)) {
            if (!matchedIn.includes('summary')) matchedIn.push('summary');
            relevance += 2;
          }
        }

        const matchedCaptures: ProcessedResult['matchedCaptures'] = [];
        for (const capture of captures) {
          const contentLower = capture.content.toLowerCase();
          let captureMatches = false;

          for (const keyword of keywords) {
            if (contentLower.includes(keyword)) {
              captureMatches = true;
              relevance += 1;
            }
          }

          if (captureMatches) {
            if (!matchedIn.includes('captures')) matchedIn.push('captures');
            matchedCaptures.push({
              category: capture.category as ProcessedResult['matchedCaptures'][0]['category'],
              content: capture.content,
              timestamp: capture.timestamp,
              highlight:
                capture.content.slice(0, 100) + (capture.content.length > 100 ? '...' : ''),
            });
          }
        }

        if (matchedIn.length === 0) continue;

        processedResults.push({
          id: row.id,
          type: row.type,
          title: row.title,
          status: row.status,
          sprintId: row.sprint_id,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          summary: row.summary,
          captureCount: captures.length,
          matchedCaptures,
          matchedIn,
          relevance,
        });
      }

      processedResults.sort((a, b) => b.relevance - a.relevance);
      const limitedResults = processedResults.slice(0, limit);

      return createSuccess<CmosSessionSearchResult>({
        query: params.query,
        results: limitedResults,
        totalMatches: processedResults.length,
        limited: processedResults.length > limit,
        filters: {
          category: params.category,
          type: params.type,
          since: params.since,
          until: params.until,
        },
      });
    },
    { dbPath }
  );
}
