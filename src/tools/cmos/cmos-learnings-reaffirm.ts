// ABOUTME: cmos_learnings(action="reaffirm") — mark an evergreen learning as still valid
// by bumping last_reviewed_at without changing status. Stops staleness re-firing on triaged
// learnings each sprint (Sprint 52 m03).

import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { ensureReviewTimestamps, ensureLearningsTable } from './schema-migrations';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';

/**
 * MODELLED ON `CmosLearningsUpdateResult`, NOT ON `cmos-constraints.ts` reaffirmConstraint —
 * recorded here so the wrong model is not copied later (s86-m03 correction 1).
 *
 * The s85-m06 objective said to copy `reaffirmConstraint` because it "returns a previous/new
 * pair". Its conditional UPDATE (cmos-constraints.ts:367-374) IS the right SQL pattern and is
 * what the handler below copies. But `ConstraintsResult` carries NO such pair: its `createSuccess`
 * (cmos-constraints.ts:383-389) returns constraintAction / constraintId / reaffirmedAt / affected /
 * message, and the flag appears only inside the free-text `message` built at :382. The surface
 * that genuinely returns the pair is `CmosLearningsUpdateResult` (cmos-learnings-update.ts), so
 * that is what `previousEvergreen` / `newEvergreen` below are modelled on — including its `=== 1`
 * integer coercion, because `evergreen` is stored `INTEGER NOT NULL DEFAULT 0`
 * (schema-migrations.ts:261/:273) and a truthy cast would publish 1/0 where the type says boolean.
 */
export interface CmosLearningsReaffirmResult {
  /** ID of the reaffirmed learning */
  learningId: number;
  /** Status after reaffirm (unchanged from before) */
  status: string;
  /** ISO timestamp the review was recorded at */
  reaffirmedAt: string;
  /** Evergreen flag as it stood BEFORE this reaffirm (s86-m03). */
  previousEvergreen: boolean;
  /** Evergreen flag after this reaffirm — equal to the previous one when `evergreen` was omitted. */
  newEvergreen: boolean;
  /** Confirmation message */
  message: string;
}

export interface CmosLearningsReaffirmParams {
  /** Learning ID to reaffirm */
  learningId: number;

  /**
   * s86-m03 — evergreen flag, live on `reaffirm` as it already was on `update`.
   * Two-way: `true` sets the flag, `false` clears it, omitted leaves it unchanged.
   */
  evergreen?: boolean;

  /** Optional: explicit project root */
  projectRoot?: string;
}

/**
 * Bump last_reviewed_at on an existing learning without changing its status.
 *
 * Use this when triaging evergreen learnings — staleness detection respects the review
 * timestamp (COALESCE(last_reviewed_at, created_at)) so a reaffirmed learning won't get
 * re-flagged next sprint.
 */
export async function cmosLearningsReaffirm(
  params: CmosLearningsReaffirmParams
): Promise<CmosToolResult<CmosLearningsReaffirmResult>> {
  if (!params.learningId || typeof params.learningId !== 'number') {
    return createError(CmosErrors.missingParameter('learningId'));
  }

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      // Sprint 52 m03: ensure last_reviewed_at exists so we can bump it on reaffirm.
      // s86-m03: ensure the evergreen column exists before we read/write it. It is created by a
      // DIFFERENT migration (ensureLearningsTable, schema-migrations.ts:242, ALTER at :271-277)
      // than last_reviewed_at, so reading evergreen with only ensureReviewTimestamps throws
      // `no such column: evergreen` on any store predating s61-m03. Mirrors
      // cmos-learnings-update.ts:85-88, which calls both for the same reason.
      warnings.push(...(ensureReviewTimestamps(client).warnings ?? []));
      warnings.push(...(ensureLearningsTable(client).warnings ?? []));

      const existing = client.getOne<{ id: number; status: string; evergreen: number | null }>(
        'SELECT id, status, evergreen FROM learnings WHERE id = ?',
        [params.learningId]
      );

      if (!existing.success || !existing.data) {
        return createError<CmosLearningsReaffirmResult>({
          code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
          message: `Learning #${params.learningId} not found`,
          suggestion: 'Use cmos_learnings list to find valid learning IDs',
        });
      }

      const previousEvergreen = existing.data.evergreen === 1;
      const newEvergreen = params.evergreen === undefined ? previousEvergreen : params.evergreen;

      const nowIso = new Date().toISOString();
      // s86-m03: conditional UPDATE on the cmos-constraints.ts:367-374 pattern — when `evergreen`
      // is omitted this is the unchanged Sprint-52 reaffirm (review clock only); when supplied it
      // sets/clears the durable flag alongside the bump.
      const updateResult =
        params.evergreen === undefined
          ? client.execute('UPDATE learnings SET last_reviewed_at = ? WHERE id = ?', [
              nowIso,
              params.learningId,
            ])
          : client.execute(
              'UPDATE learnings SET last_reviewed_at = ?, evergreen = ? WHERE id = ?',
              [nowIso, params.evergreen ? 1 : 0, params.learningId]
            );

      // s86-m02b: the failure arm runs through checkWrite so the DB's own code and message reach
      // the answer, rather than a generic phrase substituted on the database's behalf. A failed
      // UPDATE is an ERROR here, not a warning — the write is the entire point of the call, so
      // reporting `newEvergreen` off an UPDATE that never ran would be this sprint's own class.
      const writeSink: string[] = [];
      if (!checkWrite(updateResult, writeSink, 'learnings.reaffirm')) {
        return createError<CmosLearningsReaffirmResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to reaffirm learning: ${writeSink[0] ?? 'Unknown error'}`,
        });
      }

      return createSuccess<CmosLearningsReaffirmResult>({
        learningId: params.learningId,
        status: existing.data.status,
        reaffirmedAt: nowIso,
        previousEvergreen,
        newEvergreen,
        message:
          params.evergreen === undefined
            ? `Learning #${params.learningId} reaffirmed — last_reviewed_at bumped`
            : `Learning #${params.learningId} reaffirmed — last_reviewed_at bumped, evergreen ${previousEvergreen ? 'true' : 'false'} → ${newEvergreen ? 'true' : 'false'}`,
      });
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

export function formatLearningsReaffirmForLLM(
  result: CmosToolResult<CmosLearningsReaffirmResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to reaffirm learning',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ].filter(Boolean);
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const d = result.data;
  const lines = [
    '✓ **Learning Reaffirmed**',
    '',
    `**Learning**: #${d.learningId}`,
    `**Status**: ${d.status} (unchanged)`,
    `**Reaffirmed at**: ${d.reaffirmedAt}`,
    d.previousEvergreen === d.newEvergreen
      ? `**Evergreen**: ${d.newEvergreen} (unchanged)`
      : `**Evergreen**: ${d.previousEvergreen} → ${d.newEvergreen}`,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}
