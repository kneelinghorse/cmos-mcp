// ABOUTME: Sprint 67 m01 / Sprint 82 m02 — production-corpus paraphrase measurement + gate.
// Runs the hand-authored fixtures at tests/fixtures/paraphrase-fixtures-production.json
// through both BM25-only and HybridRetriever (real Xenova embedder) against the live
// cmos/db/cmos.sqlite. As a REPORTER (no flag) it emits a JSON report. As a GATE
// (--gate) it additionally enforces per-type floors + a decisions/learnings baseline-delta
// regression assert + an embedder-loaded assert, and process.exit(1) on any miss.
//
// s82-m02: imports the retriever from BUILT dist/ (not src/ via ts-node) so the numbers
// reflect shipped code; meta reads the live DEFAULT_RRF_K / DEFAULT_RECENCY_WEIGHT so the
// old stale 60/0.5 can never re-drift.

import * as fs from 'fs';
import * as path from 'path';
import { CmosDatabaseClient } from '../dist/tools/cmos/client';
import {
  HybridRetriever,
  type RankedResult,
  DEFAULT_RRF_K,
  DEFAULT_RECENCY_WEIGHT,
} from '../dist/tools/cmos/fts5-retriever';
import { extractKeywords } from '../dist/tools/cmos/supersession-detection';

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'tests/fixtures/paraphrase-fixtures-production.json'
);
// s82-m03: allow gating a COPY of the store (backfill-against-a-copy discipline) by pointing
// at an alternate DB. Defaults to the live git-tracked store.
const DB_PATH = process.env.CMOS_RETRIEVAL_DB
  ? path.resolve(process.env.CMOS_RETRIEVAL_DB)
  : path.resolve(__dirname, '..', 'cmos/db/cmos.sqlite');
const BASELINE_PATH = path.resolve(__dirname, '..', 'tests/fixtures/retrieval-baseline.json');
const TOP_K = 10;

// ─── Gate configuration (s82-m02) ─────────────────────────────────────────────

const GATE = process.argv.includes('--gate');
const WRITE_BASELINE = process.argv.includes('--write-baseline');

// Mission top-3 recall floor. Env-overridable so the gate's bite can be demonstrated
// (positive-fire) without editing this file. s82-m04: re-set to 0.50 — the honest achievable
// value once the graph-neighbor arm is on (the m03 mission-embedding trim was a negative
// result; the graph arm doubled mission top-3 recall 0.25→0.50 with zero decision/learning
// regression). Measured on the production recall path (expandGraph=true), which is what
// context-search / relevance-surfacing use.
const MISSION_TOP3_FLOOR = envFloat('CMOS_MISSION_TOP3_FLOOR', 0.5);
// Decisions/learnings may not drop more than this below the committed baseline (5 points).
const REGRESSION_TOLERANCE = envFloat('CMOS_REGRESSION_TOLERANCE', 0.05);

// s82-m03/FORK-E5: optional per-run tuning overrides for the post-re-embed sweep. Undefined
// => the retriever's shipped DEFAULT_RRF_K / DEFAULT_RECENCY_WEIGHT are used.
const RECENCY_OVERRIDE = envOptFloat('CMOS_RECENCY_OVERRIDE');
const RRFK_OVERRIDE = envOptInt('CMOS_RRFK_OVERRIDE');

function envOptFloat(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}
function envOptInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

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

interface BaselineFile {
  measuredAt: string;
  note: string;
  hybrid: PerTypeMetrics;
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

// ─── Gate evaluation (s82-m02) ────────────────────────────────────────────────

interface GateResult {
  passed: boolean;
  failures: string[];
  checks: string[];
}

function evaluateGate(hybridPerType: PerTypeMetrics, embedderActive: boolean): GateResult {
  const failures: string[] = [];
  const checks: string[] = [];

  // 1. Embedder-loaded assert: if NO hybrid result across any fixture carries a vector
  // similarity, the vector arm never ran — getEmbedder negative-cached a no-op embedder (the
  // silent BM25-quality trap) and the "hybrid" numbers are really BM25 quality.
  if (embedderActive) {
    checks.push(
      'embedder-loaded: vector arm scored >=1 returned row (vectorSimilarity non-null) ✓'
    );
  } else {
    failures.push(
      'embedder NOT loaded: no hybrid result across any fixture carries a vector similarity ' +
        '(getEmbedder negative-cache silent-BM25 trap) — retrieval numbers are meaningless'
    );
  }

  // 2. Per-type floor: mission top-3 recall.
  if (hybridPerType.mission.top3Recall >= MISSION_TOP3_FLOOR) {
    checks.push(
      `mission top3Recall ${fmt(hybridPerType.mission.top3Recall)} >= floor ${fmt(MISSION_TOP3_FLOOR)} ✓`
    );
  } else {
    failures.push(
      `mission top3Recall ${fmt(hybridPerType.mission.top3Recall)} < floor ${fmt(MISSION_TOP3_FLOOR)}`
    );
  }

  // 3. Baseline-delta regression assert for decisions + learnings.
  if (fs.existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as BaselineFile;
    for (const type of ['decision', 'learning'] as const) {
      const cur = hybridPerType[type].top3Recall;
      const base = baseline.hybrid[type].top3Recall;
      if (cur >= base - REGRESSION_TOLERANCE) {
        checks.push(
          `${type} top3Recall ${fmt(cur)} within ${fmt(REGRESSION_TOLERANCE)} of baseline ${fmt(base)} ✓`
        );
      } else {
        failures.push(
          `${type} top3Recall ${fmt(cur)} regressed >${fmt(REGRESSION_TOLERANCE)} below baseline ${fmt(base)}`
        );
      }
    }
  } else {
    failures.push(
      `no baseline file at ${path.relative(process.cwd(), BASELINE_PATH)} — run with ` +
        `--write-baseline first to establish the decisions/learnings regression anchor`
    );
  }

  return { passed: failures.length === 0, failures, checks };
}

function fmt(n: number): string {
  return n.toFixed(4);
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
    // Tracks whether the vector arm actually scored any returned row (embedder-loaded proof).
    let embedderActive = false;
    const perQuery: Array<{
      query: string;
      type: FixtureType;
      expectedId: number | string;
      paraphraseStrategy: string;
      bm25: { hits: number; expectedRank: number | null };
      hybrid: { hits: number; expectedRank: number | null; vectorHits: number };
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
        ...(RECENCY_OVERRIDE !== undefined ? { recencyWeight: RECENCY_OVERRIDE } : {}),
        ...(RRFK_OVERRIDE !== undefined ? { rrfK: RRFK_OVERRIDE } : {}),
        // s82-m04: the gate measures the PRODUCTION recall path, where context-search /
        // relevance-surfacing pass expandGraph=true — so the arm is ON by default here.
        // CMOS_EXPAND_GRAPH=0 turns it off for the OFF-vs-ON comparison; CMOS_GRAPH_WEIGHT sweeps.
        ...(process.env.CMOS_EXPAND_GRAPH !== '0' ? { expandGraph: true } : {}),
        ...(envOptFloat('CMOS_GRAPH_WEIGHT') !== undefined
          ? { graphWeight: envOptFloat('CMOS_GRAPH_WEIGHT') }
          : {}),
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

      // Embedder-loaded signal (s82-m02): count hybrid results whose vectorSimilarity is
      // non-null — i.e. the vector arm actually embedded the query and scored a returned row
      // (fts5-retriever.ts sets vectorSimilarity = vecSim.get(key) ?? null in the fusion).
      // When getEmbedder negative-caches a no-op embedder, embedQuery returns null, the vector
      // arm is empty, and EVERY hybrid result has vectorSimilarity === null. This signal is
      // intrinsic to the hybrid output — unlike comparing against the harness's own
      // status-unfiltered bm25Only, which diverges from the active-only hybrid path regardless
      // of embedder health and so could never actually catch the trap.
      const vectorHits = hybridResults.filter((r) => r.vectorSimilarity != null).length;
      if (vectorHits > 0) embedderActive = true;

      perQuery.push({
        query: f.query,
        type: f.type,
        expectedId: f.expected_id,
        paraphraseStrategy: f.paraphrase_strategy,
        bm25: { hits: bm25Outcome.hits, expectedRank: bm25Outcome.expectedRank },
        hybrid: { hits: hybridOutcome.hits, expectedRank: hybridOutcome.expectedRank, vectorHits },
      });
    }

    const bm25Aggregate = aggregate(bm25Outcomes);
    const hybridAggregate = aggregate(hybridOutcomes);
    const bm25PerType = aggregateByType(bm25Outcomes);
    const hybridPerType = aggregateByType(hybridOutcomes);
    const elapsedMs = Date.now() - startedAt;

    // --write-baseline: persist the current hybrid per-type metrics as the regression anchor.
    if (WRITE_BASELINE) {
      const baseline: BaselineFile = {
        measuredAt: new Date().toISOString(),
        note:
          'Decisions/learnings top3Recall regression anchor for the s82 recall gate ' +
          '(measure-retrieval-production.ts --gate). Regenerate with --write-baseline after ' +
          'an intentional corpus/fixture change; the gate fails if decision/learning top3Recall ' +
          `drops more than ${REGRESSION_TOLERANCE} below these values.`,
        hybrid: hybridPerType,
      };
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
      process.stderr.write(
        `[baseline] wrote ${path.relative(process.cwd(), BASELINE_PATH)} — ` +
          `decision=${fmt(hybridPerType.decision.top3Recall)} ` +
          `learning=${fmt(hybridPerType.learning.top3Recall)} ` +
          `mission=${fmt(hybridPerType.mission.top3Recall)}\n`
      );
    }

    const report = {
      meta: {
        sprint: 'sprint-82',
        mission: 's82-m02',
        measuredAt: new Date().toISOString(),
        durationMs: elapsedMs,
        dbPath: path.relative(process.cwd(), DB_PATH),
        fixtureCount: fixtures.length,
        topK: TOP_K,
        corpusSnapshot: fixtureFile.corpusSnapshot,
        retrieverDefaults: {
          backend: 'hybrid',
          // s82-m02 (FORK-E5): read the live constants so this can never re-drift from the
          // running retriever (the old hardcoded 60/0.5 was stale for ~15 sprints).
          rrfK: DEFAULT_RRF_K,
          recencyWeight: DEFAULT_RECENCY_WEIGHT,
          statusFilter: ['active'],
        },
        embedderActive,
        gate: GATE
          ? { missionTop3Floor: MISSION_TOP3_FLOOR, regressionTolerance: REGRESSION_TOLERANCE }
          : undefined,
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

    // --gate: enforce floors + regression + embedder-loaded, exit(1) on any miss.
    if (GATE) {
      const gate = evaluateGate(hybridPerType, embedderActive);
      process.stderr.write('\n─── RECALL GATE ───\n');
      for (const c of gate.checks) process.stderr.write(`  PASS  ${c}\n`);
      for (const fmsg of gate.failures) process.stderr.write(`  FAIL  ${fmsg}\n`);
      if (gate.passed) {
        process.stderr.write('GATE PASSED\n');
      } else {
        process.stderr.write(`GATE FAILED (${gate.failures.length} failure(s))\n`);
        client.close();
        process.exit(1);
      }
    }
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
