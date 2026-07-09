/**
 * cmos_session_search Tool Tests
 *
 * s77-m05: these drive the REAL cmosSessionSearch handler (via projectRoot) against
 * a seeded temp store — the previous ~220-line reimplementation (a drift hazard whose
 * highlight logic had already diverged from the real createHighlight) was removed.
 *
 * @module tests/tools/cmos/cmos-session-search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSessionSearch,
  formatSessionSearchForLLM,
  VALID_SESSION_TYPES,
  type CmosSessionSearchParams,
  type CmosSessionSearchResult,
} from '../../../src/tools/cmos/cmos-session-search';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';
import type { CmosSessionSearchResult as SessionSearchResultType } from '../../../src/tools/cmos/cmos-session-search';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('cmos_session_search', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-session-search-test-'));
    const dbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

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

      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Search Test'), ('project_id', 'search-test');

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

  /** Drive the REAL cmosSessionSearch handler against the seeded temp store. */
  function search(
    params: Omit<CmosSessionSearchParams, 'projectRoot'>
  ): Promise<CmosToolResult<CmosSessionSearchResult>> {
    CmosDetector.resetInstance();
    return cmosSessionSearch({ ...params, projectRoot: tempDir });
  }

  describe('basic search functionality', () => {
    it('should search across session titles', async () => {
      const result = await search({ query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.some((r) => r.title.includes('Planning'))).toBe(true);
    });

    it('should search across session summaries', async () => {
      const result = await search({ query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results[0].matchedIn).toContain('summary');
    });

    it('should search across captures', async () => {
      const result = await search({ query: 'SQLite' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(2); // PS-001 and PS-003
      expect(result.data?.results[0].matchedIn).toContain('captures');
    });

    it('should return matched captures with highlights (real createHighlight)', async () => {
      const result = await search({ query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results[0].matchedCaptures.length).toBeGreaterThan(0);
      const hl = result.data?.results[0].matchedCaptures[0].highlight;
      expect(hl).toBeDefined();
      // createHighlight extracts a window around the first keyword — the matched
      // snippet must actually contain the query.
      expect(hl?.toLowerCase()).toContain('typescript');
    });

    it('should rank results by relevance', async () => {
      const result = await search({ query: 'SQLite' });

      expect(result.success).toBe(true);
      const relevances = result.data?.results.map((r) => r.relevance) ?? [];
      for (let i = 1; i < relevances.length; i++) {
        expect(relevances[i]).toBeLessThanOrEqual(relevances[i - 1]);
      }
    });
  });

  describe('filtering', () => {
    it('should filter by capture category', async () => {
      const result = await search({ query: 'SQLite', category: 'learning' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        for (const capture of session.matchedCaptures) {
          expect(capture.category).toBe('learning');
        }
      }
    });

    it('should filter by session type', async () => {
      const result = await search({ query: 'session', type: 'planning' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(session.type).toBe('planning');
      }
    });

    it('should filter by date range (since)', async () => {
      const result = await search({ query: 'session', since: '2024-01-17' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(new Date(session.startedAt) >= new Date('2024-01-17')).toBe(true);
      }
    });

    it('should filter by date range (until)', async () => {
      const result = await search({ query: 'session', until: '2024-01-16T12:00:00Z' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(new Date(session.startedAt) <= new Date('2024-01-16T12:00:00Z')).toBe(true);
      }
    });

    it('should apply multiple filters', async () => {
      const result = await search({ query: 'Planning', type: 'planning', since: '2024-01-15' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(session.type).toBe('planning');
        expect(new Date(session.startedAt) >= new Date('2024-01-15')).toBe(true);
      }
    });
  });

  describe('pagination', () => {
    it('should respect limit parameter', async () => {
      const result = await search({ query: 'session', limit: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(2);
    });

    it('should indicate when results are limited', async () => {
      const result = await search({ query: 'session', limit: 1 });

      expect(result.success).toBe(true);
      if (result.data?.totalMatches && result.data.totalMatches > 1) {
        expect(result.data?.limited).toBe(true);
      }
    });

    it('should default limit to 20', async () => {
      const result = await search({ query: 'session' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(20);
    });
  });

  describe('error handling', () => {
    it('should return error for empty query', async () => {
      const result = await search({ query: '' });

      expect(result.success).toBe(false);
    });

    it('should return empty results for non-matching query', async () => {
      const result = await search({ query: 'xyznonexistent' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(0);
      expect(result.data?.totalMatches).toBe(0);
    });
  });

  describe('exports', () => {
    it('exposes the valid session types', () => {
      expect(VALID_SESSION_TYPES).toContain('planning');
      expect(VALID_SESSION_TYPES).toContain('review');
      expect(VALID_SESSION_TYPES).toContain('research');
    });
  });

  describe('via cmos_session(action="search") — end-to-end through the router', () => {
    it('drives the real handler and returns matchedCaptures with a highlight', async () => {
      CmosDetector.resetInstance();
      const result = (await cmosSession({
        action: 'search',
        query: 'SQLite',
        projectRoot: tempDir,
      })) as CmosToolResult<SessionSearchResultType>;

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(2); // PS-001 + PS-003
      const withCaptures = result.data?.results.find((r) => r.matchedCaptures.length > 0);
      expect(withCaptures).toBeDefined();
      expect(withCaptures?.matchedCaptures[0].highlight.toLowerCase()).toContain('sqlite');
    });

    it('surfaces MISSING_PARAMETER when query is omitted (?? "" reaches the handler)', async () => {
      CmosDetector.resetInstance();
      const result = await cmosSession({ action: 'search', projectRoot: tempDir });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAMETER');
    });
  });

  describe('formatSessionSearchForLLM', () => {
    it('should format search results', async () => {
      const result = await search({ query: 'Planning' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('Planning');
    });

    it('should show filter information', async () => {
      const result = await search({ query: 'test', type: 'planning' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('type: planning');
    });

    it('should show matched captures', async () => {
      const result = await search({ query: 'TypeScript' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('decision');
    });
  });
});
