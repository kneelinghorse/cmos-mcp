/**
 * cmos_decisions update action
 *
 * Updates a strategic decision's superseded_by and/or status fields.
 * Automatically sets status='superseded' when superseded_by is set.
 *
 * @module tools/cmos/cmos-decisions-update
 */

import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';

export interface CmosDecisionsUpdateResult {
  /** ID of the updated decision */
  decisionId: number;

  /** Previous status */
  previousStatus: string;

  /** New status after update */
  newStatus: string;

  /** ID of the superseding decision (if set) */
  supersededBy: number | null;

  /** Confirmation message */
  message: string;
}

export interface CmosDecisionsUpdateParams {
  /** Decision ID to update */
  decisionId: number;

  /** ID of the decision that supersedes this one */
  supersededBy?: number;

  /** New status (auto-set to 'superseded' when supersededBy is provided) */
  status?: string;

  /** Optional project root */
  projectRoot?: string;
}

const VALID_STATUSES = ['active', 'superseded', 'archived', 'stale'];

export async function cmosDecisionsUpdate(
  params: CmosDecisionsUpdateParams
): Promise<CmosToolResult<CmosDecisionsUpdateResult>> {
  if (!params.decisionId || typeof params.decisionId !== 'number') {
    return createError(CmosErrors.missingParameter('decisionId'));
  }

  if (params.status && !VALID_STATUSES.includes(params.status)) {
    return createError(CmosErrors.invalidParameter('status', params.status, VALID_STATUSES));
  }

  return withClientValidated(
    (client) => {
      // Fetch the existing decision
      const existing = client.getOne<{
        id: number;
        status: string;
        superseded_by: number | null;
      }>('SELECT id, status, superseded_by FROM strategic_decisions WHERE id = ?', [
        params.decisionId,
      ]);

      if (!existing.success || !existing.data) {
        return createError<CmosDecisionsUpdateResult>({
          code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
          message: `Decision #${params.decisionId} not found`,
          suggestion: 'Use cmos_decisions list to find valid decision IDs',
        });
      }

      const previousStatus = existing.data.status;

      // If supersededBy is provided, validate the target exists
      if (params.supersededBy !== undefined) {
        const target = client.getOne<{ id: number }>(
          'SELECT id FROM strategic_decisions WHERE id = ?',
          [params.supersededBy]
        );

        if (!target.success || !target.data) {
          return createError<CmosDecisionsUpdateResult>({
            code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
            message: `Superseding decision #${params.supersededBy} not found`,
            suggestion: 'The supersededBy value must reference an existing decision ID',
          });
        }

        if (params.supersededBy === params.decisionId) {
          return createError<CmosDecisionsUpdateResult>({
            code: 'INVALID_PARAMETER',
            message: 'A decision cannot supersede itself',
          });
        }
      }

      // Determine new status
      let newStatus = params.status ?? previousStatus;
      if (params.supersededBy !== undefined && !params.status) {
        // Auto-set status to 'superseded' when supersededBy is provided
        newStatus = 'superseded';
      }

      // Build update
      const sets: string[] = [];
      const updateParams: (string | number | null)[] = [];

      if (newStatus !== previousStatus) {
        sets.push('status = ?');
        updateParams.push(newStatus);
      }

      if (params.supersededBy !== undefined) {
        sets.push('superseded_by = ?');
        updateParams.push(params.supersededBy);
      }

      if (sets.length === 0) {
        return createSuccess<CmosDecisionsUpdateResult>({
          decisionId: params.decisionId,
          previousStatus,
          newStatus,
          supersededBy: existing.data.superseded_by,
          message: 'No changes needed',
        });
      }

      updateParams.push(params.decisionId);
      const updateResult = client.execute(
        `UPDATE strategic_decisions SET ${sets.join(', ')} WHERE id = ?`,
        updateParams
      );

      if (!updateResult.success) {
        return createError<CmosDecisionsUpdateResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update decision: ${updateResult.error?.message ?? 'Unknown error'}`,
        });
      }

      const finalSupersededBy = params.supersededBy ?? existing.data.superseded_by;

      return createSuccess<CmosDecisionsUpdateResult>({
        decisionId: params.decisionId,
        previousStatus,
        newStatus,
        supersededBy: finalSupersededBy,
        message: `Decision #${params.decisionId} updated: status ${previousStatus} → ${newStatus}${
          params.supersededBy !== undefined ? `, superseded by #${params.supersededBy}` : ''
        }`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatDecisionsUpdateForLLM(
  result: CmosToolResult<CmosDecisionsUpdateResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to update decision',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = result.data;
  const lines = [
    '✓ **Decision Updated**',
    '',
    `**Decision**: #${d.decisionId}`,
    `**Status**: ${d.previousStatus} → ${d.newStatus}`,
  ];

  if (d.supersededBy !== null) {
    lines.push(`**Superseded By**: #${d.supersededBy}`);
  }

  return lines.join('\n');
}
