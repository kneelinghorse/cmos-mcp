/**
 * cmos_mission_unblock Tool
 *
 * MCP tool for unblocking a mission - transitions from Blocked to In Progress or Current.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/cmos/cmos-mission-unblock
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  VALID_STATE_TRANSITIONS,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { appendWarnings } from './format-warnings';
import { checkWrite } from './write-guard';

/**
 * Result of unblocking a mission.
 */
export interface MissionUnblockResult {
  /** The mission ID that was unblocked */
  missionId: string;

  /** Previous status before transition (always 'Blocked') */
  previousStatus: MissionStatus;

  /** Current status after transition */
  currentStatus: MissionStatus;

  /** Resolution notes */
  resolution: string | null;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was unblocked */
  unblockedAt: string;
}

/**
 * Input parameters schema for cmos_mission_unblock tool.
 */
export const cmosMissionUnblockSchema = z.object({
  /** The mission ID to unblock */
  missionId: z.string().min(1).describe('The mission ID to unblock (e.g., "s12-m06")'),

  /** Optional resolution notes explaining how the blocker was resolved */
  resolution: z
    .string()
    .optional()
    .describe('Optional notes explaining how the blocker was resolved'),

  /** Target status after unblock (default: 'In Progress') */
  targetStatus: z
    .enum(['In Progress', 'Current'])
    .optional()
    .describe('Target status after unblocking (default: "In Progress")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionUnblockParams = z.infer<typeof cmosMissionUnblockSchema>;

/**
 * MCP Tool Definition for cmos_mission_unblock.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionUnblockToolDefinition = {
  name: 'cmos_mission_unblock',
  description:
    'Unblock a mission by transitioning it from Blocked to In Progress or Current status. ' +
    'Only valid from Blocked status. ' +
    'Optionally include resolution notes to document how the blocker was resolved. ' +
    'Returns INVALID_STATE_TRANSITION error if the mission is not blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to unblock (e.g., "s12-m06")',
      },
      resolution: {
        type: 'string',
        description: 'Optional notes explaining how the blocker was resolved',
      },
      targetStatus: {
        type: 'string',
        enum: ['In Progress', 'Current'],
        description: 'Target status after unblocking (default: "In Progress")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_unblock tool.
 *
 * Transitions a mission from Blocked to In Progress (default) or Current.
 * Clears blocker information and optionally records resolution notes.
 *
 * @param params - Tool parameters (missionId, resolution, targetStatus, projectRoot)
 * @returns CmosToolResult with unblock result or actionable error
 */
export async function cmosMissionUnblock(
  params: CmosMissionUnblockParams
): Promise<CmosToolResult<MissionUnblockResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = params.targetStatus ?? 'In Progress';

  return withClientValidated(
    (client) => {
      const warnings: string[] = [];

      // Query mission by ID
      const missionResult = client.getOne<Mission>(
        `
        SELECT id, status, name, domain_fields
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionUnblockResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionUnblockResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      // Check if mission is blocked
      if (currentStatus !== 'Blocked') {
        return createError<MissionUnblockResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is not blocked (current status: ${currentStatus})`,
          currentState: currentStatus,
          suggestion:
            currentStatus === 'Completed'
              ? 'Cannot unblock a completed mission'
              : 'Use cmos_mission_transition(action="start") to begin work on this mission',
        });
      }

      // Validate target status is a valid transition from Blocked
      const validTransitions = VALID_STATE_TRANSITIONS['Blocked'];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionUnblockResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      // Perform the update
      const now = new Date().toISOString();

      // Update domain_fields to clear blocker information but preserve history
      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          existingDomainFields = {};
        }
      }

      // Preserve previous blocker info for history, clear active blocker
      const previousBlocker = existingDomainFields.blocker;
      const previousBlockedSince = existingDomainFields.blockedSince;

      const updatedDomainFields = {
        ...existingDomainFields,
        blocker: null,
        blockedSince: null,
        blockers: null,
        unblockedAt: now,
        previousBlocker,
        previousBlockedSince,
        resolution: params.resolution ?? null,
      };

      // Build note text
      const unblockNote = params.resolution
        ? `[Unblocked] ${params.resolution}`
        : `[Unblocked] Blocker resolved`;

      // Ensure timestamp columns exist (migration)
      ensureMissionTimestamps(client);

      const updateResult = client.execute(
        `
        UPDATE missions
        SET status = ?,
            domain_fields = ?,
            notes = COALESCE(notes || ' | ', '') || ?,
            updated_at = ?
        WHERE id = ?
      `,
        [targetStatus, JSON.stringify(updatedDomainFields), unblockNote, now, missionId]
      );

      if (!updateResult.success) {
        return createError<MissionUnblockResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionUnblockResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      // Log the state change to session_events
      const eventResult = client.execute(
        `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, 'unblock', ?, ?, ?)
      `,
        [
          now,
          missionId,
          targetStatus,
          params.resolution ?? `Unblocked mission ${missionId}`,
          JSON.stringify({
            tool: 'cmos_mission_unblock',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            resolution: params.resolution,
            previousBlocker,
          }),
        ]
      );

      // Don't fail the operation if event logging fails (non-critical) — but say so.
      if (!checkWrite(eventResult, warnings, 'mission unblock event logging')) {
        console.warn('Failed to log mission unblock event:', eventResult.error);
      }

      return createSuccess<MissionUnblockResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          resolution: params.resolution ?? null,
          message: `Mission '${missionId}' has been unblocked`,
          unblockedAt: now,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format mission unblock result for LLM readability.
 *
 * @param result - Mission unblock result
 * @returns Human-readable formatted result
 */
export function formatMissionUnblockForLLM(result: CmosToolResult<MissionUnblockResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to unblock mission',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.currentState) {
      lines.push(`Current status: ${error.currentState}`);
    }

    if (error?.validTransitions && error.validTransitions.length > 0) {
      lines.push(`Valid transitions: ${error.validTransitions.join(', ')}`);
    }

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `✓ Mission '${data.missionId}' unblocked`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Unblocked at: ${data.unblockedAt}`,
  ];

  if (data.resolution) {
    lines.push(`Resolution: ${data.resolution}`);
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
