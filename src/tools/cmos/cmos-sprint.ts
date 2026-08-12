/**
 * cmos_sprint Tool
 *
 * Proof-of-concept consolidated tool for the action-parameterized pattern.
 * This routes actions to the existing sprint handlers without rewriting the
 * underlying sprint business logic.
 *
 * @module tools/cmos/cmos-sprint
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import type { ActionParamMap, CmosToolResult } from './types';
import {
  cmosSprintAdd,
  formatSprintAddForLLM,
  type CmosSprintAddParams,
  type SprintAddResult,
} from './cmos-sprint-add';
import {
  cmosSprintComplete,
  formatSprintCompleteForLLM,
  type CmosSprintCompleteParams,
  type CmosSprintCompleteResult,
} from './cmos-sprint-complete';
import { triggerCheckpointBackfill } from './checkpoint-backfill';
import { maybePropagateSprintStatus } from './sync-locks';
import {
  cmosSprintList,
  formatSprintListForLLM,
  type CmosSprintListParams,
  type CmosSprintListResult,
} from './cmos-sprint-list';
import {
  cmosSprintShow,
  formatSprintShowForLLM,
  type CmosSprintShowParams,
  type SprintShowResult,
} from './cmos-sprint-show';
import {
  cmosSprintUpdate,
  formatSprintUpdateForLLM,
  type CmosSprintUpdateParams,
  type SprintUpdateFields,
  type SprintUpdateResult,
} from './cmos-sprint-update';
import {
  cmosSprintRetro,
  formatSprintRetroForLLM,
  type CmosSprintRetroParams,
  type SprintRetroResult,
} from './cmos-sprint-retro';
import {
  cmosSprintCarryForward,
  formatSprintCarryForwardForLLM,
  type CmosSprintCarryForwardParams,
  type SprintCarryForwardResult,
} from './cmos-sprint-carry-forward';
import {
  cmosSprintAnalytics,
  formatSprintAnalyticsForLLM,
  type CmosSprintAnalyticsParams,
  type SprintAnalyticsResult,
} from './cmos-sprint-analytics';

export const CMOS_SPRINT_ACTIONS = [
  'list',
  'show',
  'add',
  'update',
  'complete',
  'retro',
  'carry_forward',
  'analytics',
] as const;

export type CmosSprintAction = (typeof CMOS_SPRINT_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const CMOS_SPRINT_ACTION_PARAMS: ActionParamMap<CmosSprintAction, CmosSprintParams> = {
  list: ['action', 'status', 'limit', 'projectRoot'],
  show: ['action', 'sprintId', 'projectRoot'],
  add: ['action', 'sprintId', 'title', 'focus', 'status', 'startDate', 'endDate', 'projectRoot'],
  update: ['action', 'sprintId', 'fields', 'projectRoot'],
  // `forceComplete` is retained and forwarded but is a NO-OP since decision #841 demoted the
  // build-freshness gate to advisory. It applies to this action in the sense the contract means —
  // the router accepts and forwards it — and the fact that it now changes nothing belongs in its
  // description, not in a silent omission here.
  complete: [
    'action',
    'sprintId',
    'summary',
    'condensation',
    'targetSizePercent',
    'forceComplete',
    'projectRoot',
  ],
  retro: ['action', 'sprintId', 'projectRoot'],
  carry_forward: ['action', 'sprintId', 'targetAddress', 'send', 'projectRoot'],
  analytics: ['action', 'limit', 'projectRoot'],
};

export type CmosSprintResult =
  | CmosSprintListResult
  | SprintShowResult
  | SprintAddResult
  | SprintUpdateResult
  | CmosSprintCompleteResult
  | SprintRetroResult
  | SprintCarryForwardResult
  | SprintAnalyticsResult;

const cmosSprintFieldsSchema = z
  .object({
    title: z.string().optional().describe('Sprint title'),
    focus: z.string().optional().describe('Strategic focus or theme of the sprint'),
    status: z.string().optional().describe('Sprint status (e.g., "Active", "Completed")'),
    startDate: z.string().optional().describe('Start date in ISO format (e.g., "2025-01-01")'),
    endDate: z.string().optional().describe('End date in ISO format (e.g., "2025-01-15")'),
  })
  .strict();

/**
 * Consolidated schema for all sprint actions.
 * Individual handlers still validate action-specific requirements.
 */
export const cmosSprintSchema = z
  .object({
    action: z
      .enum(CMOS_SPRINT_ACTIONS)
      // s86-m04: DERIVED, not hand-written. This string listed 5 of the 8 members and had
      // shipped that way, so an agent reading it could not learn that retro, carry_forward or
      // analytics exist.
      .describe(`Sprint action: ${CMOS_SPRINT_ACTIONS.join(' | ')}`),
    sprintId: z
      .string()
      .optional()
      .describe('Sprint ID for show/add/update/complete/retro/carry_forward actions'),
    title: z.string().optional().describe('Sprint title for add action'),
    focus: z.string().optional().describe('Strategic focus or theme for add action'),
    status: z.string().optional().describe('Filter or sprint status depending on action'),
    startDate: z.string().optional().describe('Sprint start date for add action'),
    endDate: z.string().optional().describe('Sprint end date for add action'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum sprints to return for list/analytics actions'),
    fields: cmosSprintFieldsSchema.optional().describe('Fields payload for update action'),
    summary: z.string().optional().describe('Closeout summary for complete action'),
    condensation: z
      .enum(['none', 'conservative', 'auto', 'aggressive'])
      .optional()
      .describe('Optional condensation strategy for complete action'),
    targetSizePercent: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Target size percent for complete action condensation'),
    forceComplete: z
      .boolean()
      .optional()
      .describe(
        'No-op for complete action, kept for backward compatibility. Build-freshness is advisory as of the s74 review — staleness is surfaced as a warning and never blocks closeout, so no override is needed.'
      ),
    targetAddress: z
      .string()
      .optional()
      .describe('cmos:// address for carry_forward action (e.g., cmos://derek/cmos-dashboard)'),
    send: z
      .boolean()
      .optional()
      .describe(
        'Whether to actually send messages for carry_forward (default true, false = dry run)'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosSprintParams = z.infer<typeof cmosSprintSchema>;

/**
 * MCP Tool Definition for cmos_sprint.
 */
export const cmosSprintToolDefinition = {
  name: 'cmos_sprint',
  description:
    'Consolidated sprint tool with action parameter support. ' +
    'Actions: list, show, add, update, complete, retro, carry_forward, analytics. ' +
    'Use retro to auto-generate a sprint retrospective report with KPIs, decisions, learnings, and git commit summary. ' +
    'Use carry_forward to detect sync gaps and blocked missions and send backlog_request messages to a target project. ' +
    'Use analytics to compute cross-sprint trend KPIs: velocity, completion rate, decision volume, cycle time.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_SPRINT_ACTIONS],
        description: `Sprint action: ${CMOS_SPRINT_ACTIONS.join(' | ')}`,
      },
      sprintId: {
        type: 'string',
        description: 'Sprint ID for show/add/update/complete/retro/carry_forward actions',
      },
      title: {
        type: 'string',
        description: 'Sprint title for add action',
      },
      focus: {
        type: 'string',
        description: 'Strategic focus or theme for add action',
      },
      status: {
        type: 'string',
        description: 'Filter or sprint status depending on action',
      },
      startDate: {
        type: 'string',
        description: 'Sprint start date for add action',
      },
      endDate: {
        type: 'string',
        description: 'Sprint end date for add action',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum sprints to return for list/analytics actions',
      },
      fields: {
        type: 'object',
        description: 'Fields payload for update action',
        properties: {
          title: { type: 'string', description: 'Sprint title' },
          focus: { type: 'string', description: 'Strategic focus or theme of the sprint' },
          status: { type: 'string', description: 'Sprint status (e.g., "Active", "Completed")' },
          startDate: {
            type: 'string',
            description: 'Start date in ISO format (e.g., "2025-01-01")',
          },
          endDate: {
            type: 'string',
            description: 'End date in ISO format (e.g., "2025-01-15")',
          },
        },
        additionalProperties: false,
      },
      summary: {
        type: 'string',
        description: 'Closeout summary for complete action',
      },
      condensation: {
        type: 'string',
        enum: ['none', 'conservative', 'auto', 'aggressive'],
        description: 'Optional condensation strategy for complete action',
      },
      targetSizePercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Target size percent for complete action condensation',
      },
      forceComplete: {
        type: 'boolean',
        description:
          'No-op for complete action, kept for backward compatibility. Build-freshness is advisory — staleness is surfaced as a warning and never blocks closeout.',
      },
      targetAddress: {
        type: 'string',
        description: 'cmos:// address for carry_forward action (e.g., cmos://derek/cmos-dashboard)',
      },
      send: {
        type: 'boolean',
        description:
          'Whether to actually send messages for carry_forward (default true, false = dry run)',
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

function isSprintAction(value: string): value is CmosSprintAction {
  return (CMOS_SPRINT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Route a consolidated sprint request to the existing action-specific handler.
 */
export async function cmosSprint(
  params: CmosSprintParams
): Promise<CmosToolResult<CmosSprintResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isSprintAction(actionValue)) {
    return createError<CmosSprintResult>(
      CmosErrors.invalidAction('cmos_sprint', actionValue, CMOS_SPRINT_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'list':
      return cmosSprintList({
        status: params.status,
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies CmosSprintListParams);
    case 'show':
      return cmosSprintShow({
        sprintId: params.sprintId ?? '',
        projectRoot: params.projectRoot,
      } satisfies CmosSprintShowParams);
    case 'add':
      return cmosSprintAdd({
        sprintId: params.sprintId ?? '',
        title: params.title ?? '',
        focus: params.focus,
        status: params.status,
        startDate: params.startDate,
        endDate: params.endDate,
        projectRoot: params.projectRoot,
      } satisfies CmosSprintAddParams);
    case 'update': {
      const result = await cmosSprintUpdate({
        sprintId: params.sprintId ?? '',
        fields: (params.fields ?? {}) as SprintUpdateFields,
        projectRoot: params.projectRoot,
      } satisfies CmosSprintUpdateParams);
      // Sprint 72 m02: propagate sprint_status to the broker on a collab store — but only
      // when this update actually touched `status` (a focus/title-only update emits
      // nothing). Resilient + no-op on solo stores (see maybePropagateSprintStatus).
      const statusChanged =
        result.success && (result.data?.updatedFields?.includes('status') ?? false);
      return statusChanged
        ? maybePropagateSprintStatus(result, params.sprintId ?? '', params.projectRoot)
        : result;
    }
    case 'complete': {
      const result = await cmosSprintComplete({
        sprintId: params.sprintId ?? '',
        summary: params.summary ?? '',
        condensation: params.condensation,
        targetSizePercent: params.targetSizePercent,
        forceComplete: params.forceComplete,
        projectRoot: params.projectRoot,
      } satisfies CmosSprintCompleteParams);
      if (result.success) {
        triggerCheckpointBackfill({ projectRoot: params.projectRoot, force: true });
      }
      // Sprint 72 m02: a completed sprint flips status → 'Completed'; propagate it.
      return maybePropagateSprintStatus(result, params.sprintId ?? '', params.projectRoot);
    }
    case 'retro':
      return cmosSprintRetro({
        sprintId: params.sprintId ?? '',
        projectRoot: params.projectRoot,
      } satisfies CmosSprintRetroParams);
    case 'carry_forward':
      return cmosSprintCarryForward({
        sprintId: params.sprintId ?? '',
        targetAddress: params.targetAddress ?? '',
        send: params.send,
        projectRoot: params.projectRoot,
      } satisfies CmosSprintCarryForwardParams);
    case 'analytics':
      return cmosSprintAnalytics({
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies CmosSprintAnalyticsParams);
  }
}

/**
 * Format consolidated sprint responses by delegating to the existing formatter
 * for the selected action. This keeps the POC close to the current output style.
 */
export function formatSprintForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosSprintResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_sprint', '', `Error: ${result.error.message}`];

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
    case 'list':
      return formatSprintListForLLM(result as CmosToolResult<CmosSprintListResult>);
    case 'show':
      return formatSprintShowForLLM(result as CmosToolResult<SprintShowResult>);
    case 'add':
      return formatSprintAddForLLM(result as CmosToolResult<SprintAddResult>);
    case 'update':
      return formatSprintUpdateForLLM(result as CmosToolResult<SprintUpdateResult>);
    case 'complete':
      return formatSprintCompleteForLLM(result as CmosToolResult<CmosSprintCompleteResult>);
    case 'retro':
      return formatSprintRetroForLLM(result as CmosToolResult<SprintRetroResult>);
    case 'carry_forward':
      return formatSprintCarryForwardForLLM(result as CmosToolResult<SprintCarryForwardResult>);
    case 'analytics':
      return formatSprintAnalyticsForLLM(result as CmosToolResult<SprintAnalyticsResult>);
    default:
      return result.success ? '✓ Sprint action completed' : '❌ Failed to execute cmos_sprint';
  }
}
