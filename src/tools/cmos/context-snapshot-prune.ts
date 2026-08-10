// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s84-m04 (#478) — PURE selection logic for the context_snapshots bounded-retention
// ABOUTME: prune. Given rows + live-FK ids + config, decides which snapshots' content to reclaim.

/**
 * A context_snapshots row, projected to only what the prune selection needs. `contentLength`
 * is `LENGTH(content)` (the bytes a tombstone reclaims); `contentPrunedAt` is non-null when the
 * row was already content-tombstoned by a prior prune (so it is skipped, not re-counted).
 */
export interface SnapshotRow {
  id: number;
  contextId: string;
  source: string | null;
  /** ISO-8601 created_at — lexicographically sortable, so string compare == time order. */
  createdAt: string;
  contentLength: number;
  contentPrunedAt: string | null;
}

/** Prune knobs. `keepPerContext` = the last-N to keep per context (N=30 default). `days` > 0
 *  additionally preserves rows created within that many days (0 = age-preservation disabled). */
export interface PruneConfig {
  keepPerContext: number;
  days: number;
  /** Injected wall-clock (Unix ms) so age math is deterministic + testable — never Date.now(). */
  nowMs: number;
}

/** Why a preserved row survived (a row can qualify under several — counted under the first hit
 *  in this priority so the reasons sum to the preserved total). */
export interface PreserveReasons {
  newestPerContext: number;
  fkReferenced: number;
  sprintComplete: number;
  lastN: number;
  withinDays: number;
}

export interface PruneSelection {
  /** Ids to preserve (content kept intact). */
  preserveIds: number[];
  /** Ids whose content is reclaimable (tombstone or --hard delete). */
  prunableIds: number[];
  /** Per-context breakdown for the operator report. */
  perContext: Array<{ contextId: string; total: number; preserved: number; prunable: number }>;
  /** Sum of `contentLength` over prunable rows — bytes a `--apply` reclaims. */
  bytesReclaimable: number;
  preserveReasons: PreserveReasons;
}

/**
 * s84-m04 — is this row a SPRINT-COMPLETE milestone snapshot? The `source` column encodes the
 * reason; a sprint close stamps `sprint_complete:<sprintId>`. RATIFIED scope (build doc §2): only
 * the pure `sprint_complete*` prefix is a milestone — `mission_complete:*` / `session_complete:*`
 * (including the legacy `mission_complete:sNN-mNN:sprint_complete` suffix on old sprints) are the
 * per-mission/per-session bloat this prune targets, NOT milestones. Matched by prefix so it is a
 * single, testable predicate.
 */
export function isSprintCompleteSource(source: string | null): boolean {
  return source != null && source.startsWith('sprint_complete');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide which context_snapshots' content to reclaim. PURE — no DB, no clock, no I/O — so the
 * policy is unit-testable in isolation and the CLI/tests share one selection.
 *
 * A row is PRESERVED (content kept) when it is ANY of (union — never lose an audit-important row):
 *   1. newest-per-context (the current state for each context_id);
 *   2. FK-referenced (a `strategic_decisions.snapshot_id` points at it — resolved LIVE by the
 *      caller, never hardcoded);
 *   3. sprint_complete-sourced (a milestone — see {@link isSprintCompleteSource});
 *   4. within the last-N per context (N = `keepPerContext`);
 *   5. created within `days` days (only when `days` > 0).
 * Everything else with non-empty, not-already-pruned content is PRUNABLE.
 */
export function selectSnapshotsToPrune(
  rows: SnapshotRow[],
  fkReferencedIds: ReadonlySet<number>,
  config: PruneConfig
): PruneSelection {
  const preserve = new Set<number>();
  const reasons: PreserveReasons = {
    newestPerContext: 0,
    fkReferenced: 0,
    sprintComplete: 0,
    lastN: 0,
    withinDays: 0,
  };

  // Group by context; sort newest-first (ISO string compare == time order; tiebreak by id desc
  // so a same-instant pair is deterministic).
  const byContext = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const list = byContext.get(r.contextId);
    if (list) list.push(r);
    else byContext.set(r.contextId, [r]);
  }

  const keepN = Math.max(0, Math.floor(config.keepPerContext));

  // Attribute each preserved id to exactly ONE reason (first match wins, in this priority) so the
  // reason tallies sum to the preserved total for an honest report.
  const markPreserved = (id: number, reason: keyof PreserveReasons): void => {
    if (preserve.has(id)) return;
    preserve.add(id);
    reasons[reason] += 1;
  };

  for (const [, ctxRows] of byContext) {
    const sorted = [...ctxRows].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return b.id - a.id;
    });
    if (sorted.length > 0) markPreserved(sorted[0].id, 'newestPerContext');
    for (const r of sorted.slice(0, keepN)) markPreserved(r.id, 'lastN');
  }

  for (const r of rows) {
    if (fkReferencedIds.has(r.id)) markPreserved(r.id, 'fkReferenced');
    if (isSprintCompleteSource(r.source)) markPreserved(r.id, 'sprintComplete');
    if (config.days > 0) {
      const t = Date.parse(r.createdAt);
      if (!Number.isNaN(t) && config.nowMs - t <= config.days * DAY_MS) {
        markPreserved(r.id, 'withinDays');
      }
    }
  }

  const prunable = rows.filter(
    (r) => !preserve.has(r.id) && r.contentPrunedAt == null && r.contentLength > 0
  );
  const prunableIdSet = new Set(prunable.map((r) => r.id));
  const bytesReclaimable = prunable.reduce((sum, r) => sum + r.contentLength, 0);

  const perContext = [...byContext.entries()]
    .map(([contextId, ctxRows]) => ({
      contextId,
      total: ctxRows.length,
      preserved: ctxRows.filter((r) => preserve.has(r.id)).length,
      prunable: ctxRows.filter((r) => prunableIdSet.has(r.id)).length,
    }))
    .sort((a, b) => (a.contextId < b.contextId ? -1 : 1));

  return {
    preserveIds: [...preserve],
    prunableIds: prunable.map((r) => r.id),
    perContext,
    bytesReclaimable,
    preserveReasons: reasons,
  };
}

/** Default last-N-per-context kept when neither `--keep` nor the env override is set. */
export const DEFAULT_SNAPSHOT_PRUNE_KEEP = 30;

/**
 * Resolve the effective keep-N from the flag → env → default chain (an explicit `--keep` wins over
 * `CMOS_SNAPSHOT_PRUNE_KEEP`, which wins over {@link DEFAULT_SNAPSHOT_PRUNE_KEEP}). Ignores a
 * non-finite / negative value and falls through to the next source.
 */
export function resolveKeepN(flag: number | undefined, env: string | undefined): number {
  if (flag !== undefined && Number.isFinite(flag) && flag >= 0) return Math.floor(flag);
  if (env !== undefined) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_SNAPSHOT_PRUNE_KEEP;
}
