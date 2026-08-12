/**
 * Next-Step Lifecycle Handler
 *
 * Manages structured next-steps with status tracking:
 * - list: View pending/all next-steps
 * - complete: Mark a next-step as completed
 * - carry: Carry pending next-steps to a new sprint
 * - drop: Drop a next-step (no longer relevant)
 *
 * Wired into cmos_context(action="next_steps").
 *
 * @module tools/cmos/cmos-next-steps
 */

import { withClient, type CmosDatabaseClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { ensureNextStepsTable, type NextStepStatus } from './schema-migrations';
import { appendWarnings, appendWriteFailures } from './format-warnings';
import { countWrite, type WriteFailure } from './write-guard';

/**
 * A next-step record from the database.
 */
export interface NextStepRecord {
  id: number;
  content: string;
  status: NextStepStatus;
  sessionId: string | null;
  sprintId: string | null;
  missionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  carriedToSprint: string | null;
}

export interface NextStepsResult {
  /** The sub-action that was performed */
  nextStepAction: string;
  /** Next-steps returned (for list) */
  items?: NextStepRecord[];
  /** Count of items affected */
  affected: number;
  /** s86-m02b — writes an action ATTEMPTED and the database REJECTED. Emitted by every write
   *  action (complete/carry/drop), `[]` on the happy path; absent on `list`, which writes
   *  nothing. `affected` above counts rows the UPDATE actually changed, so a non-empty array
   *  here is the difference between the intent and the outcome. A caller-supplied id that
   *  matched no pending row is NOT a failure — the statement ran, its WHERE matched nothing —
   *  and produces no entry. */
  writeFailures?: WriteFailure[];
  /** Message */
  message: string;
}

export interface CmosNextStepsParams {
  /** Sub-action: list | complete | carry | drop */
  nextStepAction: 'list' | 'complete' | 'carry' | 'drop';
  /** Filter by status (for list, default: pending) */
  nextStepStatus?: NextStepStatus;
  /** s85-m04: filter list to next-steps stamped with this mission (#487 read surface) */
  missionId?: string;
  /** Next-step ID(s) to act on (for complete/carry/drop) */
  nextStepIds?: number[];
  /** Target sprint for carry action */
  carryToSprint?: string;
  /** Optional project root */
  projectRoot?: string;
}

export async function cmosNextSteps(
  params: CmosNextStepsParams
): Promise<CmosToolResult<NextStepsResult>> {
  const action = params.nextStepAction;

  if (!action || !['list', 'complete', 'carry', 'drop'].includes(action)) {
    return createError<NextStepsResult>({
      code: 'INVALID_ACTION',
      message: `Invalid next_step action: '${action}'`,
      suggestion: 'Use nextStepAction: list | complete | carry | drop',
      validValues: ['list', 'complete', 'carry', 'drop'],
    });
  }

  return withClient(
    (client) => {
      ensureNextStepsTable(client);

      switch (action) {
        case 'list':
          return listNextSteps(client, params.nextStepStatus ?? 'pending', params.missionId);
        case 'complete':
          return transitionNextSteps(client, params.nextStepIds ?? [], 'completed');
        case 'carry':
          return carryNextSteps(client, params.nextStepIds, params.carryToSprint ?? null);
        case 'drop':
          return transitionNextSteps(client, params.nextStepIds ?? [], 'dropped');
        default:
          return createError<NextStepsResult>({
            code: 'INVALID_ACTION',
            message: `Unknown next_step action: '${action}'`,
          });
      }
    },
    { projectRoot: params.projectRoot }
  );
}

interface NextStepRow {
  id: number;
  content: string;
  status: string;
  session_id: string | null;
  sprint_id: string | null;
  mission_id: string | null;
  created_at: string;
  resolved_at: string | null;
  carried_to_sprint: string | null;
}

/**
 * s85-m04: restructured from two hardcoded, ternary-selected SQL literals into the
 * conditions-builder shape used by cmos-decisions-list.ts. The old form had no `conditions[]`
 * array at all, so adding the `missionId` filter to only one of the two branches would have
 * been an easy and invisible mistake — the pending branch inlined its status while the other
 * bound it. One query, one param list, both predicates applied uniformly.
 */
function listNextSteps(
  client: CmosDatabaseClient,
  status: NextStepStatus,
  missionId?: string
): CmosToolResult<NextStepsResult> {
  const conditions = ['status = ?'];
  const queryParams: unknown[] = [status];

  if (missionId) {
    conditions.push('mission_id = ?');
    queryParams.push(missionId);
  }

  const query = `SELECT id, content, status, session_id, sprint_id, mission_id, created_at, resolved_at, carried_to_sprint
     FROM next_steps WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`;

  const result = client.getMany<NextStepRow>(query, queryParams);

  if (!result.success || !result.data) {
    return createError<NextStepsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query next-steps',
    });
  }

  const items: NextStepRecord[] = result.data.map((row) => ({
    id: row.id,
    content: row.content,
    status: row.status as NextStepStatus,
    sessionId: row.session_id,
    sprintId: row.sprint_id,
    missionId: row.mission_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    carriedToSprint: row.carried_to_sprint,
  }));

  return createSuccess<NextStepsResult>({
    nextStepAction: 'list',
    items,
    affected: items.length,
    message: `Found ${items.length} next-step(s) with status '${status}'${
      missionId ? ` for mission '${missionId}'` : ''
    }`,
  });
}

function transitionNextSteps(
  client: CmosDatabaseClient,
  ids: number[],
  targetStatus: 'completed' | 'dropped'
): CmosToolResult<NextStepsResult> {
  if (ids.length === 0) {
    return createError<NextStepsResult>(CmosErrors.missingParameter('nextStepIds'));
  }

  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };
  const op = targetStatus === 'completed' ? 'next_steps.complete' : 'next_steps.drop';
  let affected = 0;

  for (const id of ids) {
    const result = client.execute(
      `UPDATE next_steps SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
      [targetStatus, now, id]
    );
    // s86-m02b: the ids come from the TOOL CALL and were never re-selected, so `changes: 0` on a
    // statement that RAN means "no pending row with that id" — legitimate, and countWrite records
    // nothing for it. Only an errored statement reaches writeSink.
    affected += countWrite(result, writeSink, `${op} #${id}`);
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: targetStatus === 'completed' ? 'complete' : 'drop',
    affected,
    writeFailures: writeSink.failures,
    message: `${affected} next-step(s) marked as ${targetStatus}`,
  });
}

function carryNextSteps(
  client: CmosDatabaseClient,
  ids: number[] | undefined,
  targetSprint: string | null
): CmosToolResult<NextStepsResult> {
  // If no IDs provided, carry ALL pending next-steps
  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };

  if (!ids || ids.length === 0) {
    // Carry all pending
    const result = client.execute(
      `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE status = 'pending'`,
      [now, targetSprint]
    );
    const affected = countWrite(result, writeSink, 'next_steps.carry (all pending)');
    return createSuccess<NextStepsResult>({
      nextStepAction: 'carry',
      affected,
      writeFailures: writeSink.failures,
      message: targetSprint
        ? `${affected} pending next-step(s) carried to ${targetSprint}`
        : `${affected} pending next-step(s) marked as carried`,
    });
  }

  let affected = 0;
  for (const id of ids) {
    const result = client.execute(
      `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE id = ? AND status = 'pending'`,
      [now, targetSprint, id]
    );
    // Caller-supplied id: a zero from a WHERE that matched no pending row is ordinary and is
    // recorded nowhere. Only an errored statement becomes a writeFailures entry.
    affected += countWrite(result, writeSink, `next_steps.carry #${id}`);
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: 'carry',
    affected,
    writeFailures: writeSink.failures,
    message: targetSprint
      ? `${affected} next-step(s) carried to ${targetSprint}`
      : `${affected} next-step(s) marked as carried`,
  });
}

/**
 * Format next-steps result for LLM readability.
 */
export function formatNextStepsForLLM(result: CmosToolResult<NextStepsResult>): string {
  const lines = [renderNextStepsBody(result)];

  appendWriteFailures(lines, result.data?.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * The next-steps answer itself. Split out of formatNextStepsForLLM in s86-m02 so the envelope
 * warnings channel renders from one tail instead of once per action branch.
 */
function renderNextStepsBody(result: CmosToolResult<NextStepsResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return `Failed to manage next-steps: ${error?.message ?? 'Unknown error'}`;
  }

  const d = result.data;

  if (d.nextStepAction === 'list' && d.items) {
    if (d.items.length === 0) {
      return 'No pending next-steps found.';
    }
    const lines = [`**Next Steps (${d.items.length})**`, ''];
    for (const item of d.items) {
      const sprint = item.sprintId ? ` [${item.sprintId}]` : '';
      const mission = item.missionId ? ` (${item.missionId})` : '';
      lines.push(`  #${item.id} [${item.status}]${sprint}${mission}: ${item.content}`);
    }
    return lines.join('\n');
  }

  return d.message;
}
