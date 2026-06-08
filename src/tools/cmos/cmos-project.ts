/**
 * cmos_project Tool
 *
 * Consolidated project tool with action parameter support.
 * Actions: init, register, list, unregister, validate, update, sweep.
 * Routes to existing project handlers without rewriting business logic.
 * Note: list action supports optional validate flag that runs validation.
 *
 * @module tools/cmos/cmos-project
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import {
  cmosProjectInit,
  formatProjectInitForLLM,
  type CmosProjectInitInput,
  type CmosProjectInitResult,
} from './cmos-project-init';
import {
  cmosProjectRegister,
  formatProjectRegisterForLLM,
  type CmosProjectRegisterParams,
  type ProjectRegisterResult,
} from './cmos-project-register';
import {
  cmosProjectList,
  formatProjectListForLLM,
  type CmosProjectListParams,
  type ProjectListResult,
} from './cmos-project-list';
import {
  cmosProjectUnregister,
  formatProjectUnregisterForLLM,
  type CmosProjectUnregisterParams,
  type ProjectUnregisterResult,
} from './cmos-project-unregister';
import {
  cmosProjectValidate,
  formatProjectValidateForLLM,
  type CmosProjectValidateParams,
  type ProjectValidateResult,
} from './cmos-project-validate';
import {
  cmosProjectUpdate,
  formatProjectUpdateForLLM,
  type CmosProjectUpdateParams,
  type ProjectUpdateResult,
} from './cmos-project-update';
import { cmosProjectSweep, formatProjectSweepForLLM, type SweepResult } from './cmos-project-sweep';

export const CMOS_PROJECT_ACTIONS = [
  'init',
  'register',
  'list',
  'unregister',
  'validate',
  'prune',
  'update',
  'sweep',
] as const;

export type CmosProjectAction = (typeof CMOS_PROJECT_ACTIONS)[number];

export type CmosProjectResult =
  | CmosProjectInitResult
  | ProjectRegisterResult
  | ProjectListResult
  | ProjectUnregisterResult
  | ProjectValidateResult
  | ProjectUpdateResult
  | SweepResult;

const initialSprintSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    focus: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();

const initialMissionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    sprintId: z.string(),
    objective: z.string().optional(),
    successCriteria: z.array(z.string()).optional(),
    deliverables: z.array(z.string()).optional(),
    status: z.enum(['Queued', 'Current']).optional(),
  })
  .strict();

export const cmosProjectSchema = z
  .object({
    action: z
      .enum(CMOS_PROJECT_ACTIONS)
      .describe(
        'Project action: init | register | list | unregister | validate | prune | update | sweep'
      ),
    projectRoot: z.string().optional().describe('Project root directory'),
    // init params
    projectName: z.string().optional().describe('Project name for init action'),
    projectId: z.string().optional().describe('Project ID for init action'),
    tracelabProjectId: z.string().optional().describe('TraceLab project ID for init action'),
    initialSprint: initialSprintSchema.optional().describe('Initial sprint config for init action'),
    initialMissions: z
      .array(initialMissionSchema)
      .optional()
      .describe('Initial missions for init action'),
    // register params
    name: z.string().optional().describe('Display name for register action'),
    setAsDefault: z.boolean().optional().describe('Set as default project for register action'),
    // validate params
    prune: z.boolean().optional().describe('Prune invalid entries for validate action'),
    // list with validate flag
    validate: z
      .boolean()
      .optional()
      .describe('Run validation on list action (routes to validate handler)'),
    // update params
    projectType: z
      .enum(['general', 'managed', 'build'])
      .optional()
      .describe('Project type/tier for update action: general | managed | build'),
    // sweep params
    instances: z
      .array(z.string())
      .optional()
      .describe('Restrict sweep to these registry names only'),
    statusFilter: z
      .array(z.string())
      .optional()
      .describe('Restrict sweep to these mission/session statuses'),
    itemType: z
      .enum(['mission', 'session'])
      .optional()
      .describe('Restrict sweep to missions or sessions only'),
  })
  .strict();

export type CmosProjectParams = z.infer<typeof cmosProjectSchema>;

export const cmosProjectToolDefinition = {
  name: 'cmos_project',
  description:
    'Consolidated project tool with action parameter support. ' +
    'Actions: init, register, list, unregister, validate, prune, update, sweep. ' +
    'The list action supports an optional validate flag. ' +
    'The prune action removes registry entries where the local CMOS database no longer exists on disk. ' +
    'The update action allows setting project_type (general/managed/build). ' +
    'The sweep action returns all open missions and active sessions across registered instances.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_PROJECT_ACTIONS],
        description:
          'Project action: init | register | list | unregister | validate | prune | update | sweep',
      },
      projectRoot: { type: 'string', description: 'Project root directory' },
      projectName: { type: 'string', description: 'Project name for init action' },
      projectId: { type: 'string', description: 'Project ID for init action' },
      tracelabProjectId: { type: 'string', description: 'TraceLab project ID for init action' },
      initialSprint: {
        type: 'object',
        description: 'Initial sprint config for init action',
      },
      initialMissions: {
        type: 'array',
        description: 'Initial missions for init action',
        items: { type: 'object' },
      },
      name: { type: 'string', description: 'Display name for register action' },
      setAsDefault: { type: 'boolean', description: 'Set as default project for register action' },
      prune: { type: 'boolean', description: 'Prune invalid entries for validate action' },
      validate: {
        type: 'boolean',
        description: 'Run validation on list action (routes to validate handler)',
      },
      projectType: {
        type: 'string',
        enum: ['general', 'managed', 'build'],
        description: 'Project type/tier for update action',
      },
      instances: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict sweep to these registry names only',
      },
      statusFilter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict sweep to these mission/session statuses',
      },
      itemType: {
        type: 'string',
        enum: ['mission', 'session'],
        description: 'Restrict sweep to missions or sessions only',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

function isProjectAction(value: string): value is CmosProjectAction {
  return (CMOS_PROJECT_ACTIONS as readonly string[]).includes(value);
}

export async function cmosProject(
  params: CmosProjectParams
): Promise<CmosToolResult<CmosProjectResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isProjectAction(actionValue)) {
    return createError<CmosProjectResult>(
      CmosErrors.invalidAction('cmos_project', actionValue, CMOS_PROJECT_ACTIONS)
    );
  }

  switch (actionValue) {
    case 'init':
      return cmosProjectInit({
        projectRoot: params.projectRoot ?? '',
        projectName: params.projectName,
        projectId: params.projectId,
        tracelabProjectId: params.tracelabProjectId,
        initialSprint: params.initialSprint,
        initialMissions: params.initialMissions,
      } as CmosProjectInitInput);
    case 'register':
      return cmosProjectRegister({
        projectRoot: params.projectRoot ?? '',
        name: params.name,
        setAsDefault: params.setAsDefault,
      } satisfies CmosProjectRegisterParams);
    case 'list':
      // Support validate flag on list action
      if (params.validate) {
        return cmosProjectValidate({
          prune: params.prune,
        } satisfies CmosProjectValidateParams);
      }
      return cmosProjectList({} satisfies CmosProjectListParams);
    case 'unregister':
      return cmosProjectUnregister({
        projectRoot: params.projectRoot ?? '',
      } satisfies CmosProjectUnregisterParams);
    case 'validate':
      return cmosProjectValidate({
        prune: params.prune,
      } satisfies CmosProjectValidateParams);
    case 'prune':
      return cmosProjectValidate({ prune: true } satisfies CmosProjectValidateParams);
    case 'update':
      return cmosProjectUpdate({
        projectRoot: params.projectRoot,
        projectType: params.projectType,
      } satisfies CmosProjectUpdateParams);
    case 'sweep':
      return cmosProjectSweep({
        instances: params.instances,
        statusFilter: params.statusFilter,
        itemType: params.itemType,
      });
  }
}

export function formatProjectForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosProjectResult>,
  params?: { validate?: boolean }
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute cmos_project', '', `Error: ${result.error.message}`];

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
    case 'init':
      return formatProjectInitForLLM(result as CmosToolResult<CmosProjectInitResult>);
    case 'register':
      return formatProjectRegisterForLLM(result as CmosToolResult<ProjectRegisterResult>);
    case 'list':
      if (params?.validate) {
        return formatProjectValidateForLLM(result as CmosToolResult<ProjectValidateResult>);
      }
      return formatProjectListForLLM(result as CmosToolResult<ProjectListResult>);
    case 'unregister':
      return formatProjectUnregisterForLLM(result as CmosToolResult<ProjectUnregisterResult>);
    case 'validate':
    case 'prune':
      return formatProjectValidateForLLM(result as CmosToolResult<ProjectValidateResult>);
    case 'update':
      return formatProjectUpdateForLLM(result as CmosToolResult<ProjectUpdateResult>);
    case 'sweep':
      return formatProjectSweepForLLM(result as CmosToolResult<SweepResult>);
    default:
      return result.success ? '✓ Project action completed' : '❌ Failed to execute cmos_project';
  }
}
