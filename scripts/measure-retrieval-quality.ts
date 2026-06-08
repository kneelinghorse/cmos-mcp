// ABOUTME: Sprint 66 m07 — quantifies the paraphrase zero-result-rate improvement from the hybrid
// ABOUTME: retrieval substrate (FTS5 + sqlite-vec via RRF). Runs the 5 fixtures from hybrid-retrieval.test.ts
// ABOUTME: through both BM25-only and hybrid backends and reports zero_result_rate, MRR, top_3_recall.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../src/tools/cmos/client';
import { HybridRetriever, type RankedResult } from '../src/tools/cmos/fts5-retriever';
import { ensureVectorStorage } from '../src/tools/cmos/schema-migrations';
import { EMBEDDING_DIM, type Embedder } from '../src/intelligence/embedding-pipeline';

// ─── Concept-based mock embedder (mirrors hybrid-retrieval.test.ts) ──────────

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
  { pattern: /credential renewal posture/i, concept: 'auth-rotation' },
  { pattern: /sqlite is the source of truth/i, concept: 'sqlite-truth' },
  { pattern: /device code bootstrap/i, concept: 'device-code' },
  { pattern: /idempotency checks on database table evolutions/i, concept: 'idempotent-migrations' },
  { pattern: /replace the linear scan over insight records/i, concept: 'linear-scan-fix' },
  { pattern: /fts5 ranking and bm25 scoring/i, concept: 'bm25-fts5' },
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

function packVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

const mockEmbedder: Embedder = async (text: string) => vectorForConcept(conceptOf(text));

// ─── Test DB plumbing ────────────────────────────────────────────────────────

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-measure-'));
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Seed fixtures (same as hybrid-retrieval.test.ts) ────────────────────────

interface FixtureRow {
  /** Source row primary key (number for decisions/learnings, string for missions). */
  id: number | string;
  type: 'decision' | 'learning' | 'mission';
  concept: ConceptKey;
}

function seedFixtures(client: CmosDatabaseClient): FixtureRow[] {
  const now = daysAgoIso(1);
  const out: FixtureRow[] = [];

  const decisions: Array<{ text: string; concept: ConceptKey }> = [
    {
      text: 'Adopt credential renewal posture with project-key grace windows',
      concept: 'auth-rotation',
    },
    {
      text: 'SQLite is the source of truth for all persistent CMOS state',
      concept: 'sqlite-truth',
    },
    { text: 'Device code bootstrap drives dashboard API key acquisition', concept: 'device-code' },
    { text: 'FTS5 ranking and BM25 scoring give us local-first relevance', concept: 'bm25-fts5' },
  ];
  for (const d of decisions) {
    const r = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
      [d.text, now]
    );
    const id = Number(r.data?.lastInsertRowid ?? 0);
    out.push({ id, type: 'decision', concept: d.concept });
    client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
      BigInt(id),
      packVector(vectorForConcept(d.concept)),
    ]);
  }

  const learnings: Array<{ content: string; concept: ConceptKey }> = [
    {
      content: 'Always include idempotency checks on database table evolutions',
      concept: 'idempotent-migrations',
    },
  ];
  for (const l of learnings) {
    const r = client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
      l.content,
      now,
    ]);
    const id = Number(r.data?.lastInsertRowid ?? 0);
    out.push({ id, type: 'learning', concept: l.concept });
    client.execute(`INSERT INTO learnings_vec(learning_id, embedding) VALUES (?, ?)`, [
      BigInt(id),
      packVector(vectorForConcept(l.concept)),
    ]);
  }

  const missions: Array<{
    id: string;
    name: string;
    objective: string;
    concept: ConceptKey;
  }> = [
    {
      id: 's99-m01',
      name: 'Indexed retrieval upgrade',
      objective: 'Replace the linear scan over insight records with FTS5 plus vector retrieval',
      concept: 'linear-scan-fix',
    },
  ];
  for (const m of missions) {
    client.execute(`INSERT INTO missions (id, name, objective, created_at) VALUES (?, ?, ?, ?)`, [
      m.id,
      m.name,
      m.objective,
      now,
    ]);
    out.push({ id: m.id, type: 'mission', concept: m.concept });
    client.execute(`INSERT INTO missions_vec(mission_id, embedding) VALUES (?, ?)`, [
      m.id,
      packVector(vectorForConcept(m.concept)),
    ]);
  }

  return out;
}

// ─── BM25-only baseline ──────────────────────────────────────────────────────

interface RankedHit {
  id: number | string;
  rank: number;
}

function bm25Only(
  client: CmosDatabaseClient,
  ftsTable: string,
  query: string,
  limit: number
): RankedHit[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const matchClause = tokens.map((k) => `"${k.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const stmt = (client as unknown as { db: Database.Database }).db.prepare(
      `SELECT rowid, rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank LIMIT ?`
    );
    const rows = stmt.all(matchClause, limit) as Array<{ rowid: number; rank: number }>;
    return rows.map((r, i) => ({ id: r.rowid, rank: i + 1 }));
  } catch {
    return [];
  }
}

// ─── Paraphrase fixtures (mirror hybrid-retrieval.test.ts) ───────────────────

interface ParaphraseFixture {
  query: string;
  type: 'decision' | 'learning' | 'mission';
  ftsTable: string;
  expectedConcept: ConceptKey;
}

const FIXTURES: ParaphraseFixture[] = [
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

const TOP_K = 10; // Reciprocal-rank horizon for MRR.

// ─── Metric helpers ──────────────────────────────────────────────────────────

interface RunOutcome {
  query: string;
  type: string;
  expectedId: number | string;
  hits: number;
  expectedRank: number | null; // 1-indexed; null when not found in top-K
}

interface AggregateMetrics {
  total: number;
  zeroResultRate: number;
  mrrAtK: number;
  top3Recall: number;
}

function expectedIdFor(seeded: FixtureRow[], type: string, concept: ConceptKey): number | string {
  const hit = seeded.find((r) => r.type === type && r.concept === concept);
  if (!hit) throw new Error(`No fixture seeded for ${type}/${concept}`);
  return hit.id;
}

function aggregate(outcomes: RunOutcome[]): AggregateMetrics {
  const total = outcomes.length;
  const zeros = outcomes.filter((o) => o.hits === 0).length;
  const reciprocalRanks = outcomes.map((o) => (o.expectedRank ? 1 / o.expectedRank : 0));
  const mrr = reciprocalRanks.reduce((s, x) => s + x, 0) / total;
  const top3 = outcomes.filter((o) => o.expectedRank !== null && o.expectedRank <= 3).length;
  return {
    total,
    zeroResultRate: zeros / total,
    mrrAtK: mrr,
    top3Recall: top3 / total,
  };
}

function rankIn(
  results: Array<{ id: number | string }>,
  expectedId: number | string
): number | null {
  // String/number comparison is loose on purpose — mission ids are strings.
  for (let i = 0; i < results.length; i++) {
    if (String(results[i].id) === String(expectedId)) return i + 1;
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { tempDir, dbPath } = makeTempDb();
  let client: CmosDatabaseClient | null = null;
  try {
    client = await openClient(dbPath);
    ensureVectorStorage(client);
    const seeded = seedFixtures(client);

    const bm25Outcomes: RunOutcome[] = [];
    const hybridOutcomes: RunOutcome[] = [];

    const hybrid = new HybridRetriever(client, { embedder: mockEmbedder });

    for (const f of FIXTURES) {
      const expectedId = expectedIdFor(seeded, f.type, f.expectedConcept);

      const bm25Hits = bm25Only(client, f.ftsTable, f.query, TOP_K);
      bm25Outcomes.push({
        query: f.query,
        type: f.type,
        expectedId,
        hits: bm25Hits.length,
        expectedRank: rankIn(bm25Hits, expectedId),
      });

      const hybridResults: RankedResult[] = await hybrid.search(f.query, {
        types: [f.type],
        limit: TOP_K,
      });
      hybridOutcomes.push({
        query: f.query,
        type: f.type,
        expectedId,
        hits: hybridResults.length,
        expectedRank: rankIn(hybridResults, expectedId),
      });
    }

    const bm25Metrics = aggregate(bm25Outcomes);
    const hybridMetrics = aggregate(hybridOutcomes);

    const report = {
      fixtures: FIXTURES.length,
      topK: TOP_K,
      bm25Only: bm25Metrics,
      hybrid: hybridMetrics,
      deltas: {
        zeroResultRateDelta: hybridMetrics.zeroResultRate - bm25Metrics.zeroResultRate,
        mrrDelta: hybridMetrics.mrrAtK - bm25Metrics.mrrAtK,
        top3RecallDelta: hybridMetrics.top3Recall - bm25Metrics.top3Recall,
      },
      perQuery: FIXTURES.map((f, i) => ({
        query: f.query,
        type: f.type,
        bm25: { hits: bm25Outcomes[i].hits, expectedRank: bm25Outcomes[i].expectedRank },
        hybrid: { hits: hybridOutcomes[i].hits, expectedRank: hybridOutcomes[i].expectedRank },
      })),
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    client?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`measure-retrieval-quality failed: ${(err as Error).message}\n`);
  process.exit(1);
});
