// ABOUTME: Implements the cmos_mission_drop action — transitions a mission to Dropped (terminal).
// ABOUTME: Dropped missions are soft-parked (not deleted) and permanently removed from the active queue.

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  transitionsFrom,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';

/**
 * Result of dropping a mission.
 */
export interface MissionDropResult {
  /** The mission ID that was dropped */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'Dropped') */
  currentStatus: MissionStatus;

  /** The reason for dropping */
  reason: string | null;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was dropped */
  droppedAt: string;
}

export const cmosMissionDropSchema = z.object({
  missionId: z.string().min(1).describe('The mission ID to drop (e.g., "s12-m06")'),
  reason: z.string().optional().describe('Optional reason why this mission is being dropped'),
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionDropParams = z.infer<typeof cmosMissionDropSchema>;

export async function cmosMissionDrop(
  params: CmosMissionDropParams
): Promise<CmosToolResult<MissionDropResult>> {
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'Dropped';

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      const missionResult = client.getOne<Mission>(
        `SELECT id, status, name, domain_fields FROM missions WHERE id = ?`,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionDropResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionDropResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      if (currentStatus === 'Dropped') {
        return createError<MissionDropResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is already Dropped`,
          currentState: currentStatus,
          suggestion: 'Mission is already in terminal Dropped state',
        });
      }

      // s87-m01: guarded through the ONE shared helper. `currentStatus` is read from the store,
      // not validated by the type system, and an unrecognized value now yields a NAMED refusal
      // instead of an unhandled TypeError the MCP boundary reports as "an internal error".
      const validTransitions = transitionsFrom(currentStatus);
      if (validTransitions === undefined) {
        return createError<MissionDropResult>(
          CmosErrors.missionUnrecognizedStatus(missionId, currentStatus)
        );
      }
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionDropResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      const now = new Date().toISOString();

      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          existingDomainFields = {};
        }
      }

      const updatedDomainFields = {
        ...existingDomainFields,
        droppedReason: params.reason ?? null,
        droppedAt: now,
        droppedFromStatus: currentStatus,
      };

      const dropNote = params.reason
        ? `[Dropped] ${params.reason}`
        : `[Dropped] Removed from active queue`;

      warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));

      const updateResult = client.execute(
        `UPDATE missions
         SET status = ?,
             domain_fields = ?,
             notes = COALESCE(notes || ' | ', '') || ?,
             updated_at = ?
         WHERE id = ?`,
        [targetStatus, JSON.stringify(updatedDomainFields), dropNote, now, missionId]
      );

      if (!updateResult.success) {
        return createError<MissionDropResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionDropResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'drop', ?, ?, ?)`,
        [
          now,
          missionId,
          targetStatus,
          params.reason ?? `Dropped mission ${missionId}`,
          JSON.stringify({
            tool: 'cmos_mission_drop',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            reason: params.reason ?? null,
          }),
        ]
      );

      if (!checkWrite(eventResult, warnings, 'mission drop event logging')) {
        console.warn('Failed to log mission drop event:', eventResult.error);
      }

      return createSuccess<MissionDropResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          reason: params.reason ?? null,
          message: `Mission '${missionId}' has been dropped`,
          droppedAt: now,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

export function formatMissionDropForLLM(result: CmosToolResult<MissionDropResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to drop mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `✗ Mission '${data.missionId}' dropped`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Dropped at: ${data.droppedAt}`,
  ];

  if (data.reason) {
    lines.push(`Reason: ${data.reason}`);
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
