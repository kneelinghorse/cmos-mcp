/**
 * cmos_db Tool
 *
 * Consolidated database admin tool with action parameter support.
 * Actions: health, snapshot, restore.
 * Routes to existing DB handlers without rewriting business logic.
 *
 * @module tools/cmos/cmos-db
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import type { ActionParamMap, CmosToolResult } from './types';
import {
  cmosDbHealth,
  formatHealthForLLM,
  type CmosDbHealthParams,
  type CmosDbHealthResult,
} from './cmos-db-health';
import {
  cmosDbSnapshot,
  formatDbSnapshotForLLM,
  type CmosDbSnapshotParams,
  type CmosDbSnapshotResult,
} from './cmos-db-snapshot';
import {
  cmosDbRestore,
  formatDbRestoreForLLM,
  type CmosDbRestoreParams,
  type CmosDbRestoreResult,
} from './cmos-db-restore';
import {
  cmosDbBackfill,
  formatBackfillForLLM,
  type CmosDbBackfillParams,
  type CmosDbBackfillResult,
} from './cmos-db-backfill';
import {
  cmosDbReconcile,
  formatReconciliationForLLM,
  type ReconciliationResult,
  cmosDbPurge,
  formatPurgeForLLM,
  type PurgeResult,
  identifyPgOrphans,
  formatPgOrphanReportForLLM,
  type PgOrphanReport,
} from './cmos-db-backfill';
import { syncPull, formatSyncPullForLLM, type SyncPullResult } from './sync-pull';
import {
  syncBootstrap,
  formatSyncBootstrapForLLM,
  type SyncBootstrapResult,
} from './sync-bootstrap';

export const CMOS_DB_ACTIONS = [
  'health',
  'snapshot',
  'restore',
  'backfill',
  'reconcile',
  'purge',
  'identify_orphans',
  'pull',
  'clone',
] as const;

export type CmosDbAction = (typeof CMOS_DB_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const CMOS_DB_ACTION_PARAMS: ActionParamMap<CmosDbAction, CmosDbParams> = {
  health: ['action', 'projectRoot'],
  snapshot: ['action', 'listOnly', 'maxSnapshots', 'projectRoot'],
  restore: ['action', 'snapshotId', 'confirm', 'projectRoot'],
  backfill: ['action', 'force', 'dryRun', 'projectRoot'],
  reconcile: ['action', 'projectRoot'],
  purge: ['action', 'confirm', 'expectedSlug', 'projectRoot'],
  identify_orphans: ['action', 'projectRoot'],
  pull: ['action', 'slug', 'limit', 'maxPages', 'projectRoot'],
  clone: ['action', 'slug', 'projectRoot'],
};

export type CmosDbResult =
  | CmosDbHealthResult
  | CmosDbSnapshotResult
  | CmosDbRestoreResult
  | CmosDbBackfillResult
  | ReconciliationResult
  | PurgeResult
  | PgOrphanReport
  | SyncPullResult
  | SyncBootstrapResult;

export const cmosDbSchema = z
  .object({
    action: z
      .enum(CMOS_DB_ACTIONS)
      .describe(
        'Database action: health | snapshot | restore | backfill | reconcile | purge | identify_orphans | pull | clone'
      ),
    // pull/clone params (Sprint 71 m02 PULL consumer + m03 clone-from-/state)
    slug: z
      .string()
      .optional()
      .describe(
        'Dashboard slug to pull/clone (for pull and clone actions; defaults to the registered slug)'
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Per-page event limit for pull action (default 500, broker caps at 1000)'),
    maxPages: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Safety bound on the pull pagination loop (default 1000)'),
    // snapshot params
    listOnly: z.boolean().optional().describe('List snapshots instead of creating one'),
    maxSnapshots: z.number().int().positive().optional().describe('Max snapshots to list'),
    // restore params
    snapshotId: z
      .string()
      .optional()
      .describe('Snapshot ID for restore action (required for restore)'),
    confirm: z
      .boolean()
      .optional()
      .describe('Confirmation flag for restore/purge actions (required for restore)'),
    // backfill params
    force: z
      .boolean()
      .optional()
      .describe('Force full backfill, ignoring cursor (for backfill action)'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview backfill without pushing (for backfill action)'),
    expectedSlug: z
      .string()
      .optional()
      .describe('Expected project slug for guardrail checks on purge (optional)'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosDbParams = z.infer<typeof cmosDbSchema>;

export const cmosDbToolDefinition = {
  name: 'cmos_db',
  description:
    'Consolidated database admin tool with action parameter support. ' +
    'Actions: health, snapshot, restore, backfill, reconcile, purge, identify_orphans, pull, clone. ' +
    'Routes to the existing DB handlers without changing DB business logic.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_DB_ACTIONS],
        description:
          'Database action: health | snapshot | restore | backfill | reconcile | purge | identify_orphans | pull | clone',
      },
      listOnly: { type: 'boolean', description: 'List snapshots instead of creating one' },
      maxSnapshots: { type: 'integer', minimum: 1, description: 'Max snapshots to list' },
      snapshotId: { type: 'string', description: 'Snapshot ID for restore action' },
      confirm: { type: 'boolean', description: 'Confirmation flag for restore/purge actions' },
      force: { type: 'boolean', description: 'Force full backfill, ignoring cursor' },
      dryRun: { type: 'boolean', description: 'Preview backfill without pushing' },
      expectedSlug: {
        type: 'string',
        description: 'Expected project slug for guardrail checks on purge',
      },
      slug: {
        type: 'string',
        description:
          'Dashboard slug to pull/clone (for pull and clone actions; defaults to the registered slug)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Per-page event limit for pull action (default 500, broker caps at 1000)',
      },
      maxPages: {
        type: 'integer',
        minimum: 1,
        description: 'Safety bound on the pull pagination loop (default 1000)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

function isDbAction(value: string): value is CmosDbAction {
  return (CMOS_DB_ACTIONS as readonly string[]).includes(value);
}

export async function cmosDb(params: CmosDbParams): Promise<CmosToolResult<CmosDbResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isDbAction(actionValue)) {
    return createError<CmosDbResult>(
      CmosErrors.invalidAction('cmos_db', actionValue, CMOS_DB_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'health':
      return cmosDbHealth({
        projectRoot: params.projectRoot,
      } satisfies CmosDbHealthParams);
    case 'snapshot':
      return cmosDbSnapshot({
        listOnly: params.listOnly,
        maxSnapshots: params.maxSnapshots,
        projectRoot: params.projectRoot,
      } satisfies CmosDbSnapshotParams);
    case 'restore':
      return cmosDbRestore({
        snapshotId: params.snapshotId ?? '',
        confirm: params.confirm ?? false,
        projectRoot: params.projectRoot,
      } satisfies CmosDbRestoreParams);
    case 'backfill':
      return cmosDbBackfill({
        force: params.force,
        dryRun: params.dryRun,
        projectRoot: params.projectRoot,
      } satisfies CmosDbBackfillParams);
    case 'reconcile':
      return cmosDbReconcile({
        projectRoot: params.projectRoot,
      });
    case 'purge':
      return cmosDbPurge({
        confirm: params.confirm,
        expectedSlug: params.expectedSlug,
        projectRoot: params.projectRoot,
      });
    case 'identify_orphans':
      return identifyPgOrphans({
        projectRoot: params.projectRoot,
      });
    case 'pull':
      return syncPull({
        slug: params.slug,
        limit: params.limit,
        maxPages: params.maxPages,
        projectRoot: params.projectRoot,
      });
    case 'clone':
      return syncBootstrap({
        slug: params.slug,
        projectRoot: params.projectRoot,
      });
  }
}

export function formatDbForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosDbResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_db', '', `Error: ${result.error.message}`];

    if (availableActions.length > 0) {
      lines.push('');
      lines.push(`Available actions: ${availableActions.join(', ')}`);
    }

    if (result.error.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${result.error.suggestion}`);
    }

    return lines.join('\n');
  }

  switch (action) {
    case 'health':
      return formatHealthForLLM(result as CmosToolResult<CmosDbHealthResult>);
    case 'snapshot':
      return formatDbSnapshotForLLM(result as CmosToolResult<CmosDbSnapshotResult>);
    case 'restore':
      return formatDbRestoreForLLM(result as CmosToolResult<CmosDbRestoreResult>);
    case 'backfill':
      return formatBackfillForLLM(result as CmosToolResult<CmosDbBackfillResult>);
    case 'reconcile':
      return formatReconciliationForLLM(result as CmosToolResult<ReconciliationResult>);
    case 'purge':
      return formatPurgeForLLM(result as CmosToolResult<PurgeResult>);
    case 'identify_orphans':
      return formatPgOrphanReportForLLM(result as CmosToolResult<PgOrphanReport>);
    case 'pull':
      return formatSyncPullForLLM(result as CmosToolResult<SyncPullResult>);
    case 'clone':
      return formatSyncBootstrapForLLM(result as CmosToolResult<SyncBootstrapResult>);
    default:
      return result.success ? '✓ Database action completed' : '❌ Failed to execute cmos_db';
  }
}
