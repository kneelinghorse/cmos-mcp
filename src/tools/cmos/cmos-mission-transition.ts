/**
 * cmos_mission_transition Tool
 *
 * Consolidated mission state-machine tool with action parameter support.
 * Actions: start, complete, block, unblock.
 * Kept separate from cmos_mission per architectural decision to reduce
 * parameter hallucination risk around state transitions.
 *
 * @module tools/cmos/cmos-mission-transition
 */

import { z } from 'zod';
import { createError, CmosErrors } from './errors';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, CmosToolResult } from './types';
import {
  cmosMissionStart,
  formatMissionStartForLLM,
  type CmosMissionStartParams,
  type MissionStartResult,
} from './cmos-mission-start';
import {
  cmosMissionComplete,
  formatMissionCompleteForLLM,
  type CmosMissionCompleteParams,
  type MissionCompleteResult,
} from './cmos-mission-complete';
import {
  cmosMissionBlock,
  formatMissionBlockForLLM,
  type CmosMissionBlockParams,
  type MissionBlockResult,
} from './cmos-mission-block';
import {
  cmosMissionUnblock,
  formatMissionUnblockForLLM,
  type CmosMissionUnblockParams,
  type MissionUnblockResult,
} from './cmos-mission-unblock';
import {
  cmosMissionDrop,
  formatMissionDropForLLM,
  type CmosMissionDropParams,
  type MissionDropResult,
} from './cmos-mission-drop';
import {
  cmosMissionDefer,
  formatMissionDeferForLLM,
  type CmosMissionDeferParams,
  type MissionDeferResult,
} from './cmos-mission-defer';
import { maybePropagateMissionStatus } from './sync-locks';

export const CMOS_MISSION_TRANSITION_ACTIONS = [
  'start',
  'complete',
  'block',
  'unblock',
  'drop',
  'defer',
] as const;

export type CmosMissionTransitionAction = (typeof CMOS_MISSION_TRANSITION_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const CMOS_MISSION_TRANSITION_ACTION_PARAMS: ActionParamMap<
  CmosMissionTransitionAction,
  CmosMissionTransitionParams
> = {
  start: ['action', 'missionId', 'notes', 'projectRoot'],
  complete: ['action', 'missionId', 'notes', 'decisions', 'agentFeedback', 'projectRoot'],
  block: ['action', 'missionId', 'reason', 'blockers', 'projectRoot'],
  unblock: ['action', 'missionId', 'resolution', 'targetStatus', 'projectRoot'],
  drop: ['action', 'missionId', 'reason', 'projectRoot'],
  defer: ['action', 'missionId', 'reason', 'deferUntil', 'projectRoot'],
};

export type CmosMissionTransitionResult =
  | MissionStartResult
  | MissionCompleteResult
  | MissionBlockResult
  | MissionUnblockResult
  | MissionDropResult
  | MissionDeferResult;

export const cmosMissionTransitionSchema = z
  .object({
    action: z
      .enum(CMOS_MISSION_TRANSITION_ACTIONS)
      .describe('Transition action: start | complete | block | unblock | drop | defer'),
    missionId: z.string().describe('The mission ID to transition'),
    notes: z.string().optional().describe('Notes for start/complete actions'),
    reason: z
      .string()
      .optional()
      .describe('Reason for block/drop/defer actions (required for block)'),
    blockers: z.array(z.string()).optional().describe('List of blockers for block action'),
    decisions: z
      .array(z.string())
      .optional()
      .describe('Decisions made during mission for complete action'),
    resolution: z.string().optional().describe('Resolution notes for unblock action'),
    targetStatus: z
      .enum(['In Progress', 'Current'])
      .optional()
      .describe('Target status after unblock (default: In Progress)'),
    deferUntil: z
      .string()
      .optional()
      .describe('Hint about when to re-queue for defer action (e.g., "after sprint 48")'),
    agentFeedback: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Optional free-text UX feedback (Sprint 56 m03). Use on complete actions to flag rough edges or improvement ideas you hit while working the mission. Reviewed via cmos_feedback(action="list").'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosMissionTransitionParams = z.infer<typeof cmosMissionTransitionSchema>;

export const cmosMissionTransitionToolDefinition = {
  name: 'cmos_mission_transition',
  description:
    'Consolidated mission state-machine tool with action parameter support. ' +
    'Actions: start, complete, block, unblock, drop, defer. ' +
    'Enforces state-machine rules and logs transition events.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_MISSION_TRANSITION_ACTIONS],
        description: 'Transition action: start | complete | block | unblock | drop | defer',
      },
      missionId: {
        type: 'string',
        description: 'The mission ID to transition',
      },
      notes: {
        type: 'string',
        description: 'Notes for start/complete actions',
      },
      reason: {
        type: 'string',
        description: 'Reason for block/drop/defer actions (required for block)',
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of blockers for block action',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Decisions made during mission for complete action',
      },
      resolution: {
        type: 'string',
        description: 'Resolution notes for unblock action',
      },
      targetStatus: {
        type: 'string',
        enum: ['In Progress', 'Current'],
        description: 'Target status after unblock (default: In Progress)',
      },
      deferUntil: {
        type: 'string',
        description: 'Hint about when to re-queue for defer action (e.g., "after sprint 48")',
      },
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback (Sprint 56 m03). Use on complete actions to flag rough edges or improvement ideas you hit while working the mission. Reviewed via cmos_feedback(action="list").',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['action', 'missionId'],
    additionalProperties: false,
  },
} as const;

function isTransitionAction(value: string): value is CmosMissionTransitionAction {
  return (CMOS_MISSION_TRANSITION_ACTIONS as readonly string[]).includes(value);
}

export async function cmosMissionTransition(
  params: CmosMissionTransitionParams
): Promise<CmosToolResult<CmosMissionTransitionResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isTransitionAction(actionValue)) {
    return createError<CmosMissionTransitionResult>(
      CmosErrors.invalidAction(
        'cmos_mission_transition',
        actionValue,
        CMOS_MISSION_TRANSITION_ACTIONS
      )
    );
  }

  // On a COLLAB store, every status transition is a mutable-surface edit that must
  // propagate to the broker per-field (m05). We wrap the handler result in a single
  // place — the dispatcher — rather than touch each handler: it reads the authoritative
  // POST-transition status and pushes it under a soft-lock. RESILIENT — a sync failure
  // never fails the local transition (folded into warnings); a SOLO store is untouched.
  switch (actionValue) {
    case 'start':
      return maybePropagateMissionStatus(
        await cmosMissionStart({
          missionId: params.missionId,
          notes: params.notes,
          projectRoot: params.projectRoot,
        } satisfies CmosMissionStartParams),
        params.missionId,
        params.projectRoot
      );
    case 'complete':
      return maybePropagateMissionStatus(
        await cmosMissionComplete({
          missionId: params.missionId,
          notes: params.notes,
          decisions: params.decisions,
          agentFeedback: params.agentFeedback,
          projectRoot: params.projectRoot,
        } satisfies CmosMissionCompleteParams),
        params.missionId,
        params.projectRoot
      );
    case 'block':
      return maybePropagateMissionStatus(
        await cmosMissionBlock({
          missionId: params.missionId,
          reason: params.reason ?? '',
          blockers: params.blockers,
          projectRoot: params.projectRoot,
        } satisfies CmosMissionBlockParams),
        params.missionId,
        params.projectRoot
      );
    case 'unblock':
      return maybePropagateMissionStatus(
        await cmosMissionUnblock({
          missionId: params.missionId,
          resolution: params.resolution,
          targetStatus: params.targetStatus,
          projectRoot: params.projectRoot,
        } satisfies CmosMissionUnblockParams),
        params.missionId,
        params.projectRoot
      );
    case 'drop':
      return maybePropagateMissionStatus(
        await cmosMissionDrop({
          missionId: params.missionId,
          reason: params.reason,
          projectRoot: params.projectRoot,
        } satisfies CmosMissionDropParams),
        params.missionId,
        params.projectRoot
      );
    case 'defer':
      return maybePropagateMissionStatus(
        await cmosMissionDefer({
          missionId: params.missionId,
          reason: params.reason,
          deferUntil: params.deferUntil,
          projectRoot: params.projectRoot,
        } satisfies CmosMissionDeferParams),
        params.missionId,
        params.projectRoot
      );
  }
}

export function formatMissionTransitionForLLM(
  action: string | undefined,
  result: CmosToolResult<CmosMissionTransitionResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = [
      '❌ Failed to execute cmos_mission_transition',
      '',
      `Error: ${result.error.message}`,
    ];

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
    case 'start':
      return formatMissionStartForLLM(result as CmosToolResult<MissionStartResult>);
    case 'complete':
      return formatMissionCompleteForLLM(result as CmosToolResult<MissionCompleteResult>);
    case 'block':
      return formatMissionBlockForLLM(result as CmosToolResult<MissionBlockResult>);
    case 'unblock':
      return formatMissionUnblockForLLM(result as CmosToolResult<MissionUnblockResult>);
    case 'drop':
      return formatMissionDropForLLM(result as CmosToolResult<MissionDropResult>);
    case 'defer':
      return formatMissionDeferForLLM(result as CmosToolResult<MissionDeferResult>);
    default: {
      if (!result.success) return '❌ Failed to execute cmos_mission_transition';
      const lines = ['✓ Mission transition completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
