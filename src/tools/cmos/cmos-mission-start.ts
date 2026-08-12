/**
 * cmos_mission_start Tool
 *
 * MCP tool for starting a mission - transitions from Queued/Current to In Progress.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/cmos/cmos-mission-start
 */

import { z } from 'zod';
import { withClientAsync, type CmosDatabaseClient } from './client';
import type { CmosToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  VALID_STATE_TRANSITIONS,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { getProjectId } from './genesis-columns';
import { frameForeignText } from '../../intelligence/provenance-frame';
import {
  findRelevantDecisions,
  buildMissionSearchText,
  type RelevantDecision,
} from './relevance-surfacing';
import { appendWarnings } from './format-warnings';
import { checkWrite } from './write-guard';

/**
 * Result of starting a mission.
 */
export interface MissionStartResult {
  /** The mission ID that was started */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'In Progress') */
  currentStatus: MissionStatus;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was started */
  startedAt: string;

  /** Active decisions relevant to this mission's objective (0-5 items) */
  relevantDecisions?: RelevantDecision[];

  /**
   * s83-m06: the local project_id, so the renderer can frame any relevant decision
   * whose project_id differs (a pull-merged FOREIGN row) as untrusted data.
   */
  localProjectId?: string | null;
}

/**
 * Input parameters schema for cmos_mission_start tool.
 */
export const cmosMissionStartSchema = z.object({
  /** The mission ID to start */
  missionId: z.string().min(1).describe('The mission ID to start (e.g., "s12-m06")'),

  /** Optional notes about starting this mission */
  notes: z.string().optional().describe('Optional notes about why this mission is being started'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionStartParams = z.infer<typeof cmosMissionStartSchema>;

/**
 * MCP Tool Definition for cmos_mission_start.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionStartToolDefinition = {
  name: 'cmos_mission_start',
  description:
    'Start a mission by transitioning it to In Progress status. ' +
    'Valid from Queued or Current status. ' +
    'Returns INVALID_STATE_TRANSITION error with valid_transitions if the mission cannot be started.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to start (e.g., "s12-m06")',
      },
      notes: {
        type: 'string',
        description: 'Optional notes about why this mission is being started',
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
 * Execute the cmos_mission_start tool.
 *
 * Transitions a mission from Queued or Current to In Progress.
 * Validates the state transition and returns actionable errors if invalid.
 *
 * @param params - Tool parameters (missionId, notes, projectRoot)
 * @returns CmosToolResult with start result or actionable error
 */
export async function cmosMissionStart(
  params: CmosMissionStartParams
): Promise<CmosToolResult<MissionStartResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'In Progress';

  return withClientAsync(
    async (client) => {
      const warnings: string[] = [];

      // Query mission by ID
      const missionResult = loadMissionForStart(client, missionId);

      if (!missionResult.success) {
        return createError<MissionStartResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionStartResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      // Check if already in target status
      if (currentStatus === targetStatus) {
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is already In Progress`,
          currentState: currentStatus,
          suggestion:
            'Use cmos_mission_transition(action="complete") to mark it done or cmos_mission_transition(action="block") if blocked',
        });
      }

      // Special handling for blocked missions - redirect to unblock tool
      if (currentStatus === 'Blocked') {
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION,
          message: `Cannot start blocked mission '${missionId}'`,
          currentState: currentStatus,
          validTransitions: ['In Progress', 'Current'],
          suggestion:
            'Use cmos_mission_transition(action="unblock") to unblock this mission first. ' +
            'Provide a resolution explaining how the blocker was resolved.',
        });
      }

      // Validate state transition
      const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionStartResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      // Perform the update
      const now = new Date().toISOString();
      const sprintActivationResult = shouldActivateParentSprint(client, mission.sprint_id);
      if (!sprintActivationResult.success || sprintActivationResult.data === undefined) {
        return createError<MissionStartResult>(
          sprintActivationResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to inspect parent sprint for mission '${missionId}'`,
            suggestion: 'Check database connectivity and schema',
          }
        );
      }

      // Ensure timestamp columns exist (migration)
      ensureMissionTimestamps(client);

      // Build update query - include notes if provided
      // Set started_at only if not already set (first start), always update updated_at
      let updateQuery: string;
      let updateParams: (string | null)[];

      if (params.notes) {
        updateQuery = `
          UPDATE missions
          SET status = ?,
              notes = COALESCE(notes || ' | ', '') || ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE id = ?
        `;
        updateParams = [targetStatus, `[Started] ${params.notes}`, now, now, missionId];
      } else {
        updateQuery = `
          UPDATE missions
          SET status = ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE id = ?
        `;
        updateParams = [targetStatus, now, now, missionId];
      }

      const beginResult = client.execute('BEGIN IMMEDIATE', []);
      if (!beginResult.success) {
        return createError<MissionStartResult>(
          beginResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to begin mission start transaction for '${missionId}'`,
            suggestion: 'Retry the mission start once the database is available',
          }
        );
      }

      let transactionOpen = true;

      const rollbackTransaction = (): void => {
        if (!transactionOpen) {
          return;
        }
        client.execute('ROLLBACK', []);
        transactionOpen = false;
      };

      if (sprintActivationResult.data && mission.sprint_id) {
        const activateSprintResult = activateParentSprint(client, mission.sprint_id, now);

        if (!activateSprintResult.success) {
          rollbackTransaction();
          return createError<MissionStartResult>(
            activateSprintResult.error ?? {
              code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
              message: `Failed to activate parent sprint '${mission.sprint_id}'`,
              suggestion: 'Check database connectivity and retry the mission start.',
            }
          );
        }
      }

      const updateResult = client.execute(updateQuery, updateParams);

      if (!updateResult.success) {
        rollbackTransaction();
        return createError<MissionStartResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        rollbackTransaction();
        return createError<MissionStartResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      const commitResult = client.execute('COMMIT', []);
      if (!commitResult.success) {
        rollbackTransaction();
        return createError<MissionStartResult>(
          commitResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to commit mission start for '${missionId}'`,
            suggestion: 'Retry the mission start once the database transaction can be committed.',
          }
        );
      }
      transactionOpen = false;

      // Log the state change to session_events
      const eventResult = client.execute(
        `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, 'start', ?, ?, ?)
      `,
        [
          now,
          missionId,
          targetStatus,
          params.notes ?? `Started mission ${missionId}`,
          JSON.stringify({
            tool: 'cmos_mission_start',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            notes: params.notes,
          }),
        ]
      );

      // Don't fail the operation if event logging fails (non-critical) — but say so.
      if (!checkWrite(eventResult, warnings, 'mission start event logging')) {
        console.warn('Failed to log mission start event:', eventResult.error);
      }

      // Surface relevant decisions for this mission (non-critical)
      let relevantDecisions: RelevantDecision[] | undefined;
      const missionDetail = client.getOne<{
        objective: string | null;
        success_criteria: string | null;
      }>('SELECT objective, success_criteria FROM missions WHERE id = ?', [missionId]);
      if (missionDetail.success && missionDetail.data) {
        const searchText = buildMissionSearchText(
          missionDetail.data.objective,
          missionDetail.data.success_criteria
        );
        if (searchText.length > 0) {
          const found = await findRelevantDecisions(client, searchText);
          if (found.length > 0) {
            relevantDecisions = found;
          }
        }
      }

      return createSuccess<MissionStartResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          message: `Mission '${missionId}' is now In Progress`,
          startedAt: now,
          relevantDecisions,
          localProjectId: getProjectId(client),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

function loadMissionForStart(
  client: CmosDatabaseClient,
  missionId: string
): CmosToolResult<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>> {
  const missionResult = client.getOne<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>>(
    `
      SELECT id, status, name, sprint_id
      FROM missions
      WHERE id = ?
    `,
    [missionId]
  );

  if (
    missionResult.success ||
    missionResult.error?.code !== CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH ||
    !missionResult.error?.message.includes('sprint_id')
  ) {
    return missionResult as CmosToolResult<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>>;
  }

  const legacyResult = client.getOne<Mission>(
    `
      SELECT id, status, name
      FROM missions
      WHERE id = ?
    `,
    [missionId]
  );

  if (!legacyResult.success || !legacyResult.data) {
    return legacyResult as CmosToolResult<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>>;
  }

  return createSuccess({
    ...legacyResult.data,
    sprint_id: null,
  });
}

function shouldActivateParentSprint(
  client: { getOne: CmosDatabaseClient['getOne'] },
  sprintId: string | null
): CmosToolResult<boolean> {
  if (!sprintId) {
    return createSuccess(false);
  }

  const sprintResult = client.getOne<{ status: string | null }>(
    'SELECT status FROM sprints WHERE id = ?',
    [sprintId]
  );

  if (!sprintResult.success) {
    return createError<boolean>(
      sprintResult.error ?? {
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to query sprint '${sprintId}'`,
        suggestion: 'Check database connectivity and schema',
      }
    );
  }

  return createSuccess(sprintResult.data?.status === 'Planned');
}

function activateParentSprint(
  client: { execute: CmosDatabaseClient['execute'] },
  sprintId: string,
  startedAt: string
): ReturnType<CmosDatabaseClient['execute']> {
  const updateWithStartDate = client.execute(
    `
      UPDATE sprints
      SET status = 'Active',
          start_date = COALESCE(start_date, ?)
      WHERE id = ?
        AND status = 'Planned'
    `,
    [startedAt, sprintId]
  );

  // s86-m02b: stated as the NEGATIVE test (De Morgan of the original
  // `success || code !== … || !message.includes(…)` early return) so the failure
  // path is the one named in the condition. Behaviour is identical.
  if (
    !updateWithStartDate.success &&
    updateWithStartDate.error?.code === CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH &&
    updateWithStartDate.error?.message.includes('start_date')
  ) {
    return client.execute(
      `
      UPDATE sprints
      SET status = 'Active'
      WHERE id = ?
        AND status = 'Planned'
    `,
      [sprintId]
    );
  }

  return updateWithStartDate;
}

/**
 * Format mission start result for LLM readability.
 *
 * @param result - Mission start result
 * @returns Human-readable formatted result
 */
export function formatMissionStartForLLM(result: CmosToolResult<MissionStartResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to start mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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
    `✓ Mission '${data.missionId}' started`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Started at: ${data.startedAt}`,
  ];

  if (data.relevantDecisions && data.relevantDecisions.length > 0) {
    lines.push('');
    lines.push(`**Relevant Past Decisions** (${data.relevantDecisions.length}):`);
    const localProjectId = data.localProjectId ?? null;
    for (const d of data.relevantDecisions) {
      const cat = d.category ? ` [${d.category}]` : '';
      const sprint = d.sprintId ? ` (${d.sprintId})` : '';
      // s83-m06: a relevant decision pull-merged from ANOTHER project is foreign,
      // untrusted content — render its text inside the provenance fence instead of
      // as a bare bullet that could read as an instruction. Mirrors the ratified
      // LIST precedent (cmos-decisions-list.ts). Local rows stay bare.
      const isForeign =
        d.projectId != null && (localProjectId == null || d.projectId !== localProjectId);
      if (isForeign) {
        lines.push(`  • #${d.id}${cat}${sprint} [proj:${d.projectId}]`);
        lines.push(frameForeignText(d.decisionText, `proj:${d.projectId}`));
        // s83-m06 (review): evidence is also foreign-author-controlled free text —
        // it MUST stay inside the fence, not render bare after [END UNTRUSTED DATA].
        if (d.evidence) {
          lines.push('    Evidence:');
          lines.push(frameForeignText(d.evidence, `proj:${d.projectId}`));
        }
      } else {
        const preview =
          d.decisionText.length > 100 ? d.decisionText.slice(0, 100) + '...' : d.decisionText;
        lines.push(`  • #${d.id}${cat}${sprint}: ${preview}`);
        if (d.evidence) {
          lines.push(`    Evidence: ${d.evidence}`);
        }
      }
    }
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
