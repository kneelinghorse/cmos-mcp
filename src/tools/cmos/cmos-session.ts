/**
 * cmos_session Tool
 *
 * Consolidated session tool with action parameter support.
 * Actions: list, start, capture, complete.
 * Routes to existing session handlers without rewriting business logic.
 *
 * @module tools/cmos/cmos-session
 */

import { z } from 'zod';
import { createError, CmosErrors, VALID_SESSION_TYPES } from './errors';
import type { CmosToolResult } from './types';
import {
  cmosSessionList,
  formatSessionListForLLM,
  VALID_SESSION_STATUSES,
  type CmosSessionListParams,
  type CmosSessionListResult,
} from './cmos-session-list';
import {
  cmosSessionStart,
  formatSessionStartForLLM,
  type CmosSessionStartParams,
  type CmosSessionStartResult,
} from './cmos-session-start';
import {
  cmosSessionCapture,
  formatSessionCaptureForLLM,
  VALID_CAPTURE_CATEGORIES,
  type CmosSessionCaptureParams,
  type CmosSessionCaptureResult,
} from './cmos-session-capture';
import {
  cmosSessionComplete,
  formatSessionCompleteForLLM,
  type CmosSessionCompleteParams,
  type CmosSessionCompleteResult,
} from './cmos-session-complete';
import {
  cmosSessionSearch,
  formatSessionSearchForLLM,
  type CmosSessionSearchResult,
} from './cmos-session-search';
import { triggerCheckpointBackfill } from './checkpoint-backfill';

export const CMOS_SESSION_ACTIONS = ['list', 'start', 'capture', 'complete', 'search'] as const;

export type CmosSessionAction = (typeof CMOS_SESSION_ACTIONS)[number];

export type CmosSessionResult =
  | CmosSessionListResult
  | CmosSessionStartResult
  | CmosSessionCaptureResult
  | CmosSessionCompleteResult
  | CmosSessionSearchResult;

export const cmosSessionSchema = z
  .object({
    action: z
      .enum(CMOS_SESSION_ACTIONS)
      .describe('Session action: list | start | capture | complete | search'),
    // search params (s77-m05) — query/since/until/limit; type/category reused below
    query: z
      .string()
      .optional()
      .describe('Search query for search action (keywords across titles, summaries, captures)'),
    since: z.string().optional().describe('Filter sessions started after this ISO date (search)'),
    until: z.string().optional().describe('Filter sessions started before this ISO date (search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum sessions to return for search action (1-100, default: 20)'),
    // list params
    status: z
      .enum(VALID_SESSION_STATUSES)
      .optional()
      .describe('Filter by session status for list action'),
    type: z
      .enum(VALID_SESSION_TYPES)
      .optional()
      .describe('Session type filter for list, or type for start action'),
    sprintId: z.string().optional().describe('Sprint ID filter for list action'),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    // start params
    title: z.string().optional().describe('Session title for start action (required for start)'),
    agent: z.string().optional().describe('Agent identifier for start/capture/complete actions'),
    autoRefreshMasterContext: z
      .boolean()
      .optional()
      .describe('Auto-refresh master context on start'),
    // capture params
    sessionId: z
      .string()
      .optional()
      .describe('Session ID (auto-detected if omitted) for capture/complete actions'),
    category: z
      .enum(VALID_CAPTURE_CATEGORIES)
      .optional()
      .describe('Capture category for capture action (required for capture)'),
    content: z
      .string()
      .optional()
      .describe('Capture content for capture action (required for capture)'),
    context: z.string().optional().describe('Additional context for capture action'),
    missionId: z
      .string()
      .optional()
      .describe(
        'Associated mission ID. On capture, stamps the decision/learning/next-step row; on complete, stamps the decisions[] and nextSteps[] rows this call materializes.'
      ),
    evidence: z
      .array(z.object({ type: z.string(), id: z.string() }))
      .optional()
      .describe('Array of TraceLab evidence references [{type, id}] for decision captures'),
    citesLearningIds: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Learning IDs this capture/decision cites. Bumps last_reviewed_at on each — applies to capture(category=decision|learning) and complete(decisions[]).'
      ),
    // complete params
    summary: z
      .string()
      .optional()
      .describe('Session summary for complete action (required for complete)'),
    nextSteps: z.array(z.string()).optional().describe('Next steps for complete action'),
    decisions: z
      .array(z.string())
      .optional()
      .describe(
        'Decisions captured at session close; each entry is inserted into strategic_decisions'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosSessionParams = z.infer<typeof cmosSessionSchema>;

export const cmosSessionToolDefinition = {
  name: 'cmos_session',
  description:
    'Consolidated session tool with action parameter support. ' +
    'Actions: list, start, capture, complete, search. ' +
    'Routes to the existing session handlers without changing session business logic.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_SESSION_ACTIONS],
        description: 'Session action: list | start | capture | complete | search',
      },
      query: {
        type: 'string',
        description: 'Search query for search action (keywords across titles, summaries, captures)',
      },
      since: {
        type: 'string',
        description: 'Filter sessions started after this ISO date (search action)',
      },
      until: {
        type: 'string',
        description: 'Filter sessions started before this ISO date (search action)',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Maximum sessions to return for search action (1-100, default: 20)',
      },
      status: {
        type: 'string',
        enum: [...VALID_SESSION_STATUSES],
        description: 'Filter by session status for list action',
      },
      type: {
        type: 'string',
        enum: [...VALID_SESSION_TYPES],
        description: 'Session type for list/start actions',
      },
      sprintId: { type: 'string', description: 'Sprint ID filter for list action' },
      page: { type: 'number', minimum: 1, description: 'Page number for list action' },
      pageSize: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Page size for list action',
      },
      title: { type: 'string', description: 'Session title for start action' },
      agent: { type: 'string', description: 'Agent identifier for start/capture/complete actions' },
      autoRefreshMasterContext: {
        type: 'boolean',
        description: 'Auto-refresh master context on start',
      },
      sessionId: { type: 'string', description: 'Session ID for capture/complete actions' },
      category: {
        type: 'string',
        enum: [...VALID_CAPTURE_CATEGORIES],
        description: 'Capture category for capture action',
      },
      content: { type: 'string', description: 'Capture content for capture action' },
      context: { type: 'string', description: 'Additional context for capture action' },
      missionId: {
        type: 'string',
        description:
          'Associated mission ID. On capture, stamps the decision/learning/next-step row; on complete, stamps the decisions[] and nextSteps[] rows this call materializes.',
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
        },
        description: 'Array of TraceLab evidence references [{type, id}] for decision captures',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'Learning IDs this capture/decision cites. Bumps last_reviewed_at on each — applies to capture(category=decision|learning) and complete(decisions[]).',
      },
      summary: { type: 'string', description: 'Session summary for complete action' },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Next steps for complete action',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Decisions captured at session close; each entry is inserted into strategic_decisions',
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

function isSessionAction(value: string): value is CmosSessionAction {
  return (CMOS_SESSION_ACTIONS as readonly string[]).includes(value);
}

export async function cmosSession(
  params: CmosSessionParams
): Promise<CmosToolResult<CmosSessionResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isSessionAction(actionValue)) {
    return createError<CmosSessionResult>(
      CmosErrors.invalidAction('cmos_session', actionValue, CMOS_SESSION_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'list':
      return cmosSessionList({
        status: params.status,
        type: params.type,
        sprintId: params.sprintId,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
      } as CmosSessionListParams);
    case 'start':
      return cmosSessionStart({
        type: params.type ?? ('planning' as CmosSessionStartParams['type']),
        title: params.title ?? '',
        agent: params.agent,
        sprintId: params.sprintId,
        autoRefreshMasterContext: params.autoRefreshMasterContext,
        projectRoot: params.projectRoot,
      } as CmosSessionStartParams);
    case 'capture':
      return cmosSessionCapture({
        sessionId: params.sessionId,
        category: params.category ?? ('context' as CmosSessionCaptureParams['category']),
        content: params.content ?? '',
        context: params.context,
        missionId: params.missionId,
        evidence: params.evidence,
        agent: params.agent,
        citesLearningIds: params.citesLearningIds,
        projectRoot: params.projectRoot,
      } as CmosSessionCaptureParams);
    case 'complete': {
      const result = await cmosSessionComplete({
        sessionId: params.sessionId,
        summary: params.summary ?? '',
        nextSteps: params.nextSteps,
        decisions: params.decisions,
        // s85-m04: `missionId` is declared on this router (zod + JSON inputSchema) and was
        // forwarded to `capture` but NOT here — so wiring it into cmosSessionComplete alone
        // would pass every handler test and ship DEAD over the real MCP surface, silently
        // returning null. That is the s80-m07 shape. The real-store positive fire drives this
        // router, not the handler, and fails if this line is removed.
        missionId: params.missionId,
        agent: params.agent,
        citesLearningIds: params.citesLearningIds,
        projectRoot: params.projectRoot,
      } as CmosSessionCompleteParams);
      if (result.success) {
        triggerCheckpointBackfill({ projectRoot: params.projectRoot, force: false });
      }
      return result;
    }
    case 'search':
      // `?? ''` mirrors start/capture: a missing query reaches the handler as ''
      // and surfaces its own MISSING_PARAMETER('query').
      return cmosSessionSearch({
        query: params.query ?? '',
        category: params.category,
        type: params.type,
        since: params.since,
        until: params.until,
        limit: params.limit,
        projectRoot: params.projectRoot,
      });
  }
}

export function formatSessionForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosSessionResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_session', '', `Error: ${result.error.message}`];

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
      return formatSessionListForLLM(result as CmosToolResult<CmosSessionListResult>);
    case 'start':
      return formatSessionStartForLLM(result as CmosToolResult<CmosSessionStartResult>);
    case 'capture':
      return formatSessionCaptureForLLM(result as CmosToolResult<CmosSessionCaptureResult>);
    case 'complete':
      return formatSessionCompleteForLLM(result as CmosToolResult<CmosSessionCompleteResult>);
    case 'search':
      return formatSessionSearchForLLM(result as CmosToolResult<CmosSessionSearchResult>);
    default:
      return result.success ? '✓ Session action completed' : '❌ Failed to execute cmos_session';
  }
}
