// ABOUTME: cmos_learnings(action="reaffirm") — mark an evergreen learning as still valid
// by bumping last_reviewed_at without changing status. Stops staleness re-firing on triaged
// learnings each sprint (Sprint 52 m03).

import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { ensureReviewTimestamps } from './schema-migrations';

export interface CmosLearningsReaffirmResult {
  /** ID of the reaffirmed learning */
  learningId: number;
  /** Status after reaffirm (unchanged from before) */
  status: string;
  /** ISO timestamp the review was recorded at */
  reaffirmedAt: string;
  /** Confirmation message */
  message: string;
}

export interface CmosLearningsReaffirmParams {
  /** Learning ID to reaffirm */
  learningId: number;
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

  return withClientValidated(
    (client) => {
      ensureReviewTimestamps(client);

      const existing = client.getOne<{ id: number; status: string }>(
        'SELECT id, status FROM learnings WHERE id = ?',
        [params.learningId]
      );

      if (!existing.success || !existing.data) {
        return createError<CmosLearningsReaffirmResult>({
          code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
          message: `Learning #${params.learningId} not found`,
          suggestion: 'Use cmos_learnings list to find valid learning IDs',
        });
      }

      const nowIso = new Date().toISOString();
      const updateResult = client.execute(
        'UPDATE learnings SET last_reviewed_at = ? WHERE id = ?',
        [nowIso, params.learningId]
      );

      if (!updateResult.success) {
        return createError<CmosLearningsReaffirmResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to reaffirm learning: ${updateResult.error?.message ?? 'Unknown error'}`,
        });
      }

      return createSuccess<CmosLearningsReaffirmResult>({
        learningId: params.learningId,
        status: existing.data.status,
        reaffirmedAt: nowIso,
        message: `Learning #${params.learningId} reaffirmed — last_reviewed_at bumped`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatLearningsReaffirmForLLM(
  result: CmosToolResult<CmosLearningsReaffirmResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to reaffirm learning',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = result.data;
  return [
    '✓ **Learning Reaffirmed**',
    '',
    `**Learning**: #${d.learningId}`,
    `**Status**: ${d.status} (unchanged)`,
    `**Reaffirmed at**: ${d.reaffirmedAt}`,
  ].join('\n');
}
