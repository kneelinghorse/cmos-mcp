// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s84-m04 (#478) — PURE selection logic for the context_snapshots bounded-retention
// ABOUTME: prune. Given rows + live-FK ids + config, decides which snapshots' content to reclaim.

import {
  classifySnapshotSource,
  isAutomaticCopy,
  PRE_MUTATION_KEEP_DAYS,
  snapshotTimeMs,
} from './snapshot-content-policy';

export { snapshotTimeMs };

/**
 * A context_snapshots row, projected to only what the prune selection needs. `contentLength`
 * is `LENGTH(content)` (the bytes a tombstone reclaims); `contentPrunedAt` is non-null when the
 * row was already content-tombstoned by a prior prune (so it is skipped, not re-counted).
 */
export interface SnapshotRow {
  id: number;
  contextId: string;
  source: string | null;
  /** created_at as stored: ISO-8601, or SQLite's `YYYY-MM-DD HH:MM:SS` on old rows (see
   *  `snapshotTimeMs`). */
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
  /** s92-m09: ids the caller keeps, whatever else applies. */
  keepIds?: ReadonlySet<number>;
  /** s92-m09: keep every snapshot created at or after this instant (Unix ms). */
  keepSinceMs?: number | null;
  /** s92-m09: keep every snapshot whose source matches one of these patterns (`*` = anything,
   *  case-insensitive). */
  keepSources?: readonly string[];
  /** s92-m09: a pre-mutation recovery copy younger than this many days is kept. */
  recoveryCopyDays?: number;
  /**
   * s92-m09: the recorded sprint closes. Before s92-m09 a close stored its milestone only when no
   * row of that context already held the same content; otherwise it reused that row, whatever the
   * row was (on this repository's store, 67 of 70 recorded closes left no `sprint_complete:` row in
   * master_context). So for each close that left no milestone row in a context, the newest
   * content-bearing snapshot of that context at or before the close is kept: the state it closed on.
   */
  sprintCloses?: ReadonlyArray<{ sprintId: string; closedAtMs: number }>;
}

/**
 * s92-m09: every snapshot id something still points at. A snapshot referenced from either place
 * keeps its content, whatever its age or source.
 */
export interface SnapshotReferences {
  /** `strategic_decisions.snapshot_id` (an FK, ON DELETE SET NULL). */
  decisions: ReadonlySet<number>;
  /** `archived_sprint_summaries[].snapshot_id` inside any context row: the retention archive a
   *  trimmed sprint's detail lives in. */
  contexts: ReadonlySet<number>;
}

/** Why a preserved row survived (a row can qualify under several — counted under the first hit
 *  in this priority so the reasons sum to the preserved total). */
export interface PreserveReasons {
  newestPerContext: number;
  fkReferenced: number;
  /** s92-m09: referenced from a context's archived_sprint_summaries. */
  contextReferenced: number;
  sprintComplete: number;
  /** s92-m09: an explicit or unrecognised source: someone asked for it, so it is not a copy. */
  notAutomatic: number;
  /** s92-m09: a pre-mutation recovery copy younger than `recoveryCopyDays`. */
  recentRecoveryCopy: number;
  /** s92-m09: the context as a recorded sprint close left it (see `sprintCloses`). */
  sprintCloseState: number;
  lastN: number;
  keepIds: number;
  keepSince: number;
  keepSources: number;
  withinDays: number;
}

export interface PruneSelection {
  /** Ids to preserve (content kept intact). */
  preserveIds: number[];
  /** Ids whose content is reclaimable (tombstone or --hard delete). */
  prunableIds: number[];
  /** Per-context breakdown for the operator report. s92-m09: with bytes. */
  perContext: Array<{
    contextId: string;
    total: number;
    preserved: number;
    prunable: number;
    bytes: number;
    prunableBytes: number;
  }>;
  /** Sum of `contentLength` over prunable rows — bytes a `--apply` reclaims. */
  bytesReclaimable: number;
  preserveReasons: PreserveReasons;
}

/** A `keepSources` pattern as a case-insensitive whole-string match (`*` matches anything). */
export function sourcePatternMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * s84-m04 — is this row a SPRINT-COMPLETE milestone snapshot by the s84 rule (the pure
 * `sprint_complete*` prefix)? s92-m09 widened the milestone CLASS used by the selection
 * (`classifySnapshotSource`): the legacy `mission_complete:<id>:sprint_complete` rows are the
 * context as a sprint closed, so they are kept too, and a close that reused another row is covered
 * by `sprintCloseTimesMs`. This predicate keeps its s84 meaning for its existing callers.
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
 *   3. s92-m09: referenced from a context's `archived_sprint_summaries[].snapshot_id`;
 *   4. a sprint milestone (s92-m09: by `classifySnapshotSource`, which also counts the legacy
 *      `mission_complete:<id>:sprint_complete` rows);
 *   5. s92-m09: not an automatic copy (an explicit or unrecognised source; see
 *      snapshot-content-policy.ts) — only copies the server wrote on its own are reclaimable;
 *   6. s92-m09: a pre-mutation recovery copy younger than `recoveryCopyDays` (30 by default);
 *   7. s92-m09: the state a recorded sprint close landed on (`sprintCloses`);
 *   8. within the last-N per context (N = `keepPerContext`);
 *   9. s92-m09: the caller's keep rules — `keepIds`, `keepSinceMs`, `keepSources`;
 *  10. created within `days` days (only when `days` > 0).
 * Rules 1, 7 and 8 count only rows that still hold content. Everything else with non-empty,
 * not-already-pruned content is PRUNABLE.
 */
export function selectSnapshotsToPrune(
  rows: SnapshotRow[],
  references: SnapshotReferences,
  config: PruneConfig
): PruneSelection {
  const preserve = new Set<number>();
  const reasons: PreserveReasons = {
    newestPerContext: 0,
    fkReferenced: 0,
    contextReferenced: 0,
    sprintComplete: 0,
    notAutomatic: 0,
    recentRecoveryCopy: 0,
    sprintCloseState: 0,
    lastN: 0,
    keepIds: 0,
    keepSince: 0,
    keepSources: 0,
    withinDays: 0,
  };
  const recoveryDays = config.recoveryCopyDays ?? PRE_MUTATION_KEEP_DAYS;
  const keepSourceMatchers = (config.keepSources ?? []).map(sourcePatternMatcher);

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

  // s92-m09 (critic B2): newest, last-N and the sprint-close states count only rows that still
  // hold content. A close copy is written content-less, so it is the newest row after every close;
  // counting such rows let "keep the last 30" protect 30 empty rows and nothing else.
  const holdsContent = (r: SnapshotRow): boolean =>
    r.contentPrunedAt == null && r.contentLength > 0;
  const contentByContext = new Map<string, SnapshotRow[]>();
  for (const [contextId, ctxRows] of byContext) {
    contentByContext.set(
      contextId,
      ctxRows
        .filter(holdsContent)
        .sort((a, b) => snapshotTimeMs(b) - snapshotTimeMs(a) || b.id - a.id)
    );
  }

  for (const [, sorted] of contentByContext) {
    if (sorted.length > 0) markPreserved(sorted[0].id, 'newestPerContext');
  }

  for (const r of rows) {
    if (references.decisions.has(r.id)) markPreserved(r.id, 'fkReferenced');
    if (references.contexts.has(r.id)) markPreserved(r.id, 'contextReferenced');
    const sourceClass = classifySnapshotSource(r.source);
    if (sourceClass === 'sprint-milestone') markPreserved(r.id, 'sprintComplete');
    if (!isAutomaticCopy(sourceClass)) markPreserved(r.id, 'notAutomatic');
    if (sourceClass === 'pre-mutation') {
      const t = snapshotTimeMs(r);
      if (Number.isFinite(t) && config.nowMs - t <= recoveryDays * DAY_MS) {
        markPreserved(r.id, 'recentRecoveryCopy');
      }
    }
  }

  for (const close of config.sprintCloses ?? []) {
    const milestoneSource = `sprint_complete:${close.sprintId}`;
    for (const [, sorted] of contentByContext) {
      if (sorted.some((r) => r.source === milestoneSource)) continue;
      const state = sorted.find((r) => snapshotTimeMs(r) <= close.closedAtMs);
      if (state) markPreserved(state.id, 'sprintCloseState');
    }
  }

  for (const [, sorted] of contentByContext) {
    for (const r of sorted.slice(0, keepN)) markPreserved(r.id, 'lastN');
  }

  for (const r of rows) {
    if (config.keepIds?.has(r.id)) markPreserved(r.id, 'keepIds');
    if (config.keepSinceMs != null) {
      const t = snapshotTimeMs(r);
      if (Number.isFinite(t) && t >= config.keepSinceMs) markPreserved(r.id, 'keepSince');
    }
    if (keepSourceMatchers.some((m) => m.test(r.source ?? ''))) {
      markPreserved(r.id, 'keepSources');
    }
    if (config.days > 0) {
      const t = snapshotTimeMs(r);
      if (Number.isFinite(t) && config.nowMs - t <= config.days * DAY_MS) {
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
      bytes: ctxRows.reduce((sum, r) => sum + r.contentLength, 0),
      prunableBytes: ctxRows
        .filter((r) => prunableIdSet.has(r.id))
        .reduce((sum, r) => sum + r.contentLength, 0),
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
