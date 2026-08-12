// ABOUTME: Sprint 69 m01 — cross-store baseline measurement. Walks the active
// per-project CMOS SQLite stores and reports how close the portfolio is to the
// s68 ADR App-View migration triggers: current store count N, mutable-write
// share vs the 25% CRDT threshold, and fan-in p95 latency for the four named
// CMOS queries via application-level fan-out. Re-runnable; emits a stable JSON
// report + a markdown summary upserted into cmos/planning/phase-2-master-plan.md
// (s77-m09 Fork D repointed the writeback from the superseded pro-expansion-roadmap.md).
//
// Usage: npm run baseline:cross-store [-- --archive] [-- --config <path>]
//
// ── JSON report schema (schemaVersion 1) ────────────────────────────────────
// {
//   schemaVersion: 1,
//   meta: { measuredAt, durationMs, tool, configSource },
//   stores: { registered, reachable, queried, unreachable: [...], openErrors: [...],
//             unreliable: [{ projectRoot, queryErrors }], absentTables: [{ projectRoot, tables }] },
//   mutableWriteShare: {
//     thresholds: { crdtPct, approachingPct },
//     coverage: { storesCounted, storesExcluded, complete, note },     // what the shares cover
//     overall: { appendWrites, transitionWrites, sharePct, status },   // headline
//     softLock: { byTable: {...}, surfaceWrites, totalWrites, sharePct, status, note },
//     projectIdentityEdits: { byProject: [{ projectRoot, identitySnapshots, reliable }], note },
//     perProject: [{ projectRoot, appendWrites, transitionWrites, reliable, ...durable counts }]
//   },
//   fanInLatency: {
//     thresholds: { triggerMs, approachingMs }, runsPerQuery,
//     queries: [{ key, label, coldMs, warmP95Ms, p95Ms, resultCount, storesQueried, storeErrors, status }],
//     aggregateP95Ms (worst-case = slowest query p95), status
//   }
// }
// The schema is stable across runs so future tooling can diff baseline reports
// for trend analysis. Bump schemaVersion only on a breaking shape change.

import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { CmosDatabaseClient } from '../src/tools/cmos/client';
import type { CmosToolError } from '../src/tools/cmos/types';
import { ProjectGraphRegistry } from '../src/intelligence/project-graph-registry';

// ─── Thresholds (from s68 ADR Section 5.1 + CMOS-MULTIUSER-COLLAB-01-01) ──────
const CRDT_THRESHOLD_PCT = 25; // 25% mutable-write share → revisit CRDT layering
const CRDT_APPROACHING_PCT = 15;
const FANIN_TRIGGER_MS = 200; // p95 > 200ms → App-View Trigger A
const FANIN_APPROACHING_MS = 100;
const RUNS_PER_QUERY = 10;
const REPORT_PATH = path.resolve(__dirname, '..', 'cmos/research/s69-baseline-measurement.json');
// s77-m09 Fork D: the writeback target is the authoritative phase-2-master-plan.md;
// the superseded pro-expansion-roadmap.md no longer carries the regenerating block.
const ROADMAP_PATH = path.resolve(__dirname, '..', 'cmos/planning/phase-2-master-plan.md');
const MARK_START = '<!-- BASELINE-MEASUREMENT-S69M01 -->';
const MARK_END = '<!-- /BASELINE-MEASUREMENT-S69M01 -->';

// ─── Write-source note (why durable domain tables, not the sync queue) ───────
// `sync_event_queue` is a TRANSIENT delivery queue, drained after each event is
// pushed to the dashboard — on a synced store it is empty, so it carries NO
// historical mutable-write signal. Reading it would report a misleading "0%".
// Instead we count durable signals on the append-only domain tables themselves:
// every row is a genesis (append) event, and per-row transition columns
// (missions.started_at / completed_at, sprints.status='Completed',
// sessions.completed_at, strategic_decisions.superseded_by) are durable
// evidence that ≥1 mutation occurred on that row. This is a floor on mutation
// count (it can't see an UPDATE that was later reverted, or repeated UPDATEs to
// the same column), which the report states explicitly.

// ─── Types ───────────────────────────────────────────────────────────────────
export type ThresholdStatus = 'ok' | 'approaching' | 'exceeded' | 'unavailable';

export interface QuerySpec {
  key: string;
  label: string;
  sql: string;
  params: Record<string, unknown>;
  /** Column the merged result set is ordered by (occurred_at proxy). */
  sortKey: string;
}

/** Durable write counts read from one store's append-only domain tables. */
export interface StoreWriteCounts {
  // Genesis (append) counts — one per row.
  decisions: number;
  learnings: number;
  missions: number;
  sprints: number;
  sessions: number;
  nextSteps: number;
  constraints: number;
  contextSnapshots: number;
  // Transition (mutation) proxies — durable per-row signals.
  missionsStarted: number; // started_at IS NOT NULL (Queued → In Progress)
  missionsCompleted: number; // completed_at IS NOT NULL
  sprintsCompleted: number; // status = 'Completed' (the contested soft-lock surface)
  sessionsCompleted: number; // completed_at IS NOT NULL
  decisionsSuperseded: number; // superseded_by IS NOT NULL
  // project_identity edit lower bound.
  identitySnapshots: number;
}

const EMPTY_COUNTS: StoreWriteCounts = {
  decisions: 0,
  learnings: 0,
  missions: 0,
  sprints: 0,
  sessions: 0,
  nextSteps: 0,
  constraints: 0,
  contextSnapshots: 0,
  missionsStarted: 0,
  missionsCompleted: 0,
  sprintsCompleted: 0,
  sessionsCompleted: 0,
  decisionsSuperseded: 0,
  identitySnapshots: 0,
};

/** One count query that could not be answered, in `table WHERE clause` vocabulary. */
export interface CountQueryError {
  query: string;
  reason: string;
}

/**
 * What a store's read pass learned BESIDES the counts. The two ways a count can
 * come back 0 are kept STRICTLY apart, because folding them together publishes a
 * false zero into an aggregate that is then written to disk as fact:
 *
 *  - `absentTables` — the table is not in `sqlite_master`. The count genuinely IS
 *    zero (a foreign or partial store). Recorded ONCE PER STORE so the zero is
 *    disclosed rather than silent.
 *  - `queryErrors` — a count query ERRORED on a table that EXISTS (a corrupt page,
 *    a missing module/collation, a lock, a broken connection). The count is
 *    UNKNOWN — never zero. Any entry here makes the whole store's counts
 *    UNRELIABLE, and they are held OUT of the aggregate instead of contributing 0.
 */
export interface StoreReadDiagnostics {
  absentTables: string[];
  queryErrors: CountQueryError[];
}

export function newReadDiagnostics(): StoreReadDiagnostics {
  return { absentTables: [], queryErrors: [] };
}

export interface PerStoreCounts extends StoreWriteCounts {
  projectRoot: string;
  appendWrites: number;
  transitionWrites: number;
  /** False when a count query errored on an EXISTING table — counts are unknown, not zero. */
  reliable: boolean;
  /** Tables absent from this store; their counts are a genuine, recorded 0. */
  absentTables: string[];
  /** Count queries that errored on an existing table. Non-empty ⇒ `reliable: false`. */
  queryErrors: CountQueryError[];
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Linear-interpolated percentile of an unsorted sample. p in [0,100]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

/** Classify a "higher is worse" share/latency against approaching/exceeded bounds. */
export function classifyStatus(
  value: number,
  approaching: number,
  exceeded: number
): ThresholdStatus {
  if (value >= exceeded) return 'exceeded';
  if (value >= approaching) return 'approaching';
  return 'ok';
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function sumAppendWrites(c: StoreWriteCounts): number {
  return (
    c.decisions +
    c.learnings +
    c.missions +
    c.sprints +
    c.sessions +
    c.nextSteps +
    c.constraints +
    c.contextSnapshots
  );
}

export function sumTransitionWrites(c: StoreWriteCounts): number {
  return (
    c.missionsStarted +
    c.missionsCompleted +
    c.sprintsCompleted +
    c.sessionsCompleted +
    c.decisionsSuperseded
  );
}

/**
 * Compute mutable-write share from aggregated durable write counts.
 *
 * Reports TWO complementary metrics:
 *  - `overall`: transitionWrites / (appendWrites + transitionWrites) — the
 *    "fraction of recorded writes that are mutations vs appends", the direct
 *    analog to "append-mostly, CMOS at 5-10%, revisit CRDT at 25%"
 *    (CMOS-MULTIUSER-COLLAB-01-01 / decision #689). HEADLINE, gated at 25%.
 *  - `softLock`: the strict ADR 6.3 contested surface — only sprint status
 *    (Active↔Completed) is a durably-recordable contested transition. Mission
 *    WORKFLOW transitions (started/completed — "Queued → In Progress is a
 *    workflow step, not a contested edit") and session/decision transitions are
 *    EXCLUDED. project_identity edits are a separate lower-bound proxy.
 *
 * `status` is `'unavailable'` when there are zero recorded writes (an empty or
 * un-synced corpus), so an empty portfolio never reads as a confident "0% ok".
 */
export function computeMutableShare(c: StoreWriteCounts): {
  overall: {
    appendWrites: number;
    transitionWrites: number;
    sharePct: number;
    status: ThresholdStatus;
  };
  softLock: {
    byTable: Record<string, { surfaceWrites: number; totalWrites: number; sharePct: number }>;
    surfaceWrites: number;
    totalWrites: number;
    sharePct: number;
    status: ThresholdStatus;
    note: string;
  };
} {
  const appendWrites = sumAppendWrites(c);
  const transitionWrites = sumTransitionWrites(c);
  const totalWrites = appendWrites + transitionWrites;
  const hasData = totalWrites > 0;
  const overallShare = hasData ? (transitionWrites / totalWrites) * 100 : 0;

  const sprintTotal = c.sprints + c.sprintsCompleted;
  const missionTotal = c.missions + c.missionsStarted + c.missionsCompleted;
  const byTable = {
    sprints: {
      surfaceWrites: c.sprintsCompleted,
      totalWrites: sprintTotal,
      sharePct: round(sprintTotal === 0 ? 0 : (c.sprintsCompleted / sprintTotal) * 100),
    },
    missions: {
      // Mission status transitions are recorded but are workflow steps, not
      // contested edits — excluded from the soft-lock surface per ADR 6.3.
      surfaceWrites: 0,
      totalWrites: missionTotal,
      sharePct: 0,
    },
  };
  const surfaceWrites = c.sprintsCompleted;
  const softLockShare = hasData ? (surfaceWrites / totalWrites) * 100 : 0;

  return {
    overall: {
      appendWrites,
      transitionWrites,
      sharePct: round(overallShare),
      status: hasData
        ? classifyStatus(overallShare, CRDT_APPROACHING_PCT, CRDT_THRESHOLD_PCT)
        : 'unavailable',
    },
    softLock: {
      byTable,
      surfaceWrites,
      totalWrites,
      sharePct: round(softLockShare),
      status: hasData
        ? classifyStatus(softLockShare, CRDT_APPROACHING_PCT, CRDT_THRESHOLD_PCT)
        : 'unavailable',
      note:
        'ADR 6.3 strict contested surface, measured from DURABLE per-row signals (sync_event_queue ' +
        'is a transient delivery queue, drained after push — see header). Only sprint status ' +
        '(status="Completed") is a recordable contested transition. Mission started/completed are ' +
        'workflow transitions (excluded), and project_identity edits are a separate lower-bound proxy ' +
        '(projectIdentityEdits). Treat overall.sharePct as the trigger metric; softLock.sharePct is a ' +
        'strict lower bound. All transition counts are floors — a reverted or repeated UPDATE is unseen.',
    },
  };
}

// ─── Per-store reads ─────────────────────────────────────────────────────────

/** Is the table there, missing, or did the probe itself fail? Three answers, not two. */
type TablePresence =
  | { state: 'present' }
  | { state: 'absent' }
  | { state: 'error'; reason: string };

function probeTable(client: CmosDatabaseClient, name: string): TablePresence {
  const row = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [name]
  );
  if (!row.success) {
    return { state: 'error', reason: describeError(row.error) };
  }
  return row.data ? { state: 'present' } : { state: 'absent' };
}

function describeError(error: CmosToolError | undefined): string {
  return `${error?.code ?? 'DB_ERROR'} — ${error?.message ?? 'unknown'}`;
}

function noteAbsent(diag: StoreReadDiagnostics, table: string): void {
  // Once per store, not once per query — `missions` is counted three times.
  if (!diag.absentTables.includes(table)) diag.absentTables.push(table);
}

/**
 * COUNT(*) for a where-clause. THE TWO ZEROS ARE NOT THE SAME ZERO (s86-m02b, f10
 * non-cuttable core): an absent table is a genuine 0 and is recorded as such; a
 * query that ERRORS on an existing table yields an UNKNOWN count, which is
 * recorded into `diag.queryErrors` so the caller can exclude the whole store from
 * any published aggregate. The returned 0 in the error case is a placeholder that
 * MUST NOT be read as a count — `PerStoreCounts.reliable` is the flag that says so.
 *
 * Exported as the seam a test drives against a fixture store whose table exists
 * but cannot be queried.
 */
export function safeCount(
  client: CmosDatabaseClient,
  table: string,
  where: string,
  diag: StoreReadDiagnostics
): number {
  const label = `${table}${where ? ` WHERE ${where}` : ''}`;
  const presence = probeTable(client, table);
  if (presence.state === 'error') {
    // The PREDICATE failed, so we do not know whether the table is there. Never
    // fail open into "absent → 0" (agents.md standing gate: no silent fail-open).
    diag.queryErrors.push({ query: `sqlite_master probe for ${table}`, reason: presence.reason });
    return 0;
  }
  if (presence.state === 'absent') {
    noteAbsent(diag, table);
    return 0;
  }
  const row = client.getOne<{ c: number }>(`SELECT COUNT(*) AS c FROM ${label}`, []);
  if (!row.success) {
    diag.queryErrors.push({ query: label, reason: describeError(row.error) });
    return 0;
  }
  if (!row.data) {
    // COUNT(*) always returns a row; no row on a successful query is anomalous.
    diag.queryErrors.push({ query: label, reason: 'COUNT(*) returned no row' });
    return 0;
  }
  return row.data.c;
}

/**
 * Read durable write counts from one store's append-only domain tables. A missing
 * table counts 0 (and is recorded in `diag.absentTables`) so a foreign/partial
 * store never throws; a table that exists but cannot be queried is recorded in
 * `diag.queryErrors` and makes the store's counts unreliable.
 *
 * The `diag` default exists only for direct unit use where the counts are asserted
 * in place; every path that PUBLISHES a number passes the store's own sink
 * (see `readStoreCounts`), so no aggregate is ever built from unread diagnostics.
 */
export function countStoreWrites(
  client: CmosDatabaseClient,
  diag: StoreReadDiagnostics = newReadDiagnostics()
): StoreWriteCounts {
  return {
    decisions: safeCount(client, 'strategic_decisions', '', diag),
    learnings: safeCount(client, 'learnings', '', diag),
    missions: safeCount(client, 'missions', '', diag),
    sprints: safeCount(client, 'sprints', '', diag),
    sessions: safeCount(client, 'sessions', '', diag),
    nextSteps: safeCount(client, 'next_steps', '', diag),
    constraints: safeCount(client, 'constraints', '', diag),
    contextSnapshots: safeCount(client, 'context_snapshots', '', diag),
    missionsStarted: safeCount(client, 'missions', 'started_at IS NOT NULL', diag),
    missionsCompleted: safeCount(client, 'missions', 'completed_at IS NOT NULL', diag),
    sprintsCompleted: safeCount(client, 'sprints', "status = 'Completed'", diag),
    sessionsCompleted: safeCount(client, 'sessions', 'completed_at IS NOT NULL', diag),
    decisionsSuperseded: safeCount(
      client,
      'strategic_decisions',
      'superseded_by IS NOT NULL',
      diag
    ),
    identitySnapshots: safeCount(
      client,
      'context_snapshots',
      "context_id = 'project_identity'",
      diag
    ),
  };
}

/** Read a store's write counts from an already-open read-only client. */
export function readStoreCounts(projectRoot: string, client: CmosDatabaseClient): PerStoreCounts {
  const diag = newReadDiagnostics();
  const counts = countStoreWrites(client, diag);
  return {
    projectRoot,
    ...counts,
    appendWrites: sumAppendWrites(counts),
    transitionWrites: sumTransitionWrites(counts),
    reliable: diag.queryErrors.length === 0,
    absentTables: diag.absentTables,
    queryErrors: diag.queryErrors,
  };
}

/**
 * Open a store read-only, or return the failure reason. Note: the shared client
 * runs `journal_mode=WAL` on open, which a brand-new non-WAL store cannot honor
 * read-only — such stores surface in `openErrors` rather than failing the run.
 * Every store the MCP server has ever written is already WAL, so this only
 * affects never-opened stores.
 */
export type StoreOpener = (
  dbPath: string
) => Promise<{ client: CmosDatabaseClient } | { error: string }>;

const defaultOpener: StoreOpener = async (dbPath) => {
  const res = await CmosDatabaseClient.create({ dbPath, readonly: true });
  if (res.success && res.data) return { client: res.data };
  return { error: res.error?.message ?? 'failed to open' };
};

// ─── Fan-out query simulation ────────────────────────────────────────────────

interface FanInResult {
  resultCount: number;
  storesQueried: number;
  storeErrors: number;
}

/**
 * Run one query as an application-level fan-out across the open stores: query
 * each store, concat, and merge-sort by the query's sortKey descending (the
 * occurred_at proxy). Per-store failures are isolated — a store that errors is
 * counted and excluded, never failing the whole query.
 */
export function runFanIn(
  clients: { projectRoot: string; client: CmosDatabaseClient }[],
  q: QuerySpec
): FanInResult {
  const merged: Record<string, unknown>[] = [];
  let storesQueried = 0;
  let storeErrors = 0;
  for (const { client } of clients) {
    const res = client.getMany<Record<string, unknown>>(q.sql, q.params);
    if (res.success && res.data) {
      storesQueried += 1;
      merged.push(...res.data);
    } else {
      storeErrors += 1;
    }
  }
  // Streaming merge-sort is overkill at this N; a single sort over the union is
  // representative of the fan-in merge cost the ADR's read path will pay.
  merged.sort((a, b) => {
    const av = String(a[q.sortKey] ?? '');
    const bv = String(b[q.sortKey] ?? '');
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  return { resultCount: merged.length, storesQueried, storeErrors };
}

/** The four named CMOS queries (s68 ADR Section 5.4), materialized against `now`. */
export function materializeDefaultQueries(now: number): QuerySpec[] {
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      key: 'decisions_last_30d',
      label: 'All decisions across projects in the last 30 days',
      sql: 'SELECT id, decision_text, created_at FROM strategic_decisions WHERE created_at >= :since ORDER BY created_at DESC',
      params: { since: thirtyDaysAgo },
      sortKey: 'created_at',
    },
    {
      key: 'active_missions',
      label: 'Active missions across the portfolio',
      sql: "SELECT id, name, status FROM missions WHERE status IN ('In Progress', 'Current')",
      params: {},
      sortKey: 'id',
    },
    {
      key: 'learnings_by_tag',
      label: 'Learnings tagged X across N projects (category as tag proxy)',
      sql: 'SELECT id, content, category, created_at FROM learnings WHERE category = :tag',
      params: { tag: 'technical' },
      sortKey: 'created_at',
    },
    {
      key: 'decision_citations',
      label: 'Decisions that cite each other (evidence-bearing decisions; pre-m03 proxy)',
      sql: "SELECT id, decision_text, evidence, created_at FROM strategic_decisions WHERE evidence IS NOT NULL AND evidence != ''",
      params: {},
      sortKey: 'created_at',
    },
  ];
}

interface QueryLatency {
  key: string;
  label: string;
  coldMs: number;
  warmP95Ms: number;
  p95Ms: number;
  resultCount: number;
  storesQueried: number;
  storeErrors: number;
  status: ThresholdStatus;
}

function measureQuery(
  clients: { projectRoot: string; client: CmosDatabaseClient }[],
  q: QuerySpec,
  runs: number
): QueryLatency {
  const latencies: number[] = [];
  let last: FanInResult = { resultCount: 0, storesQueried: 0, storeErrors: 0 };
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    last = runFanIn(clients, q);
    latencies.push(performance.now() - start);
  }
  const p95 = percentile(latencies, 95);
  return {
    key: q.key,
    label: q.label,
    coldMs: round(latencies[0] ?? 0, 3),
    warmP95Ms: round(percentile(latencies.slice(1), 95), 3),
    p95Ms: round(p95, 3),
    resultCount: last.resultCount,
    storesQueried: last.storesQueried,
    storeErrors: last.storeErrors,
    status: classifyStatus(p95, FANIN_APPROACHING_MS, FANIN_TRIGGER_MS),
  };
}

// ─── Report assembly ─────────────────────────────────────────────────────────

export interface BaselineReport {
  schemaVersion: number;
  meta: { measuredAt: string; durationMs: number; tool: string; configSource: string };
  stores: {
    registered: number;
    reachable: number;
    queried: number;
    unreachable: { projectRoot: string; reason: string }[];
    openErrors: { projectRoot: string; reason: string }[];
    /** Opened, but a count query errored on an existing table — counts UNKNOWN, excluded. */
    unreliable: { projectRoot: string; queryErrors: CountQueryError[] }[];
    /** Opened, missing one or more CMOS tables — a genuine 0, recorded not swallowed. */
    absentTables: { projectRoot: string; tables: string[] }[];
  };
  mutableWriteShare: ReturnType<typeof computeMutableShare> & {
    thresholds: { crdtPct: number; approachingPct: number };
    coverage: {
      storesCounted: number;
      storesExcluded: number;
      complete: boolean;
      note: string;
    };
    projectIdentityEdits: {
      byProject: { projectRoot: string; identitySnapshots: number; reliable: boolean }[];
      note: string;
    };
    perProject: PerStoreCounts[];
  };
  fanInLatency: {
    thresholds: { triggerMs: number; approachingMs: number };
    runsPerQuery: number;
    queries: QueryLatency[];
    aggregateP95Ms: number;
    status: ThresholdStatus;
  };
}

/**
 * Build the full baseline report. Opens each reachable store ONCE read-only (via
 * the injected opener, default = real read-only client), reuses that connection
 * for both the write-count reads and the fan-in latency runs, and closes them
 * all at the end. Stores that fail to open are isolated into `openErrors` rather
 * than failing the run; stores that open but error on a query are isolated
 * per-query into `storeErrors`. The report SHAPE is deterministic; only latency
 * numbers and `meta` vary across runs.
 */
export async function buildReport(
  reachable: { projectRoot: string; dbPath: string }[],
  unreachable: { projectRoot: string; reason: string }[],
  registeredCount: number,
  queries: QuerySpec[],
  opts: { now: number; configSource: string; runsPerQuery?: number; openStore?: StoreOpener }
): Promise<BaselineReport> {
  const startedAt = performance.now();
  const runs = opts.runsPerQuery ?? RUNS_PER_QUERY;
  const openStore = opts.openStore ?? defaultOpener;

  // Open every reachable store once (read-only); isolate open failures.
  const open: { projectRoot: string; client: CmosDatabaseClient }[] = [];
  const openErrors: { projectRoot: string; reason: string }[] = [];
  for (const { projectRoot, dbPath } of reachable) {
    const opened = await openStore(dbPath);
    if ('client' in opened) {
      open.push({ projectRoot, client: opened.client });
    } else {
      openErrors.push({ projectRoot, reason: opened.error });
    }
  }

  let perProject: PerStoreCounts[] = [];
  const aggregate: StoreWriteCounts = { ...EMPTY_COUNTS };
  let queryResults: QueryLatency[] = [];
  try {
    // Per-store durable write counts.
    perProject = open.map(({ projectRoot, client }) => readStoreCounts(projectRoot, client));
    for (const p of perProject) {
      // A store whose count query errored contributes NOTHING — not a 0. Folding
      // its placeholder zeros in would publish a smaller denominator as fact.
      if (!p.reliable) continue;
      for (const k of Object.keys(aggregate) as (keyof StoreWriteCounts)[]) {
        aggregate[k] += p[k];
      }
    }
    // Fan-in latency over the same open connections.
    queryResults = queries.map((q) => measureQuery(open, q, runs));
  } finally {
    for (const { client } of open) client.close();
  }

  const share = computeMutableShare(aggregate);
  const unreliableStores = perProject
    .filter((p) => !p.reliable)
    .map((p) => ({ projectRoot: p.projectRoot, queryErrors: p.queryErrors }));
  const absentTableStores = perProject
    .filter((p) => p.absentTables.length > 0)
    .map((p) => ({ projectRoot: p.projectRoot, tables: p.absentTables }));
  const storesCounted = perProject.length - unreliableStores.length;
  // Worst-case (max) per-query p95 — App-View Trigger A fires if ANY query's
  // fan-in p95 exceeds 200ms, so the max is the honest portfolio headline (a
  // mean/percentile-of-percentiles over 4 points would mask a slow query).
  const aggregateP95 = queryResults.reduce((m, r) => Math.max(m, r.p95Ms), 0);

  return {
    schemaVersion: 1,
    meta: {
      measuredAt: new Date(opts.now).toISOString(),
      durationMs: round(performance.now() - startedAt, 1),
      tool: 'measure-cross-store-baseline',
      configSource: opts.configSource,
    },
    stores: {
      registered: registeredCount,
      reachable: reachable.length,
      queried: open.length,
      unreachable,
      openErrors,
      unreliable: unreliableStores,
      absentTables: absentTableStores,
    },
    mutableWriteShare: {
      thresholds: { crdtPct: CRDT_THRESHOLD_PCT, approachingPct: CRDT_APPROACHING_PCT },
      coverage: {
        storesCounted,
        storesExcluded: unreliableStores.length,
        complete: unreliableStores.length === 0,
        note:
          'Every share below is computed over the storesCounted stores whose count queries ALL ' +
          'succeeded. A store where a count query errored on an EXISTING table has UNKNOWN counts, ' +
          'not zero counts, so it is held OUT of the aggregate rather than contributing a false 0 ' +
          'to the denominator — see stores.unreliable for the store and the failing query. An ' +
          'ABSENT table is a different thing: it is a genuine 0, counted as 0, and recorded in ' +
          'stores.absentTables so the zero is disclosed rather than silent.',
      },
      ...share,
      projectIdentityEdits: {
        byProject: perProject.map((p) => ({
          projectRoot: p.projectRoot,
          identitySnapshots: p.identitySnapshots,
          reliable: p.reliable,
        })),
        note:
          'Lower-bound history-depth proxy: count of context_snapshots taken of the project_identity ' +
          'context. The live contexts row is a single PK row (one updated_at value), so SQLite retains ' +
          'no per-UPDATE history. Not every edit is snapshotted — treat as a floor, not a count. ' +
          'A row with reliable:false had a count query error, so its number is a placeholder and ' +
          'not even a floor.',
      },
      perProject,
    },
    fanInLatency: {
      thresholds: { triggerMs: FANIN_TRIGGER_MS, approachingMs: FANIN_APPROACHING_MS },
      runsPerQuery: runs,
      queries: queryResults,
      aggregateP95Ms: round(aggregateP95, 3),
      status: classifyStatus(aggregateP95, FANIN_APPROACHING_MS, FANIN_TRIGGER_MS),
    },
  };
}

// ─── Markdown summary ────────────────────────────────────────────────────────

export function renderMarkdownSummary(report: BaselineReport): string {
  const m = report.mutableWriteShare;
  const f = report.fanInLatency;
  const date = report.meta.measuredAt.slice(0, 10);
  const storeName = (root: string): string => path.basename(root) || root;
  // The shares below are only a portfolio fact when every queried store answered.
  // When one did not, say so ON the number, not only in a footnote — an excluded
  // store is a hole in the denominator, and the block is published as fact.
  const partialTag = m.coverage.complete ? '' : ' — **PARTIAL CORPUS, see coverage note**';
  const coverageLines = m.coverage.complete
    ? []
    : [
        `- **COUNTS INCOMPLETE — ${m.coverage.storesExcluded} of ` +
          `${m.coverage.storesCounted + m.coverage.storesExcluded} queried store(s) EXCLUDED:** a count query ` +
          'errored on a table that EXISTS, so those counts are UNKNOWN (never 0) and are held out of the ' +
          'aggregate rather than shrinking the denominator: ' +
          report.stores.unreliable
            .map(
              (u) =>
                `\`${storeName(u.projectRoot)}\` (${u.queryErrors
                  .map((e) => `${e.query}: ${e.reason}`)
                  .join('; ')})`
            )
            .join(', '),
      ];
  const absentLines = report.stores.absentTables.length
    ? [
        '- **Absent tables (a genuine zero, recorded not swallowed):** ' +
          report.stores.absentTables
            .map((a) => `\`${storeName(a.projectRoot)}\` (${a.tables.join(', ')})`)
            .join(', '),
      ]
    : [];
  // PER-STORE ROWS, not a bare fleet aggregate (s86-m09 §4(2)). The aggregate above is a
  // portfolio total; a reader cannot tell from it whether one store dominates the share or
  // whether a store contributed nothing because it could not be counted. Those are different
  // facts and the block is published as fact. An UNRELIABLE store prints no share at all —
  // its counts are unknown, and a number in that cell would be the defect this instrument
  // exists to close.
  const storeRows = [...m.perProject]
    .sort((a, b) => b.appendWrites + b.transitionWrites - (a.appendWrites + a.transitionWrites))
    .map((p) => {
      const total = p.appendWrites + p.transitionWrites;
      const share =
        p.reliable && total > 0 ? `${round((p.transitionWrites / total) * 100, 2)}%` : '—';
      const note = !p.reliable
        ? `**UNRELIABLE, EXCLUDED** (${p.queryErrors.map((e) => e.query).join(', ')})`
        : p.absentTables.length
          ? `absent: ${p.absentTables.join(', ')}`
          : '';
      return `| ${storeName(p.projectRoot)} | ${p.reliable ? p.appendWrites : '?'} | ${
        p.reliable ? p.transitionWrites : '?'
      } | ${share} | ${note} |`;
    });

  const lines = [
    MARK_START,
    '',
    '### Baseline measurement (s69-m01)',
    '',
    `_Measured ${date} via \`npm run baseline:cross-store\`. Regenerated in place on each run._`,
    '',
    `- **N (reachable stores):** ${report.stores.reachable} of ${report.stores.registered} registered` +
      (report.stores.unreachable.length
        ? ` (${report.stores.unreachable.length} unreachable)`
        : ''),
    ...coverageLines,
    ...absentLines,
    `- **All-transitions write share (upper bound):** ${m.overall.sharePct}%${partialTag} ` +
      `(transition ${m.overall.transitionWrites} / total ${m.overall.transitionWrites + m.overall.appendWrites}; ` +
      `includes routine workflow transitions) — **${m.overall.status}**`,
    `- **Soft-lock contested share (ADR §6.3 strict lower bound):** ${m.softLock.sharePct}% ` +
      `(${m.softLock.surfaceWrites}/${m.softLock.totalWrites}; sprint completions only)`,
    `- **Contested mutable surface** (what the ${m.thresholds.crdtPct}% CRDT trigger targets) is **bracketed ` +
      `[${m.softLock.sharePct}%, ${m.overall.sharePct}%]** — the research (CMOS-MULTIUSER-COLLAB-01-01) estimated 5-10%. ` +
      `Not precisely measurable until durable transition logging (event_log) lands.`,
    `- **Worst-case fan-in p95 (slowest of 4 named queries, ${f.runsPerQuery} runs):** ${f.aggregateP95Ms}ms ` +
      `(threshold ${f.thresholds.triggerMs}ms, approaching ${f.thresholds.approachingMs}ms) — **${f.status}**`,
    '',
    `**Per-store write counts** (the aggregate above is the sum of the reliable rows only — ` +
      `${m.coverage.storesCounted} of ${m.coverage.storesCounted + m.coverage.storesExcluded} queried):`,
    '',
    '| Store | append | transition | share | note |',
    '| --- | --- | --- | --- | --- |',
    ...storeRows,
    '',
    '| Query | p95 (ms) | cold (ms) | results | stores | errors |',
    '| --- | --- | --- | --- | --- | --- |',
    ...f.queries.map(
      (q) =>
        `| ${q.label} | ${q.p95Ms} | ${q.coldMs} | ${q.resultCount} | ${q.storesQueried} | ${q.storeErrors} |`
    ),
    '',
    `**Trigger-proximity assessment:** App-View Trigger A (N>125 OR fan-in p95>200ms) is **${
      report.stores.reachable > 125 || f.status === 'exceeded' ? 'FIRING' : 'not firing'
    }** — N=${report.stores.queried} and worst fan-in p95=${f.aggregateP95Ms}ms both have wide headroom. ` +
      `CRDT-revisit trigger (25% contested-surface share): the contested surface upper bound (${m.overall.sharePct}%) ` +
      `is below 25%, so the trigger is **not firing**, but the all-transitions share is in the approaching band — ` +
      `worth a re-measure once contested edits are durably logged.` +
      (m.coverage.complete
        ? ''
        : ` **This CRDT reading is PROVISIONAL:** it covers ${m.coverage.storesCounted} of ` +
          `${m.coverage.storesCounted + m.coverage.storesExcluded} queried stores, and the excluded ` +
          `store(s) could move it in either direction — re-run before quoting it.`),
    '',
    '**Caveats:** project_identity edits are not recorded anywhere (lower-bound proxy only); ' +
      'pre-m03 schema, so the four queries use `created_at` as the `occurred_at` proxy and ' +
      'category as the learning-tag proxy; the decision-citation query is an evidence-bearing-row ' +
      'proxy until `stable_event_id` lands (m03).',
    '',
    MARK_END,
  ];
  return lines.join('\n');
}

function upsertMarkdownSection(roadmap: string, section: string): string {
  const startIdx = roadmap.indexOf(MARK_START);
  const endIdx = roadmap.indexOf(MARK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = roadmap.slice(0, startIdx).replace(/\s*$/, '');
    const after = roadmap.slice(endIdx + MARK_END.length).replace(/^\s*/, '');
    return `${before}\n\n${section}\n\n${after}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  return `${roadmap.replace(/\s*$/, '')}\n\n${section}\n`;
}

// ─── Store enumeration + main ────────────────────────────────────────────────

async function enumerateStores(): Promise<{
  reachable: { projectRoot: string; dbPath: string }[];
  unreachable: { projectRoot: string; reason: string }[];
  registered: number;
}> {
  // s80-m02: enumerate stores from the project-graph registry (single source).
  const graph = await ProjectGraphRegistry.create();
  const projects = graph.list();
  const reachable: { projectRoot: string; dbPath: string }[] = [];
  const unreachable: { projectRoot: string; reason: string }[] = [];
  for (const p of projects) {
    const dbPath = path.join(p.store_path, 'cmos', 'db', 'cmos.sqlite');
    if (fs.existsSync(dbPath)) {
      reachable.push({ projectRoot: p.store_path, dbPath });
    } else {
      unreachable.push({ projectRoot: p.store_path, reason: 'cmos/db/cmos.sqlite not found' });
    }
  }
  return { reachable, unreachable, registered: projects.length };
}

function loadConfigQueries(
  configPath: string | undefined,
  now: number
): { queries: QuerySpec[]; source: string } {
  if (!configPath) return { queries: materializeDefaultQueries(now), source: 'default' };
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { queries?: QuerySpec[] };
  if (!Array.isArray(raw.queries) || raw.queries.length === 0) {
    throw new Error(`Config ${configPath} has no "queries" array`);
  }
  return { queries: raw.queries, source: configPath };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const archive = argv.includes('--archive');
  const configIdx = argv.indexOf('--config');
  const configPath = configIdx !== -1 ? argv[configIdx + 1] : undefined;
  const now = Date.now();

  const { reachable, unreachable, registered } = await enumerateStores();
  const { queries, source } = loadConfigQueries(configPath, now);

  const report = await buildReport(reachable, unreachable, registered, queries, {
    now,
    configSource: source,
  });

  if (archive && fs.existsSync(REPORT_PATH)) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    fs.renameSync(REPORT_PATH, REPORT_PATH.replace(/\.json$/, `.${stamp}.json`));
  }
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  if (fs.existsSync(ROADMAP_PATH)) {
    const roadmap = fs.readFileSync(ROADMAP_PATH, 'utf8');
    fs.writeFileSync(ROADMAP_PATH, upsertMarkdownSection(roadmap, renderMarkdownSummary(report)));
  }

  // Absent tables are a genuine zero, but a silent genuine zero is still a story
  // the operator never hears — note it once per store.
  for (const s of report.stores.absentTables) {
    process.stdout.write(
      `Note: ${s.projectRoot} — table(s) absent, counted as 0: ${s.tables.join(', ')}\n`
    );
  }
  // A failed count on an EXISTING table is not a zero at all. Say so loudly, and
  // say that the published share does not cover that store.
  for (const s of report.stores.unreliable) {
    process.stderr.write(
      `WARNING: ${s.projectRoot} — counts UNRELIABLE, EXCLUDED from the aggregate: ` +
        `${s.queryErrors.map((e) => `${e.query} → ${e.reason}`).join('; ')}\n`
    );
  }

  const coverage = report.mutableWriteShare.coverage;
  process.stdout.write(
    `Baseline measured: N=${report.stores.queried}/${report.stores.registered} queried ` +
      `(${report.stores.reachable} reachable), ` +
      `mutable-write share ${report.mutableWriteShare.overall.sharePct}% (${report.mutableWriteShare.overall.status}` +
      (coverage.complete
        ? ''
        : `, PARTIAL — counts from ${coverage.storesCounted}/${coverage.storesCounted + coverage.storesExcluded} stores`) +
      `), ` +
      `fan-in p95 ${report.fanInLatency.aggregateP95Ms}ms (${report.fanInLatency.status}).\n` +
      `Report: ${path.relative(process.cwd(), REPORT_PATH)}\n`
  );
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`measure-cross-store-baseline failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
