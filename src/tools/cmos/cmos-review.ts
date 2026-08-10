// ABOUTME: cmos_review — sprint-64 m03 bundled session-opener digest tool.
// ABOUTME: Replaces the rote cmos_agent_onboard + cmos_context_view + cmos_mission_status opener with one ≤4KB payload, project-only, top-3 next_actions promoted to flat top-level.

/**
 * cmos_review Tool
 *
 * Bundles the three canonical session-opener calls (cmos_agent_onboard,
 * cmos_context_view, cmos_mission_status) into a single ≤4KB digest so a
 * fresh agent can boot from one tool call instead of four.
 *
 * Scope is locked per sprint-64 m03 decision #671: cmos_review calls into the
 * existing handlers and shapes their output — it does NOT author new SQL of its
 * own. The s79-m06 portfolio section (below) likewise CONSUMES an existing
 * cross-store helper (`activeMissionsAcrossProjects`), which owns its SQL — so
 * #671 still holds. cmos_agent_onboard and cmos_context_view stay unchanged for
 * back-compat; this tool is purely additive.
 *
 * Cross-store portfolio rollup (s79-m06 — SUPERSEDES the #672 project-only
 * exclusion). #672 excluded cross-project status because the old model was one
 * CMOS aggregating all projects; Arc D makes the sqlite ProjectGraphRegistry the
 * one discovery source + `queryAcrossStores` the one portfolio read path. So
 * cmos_review now carries an ALWAYS-ON, graceful-degrading ≤4KB portfolio section
 * (active missions across the registered projects) built on that graph-backed
 * fan-out. It degrades to `portfolio=null` for a single-project operator (registry
 * lists ≤1 active project) or when the fan-out fails. Latency-fenced to the
 * active-missions query only (no second decisions-pulse fan-out).
 *
 * @module tools/cmos/cmos-review
 */

import { statSync } from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { CmosToolResult } from './types';
import { createSuccess } from './errors';
import { cmosAgentOnboard, type CmosAgentOnboardResult } from './cmos-agent-onboard';
import type { SelfCaptureGap } from './self-capture-guard';
import { cmosMissionStatus, type StatusMissionItem } from './cmos-mission-status';
import { checkBuildFreshness, type BuildFreshnessReport } from './build-freshness';
import { resolveProjectRootEnhanced } from '../../intelligence/project-resolution';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { activeMissionsAcrossProjects } from '../../intelligence/cross-store-queries';
import {
  frameForeignInline,
  frameInlineIfForeign,
  isForeignProject,
} from '../../intelligence/provenance-frame';
import { isReadOnlyAgentSession } from './read-only-agent-guard';

/**
 * Compact action descriptor for the flat top-level next_actions array.
 */
export interface NextAction {
  action: string;
  command: string;
  priority: number;
}

/**
 * Compact work-queue mission entry.
 */
export interface WorkItem {
  id: string;
  name: string;
  /** s84-m03: the mission's own project_id — foreign name is framed / dropped from nextAction. */
  projectId?: string | null;
}

/**
 * Per-bucket work queue summary.
 */
export interface WorkQueueBucket {
  count: number;
  top: WorkItem[];
}

/** s80-m06 — one drifting project in the portfolio drift list. */
export interface PortfolioDriftItem {
  projectId: string;
  /** Display name, capped to {@link DRIFT_NAME_CAP_CHARS}. */
  name: string;
  /** Why it drifted, e.g. "no CMOS write in 37d" or "un-migrated (…)". */
  reason: string;
  /** Store mtime age in whole days (0 when the store could not be stat'd). */
  ageDays: number;
  /** Optional operator action, e.g. "run cmos_db backfill/rebuild" for un-migrated stores. */
  hint?: string;
}

/** s80-m06 — per-project freshness drift within the portfolio. */
export interface PortfolioDrift {
  /** The "silent" threshold in days (a store past it is flagged). */
  staleThresholdDays: number;
  /** The drifting projects (silent + un-migrated), top-N by ageDays desc. */
  stale: PortfolioDriftItem[];
}

/**
 * s79-m06 / s80-m06 — cross-store portfolio rollup. Active missions (In Progress/
 * Current) across the registered projects, built on the graph-backed
 * `queryAcrossStores`. `null` for a single-project operator or when the fan-out fails
 * (graceful degrade). s80-m06 reclassified the old `reachable`/`unreachable` split into
 * a STRICT PARTITION — `reachable + silent + unmigrated + unreadable === projects` — so
 * "reachable" regains its literal meaning (a succeeded, non-stale store) and per-project
 * drift is visible without a fan-out.
 */
export interface PortfolioSection {
  /** Active projects the graph registry lists (= stores queried). */
  projects: number;
  /** Succeeded ∧ fresh (written within `drift.staleThresholdDays`). */
  reachable: number;
  /** Succeeded ∧ stale (no CMOS write in > `drift.staleThresholdDays`). */
  silent: number;
  /** Failed with "no such column" — the missions table predates the s79 per-row rebuild. */
  unmigrated: number;
  /** Failed for another reason (store DB moved/locked/unreadable). */
  unreadable: number;
  /** Active missions across the portfolio: total count + the top ≤5 (trimmed first under budget). */
  activeMissions: {
    count: number;
    top: Array<{ id: string; name: string; projectId: string }>;
  };
  /** p95 per-store fan-in latency in ms (App-View Trigger-A signal); overall wall-clock when no store succeeded. */
  fanInP95Ms: number;
  /** Per-project freshness drift (silent + un-migrated stores); null when nothing drifted. */
  drift: PortfolioDrift | null;
}

/**
 * Result of cmos_review — ≤4KB digest of project state for cold-start onboarding.
 *
 * Field surface is intentionally narrow: only fields a fresh agent needs to
 * decide what to do first. Anything not on this surface lives on the unchanged
 * cmos_agent_onboard payload for callers that need the long form.
 */
export interface CmosReviewResult {
  /** Top-3 ranked actions, promoted from cmos_agent_onboard.suggestedActions. */
  next_actions: NextAction[];

  /** Compact project identity. */
  project: {
    name: string;
    cmos_address: string;
    status: string | null;
    tier: string;
  };

  /** Current sprint summary, focus capped to 280 chars. Null if none. */
  sprint: {
    id: string;
    title: string;
    status: string | null;
    focus: string | null;
    /** s84-m03: the sprint's own project_id — a foreign sprint's title/focus is framed. */
    projectId?: string | null;
  } | null;

  /** Project-only work queue. Cross-project status is explicitly excluded. */
  workQueue: {
    inProgress: WorkQueueBucket;
    current: WorkQueueBucket;
    queued: WorkQueueBucket;
    blocked: { count: number };
    nextAction: string;
  };

  /** Up to 5 most recent decisions in compact {text, createdAt} form. `projectId`
   *  carries genesis provenance so the renderer can frame a pull-merged FOREIGN
   *  decision (project_id != localProjectId) as untrusted (s83-m06). */
  recentDecisions: Array<{ text: string; createdAt: string; projectId: string | null }>;

  /** s83-m06: the local project_id, so the renderer frames foreign recent decisions
   *  and foreign portfolio mission names. */
  localProjectId: string | null;

  /** s79-m06 — always-on cross-store portfolio rollup; null when degraded (≤1 project / fan-out failed). */
  portfolio: PortfolioSection | null;

  /** s80-m07 — self-capture gap, present ONLY when it fires (commits ahead of the last CMOS write). */
  selfCapture?: SelfCaptureGap;

  /** Master-context freshness signal. */
  freshness: {
    lagDays: number;
    isStale: boolean;
  };

  /** Auth and sync warnings only (size-warnings dropped to stay under budget). */
  warnings: string[];

  /** Build-freshness signal — present ONLY when stale=true (Sprint 67 m03).
   *  Closes the s65 retro footgun where missions were marked Complete against
   *  stale runtime code because nobody had rebuilt dist/. */
  buildFreshness?: BuildFreshnessReport;

  /** Self-reported payload size in bytes (matches Buffer.byteLength of JSON). */
  digestSizeBytes: number;
}

/**
 * Input schema for cmos_review.
 */
export const cmosReviewSchema = z.object({
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosReviewParams = z.infer<typeof cmosReviewSchema>;

/**
 * MCP tool definition for cmos_review.
 */
export const cmosReviewToolDefinition = {
  name: 'cmos_review',
  description:
    'Bundled session-opener digest (≤4KB). Replaces the older three-step opener (cmos_agent_onboard + cmos_context(action="view") + cmos_mission(action="status")) with one payload. Top-3 next_actions are promoted to a flat top-level field. Includes an always-on cross-store `portfolio` rollup (active missions across your registered projects) built on the graph-backed queryAcrossStores; it degrades to null for a single-project setup.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/** Top-N applied to each work-queue bucket. */
const WORK_QUEUE_TOP_N = 3;

/** Top-N applied to next_actions (mission spec: "top-3 ranked next_actions"). */
const NEXT_ACTIONS_TOP_N = 3;

/** Hard cap on sprint focus length to keep the digest within budget. */
const SPRINT_FOCUS_CAP_CHARS = 280;

/** Hard cap on individual decision text length. */
const DECISION_TEXT_CAP_CHARS = 220;

/** Hard cap on mission name length for work-queue entries. */
const WORK_ITEM_NAME_CAP_CHARS = 80;

/** Maximum recent-decisions retained in the digest. */
const RECENT_DECISIONS_MAX = 5;

/** Payload budget in bytes (mission spec). */
const DIGEST_BUDGET_BYTES = 4096;

/** s79-m06 — max active missions shown in the portfolio section (count is unbounded up to the fetch limit). */
const PORTFOLIO_TOP_N = 5;

/** s79-m06 — per-store fan-out cap for the portfolio active-missions count (bounded, latency-fenced). */
const PORTFOLIO_FETCH_LIMIT = 50;

/** s79-m06 — cap on a portfolio mission name (tighter than the local work-queue cap to protect the budget). */
const PORTFOLIO_MISSION_NAME_CAP_CHARS = 60;

/** s79-m06 — under-budget re-truncation cap for sprint.focus (trim stage 2). */
const SPRINT_FOCUS_TRIM_CAP_CHARS = 160;

/** s80-m06 — a store with no CMOS write in more than this many days is "silent" (drift). */
const STALE_THRESHOLD_DAYS = 21;

/**
 * s81-m03 — a FRESH store whose local mtime is more than this many days ahead of its
 * persisted `last_synced_at` (last dashboard-converged push from THIS machine) is flagged
 * "local ahead of dashboard (unsynced)". Deliberately SHORTER than the 21d silent
 * threshold — this catches unpushed LOCAL work, a different axis from a dead store.
 * NULL `last_synced_at` (pre-v2 / never-pushed) = no-signal, so it never false-positives.
 */
const UNSYNCED_THRESHOLD_DAYS = 3;

/** s80-m06 — cap on the per-project drift list (top-N by ageDays) to bound digest bytes. */
const DRIFT_TOP_N = 8;

/** s80-m06 — cap on a drifting project's display name in the drift list. */
const DRIFT_NAME_CAP_CHARS = 30;

/**
 * Execute cmos_review.
 *
 * Calls cmos_agent_onboard and cmos_mission_status in parallel (both already
 * exist with their own SQL), then shapes the bundled output into a digest.
 * No new database queries are added by this tool.
 */
export async function cmosReview(
  params: CmosReviewParams = {},
  // s79-m06 — internal, NON-schema seam: an injectable ProjectGraphRegistry for
  // deterministic tests of the portfolio section. NOT exposed on the tool
  // inputSchema (it must never reach the MCP boundary).
  internalOpts: { registry?: ProjectGraphRegistry } = {}
): Promise<CmosToolResult<CmosReviewResult>> {
  const projectRoot = params.projectRoot;

  const [onboardResult, missionStatusResult, buildFreshness, portfolio] = await Promise.all([
    cmosAgentOnboard(projectRoot ? { projectRoot } : {}),
    cmosMissionStatus(
      projectRoot ? { projectRoot, includeBlocked: true } : { includeBlocked: true }
    ),
    resolveReviewFreshness(projectRoot),
    // s79-m06 — the always-on cross-store portfolio rollup (active missions across
    // the registered projects). Runs in the same parallel batch as onboard/status
    // so it adds no serial latency; latency-fenced to the active-missions query.
    // Degrades to null (never throws) on ≤1 project or fan-out failure.
    buildPortfolioSection(internalOpts.registry),
    // s69-m05 — record this project's last_seen_at in the per-user project-graph
    // registry (auto-registering it if absent). Never throws, never blocks the
    // opener (runs in the same parallel batch; result discarded).
    touchProjectGraphRegistry(projectRoot),
  ]);

  if (!onboardResult.success || !onboardResult.data) {
    return {
      success: false,
      error: onboardResult.error ?? {
        code: 'DB_QUERY_FAILED',
        message: 'cmos_review failed to gather onboarding data',
      },
    };
  }

  const onboard = onboardResult.data;
  const missionStatus =
    missionStatusResult.success && missionStatusResult.data ? missionStatusResult.data : null;

  // s84-m05: build-freshness is a build-tier concern — a general/managed project has no `dist/`
  // to keep fresh, so the "rebuild before working" nudge is noise there. Gate on the
  // already-fetched projectType (no extra query); the probe already ran in the parallel batch
  // above — we simply suppress its result for non-build tiers. The local store defaults to
  // 'build', so it keeps the signal.
  const gatedBuildFreshness = onboard.project.projectType === 'build' ? buildFreshness : null;

  const digest = buildDigest(onboard, missionStatus, gatedBuildFreshness, portfolio);

  // Filter to auth + sync warnings only. Drop staleness/orphan/context-size
  // warnings — those live on the long-form cmos_agent_onboard payload.
  const reviewWarnings = filterReviewWarnings(onboardResult.warnings ?? []);

  return createSuccess(digest, reviewWarnings);
}

/**
 * Assemble the digest from the two bundled handler outputs, applying caps to
 * keep the JSON-serialized payload within the 4KB budget.
 */
function buildDigest(
  onboard: CmosAgentOnboardResult,
  missionStatus: import('./cmos-mission-status').CmosMissionStatusResult | null,
  buildFreshness: BuildFreshnessReport | null,
  portfolio: PortfolioSection | null
): CmosReviewResult {
  const sprintFocus = onboard.currentSprint?.focus
    ? truncate(onboard.currentSprint.focus, SPRINT_FOCUS_CAP_CHARS)
    : null;

  const sprint = onboard.currentSprint
    ? {
        id: onboard.currentSprint.id,
        title: onboard.currentSprint.title,
        status: onboard.currentSprint.status,
        focus: sprintFocus,
        projectId: onboard.currentSprint.projectId ?? null,
      }
    : null;

  // Pull cmos_address from the project_identity row when present; fall back to
  // local-only sentinel so the field is never null/empty (cmos_status uses the
  // same convention — see src/tools/cmos/cmos-status.ts).
  const cmosAddress = normalizeAddress(onboard.projectIdentity?.cmos_address ?? null);

  const project = {
    name: onboard.project.name,
    cmos_address: cmosAddress,
    status: onboard.project.status,
    tier: onboard.project.projectType,
  };

  // Bucket work queue. Prefer cmos_mission_status when available — it gives
  // us proper full buckets per status. Fall back to cmos_agent_onboard's
  // pendingMissions (which mixes In Progress + Current + Queued under a
  // single LIMIT 5 cap) when mission-status fails.
  const workQueue = missionStatus
    ? bucketFromMissionStatus(missionStatus)
    : bucketFromOnboardFallback(onboard);

  // Recent decisions trimmed to compact form. cmos_agent_onboard already
  // ordered by created_at DESC and LIMIT 10 — we slice to 5 and drop domain.
  const recentDecisions = onboard.recentDecisions.slice(0, RECENT_DECISIONS_MAX).map((d) => ({
    text: truncate(d.decision, DECISION_TEXT_CAP_CHARS),
    createdAt: d.createdAt,
    projectId: d.projectId,
  }));

  const freshness = {
    lagDays: onboard.contextFreshness.lagDays ?? 0,
    isStale: onboard.contextFreshness.isStale,
  };

  // Promote top-3 suggestedActions to a flat top-level next_actions array.
  // suggestedActions is already priority-sorted by the onboard handler.
  const promotedActions = onboard.suggestedActions.slice(0, NEXT_ACTIONS_TOP_N).map((a) => ({
    action: a.action,
    command: a.command,
    priority: a.priority,
  }));

  // Insert a priority-1 build-freshness entry above the existing actions when stale.
  // Top-N cap is reapplied so the array still respects NEXT_ACTIONS_TOP_N.
  // Sprint 70 m02: this review surface stays ADVISORY (non-blocking), but the same
  // stale condition is now ENFORCED at cmos_sprint(action='complete') — the wording
  // names that so the two surfaces describe one condition, not two.
  const next_actions = buildFreshness?.stale
    ? [
        {
          action:
            buildFreshness.reason === 'dist-missing'
              ? 'build output missing — run npm run build before starting work (sprint close now blocks on this)'
              : 'build output is behind src/ — rebuild before starting fresh sessions (sprint close now blocks on this)',
          command: 'npm run build',
          priority: 1,
        },
        ...promotedActions,
      ].slice(0, NEXT_ACTIONS_TOP_N)
    : promotedActions;

  // Assemble — digestSizeBytes is computed after the rest of the body is in
  // place so the byte-count reflects the serialized final shape.
  const draft: CmosReviewResult = {
    next_actions,
    project,
    sprint,
    workQueue,
    recentDecisions,
    localProjectId: onboard.localProjectId ?? null,
    portfolio,
    freshness,
    warnings: [],
    digestSizeBytes: 0,
  };

  if (buildFreshness?.stale) {
    draft.buildFreshness = buildFreshness;
  }

  // s80-m07 — surface the self-capture gap via the structured path (NOT the warning
  // string, which filterReviewWarnings drops). The `selfCapture` struct + the
  // formatReviewForLLM line are the GUARANTEED surfaces; the priority-2 action also
  // rides in via onboard.suggestedActions → next_actions when it ranks in the top-3.
  if (onboard.selfCapture?.fires) {
    draft.selfCapture = onboard.selfCapture;
  }

  const trimmed = trimToBudget(draft);

  // Iterative convergence on digestSizeBytes. The field self-reports the size
  // of the serialized JSON, but stamping the number changes the digit width
  // (e.g. "0" → "1945") which itself shifts the byte count. Loop until the
  // stamped value matches the post-stamp serialization length. Converges in
  // ≤3 iterations in practice.
  trimmed.digestSizeBytes = Buffer.byteLength(JSON.stringify(trimmed), 'utf8');
  for (let i = 0; i < 5; i++) {
    const measured = Buffer.byteLength(JSON.stringify(trimmed), 'utf8');
    if (measured === trimmed.digestSizeBytes) break;
    trimmed.digestSizeBytes = measured;
  }

  return trimmed;
}

/**
 * Resolve the project root for the build-freshness probe. Returns null on any
 * resolution failure so the parallel Promise.all keeps the happy path intact —
 * cmos_review never blocks on the freshness check.
 */
async function resolveReviewFreshness(
  explicitRoot: string | undefined
): Promise<BuildFreshnessReport | null> {
  let root = explicitRoot;
  if (!root) {
    try {
      const resolution = await resolveProjectRootEnhanced(undefined, {
        autoRegister: false,
        silent: true,
      });
      root = resolution.projectRoot;
    } catch {
      return null;
    }
  }
  try {
    return await checkBuildFreshness(root);
  } catch {
    return null;
  }
}

/**
 * Record the current project's `last_seen_at` in the per-user project-graph
 * registry (s69-m05), auto-registering it if absent. Pure side-effect — the
 * result never enters the digest. Resolves the project root the same way the
 * freshness probe does (explicit param, else `resolveProjectRootEnhanced` with
 * auto-register off so this read-path never mutates the JSON ProjectRegistry).
 * Swallows every error: registry bookkeeping must never break the session opener.
 */
async function touchProjectGraphRegistry(explicitRoot: string | undefined): Promise<void> {
  // s78-m04: the read-only review role must not mutate ANY store — skip the per-user
  // project-graph last_seen_at write so review mode is side-effect-free everywhere.
  if (isReadOnlyAgentSession()) return;
  try {
    let root = explicitRoot;
    if (!root) {
      const resolution = await resolveProjectRootEnhanced(undefined, {
        autoRegister: false,
        silent: true,
      });
      root = resolution.projectRoot;
    }
    const graph = await ProjectGraphRegistry.create();
    graph.touchOrRegisterFromStore(root);
  } catch {
    // Best-effort — the project-graph registry is an additive discovery index.
  }
}

/**
 * s79-m06 — build the always-on cross-store portfolio section. Discovers stores
 * via the graph registry (injectable for tests) and merges active missions across
 * the portfolio through `activeMissionsAcrossProjects` (§5.4 query b — no new SQL,
 * #671 holds). Graceful degrade: returns null when the registry lists ≤1 active
 * project (a portfolio rollup is meaningless for one project) OR when the whole
 * fan-out throws. Latency-fenced: the single active-missions query only.
 */
/** s80-m06 — return a store file's mtime in Unix ms, or null if it can't be stat'd. */
export type StoreStatFn = (filePath: string) => number | null;

const defaultStoreStatFn: StoreStatFn = (filePath) => {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * s80-m06 — a store's freshness age in days, from the NEWEST of its `cmos.sqlite` +
 * `cmos.sqlite-wal` mtimes (the WAL sidecar advances on every write before checkpoint).
 * Store mtime is the primary signal — the graph registry's `last_seen_at` is inflated
 * by `cmos_review`'s own touch, so it is NOT used here. Returns null when neither file
 * can be stat'd.
 */
/** The newest mtime (Unix ms) across a store's cmos.sqlite + -wal sidecar, or null. */
function storeMtimeMs(storePath: string, statFn: StoreStatFn): number | null {
  const base = path.join(storePath, 'cmos', 'db', 'cmos.sqlite');
  let newest = 0;
  for (const p of [base, `${base}-wal`]) {
    const mtime = statFn(p);
    if (mtime !== null && mtime > newest) newest = mtime;
  }
  return newest === 0 ? null : newest;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function storeAgeDays(storePath: string, statFn: StoreStatFn, nowMs: number): number | null {
  const mtime = storeMtimeMs(storePath, statFn);
  return mtime === null ? null : (nowMs - mtime) / MS_PER_DAY;
}

/** s80-m06 — the strict reachability partition + the drift list. */
export interface DriftPartition {
  reachable: number;
  silent: number;
  unmigrated: number;
  unreadable: number;
  drift: PortfolioDrift | null;
}

/**
 * s80-m06 — classify every queried store into the strict partition and build the
 * per-project drift list, consuming ONLY existing outputs (`registry.list()` +
 * `fanout.errors`) plus `fs.stat` on each store file (#671 holds — no new SQL/opens/
 * network). A store is:
 *   - `unmigrated` — failed with "no such column" (its missions table predates the s79
 *      per-row rebuild) → drift item with a backfill hint;
 *   - `unreadable` — failed otherwise (moved/locked/I/O; classified transient);
 *   - `silent`     — succeeded but its store mtime is > `STALE_THRESHOLD_DAYS` old → drift;
 *   - `reachable`  — succeeded ∧ fresh.
 * By construction `reachable + silent + unmigrated + unreadable === stores.length`.
 * The drift list is capped top-N by `ageDays` desc to bound digest bytes.
 *
 * s81-m03 — additionally OVERLAYS an "unsynced" drift signal: a FRESH (reachable) store
 * whose local mtime is > {@link UNSYNCED_THRESHOLD_DAYS} ahead of its persisted
 * `last_synced_at` (last dashboard-converged push from THIS machine) gets an extra drift
 * ITEM. This is orthogonal to the partition — an unsynced store is still counted
 * `reachable`, so the 4 buckets still sum to `stores.length`. NULL `last_synced_at`
 * (pre-v2 / never-pushed-from-here) = no-signal (never a false positive). Machine-local
 * scope by construction — it flags THIS machine's unpushed work, not another machine's.
 */
export function deriveDrift(
  stores: ReadonlyArray<{
    project_id: string;
    store_path: string;
    name: string;
    last_synced_at?: number | null;
  }>,
  errors: ReadonlyArray<{ projectId: string; error: string }>,
  statFn: StoreStatFn,
  nowMs: number
): DriftPartition {
  const errorById = new Map(errors.map((e) => [e.projectId, e.error]));
  let reachable = 0;
  let silent = 0;
  let unmigrated = 0;
  let unreadable = 0;
  const items: PortfolioDriftItem[] = [];

  for (const store of stores) {
    const name = truncate(store.name, DRIFT_NAME_CAP_CHARS);
    const err = errorById.get(store.project_id);
    if (err !== undefined) {
      if (/no such column/i.test(err)) {
        unmigrated++;
        items.push({
          projectId: store.project_id,
          name,
          reason: 'un-migrated (missions table predates the per-row rebuild)',
          ageDays: Math.round(storeAgeDays(store.store_path, statFn, nowMs) ?? 0),
          hint: 'run cmos_db backfill/rebuild',
        });
      } else {
        // moved / locked / I/O / unknown → transient, classified defensively.
        unreadable++;
      }
      continue;
    }
    // Succeeded — freshness by store mtime.
    const mtimeMs = storeMtimeMs(store.store_path, statFn);
    const age = mtimeMs === null ? null : (nowMs - mtimeMs) / MS_PER_DAY;
    if (age !== null && age > STALE_THRESHOLD_DAYS) {
      silent++;
      items.push({
        projectId: store.project_id,
        name,
        reason: `no CMOS write in ${Math.round(age)}d`,
        ageDays: Math.round(age),
      });
    } else {
      reachable++;
      // s81-m03: "unsynced" overlay — a FRESH store with local work newer than its last
      // dashboard-converged push (from THIS machine) by more than the threshold. Extra
      // drift ITEM only; the store stays counted `reachable` (partition sum unchanged).
      // NULL last_synced_at = no-signal (never-pushed-from-here); no false positive.
      const lastSynced = store.last_synced_at ?? null;
      if (lastSynced !== null && mtimeMs !== null) {
        const unsyncedDays = (mtimeMs - lastSynced) / MS_PER_DAY;
        if (unsyncedDays > UNSYNCED_THRESHOLD_DAYS) {
          items.push({
            projectId: store.project_id,
            name,
            reason: `local ahead of dashboard by ${Math.round(unsyncedDays)}d (unsynced; this machine)`,
            ageDays: Math.round(unsyncedDays),
          });
        }
      }
    }
  }

  items.sort((a, b) => b.ageDays - a.ageDays);
  const drift: PortfolioDrift | null = items.length
    ? { staleThresholdDays: STALE_THRESHOLD_DAYS, stale: items.slice(0, DRIFT_TOP_N) }
    : null;
  return { reachable, silent, unmigrated, unreadable, drift };
}

async function buildPortfolioSection(
  registryOverride?: ProjectGraphRegistry,
  statFn: StoreStatFn = defaultStoreStatFn,
  nowMs: number = Date.now()
): Promise<PortfolioSection | null> {
  try {
    const registry = registryOverride ?? (await ProjectGraphRegistry.create());
    const stores = registry.list();
    if (stores.length <= 1) return null; // single-project → degrade

    const fanout = await activeMissionsAcrossProjects({
      limit: PORTFOLIO_FETCH_LIMIT,
      registry,
    });
    const meta = fanout.metadata;
    // s80-m06: strict partition + drift over the SAME store set the fan-out queried.
    const partition = deriveDrift(stores, fanout.errors, statFn, nowMs);
    return {
      projects: stores.length,
      reachable: partition.reachable,
      silent: partition.silent,
      unmigrated: partition.unmigrated,
      unreadable: partition.unreadable,
      activeMissions: {
        count: fanout.results.length,
        top: fanout.results.slice(0, PORTFOLIO_TOP_N).map((m) => ({
          id: m.id,
          name: truncate(m.name, PORTFOLIO_MISSION_NAME_CAP_CHARS),
          projectId: m.project_id,
        })),
      },
      fanInP95Ms: Math.round(meta.perStoreP95Ms ?? meta.overallMs),
      drift: partition.drift,
    };
  } catch {
    return null; // fan-out failed → degrade, never break the opener
  }
}

/**
 * Trim the digest in stages until it fits the 4KB budget (s79-m06 F9 order). The
 * NEW cross-store portfolio signal is the point of this digest, so it is trimmed
 * LAST: recentDecisions → sprint.focus → warnings → workQueue tops →
 * portfolio.activeMissions.top (5→3→0) → portfolio=null. Everything cheaper and
 * more local is sacrificed before the portfolio rollup degrades.
 */
function trimToBudget(digest: CmosReviewResult): CmosReviewResult {
  const measure = (d: CmosReviewResult): number => Buffer.byteLength(JSON.stringify(d), 'utf8');

  let current = digest;
  let size = measure(current);

  // Stage 1: drop recentDecisions one at a time (largest existing field).
  while (size > DIGEST_BUDGET_BYTES && current.recentDecisions.length > 0) {
    current = { ...current, recentDecisions: current.recentDecisions.slice(0, -1) };
    size = measure(current);
  }

  // Stage 2: re-truncate sprint.focus to a tighter cap.
  if (
    size > DIGEST_BUDGET_BYTES &&
    current.sprint?.focus &&
    current.sprint.focus.length > SPRINT_FOCUS_TRIM_CAP_CHARS
  ) {
    current = {
      ...current,
      sprint: {
        ...current.sprint,
        focus: truncate(current.sprint.focus, SPRINT_FOCUS_TRIM_CAP_CHARS),
      },
    };
    size = measure(current);
  }

  // Stage 3: drop warnings.
  while (size > DIGEST_BUDGET_BYTES && current.warnings.length > 0) {
    current = { ...current, warnings: current.warnings.slice(0, -1) };
    size = measure(current);
  }

  // Stage 4: trim work-queue top arrays.
  while (
    size > DIGEST_BUDGET_BYTES &&
    (current.workQueue.inProgress.top.length > 0 ||
      current.workQueue.current.top.length > 0 ||
      current.workQueue.queued.top.length > 0)
  ) {
    current = {
      ...current,
      workQueue: {
        ...current.workQueue,
        inProgress: {
          ...current.workQueue.inProgress,
          top: current.workQueue.inProgress.top.slice(0, -1),
        },
        current: {
          ...current.workQueue.current,
          top: current.workQueue.current.top.slice(0, -1),
        },
        queued: {
          ...current.workQueue.queued,
          top: current.workQueue.queued.top.slice(0, -1),
        },
      },
    };
    size = measure(current);
  }

  // Stage 5: shrink portfolio.activeMissions.top (5→3→0), one at a time.
  while (
    size > DIGEST_BUDGET_BYTES &&
    current.portfolio &&
    current.portfolio.activeMissions.top.length > 0
  ) {
    current = {
      ...current,
      portfolio: {
        ...current.portfolio,
        activeMissions: {
          ...current.portfolio.activeMissions,
          top: current.portfolio.activeMissions.top.slice(0, -1),
        },
      },
    };
    size = measure(current);
  }

  // Stage 5b (s80-m06): shrink portfolio.drift.stale one at a time before dropping the
  // whole portfolio — the drift list is capped but still yields under extreme pressure.
  while (
    size > DIGEST_BUDGET_BYTES &&
    current.portfolio?.drift &&
    current.portfolio.drift.stale.length > 0
  ) {
    const stale = current.portfolio.drift.stale.slice(0, -1);
    current = {
      ...current,
      portfolio: {
        ...current.portfolio,
        drift: stale.length ? { ...current.portfolio.drift, stale } : null,
      },
    };
    size = measure(current);
  }

  // Stage 6 (last resort): drop the whole portfolio section.
  if (size > DIGEST_BUDGET_BYTES && current.portfolio) {
    current = { ...current, portfolio: null };
    size = measure(current);
  }

  return current;
}

function bucketFromMissionStatus(
  status: import('./cmos-mission-status').CmosMissionStatusResult
): CmosReviewResult['workQueue'] {
  return {
    inProgress: {
      count: status.inProgress.length,
      top: status.inProgress.slice(0, WORK_QUEUE_TOP_N).map(toWorkItem),
    },
    current: {
      count: status.current.length,
      top: status.current.slice(0, WORK_QUEUE_TOP_N).map(toWorkItem),
    },
    queued: {
      count: status.queued.length,
      top: status.queued.slice(0, WORK_QUEUE_TOP_N).map(toWorkItem),
    },
    blocked: { count: status.blocked?.length ?? 0 },
    nextAction: status.summary.nextAction,
  };
}

function bucketFromOnboardFallback(onboard: CmosAgentOnboardResult): CmosReviewResult['workQueue'] {
  const byStatus = {
    'In Progress': [] as WorkItem[],
    Current: [] as WorkItem[],
    Queued: [] as WorkItem[],
  };
  for (const m of onboard.pendingMissions) {
    if (m.status === 'In Progress' || m.status === 'Current' || m.status === 'Queued') {
      byStatus[m.status].push(toWorkItemFromOnboard(m));
    }
  }
  return {
    inProgress: {
      count: byStatus['In Progress'].length,
      top: byStatus['In Progress'].slice(0, WORK_QUEUE_TOP_N),
    },
    current: { count: byStatus.Current.length, top: byStatus.Current.slice(0, WORK_QUEUE_TOP_N) },
    queued: { count: byStatus.Queued.length, top: byStatus.Queued.slice(0, WORK_QUEUE_TOP_N) },
    blocked: { count: onboard.blockedMissions.length },
    nextAction:
      byStatus['In Progress'].length > 0
        ? `Continue working on ${byStatus['In Progress'][0].id}`
        : byStatus.Current.length > 0
          ? `Start the current mission: ${byStatus.Current[0].id}`
          : byStatus.Queued.length > 0
            ? `Promote and start ${byStatus.Queued[0].id}`
            : 'No missions in queue. Add new missions to continue work.',
  };
}

function toWorkItem(m: StatusMissionItem): WorkItem {
  return {
    id: m.id,
    name: truncate(m.name, WORK_ITEM_NAME_CAP_CHARS),
    projectId: m.projectId ?? null,
  };
}

function toWorkItemFromOnboard(m: {
  id: string;
  name: string;
  projectId?: string | null;
}): WorkItem {
  return {
    id: m.id,
    name: truncate(m.name, WORK_ITEM_NAME_CAP_CHARS),
    projectId: m.projectId ?? null,
  };
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + '…';
}

/**
 * Normalize cmos:// address. Mirrors the local-only sentinel logic that
 * cmos_status uses so support-side and review-side agree on the field shape.
 */
function normalizeAddress(raw: string | null): string {
  if (!raw) return 'local-only';
  const trimmed = raw.trim();
  if (!trimmed) return 'local-only';
  if (trimmed.startsWith('cmos://unknown/')) return 'local-only';
  return trimmed;
}

/**
 * Keep only the high-signal warnings (auth, sync, attribution). Staleness,
 * orphan, and context-size warnings are valuable but heavy — they live on the
 * unchanged cmos_agent_onboard payload for callers that need them.
 */
function filterReviewWarnings(warnings: string[]): string[] {
  const interesting = warnings.filter((w) => {
    const lower = w.toLowerCase();
    return (
      lower.includes('auth') ||
      lower.includes('sync') ||
      lower.includes('cmos_auth') ||
      lower.includes('credential') ||
      lower.includes('attribution') ||
      lower.includes('whoami')
    );
  });
  // Cap to 3 warnings so a single noisy condition can't blow the budget.
  return interesting.slice(0, 3);
}

/**
 * Render the review digest as a short human-readable string for the MCP
 * `content` text field.
 */
export function formatReviewForLLM(result: CmosToolResult<CmosReviewResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['cmos_review failed', `Error: ${error?.message ?? 'unknown error'}`];
    if (error?.suggestion) {
      lines.push(`Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const d = result.data;
  const lines: string[] = [];
  // s84-m03: fence foreign (pull-merged) sprint/mission text INLINE — the digest is
  // budget-capped (≤4096 bytes), so only compact inline framing is used here. A
  // local/NULL-project row renders byte-identical to 2.3.0.
  const local = d.localProjectId;
  lines.push(`**${d.project.name}** (${d.project.tier}) — ${d.project.cmos_address}`);
  if (d.sprint) {
    const title = frameInlineIfForeign(d.sprint.title, d.sprint.projectId, local);
    lines.push(`Sprint ${d.sprint.id}: ${title} [${d.sprint.status ?? '—'}]`);
    if (d.sprint.focus)
      lines.push(`  ${frameInlineIfForeign(d.sprint.focus, d.sprint.projectId, local)}`);
  }
  lines.push('');
  lines.push(
    `Work queue — InProgress:${d.workQueue.inProgress.count} Current:${d.workQueue.current.count} Queued:${d.workQueue.queued.count} Blocked:${d.workQueue.blocked.count}`
  );
  // s84-m03 (FORK-5): the mission-status nextAction embeds `<id>: <FULL name>` of the
  // referenced work-queue mission (determineNextAction; the name is the UNTRUNCATED source,
  // not the byte-capped WorkItem.name). When that mission is FOREIGN, render id-only — cut
  // the `: <name>` tail at the `<id>: ` marker so the foreign name never lands unfenced in
  // the ≤4KB digest. Matching the marker (not the name) is truncation-independent — a name
  // longer than the WorkItem cap would otherwise slip past a name-based match and leak.
  // Local rows leave nextAction byte-identical (no marker cut).
  const refItem =
    d.workQueue.inProgress.top[0] ?? d.workQueue.current.top[0] ?? d.workQueue.queued.top[0];
  let nextAction = d.workQueue.nextAction;
  if (refItem && isForeignProject(refItem.projectId, local)) {
    const marker = `${refItem.id}: `;
    const idx = nextAction.indexOf(marker);
    // The name always sits at the END of the recommendation (see determineNextAction), so
    // slicing from the marker and re-appending the bare id yields the id-only form. Formats
    // with no `<id>: <name>` segment (e.g. the multi-in-progress "Continue with <id> …",
    // which carries no name) simply don't match → left unchanged.
    if (idx !== -1) nextAction = nextAction.slice(0, idx) + refItem.id;
  }
  lines.push(`Next: ${nextAction}`);

  if (d.next_actions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of d.next_actions) {
      lines.push(`  [${a.priority}] ${a.action} → ${a.command}`);
    }
  }

  if (d.recentDecisions.length > 0) {
    lines.push('');
    lines.push('Recent decisions:');
    // s83-m06: frame a pull-merged FOREIGN decision (project_id != local) inside the
    // compact untrusted marker; render is text-only so the ≤4KB digestSizeBytes budget
    // is unaffected. Local rows stay bare.
    const localProjectId = d.localProjectId ?? null;
    for (const dec of d.recentDecisions) {
      const isForeign =
        dec.projectId != null && (localProjectId == null || dec.projectId !== localProjectId);
      lines.push(
        `  • ${isForeign ? frameForeignInline(dec.text, `proj:${dec.projectId}`) : dec.text}`
      );
    }
  }

  if (d.portfolio) {
    const p = d.portfolio;
    lines.push('');
    // s80-m06: strict partition — reachable + silent + unmigrated + unreadable === projects.
    const parts = [`${p.reachable} reachable`];
    if (p.silent > 0) parts.push(`${p.silent} silent`);
    if (p.unmigrated > 0) parts.push(`${p.unmigrated} un-migrated`);
    if (p.unreadable > 0) parts.push(`${p.unreadable} unreadable`);
    lines.push(
      `🌐 Portfolio — ${p.activeMissions.count} active mission(s) across ${p.projects} store(s): ` +
        `${parts.join(', ')} · fan-in p95 ${p.fanInP95Ms}ms`
    );
    // s84-m03 (#485): a portfolio mission from another project is FOREIGN — frame its
    // name inline (the [proj:X] tag is metadata, not a trust boundary). The local
    // project's own rows stay bare. Closes the s83-m06 deferral (SECURITY.md updated).
    for (const m of p.activeMissions.top) {
      const name = frameInlineIfForeign(m.name, m.projectId, local);
      lines.push(`  📋 ${m.id} — ${name} [proj:${m.projectId}]`);
    }
    if (p.drift && p.drift.stale.length > 0) {
      lines.push(`  ⚠ drift (>${p.drift.staleThresholdDays}d): ${p.drift.stale.length} project(s)`);
      for (const s of p.drift.stale) {
        lines.push(`    · ${s.name} — ${s.reason}${s.hint ? ` (${s.hint})` : ''}`);
      }
    }
  }

  // s80-m07 — self-capture advisory (present only when it fires). Rendered here, not
  // via d.warnings, because filterReviewWarnings drops non-auth/sync warnings.
  if (d.selfCapture?.fires) {
    lines.push('');
    lines.push(
      `📝 Self-capture: local commits are ~${Math.round(d.selfCapture.gapDays)}d ahead of the last ` +
        `CMOS write — capture recent work (cmos_session action="capture")`
    );
  }

  if (d.warnings.length > 0) {
    lines.push('');
    for (const w of d.warnings) lines.push(`⚠ ${w}`);
  }

  lines.push('');
  lines.push(`Digest size: ${d.digestSizeBytes} bytes (budget 4096)`);
  return lines.join('\n');
}
