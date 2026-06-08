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
 * existing handlers and shapes their output — it does NOT introduce new SQL
 * queries of its own. cmos_agent_onboard and cmos_context_view themselves
 * stay unchanged for back-compat; this tool is purely additive.
 *
 * Cross-project exclusion (decision #672): the registry-aware cross-project
 * status was built for a different operating model where one CMOS aggregates
 * across all projects. The current model is one CMOS per project with
 * explicit cross-project messaging via cmos_message, so cmos_review is
 * project-scoped by design and does NOT walk the project registry.
 *
 * @module tools/cmos/cmos-review
 */

import { z } from 'zod';
import type { CmosToolResult } from './types';
import { createSuccess } from './errors';
import { cmosAgentOnboard, type CmosAgentOnboardResult } from './cmos-agent-onboard';
import { cmosMissionStatus, type StatusMissionItem } from './cmos-mission-status';
import { checkBuildFreshness, type BuildFreshnessReport } from './build-freshness';
import { resolveProjectRootEnhanced } from '../../intelligence/project-registry';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';

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
}

/**
 * Per-bucket work queue summary.
 */
export interface WorkQueueBucket {
  count: number;
  top: WorkItem[];
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
  } | null;

  /** Project-only work queue. Cross-project status is explicitly excluded. */
  workQueue: {
    inProgress: WorkQueueBucket;
    current: WorkQueueBucket;
    queued: WorkQueueBucket;
    blocked: { count: number };
    nextAction: string;
  };

  /** Up to 5 most recent decisions in compact {text, createdAt} form. */
  recentDecisions: Array<{ text: string; createdAt: string }>;

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
    'Bundled session-opener digest (≤4KB). Replaces the cmos_agent_onboard + cmos_context_view + cmos_mission_status opener with one project-scoped payload. Top-3 next_actions are promoted to a flat top-level field. Does NOT walk the project registry — use cmos_message for cross-project workflows.',
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

/**
 * Execute cmos_review.
 *
 * Calls cmos_agent_onboard and cmos_mission_status in parallel (both already
 * exist with their own SQL), then shapes the bundled output into a digest.
 * No new database queries are added by this tool.
 */
export async function cmosReview(
  params: CmosReviewParams = {}
): Promise<CmosToolResult<CmosReviewResult>> {
  const projectRoot = params.projectRoot;

  const [onboardResult, missionStatusResult, buildFreshness] = await Promise.all([
    cmosAgentOnboard(projectRoot ? { projectRoot } : {}),
    cmosMissionStatus(
      projectRoot ? { projectRoot, includeBlocked: true } : { includeBlocked: true }
    ),
    resolveReviewFreshness(projectRoot),
    // s69-m05 — record this project's last_seen_at in the per-user project-graph
    // registry (auto-registering it if absent). This is a write SIDE-EFFECT only:
    // it does NOT add cross-project data to the digest, so decision #672 still
    // holds — the payload stays strictly project-scoped. Never throws, never
    // blocks the opener (runs in the same parallel batch; result discarded).
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

  const digest = buildDigest(onboard, missionStatus, buildFreshness);

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
  buildFreshness: BuildFreshnessReport | null
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
              ? 'dist/ missing — run npm run build before starting work (sprint close now blocks on this)'
              : 'dist/ is behind src/ — rebuild before starting fresh sessions (sprint close now blocks on this)',
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
    freshness,
    warnings: [],
    digestSizeBytes: 0,
  };

  if (buildFreshness?.stale) {
    draft.buildFreshness = buildFreshness;
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
 * Trim the digest in stages until it fits the 4KB budget. Order of stages is
 * chosen so we preserve the most decision-relevant signal: cut decision
 * volume first, then per-decision text, then work-queue entry counts.
 */
function trimToBudget(digest: CmosReviewResult): CmosReviewResult {
  const measure = (d: CmosReviewResult): number => Buffer.byteLength(JSON.stringify(d), 'utf8');

  // The body is already capped at the top of buildDigest. Run a defensive
  // shrink loop in case real-world payloads slip over the limit — trim
  // decisions and warnings before touching anything else.
  let current = digest;
  let size = measure(current);

  // Stage 1: drop recentDecisions one at a time until under budget.
  while (size > DIGEST_BUDGET_BYTES && current.recentDecisions.length > 0) {
    current = { ...current, recentDecisions: current.recentDecisions.slice(0, -1) };
    size = measure(current);
  }

  // Stage 2: drop warnings.
  while (size > DIGEST_BUDGET_BYTES && current.warnings.length > 0) {
    current = { ...current, warnings: current.warnings.slice(0, -1) };
    size = measure(current);
  }

  // Stage 3: trim work-queue top arrays.
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
  return { id: m.id, name: truncate(m.name, WORK_ITEM_NAME_CAP_CHARS) };
}

function toWorkItemFromOnboard(m: { id: string; name: string }): WorkItem {
  return { id: m.id, name: truncate(m.name, WORK_ITEM_NAME_CAP_CHARS) };
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
  lines.push(`**${d.project.name}** (${d.project.tier}) — ${d.project.cmos_address}`);
  if (d.sprint) {
    lines.push(`Sprint ${d.sprint.id}: ${d.sprint.title} [${d.sprint.status ?? '—'}]`);
    if (d.sprint.focus) lines.push(`  ${d.sprint.focus}`);
  }
  lines.push('');
  lines.push(
    `Work queue — InProgress:${d.workQueue.inProgress.count} Current:${d.workQueue.current.count} Queued:${d.workQueue.queued.count} Blocked:${d.workQueue.blocked.count}`
  );
  lines.push(`Next: ${d.workQueue.nextAction}`);

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
    for (const dec of d.recentDecisions) {
      lines.push(`  • ${dec.text}`);
    }
  }

  if (d.warnings.length > 0) {
    lines.push('');
    for (const w of d.warnings) lines.push(`⚠ ${w}`);
  }

  lines.push('');
  lines.push(`Digest size: ${d.digestSizeBytes} bytes (budget 4096)`);
  return lines.join('\n');
}
