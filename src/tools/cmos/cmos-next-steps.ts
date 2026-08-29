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
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
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

/**
 * s87-m06 — WHICH statuses a next-step transition may move OUT of. Exactly two, and no others.
 *
 * It was `status = 'pending'` at all three write sites, so a row CARRIED to a later sprint could
 * never afterwards be completed, dropped, or re-carried by id. That is not hypothetical: rows
 * #486, #492 and #493 are stamped `carried_to_sprint='sprint-86'`, were still open at sprint-87,
 * and were frozen — they could only age.
 *
 * `'completed'` IS DELIBERATELY NOT ADMITTED. `write-disclosure-next-steps.test.ts` CRITERION 8
 * seeds a completed row and asserts that transitioning it reports `affected: 0` with no write
 * failure and no warning; admitting it breaks all five of that test's assertions. If that test
 * needs editing to accommodate a change here, the change is wrong — not the test.
 *
 * DO NOT COPY THIS TO `cmos-sprint-complete.ts`. Its predicate looks identical and has the
 * OPPOSITE short-count semantics: it re-SELECTs its id set under the same predicate inside the
 * same transaction, so a short count THERE really does imply an error and is warned about. Same
 * SQL fragment, different call-site judgement — `write-disclosure-next-steps.test.ts` says so in
 * a docblock.
 */
const TRANSITIONABLE_STATUS = "status IN ('pending','carried')";

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
  /**
   * s87-m06 — WHICH requested ids the transition did not match.
   *
   * `affected` says HOW MANY rows moved. Asking for 12 and getting 10 told an operator that two
   * ids did nothing and gave them no way to find out which two. These ids are not failures and
   * are deliberately NOT reported as such: the statement ran and its WHERE matched nothing, which
   * is an ordinary outcome for an id that is already completed, already dropped, or does not
   * exist. `writeFailures` means the database REJECTED something, and conflating the two would
   * tell an operator a write failed when none did — the "say only what you know" violation this
   * fix exists to close, committed inside the fix.
   *
   * Absent on `list`, which writes nothing. Empty when every requested id matched.
   */
  unmatchedIds?: number[];
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

  const migrationWarnings: string[] = [];
  const result = await withClient(
    (client) => {
      migrationWarnings.push(...(ensureNextStepsTable(client).warnings ?? []));

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
  return attachWarnings(result, migrationWarnings);
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
  const unmatchedIds: number[] = [];

  for (const id of ids) {
    const result = client.execute(
      `UPDATE next_steps SET status = ?, resolved_at = ? WHERE id = ? AND ${TRANSITIONABLE_STATUS}`,
      [targetStatus, now, id]
    );
    // s86-m02b: the ids come from the TOOL CALL and were never re-selected, so `changes: 0` on a
    // statement that RAN means "no transitionable row with that id" — legitimate, and countWrite
    // records nothing for it. Only an errored statement reaches writeSink.
    // s87-m06: that zero is now NAMED rather than merely not-counted. It is the value countWrite
    // already returns; nothing new is computed.
    const changed = countWrite(result, writeSink, `${op} #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: targetStatus === 'completed' ? 'complete' : 'drop',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
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
      `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE ${TRANSITIONABLE_STATUS}`,
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
  const unmatchedIds: number[] = [];
  for (const id of ids) {
    const result = client.execute(
      `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE id = ? AND ${TRANSITIONABLE_STATUS}`,
      [now, targetSprint, id]
    );
    // Caller-supplied id: a zero from a WHERE that matched no transitionable row is ordinary and
    // is not a write failure. s87-m06 names it instead of discarding it.
    const changed = countWrite(result, writeSink, `next_steps.carry #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: 'carry',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
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

  // s87-m06 — the unmatched ids, on a NEUTRAL line, and the neutrality is the whole design.
  //
  // It carries neither the WRITE-FAILURE heading nor the WARNINGS heading nor the
  // `next_steps.<op> #<id>` write-failure format, because an id that matched no transitionable
  // row is NOT a failure: the statement ran and its WHERE matched nothing. Announcing it as a
  // write failure would tell an operator the database rejected something it did not — which is
  // precisely the "say only what you know" violation this whole sprint is closing, committed
  // inside the fix for it. `write-disclosure-next-steps.test.ts` CRITERION 8 names that
  // temptation in as many words and must keep passing UNMODIFIED; a plain extra line trips none
  // of its five assertions.
  //
  // Placed BEFORE the two envelope channels so an operator reads what happened before reading
  // what went wrong — and so a reader can tell at a glance that it is neither of those things.
  const unmatched = result.data?.unmatchedIds ?? [];
  if (unmatched.length > 0) {
    lines.push('');
    lines.push(
      `Not matched (already resolved, or no such id): ${unmatched.map((id) => `#${id}`).join(', ')}`
    );
  }

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
