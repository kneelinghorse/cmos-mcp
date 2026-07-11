/**
 * cmos_context Tool
 *
 * Consolidated context tool with action parameter support.
 * Actions: view, update, condense, snapshot, history.
 * Routes to existing context handlers without rewriting business logic.
 *
 * @module tools/cmos/cmos-context
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import {
  cmosContextView,
  formatContextViewForLLM,
  type CmosContextViewParams,
  type CmosContextViewResult,
} from './cmos-context-view';
import {
  cmosContextUpdate,
  formatContextUpdateForLLM,
  type CmosContextUpdateParams,
  type CmosContextUpdateResult,
} from './cmos-context-update';
import {
  cmosContextViewProjectIdentity,
  cmosContextUpdateProjectIdentity,
  formatProjectIdentityViewForLLM,
  formatProjectIdentityUpdateForLLM,
  type ProjectIdentityViewResult,
  type ProjectIdentityUpdateResult,
} from './cmos-context-project-identity';
import {
  cmosContextSearch,
  formatContextSearchForLLM,
  type ContextSearchResult,
  type RankedResultType,
} from './cmos-context-search';
import {
  cmosContextCondense,
  formatContextCondenseForLLM,
  type CmosContextCondenseParams,
  type CmosContextCondenseResult,
} from './cmos-context-condense';
import {
  cmosContextSnapshot,
  formatContextSnapshotForLLM,
  type CmosContextSnapshotParams,
  type CmosContextSnapshotResult,
} from './cmos-context-snapshot';
import {
  cmosContextHistory,
  formatContextHistoryForLLM,
  type CmosContextHistoryParams,
  type CmosContextHistoryResult,
} from './cmos-context-history';
import {
  cmosNextSteps,
  formatNextStepsForLLM,
  type CmosNextStepsParams,
  type NextStepsResult,
} from './cmos-next-steps';
import {
  cmosConstraints,
  formatConstraintsForLLM,
  type CmosConstraintsParams,
  type ConstraintsResult,
} from './cmos-constraints';
import { NEXT_STEP_STATUSES, CONSTRAINT_STATUSES } from './schema-migrations';
import { maybePropagateProjectIdentity } from './sync-locks';

export const CMOS_CONTEXT_ACTIONS = [
  'view',
  'update',
  'condense',
  'snapshot',
  'history',
  'next_steps',
  'constraints',
  'search',
] as const;

export type CmosContextAction = (typeof CMOS_CONTEXT_ACTIONS)[number];

export type CmosContextResult =
  | CmosContextViewResult
  | CmosContextUpdateResult
  | CmosContextCondenseResult
  | CmosContextSnapshotResult
  | CmosContextHistoryResult
  | NextStepsResult
  | ConstraintsResult
  | ProjectIdentityViewResult
  | ProjectIdentityUpdateResult
  | ContextSearchResult;

export const cmosContextSchema = z
  .object({
    action: z
      .enum(CMOS_CONTEXT_ACTIONS)
      .describe('Context action: view | update | condense | snapshot | history | next_steps'),
    contextType: z
      .enum(['master_context', 'project_context', 'project_identity'])
      .optional()
      .describe('Context type (defaults to master_context)'),
    // view params
    sizeOnly: z.boolean().optional().describe('Return only size info for view action'),
    compact: z.boolean().optional().describe('Return compact view for view action'),
    // update params
    mode: z.enum(['aggregate', 'manual']).optional().describe('Update mode for update action'),
    arrayUpdates: z
      .object({
        decisions_made: z.array(z.string()).optional(),
        learnings: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        context_notes: z.array(z.string()).optional(),
      })
      .optional()
      .describe('Array fields to append for update action'),
    fieldUpdates: z
      .array(
        z.object({
          path: z.string(),
          value: z.unknown(),
        })
      )
      .optional()
      .describe('Field-level updates for update action'),
    since: z.string().optional().describe('ISO date filter for update/history actions'),
    // condense params
    strategy: z
      .enum(['conservative', 'auto', 'aggressive'])
      .optional()
      .describe('Condensation strategy for condense action'),
    targetSizePercent: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Target size percent for condense action'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview condensation without applying for condense action'),
    // snapshot params
    source: z
      .string()
      .optional()
      .describe('Snapshot source label for snapshot action (required for snapshot)'),
    sessionId: z.string().optional().describe('Session ID for snapshot/history actions'),
    // history params
    until: z.string().optional().describe('ISO date upper bound for history action'),
    page: z.number().int().positive().optional().describe('Page number for history action'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Page size for history action'),
    // next_steps params
    nextStepAction: z
      .enum(['list', 'complete', 'carry', 'drop'])
      .optional()
      .describe('Sub-action for next_steps: list | complete | carry | drop'),
    nextStepStatus: z
      .enum(NEXT_STEP_STATUSES)
      .optional()
      .describe('Filter status for next_steps list (default: pending)'),
    nextStepIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('Next-step IDs to act on for complete/carry/drop'),
    carryToSprint: z.string().optional().describe('Target sprint ID for carry action'),
    // constraints params
    constraintAction: z
      .enum(['list', 'review', 'archive', 'reaffirm'])
      .optional()
      .describe('Sub-action for constraints: list | review | archive | reaffirm'),
    constraintStatus: z
      .enum(CONSTRAINT_STATUSES)
      .optional()
      .describe('Filter status for constraints list (default: active)'),
    constraintIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('Constraint IDs to archive'),
    constraintId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Constraint ID to reaffirm (bumps last_reviewed_at without changing status)'),
    stalenessThresholdDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Staleness threshold in days for review (default: 30)'),
    // search params
    query: z.string().optional().describe('Search query string for search action'),
    searchLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Max results for search action (default: 5)'),
    searchTypes: z
      .array(z.enum(['decision', 'learning', 'mission', 'session']))
      .optional()
      .describe('Content types to search for search action'),
    recencyWeight: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Recency boost weight 0–1 for search action (default: 0.2)'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosContextParams = z.infer<typeof cmosContextSchema>;

export const cmosContextToolDefinition = {
  name: 'cmos_context',
  description:
    'Consolidated context tool with action parameter support. ' +
    'Actions: view, update, condense, snapshot, history, next_steps, search. ' +
    'Use contextType=project_identity to view/update the Layer 0 project description. ' +
    'Use action=search to run FTS5 relevance-scored retrieval over decisions, learnings, and missions.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_CONTEXT_ACTIONS],
        description:
          'Context action: view | update | condense | snapshot | history | next_steps | constraints',
      },
      contextType: {
        type: 'string',
        enum: ['master_context', 'project_context', 'project_identity'],
        description: 'Context type (defaults to master_context)',
      },
      sizeOnly: { type: 'boolean', description: 'Return only size info for view action' },
      compact: { type: 'boolean', description: 'Return compact view for view action' },
      mode: {
        type: 'string',
        enum: ['aggregate', 'manual'],
        description: 'Update mode for update action',
      },
      arrayUpdates: {
        type: 'object',
        description: 'Array fields to append for update action',
      },
      fieldUpdates: {
        type: 'array',
        description:
          'Field-level updates for update action. Each entry must have "path" (dot-notation field name) and "value". Example: [{path: "project_name", value: "My Project"}, {path: "type_fields.stack", value: "Node.js"}]',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Field path in dot-notation (e.g. "project_name", "type_fields.stack")',
            },
            value: { description: 'New field value' },
          },
          required: ['path', 'value'],
        },
      },
      since: { type: 'string', description: 'ISO date filter for update/history actions' },
      strategy: {
        type: 'string',
        enum: ['conservative', 'auto', 'aggressive'],
        description: 'Condensation strategy for condense action',
      },
      targetSizePercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Target size percent for condense action',
      },
      dryRun: { type: 'boolean', description: 'Preview condensation for condense action' },
      source: { type: 'string', description: 'Snapshot source label for snapshot action' },
      sessionId: { type: 'string', description: 'Session ID for snapshot/history actions' },
      until: { type: 'string', description: 'ISO date upper bound for history action' },
      page: { type: 'number', minimum: 1, description: 'Page number for history action' },
      pageSize: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Page size for history action',
      },
      nextStepAction: {
        type: 'string',
        enum: ['list', 'complete', 'carry', 'drop'],
        description: 'Sub-action for next_steps: list | complete | carry | drop',
      },
      nextStepStatus: {
        type: 'string',
        enum: [...NEXT_STEP_STATUSES],
        description: 'Filter status for next_steps list (default: pending)',
      },
      nextStepIds: {
        type: 'array',
        items: { type: 'number' },
        description: 'Next-step IDs to act on for complete/carry/drop',
      },
      carryToSprint: {
        type: 'string',
        description: 'Target sprint ID for carry action',
      },
      constraintAction: {
        type: 'string',
        enum: ['list', 'review', 'archive', 'reaffirm'],
        description: 'Sub-action for constraints: list | review | archive | reaffirm',
      },
      constraintStatus: {
        type: 'string',
        enum: [...CONSTRAINT_STATUSES],
        description: 'Filter status for constraints list (default: active)',
      },
      constraintIds: {
        type: 'array',
        items: { type: 'number' },
        description: 'Constraint IDs to archive',
      },
      constraintId: {
        type: 'number',
        minimum: 1,
        description:
          'Constraint ID to reaffirm (bumps last_reviewed_at without changing status; resets its staleness clock)',
      },
      stalenessThresholdDays: {
        type: 'number',
        description: 'Staleness threshold in days for review (default: 30)',
      },
      query: {
        type: 'string',
        description: 'Search query string for search action',
      },
      searchLimit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        description: 'Max results for search action (default: 5)',
      },
      searchTypes: {
        type: 'array',
        items: { type: 'string', enum: ['decision', 'learning', 'mission', 'session'] },
        description: 'Content types to search (default: all)',
      },
      recencyWeight: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Recency boost weight 0–1 for search action (default: 0.2)',
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

function isContextAction(value: string): value is CmosContextAction {
  return (CMOS_CONTEXT_ACTIONS as readonly string[]).includes(value);
}

export async function cmosContext(
  params: CmosContextParams
): Promise<CmosToolResult<CmosContextResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isContextAction(actionValue)) {
    return createError<CmosContextResult>(
      CmosErrors.invalidAction('cmos_context', actionValue, CMOS_CONTEXT_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'view':
      // project_identity gets its own view handler
      if (params.contextType === 'project_identity') {
        return cmosContextViewProjectIdentity({ projectRoot: params.projectRoot });
      }
      return cmosContextView({
        contextType: params.contextType as 'master_context' | 'project_context' | undefined,
        sizeOnly: params.sizeOnly,
        compact: params.compact,
        projectRoot: params.projectRoot,
      } as CmosContextViewParams);
    case 'update':
      // project_identity gets its own update handler
      if (params.contextType === 'project_identity') {
        const result = await cmosContextUpdateProjectIdentity({
          fieldUpdates: params.fieldUpdates as Array<{ path: string; value: unknown }> | undefined,
          projectRoot: params.projectRoot,
        });
        // Sprint 72 m03: propagate project_identity to the broker on a collab store — but
        // only when this update actually touched `project_name` (a description-only update
        // emits nothing). Resilient + no-op on solo stores (see maybePropagateProjectIdentity).
        const nameChanged =
          result.success && (result.data?.fieldsUpdated?.includes('project_name') ?? false);
        return nameChanged ? maybePropagateProjectIdentity(result, params.projectRoot) : result;
      }
      return cmosContextUpdate({
        mode: params.mode,
        contextType: params.contextType as 'master_context' | 'project_context' | undefined,
        arrayUpdates: params.arrayUpdates,
        fieldUpdates: params.fieldUpdates,
        since: params.since,
        projectRoot: params.projectRoot,
      } as CmosContextUpdateParams);
    case 'search':
      return cmosContextSearch({
        query: params.query ?? '',
        limit: params.searchLimit,
        types: params.searchTypes as RankedResultType[] | undefined,
        recencyWeight: params.recencyWeight,
        projectRoot: params.projectRoot,
      });
    case 'condense':
      return cmosContextCondense({
        contextType: (params.contextType ?? 'master_context') as
          | 'master_context'
          | 'project_context',
        strategy: params.strategy,
        targetSizePercent: params.targetSizePercent,
        dryRun: params.dryRun,
        projectRoot: params.projectRoot,
      } as CmosContextCondenseParams);
    case 'snapshot':
      return cmosContextSnapshot({
        contextType: (params.contextType ?? 'master_context') as
          | 'master_context'
          | 'project_context',
        source: params.source ?? '',
        sessionId: params.sessionId,
        projectRoot: params.projectRoot,
      } as CmosContextSnapshotParams);
    case 'history':
      return cmosContextHistory({
        contextType: params.contextType as 'master_context' | 'project_context' | undefined,
        since: params.since,
        until: params.until,
        sessionId: params.sessionId,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
      } as CmosContextHistoryParams);
    case 'next_steps':
      return cmosNextSteps({
        nextStepAction: params.nextStepAction ?? 'list',
        nextStepStatus: params.nextStepStatus,
        nextStepIds: params.nextStepIds,
        carryToSprint: params.carryToSprint,
        projectRoot: params.projectRoot,
      } as CmosNextStepsParams);
    case 'constraints':
      return cmosConstraints({
        constraintAction: params.constraintAction ?? 'list',
        constraintStatus: params.constraintStatus,
        constraintIds: params.constraintIds,
        constraintId: params.constraintId,
        stalenessThresholdDays: params.stalenessThresholdDays,
        projectRoot: params.projectRoot,
      } as CmosConstraintsParams);
  }
}

export function formatContextForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosContextResult>,
  contextType?: string
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_context', '', `Error: ${result.error.message}`];

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
    case 'view':
      if (contextType === 'project_identity') {
        return formatProjectIdentityViewForLLM(result as CmosToolResult<ProjectIdentityViewResult>);
      }
      return formatContextViewForLLM(result as CmosToolResult<CmosContextViewResult>);
    case 'update':
      if (contextType === 'project_identity') {
        return formatProjectIdentityUpdateForLLM(
          result as CmosToolResult<ProjectIdentityUpdateResult>
        );
      }
      return formatContextUpdateForLLM(result as CmosToolResult<CmosContextUpdateResult>);
    case 'condense':
      return formatContextCondenseForLLM(result as CmosToolResult<CmosContextCondenseResult>);
    case 'snapshot':
      return formatContextSnapshotForLLM(result as CmosToolResult<CmosContextSnapshotResult>);
    case 'history':
      return formatContextHistoryForLLM(result as CmosToolResult<CmosContextHistoryResult>);
    case 'next_steps':
      return formatNextStepsForLLM(result as CmosToolResult<NextStepsResult>);
    case 'constraints':
      return formatConstraintsForLLM(result as CmosToolResult<ConstraintsResult>);
    case 'search':
      return formatContextSearchForLLM(result as CmosToolResult<ContextSearchResult>);
    default:
      return result.success ? '✓ Context action completed' : '❌ Failed to execute cmos_context';
  }
}
