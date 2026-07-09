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
        'Provide at least one field to update (e.g., title, focus, status, startDate, endDate)',
    });
  }

  return withClientValidated(
    (client) => {
      // Check if sprint exists
      const sprintResult = client.getOne<Sprint>('SELECT id FROM sprints WHERE id = ?', [sprintId]);

      if (!sprintResult.success) {
        return createError<SprintUpdateResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query sprint' }
        );
      }

      if (!sprintResult.data) {
        return createError<SprintUpdateResult>(CmosErrors.sprintNotFound(sprintId));
      }

      // Map of TypeScript field names to database column names
      const fieldMapping: Record<string, string> = {
        title: 'title',
        focus: 'focus',
        status: 'status',
        startDate: 'start_date',
        endDate: 'end_date',
      };

      // The primary write: build + run the dynamic UPDATE from the provided fields.
      const applyUpdate = (): CmosToolResult<void> => {
        const setClauses: string[] = [];
        const queryParams: (string | null)[] = [];

        for (const key of fieldKeys) {
          const dbColumn = fieldMapping[key];
          if (!dbColumn) continue;

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
      const success = (warnings?: string[]): CmosToolResult<SprintUpdateResult> =>
        createSuccess({ sprintId, updatedFields: fieldKeys, message }, warnings);

      // Single-current-sprint invariant (s77-m01): only when this update puts the
      // sprint INTO the OPEN set do we demote the other open sprints (atomically).
      // A field-only edit or a move to a non-open status opens no new work, so it
      // takes the plain UPDATE path and demotes nothing.
      const nextStatus = fields.status?.trim();
      const willBecomeOpen =
        nextStatus !== undefined && nextStatus !== '' && isOpenStatus(nextStatus);

      if (!willBecomeOpen) {
        const updated = applyUpdate();
        if (!updated.success) {
          return createError<SprintUpdateResult>(updated.error!);
        }
        return success();
      }

      const invariant = writeSingleCurrentSprint(client, sprintId, applyUpdate);
      if (!invariant.success) {
        return createError<SprintUpdateResult>(invariant.error!);
      }
      const warning = buildDemotionWarning(invariant.data!.demoted);
      return success(warning ? [warning] : undefined);
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

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `✓ Sprint '${data.sprintId}' updated`,
    '',
    `Updated fields: ${data.updatedFields.join(', ')}`,
  ];

  // Sprint 72 m02 (#790): render folded-in collab-sync warnings so a superseded
  // sprint_status push surfaces its restore hint to the operator.
  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}
