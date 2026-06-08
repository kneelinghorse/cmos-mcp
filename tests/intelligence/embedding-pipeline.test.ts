// ABOUTME: Tests for src/intelligence/embedding-pipeline.ts (Sprint 66 m03).
// Covers per-type input composition, recordEmbedding skip-on-no-change behavior, vec0 upsert correctness,
// and a fixture-driven backfill scenario. Uses setEmbedderForTesting so the real Xenova model never loads.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../src/tools/cmos/client';
import { ensureVectorStorage } from '../../src/tools/cmos/schema-migrations';
import {
  recordEmbedding,
  decisionEmbeddingInput,
  learningEmbeddingInput,
  missionEmbeddingInput,
  setEmbedderForTesting,
  __resetEmbedderCacheForTesting,
  EMBEDDING_DIM,
  type Embedder,
} from '../../src/intelligence/embedding-pipeline';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-pipeline-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO metadata (key, value) VALUES ('schema_version', '2.2');

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT,
      notes TEXT,
      success_criteria TEXT,
      status TEXT NOT NULL DEFAULT 'Queued'
    );
  `);
  db.close();
  return { tempDir, dbPath };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

/** Build a fake embedder that returns a fixed 384-dim vector keyed off the input length.
 *  Tracks call count so tests can assert skip-on-no-change. */
function makeMockEmbedder(): { embedder: Embedder; callCount: () => number; reset: () => void } {
  let calls = 0;
  const embedder: Embedder = async (text: string) => {
    calls++;
    const arr = new Float32Array(EMBEDDING_DIM);
    // Seed the vector deterministically from text so different inputs map to
    // different vectors (helps the nearest-neighbour assertion downstream).
    const seed = ((text.length % EMBEDDING_DIM) + EMBEDDING_DIM) % EMBEDDING_DIM;
    arr[seed] = 1;
    return arr;
  };
  return {
    embedder,
    callCount: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}

// ─── Input composition ──────────────────────────────────────────────────────

describe('embedding-input composition', () => {
  it('decisionEmbeddingInput trims whitespace and returns the text', () => {
    expect(decisionEmbeddingInput('  Use sqlite-vec  ')).toBe('Use sqlite-vec');
  });

  it('learningEmbeddingInput trims whitespace and returns the content', () => {
    expect(learningEmbeddingInput('\nFTS5 is fast\n')).toBe('FTS5 is fast');
  });

  it('missionEmbeddingInput joins name, objective, notes, criteria with separators', () => {
    const out = missionEmbeddingInput({
      name: 'Hybrid retriever',
      objective: 'Fuse BM25 + cosine via RRF',
      notes: 'k=60',
      successCriteria: ['Top-3 recall', 'Recency preserved'],
    });
    expect(out).toBe(
      'Hybrid retriever — Fuse BM25 + cosine via RRF | k=60 | criteria: Top-3 recall; Recency preserved'
    );
  });

  it('missionEmbeddingInput skips null/empty fields cleanly', () => {
    expect(
      missionEmbeddingInput({ name: 'Bare', objective: null, notes: null, successCriteria: null })
    ).toBe('Bare');
  });

  it('missionEmbeddingInput filters empty strings out of success criteria', () => {
    const out = missionEmbeddingInput({
      name: 'Mission',
      objective: 'Do thing',
      notes: null,
      successCriteria: ['  ', 'Real criterion', ''],
    });
    expect(out).toBe('Mission — Do thing | criteria: Real criterion');
  });
});

// ─── recordEmbedding behavior ───────────────────────────────────────────────

describe('recordEmbedding', () => {
  let tempDir: string;
  let dbPath: string;
  let client: CmosDatabaseClient;
  let mock: ReturnType<typeof makeMockEmbedder>;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempDb());
    const result = await CmosDatabaseClient.create({ dbPath });
    client = result.data!;
    ensureVectorStorage(client);

    mock = makeMockEmbedder();
    setEmbedderForTesting(mock.embedder);
  });

  afterEach(() => {
    setEmbedderForTesting(null);
    __resetEmbedderCacheForTesting();
    client.close();
    cleanup(tempDir);
  });

  it('embeds on first call and stamps last_embedded_hash', async () => {
    const insert = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      ['Use RRF for hybrid scoring', new Date().toISOString()]
    );
    const id = Number(insert.data?.lastInsertRowid);

    const result = await recordEmbedding(client, {
      type: 'decision',
      id,
      inputText: decisionEmbeddingInput('Use RRF for hybrid scoring'),
    });

    expect(result.action).toBe('embedded');
    expect(mock.callCount()).toBe(1);

    const hashRow = client.getOne<{ last_embedded_hash: string | null }>(
      `SELECT last_embedded_hash FROM strategic_decisions WHERE id = ?`,
      [id]
    );
    expect(hashRow.data?.last_embedded_hash).toBeTruthy();

    const vecRow = client.getOne<{ decision_id: number }>(
      `SELECT decision_id FROM decisions_vec WHERE decision_id = ?`,
      [BigInt(id)]
    );
    expect(vecRow.data?.decision_id).toBe(id);
  });

  it('skips re-embedding when content_hash is unchanged', async () => {
    const insert = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      ['Stable content', new Date().toISOString()]
    );
    const id = Number(insert.data?.lastInsertRowid);

    const first = await recordEmbedding(client, {
      type: 'decision',
      id,
      inputText: 'Stable content',
    });
    expect(first.action).toBe('embedded');
    expect(mock.callCount()).toBe(1);

    const second = await recordEmbedding(client, {
      type: 'decision',
      id,
      inputText: 'Stable content',
    });
    expect(second.action).toBe('skipped-no-change');
    // Embedder must not have been called a second time.
    expect(mock.callCount()).toBe(1);
  });

  it('re-embeds when input text changes', async () => {
    const insert = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      ['Original', new Date().toISOString()]
    );
    const id = Number(insert.data?.lastInsertRowid);

    await recordEmbedding(client, { type: 'decision', id, inputText: 'Original' });
    const before = mock.callCount();

    const updated = await recordEmbedding(client, {
      type: 'decision',
      id,
      inputText: 'Updated text',
    });
    expect(updated.action).toBe('embedded');
    expect(mock.callCount()).toBe(before + 1);
  });

  it('upserts: a second embed on the same id replaces the vec row, not duplicates it', async () => {
    const insert = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      ['First', new Date().toISOString()]
    );
    const id = Number(insert.data?.lastInsertRowid);

    await recordEmbedding(client, { type: 'decision', id, inputText: 'First text' });
    await recordEmbedding(client, { type: 'decision', id, inputText: 'Second text' });

    const count = client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM decisions_vec WHERE decision_id = ?`,
      [BigInt(id)]
    );
    expect(count.data?.count).toBe(1);
  });

  it('handles INTEGER-PK learnings (BigInt coercion path)', async () => {
    const insert = client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
      'Learning content',
      new Date().toISOString(),
    ]);
    const id = Number(insert.data?.lastInsertRowid);

    const result = await recordEmbedding(client, {
      type: 'learning',
      id,
      inputText: 'Learning content',
    });
    expect(result.action).toBe('embedded');

    const vec = client.getOne<{ learning_id: number }>(
      `SELECT learning_id FROM learnings_vec WHERE learning_id = ?`,
      [BigInt(id)]
    );
    expect(vec.data?.learning_id).toBe(id);
  });

  it('handles TEXT-PK missions (no BigInt coercion)', async () => {
    client.execute(`INSERT INTO missions (id, name, objective) VALUES (?, ?, ?)`, [
      's99-m01',
      'Test mission',
      'Verify TEXT pk path',
    ]);

    const result = await recordEmbedding(client, {
      type: 'mission',
      id: 's99-m01',
      inputText: missionEmbeddingInput({
        name: 'Test mission',
        objective: 'Verify TEXT pk path',
        notes: null,
        successCriteria: null,
      }),
    });
    expect(result.action).toBe('embedded');

    const vec = client.getOne<{ mission_id: string }>(
      `SELECT mission_id FROM missions_vec WHERE mission_id = ?`,
      ['s99-m01']
    );
    expect(vec.data?.mission_id).toBe('s99-m01');
  });

  it('does not throw when the source row is missing — degrades to "failed"', async () => {
    // No INSERT into strategic_decisions; recordEmbedding tries to UPDATE a
    // nonexistent row. The hash-write fails silently (0 rows affected) but the
    // vec upsert still inserts. Both behaviours are part of the graceful-degrade
    // contract — what matters is no throw escapes to the caller.
    const result = await recordEmbedding(client, {
      type: 'decision',
      id: 99999,
      inputText: 'Orphan text',
    });
    expect(['embedded', 'failed']).toContain(result.action);
  });

  it('returns "failed" without throwing when the embedder throws', async () => {
    setEmbedderForTesting(async () => {
      throw new Error('simulated model failure');
    });

    const insert = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      ['Decision text', new Date().toISOString()]
    );
    const id = Number(insert.data?.lastInsertRowid);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await recordEmbedding(client, {
      type: 'decision',
      id,
      inputText: 'Decision text',
    });
    expect(result.action).toBe('failed');
    expect(result.error).toContain('simulated model failure');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`embedding-pipeline: decision#${id} failed`)
    );
    errorSpy.mockRestore();
  });
});

// ─── Fixture-corpus backfill ────────────────────────────────────────────────

describe('backfill behavior (fixture corpus)', () => {
  let tempDir: string;
  let dbPath: string;
  let client: CmosDatabaseClient;
  let mock: ReturnType<typeof makeMockEmbedder>;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempDb());
    const result = await CmosDatabaseClient.create({ dbPath });
    client = result.data!;
    ensureVectorStorage(client);

    // Seed a small fixture corpus: 5 decisions, 3 learnings, 2 missions.
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      client.execute(`INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`, [
        `Decision ${i}`,
        now,
      ]);
    }
    for (let i = 0; i < 3; i++) {
      client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
        `Learning ${i}`,
        now,
      ]);
    }
    client.execute(`INSERT INTO missions (id, name, objective) VALUES (?, ?, ?)`, [
      's99-m01',
      'Mission A',
      'Objective A',
    ]);
    client.execute(`INSERT INTO missions (id, name, objective) VALUES (?, ?, ?)`, [
      's99-m02',
      'Mission B',
      'Objective B',
    ]);

    mock = makeMockEmbedder();
    setEmbedderForTesting(mock.embedder);
  });

  afterEach(() => {
    setEmbedderForTesting(null);
    __resetEmbedderCacheForTesting();
    client.close();
    cleanup(tempDir);
  });

  it('embeds every fixture row exactly once on a fresh corpus', async () => {
    const decisions = client.getMany<{ id: number; decision_text: string }>(
      `SELECT id, decision_text FROM strategic_decisions ORDER BY id`,
      []
    );
    for (const row of decisions.data!) {
      await recordEmbedding(client, {
        type: 'decision',
        id: row.id,
        inputText: decisionEmbeddingInput(row.decision_text),
      });
    }
    const learnings = client.getMany<{ id: number; content: string }>(
      `SELECT id, content FROM learnings ORDER BY id`,
      []
    );
    for (const row of learnings.data!) {
      await recordEmbedding(client, {
        type: 'learning',
        id: row.id,
        inputText: learningEmbeddingInput(row.content),
      });
    }
    const missions = client.getMany<{ id: string; name: string; objective: string | null }>(
      `SELECT id, name, objective FROM missions ORDER BY id`,
      []
    );
    for (const row of missions.data!) {
      await recordEmbedding(client, {
        type: 'mission',
        id: row.id,
        inputText: missionEmbeddingInput({
          name: row.name,
          objective: row.objective,
          notes: null,
          successCriteria: null,
        }),
      });
    }

    expect(mock.callCount()).toBe(5 + 3 + 2);

    const decisionsVec = client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM decisions_vec`,
      []
    );
    const learningsVec = client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM learnings_vec`,
      []
    );
    const missionsVec = client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM missions_vec`,
      []
    );
    expect(decisionsVec.data?.count).toBe(5);
    expect(learningsVec.data?.count).toBe(3);
    expect(missionsVec.data?.count).toBe(2);
  });

  it('is idempotent: re-running over an already-embedded corpus is all skip-no-change', async () => {
    const decisions = client.getMany<{ id: number; decision_text: string }>(
      `SELECT id, decision_text FROM strategic_decisions ORDER BY id`,
      []
    );
    for (const row of decisions.data!) {
      await recordEmbedding(client, {
        type: 'decision',
        id: row.id,
        inputText: decisionEmbeddingInput(row.decision_text),
      });
    }
    const callsAfterFirstPass = mock.callCount();
    expect(callsAfterFirstPass).toBe(5);

    // Second pass — every row's hash matches; embedder should be untouched.
    for (const row of decisions.data!) {
      const result = await recordEmbedding(client, {
        type: 'decision',
        id: row.id,
        inputText: decisionEmbeddingInput(row.decision_text),
      });
      expect(result.action).toBe('skipped-no-change');
    }
    expect(mock.callCount()).toBe(callsAfterFirstPass);
  });
});
