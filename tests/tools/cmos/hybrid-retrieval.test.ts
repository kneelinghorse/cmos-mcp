// ABOUTME: HybridRetriever tests (Sprint 66 m04). Covers the vector and hybrid backends against
// paraphrase fixtures designed to expose the 50% zero-result-rate failure mode of pure BM25 across
// all three retrievable types (decisions, learnings, missions). Mock embedder is concept-based —
// fixtures and their paraphrase queries map to the same unit vector so semantic recall is deterministic.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { HybridRetriever, type RankedResult } from '../../../src/tools/cmos/fts5-retriever';
import { ensureVectorStorage } from '../../../src/tools/cmos/schema-migrations';
import { EMBEDDING_DIM, type Embedder } from '../../../src/intelligence/embedding-pipeline';

// ─── Concept-based mock embedder ─────────────────────────────────────────────
//
// Each concept maps to a unique sparse unit vector. Source-row texts and their
// paraphrase queries are routed to the same concept, so vector cosine ranks the
// matching doc at rank 1. BM25 alone cannot find these matches because the source
// and query share no surface keywords.

const CONCEPT_TO_INDEX: Record<string, number> = {
  'auth-rotation': 10,
  'sqlite-truth': 50,
  'device-code': 100,
  'idempotent-migrations': 150,
  'linear-scan-fix': 200,
  'bm25-fts5': 250,
  unrelated: 300,
};

type ConceptKey = keyof typeof CONCEPT_TO_INDEX;

interface FragmentToConcept {
  pattern: RegExp;
  concept: ConceptKey;
}

const TEXT_TO_CONCEPT: FragmentToConcept[] = [
  // Source-row text fragments (case-insensitive). Carry no surface keywords in common
  // with their matching paraphrase queries below — the whole point is exposing the BM25
  // zero-result failure mode.
  { pattern: /credential renewal posture/i, concept: 'auth-rotation' },
  { pattern: /sqlite is the source of truth/i, concept: 'sqlite-truth' },
  { pattern: /device code bootstrap/i, concept: 'device-code' },
  { pattern: /idempotency checks on database table evolutions/i, concept: 'idempotent-migrations' },
  { pattern: /replace the linear scan over insight records/i, concept: 'linear-scan-fix' },
  { pattern: /fts5 ranking and bm25 scoring/i, concept: 'bm25-fts5' },

  // Paraphrase query fragments — no surface keywords in common with the sources.
  { pattern: /auth token rotation/i, concept: 'auth-rotation' },
  { pattern: /where do we persist data/i, concept: 'sqlite-truth' },
  { pattern: /agent identity onboarding flow/i, concept: 'device-code' },
  { pattern: /design upgrades that survive repeated execution/i, concept: 'idempotent-migrations' },
  { pattern: /stop reading every row to find documents/i, concept: 'linear-scan-fix' },
];

function conceptOf(text: string): ConceptKey {
  for (const { pattern, concept } of TEXT_TO_CONCEPT) {
    if (pattern.test(text)) return concept;
  }
  return 'unrelated';
}

function vectorForConcept(concept: ConceptKey): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  arr[CONCEPT_TO_INDEX[concept]] = 1;
  return arr;
}

const mockEmbedder: Embedder = async (text: string) => vectorForConcept(conceptOf(text));

// A throwing embedder for the failure-posture test.
const failingEmbedder: Embedder = async () => {
  throw new Error('intentional test failure');
};

// ─── Test DB plumbing ────────────────────────────────────────────────────────

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-retrieval-test-'));
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

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      sprint_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT,
      notes TEXT,
      sprint_id TEXT,
      created_at TEXT,
      status TEXT NOT NULL DEFAULT 'Queued'
    );
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

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function packVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Fixture seeding ─────────────────────────────────────────────────────────

interface DecisionFixture {
  id: number;
  text: string;
  concept: ConceptKey;
}

interface LearningFixture {
  id: number;
  content: string;
  concept: ConceptKey;
}

interface MissionFixture {
  id: string;
  name: string;
  objective: string | null;
  notes: string | null;
  concept: ConceptKey;
}

interface SeededFixtures {
  decisions: DecisionFixture[];
  learnings: LearningFixture[];
  missions: MissionFixture[];
}

function seedFixtures(client: CmosDatabaseClient): SeededFixtures {
  const now = daysAgoIso(1);

  // ─── Decisions ──────────────────────────────────────────────────────────
  const decisionDefs: Array<{ text: string; concept: ConceptKey }> = [
    {
      text: 'Adopt credential renewal posture with project-key grace windows',
      concept: 'auth-rotation',
    },
    {
      text: 'SQLite is the source of truth for all persistent CMOS state',
      concept: 'sqlite-truth',
    },
    {
      text: 'Device code bootstrap drives dashboard API key acquisition',
      concept: 'device-code',
    },
    {
      text: 'FTS5 ranking and BM25 scoring give us local-first relevance',
      concept: 'bm25-fts5',
    },
  ];

  const decisions: DecisionFixture[] = [];
  for (const def of decisionDefs) {
    const result = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      [def.text, now]
    );
    const id = Number(result.data?.lastInsertRowid ?? 0);
    decisions.push({ id, text: def.text, concept: def.concept });
    // Populate vec0 table directly (simulates m03 having already embedded).
    client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
      BigInt(id),
      packVector(vectorForConcept(def.concept)),
    ]);
  }

  // ─── Learnings ──────────────────────────────────────────────────────────
  const learningDefs: Array<{ content: string; concept: ConceptKey }> = [
    {
      content: 'Always include idempotency checks on database table evolutions',
      concept: 'idempotent-migrations',
    },
  ];

  const learnings: LearningFixture[] = [];
  for (const def of learningDefs) {
    const result = client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
      def.content,
      now,
    ]);
    const id = Number(result.data?.lastInsertRowid ?? 0);
    learnings.push({ id, content: def.content, concept: def.concept });
    client.execute(`INSERT INTO learnings_vec(learning_id, embedding) VALUES (?, ?)`, [
      BigInt(id),
      packVector(vectorForConcept(def.concept)),
    ]);
  }

  // ─── Missions ───────────────────────────────────────────────────────────
  const missionDefs: Array<{
    id: string;
    name: string;
    objective: string | null;
    concept: ConceptKey;
  }> = [
    {
      id: 's99-m01',
      name: 'Indexed retrieval upgrade',
      objective: 'Replace the linear scan over insight records with FTS5 plus vector retrieval',
      concept: 'linear-scan-fix',
    },
  ];

  const missions: MissionFixture[] = [];
  for (const def of missionDefs) {
    client.execute(`INSERT INTO missions (id, name, objective, created_at) VALUES (?, ?, ?, ?)`, [
      def.id,
      def.name,
      def.objective,
      now,
    ]);
    missions.push({
      id: def.id,
      name: def.name,
      objective: def.objective,
      notes: null,
      concept: def.concept,
    });
    client.execute(`INSERT INTO missions_vec(mission_id, embedding) VALUES (?, ?)`, [
      def.id,
      packVector(vectorForConcept(def.concept)),
    ]);
  }

  return { decisions, learnings, missions };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a BM25-only query against the FTS5 virtual table for the given type.
 * Used to demonstrate the failure mode the hybrid layer fixes: pure BM25 returns
 * 0 rows for the paraphrase queries.
 */
function bm25Only(
  client: CmosDatabaseClient,
  ftsTable: string,
  query: string
): Array<{ rowid: number; rank: number }> {
  // Mirror the keyword extraction the retriever uses: strip non-alphanumerics,
  // drop short tokens, OR the survivors.
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const matchClause = tokens.map((k) => `"${k.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const stmt = (client as unknown as { db: Database.Database }).db.prepare(
      `SELECT rowid, rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank`
    );
    return stmt.all(matchClause) as Array<{ rowid: number; rank: number }>;
  } catch {
    return [];
  }
}

function topIds(results: RankedResult[], n: number): Array<number | string> {
  return results.slice(0, n).map((r) => r.id);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HybridRetriever', () => {
  let tempDir: string;
  let dbPath: string;
  let client: CmosDatabaseClient;
  let fixtures: SeededFixtures;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempDb());
    client = await openClient(dbPath);
    ensureVectorStorage(client);
    fixtures = seedFixtures(client);
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  // ─── capabilities ─────────────────────────────────────────────────────────

  describe('capabilities', () => {
    it('defaults to hybrid backend with semantic search across all three types', () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const caps = retriever.capabilities();
      expect(caps.backend).toBe('hybrid');
      expect(caps.semanticSearch).toBe(true);
      expect(caps.recencyBoost).toBe(true);
      expect(caps.supportedTypes).toEqual(
        expect.arrayContaining(['decision', 'learning', 'mission'])
      );
    });

    it('reports vector backend when configured', () => {
      const retriever = new HybridRetriever(client, {
        backend: 'vector',
        embedder: mockEmbedder,
      });
      expect(retriever.capabilities().backend).toBe('vector');
    });
  });

  // ─── Paraphrase fixtures — the headline success criterion ─────────────────

  describe('paraphrase recall (hybrid backend)', () => {
    // Each fixture: a query that shares no surface keywords with the source row,
    // so pure BM25 returns 0 matches. The hybrid layer must surface the right doc
    // in the top 3.
    interface ParaphraseFixture {
      query: string;
      type: 'decision' | 'learning' | 'mission';
      ftsTable: string;
      expectedConcept: ConceptKey;
    }

    const fixturesToTest: ParaphraseFixture[] = [
      {
        query: 'auth token rotation',
        type: 'decision',
        ftsTable: 'decisions_fts',
        expectedConcept: 'auth-rotation',
      },
      {
        query: 'where do we persist data',
        type: 'decision',
        ftsTable: 'decisions_fts',
        expectedConcept: 'sqlite-truth',
      },
      {
        query: 'agent identity onboarding flow',
        type: 'decision',
        ftsTable: 'decisions_fts',
        expectedConcept: 'device-code',
      },
      {
        query: 'design upgrades that survive repeated execution',
        type: 'learning',
        ftsTable: 'learnings_fts',
        expectedConcept: 'idempotent-migrations',
      },
      {
        query: 'stop reading every row to find documents',
        type: 'mission',
        ftsTable: 'missions_fts',
        expectedConcept: 'linear-scan-fix',
      },
    ];

    it.each(fixturesToTest)(
      'BM25 alone returns 0 rows for "$query" ($type)',
      ({ query, ftsTable }) => {
        const bm25Hits = bm25Only(client, ftsTable, query);
        expect(bm25Hits).toHaveLength(0);
      }
    );

    it.each(fixturesToTest)(
      'hybrid retrieval surfaces the right $type for "$query" in the top 3',
      async ({ query, type, expectedConcept }) => {
        const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
        const results = await retriever.search(query, { types: [type], limit: 3 });

        expect(results.length).toBeGreaterThan(0);
        const expectedId = findExpectedId(fixtures, type, expectedConcept);
        const top3 = topIds(results, 3);
        expect(top3).toContain(expectedId);
      }
    );
  });

  // ─── Vector-only backend ──────────────────────────────────────────────────

  describe('vector backend', () => {
    it('returns the nearest decision when the query embeds to the same concept', async () => {
      const retriever = new HybridRetriever(client, {
        backend: 'vector',
        embedder: mockEmbedder,
      });
      const results = await retriever.search('where do we persist data', {
        types: ['decision'],
        limit: 5,
      });
      const expectedId = findExpectedId(fixtures, 'decision', 'sqlite-truth');
      expect(results[0].id).toBe(expectedId);
      expect(typeof results[0].vectorSimilarity).toBe('number');
      // bm25Score is 0 in vector-only mode.
      expect(results[0].bm25Score).toBe(0);
    });

    it('reports vectorSimilarity in [-1, 1] (allowing tiny numerical drift)', async () => {
      const retriever = new HybridRetriever(client, {
        backend: 'vector',
        embedder: mockEmbedder,
      });
      const results = await retriever.search('auth token rotation', {
        types: ['decision'],
        limit: 5,
      });
      for (const r of results) {
        expect(r.vectorSimilarity).toBeGreaterThanOrEqual(-1.001);
        expect(r.vectorSimilarity).toBeLessThanOrEqual(1.001);
      }
    });

    it('returns [] when the embedder throws (graceful degrade)', async () => {
      const retriever = new HybridRetriever(client, {
        backend: 'vector',
        embedder: failingEmbedder,
      });
      const results = await retriever.search('any query', { types: ['decision'] });
      expect(results).toEqual([]);
    });
  });

  // ─── BM25 arm still works in hybrid mode ──────────────────────────────────

  describe('BM25 arm continues to work in hybrid backend', () => {
    it('returns the FTS5-matching decision for a keyword query', async () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const results = await retriever.search('FTS5 BM25', {
        types: ['decision'],
        limit: 3,
      });
      // The BM25-friendly fixture has concept 'bm25-fts5'.
      const expectedId = findExpectedId(fixtures, 'decision', 'bm25-fts5');
      expect(topIds(results, 3)).toContain(expectedId);
    });

    it('degrades to BM25-only when the embedder fails (hybrid backend)', async () => {
      const retriever = new HybridRetriever(client, { embedder: failingEmbedder });
      // Use a query that surface-matches BM25 so we have proof the BM25 arm fires.
      const results = await retriever.search('FTS5 BM25', {
        types: ['decision'],
        limit: 3,
      });
      const expectedId = findExpectedId(fixtures, 'decision', 'bm25-fts5');
      expect(topIds(results, 3)).toContain(expectedId);
      // No vector signal when the embedder is broken.
      const hit = results.find((r) => r.id === expectedId);
      expect(hit?.vectorSimilarity ?? null).toBeNull();
    });
  });

  // ─── RRF score telemetry ──────────────────────────────────────────────────

  describe('RRF telemetry', () => {
    it('populates rrfScore on hybrid results and leaves it null on vector results', async () => {
      const hybridRetriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const hybridResults = await hybridRetriever.search('auth token rotation', {
        types: ['decision'],
      });
      expect(hybridResults.length).toBeGreaterThan(0);
      const hybridTop = hybridResults[0];
      expect(typeof hybridTop.rrfScore).toBe('number');
      // The matching doc appears in the vector arm at rank 1, so rrfScore >= 1/(60+1).
      expect(hybridTop.rrfScore).toBeGreaterThan(0);

      const vectorRetriever = new HybridRetriever(client, {
        backend: 'vector',
        embedder: mockEmbedder,
      });
      const vectorResults = await vectorRetriever.search('auth token rotation', {
        types: ['decision'],
      });
      expect(vectorResults.length).toBeGreaterThan(0);
      expect(vectorResults[0].rrfScore).toBeNull();
    });

    it('honors a custom rrfK option (smaller k boosts top-rank contribution)', async () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const lowK = await retriever.search('auth token rotation', {
        types: ['decision'],
        rrfK: 10,
      });
      const highK = await retriever.search('auth token rotation', {
        types: ['decision'],
        rrfK: 1000,
      });
      // Lower k inflates 1/(k+rank) for the same rank. Use the doc that appears in both runs.
      const expectedId = findExpectedId(fixtures, 'decision', 'auth-rotation');
      const lowHit = lowK.find((r) => r.id === expectedId);
      const highHit = highK.find((r) => r.id === expectedId);
      expect(lowHit).toBeTruthy();
      expect(highHit).toBeTruthy();
      expect((lowHit?.rrfScore ?? 0) > (highHit?.rrfScore ?? 0)).toBe(true);
    });
  });

  // ─── Recency orthogonality ────────────────────────────────────────────────

  describe('recency decay applies after fusion (orthogonal to scoring)', () => {
    it('older items get a smaller recencyFactor while keeping rrfScore unchanged', async () => {
      // Re-seed: same concept, two decisions of different ages.
      client.execute(`DELETE FROM strategic_decisions`);
      client.execute(`DELETE FROM decisions_vec`);

      const freshNow = new Date().toISOString();
      const old120 = daysAgoIso(120);

      const fresh = client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
        ['Adopt credential lifecycle rotation with project-key grace windows', freshNow]
      );
      const freshId = Number(fresh.data?.lastInsertRowid ?? 0);
      client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
        BigInt(freshId),
        packVector(vectorForConcept('auth-rotation')),
      ]);

      const older = client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
        ['Adopt credential lifecycle rotation with project-key grace windows', old120]
      );
      const olderId = Number(older.data?.lastInsertRowid ?? 0);
      client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
        BigInt(olderId),
        packVector(vectorForConcept('auth-rotation')),
      ]);

      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const results = await retriever.search('auth token rotation', {
        types: ['decision'],
        recencyWeight: 1.0,
        limit: 5,
      });

      const freshHit = results.find((r) => r.id === freshId);
      const olderHit = results.find((r) => r.id === olderId);
      expect(freshHit).toBeTruthy();
      expect(olderHit).toBeTruthy();
      // Recency drives the older doc's final score down. Both docs embed to the same vector
      // and share identical text, so their BM25/vector ranks differ by at most one position
      // (tie-broken by SQLite ordering), giving near-identical rrfScores.
      expect(freshHit!.recencyFactor).toBeGreaterThan(olderHit!.recencyFactor);
      expect(Math.abs((freshHit!.rrfScore ?? 0) - (olderHit!.rrfScore ?? 0))).toBeLessThan(0.001);
      // Orthogonality check: with recencyWeight=1, final = rrf × recencyFactor exactly.
      const freshRatio = freshHit!.score / (freshHit!.rrfScore ?? 1);
      const olderRatio = olderHit!.score / (olderHit!.rrfScore ?? 1);
      expect(freshRatio).toBeCloseTo(freshHit!.recencyFactor, 5);
      expect(olderRatio).toBeCloseTo(olderHit!.recencyFactor, 5);
      // And the final score is lower for the older doc.
      expect(freshHit!.score).toBeGreaterThan(olderHit!.score);
    });
  });

  // ─── Status filter ────────────────────────────────────────────────────────

  describe('status filter (decisions and learnings)', () => {
    it('excludes superseded decisions by default', async () => {
      // Mark one fixture as superseded.
      const authId = findExpectedId(fixtures, 'decision', 'auth-rotation');
      client.execute(`UPDATE strategic_decisions SET status='superseded' WHERE id=?`, [authId]);

      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const results = await retriever.search('auth token rotation', {
        types: ['decision'],
        limit: 5,
      });
      expect(results.find((r) => r.id === authId)).toBeUndefined();
    });

    it('honors an explicit statusFilter that includes superseded', async () => {
      const authId = findExpectedId(fixtures, 'decision', 'auth-rotation');
      client.execute(`UPDATE strategic_decisions SET status='superseded' WHERE id=?`, [authId]);

      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const results = await retriever.search('auth token rotation', {
        types: ['decision'],
        statusFilter: ['active', 'superseded'],
        limit: 5,
      });
      expect(results.find((r) => r.id === authId)).toBeTruthy();
    });
  });

  // ─── get() ────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('fetches a decision by integer id', () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const id = findExpectedId(fixtures, 'decision', 'sqlite-truth');
      const result = retriever.get(id, 'decision');
      expect(result).not.toBeNull();
      expect(result?.text).toContain('SQLite is the source of truth');
    });

    it('fetches a mission by string id', () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      const result = retriever.get('s99-m01', 'mission');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('s99-m01');
      expect(result?.text).toContain('Indexed retrieval upgrade');
    });

    it('returns null for unknown ids', () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      expect(retriever.get(999_999, 'decision')).toBeNull();
      expect(retriever.get('no-such-mission', 'mission')).toBeNull();
    });

    it('returns null for unsupported types (e.g. session)', () => {
      const retriever = new HybridRetriever(client, { embedder: mockEmbedder });
      expect(retriever.get(1, 'session')).toBeNull();
    });
  });
});

// ─── Fixture lookup ──────────────────────────────────────────────────────────

function findExpectedId(
  seeded: SeededFixtures,
  type: 'decision' | 'learning' | 'mission',
  concept: ConceptKey
): number | string {
  if (type === 'decision') {
    const match = seeded.decisions.find((d) => d.concept === concept);
    if (!match) throw new Error(`No decision fixture seeded for concept ${concept}`);
    return match.id;
  }
  if (type === 'learning') {
    const match = seeded.learnings.find((l) => l.concept === concept);
    if (!match) throw new Error(`No learning fixture seeded for concept ${concept}`);
    return match.id;
  }
  const match = seeded.missions.find((m) => m.concept === concept);
  if (!match) throw new Error(`No mission fixture seeded for concept ${concept}`);
  return match.id;
}
