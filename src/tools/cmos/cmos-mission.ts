/**
 * cmos_mission Tool
 *
 * Consolidated mission CRUD tool with action parameter support.
 * Actions: list, show, status, add, update, depends.
 * Routes to existing mission handlers without rewriting business logic.
 *
 * @module tools/cmos/cmos-mission
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import {
  cmosMissionList,
  formatMissionListForLLM,
  type CmosMissionListParams,
  type CmosMissionListResult,
} from './cmos-mission-list';
import {
  cmosMissionShow,
  formatMissionShowForLLM,
  type CmosMissionShowParams,
  type MissionShowResult,
} from './cmos-mission-show';
import {
  cmosMissionStatus,
  missionStatusAcrossProjects,
  formatMissionStatusForLLM,
  formatMissionPortfolioForLLM,
  type CmosMissionStatusParams,
  type CmosMissionStatusResult,
  type CmosMissionPortfolioResult,
} from './cmos-mission-status';
import {
  cmosMissionAdd,
  formatMissionAddForLLM,
  type CmosMissionAddParams,
  type MissionAddResult,
} from './cmos-mission-add';
import {
  cmosMissionUpdate,
  formatMissionUpdateForLLM,
  type CmosMissionUpdateParams,
  type MissionUpdateResult,
  type MissionUpdateFields,
} from './cmos-mission-update';
import {
  cmosMissionDepends,
  formatMissionDependsForLLM,
  type CmosMissionDependsParams,
  type MissionDependsResult,
} from './cmos-mission-depends';
import {
  cmosMissionUndepends,
  formatMissionUndependsForLLM,
  type CmosMissionUndependsParams,
  type MissionUndependsResult,
} from './cmos-mission-undepends';

export const CMOS_MISSION_ACTIONS = [
  'list',
  'show',
  'status',
  'add',
  'update',
  'depends',
  'undepends',
] as const;

export type CmosMissionAction = (typeof CMOS_MISSION_ACTIONS)[number];

export type CmosMissionResult =
  | CmosMissionListResult
  | MissionShowResult
  | CmosMissionStatusResult
  | CmosMissionPortfolioResult
  | MissionAddResult
  | MissionUpdateResult
  | MissionDependsResult
  | MissionUndependsResult;

const cmosMissionFieldsSchema = z
  .object({
    name: z.string().optional().describe('Mission name/title'),
    status: z.string().optional().describe('Mission status'),
    objective: z.string().optional().describe('Mission objective'),
    context: z
      .union([z.string(), z.record(z.unknown())])
      .optional()
      .describe('Background context'),
    successCriteria: z.array(z.string()).optional().describe('Success criteria'),
    deliverables: z.array(z.string()).optional().describe('Deliverables'),
    referenceDocs: z.array(z.string()).optional().describe('Reference docs'),
    domainFields: z.record(z.unknown()).optional().describe('Domain-specific fields'),
    notes: z.string().optional().describe('Notes'),
    metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
  })
  .strict();

export const cmosMissionSchema = z
  .object({
    action: z
      .enum(CMOS_MISSION_ACTIONS)
      .describe('Mission action: list | show | status | add | update | depends | undepends'),
    missionId: z.string().optional().describe('Mission ID for show/add/update actions'),
    sprintId: z.string().optional().describe('Sprint ID for list filter or add action'),
    status: z.string().optional().describe('Status filter for list action'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum missions to return for list action'),
    includeBlocked: z.boolean().optional().describe('Include blocked missions in status action'),
    acrossProjects: z
      .boolean()
      .optional()
      .describe(
        'status action: active missions (In Progress/Current) across all registered projects (cross-store portfolio view)'
      ),
    queuedLimit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum queued missions for status action'),
    name: z.string().optional().describe('Mission name for add action'),
    objective: z.string().optional().describe('Mission objective for add action'),
    context: z
      .union([z.string(), z.record(z.unknown())])
      .optional()
      .describe('Mission context for add action'),
    successCriteria: z.array(z.string()).optional().describe('Success criteria for add action'),
    deliverables: z.array(z.string()).optional().describe('Deliverables for add action'),
    referenceDocs: z.array(z.string()).optional().describe('Reference docs for add action'),
    domainFields: z.record(z.unknown()).optional().describe('Domain fields for add action'),
    notes: z.string().optional().describe('Notes for add action'),
    fields: cmosMissionFieldsSchema.optional().describe('Fields payload for update action'),
    fromId: z.string().optional().describe('Dependent mission ID for depends action'),
    toId: z.string().optional().describe('Dependency mission ID for depends action'),
    type: z
      .enum(['Blocks', 'Requires', 'Enables'])
      .optional()
      .describe('Dependency type for depends action'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosMissionParams = z.infer<typeof cmosMissionSchema>;

export const cmosMissionToolDefinition = {
  name: 'cmos_mission',
  description:
    'Consolidated mission tool with action parameter support. ' +
    'Actions: list, show, status, add, update, depends, undepends. ' +
    'Routes to the existing mission handlers without changing mission business logic.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_MISSION_ACTIONS],
        description: 'Mission action: list | show | status | add | update | depends | undepends',
      },
      missionId: {
        type: 'string',
        description: 'Mission ID for show/add/update actions',
      },
      sprintId: {
        type: 'string',
        description: 'Sprint ID for list filter or add action',
      },
      status: {
        type: 'string',
        description: 'Status filter for list action',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Maximum missions to return for list action',
      },
      includeBlocked: {
        type: 'boolean',
        description: 'Include blocked missions in status action',
      },
      queuedLimit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        description: 'Maximum queued missions for status action',
      },
      name: {
        type: 'string',
        description: 'Mission name for add action',
      },
      objective: {
        type: 'string',
        description: 'Mission objective for add action',
      },
      context: {
        type: ['string', 'object'],
        description: 'Mission context for add action (string or object)',
      },
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Success criteria for add action',
      },
      deliverables: {
        type: 'array',
        items: { type: 'string' },
        description: 'Deliverables for add action',
      },
      referenceDocs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference docs for add action',
      },
      domainFields: {
        type: 'object',
        description: 'Domain-specific fields for add action',
      },
      notes: {
        type: 'string',
        description: 'Notes for add action',
      },
      fields: {
        type: 'object',
        description: 'Fields payload for update action',
        properties: {
          name: { type: 'string', description: 'Mission name/title' },
          status: { type: 'string', description: 'Mission status' },
          objective: { type: 'string', description: 'Mission objective' },
          context: { type: ['string', 'object'], description: 'Background context' },
          successCriteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Success criteria',
          },
          deliverables: { type: 'array', items: { type: 'string' }, description: 'Deliverables' },
          referenceDocs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Reference docs',
          },
          domainFields: { type: 'object', description: 'Domain-specific fields' },
          notes: { type: 'string', description: 'Notes' },
          metadata: { type: 'object', description: 'Additional metadata' },
        },
        additionalProperties: false,
      },
      fromId: {
        type: 'string',
        description: 'Dependent mission ID for depends action',
      },
      toId: {
        type: 'string',
        description: 'Dependency mission ID for depends action',
      },
      type: {
        type: 'string',
        enum: ['Blocks', 'Requires', 'Enables'],
        description: 'Dependency type for depends action',
      },
      acrossProjects: {
        type: 'boolean',
        description:
          'status action: active missions (In Progress/Current) across all registered projects (cross-store portfolio view)',
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

function isMissionAction(value: string): value is CmosMissionAction {
  return (CMOS_MISSION_ACTIONS as readonly string[]).includes(value);
}

export async function cmosMission(
  params: CmosMissionParams
): Promise<CmosToolResult<CmosMissionResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isMissionAction(actionValue)) {
    return createError<CmosMissionResult>(
      CmosErrors.invalidAction('cmos_mission', actionValue, CMOS_MISSION_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'list':
      return cmosMissionList({
        sprintId: params.sprintId,
        status: params.status as CmosMissionListParams['status'],
        limit: params.limit,
        projectRoot: params.projectRoot,
      });
    case 'show':
      return cmosMissionShow({
        missionId: params.missionId ?? '',
        projectRoot: params.projectRoot,
      } satisfies CmosMissionShowParams);
    case 'status':
      // s79-m05: acrossProjects → the §5.4 active-missions portfolio query (graph-
      // backed queryAcrossStores), NOT the single-store work queue. index.ts skips
      // local-root resolution for this branch.
      if (params.acrossProjects) {
        return missionStatusAcrossProjects({ limit: params.limit });
      }
      return cmosMissionStatus({
        includeBlocked: params.includeBlocked,
        queuedLimit: params.queuedLimit,
        projectRoot: params.projectRoot,
      } satisfies CmosMissionStatusParams);
    case 'add':
      return cmosMissionAdd({
        missionId: params.missionId ?? '',
        name: params.name ?? '',
        sprintId: params.sprintId ?? '',
        status: params.status as CmosMissionAddParams['status'],
        objective: params.objective,
        context: params.context,
        successCriteria: params.successCriteria,
        deliverables: params.deliverables,
        referenceDocs: params.referenceDocs,
        domainFields: params.domainFields,
        notes: params.notes,
        projectRoot: params.projectRoot,
      });
    case 'update':
      return cmosMissionUpdate({
        missionId: params.missionId ?? '',
        fields: (params.fields ?? {}) as MissionUpdateFields,
        projectRoot: params.projectRoot,
      } satisfies CmosMissionUpdateParams);
    case 'depends':
      return cmosMissionDepends({
        fromId: params.fromId ?? '',
        toId: params.toId ?? '',
        type: (params.type ?? 'Requires') as CmosMissionDependsParams['type'],
        projectRoot: params.projectRoot,
      } satisfies CmosMissionDependsParams);
    case 'undepends':
      return cmosMissionUndepends({
        fromId: params.fromId ?? '',
        toId: params.toId ?? '',
        projectRoot: params.projectRoot,
      } satisfies CmosMissionUndependsParams);
  }
}

export function formatMissionForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosMissionResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_mission', '', `Error: ${result.error.message}`];

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
      return formatMissionListForLLM(result as CmosToolResult<CmosMissionListResult>);
    case 'show':
      return formatMissionShowForLLM(result as CmosToolResult<MissionShowResult>);
    case 'status':
      // s79-m05: the acrossProjects branch returns the flat portfolio envelope.
      if (result.success && result.data && 'acrossProjects' in result.data) {
        return formatMissionPortfolioForLLM(result as CmosToolResult<CmosMissionPortfolioResult>);
      }
      return formatMissionStatusForLLM(result as CmosToolResult<CmosMissionStatusResult>);
    case 'add':
      return formatMissionAddForLLM(result as CmosToolResult<MissionAddResult>);
    case 'update':
      return formatMissionUpdateForLLM(result as CmosToolResult<MissionUpdateResult>);
    case 'depends':
      return formatMissionDependsForLLM(result as CmosToolResult<MissionDependsResult>);
    case 'undepends':
      return formatMissionUndependsForLLM(result as CmosToolResult<MissionUndependsResult>);
    default:
      return result.success ? '✓ Mission action completed' : '❌ Failed to execute cmos_mission';
  }
}
