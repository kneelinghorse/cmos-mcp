import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getEmbedder,
  recordEmbedding,
  __resetEmbedderCacheForTesting,
  __getEmbedderLoadAttemptsForTesting,
} from '../../src/intelligence/embedding-pipeline';
import { HybridRetriever } from '../../src/tools/cmos/fts5-retriever';
import { CmosDatabaseClient } from '../../src/tools/cmos/client';
import { TokenCounter } from '../../src/intelligence/token-counters';
import * as bootstrap from '../../src/intelligence/tokenizer-bootstrap';

// s78-m03: offline graceful-degrade + negative caching. Drives the REAL getEmbedder path
// (NOT setEmbedderForTesting) with the library-level offline mechanism — CMOS_OFFLINE_EMBEDDINGS=1
// (env.allowRemoteModels=false) + an empty CMOS_MODEL_CACHE_DIR — so the model load fails without
// any external egress. Isolated file: env vars are restored in afterAll (process.env is
// worker-scoped and would otherwise leak to sibling test files).

describe('offline graceful-degrade + negative caching (s78-m03)', () => {
  let tempDir: string;
  let dbPath: string;
  let savedOffline: string | undefined;
  let savedCacheDir: string | undefined;

  async function openClient(): Promise<CmosDatabaseClient> {
    const result = await CmosDatabaseClient.create({ dbPath });
    if (!result.success || !result.data) {
      throw new Error(`open failed: ${result.error?.message}`);
    }
    return result.data;
  }

  beforeAll(() => {
    savedOffline = process.env.CMOS_OFFLINE_EMBEDDINGS;
    savedCacheDir = process.env.CMOS_MODEL_CACHE_DIR;
    process.env.CMOS_OFFLINE_EMBEDDINGS = '1';
  });

  afterAll(() => {
    __resetEmbedderCacheForTesting();
    bootstrap.__test__.reset();
    if (savedOffline === undefined) delete process.env.CMOS_OFFLINE_EMBEDDINGS;
    else process.env.CMOS_OFFLINE_EMBEDDINGS = savedOffline;
    if (savedCacheDir === undefined) delete process.env.CMOS_MODEL_CACHE_DIR;
    else process.env.CMOS_MODEL_CACHE_DIR = savedCacheDir;
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-offline-degrade-'));
    const dbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    // Empty model cache dir → with allowRemoteModels=false the model is unfindable.
    const emptyCache = path.join(tempDir, 'empty-model-cache');
    fs.mkdirSync(emptyCache, { recursive: true });
    process.env.CMOS_MODEL_CACHE_DIR = emptyCache;

    dbPath = path.join(dbDir, 'cmos.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_text TEXT NOT NULL,
        category TEXT,
        sprint_id TEXT,
        evidence TEXT,
        created_at TEXT NOT NULL,
        last_embedded_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE VIRTUAL TABLE decisions_fts USING fts5(
        decision_text, content='strategic_decisions', content_rowid='id'
      );
      CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
        INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
      END;
    `);
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status) VALUES (?, ?, 'active')`
    );
    insert.run('Use SQLite as the single source of truth for retrieval', now);
    insert.run('Hybrid retrieval fuses BM25 with vector cosine via RRF', now);
    db.close();

    __resetEmbedderCacheForTesting();
    bootstrap.__test__.reset();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('embedder load is attempted AT MOST once; getEmbedder returns a no-op after failure', async () => {
    const first = await getEmbedder();
    const second = await getEmbedder();
    const third = await getEmbedder();
    expect(__getEmbedderLoadAttemptsForTesting()).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    // The negative-cache sentinel throws on use (callers catch and degrade).
    await expect(first('hello world')).rejects.toThrow(/unavailable/i);
  });

  test('recordEmbedding degrades to action:"failed" without throwing', async () => {
    const client = await openClient();
    try {
      const result = await recordEmbedding(client, {
        type: 'decision',
        id: 1,
        inputText: 'Use SQLite as the single source of truth for retrieval',
      });
      expect(result.action).toBe('failed');
    } finally {
      client.close();
    }
    // Still at most one load attempt after a recordEmbedding round-trip.
    expect(__getEmbedderLoadAttemptsForTesting()).toBe(1);
  });

  test('HybridRetriever.search returns non-empty BM25-only results with no embedder', async () => {
    const client = await openClient();
    try {
      const retriever = new HybridRetriever(client, { backend: 'hybrid' });
      const results = await retriever.search('SQLite source of truth retrieval', {
        types: ['decision'],
      });
      expect(results.length).toBeGreaterThan(0);
      // Vector arm disabled → cosine similarity is absent on every result.
      expect(
        results.every((r) => r.vectorSimilarity === null || r.vectorSimilarity === undefined)
      ).toBe(true);
    } finally {
      client.close();
    }
  });

  test('Claude tokenizer falls back to heuristic once, not per call (negative cache)', async () => {
    // Inject a loader that fails (offline). The real path (empty cache + allowRemoteModels=false)
    // fails the same way; the injected loader keeps this deterministic and network-free.
    bootstrap.__test__.setModuleLoaders({
      claude: async () => {
        throw new Error('network unavailable (offline)');
      },
    });

    const t1 = await bootstrap.getClaudeTokenizerInstance();
    const t2 = await bootstrap.getClaudeTokenizerInstance();
    const t3 = await bootstrap.getClaudeTokenizerInstance();
    expect(t1).toBeNull();
    expect(t2).toBeNull();
    expect(t3).toBeNull();
    const state = bootstrap.__test__.getState();
    expect(state.claudeLoadAttempts).toBe(1);
    expect(state.claudeLoadFailed).toBe(true);

    // TokenCounter still returns a positive heuristic count for Claude despite the failed load.
    const counter = new TokenCounter();
    const count = await counter.count('some text to count for claude', 'claude');
    expect(count.count).toBeGreaterThan(0);
  });
});
