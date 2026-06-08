// ABOUTME: Sprint 67 m02 — parameter sweep over RRF k and recency weight using m01's
// ABOUTME: production-corpus fixtures as the regression gate. Caches query embeddings across
// ABOUTME: combinations (one embed per fixture, not per combo) for a 25× speedup.

import * as fs from 'fs';
import * as path from 'path';
import { CmosDatabaseClient } from '../src/tools/cmos/client';
import { HybridRetriever, type RankedResult } from '../src/tools/cmos/fts5-retriever';
import { extractKeywords } from '../src/tools/cmos/supersession-detection';
import { getEmbedder, type Embedder } from '../src/intelligence/embedding-pipeline';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'tests/fixtures/paraphrase-fixtures-production.json'
);
const DB_PATH = path.resolve(__dirname, '..', 'cmos/db/cmos.sqlite');
const RESULTS_PATH = path.resolve(__dirname, '..', 'scripts/tune-retrieval-params.results.json');
const TOP_K = 10;

const RRF_K_GRID = [30, 45, 60, 75, 90];
const RECENCY_WEIGHT_GRID = [0.2, 0.35, 0.5, 0.65, 0.8];

// Production defaults at the time of the sweep — match the constants at
// src/tools/cmos/fts5-retriever.ts:129 (DEFAULT_RECENCY_WEIGHT) and :138 (DEFAULT_RRF_K).
const CURRENT_DEFAULTS = { rrfK: 60, recencyWeight: 0.5 };

// Update rule (per mission spec).
const MRR_LIFT_THRESHOLD = 0.05;
const SYNTHETIC_MRR_FLOOR = 0.95;

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
  fixtures: Fixture[];
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface RunOutcome {
  expectedId: number | string;
  hits: number;
  expectedRank: number | null;
}

interface AggregateMetrics {
  total: number;
  zeroResultRate: number;
  mrrAtK: number;
  top3Recall: number;
}

interface CombinationResult {
  rrfK: number;
  recencyWeight: number;
  metrics: AggregateMetrics;
}

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

// ─── BM25 baseline (lifted from measure-retrieval-production.ts) ─────────────

const FTS_TABLE: Record<FixtureType, string> = {
  decision: 'decisions_fts',
  learning: 'learnings_fts',
  mission: 'missions_fts',
};

function bm25Rank(
  client: CmosDatabaseClient,
  type: FixtureType,
  query: string,
  expectedId: number | string
): { hits: number; expectedRank: number | null } {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return { hits: 0, expectedRank: null };
  const ftsTable = FTS_TABLE[type];
  const ftsQuery = keywords
    .slice(0, 10)
    .map((k) => `"${k.replace(/"/g, '""')}"`)
    .join(' OR ');

  const raw = client.getMany<{ rowid: number; rank: number }>(
    `SELECT rowid, rank FROM ${ftsTable} WHERE ${ftsTable} MATCH ? ORDER BY rank LIMIT ?`,
    [ftsQuery, TOP_K]
  );
  if (!raw.success || !raw.data || raw.data.length === 0) {
    return { hits: 0, expectedRank: null };
  }

  let hitIds: Array<number | string>;
  if (type === 'mission') {
    const placeholders = raw.data.map(() => '?').join(', ');
    const lookup = client.getMany<{ rowid: number; id: string }>(
      `SELECT rowid, id FROM missions WHERE rowid IN (${placeholders})`,
      raw.data.map((r) => r.rowid)
    );
    const map = new Map<number, string>();
    (lookup.data ?? []).forEach((r) => map.set(r.rowid, r.id));
    hitIds = raw.data.map((r) => map.get(r.rowid)).filter((id): id is string => id !== undefined);
  } else {
    hitIds = raw.data.map((r) => r.rowid);
  }

  return {
    hits: hitIds.length,
    expectedRank: rankIn(
      hitIds.map((id) => ({ id })),
      expectedId
    ),
  };
}

// ─── Memoized embedder (cache by query string across the sweep) ──────────────

function memoizedEmbedder(real: Embedder): {
  embed: Embedder;
  stats: { hits: number; misses: number };
} {
  const cache = new Map<string, Float32Array>();
  const stats = { hits: 0, misses: 0 };
  const embed: Embedder = async (text: string) => {
    const cached = cache.get(text);
    if (cached) {
      stats.hits++;
      return cached;
    }
    stats.misses++;
    const vec = await real(text);
    cache.set(text, vec);
    return vec;
  };
  return { embed, stats };
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

interface SweepProgress {
  combo: number;
  totalCombos: number;
}

async function runSweep(
  client: CmosDatabaseClient,
  fixtures: Fixture[],
  embedder: Embedder
): Promise<CombinationResult[]> {
  const hybrid = new HybridRetriever(client, { embedder });
  const results: CombinationResult[] = [];
  const totalCombos = RRF_K_GRID.length * RECENCY_WEIGHT_GRID.length;
  let comboIndex = 0;

  for (const rrfK of RRF_K_GRID) {
    for (const recencyWeight of RECENCY_WEIGHT_GRID) {
      comboIndex++;
      const outcomes: RunOutcome[] = [];
      for (const f of fixtures) {
        const hits: RankedResult[] = await hybrid.search(f.query, {
          types: [f.type],
          limit: TOP_K,
          rrfK,
          recencyWeight,
        });
        outcomes.push({
          expectedId: f.expected_id,
          hits: hits.length,
          expectedRank: rankIn(hits, f.expected_id),
        });
      }
      const metrics = aggregate(outcomes);
      results.push({ rrfK, recencyWeight, metrics });
      logProgress({ combo: comboIndex, totalCombos });
    }
  }
  process.stderr.write('\n');
  return results;
}

function logProgress(p: SweepProgress): void {
  process.stderr.write(`.`);
  if (p.combo === p.totalCombos) process.stderr.write(' done');
}

// ─── BM25 reference snapshot ─────────────────────────────────────────────────

function bm25Snapshot(client: CmosDatabaseClient, fixtures: Fixture[]): AggregateMetrics {
  const outcomes: RunOutcome[] = fixtures.map((f) => {
    const r = bm25Rank(client, f.type, f.query, f.expected_id);
    return { expectedId: f.expected_id, hits: r.hits, expectedRank: r.expectedRank };
  });
  return aggregate(outcomes);
}

// ─── Ranking + verdict ───────────────────────────────────────────────────────

function rankCombinations(results: CombinationResult[]): CombinationResult[] {
  return [...results].sort((a, b) => {
    if (b.metrics.mrrAtK !== a.metrics.mrrAtK) return b.metrics.mrrAtK - a.metrics.mrrAtK;
    if (b.metrics.top3Recall !== a.metrics.top3Recall) {
      return b.metrics.top3Recall - a.metrics.top3Recall;
    }
    // Last tiebreaker: prefer the canonical default for stability.
    const canonA =
      a.rrfK === CURRENT_DEFAULTS.rrfK && a.recencyWeight === CURRENT_DEFAULTS.recencyWeight
        ? 1
        : 0;
    const canonB =
      b.rrfK === CURRENT_DEFAULTS.rrfK && b.recencyWeight === CURRENT_DEFAULTS.recencyWeight
        ? 1
        : 0;
    return canonB - canonA;
  });
}

interface Verdict {
  recommendation: 'change-defaults' | 'keep-defaults';
  winner: CombinationResult;
  currentDefault: CombinationResult;
  mrrLift: number;
  top3Lift: number;
  reason: string;
}

function buildVerdict(ranked: CombinationResult[]): Verdict {
  const winner = ranked[0];
  const currentDefault = ranked.find(
    (r) => r.rrfK === CURRENT_DEFAULTS.rrfK && r.recencyWeight === CURRENT_DEFAULTS.recencyWeight
  );
  if (!currentDefault) {
    throw new Error('Current default combination missing from sweep grid');
  }
  const mrrLift = winner.metrics.mrrAtK - currentDefault.metrics.mrrAtK;
  const top3Lift = winner.metrics.top3Recall - currentDefault.metrics.top3Recall;

  const sameAsCurrent =
    winner.rrfK === CURRENT_DEFAULTS.rrfK &&
    winner.recencyWeight === CURRENT_DEFAULTS.recencyWeight;
  if (sameAsCurrent) {
    return {
      recommendation: 'keep-defaults',
      winner,
      currentDefault,
      mrrLift,
      top3Lift,
      reason: 'Current canonical defaults are the empirical winner.',
    };
  }

  if (mrrLift >= MRR_LIFT_THRESHOLD) {
    return {
      recommendation: 'change-defaults',
      winner,
      currentDefault,
      mrrLift,
      top3Lift,
      reason: `Winner lifts production MRR@10 by ${mrrLift.toFixed(4)} (≥${MRR_LIFT_THRESHOLD} threshold). Synthetic-MRR check must still confirm via test suite re-run.`,
    };
  }

  return {
    recommendation: 'keep-defaults',
    winner,
    currentDefault,
    mrrLift,
    top3Lift,
    reason: `Winner lifts production MRR@10 by only ${mrrLift.toFixed(4)} (<${MRR_LIFT_THRESHOLD} threshold). Keeping canonical defaults — empirically confirmed.`,
  };
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

  const clientResult = await CmosDatabaseClient.create({ dbPath: DB_PATH, readonly: true });
  if (!clientResult.success || !clientResult.data) {
    throw new Error(`Failed to open DB: ${clientResult.error?.message ?? 'unknown'}`);
  }
  const client = clientResult.data;

  try {
    const realEmbedder = await getEmbedder();
    const { embed, stats } = memoizedEmbedder(realEmbedder);

    process.stderr.write(
      `[tune] sweeping ${RRF_K_GRID.length}×${RECENCY_WEIGHT_GRID.length} = ${
        RRF_K_GRID.length * RECENCY_WEIGHT_GRID.length
      } combinations × ${fixtures.length} fixtures\n`
    );

    const sweepResults = await runSweep(client, fixtures, embed);
    const ranked = rankCombinations(sweepResults);
    const verdict = buildVerdict(ranked);
    const bm25Reference = bm25Snapshot(client, fixtures);
    const elapsedMs = Date.now() - startedAt;

    const report = {
      meta: {
        sprint: 'sprint-67',
        mission: 's67-m02',
        measuredAt: new Date().toISOString(),
        durationMs: elapsedMs,
        dbPath: path.relative(process.cwd(), DB_PATH),
        fixtureCount: fixtures.length,
        topK: TOP_K,
        grid: {
          rrfK: RRF_K_GRID,
          recencyWeight: RECENCY_WEIGHT_GRID,
        },
        currentDefaults: CURRENT_DEFAULTS,
        embedderCacheStats: stats,
        updateRule: {
          mrrLiftThreshold: MRR_LIFT_THRESHOLD,
          syntheticMrrFloor: SYNTHETIC_MRR_FLOOR,
        },
      },
      bm25Reference,
      verdict,
      ranked,
    };

    fs.writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`[tune] wrote ${path.relative(process.cwd(), RESULTS_PATH)}\n`);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`tune-retrieval-params failed: ${(err as Error).message}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
});
