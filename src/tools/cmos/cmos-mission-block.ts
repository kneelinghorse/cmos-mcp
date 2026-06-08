/**
 * cmos_mission_block Tool
 *
 * MCP tool for blocking a mission - transitions from Current/In Progress to Blocked.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/cmos/cmos-mission-block
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult, Mission, MissionStatus, SanitizedFieldReport } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  VALID_STATE_TRANSITIONS,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { sanitizeContentField, sanitizeStringArray } from '../../intelligence/content-sanitizer';

/**
 * Result of blocking a mission.
 */
export interface MissionBlockResult {
  /** The mission ID that was blocked */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'Blocked') */
  currentStatus: MissionStatus;

  /** The reason for blocking */
  reason: string;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was blocked */
  blockedAt: string;
}

/**
 * Input parameters schema for cmos_mission_block tool.
 */
export const cmosMissionBlockSchema = z.object({
  /** The mission ID to block */
  missionId: z.string().min(1).describe('The mission ID to block (e.g., "s12-m06")'),

  /** The reason for blocking */
  reason: z.string().min(1).describe('The reason why this mission is being blocked'),

  /** Optional list of things needed to unblock */
  blockers: z
    .array(z.string())
    .optional()
    .describe('Optional list of items or dependencies needed to unblock'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionBlockParams = z.infer<typeof cmosMissionBlockSchema>;

/**
 * MCP Tool Definition for cmos_mission_block.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionBlockToolDefinition = {
  name: 'cmos_mission_block',
  description:
    'Block a mission by transitioning it to Blocked status. ' +
    'Requires a reason for why the mission is blocked. ' +
    'Valid from Current or In Progress status. ' +
    'Returns INVALID_STATE_TRANSITION error with current_state and valid_transitions if the mission cannot be blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to block (e.g., "s12-m06")',
      },
      reason: {
        type: 'string',
        description: 'The reason why this mission is being blocked',
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of items or dependencies needed to unblock',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId', 'reason'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_block tool.
 *
 * Transitions a mission from Current or In Progress to Blocked.
 * Requires a reason and optionally accepts blockers list.
 *
 * @param params - Tool parameters (missionId, reason, blockers, projectRoot)
 * @returns CmosToolResult with block result or actionable error
 */
export async function cmosMissionBlock(
  params: CmosMissionBlockParams
): Promise<CmosToolResult<MissionBlockResult>> {
  // Validate required parameters
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  if (!params.reason || params.reason.trim() === '') {
    return createError(CmosErrors.missingParameter('reason'));
  }

  const missionId = params.missionId.trim();
  // Sprint 60 m02: sanitize text inputs before persistence so XML-marshalling
  // sibling absorption is stripped + surfaced rather than written verbatim.
  const inputSanitized: SanitizedFieldReport[] = [];
  let cleanedReason = params.reason;
  const reasonSanitize = sanitizeContentField(params.reason);
  if (reasonSanitize.wasModified) {
    cleanedReason = reasonSanitize.cleaned;
    inputSanitized.push({ field: 'reason', reason: reasonSanitize.reason ?? '' });
  }
  if (!cleanedReason || cleanedReason.trim() === '') {
    return createError(CmosErrors.missingParameter('reason'));
  }
  let cleanedBlockers = params.blockers;
  if (Array.isArray(cleanedBlockers)) {
    const r = sanitizeStringArray('blockers', cleanedBlockers);
    cleanedBlockers = r.cleaned;
    inputSanitized.push(...r.sanitizedFields);
  }
  const reason = cleanedReason.trim();
  const targetStatus: MissionStatus = 'Blocked';

  return withClientValidated(
    (client) => {
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
        return createError<MissionBlockResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionBlockResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      // Check if already blocked
      if (currentStatus === targetStatus) {
        return createError<MissionBlockResult>({
          code: CMOS_ERROR_CODES.MISSION_ALREADY_BLOCKED,
          message: `Mission '${missionId}' is already Blocked`,
          currentState: currentStatus,
          suggestion: 'Use cmos_mission_unblock to unblock it first, or update the block reason',
        });
      }

      // Validate state transition
      const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionBlockResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      // Perform the update
      const now = new Date().toISOString();

      // Update domain_fields with blocker information
      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          // If parsing fails, start fresh
          existingDomainFields = {};
        }
      }

      const updatedDomainFields = {
        ...existingDomainFields,
        blocker: reason,
        blockedSince: now,
        blockers: cleanedBlockers ?? [],
      };

      // Build note text
      const blockNote = cleanedBlockers?.length
        ? `[Blocked] ${reason}. Needs: ${cleanedBlockers.join(', ')}`
        : `[Blocked] ${reason}`;

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
        [targetStatus, JSON.stringify(updatedDomainFields), blockNote, now, missionId]
      );

      if (!updateResult.success) {
        return createError<MissionBlockResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionBlockResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      // Log the state change to session_events
      const eventResult = client.execute(
        `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, 'block', ?, ?, ?)
      `,
        [
          now,
          missionId,
          targetStatus,
          reason,
          JSON.stringify({
            tool: 'cmos_mission_block',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            reason,
            blockers: cleanedBlockers,
          }),
        ]
      );

      // Don't fail the operation if event logging fails (non-critical)
      if (!eventResult.success) {
        console.warn('Failed to log mission block event:', eventResult.error);
      }

      return createSuccess<MissionBlockResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          reason,
          message: `Mission '${missionId}' has been blocked: ${reason}`,
          blockedAt: now,
        },
        undefined,
        inputSanitized
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format mission block result for LLM readability.
 *
 * @param result - Mission block result
 * @returns Human-readable formatted result
 */
export function formatMissionBlockForLLM(result: CmosToolResult<MissionBlockResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to block mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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
    `⊘ Mission '${data.missionId}' blocked`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Reason: ${data.reason}`,
    `Blocked at: ${data.blockedAt}`,
  ];

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}
