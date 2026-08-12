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
import type { ActionParamMap, CmosToolResult } from './types';
import {
  cmosLearningsList,
  cmosLearningsListAcrossProjects,
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

/**
 * s86-m04 — which published parameter applies to which action. See action-params.ts for why this
 * is product data rather than a generated artifact.
 *
 * THE ENTRY THAT OPENED THIS ARC: `evergreen` appears under BOTH `update` and `reaffirm`. The
 * router forwarded it only to `update` until s86-m03, so `cmos_learnings(action="reaffirm",
 * evergreen=true)` reported success and wrote nothing — and no gate could see it, because
 * `CmosLearningsReaffirmParams` under-declared the key in the same way. Two lists claiming it is
 * what makes that class of defect red instead of silent.
 *
 * `learningId` likewise appears under `update` AND `reaffirm`. Its description used to read
 * "Learning ID for update action" — wrong in exactly the way this map exists to expose, since
 * per-action tables put that sentence under a `reaffirm` heading that contradicts it. Both the
 * description and the map now say update/reaffirm, and
 * tests/tools/cmos/action-clause-agreement.test.ts keeps them agreeing.
 */
export const CMOS_LEARNINGS_ACTION_PARAMS: ActionParamMap<
  CmosLearningsAction,
  CmosLearningsParams
> = {
  list: [
    'action',
    'category',
    'sprintId',
    'missionId',
    'status',
    'since',
    'until',
    'page',
    'pageSize',
    'acrossProjects',
    'limit',
    'projectRoot',
  ],
  search: ['action', 'category', 'sprintId', 'query', 'limit', 'projectRoot'],
  update: ['action', 'status', 'learningId', 'evergreen', 'projectRoot'],
  reaffirm: ['action', 'learningId', 'evergreen', 'projectRoot'],
};

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
    missionId: z
      .string()
      .optional()
      .describe('s85-m04: filter to rows stamped with this mission (#487 mission -> row trail)'),
    status: z
      // s86-m04 (fork f04, fleet-resolved): four members, not three. CMOS ITSELF writes 'stale'
      // at staleness-detection.ts:494-499, and 246 such rows exist across 7 of 18 registered
      // stores — so the published 3-member enum forbade callers from naming a value the server
      // had been writing for sprints. cmos_decisions never had this bug; that asymmetry is the
      // evidence the enum was wrong, not the data.
      .enum(['active', 'archived', 'superseded', 'stale'])
      .optional()
      .describe(
        'Filter by status for list action, or new status for update action (active | archived | superseded | stale)'
      ),
    since: z.string().optional().describe('ISO date lower bound for list action'),
    until: z.string().optional().describe('ISO date upper bound for list action'),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    acrossProjects: z
      .boolean()
      .optional()
      .describe(
        'list action: learnings tagged `category` across all registered projects (cross-store portfolio view; requires category)'
      ),
    // search params
    query: z.string().optional().describe('Search query for search action (required for search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum results for search action, or the across-project cap for list action'),
    // update params
    learningId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Learning ID for update/reaffirm actions'),
    evergreen: z
      .boolean()
      .optional()
      .describe(
        'Toggle institutional-rule flag. Applies to the update and reaffirm actions. true = exclude from staleness signal; false = clear flag; omitted = leave unchanged.'
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
    `Actions: ${CMOS_LEARNINGS_ACTIONS.join(', ')}. ` +
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
        // s86-m04 (fork f04): NO enum. `learnings.category` is `TEXT` with no CHECK constraint
        // (schema.ts), so publishing a closed set claimed an enforcement the server does not
        // perform — and the fleet already carries an out-of-set value ('voice', Writing-and-
        // Strategy). The four canonical values are guidance, not a contract.
        description: 'Filter by category. Commonly: technical | process | agent-behavior | tooling',
      },
      sprintId: { type: 'string', description: 'Filter by sprint ID' },
      missionId: {
        type: 'string',
        description: 'Filter to rows stamped with this mission (#487 mission -> row trail)',
      },
      status: {
        type: 'string',
        enum: ['active', 'archived', 'superseded', 'stale'],
        description: 'Filter by status (list) or new status (update)',
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
          'list action: learnings tagged `category` across all registered projects (cross-store portfolio view; requires category)',
      },
      query: { type: 'string', description: 'Search query for search action' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum results for search action, or the across-project cap for list action',
      },
      learningId: {
        type: 'integer',
        minimum: 1,
        description: 'Learning ID for update/reaffirm actions',
      },
      evergreen: {
        type: 'boolean',
        description:
          'Toggle institutional-rule flag for the learning. Applies to the update and reaffirm actions. true = exclude from staleness signal; false = clear flag; omitted = leave unchanged.',
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
      // s79-m05: acrossProjects → the §5.4 "learnings tagged X" portfolio query
      // (graph-backed queryAcrossStores). index.ts skips local-root resolution.
      if (params.acrossProjects) {
        return cmosLearningsListAcrossProjects({
          category: params.category,
          limit: params.pageSize ?? params.limit,
        });
      }
      return cmosLearningsList({
        category: params.category,
        sprintId: params.sprintId,
        missionId: params.missionId,
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
        // s86-m03: `evergreen` is declared on this router (zod :94-99 + JSON inputSchema :167-171)
        // with no action scoping, and is forwarded to `update` one branch above — but was dropped
        // here, so `cmos_learnings(action="reaffirm", evergreen=true)` returned success and wrote
        // nothing. A handler-only test would have passed throughout: cmosLearningsReaffirm never
        // received the value to ignore. The real-store read-back fire drives THIS ROUTER, not the
        // handler, and fails if this line is removed.
        evergreen: params.evergreen,
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
