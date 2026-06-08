// ABOUTME: Sprint 67 m01 — production-corpus paraphrase measurement. Runs the
// hand-authored fixtures at tests/fixtures/paraphrase-fixtures-production.json through
// both BM25-only and HybridRetriever (real Xenova embedder) against the live
// cmos/db/cmos.sqlite and emits a JSON report (per-fixture, aggregate, per-type).

import * as fs from 'fs';
import * as path from 'path';
import { CmosDatabaseClient } from '../src/tools/cmos/client';
import { HybridRetriever, type RankedResult } from '../src/tools/cmos/fts5-retriever';
import { extractKeywords } from '../src/tools/cmos/supersession-detection';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'tests/fixtures/paraphrase-fixtures-production.json'
);
const DB_PATH = path.resolve(__dirname, '..', 'cmos/db/cmos.sqlite');
const TOP_K = 10;

// ─── Fixture types ───────────────────────────────────────────────────────────

type FixtureType = 'decision' | 'learning' | 'mission';

interface Fixture {
  query: string;
  type: FixtureType;
  expected_id: number | string;
  source_text_snippet: string;
  paraphrase_strategy: string;
}

interface FixtureFile {
  description: string;
  version: string;
  corpusSnapshot: Record<string, unknown>;
  fixtures: Fixture[];
}

// ─── Result types ────────────────────────────────────────────────────────────

interface RunOutcome {
  query: string;
  type: FixtureType;
  expectedId: number | string;
  paraphraseStrategy: string;
  hits: number;
  expectedRank: number | null;
}

interface AggregateMetrics {
  total: number;
  zeroResultRate: number;
  mrrAtK: number;
  top3Recall: number;
}

interface PerTypeMetrics {
  decision: AggregateMetrics;
  learning: AggregateMetrics;
  mission: AggregateMetrics;
}

// ─── BM25 baseline ───────────────────────────────────────────────────────────

const FTS_TABLE: Record<FixtureType, string> = {
  decision: 'decisions_fts',
  learning: 'learnings_fts',
  mission: 'missions_fts',
};

interface RankedHit {
  id: number | string;
  rank: number;
}

function bm25Only(
  client: CmosDatabaseClient,
  type: FixtureType,
  query: string,
  limit: number
): RankedHit[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];
  const ftsTable = FTS_TABLE[type];
  const ftsQuery = keywords
    .slice(0, 10)
    .map((k) => `"${k.replace(/"/g, '""')}"`)
    .join(' OR ');

  const raw = client.getMany<{ rowid: number; rank: number }>(
    `SELECT rowid, rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank LIMIT ?`,
    [ftsQuery, limit]
  );
  if (!raw.success || !raw.data || raw.data.length === 0) return [];

  // For missions, missions_fts.rowid maps to missions.rowid (auto-allocated); translate to
  // the public TEXT id. Decisions and learnings use AUTOINCREMENT, so rowid == id.
  if (type === 'mission') {
    const placeholders = raw.data.map(() => '?').join(', ');
    const lookup = client.getMany<{ rowid: number; id: string }>(
      `SELECT rowid, id FROM missions WHERE rowid IN (${placeholders})`,
      raw.data.map((r) => r.rowid)
    );
    const map = new Map<number, string>();
    (lookup.data ?? []).forEach((r) => map.set(r.rowid, r.id));
    const out: RankedHit[] = [];
    raw.data.forEach((r, idx) => {
      const publicId = map.get(r.rowid);
      if (publicId) out.push({ id: publicId, rank: idx + 1 });
    });
    return out;
  }

  return raw.data.map((r, idx) => ({ id: r.rowid, rank: idx + 1 }));
}

// ─── Metric helpers ──────────────────────────────────────────────────────────

function rankIn(
  results: Array<{ id: number | string }>,
  expectedId: number | string
): number | null {
  for (let i = 0; i < results.length; i++) {
    if (String(results[i].id) === String(expectedId)) return i + 1;
  }
  return null;
}

function aggregate(outcomes: RunOutcome[]): AggregateMetrics {
  const total = outcomes.length;
  if (total === 0) return { total: 0, zeroResultRate: 0, mrrAtK: 0, top3Recall: 0 };
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

function aggregateByType(outcomes: RunOutcome[]): PerTypeMetrics {
  return {
    decision: aggregate(outcomes.filter((o) => o.type === 'decision')),
    learning: aggregate(outcomes.filter((o) => o.type === 'learning')),
    mission: aggregate(outcomes.filter((o) => o.type === 'mission')),
  };
}

// ─── Fixture verification ────────────────────────────────────────────────────

interface MissingFixture {
  expected_id: number | string;
  type: FixtureType;
  reason: string;
}

function verifyFixturesExist(client: CmosDatabaseClient, fixtures: Fixture[]): MissingFixture[] {
  const missing: MissingFixture[] = [];
  for (const f of fixtures) {
    if (f.type === 'decision') {
      const r = client.getOne<{ id: number; status: string }>(
        `SELECT id, status FROM strategic_decisions WHERE id = ?`,
        [f.expected_id]
      );
      if (!r.success || !r.data) {
        missing.push({ expected_id: f.expected_id, type: f.type, reason: 'row not found' });
      } else if (r.data.status !== 'active') {
        missing.push({
          expected_id: f.expected_id,
          type: f.type,
          reason: `status=${r.data.status} (production retriever filters to 'active')`,
        });
      }
    } else if (f.type === 'learning') {
      const r = client.getOne<{ id: number; status: string }>(
        `SELECT id, status FROM learnings WHERE id = ?`,
        [f.expected_id]
      );
      if (!r.success || !r.data) {
        missing.push({ expected_id: f.expected_id, type: f.type, reason: 'row not found' });
      } else if (r.data.status !== 'active') {
        missing.push({
          expected_id: f.expected_id,
          type: f.type,
          reason: `status=${r.data.status} (production retriever filters to 'active')`,
        });
      }
    } else {
      const r = client.getOne<{ id: string }>(`SELECT id FROM missions WHERE id = ?`, [
        f.expected_id,
      ]);
      if (!r.success || !r.data) {
        missing.push({ expected_id: f.expected_id, type: f.type, reason: 'row not found' });
      }
    }
  }
  return missing;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture file not found: ${FIXTURE_PATH}`);
  }
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Live DB not found: ${DB_PATH}`);
  }

  const fixtureFile = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as FixtureFile;
  const fixtures = fixtureFile.fixtures;
  if (fixtures.length < 15) {
    throw new Error(`Need >=15 fixtures; got ${fixtures.length}`);
  }

  // Open the live DB read-only. The HybridRetriever's ensureXxxFts5 / ensureVectorStorage
  // helpers short-circuit when the tables already exist (they do — the m02 migration ran),
  // so no CREATE statements fire on this path.
  const clientResult = await CmosDatabaseClient.create({ dbPath: DB_PATH, readonly: true });
  if (!clientResult.success || !clientResult.data) {
    throw new Error(`Failed to open DB: ${clientResult.error?.message ?? 'unknown'}`);
  }
  const client = clientResult.data;

  try {
    const missing = verifyFixturesExist(client, fixtures);
    if (missing.length > 0) {
      const lines = missing.map((m) => `  - ${m.type}#${m.expected_id}: ${m.reason}`).join('\n');
      throw new Error(`Fixtures reference rows that do not exist or are not active:\n${lines}`);
    }

    // Default HybridRetriever uses the production singleton embedder via getEmbedder() —
    // matching production behavior (no test override). First query pays the model-load cost
    // (~0.5-3s); subsequent queries reuse the cached extractor (~10-50ms each).
    const hybrid = new HybridRetriever(client);

    const bm25Outcomes: RunOutcome[] = [];
    const hybridOutcomes: RunOutcome[] = [];
    const perQuery: Array<{
      query: string;
      type: FixtureType;
      expectedId: number | string;
      paraphraseStrategy: string;
      bm25: { hits: number; expectedRank: number | null };
      hybrid: { hits: number; expectedRank: number | null };
    }> = [];

    for (const f of fixtures) {
      const bm25Hits = bm25Only(client, f.type, f.query, TOP_K);
      const bm25Outcome: RunOutcome = {
        query: f.query,
        type: f.type,
        expectedId: f.expected_id,
        paraphraseStrategy: f.paraphrase_strategy,
        hits: bm25Hits.length,
        expectedRank: rankIn(bm25Hits, f.expected_id),
      };
      bm25Outcomes.push(bm25Outcome);

      const hybridResults: RankedResult[] = await hybrid.search(f.query, {
        types: [f.type],
        limit: TOP_K,
      });
      const hybridOutcome: RunOutcome = {
        query: f.query,
        type: f.type,
        expectedId: f.expected_id,
        paraphraseStrategy: f.paraphrase_strategy,
        hits: hybridResults.length,
        expectedRank: rankIn(hybridResults, f.expected_id),
      };
      hybridOutcomes.push(hybridOutcome);

      perQuery.push({
        query: f.query,
        type: f.type,
        expectedId: f.expected_id,
        paraphraseStrategy: f.paraphrase_strategy,
        bm25: { hits: bm25Outcome.hits, expectedRank: bm25Outcome.expectedRank },
        hybrid: { hits: hybridOutcome.hits, expectedRank: hybridOutcome.expectedRank },
      });
    }

    const bm25Aggregate = aggregate(bm25Outcomes);
    const hybridAggregate = aggregate(hybridOutcomes);
    const bm25PerType = aggregateByType(bm25Outcomes);
    const hybridPerType = aggregateByType(hybridOutcomes);
    const elapsedMs = Date.now() - startedAt;

    const report = {
      meta: {
        sprint: 'sprint-67',
        mission: 's67-m01',
        measuredAt: new Date().toISOString(),
        durationMs: elapsedMs,
        dbPath: path.relative(process.cwd(), DB_PATH),
        fixtureCount: fixtures.length,
        topK: TOP_K,
        corpusSnapshot: fixtureFile.corpusSnapshot,
        retrieverDefaults: {
          backend: 'hybrid',
          rrfK: 60,
          recencyWeight: 0.5,
          statusFilter: ['active'],
        },
        baselineReference: {
          tracelabMissionId: '2de68a40-cc93-4785-b50f-5318cfbbb4a2',
          tracelabBaselineZeroResultRate: 0.5,
          syntheticBaselineZeroResultRate: 1.0,
          note: 'TraceLab CMOS-CONTEXT-RETRIEVAL-01-02 documents 50% production zero-result rate on paraphrase queries. Synthetic s66-m07 fixtures produced 100% by construction. This measurement quantifies the real-world rate.',
        },
      },
      aggregate: {
        bm25Only: bm25Aggregate,
        hybrid: hybridAggregate,
        deltas: {
          zeroResultRateDelta: hybridAggregate.zeroResultRate - bm25Aggregate.zeroResultRate,
          mrrDelta: hybridAggregate.mrrAtK - bm25Aggregate.mrrAtK,
          top3RecallDelta: hybridAggregate.top3Recall - bm25Aggregate.top3Recall,
        },
      },
      perType: {
        bm25Only: bm25PerType,
        hybrid: hybridPerType,
      },
      perQuery,
    };

    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`measure-retrieval-production failed: ${(err as Error).message}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
});
