/**
 * cmos_learnings Tool
 *
 * Consolidated learnings tool with action parameter support.
 * Actions: list, search, update.
 * Routes to existing learnings handlers without rewriting business logic.
 *
 * @module tools/cmos/cmos-learnings
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import {
  cmosLearningsList,
  formatLearningsListForLLM,
  type CmosLearningsListParams,
  type CmosLearningsListResult,
} from './cmos-learnings-list';
import {
  cmosLearningsSearch,
  formatLearningsSearchForLLM,
  type CmosLearningsSearchParams,
  type CmosLearningsSearchResult,
} from './cmos-learnings-search';
import {
  cmosLearningsUpdate,
  formatLearningsUpdateForLLM,
  type CmosLearningsUpdateParams,
  type CmosLearningsUpdateResult,
} from './cmos-learnings-update';
import {
  cmosLearningsReaffirm,
  formatLearningsReaffirmForLLM,
  type CmosLearningsReaffirmParams,
  type CmosLearningsReaffirmResult,
} from './cmos-learnings-reaffirm';

export const CMOS_LEARNINGS_ACTIONS = ['list', 'search', 'update', 'reaffirm'] as const;

export type CmosLearningsAction = (typeof CMOS_LEARNINGS_ACTIONS)[number];

export type CmosLearningsResult =
  | CmosLearningsListResult
  | CmosLearningsSearchResult
  | CmosLearningsUpdateResult
  | CmosLearningsReaffirmResult;

export const cmosLearningsSchema = z
  .object({
    action: z
      .enum(CMOS_LEARNINGS_ACTIONS)
      .describe('Learnings action: list | search | update | reaffirm'),
    // list params
    category: z
      .string()
      .optional()
      .describe(
        'Filter by category for list/search actions (technical | process | agent-behavior | tooling)'
      ),
    sprintId: z.string().optional().describe('Filter by sprint ID for list/search actions'),
    status: z
      .string()
      .optional()
      .describe(
        'Filter by status for list action, or new status for update action (active | archived | superseded)'
      ),
    since: z.string().optional().describe('ISO date lower bound for list action'),
    until: z.string().optional().describe('ISO date upper bound for list action'),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    // search params
    query: z.string().optional().describe('Search query for search action (required for search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum results for search action'),
    // update params
    learningId: z.number().int().positive().optional().describe('Learning ID for update action'),
    evergreen: z
      .boolean()
      .optional()
      .describe(
        'Sprint 61 m03 — toggle institutional-rule flag. true = exclude from staleness signal; false = clear flag.'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosLearningsParams = z.infer<typeof cmosLearningsSchema>;

export const cmosLearningsToolDefinition = {
  name: 'cmos_learnings',
  description:
    'Consolidated learnings tool with action parameter support. ' +
    'Actions: list, search, update. ' +
    'Use list to browse learnings with category/sprint/status filters. ' +
    'Use search to find learnings by keyword. ' +
    'Use update to change status (active, archived, superseded). ' +
    'Use reaffirm to mark an evergreen learning as still valid (bumps last_reviewed_at without changing status).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_LEARNINGS_ACTIONS],
        description: 'Learnings action: list | search | update | reaffirm',
      },
      category: {
        type: 'string',
        enum: ['technical', 'process', 'agent-behavior', 'tooling'],
        description: 'Filter by category',
      },
      sprintId: { type: 'string', description: 'Filter by sprint ID' },
      status: {
        type: 'string',
        enum: ['active', 'archived', 'superseded'],
        description: 'Filter by status (list) or new status (update)',
      },
      since: { type: 'string', description: 'ISO date lower bound for list action' },
      until: { type: 'string', description: 'ISO date upper bound for list action' },
      page: { type: 'number', minimum: 1, description: 'Page number for list action' },
      pageSize: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Page size for list action',
      },
      query: { type: 'string', description: 'Search query for search action' },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        description: 'Maximum results for search action',
      },
      learningId: {
        type: 'number',
        minimum: 1,
        description: 'Learning ID for update action',
      },
      evergreen: {
        type: 'boolean',
        description:
          'Toggle institutional-rule flag for the learning. true = exclude from staleness signal; false = clear flag (Sprint 61 m03).',
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

function isLearningsAction(value: string): value is CmosLearningsAction {
  return (CMOS_LEARNINGS_ACTIONS as readonly string[]).includes(value);
}

export async function cmosLearnings(
  params: CmosLearningsParams
): Promise<CmosToolResult<CmosLearningsResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isLearningsAction(actionValue)) {
    return createError<CmosLearningsResult>(
      CmosErrors.invalidAction('cmos_learnings', actionValue, CMOS_LEARNINGS_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'list':
      return cmosLearningsList({
        category: params.category,
        sprintId: params.sprintId,
        status: params.status,
        since: params.since,
        until: params.until,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
      } satisfies CmosLearningsListParams);
    case 'search':
      return cmosLearningsSearch({
        query: params.query ?? '',
        category: params.category,
        sprintId: params.sprintId,
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies CmosLearningsSearchParams);
    case 'update':
      return cmosLearningsUpdate({
        learningId: params.learningId ?? 0,
        status: params.status,
        evergreen: params.evergreen,
        projectRoot: params.projectRoot,
      } satisfies CmosLearningsUpdateParams);
    case 'reaffirm':
      return cmosLearningsReaffirm({
        learningId: params.learningId ?? 0,
        projectRoot: params.projectRoot,
      } satisfies CmosLearningsReaffirmParams);
  }
}

export function formatLearningsForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosLearningsResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_learnings', '', `Error: ${result.error.message}`];

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
      return formatLearningsListForLLM(result as CmosToolResult<CmosLearningsListResult>);
    case 'search':
      return formatLearningsSearchForLLM(result as CmosToolResult<CmosLearningsSearchResult>);
    case 'update':
      return formatLearningsUpdateForLLM(result as CmosToolResult<CmosLearningsUpdateResult>);
    case 'reaffirm':
      return formatLearningsReaffirmForLLM(result as CmosToolResult<CmosLearningsReaffirmResult>);
    default:
      return result.success
        ? '✓ Learnings action completed'
        : '❌ Failed to execute cmos_learnings';
  }
}
