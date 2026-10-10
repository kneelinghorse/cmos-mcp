/**
 * cmos_decisions Tool
 *
 * Consolidated decisions tool with action parameter support.
 * Actions: list, search, update, review, batch_update, record.
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
  cmosDecisionsRecord,
  formatDecisionsRecordForLLM,
  type CmosDecisionsRecordParams,
  type CmosDecisionsRecordResult,
} from './cmos-decisions-record';
import type { CmosDraftRecordResult } from './draft-approval';
import {
  cmosDecisionsBatchUpdate,
  formatDecisionsBatchUpdateForLLM,
  type CmosDecisionsBatchUpdateParams,
  type CmosDecisionsBatchUpdateResult,
} from './cmos-decisions-batch-update';
import {
  cmosDecisionsShow,
  formatDecisionsShowForLLM,
  type CmosDecisionsShowParams,
  type CmosDecisionsShowResult,
} from './cmos-decisions-show';

export const CMOS_DECISIONS_ACTIONS = [
  'list',
  'search',
  'show',
  'update',
  'review',
  'batch_update',
  'record',
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
  // s92-m08: expand one decision by id; retrieval answers carry previews.
  show: ['action', 'decisionId', 'projectRoot'],
  update: ['action', 'decisionId', 'supersededBy', 'status', 'projectRoot'],
  review: ['action', 'includeApproaching', 'projectRoot'],
  batch_update: ['action', 'status', 'decisionIds', 'projectRoot'],
  record: [
    'action',
    'content',
    'fromDraft',
    'context',
    'alternatives',
    'consequences',
    'deciders',
    'mode',
    'missionId',
    'sprintId',
    'supersedes',
    'evidence',
    'citesLearningIds',
    'domain',
    'projectRoot',
  ],
};

export type CmosDecisionsResult =
  | CmosDecisionsListResult
  | CmosDecisionsSearchResult
  | CmosDecisionsUpdateResult
  | CmosDecisionsReviewResult
  | CmosDecisionsBatchUpdateResult
  | CmosDecisionsRecordResult
  | CmosDraftRecordResult
  | CmosDecisionsShowResult;

export const cmosDecisionsSchema = z
  .object({
    action: z
      .enum(CMOS_DECISIONS_ACTIONS)
      // s86-m04: DERIVED. Listed 3 of 5 — review and batch_update were unreachable by reading.
      .describe(`Decisions action: ${CMOS_DECISIONS_ACTIONS.join(' | ')}`),
    // shared params
    domain: z.string().optional().describe('Filter by domain for list/search actions'),
    sprintId: z.string().optional().describe('Filter by sprint ID for list/search actions'),
    missionId: z.string().optional().describe('Only rows recorded for this mission'),
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
    decisionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Decision ID for show/update actions'),
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
    // record params (s91-m04)
    content: z.string().optional().describe('Decision text for record action (required)'),
    context: z.string().optional().describe('record: reasons and background for the decision'),
    alternatives: z.array(z.string()).optional().describe('record: options considered'),
    consequences: z.string().optional().describe('record: effects and tradeoffs'),
    deciders: z.array(z.string()).optional().describe('record: who made the decision'),
    mode: z
      .literal('autonomous')
      .optional()
      .describe('record: declare autonomous work with no operator'),
    // s93-m06
    fromDraft: z
      .string()
      .optional()
      .describe(
        'record action: the CMOS draft id (P<n>) the operator just answered; its kind decides what is written'
      ),
    supersedes: z
      .array(z.number().int().positive())
      .optional()
      .describe('record action: existing decision IDs this decision supersedes'),
    evidence: z
      .array(z.object({ type: z.string().min(1), id: z.string().min(1) }).strict())
      .optional()
      .describe('record action: TraceLab evidence references [{type, id}]'),
    citesLearningIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('record action: learning IDs this decision cites (bumps last_reviewed_at)'),
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
    'Actions: list, search, show, update, review, batch_update, record. ' +
    'Use show to read one decision in full by id: search results and mission start carry ' +
    '300-character previews. ' +
    'Use review to triage stale decisions with scores and suggested actions. ' +
    'Use batch_update to archive/supersede multiple decisions at once. ' +
    'Use record to write a decision without a session: one or two sentences state the choice, ' +
    'context holds the reasons, and consequences holds the effects. alternatives and deciders ' +
    'are optional string arrays. mode=autonomous declares work with no operator. Direct headlines ' +
    'over 600 UTF-16 units succeed with a length warning. Decision text is never amended in ' +
    'place: correct a decision by recording a new one with supersedes=[<old id>]. ' +
    'When the operator answers a CMOS draft (a "Would record:" line CMOS gave an id, P<n>), ' +
    'record it with fromDraft="P<n>": the record then says how the approval was known ' +
    '(approved, agent-judged or agent-attested), and a constraint, rule or profile draft is ' +
    'written as that kind. A subagent shares its parent session and binds as the parent.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_DECISIONS_ACTIONS],
        description: `Decisions action: ${CMOS_DECISIONS_ACTIONS.join(' | ')}`,
      },
      domain: {
        type: 'string',
        description: "Filter by domain; for record, the row's project_domain",
      },
      sprintId: {
        type: 'string',
        description:
          'Filter by sprint ID; for record, an existing sprint to tag when missionId is absent',
      },
      missionId: {
        type: 'string',
        description:
          'Only rows recorded for this mission; for record, the mission to record it for (its sprint is used)',
      },
      content: { type: 'string', description: 'Decision text for record action (required)' },
      context: { type: 'string', description: 'record: reasons and background' },
      alternatives: {
        type: 'array',
        items: { type: 'string' },
        description: 'record: options considered',
      },
      consequences: { type: 'string', description: 'record: effects and tradeoffs' },
      deciders: {
        type: 'array',
        items: { type: 'string' },
        description: 'record: who made the decision',
      },
      mode: {
        type: 'string',
        enum: ['autonomous'],
        description: 'record: autonomous work with no operator',
      },
      fromDraft: {
        type: 'string',
        description:
          'record action: the CMOS draft id (P<n>) the operator just answered; its kind decides what is written',
      },
      supersedes: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'record action: existing decision IDs this decision supersedes; each is set superseded with a pointer to the new row in the same transaction',
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Evidence type' },
            id: { type: 'string', description: 'Evidence identifier' },
          },
          required: ['type', 'id'],
          additionalProperties: false,
        },
        description: 'record action: TraceLab evidence references [{type, id}]',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'record action: learning IDs this decision cites (bumps last_reviewed_at)',
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
        description: 'Decision ID for show/update actions',
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
    case 'show':
      return cmosDecisionsShow({
        decisionId: params.decisionId ?? 0,
        projectRoot: params.projectRoot,
      } satisfies CmosDecisionsShowParams);
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
    case 'record':
      return cmosDecisionsRecord({
        content: params.content ?? '',
        fromDraft: params.fromDraft,
        context: params.context,
        alternatives: params.alternatives,
        consequences: params.consequences,
        deciders: params.deciders,
        mode: params.mode,
        missionId: params.missionId,
        sprintId: params.sprintId,
        supersedes: params.supersedes,
        evidence: params.evidence,
        citesLearningIds: params.citesLearningIds,
        domain: params.domain,
        projectRoot: params.projectRoot,
      } satisfies CmosDecisionsRecordParams);
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
    case 'show':
      return formatDecisionsShowForLLM(result as CmosToolResult<CmosDecisionsShowResult>);
    case 'update':
      return formatDecisionsUpdateForLLM(result as CmosToolResult<CmosDecisionsUpdateResult>);
    case 'review':
      return formatDecisionsReviewForLLM(result as CmosToolResult<CmosDecisionsReviewResult>);
    case 'batch_update':
      return formatDecisionsBatchUpdateForLLM(
        result as CmosToolResult<CmosDecisionsBatchUpdateResult>
      );
    case 'record':
      return formatDecisionsRecordForLLM(result as CmosToolResult<CmosDecisionsRecordResult>);
    default: {
      if (!result.success) return '❌ Failed to execute cmos_decisions';
      const lines = ['✓ Decisions action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
