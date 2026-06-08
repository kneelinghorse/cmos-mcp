/**
 * FTS5Retriever Tests
 *
 * Tests for Layer 3 working retrieval: recency decay formula,
 * OR semantics, status filtering, and ranking order.
 *
 * @module tests/tools/cmos/fts5-retriever
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  FTS5Retriever,
  computeRecencyFactor,
  computeAgeDays,
} from '../../../src/tools/cmos/fts5-retriever';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-fts5-retriever-test-'));
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

    CREATE TRIGGER decisions_fts_delete AFTER DELETE ON strategic_decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, decision_text)
        VALUES('delete', old.id, old.decision_text);
    END;
  `);
  db.close();
  return { tempDir, dbPath };
}

async function openClient(dbPath: string): Promise<CmosDatabaseClient> {
  const result = await CmosDatabaseClient.create({ dbPath });
  if (!result.success || !result.data) {
    throw new Error(`Failed to open test DB: ${result.error?.message}`);
  }
  return result.data;
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

// ─── computeRecencyFactor ─────────────────────────────────────────────────────

describe('computeRecencyFactor', () => {
  it('returns 1.0 for age 0 days (just created)', () => {
    expect(computeRecencyFactor(0)).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.368 at 60 days (half-life)', () => {
    expect(computeRecencyFactor(60)).toBeCloseTo(Math.exp(-1), 3);
  });

  it('returns ~0.135 at 120 days (2× half-life)', () => {
    expect(computeRecencyFactor(120)).toBeCloseTo(Math.exp(-2), 3);
  });

  it('returns smaller value for older items', () => {
    expect(computeRecencyFactor(30)).toBeGreaterThan(computeRecencyFactor(90));
  });
});

// ─── computeAgeDays ──────────────────────────────────────────────────────────

describe('computeAgeDays', () => {
  it('returns 0 for null', () => {
    expect(computeAgeDays(null)).toBe(0);
  });

  it('returns 0 for invalid date string', () => {
    expect(computeAgeDays('not-a-date')).toBe(0);
  });

  it('returns approximately correct age for known past date', () => {
    const tenDaysAgo = daysAgoISO(10);
    const age = computeAgeDays(tenDaysAgo);
    expect(age).toBeGreaterThan(9.9);
    expect(age).toBeLessThan(10.1);
  });

  it('returns 0 for a current timestamp', () => {
    const now = new Date().toISOString();
    expect(computeAgeDays(now)).toBeLessThan(0.01);
  });
});

// ─── FTS5Retriever.capabilities ──────────────────────────────────────────────

describe('FTS5Retriever.capabilities', () => {
  let tempDir: string;
  let client: CmosDatabaseClient;

  beforeEach(async () => {
    const { tempDir: td, dbPath } = makeTempDb();
    tempDir = td;
    client = await openClient(dbPath);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('reports fts5 backend, no semantic search, recency boost enabled', () => {
    const retriever = new FTS5Retriever(client);
    const caps = retriever.capabilities();
    expect(caps.backend).toBe('fts5');
    expect(caps.semanticSearch).toBe(false);
    expect(caps.recencyBoost).toBe(true);
    expect(caps.supportedTypes).toContain('decision');
  });
});

// ─── FTS5Retriever.search ─────────────────────────────────────────────────────

describe('FTS5Retriever.search', () => {
  let tempDir: string;
  let dbPath: string;
  let client: CmosDatabaseClient;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempDb());
    client = await openClient(dbPath);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('returns empty array for query with no keyword matches', () => {
    insertDecision(dbPath, 'Use PostgreSQL for all persistent storage');
    const retriever = new FTS5Retriever(client);
    const results = retriever.search('zzz-no-match-xyz');
    expect(results).toHaveLength(0);
  });

  it('returns matching decisions ranked by combined score', () => {
    insertDecision(dbPath, 'Use FTS5 for full-text search across decisions', {
      createdAt: daysAgoISO(5),
    });
    insertDecision(dbPath, 'Use PostgreSQL for persistent storage', {
      createdAt: daysAgoISO(5),
    });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('FTS5 full-text search');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('FTS5');
  });

  it('respects limit option', () => {
    for (let i = 0; i < 10; i++) {
      insertDecision(dbPath, `Decision about context retrieval approach number ${i}`);
    }

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('context retrieval', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('filters out superseded/archived decisions by default', () => {
    insertDecision(dbPath, 'FTS5 for context retrieval', { status: 'active' });
    insertDecision(dbPath, 'FTS5 is great for context retrieval', { status: 'superseded' });
    insertDecision(dbPath, 'FTS5 works well for context retrieval', { status: 'archived' });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('FTS5 context retrieval');

    expect(results.every((r) => r.type === 'decision')).toBe(true);
    // Only the active one should be in results
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain('FTS5 for context retrieval');
  });

  it('includes superseded decisions when statusFilter includes superseded', () => {
    insertDecision(dbPath, 'FTS5 for context search', { status: 'active' });
    insertDecision(dbPath, 'FTS5 for context search (old)', { status: 'superseded' });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('FTS5 context search', {
      statusFilter: ['active', 'superseded'],
    });
    expect(results.length).toBe(2);
  });

  it('ranks recent decisions higher than old ones with same BM25 relevance', () => {
    // Same text (same BM25 relevance), different age
    insertDecision(dbPath, 'context v2 retrieval architecture decision', {
      createdAt: daysAgoISO(2), // Very recent
    });
    insertDecision(dbPath, 'context v2 retrieval architecture decision', {
      createdAt: daysAgoISO(120), // Much older
    });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('context v2 retrieval architecture', {
      recencyWeight: 1.0, // Full recency boost
    });

    expect(results.length).toBe(2);
    // Recent should rank higher
    expect(results[0].ageDays).toBeLessThan(results[1].ageDays);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('uses pure BM25 when recencyWeight=0', () => {
    insertDecision(dbPath, 'context retrieval relevance scoring', {
      createdAt: daysAgoISO(2),
    });
    insertDecision(dbPath, 'context retrieval relevance scoring', {
      createdAt: daysAgoISO(120),
    });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('context retrieval relevance', {
      recencyWeight: 0, // Pure BM25
    });

    // With recencyWeight=0, scores should be equal (same text, same BM25)
    expect(results.length).toBe(2);
    // Both scores should be equal (pure BM25, same text)
    expect(results[0].score).toBeCloseTo(results[1].score, 3);
  });

  it('result contains all required fields', () => {
    insertDecision(dbPath, 'Use SQLite for embedded storage', {
      createdAt: daysAgoISO(10),
      category: 'architectural',
      sprintId: 'sprint-5',
    });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('SQLite embedded storage');

    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r).toMatchObject({
      id: expect.any(Number),
      type: 'decision',
      text: expect.any(String),
      score: expect.any(Number),
      bm25Score: expect.any(Number),
      recencyFactor: expect.any(Number),
      ageDays: expect.any(Number),
    });
    expect(r.category).toBe('architectural');
    expect(r.sprintId).toBe('sprint-5');
  });

  it('recencyFactor is between 0 and 1', () => {
    insertDecision(dbPath, 'recency factor retrieval test', {
      createdAt: daysAgoISO(30),
    });

    const retriever = new FTS5Retriever(client);
    const results = retriever.search('recency factor retrieval');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].recencyFactor).toBeGreaterThan(0);
    expect(results[0].recencyFactor).toBeLessThanOrEqual(1);
  });
});

// ─── FTS5Retriever.get ────────────────────────────────────────────────────────

describe('FTS5Retriever.get', () => {
  let tempDir: string;
  let dbPath: string;
  let client: CmosDatabaseClient;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempDb());
    client = await openClient(dbPath);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  it('fetches a decision by ID', () => {
    insertDecision(dbPath, 'Use event sourcing for audit trail');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT id FROM strategic_decisions LIMIT 1').get() as { id: number };
    db.close();

    const retriever = new FTS5Retriever(client);
    const result = retriever.get(row.id, 'decision');
    expect(result).not.toBeNull();
    expect(result?.text).toBe('Use event sourcing for audit trail');
    expect(result?.type).toBe('decision');
  });

  it('returns null for unknown ID', () => {
    const retriever = new FTS5Retriever(client);
    const result = retriever.get(99999, 'decision');
    expect(result).toBeNull();
  });

  it('returns null for unsupported type', () => {
    const retriever = new FTS5Retriever(client);
    const result = retriever.get(1, 'learning');
    expect(result).toBeNull();
  });
});
