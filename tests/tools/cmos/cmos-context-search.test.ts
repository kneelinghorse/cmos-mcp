/**
 * cmos_context(action="search") Tests
 *
 * Integration tests for the Layer 3 search action: query validation,
 * result ranking, status filtering, and formatter output.
 *
 * @module tests/tools/cmos/cmos-context-search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosContextSearch,
  formatContextSearchForLLM,
} from '../../../src/tools/cmos/cmos-context-search';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-context-search-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      category TEXT,
      sprint_id TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE VIRTUAL TABLE decisions_fts USING fts5(
      decision_text,
      content='strategic_decisions',
      content_rowid='id'
    );

    CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
      INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
    END;
  `);
  db.close();
  return { tempDir, dbPath };
}

function insertDecision(
  dbPath: string,
  text: string,
  opts: { createdAt?: string; status?: string; category?: string; sprintId?: string } = {}
): void {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO strategic_decisions (decision_text, created_at, status, category, sprint_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    text,
    opts.createdAt ?? now,
    opts.status ?? 'active',
    opts.category ?? null,
    opts.sprintId ?? null
  );
  db.close();
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ─── cmosContextSearch ────────────────────────────────────────────────────────

describe('cmosContextSearch', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ tempDir, dbPath } = makeTempDb());
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('returns error when query is empty', async () => {
    const result = await cmosContextSearch({ query: '', projectRoot: tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('returns error when query is whitespace only', async () => {
    const result = await cmosContextSearch({ query: '   ', projectRoot: tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('returns empty results for query with no matches', async () => {
    insertDecision(dbPath, 'Use PostgreSQL for persistent storage');
    const result = await cmosContextSearch({ query: 'zzz-no-match', projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(0);
    expect(result.data?.results).toHaveLength(0);
  });

  it('returns matching decisions with required fields', async () => {
    insertDecision(dbPath, 'Use FTS5 full-text search for context retrieval', {
      category: 'architectural',
      sprintId: 'sprint-50',
    });

    const result = await cmosContextSearch({
      query: 'FTS5 context retrieval',
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.count).toBeGreaterThan(0);

    const r = result.data!.results[0];
    expect(r).toMatchObject({
      id: expect.any(Number),
      type: 'decision',
      text: expect.any(String),
      score: expect.any(Number),
      bm25Score: expect.any(Number),
      recencyFactor: expect.any(Number),
      ageDays: expect.any(Number),
    });
  });

  it('respects limit option', async () => {
    for (let i = 0; i < 10; i++) {
      insertDecision(dbPath, `Context retrieval architecture decision number ${i}`);
    }

    const result = await cmosContextSearch({
      query: 'context retrieval architecture',
      limit: 3,
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.results.length).toBeLessThanOrEqual(3);
  });

  it('includes query and options in response metadata', async () => {
    const result = await cmosContextSearch({
      query: 'FTS5 retrieval',
      limit: 3,
      recencyWeight: 0.7,
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.query).toBe('FTS5 retrieval');
    expect(result.data?.options.limit).toBe(3);
    expect(result.data?.options.recencyWeight).toBe(0.7);
    expect(result.data?.backend).toBe('hybrid');
  });

  it('uses defaults when options not provided', async () => {
    const result = await cmosContextSearch({ query: 'test query', projectRoot: tempDir });
    expect(result.data?.options.limit).toBe(5);
    expect(result.data?.options.recencyWeight).toBe(0.5);
    expect(result.data?.options.types).toEqual(['decision']);
    expect(result.data?.options.statusFilter).toEqual(['active']);
  });

  it('filters out non-active decisions by default', async () => {
    insertDecision(dbPath, 'FTS5 context search active decision', { status: 'active' });
    insertDecision(dbPath, 'FTS5 context search superseded decision', { status: 'superseded' });

    const result = await cmosContextSearch({ query: 'FTS5 context search', projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(1);
    expect(result.data?.results[0].text).toContain('active decision');
  });

  it('ranks more recent decisions higher with recencyWeight=1', async () => {
    insertDecision(dbPath, 'context v2 retrieval decision', { createdAt: daysAgoISO(2) });
    insertDecision(dbPath, 'context v2 retrieval decision', { createdAt: daysAgoISO(100) });

    const result = await cmosContextSearch({
      query: 'context v2 retrieval',
      recencyWeight: 1.0,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data!.results.length).toBe(2);
    expect(result.data!.results[0].ageDays).toBeLessThan(result.data!.results[1].ageDays);
  });
});

// ─── cmosContext(action="search") integration ─────────────────────────────────

describe('cmosContext(action="search") — integration', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ tempDir, dbPath } = makeTempDb());
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('routes search action to cmosContextSearch', async () => {
    insertDecision(dbPath, 'Use SQLite WAL mode for concurrent reads');

    const result = await cmosContext({
      action: 'search',
      query: 'SQLite WAL mode',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data =
      result.data as import('../../../src/tools/cmos/cmos-context-search').ContextSearchResult;
    expect(data.query).toBe('SQLite WAL mode');
    expect(data.backend).toBe('hybrid');
  });

  it('returns error when query is missing from search action', async () => {
    const result = await cmosContext({
      action: 'search',
      projectRoot: tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('passes searchLimit to the retriever', async () => {
    for (let i = 0; i < 10; i++) {
      insertDecision(dbPath, `Context retrieval test decision number ${i}`);
    }

    const result = await cmosContext({
      action: 'search',
      query: 'context retrieval test',
      searchLimit: 2,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data =
      result.data as import('../../../src/tools/cmos/cmos-context-search').ContextSearchResult;
    expect(data.results.length).toBeLessThanOrEqual(2);
  });
});

// ─── formatContextSearchForLLM ────────────────────────────────────────────────

describe('formatContextSearchForLLM', () => {
  it('formats error result', () => {
    const result = {
      success: false as const,
      error: { code: 'INVALID_PARAMETER', message: 'query is required' },
    };
    const formatted = formatContextSearchForLLM(result);
    expect(formatted).toContain('Search failed');
    expect(formatted).toContain('query is required');
  });

  it('formats empty results with suggestions', () => {
    const result = {
      success: true as const,
      data: {
        query: 'nonexistent topic',
        results: [],
        count: 0,
        options: {
          limit: 5,
          recencyWeight: 0.5,
          types: ['decision' as const],
          statusFilter: ['active'],
        },
        backend: 'fts5',
      },
    };
    const formatted = formatContextSearchForLLM(result);
    expect(formatted).toContain('nonexistent topic');
    expect(formatted).toContain('No matching results');
    expect(formatted).toContain('Suggestions');
  });

  it('formats results with scores and metadata', () => {
    const result = {
      success: true as const,
      data: {
        query: 'FTS5 retrieval',
        results: [
          {
            id: 1,
            type: 'decision' as const,
            text: 'Use FTS5 for full-text search',
            score: 1.5,
            bm25Score: 2.0,
            recencyFactor: 0.85,
            ageDays: 7,
            sprintId: 'sprint-50',
            category: 'architectural',
            evidence: null,
            createdAt: new Date().toISOString(),
          },
        ],
        count: 1,
        options: {
          limit: 5,
          recencyWeight: 0.5,
          types: ['decision' as const],
          statusFilter: ['active'],
        },
        backend: 'fts5',
      },
    };
    const formatted = formatContextSearchForLLM(result);
    expect(formatted).toContain('FTS5 retrieval');
    expect(formatted).toContain('Use FTS5 for full-text search');
    expect(formatted).toContain('sprint-50');
    expect(formatted).toContain('architectural');
    expect(formatted).toContain('score:');
  });
});
