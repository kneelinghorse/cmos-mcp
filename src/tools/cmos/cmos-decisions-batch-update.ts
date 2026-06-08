/**
 * cmos_decisions batch_update action
 *
 * Updates multiple decisions' status in a single operation.
 * Designed for efficient decision hygiene workflows.
 *
 * @module tools/cmos/cmos-decisions-batch-update
 */

import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, CmosErrors } from './errors';

export interface CmosDecisionsBatchUpdateResult {
  /** Number of decisions updated */
  updated: number;
  /** Total decisions requested */
  requested: number;
  /** IDs that were not found */
  notFound: number[];
  /** IDs that were already in the target status */
  alreadyInStatus: number[];
  /** New status applied */
  status: string;
  /** Confirmation message */
  message: string;
}

export interface CmosDecisionsBatchUpdateParams {
  /** Array of decision IDs to update */
  decisionIds: number[];
  /** Target status */
  status: string;
  /** Optional project root */
  projectRoot?: string;
}

const VALID_STATUSES = ['active', 'superseded', 'archived', 'stale'];
const MAX_BATCH_SIZE = 100;

export async function cmosDecisionsBatchUpdate(
  params: CmosDecisionsBatchUpdateParams
): Promise<CmosToolResult<CmosDecisionsBatchUpdateResult>> {
  if (!Array.isArray(params.decisionIds) || params.decisionIds.length === 0) {
    return createError(CmosErrors.missingParameter('decisionIds'));
  }

  if (params.decisionIds.length > MAX_BATCH_SIZE) {
    return createError({
      code: 'INVALID_PARAMETER',
      message: `Batch size ${params.decisionIds.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
      suggestion: `Split into batches of ${MAX_BATCH_SIZE} or fewer`,
    });
  }

  if (!params.status || !VALID_STATUSES.includes(params.status)) {
    return createError(CmosErrors.invalidParameter('status', params.status ?? '', VALID_STATUSES));
  }

  return withClientValidated(
    (client) => {
      const notFound: number[] = [];
      const alreadyInStatus: number[] = [];
      let updated = 0;

      for (const id of params.decisionIds) {
        const existing = client.getOne<{ id: number; status: string }>(
          'SELECT id, status FROM strategic_decisions WHERE id = ?',
          [id]
        );

        if (!existing.success || !existing.data) {
          notFound.push(id);
          continue;
        }

        if (existing.data.status === params.status) {
          alreadyInStatus.push(id);
          continue;
        }

        const result = client.execute('UPDATE strategic_decisions SET status = ? WHERE id = ?', [
          params.status,
          id,
        ]);

        if (result.success && (result.data?.changes ?? 0) > 0) {
          updated++;
        }
      }

      const parts: string[] = [`${updated} decision(s) updated to '${params.status}'`];
      if (notFound.length > 0) parts.push(`${notFound.length} not found`);
      if (alreadyInStatus.length > 0)
        parts.push(`${alreadyInStatus.length} already '${params.status}'`);

      return {
        success: true as const,
        data: {
          updated,
          requested: params.decisionIds.length,
          notFound,
          alreadyInStatus,
          status: params.status,
          message: parts.join(', '),
        },
      };
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatDecisionsBatchUpdateForLLM(
  result: CmosToolResult<CmosDecisionsBatchUpdateResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to batch update decisions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = result.data;
  const lines = ['✓ **Batch Decision Update**', '', d.message];

  if (d.notFound.length > 0) {
    lines.push(`  Not found: [${d.notFound.join(', ')}]`);
  }

  return lines.join('\n');
}
