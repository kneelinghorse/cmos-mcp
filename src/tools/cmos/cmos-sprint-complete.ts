/**
 * cmos_sprint_complete Tool
 *
 * MCP tool for closing out a sprint in one operation. It validates readiness,
 * snapshots both contexts, clears stale sprint-linked next steps, optionally
 * runs condensation, and returns a closeout receipt with size telemetry.
 *
 * @module tools/cmos/cmos-sprint-complete
 */

import * as crypto from 'crypto';
import { z } from 'zod';
import { withClientAsync, type CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult, Context, Sprint } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import {
  calculateContextSizeMetrics,
  resolveContextSizeSettings,
  type ContextSizeMetrics,
} from './context-retention';
import { cmosContextCondense } from './cmos-context-condense';
import { cmosDbSnapshot } from './cmos-db-snapshot';
import { getProjectType } from './cmos-agent-onboard';
import {
  ensureArchivalColumns,
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
  snapshotDedupPrunedFilter,
} from './schema-migrations';
import {
  checkBuildFreshness,
  isBlockingStaleness,
  type BuildFreshnessReport,
} from './build-freshness';
import { getServerHealth, getServerProjectRoot } from '../../server-health';
import { resolveProjectRootEnhanced } from '../../intelligence/project-resolution';
import * as path from 'path';

type CloseoutContextType = 'master_context' | 'project_context';
type CloseoutCondensationStrategy = 'none' | 'conservative' | 'auto' | 'aggressive';

interface SprintMissionRow {
  id: string;
  status: string;
  notes: string | null;
}

interface SprintMissionKpiRow {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Sprint summary KPIs computed during closeout.
 */
export interface SprintKPIs {
  completionRate: number;
  avgCycleTimeDays: number | null;
  decisionCount: number;
  learningCount: number;
  blockedCount: number;
}

/**
 * Lifecycle trigger results from sprint completion.
 */
export interface SprintLifecycleTriggers {
  decisionsArchived: number;
  learningsArchived: number;
  kpis: SprintKPIs;
  dbSnapshotId: string | null;
}

interface LoadedCloseoutContext {
  contextType: CloseoutContextType;
  rawContent: string;
  parsedContent: Record<string, unknown>;
  beforeSize: ContextSizeMetrics;
}

/**
 * Sprint readiness summary used in the closeout receipt.
 */
export interface SprintCloseoutReadiness {
  totalMissions: number;
  completedMissions: number;
  blockedMissions: number;
  skippedMissions: number;
  openMissions: number;
  completedMissionIds: string[];
  blockedMissionIds: string[];
  skippedMissionIds: string[];
  openMissionIds: string[];
}

/**
 * Per-context closeout details.
 */
export interface SprintCloseoutContextResult {
  snapshotId: number | null;
  beforeSize: ContextSizeMetrics;
  afterSize: ContextSizeMetrics;
  nextStepsCleared: number;
  condensation?: {
    strategy: Exclude<CloseoutCondensationStrategy, 'none'>;
    snapshotId: number | null;
    reductionPercent: number;
    targetMet: boolean;
    message: string;
  };
}

/**
 * Result returned by cmos_sprint_complete.
 */
export interface CmosSprintCompleteResult {
  sprintId: string;
  previousStatus: string | null;
  currentStatus: 'Completed';
  summary: string;
  completedAt: string;
  readiness: SprintCloseoutReadiness;
  contexts: {
    masterContext: SprintCloseoutContextResult;
    projectContext: SprintCloseoutContextResult;
    totalBeforeSizeKb: number;
    totalAfterSizeKb: number;
  };
  lifecycle: SprintLifecycleTriggers;
  /** s81-m06 — reconciliation of the next_steps TABLE at close (distinct from the
   *  per-context JSON-array `nextStepsCleared` above, which the closeout already did).
   *  AUTO-completes ONLY the machine-certain subset (pending rows whose `mission_id` is a
   *  Completed, non-blocked mission of the closing sprint); CARRIES blocked-linked rows;
   *  and FLAGS the sprint-linked remainder for the operator — it NEVER auto-closes on a
   *  "did it ship" guess (that recreates the silent-wrong-state debt learning #433 names). */
  nextStepsReconciled: number;
  /** Pending sprint-linked rows carried because their `mission_id` is a Blocked mission. */
  nextStepsCarried: number;
  /** Sprint-linked pending rows NOT machine-certain (mission_id NULL, or a mission not
   *  Completed/Blocked in this sprint) — surfaced for the operator to resolve by hand. */
  pendingFlagged: Array<{ id: number; content: string; missionId: string | null }>;
  /** Build-freshness report, included ONLY when stale=true (omitted on the happy path
   *  to keep the response shape unchanged for fresh-build sprints). */
  buildFreshness?: BuildFreshnessReport;
  message: string;
}

/**
 * s84-m04 — context_snapshots growth thresholds for the non-blocking sprint-close advisory.
 * Either the row count OR the total content bytes crossing its threshold fires the nudge toward
 * `npm run prune:snapshots`. Advisory-only — never gates the close.
 */
const SNAPSHOT_GROWTH_ROW_THRESHOLD = 500;
const SNAPSHOT_GROWTH_BYTE_THRESHOLD = 20 * 1024 * 1024; // 20 MB

/**
 * Input parameters schema for cmos_sprint_complete.
 */
export const cmosSprintCompleteSchema = z.object({
  sprintId: z.string().min(1).describe('The sprint ID to close out (e.g., "sprint-22")'),
  summary: z
    .string()
    .min(1)
    .max(2000)
    .describe('Short closeout summary describing what the sprint delivered'),
  condensation: z
    .enum(['none', 'conservative', 'auto', 'aggressive'])
    .default('none')
    .optional()
    .describe(
      'Optional context condensation strategy to run after snapshots and next-step cleanup'
    ),
  targetSizePercent: z
    .number()
    .min(1)
    .max(100)
    .default(60)
    .optional()
    .describe('Target percentage of the context size limit when condensation is requested'),
  forceComplete: z
    .boolean()
    .optional()
    .describe(
      'No-op, kept for backward compatibility. Build-freshness is advisory as of the s74 review — staleness is surfaced as a warning and never blocks closeout, so no override is needed.'
    ),
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSprintCompleteParams = z.infer<typeof cmosSprintCompleteSchema>;

/**
 * MCP Tool Definition for cmos_sprint_complete.
 */
export const cmosSprintCompleteToolDefinition = {
  name: 'cmos_sprint_complete',
  description:
    'Close out a sprint in one operation. Validates sprint readiness, marks the sprint Completed with endDate, snapshots both contexts, clears stale sprint-linked next steps, and optionally runs context condensation.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'The sprint ID to close out (e.g., "sprint-22")',
      },
      summary: {
        type: 'string',
        description: 'Short closeout summary describing what the sprint delivered',
        minLength: 1,
        maxLength: 2000,
      },
      condensation: {
        type: 'string',
        enum: ['none', 'conservative', 'auto', 'aggressive'],
        default: 'none',
        description:
          'Optional context condensation strategy to run after snapshots and next-step cleanup',
      },
      targetSizePercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 60,
        description: 'Target percentage of the context size limit when condensation is requested',
      },
      forceComplete: {
        type: 'boolean',
        description:
          'No-op, kept for backward compatibility. Build-freshness is advisory — staleness is surfaced as a warning and never blocks closeout.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['sprintId', 'summary'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_sprint_complete tool.
 */
export async function cmosSprintComplete(
  params: CmosSprintCompleteParams
): Promise<CmosToolResult<CmosSprintCompleteResult>> {
  if (!params.sprintId || params.sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  if (!params.summary || params.summary.trim() === '') {
    return createError(CmosErrors.missingParameter('summary'));
  }

  const sprintId = params.sprintId.trim();
  const summary = params.summary.trim();
  const condensation = params.condensation ?? 'none';
  const targetSizePercent = params.targetSizePercent ?? 60;

  return withClientAsync(
    async (client) => {
      const warnings: string[] = [];

      // Build-freshness is ADVISORY, not blocking (post-s74 review). It used to be
      // an ENFORCED gate here (s70-m02) that blocked closeout with BUILD_STALE
      // unless forceComplete. Two problems retired it: (1) the signals (src-mtime
      // vs build, server-hash drift) are noisy heuristics that over-fire on git
      // ops and non-runtime edits; (2) the server-stale signal is cross-project
      // LEAKY — getServerHealth() tracks THIS server's own build (cmos-mcp-pro),
      // so a rebuild here flipped every sibling project's close to "stale" and
      // forced forceComplete. Staleness is now surfaced as a warning after the
      // work completes (see the advisory block near the end), never as a block.

      // s69-m03 — sprint closeout wraps its work in a manual BEGIN IMMEDIATE
      // transaction below, and later snapshots genesis rows (genesisColumns). The
      // firehose 12-step migration toggles foreign_keys (a no-op inside a
      // transaction), so it MUST run here, before BEGIN, not lazily mid-closeout.
      // Idempotent + marker-gated: a fast no-op on already-migrated stores.
      ensureFirehoseEventColumns(client);
      // s69-m04 — settle the author_* namespace before BEGIN too. Its ALTERs are
      // transaction-safe (no 12-step rebuild), but ensuring it pre-BEGIN keeps the
      // rename out of the closeout transaction and mirrors the firehose pattern.
      ensureAuthorNamespaceColumns(client);
      const beginResult = client.execute('BEGIN IMMEDIATE', []);

      if (!beginResult.success) {
        return createError<CmosSprintCompleteResult>(
          beginResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to begin sprint closeout for '${sprintId}'`,
            suggestion: 'Retry once the database becomes available.',
          }
        );
      }

      let transactionOpen = true;
      const rollback = (): void => {
        if (!transactionOpen) {
          return;
        }
        client.execute('ROLLBACK', []);
        transactionOpen = false;
      };
      const fail = (error: Parameters<typeof createError<CmosSprintCompleteResult>>[0]) => {
        rollback();
        return createError<CmosSprintCompleteResult>(error);
      };

      const sprintResult = client.getOne<Sprint>(
        'SELECT id, title, focus, status, start_date, end_date, total_missions, completed_missions FROM sprints WHERE id = ?',
        [sprintId]
      );
      if (!sprintResult.success) {
        return fail(
          sprintResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to query sprint '${sprintId}'`,
            suggestion: 'Check database connectivity and schema.',
          }
        );
      }
      if (!sprintResult.data) {
        return fail(CmosErrors.sprintNotFound(sprintId));
      }

      const sprint = sprintResult.data;
      if (sprint.status === 'Completed') {
        return fail({
          code: CMOS_ERROR_CODES.SPRINT_ALREADY_COMPLETED,
          message: `Sprint '${sprintId}' is already Completed`,
          currentState: sprint.status,
          suggestion:
            'Use cmos_sprint with action="show" to review the closed sprint. No further closeout is needed.',
        });
      }

      const missionsResult = client.getMany<SprintMissionRow>(
        'SELECT id, status, notes FROM missions WHERE sprint_id = ? ORDER BY id ASC',
        [sprintId]
      );
      if (!missionsResult.success) {
        return fail(
          missionsResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to query missions for sprint '${sprintId}'`,
            suggestion: 'Check database connectivity and schema.',
          }
        );
      }

      const readiness = summarizeSprintReadiness(missionsResult.data ?? []);
      if (readiness.openMissionIds.length > 0) {
        return fail({
          code: CMOS_ERROR_CODES.SPRINT_NOT_READY,
          message: `Sprint '${sprintId}' still has non-terminal missions: ${readiness.openMissionIds.join(', ')}`,
          currentState: sprint.status ?? undefined,
          suggestion:
            'Complete, block, drop, or defer the remaining Queued/Current/In Progress missions before closing the sprint.',
        });
      }
      if (readiness.blockedMissionIds.length > 0) {
        warnings.push(
          `Sprint '${sprintId}' closed with blocked missions: ${readiness.blockedMissionIds.join(', ')}.`
        );
      }
      if (readiness.skippedMissionIds.length > 0) {
        warnings.push(
          `Sprint '${sprintId}' includes skipped missions recorded in notes: ${readiness.skippedMissionIds.join(', ')}.`
        );
      }

      const masterContext = loadCloseoutContext(client, 'master_context');
      if (!masterContext.success || !masterContext.data) {
        return fail(
          masterContext.error ?? {
            code: CMOS_ERROR_CODES.CONTEXT_NOT_FOUND,
            message: 'master_context is required for sprint closeout',
            suggestion: 'Repair or recreate master_context before retrying sprint closeout.',
          }
        );
      }

      const projectContext = loadCloseoutContext(client, 'project_context');
      if (!projectContext.success || !projectContext.data) {
        return fail(
          projectContext.error ?? {
            code: CMOS_ERROR_CODES.CONTEXT_NOT_FOUND,
            message: 'project_context is required for sprint closeout',
            suggestion: 'Repair or recreate project_context before retrying sprint closeout.',
          }
        );
      }

      const completedAt = new Date().toISOString();
      const snapshotSource = `sprint_complete:${sprintId}`;
      const masterSnapshotId = createSnapshot(
        client,
        'master_context',
        masterContext.data.rawContent,
        snapshotSource
      );
      if (!masterSnapshotId.success) {
        return fail({
          code: CMOS_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
          message: `Failed to snapshot master_context for sprint '${sprintId}'`,
          suggestion: 'Check context_snapshots table integrity and retry closeout.',
        });
      }

      const projectSnapshotId = createSnapshot(
        client,
        'project_context',
        projectContext.data.rawContent,
        snapshotSource
      );
      if (!projectSnapshotId.success) {
        return fail({
          code: CMOS_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
          message: `Failed to snapshot project_context for sprint '${sprintId}'`,
          suggestion: 'Check context_snapshots table integrity and retry closeout.',
        });
      }

      const masterCleared = clearSprintLinkedNextSteps(
        masterContext.data.parsedContent,
        sprintId,
        readiness.completedMissionIds,
        readiness.blockedMissionIds
      );
      const projectCleared = clearSprintLinkedNextSteps(
        projectContext.data.parsedContent,
        sprintId,
        readiness.completedMissionIds,
        readiness.blockedMissionIds
      );

      // s81-m06: reconcile the next_steps TABLE (distinct from the JSON arrays above),
      // inside this same txn. Auto-complete only the mission-FK-certain subset; flag the
      // rest for the operator. Never auto-close on a guess.
      const nextStepsTable = reconcileSprintNextStepsTable(
        client,
        sprintId,
        readiness.completedMissionIds,
        readiness.blockedMissionIds,
        completedAt
      );

      // --- Lifecycle Trigger: Archive sprint-scoped decisions/learnings ---
      const archiveResult = archiveSprintDecisionsAndLearnings(client, sprintId);
      if (!archiveResult.success) {
        warnings.push(
          `Decision/learning archival partially failed: ${archiveResult.error ?? 'unknown'}`
        );
      }

      // --- Lifecycle Trigger: Compute sprint KPIs ---
      const kpis = computeSprintKPIs(client, sprintId, readiness);

      // --- Lifecycle Trigger: Update project_context working_memory & current_sprint ---
      clearProjectContextWorkingMemory(projectContext.data.parsedContent, sprintId);

      const masterPersist = persistCloseoutContext(client, masterContext.data, completedAt);
      if (!masterPersist.success || !masterPersist.data) {
        return fail(
          masterPersist.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to persist master_context sprint cleanup',
            suggestion: 'Check database permissions and retry closeout.',
          }
        );
      }

      const projectPersist = persistCloseoutContext(client, projectContext.data, completedAt);
      if (!projectPersist.success || !projectPersist.data) {
        return fail(
          projectPersist.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to persist project_context sprint cleanup',
            suggestion: 'Check database permissions and retry closeout.',
          }
        );
      }

      const sprintUpdateResult = completeSprintRecord(client, sprintId, completedAt);
      if (!sprintUpdateResult.success) {
        return fail(
          sprintUpdateResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to update sprint '${sprintId}'`,
            suggestion: 'Check database permissions and retry closeout.',
          }
        );
      }

      const commitResult = client.execute('COMMIT', []);
      if (!commitResult.success) {
        rollback();
        return createError<CmosSprintCompleteResult>(
          commitResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to commit sprint closeout for '${sprintId}'`,
            suggestion: 'Retry once the database can commit the closeout transaction.',
          }
        );
      }
      transactionOpen = false;

      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'sprint_complete', 'Completed', ?, ?)`,
        [
          completedAt,
          sprintId,
          summary,
          JSON.stringify({
            tool: 'cmos_sprint_complete',
            sprintId,
            previousStatus: sprint.status,
            summary,
            condensation,
            targetSizePercent,
          }),
        ]
      );
      if (!eventResult.success) {
        warnings.push('Sprint closeout event logging failed.');
      }

      // s84-m04 (FORK-3=b): NON-BLOCKING context_snapshots growth advisory. Computed here,
      // AFTER the closeout COMMIT (transactionOpen=false) — NEVER inside the BEGIN IMMEDIATE
      // and NEVER an auto-prune (the firehose migration is txn-order-sensitive; a prune is a
      // deliberate operator action). When the write-only snapshot content has grown large,
      // nudge toward `npm run prune:snapshots`; a hiccup here never affects the committed close.
      try {
        const growth = client.getOne<{ rows: number; bytes: number }>(
          `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM context_snapshots`,
          []
        );
        if (
          growth.success &&
          growth.data &&
          (growth.data.rows > SNAPSHOT_GROWTH_ROW_THRESHOLD ||
            growth.data.bytes > SNAPSHOT_GROWTH_BYTE_THRESHOLD)
        ) {
          warnings.push(
            `context_snapshots has grown to ${growth.data.rows} rows / ` +
              `${(growth.data.bytes / (1024 * 1024)).toFixed(1)} MB of write-only content. ` +
              `Run 'npm run prune:snapshots' (dry-run) to preview reclaimable content; --apply to reclaim.`
          );
        }
      } catch {
        // Advisory only — never let a growth-check hiccup affect the already-committed close.
      }

      // --- Lifecycle Trigger: Auto-snapshot the full database (non-critical) ---
      let dbSnapshotId: string | null = null;
      try {
        const snapshotResult = await cmosDbSnapshot({ projectRoot: params.projectRoot });
        if (snapshotResult.success && snapshotResult.data?.createdSnapshot) {
          dbSnapshotId = snapshotResult.data.createdSnapshot.id;
        } else {
          warnings.push('Auto database snapshot after sprint completion failed.');
        }
      } catch {
        warnings.push('Auto database snapshot after sprint completion failed.');
      }

      const lifecycle: SprintLifecycleTriggers = {
        decisionsArchived: archiveResult.success ? archiveResult.decisionsArchived : 0,
        learningsArchived: archiveResult.success ? archiveResult.learningsArchived : 0,
        kpis,
        dbSnapshotId,
      };

      const result: CmosSprintCompleteResult = {
        sprintId,
        previousStatus: sprint.status,
        currentStatus: 'Completed',
        summary,
        completedAt,
        readiness,
        contexts: {
          masterContext: {
            snapshotId: masterSnapshotId.snapshotId ?? null,
            beforeSize: masterContext.data.beforeSize,
            afterSize: masterPersist.data.afterSize,
            nextStepsCleared: masterCleared,
          },
          projectContext: {
            snapshotId: projectSnapshotId.snapshotId ?? null,
            beforeSize: projectContext.data.beforeSize,
            afterSize: projectPersist.data.afterSize,
            nextStepsCleared: projectCleared,
          },
          totalBeforeSizeKb: roundNumber(
            masterContext.data.beforeSize.sizeKb + projectContext.data.beforeSize.sizeKb
          ),
          totalAfterSizeKb: roundNumber(
            masterPersist.data.afterSize.sizeKb + projectPersist.data.afterSize.sizeKb
          ),
        },
        lifecycle,
        nextStepsReconciled: nextStepsTable.reconciled,
        nextStepsCarried: nextStepsTable.carried,
        pendingFlagged: nextStepsTable.pendingFlagged,
        message: buildCloseoutMessage(sprintId, condensation, readiness),
      };

      if (condensation !== 'none') {
        await applyOptionalCondensation({
          projectRoot: params.projectRoot,
          strategy: condensation,
          targetSizePercent,
          warnings,
          contexts: result.contexts,
        });
      }

      result.contexts.totalAfterSizeKb = roundNumber(
        result.contexts.masterContext.afterSize.sizeKb +
          result.contexts.projectContext.afterSize.sizeKb
      );

      // Build-freshness advisory (Sprint 67 m03; demoted to non-blocking post-s74).
      // Never blocks — surfaces staleness as a warning + an attached report so the
      // happy-path shape is unchanged when fresh. Two signals:
      //   (A) source newer than the MANAGED project's own build — attach the
      //       report and warn.
      //   (B) the running server is on stale code — SCOPED to this server's OWN
      //       project, because getServerHealth() tracks cmos-mcp-pro's build, not
      //       the caller's; surfacing it to a sibling blames them for our rebuild.
      // s84-m05: build-freshness is a build-tier concern — skip it entirely for a general/
      // managed project (no `dist/` to keep fresh). Gate on getProjectType (local store defaults
      // 'build', so it keeps the signal). Both signals (A source-newer, B server-stale) are gated.
      if (getProjectType(client) === 'build') {
        try {
          const freshnessRoot = await resolveFreshnessProjectRoot(params.projectRoot);
          if (freshnessRoot) {
            const freshness = await checkBuildFreshness(freshnessRoot);
            if (freshness.stale) {
              result.buildFreshness = freshness;
              if (isBlockingStaleness(freshness)) {
                warnings.push(buildStaleAdvisory(freshness));
              }
            }
            const serverRoot = getServerProjectRoot();
            if (serverRoot && path.resolve(serverRoot) === path.resolve(freshnessRoot)) {
              const health = getServerHealth();
              if (
                health.startupBuild != null &&
                health.codeIsCurrent === false &&
                health.stalenessMessage
              ) {
                warnings.push(health.stalenessMessage);
              }
            }
          }
        } catch {
          // Advisory only — never block sprint close on a probe failure.
        }
      }

      return createSuccess(result, warnings);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Resolve the project root for the build-freshness check. Honors an explicit
 * projectRoot when provided; otherwise falls back to the registry/auto-discovery
 * chain. Returns null when nothing resolves — the caller skips the check.
 */
async function resolveFreshnessProjectRoot(explicitRoot?: string): Promise<string | null> {
  if (explicitRoot) return explicitRoot;
  try {
    const resolution = await resolveProjectRootEnhanced(undefined, {
      autoRegister: false,
      silent: true,
    });
    return resolution.projectRoot;
  } catch {
    return null;
  }
}

/**
 * Build the advisory warning for a stale managed-project build (Signal A). This
 * NEVER blocks closeout (post-s74); it tells the operator the running code may
 * not reflect these source changes, with the same remediation the old gate gave.
 */
function buildStaleAdvisory(report: BuildFreshnessReport): string {
  const examples = report.staleFiles?.length
    ? ` (e.g. ${report.staleFiles.slice(0, 3).join(', ')})`
    : '';
  return (
    `Advisory: this project's build looks stale — ${report.reason ?? 'src newer than build'}` +
    `${examples}. Rebuild (npm run build) and restart the MCP server if the running ` +
    `code should reflect these changes. This does not block sprint close.`
  );
}

function summarizeSprintReadiness(missions: SprintMissionRow[]): SprintCloseoutReadiness {
  const completedMissionIds = missions
    .filter((mission) => mission.status === 'Completed')
    .map((mission) => mission.id);
  const blockedMissionIds = missions
    .filter((mission) => mission.status === 'Blocked')
    .map((mission) => mission.id);
  const skippedMissionIds = missions
    .filter((mission) => mission.status === 'Completed' && isSkippedMission(mission.notes))
    .map((mission) => mission.id);
  // Terminal states for sprint close: Completed, Blocked, Dropped, Deferred.
  // Dropped = soft-parked and intentionally removed — sprint can close.
  // Deferred = temporarily parked — sprint can close; mission carries to next sprint.
  // Only Queued / Current / In Progress missions are truly blocking.
  const TERMINAL_FOR_SPRINT_CLOSE = new Set(['Completed', 'Blocked', 'Dropped', 'Deferred']);
  const openMissionIds = missions
    .filter((mission) => !TERMINAL_FOR_SPRINT_CLOSE.has(mission.status))
    .map((mission) => mission.id);

  return {
    totalMissions: missions.length,
    completedMissions: completedMissionIds.length,
    blockedMissions: blockedMissionIds.length,
    skippedMissions: skippedMissionIds.length,
    openMissions: openMissionIds.length,
    completedMissionIds,
    blockedMissionIds,
    skippedMissionIds,
    openMissionIds,
  };
}

function isSkippedMission(notes: string | null): boolean {
  if (typeof notes !== 'string') {
    return false;
  }

  return notes
    .split(/\r?\n|\|/)
    .map((segment) => segment.trim())
    .some(
      (segment) =>
        /^\[(?:skip|skipped)\](?:\s|$)/i.test(segment) ||
        /^skip(?:ped)?\s*[:-]/i.test(segment) ||
        /^status\s*:\s*skipped\b/i.test(segment)
    );
}

function loadCloseoutContext(
  client: CmosDatabaseClient,
  contextType: CloseoutContextType
): CmosToolResult<LoadedCloseoutContext> {
  const result = client.getOne<Context>(
    'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
    [contextType]
  );
  if (!result.success) {
    return createError(
      result.error ?? {
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to load ${contextType}`,
        suggestion: 'Check database connectivity and schema.',
      }
    );
  }
  if (!result.data) {
    return createError(CmosErrors.contextNotFound(contextType));
  }

  try {
    const parsed = JSON.parse(result.data.content);
    if (!isPlainObject(parsed)) {
      return createError({
        code: CMOS_ERROR_CODES.CONTEXT_PARSE_ERROR,
        message: `${contextType} content must be a JSON object`,
        suggestion: 'Repair the stored context JSON before retrying sprint closeout.',
      });
    }

    const sizeSettings = resolveContextSizeSettings(parsed);
    return createSuccess({
      contextType,
      rawContent: result.data.content,
      parsedContent: parsed,
      beforeSize: calculateContextSizeMetrics(result.data.content, sizeSettings),
    });
  } catch {
    return createError({
      code: CMOS_ERROR_CODES.CONTEXT_PARSE_ERROR,
      message: `${contextType} content is not valid JSON`,
      suggestion: 'Repair the stored context JSON before retrying sprint closeout.',
    });
  }
}

function createSnapshot(
  client: CmosDatabaseClient,
  contextType: CloseoutContextType,
  content: string,
  source: string
): { success: boolean; snapshotId?: number } {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const existing = client.getOne<{ id: number }>(
    // s84-m04: exclude a content-tombstoned row so identical content re-persists fresh.
    `SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}`,
    [contextType, contentHash]
  );
  if (existing.success && existing.data) {
    return { success: true, snapshotId: existing.data.id };
  }

  const now = new Date().toISOString();
  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextType, source, contentHash, content, now, ...g.values]
  );
  if (!insertResult.success) {
    return { success: false };
  }

  return { success: true, snapshotId: Number(insertResult.data?.lastInsertRowid) };
}

/**
 * s81-m06 — reconcile the next_steps TABLE at sprint close (learning #433 / decision
 * #926 practice #1). `clearSprintLinkedNextSteps` above only prunes the context-JSON
 * string arrays; the next_steps TABLE has always required the operator to pass explicit
 * ids to transition rows, so done-but-unmarked rows accumulated silently — the recurring
 * debt this pays down.
 *
 * Runs inside the closeout's BEGIN IMMEDIATE txn. Reconcile-or-FLAG, never guess:
 *   - AUTO-complete ONLY the machine-CERTAIN subset: pending rows whose `mission_id` is a
 *     Completed, non-blocked mission of the closing sprint (a real FK to a terminal-done
 *     mission — the one case where "done" is knowable without a "did it ship" guess).
 *   - CARRY blocked-linked rows: `mission_id` is a Blocked mission → leave pending (mirrors
 *     `shouldClearStep`'s blocked-mission guard, which fires FIRST).
 *   - FLAG the rest (mission_id NULL free-text, or a mission not Completed/Blocked in this
 *     sprint) on the receipt — NEVER auto-closed. Auto-closing these is exactly the
 *     silent-wrong-state debt #926 forbids.
 * Only sprint-scoped rows (`sprint_id = ?`) are considered — free-text rows with no
 * sprint link are never touched.
 */
function reconcileSprintNextStepsTable(
  client: CmosDatabaseClient,
  sprintId: string,
  completedMissionIds: string[],
  blockedMissionIds: string[],
  completedAt: string
): {
  reconciled: number;
  carried: number;
  pendingFlagged: Array<{ id: number; content: string; missionId: string | null }>;
} {
  const empty = { reconciled: 0, carried: 0, pendingFlagged: [] };
  const rows = client.getMany<{ id: number; content: string; mission_id: string | null }>(
    `SELECT id, content, mission_id FROM next_steps WHERE sprint_id = ? AND status = 'pending'`,
    [sprintId]
  );
  if (!rows.success || !rows.data) return empty;

  const completed = new Set(completedMissionIds);
  const blocked = new Set(blockedMissionIds);
  const toComplete: number[] = [];
  let carried = 0;
  const pendingFlagged: Array<{ id: number; content: string; missionId: string | null }> = [];

  for (const row of rows.data) {
    const mid = row.mission_id;
    // Blocked-mission guard FIRST (mirrors shouldClearStep:817-819): carry, never close.
    if (mid && blocked.has(mid)) {
      carried += 1;
      continue;
    }
    // The ONLY machine-certain "done": a real FK to a Completed non-blocked mission.
    if (mid && completed.has(mid)) {
      toComplete.push(row.id);
      continue;
    }
    // No mission FK, or a mission not terminal-done in this sprint → FLAG, never guess.
    pendingFlagged.push({ id: row.id, content: row.content, missionId: mid });
  }

  if (toComplete.length > 0) {
    const placeholders = toComplete.map(() => '?').join(', ');
    client.execute(
      `UPDATE next_steps SET status = 'completed', resolved_at = ? WHERE id IN (${placeholders}) AND status = 'pending'`,
      [completedAt, ...toComplete]
    );
  }

  return { reconciled: toComplete.length, carried, pendingFlagged };
}

function clearSprintLinkedNextSteps(
  content: Record<string, unknown>,
  sprintId: string,
  completedMissionIds: string[],
  blockedMissionIds: string[]
): number {
  const paths = [
    ['working_memory', 'next_steps'],
    ['next_session_context', 'when_we_resume'],
    ['next_steps'],
  ] as const;

  let removed = 0;
  for (const path of paths) {
    removed += pruneStringArrayAtPath(content, [...path], (step) =>
      shouldClearStep(step, sprintId, completedMissionIds, blockedMissionIds)
    );
  }

  return removed;
}

function pruneStringArrayAtPath(
  content: Record<string, unknown>,
  path: string[],
  shouldRemove: (step: string) => boolean
): number {
  const parent = getParentObject(content, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent || !Array.isArray(parent[key])) {
    return 0;
  }

  let removed = 0;
  parent[key] = (parent[key] as unknown[]).filter((entry) => {
    if (typeof entry === 'string' && shouldRemove(entry)) {
      removed += 1;
      return false;
    }
    return true;
  });

  return removed;
}

function shouldClearStep(
  step: string,
  sprintId: string,
  completedMissionIds: string[],
  blockedMissionIds: string[]
): boolean {
  const normalized = step.toLowerCase();
  if (blockedMissionIds.some((missionId) => normalized.includes(missionId.toLowerCase()))) {
    return false;
  }

  if (completedMissionIds.some((missionId) => normalized.includes(missionId.toLowerCase()))) {
    return true;
  }

  return buildSprintTokens(sprintId).some((token) => normalized.includes(token));
}

function buildSprintTokens(sprintId: string): string[] {
  const normalizedSprintId = sprintId.toLowerCase();
  const tokens = [normalizedSprintId, normalizedSprintId.replace(/-/g, ' ')];
  const numericMatch = normalizedSprintId.match(/^sprint-(\d+)$/);
  if (numericMatch) {
    const sprintNumber = String(Number.parseInt(numericMatch[1], 10));
    tokens.push(`sprint ${sprintNumber}`);
    tokens.push(`sprint-${numericMatch[1]}`);
  }
  return tokens;
}

function getParentObject(
  content: Record<string, unknown>,
  path: string[]
): Record<string, unknown> | null {
  let current: Record<string, unknown> = content;

  for (const segment of path) {
    const next = current[segment];
    if (!isPlainObject(next)) {
      return null;
    }
    current = next;
  }

  return current;
}

function persistCloseoutContext(
  client: CmosDatabaseClient,
  context: LoadedCloseoutContext,
  updatedAt: string
): CmosToolResult<{ afterSize: ContextSizeMetrics }> {
  const serialized = JSON.stringify(context.parsedContent);
  const afterSize = calculateContextSizeMetrics(
    serialized,
    resolveContextSizeSettings(context.parsedContent)
  );

  if (serialized === context.rawContent) {
    return createSuccess({ afterSize });
  }

  const updateResult = client.execute(
    'UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?',
    [serialized, updatedAt, context.contextType]
  );
  if (!updateResult.success) {
    return createError(
      updateResult.error ?? {
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to update ${context.contextType}`,
        suggestion: 'Check database permissions and retry sprint closeout.',
      }
    );
  }

  return createSuccess({ afterSize });
}

function completeSprintRecord(
  client: CmosDatabaseClient,
  sprintId: string,
  completedAt: string
): ReturnType<CmosDatabaseClient['execute']> {
  const updateWithEndDate = client.execute(
    `UPDATE sprints
        SET status = 'Completed',
            end_date = COALESCE(end_date, ?)
      WHERE id = ?`,
    [completedAt, sprintId]
  );

  if (
    updateWithEndDate.success ||
    updateWithEndDate.error?.code !== CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH ||
    !updateWithEndDate.error?.message.includes('end_date')
  ) {
    return updateWithEndDate;
  }

  return client.execute(`UPDATE sprints SET status = 'Completed' WHERE id = ?`, [sprintId]);
}

async function applyOptionalCondensation(params: {
  projectRoot?: string;
  strategy: Exclude<CloseoutCondensationStrategy, 'none'>;
  targetSizePercent: number;
  warnings: string[];
  contexts: CmosSprintCompleteResult['contexts'];
}): Promise<void> {
  const mappings = [
    ['masterContext', 'master_context'],
    ['projectContext', 'project_context'],
  ] as const;

  for (const [resultKey, contextType] of mappings) {
    const condenseResult = await cmosContextCondense({
      contextType,
      strategy: params.strategy,
      targetSizePercent: params.targetSizePercent,
      dryRun: false,
      projectRoot: params.projectRoot,
    });

    if (!condenseResult.success || !condenseResult.data) {
      params.warnings.push(
        `Optional ${contextType} condensation failed: ${condenseResult.error?.message ?? 'Unknown error'}.`
      );
      continue;
    }

    params.contexts[resultKey].afterSize = condenseResult.data.afterSize;
    params.contexts[resultKey].condensation = {
      strategy: params.strategy,
      snapshotId: condenseResult.data.snapshotId,
      reductionPercent: condenseResult.data.reductionPercent,
      targetMet: condenseResult.data.targetMet,
      message: condenseResult.data.message,
    };

    for (const warning of condenseResult.warnings ?? []) {
      params.warnings.push(`${contextType}: ${warning}`);
    }
  }
}

/**
 * Archive sprint-scoped decisions and learnings.
 * Sets status='archived' for all active decisions/learnings linked to the sprint
 * (directly via sprint_id, or indirectly via mission/session sprint linkage).
 * Decisions/learnings with status other than 'active' are left untouched.
 */
function archiveSprintDecisionsAndLearnings(
  client: CmosDatabaseClient,
  sprintId: string
): { success: boolean; decisionsArchived: number; learningsArchived: number; error?: string } {
  let decisionsArchived = 0;
  let learningsArchived = 0;

  // Sprint 52 m04: older DBs seeded before the session-of-origin column was added
  // will fail the archival UPDATE with `no such column` and silently archive zero
  // rows. Ensure it exists first. s69-m04 renamed it session_id → author_session_id;
  // ensureAuthorNamespaceColumns (run pre-BEGIN at the top of this handler) has
  // already settled the rename, and ensureArchivalColumns is now rename-aware.
  ensureArchivalColumns(client);

  const decisionsSql = `UPDATE strategic_decisions SET status = 'archived'
     WHERE status = 'active'
       AND (sprint_id = ?
         OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
         OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?))`;

  const decisionResult = client.execute(decisionsSql, [sprintId, sprintId, sprintId]);
  if (decisionResult.success) {
    decisionsArchived = decisionResult.data?.changes ?? 0;
  } else {
    const msg = decisionResult.error?.message ?? 'Failed to archive decisions';
    return {
      success: false,
      decisionsArchived: 0,
      learningsArchived: 0,
      error: `strategic_decisions: ${msg} — SQL: ${decisionsSql.replace(/\s+/g, ' ')}`,
    };
  }

  const learningsSql = `UPDATE learnings SET status = 'archived'
     WHERE status = 'active'
       AND (sprint_id = ?
         OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
         OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?))`;

  const learningResult = client.execute(learningsSql, [sprintId, sprintId, sprintId]);
  if (learningResult.success) {
    learningsArchived = learningResult.data?.changes ?? 0;
  } else {
    const msg = learningResult.error?.message ?? 'Failed to archive learnings';
    return {
      success: false,
      decisionsArchived,
      learningsArchived: 0,
      error: `learnings: ${msg} — SQL: ${learningsSql.replace(/\s+/g, ' ')}`,
    };
  }

  return { success: true, decisionsArchived, learningsArchived };
}

/**
 * Compute sprint summary KPIs from mission and decision data.
 */
function computeSprintKPIs(
  client: CmosDatabaseClient,
  sprintId: string,
  readiness: SprintCloseoutReadiness
): SprintKPIs {
  const completionRate =
    readiness.totalMissions > 0
      ? roundNumber(readiness.completedMissions / readiness.totalMissions)
      : 0;

  // Compute average cycle time from missions with both started_at and completed_at
  let avgCycleTimeDays: number | null = null;
  const missionRows = client.getMany<SprintMissionKpiRow>(
    'SELECT id, status, started_at, completed_at FROM missions WHERE sprint_id = ? AND status = ? AND started_at IS NOT NULL AND completed_at IS NOT NULL',
    [sprintId, 'Completed']
  );
  if (missionRows.success && missionRows.data && missionRows.data.length > 0) {
    let totalMs = 0;
    let count = 0;
    for (const row of missionRows.data) {
      if (row.started_at && row.completed_at) {
        const started = Date.parse(row.started_at);
        const completed = Date.parse(row.completed_at);
        if (!Number.isNaN(started) && !Number.isNaN(completed) && completed >= started) {
          totalMs += completed - started;
          count += 1;
        }
      }
    }
    if (count > 0) {
      avgCycleTimeDays = roundNumber(totalMs / count / (1000 * 60 * 60 * 24));
    }
  }

  // Count decisions for this sprint
  let decisionCount = 0;
  const decisionCountResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM strategic_decisions
     WHERE sprint_id = ?
       OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
       OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?)`,
    [sprintId, sprintId, sprintId]
  );
  if (decisionCountResult.success && decisionCountResult.data) {
    decisionCount = decisionCountResult.data.count;
  }

  // Count learnings for this sprint
  let learningCount = 0;
  const learningCountResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM learnings
     WHERE sprint_id = ?
       OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
       OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?)`,
    [sprintId, sprintId, sprintId]
  );
  if (learningCountResult.success && learningCountResult.data) {
    learningCount = learningCountResult.data.count;
  }

  return {
    completionRate,
    avgCycleTimeDays,
    decisionCount,
    learningCount,
    blockedCount: readiness.blockedMissions,
  };
}

/**
 * Clear project_context sprint-specific working_memory fields and update current_sprint.
 * Clears session_history and recent_sessions arrays (sprint-scoped ephemeral data).
 * Does NOT clear next_steps — that's handled by clearSprintLinkedNextSteps which is selective.
 * Mutates the parsed content in-place for subsequent persistence.
 */
function clearProjectContextWorkingMemory(
  content: Record<string, unknown>,
  _sprintId: string
): void {
  if (isPlainObject(content.working_memory)) {
    const wm = content.working_memory as Record<string, unknown>;
    // Clear sprint-scoped ephemeral arrays but NOT next_steps (handled separately)
    const ephemeralKeys = ['session_history', 'recent_sessions'];
    for (const key of ephemeralKeys) {
      if (Array.isArray(wm[key])) {
        wm[key] = [];
      }
    }
  }

  // Set current_sprint to null to signal the sprint is closed
  if ('current_sprint' in content) {
    content.current_sprint = null;
  }

  // Also clear active_mission if present
  if ('active_mission' in content) {
    content.active_mission = null;
  }
}

function buildCloseoutMessage(
  sprintId: string,
  condensation: CloseoutCondensationStrategy,
  readiness: SprintCloseoutReadiness
): string {
  const parts = [`Sprint '${sprintId}' closed successfully`];
  if (readiness.blockedMissions > 0) {
    parts.push(
      `with ${readiness.blockedMissions} blocked mission${readiness.blockedMissions === 1 ? '' : 's'} left as carryover`
    );
  }
  if (condensation !== 'none') {
    parts.push(`using ${condensation} context condensation`);
  }
  return parts.join(' ');
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Format sprint closeout results for LLM readability.
 */
export function formatSprintCompleteForLLM(
  result: CmosToolResult<CmosSprintCompleteResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to complete sprint',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines = [
    `✓ Sprint '${data.sprintId}' completed`,
    '',
    `Status: ${data.previousStatus ?? 'Unknown'} → ${data.currentStatus}`,
    `Completed at: ${data.completedAt}`,
    `Summary: ${data.summary}`,
    '',
    `Readiness: ${data.readiness.completedMissions}/${data.readiness.totalMissions} completed, ${data.readiness.blockedMissions} blocked, ${data.readiness.openMissions} open`,
    '',
    `KPIs: completion rate ${(data.lifecycle.kpis.completionRate * 100).toFixed(0)}%, avg cycle time ${data.lifecycle.kpis.avgCycleTimeDays !== null ? `${data.lifecycle.kpis.avgCycleTimeDays}d` : 'N/A'}, ${data.lifecycle.kpis.decisionCount} decisions, ${data.lifecycle.kpis.learningCount} learnings`,
    `Archived: ${data.lifecycle.decisionsArchived} decisions, ${data.lifecycle.learningsArchived} learnings`,
    `DB snapshot: ${data.lifecycle.dbSnapshotId ?? 'failed'}`,
    '',
    `master_context: ${data.contexts.masterContext.beforeSize.sizeKb.toFixed(2)}KB → ${data.contexts.masterContext.afterSize.sizeKb.toFixed(2)}KB, cleared ${data.contexts.masterContext.nextStepsCleared} next step(s)`,
    `project_context: ${data.contexts.projectContext.beforeSize.sizeKb.toFixed(2)}KB → ${data.contexts.projectContext.afterSize.sizeKb.toFixed(2)}KB, cleared ${data.contexts.projectContext.nextStepsCleared} next step(s)`,
    `Total context size: ${data.contexts.totalBeforeSizeKb.toFixed(2)}KB → ${data.contexts.totalAfterSizeKb.toFixed(2)}KB`,
  ];

  if (data.contexts.masterContext.condensation || data.contexts.projectContext.condensation) {
    lines.push('');
    if (data.contexts.masterContext.condensation) {
      lines.push(
        `master_context condensation: ${data.contexts.masterContext.condensation.message}`
      );
    }
    if (data.contexts.projectContext.condensation) {
      lines.push(
        `project_context condensation: ${data.contexts.projectContext.condensation.message}`
      );
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}
