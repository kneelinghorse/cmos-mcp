/**
 * cmos_sprint_update Tool
 *
 * MCP tool for partially updating sprint fields in the CMOS database.
 * Only provided fields are updated, others remain unchanged.
 *
 * @module tools/cmos/cmos-sprint-update
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult, Sprint } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { isOpenStatus } from './terminal-status';
import { buildDemotionWarning, writeSingleCurrentSprint } from './sprint-current-invariant';
import { appendWarnings, attachWarnings } from './format-warnings';
import { syncSprintTracking } from './sprint-tracking';

/**
 * Fields that can be updated on a sprint.
 */
export interface SprintUpdateFields {
  /** Sprint title */
  title?: string;

  /** Strategic focus of the sprint */
  focus?: string;

  /** Sprint status */
  status?: string;

  /** Start date in ISO format */
  startDate?: string;

  /** End date in ISO format */
  endDate?: string;
}

/**
 * Result of updating a sprint.
 */
export interface SprintUpdateResult {
  /** The sprint ID that was updated */
  sprintId: string;

  /** Fields that were updated */
  updatedFields: string[];

  /** Human-readable message */
  message: string;

  /**
   * s92-m02 — present when this update moved the sprint INTO Completed without an explicit
   * endDate: the actual close time it stamped as end_date. Closing by status update is a real
   * close, and the next-step lease counts closes by end_date.
   */
  endDateStamped?: string;

  /** s92-m02 — with endDateStamped: the end_date the sprint carried before (null when none). */
  plannedEndDate?: string | null;
}

/**
 * Input parameters schema for cmos_sprint_update tool.
 */
export const cmosSprintUpdateSchema = z.object({
  /** The sprint ID to update */
  sprintId: z.string().min(1).describe('The sprint ID to update (e.g., "sprint-14")'),

  /** Fields to update (only provided fields are changed) */
  fields: z
    .object({
      title: z.string().optional().describe('Sprint title'),
      focus: z.string().optional().describe('Strategic focus or theme of the sprint'),
      status: z.string().optional().describe('Sprint status (e.g., "Active", "Completed")'),
      startDate: z.string().optional().describe('Start date in ISO format (e.g., "2025-01-01")'),
      endDate: z.string().optional().describe('End date in ISO format (e.g., "2025-01-15")'),
    })
    .describe('Fields to update (only provided fields are changed)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSprintUpdateParams = z.infer<typeof cmosSprintUpdateSchema>;

/**
 * MCP Tool Definition for cmos_sprint_update.
 */
export const cmosSprintUpdateToolDefinition = {
  name: 'cmos_sprint_update',
  description:
    'Update specific fields of a sprint without replacing the entire record. ' +
    'Only provided fields are updated, others remain unchanged. ' +
    'Use this to modify sprint title, focus, status, or date range.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'The sprint ID to update (e.g., "sprint-14")',
      },
      fields: {
        type: 'object',
        description: 'Fields to update (only provided fields are changed)',
        properties: {
          title: {
            type: 'string',
            description: 'Sprint title',
          },
          focus: {
            type: 'string',
            description: 'Strategic focus or theme of the sprint',
          },
          status: {
            type: 'string',
            description: 'Sprint status (e.g., "Active", "Completed")',
          },
          startDate: {
            type: 'string',
            description: 'Start date in ISO format (e.g., "2025-01-01")',
          },
          endDate: {
            type: 'string',
            description: 'End date in ISO format (e.g., "2025-01-15")',
          },
        },
        additionalProperties: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['sprintId', 'fields'],
    additionalProperties: false,
  },
} as const;

/** Map of `fields` keys to database column names; a key outside it is refused by name. */
const SPRINT_UPDATE_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  focus: 'focus',
  status: 'status',
  startDate: 'start_date',
  endDate: 'end_date',
};

/**
 * Execute the cmos_sprint_update tool.
 *
 * @param params - Tool parameters (sprintId, fields, projectRoot)
 * @returns CmosToolResult with update result or actionable error
 */
export async function cmosSprintUpdate(
  params: CmosSprintUpdateParams
): Promise<CmosToolResult<SprintUpdateResult>> {
  // Validate required parameter
  if (!params.sprintId || params.sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  const sprintId = params.sprintId.trim();
  const fields = params.fields;

  // Check if any fields are provided
  const fieldKeys = Object.keys(fields).filter(
    (k) => fields[k as keyof SprintUpdateFields] !== undefined
  );

  if (fieldKeys.length === 0) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'No fields provided to update',
      suggestion:
        'Provide `fields: { ... }` with at least one of title, focus, status, startDate, endDate; ' +
        'a bare top-level `status` is not read.',
    });
  }

  // s91-m02 Fix 3: an unknown key used to be skipped while the receipt reported it as written,
  // and an all-unknown object built `UPDATE sprints SET  WHERE id = ?`. Refuse it by name.
  const unknownKey = fieldKeys.find((key) => !(key in SPRINT_UPDATE_COLUMNS));
  if (unknownKey !== undefined) {
    return createError(
      CmosErrors.invalidParameter(
        `fields.${unknownKey}`,
        fields[unknownKey as keyof SprintUpdateFields],
        Object.keys(SPRINT_UPDATE_COLUMNS)
      )
    );
  }

  return withClientValidated(
    (client) => {
      // Check if sprint exists (s92-m02: also read status/end_date to detect a close)
      const sprintResult = client.getOne<Sprint>(
        'SELECT id, status, end_date FROM sprints WHERE id = ?',
        [sprintId]
      );

      if (!sprintResult.success) {
        return createError<SprintUpdateResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query sprint' }
        );
      }

      if (!sprintResult.data) {
        return createError<SprintUpdateResult>(CmosErrors.sprintNotFound(sprintId));
      }

      // s92-m02 — moving a sprint INTO Completed is a close. Stamp the actual close time as
      // end_date unless the caller set endDate in the same update; a planned end date left in
      // place would be counted by the next-step lease as a close every later carry survived.
      const closing =
        fields.status?.trim() === 'Completed' && sprintResult.data.status !== 'Completed';
      const explicitEndDate = fields.endDate?.trim();
      const endDateStamped =
        closing && (explicitEndDate === undefined || explicitEndDate === '')
          ? new Date().toISOString()
          : undefined;
      const futureEndDateWarning =
        closing &&
        explicitEndDate &&
        !Number.isNaN(Date.parse(explicitEndDate)) &&
        Date.parse(explicitEndDate) > Date.now()
          ? `endDate '${explicitEndDate}' is in the future: the next-step lease does not count this close until that date. Omit endDate to stamp the actual close time.`
          : undefined;

      // The primary write: build + run the dynamic UPDATE from the provided fields.
      const applyUpdate = (): CmosToolResult<void> => {
        const setClauses: string[] = [];
        const queryParams: (string | null)[] = [];
        if (endDateStamped !== undefined) {
          setClauses.push('end_date = ?');
          queryParams.push(endDateStamped);
        }

        for (const key of fieldKeys) {
          const dbColumn = SPRINT_UPDATE_COLUMNS[key];
          if (!dbColumn) continue;
          // An empty endDate on a close is "not provided": the stamped close time stands.
          if (key === 'endDate' && endDateStamped !== undefined) continue;

          const value = fields[key as keyof SprintUpdateFields];
          if (value === undefined) continue;

          setClauses.push(`${dbColumn} = ?`);
          queryParams.push(value.trim() || null);
        }

        // Add sprintId as the last parameter for WHERE clause
        queryParams.push(sprintId);

        const updateQuery = `
        UPDATE sprints
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `;

        const updateResult = client.execute(updateQuery, queryParams);

        if (!updateResult.success) {
          return createError<void>(
            updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update sprint' }
          );
        }

        if (updateResult.data?.changes === 0) {
          return createError<void>({
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to update sprint '${sprintId}'`,
            suggestion: 'The sprint may have been modified by another process',
          });
        }

        return createSuccess<void>(undefined);
      };

      const message = `Sprint '${sprintId}' updated successfully (${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'})`;
      const success = (warnings?: string[]): CmosToolResult<SprintUpdateResult> => {
        const all = [...(warnings ?? []), ...(futureEndDateWarning ? [futureEndDateWarning] : [])];
        return createSuccess(
          {
            sprintId,
            updatedFields: fieldKeys,
            message,
            ...(endDateStamped !== undefined
              ? { endDateStamped, plannedEndDate: sprintResult.data!.end_date ?? null }
              : {}),
          },
          all.length > 0 ? all : undefined
        );
      };

      // Single-current-sprint invariant (s77-m01): only when this update puts the
      // sprint INTO the OPEN set do we demote the other open sprints (atomically).
      // A field-only edit or a move to a non-open status opens no new work, so it
      // takes the plain UPDATE path and demotes nothing.
      const nextStatus = fields.status?.trim();
      const willBecomeOpen =
        nextStatus !== undefined && nextStatus !== '' && isOpenStatus(nextStatus);

      // s91-m07: a status change moves master_context.sprint_tracking; a field-only edit does not.
      const trackingWarnings = (): string[] => {
        if (nextStatus === undefined) return [];
        const tracked: string[] = [];
        syncSprintTracking(client, tracked, nextStatus === 'Completed' ? sprintId : undefined);
        return tracked;
      };

      if (!willBecomeOpen) {
        const updated = applyUpdate();
        if (!updated.success) {
          return createError<SprintUpdateResult>(updated.error!);
        }
        const tracked = trackingWarnings();
        return success(tracked.length > 0 ? tracked : undefined);
      }

      const invariant = writeSingleCurrentSprint(client, sprintId, applyUpdate);
      if (!invariant.success) {
        return attachWarnings(
          createError<SprintUpdateResult>(invariant.error!),
          invariant.warnings ?? []
        );
      }
      const warning = buildDemotionWarning(invariant.data!.demoted);
      const warnings = [...(invariant.warnings ?? [])];
      if (warning) warnings.push(warning);
      warnings.push(...trackingWarnings());
      return success(warnings.length > 0 ? warnings : undefined);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format sprint update result for LLM readability.
 *
 * @param result - Sprint update result
 * @returns Human-readable formatted result
 */
export function formatSprintUpdateForLLM(result: CmosToolResult<SprintUpdateResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to update sprint', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `✓ Sprint '${data.sprintId}' updated`,
    '',
    `Updated fields: ${data.updatedFields.join(', ')}`,
  ];
  if (data.endDateStamped) {
    lines.push(
      `Closed: end_date stamped with the actual close time ${data.endDateStamped}` +
        (data.plannedEndDate ? ` (the planned end date was ${data.plannedEndDate})` : '')
    );
  }

  // Sprint 72 m02 (#790): render folded-in collab-sync warnings so a superseded
  // sprint_status push surfaces its restore hint to the operator.
  appendWarnings(lines, result);

  return lines.join('\n');
}
