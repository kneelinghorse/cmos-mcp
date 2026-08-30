/**
 * cmos_decisions Tool
 *
 * Consolidated decisions tool with action parameter support.
 * Actions: list, search.
 * Routes to existing decisions handlers without rewriting business logic.
 *
 * @module tools/cmos/cmos-decisions
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, CmosToolResult } from './types';
import {
  cmosDecisionsList,
  formatDecisionsListForLLM,
  type CmosDecisionsListParams,
  type CmosDecisionsListResult,
} from './cmos-decisions-list';
import {
  cmosDecisionsSearch,
  formatDecisionsSearchForLLM,
  type CmosDecisionsSearchParams,
  type CmosDecisionsSearchResult,
} from './cmos-decisions-search';
import {
  cmosDecisionsUpdate,
  formatDecisionsUpdateForLLM,
  type CmosDecisionsUpdateParams,
  type CmosDecisionsUpdateResult,
} from './cmos-decisions-update';
import {
  cmosDecisionsReview,
  formatDecisionsReviewForLLM,
  type CmosDecisionsReviewParams,
  type CmosDecisionsReviewResult,
} from './cmos-decisions-review';
import {
  cmosDecisionsBatchUpdate,
  formatDecisionsBatchUpdateForLLM,
  type CmosDecisionsBatchUpdateParams,
  type CmosDecisionsBatchUpdateResult,
} from './cmos-decisions-batch-update';

export const CMOS_DECISIONS_ACTIONS = [
  'list',
  'search',
  'update',
  'review',
  'batch_update',
] as const;

export type CmosDecisionsAction = (typeof CMOS_DECISIONS_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const CMOS_DECISIONS_ACTION_PARAMS: ActionParamMap<
  CmosDecisionsAction,
  CmosDecisionsParams
> = {
  list: [
    'action',
    'domain',
    'sprintId',
    'missionId',
    'since',
    'until',
    'page',
    'pageSize',
    'acrossProjects',
    'projectRoot',
  ],
  search: ['action', 'domain', 'sprintId', 'query', 'limit', 'projectRoot'],
  update: ['action', 'decisionId', 'supersededBy', 'status', 'projectRoot'],
  review: ['action', 'includeApproaching', 'projectRoot'],
  batch_update: ['action', 'status', 'decisionIds', 'projectRoot'],
};

export type CmosDecisionsResult =
  | CmosDecisionsListResult
  | CmosDecisionsSearchResult
  | CmosDecisionsUpdateResult
  | CmosDecisionsReviewResult
  | CmosDecisionsBatchUpdateResult;

export const cmosDecisionsSchema = z
  .object({
    action: z
      .enum(CMOS_DECISIONS_ACTIONS)
      // s86-m04: DERIVED. Listed 3 of 5 — review and batch_update were unreachable by reading.
      .describe(`Decisions action: ${CMOS_DECISIONS_ACTIONS.join(' | ')}`),
    // shared params
    domain: z.string().optional().describe('Filter by domain for list/search actions'),
    sprintId: z.string().optional().describe('Filter by sprint ID for list/search actions'),
    missionId: z
      .string()
      .optional()
      .describe('s85-m04: filter to rows stamped with this mission (#487 mission -> row trail)'),
    // list params
    since: z.string().optional().describe('ISO date lower bound for list action'),
    until: z.string().optional().describe('ISO date upper bound for list action'),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    acrossProjects: z
      .boolean()
      .optional()
      .describe('list action: fan out across all registered projects (cross-store portfolio view)'),
    // search params
    query: z.string().optional().describe('Search query for search action (required for search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum results for search action'),
    // update params
    decisionId: z.number().int().positive().optional().describe('Decision ID for update action'),
    supersededBy: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('ID of the decision that supersedes this one (for update action)'),
    status: z
      // s86-m04: matches the published JSON enum exactly. Fleet-verified safe — no stored
      // strategic_decisions.status across the 18 registered stores falls outside these four.
      .enum(['active', 'superseded', 'archived', 'stale'])
      .optional()
      .describe(
        'New status for update/batch_update action (active | superseded | archived | stale)'
      ),
    // review params
    includeApproaching: z
      .boolean()
      .optional()
      .describe('Include decisions approaching staleness in review (default true)'),
    // batch_update params
    decisionIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('Array of decision IDs for batch_update action (max 100)'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosDecisionsParams = z.infer<typeof cmosDecisionsSchema>;

export const cmosDecisionsToolDefinition = {
  name: 'cmos_decisions',
  description:
    'Consolidated decisions tool with action parameter support. ' +
    'Actions: list, search, update, review, batch_update. ' +
    'Use review to triage stale decisions with scores and suggested actions. ' +
    'Use batch_update to archive/supersede multiple decisions at once.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_DECISIONS_ACTIONS],
        description: `Decisions action: ${CMOS_DECISIONS_ACTIONS.join(' | ')}`,
      },
      domain: { type: 'string', description: 'Filter by domain' },
      sprintId: { type: 'string', description: 'Filter by sprint ID' },
      missionId: {
        type: 'string',
        description: 'Filter to rows stamped with this mission (#487 mission -> row trail)',
      },
      since: { type: 'string', description: 'ISO date lower bound for list action' },
      until: { type: 'string', description: 'ISO date upper bound for list action' },
      page: { type: 'integer', minimum: 1, description: 'Page number for list action' },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Page size for list action',
      },
      acrossProjects: {
        type: 'boolean',
        description:
          'list action: fan out across all registered projects (cross-store portfolio view)',
      },
      query: { type: 'string', description: 'Search query for search action' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum results for search action',
      },
      decisionId: {
        type: 'integer',
        minimum: 1,
        description: 'Decision ID for update action',
      },
      supersededBy: {
        type: 'integer',
        minimum: 1,
        description: 'ID of the decision that supersedes this one (for update action)',
      },
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'archived', 'stale'],
        description: 'New status for update/batch_update action',
      },
      includeApproaching: {
        type: 'boolean',
        description: 'Include decisions approaching staleness in review (default true)',
      },
      decisionIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'Array of decision IDs for batch_update action (max 100)',
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

function isDecisionsAction(value: string): value is CmosDecisionsAction {
  return (CMOS_DECISIONS_ACTIONS as readonly string[]).includes(value);
}

export async function cmosDecisions(
  params: CmosDecisionsParams
): Promise<CmosToolResult<CmosDecisionsResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isDecisionsAction(actionValue)) {
    return createError<CmosDecisionsResult>(
      CmosErrors.invalidAction('cmos_decisions', actionValue, CMOS_DECISIONS_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    cmosDecisionsToolDefinition.inputSchema,
    CMOS_DECISIONS_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<CmosDecisionsResult>(wrongTypedParam);

  switch (actionValue) {
    case 'list':
      return cmosDecisionsList({
        domain: params.domain,
        sprintId: params.sprintId,
        missionId: params.missionId,
        since: params.since,
        until: params.until,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
        acrossProjects: params.acrossProjects,
      } satisfies CmosDecisionsListParams);
    case 'search':
      return cmosDecisionsSearch({
        query: params.query ?? '',
        domain: params.domain,
        sprintId: params.sprintId,
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies CmosDecisionsSearchParams);
    case 'update':
      return cmosDecisionsUpdate({
        decisionId: params.decisionId ?? 0,
        supersededBy: params.supersededBy,
        status: params.status,
        projectRoot: params.projectRoot,
      } satisfies CmosDecisionsUpdateParams);
    case 'review':
      return cmosDecisionsReview({
        includeApproaching: params.includeApproaching,
        projectRoot: params.projectRoot,
      } satisfies CmosDecisionsReviewParams);
    case 'batch_update':
      return cmosDecisionsBatchUpdate({
        decisionIds: params.decisionIds ?? [],
        status: params.status ?? '',
        projectRoot: params.projectRoot,
      } satisfies CmosDecisionsBatchUpdateParams);
  }
}

export function formatDecisionsForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosDecisionsResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_decisions', '', `Error: ${result.error.message}`];

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
      return formatDecisionsListForLLM(result as CmosToolResult<CmosDecisionsListResult>);
    case 'search':
      return formatDecisionsSearchForLLM(result as CmosToolResult<CmosDecisionsSearchResult>);
    case 'update':
      return formatDecisionsUpdateForLLM(result as CmosToolResult<CmosDecisionsUpdateResult>);
    case 'review':
      return formatDecisionsReviewForLLM(result as CmosToolResult<CmosDecisionsReviewResult>);
    case 'batch_update':
      return formatDecisionsBatchUpdateForLLM(
        result as CmosToolResult<CmosDecisionsBatchUpdateResult>
      );
    default: {
      if (!result.success) return '❌ Failed to execute cmos_decisions';
      const lines = ['✓ Decisions action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
