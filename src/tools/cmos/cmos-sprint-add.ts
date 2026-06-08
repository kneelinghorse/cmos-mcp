/**
 * cmos_sprint_add Tool
 *
 * MCP tool for creating new sprints in the CMOS database.
 * Validates sprint ID uniqueness and required fields.
 *
 * @module tools/cmos/cmos-sprint-add
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';

/**
 * Result type for cmos_sprint_add.
 */
export interface SprintAddResult {
  /** Created sprint ID */
  id: string;

  /** Sprint title */
  title: string;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters schema for cmos_sprint_add tool.
 */
export const cmosSprintAddSchema = z.object({
  /** Unique sprint identifier */
  sprintId: z.string().min(1).describe('Unique sprint identifier (e.g., "sprint-15")'),

  /** Sprint title */
  title: z.string().min(1).describe('Sprint title (required)'),

  /** Strategic focus of the sprint */
  focus: z.string().optional().describe('Strategic focus or theme of the sprint'),

  /** Sprint status */
  status: z
    .string()
    .optional()
    .describe('Sprint status (default: "Active"). Common values: Active, Completed, Planned'),

  /** Start date in ISO format */
  startDate: z.string().optional().describe('Start date in ISO format (e.g., "2025-01-01")'),

  /** End date in ISO format */
  endDate: z.string().optional().describe('End date in ISO format (e.g., "2025-01-15")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSprintAddParams = z.infer<typeof cmosSprintAddSchema>;

/**
 * MCP Tool Definition for cmos_sprint_add.
 */
export const cmosSprintAddToolDefinition = {
  name: 'cmos_sprint_add',
  description:
    'Create a new sprint in the CMOS database. ' +
    'Requires a unique sprint ID and title. ' +
    'Optionally set focus, status, and date range.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'Unique sprint identifier (e.g., "sprint-15")',
      },
      title: {
        type: 'string',
        description: 'Sprint title (required)',
      },
      focus: {
        type: 'string',
        description: 'Strategic focus or theme of the sprint',
      },
      status: {
        type: 'string',
        description: 'Sprint status (default: "Active"). Common values: Active, Completed, Planned',
      },
      startDate: {
        type: 'string',
        description: 'Start date in ISO format (e.g., "2025-01-01")',
      },
      endDate: {
        type: 'string',
        description: 'End date in ISO format (e.g., "2025-01-15")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['sprintId', 'title'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_sprint_add tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with created sprint or actionable error
 */
export async function cmosSprintAdd(
  params: CmosSprintAddParams
): Promise<CmosToolResult<SprintAddResult>> {
  const { sprintId, title, focus, status, startDate, endDate } = params;

  // Validate required parameters
  if (!sprintId || sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  if (!title || title.trim() === '') {
    return createError(CmosErrors.missingParameter('title'));
  }

  return withClientValidated(
    (client) => {
      // Check if sprint ID already exists
      const existingResult = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
        sprintId,
      ]);

      if (!existingResult.success) {
        return createError<SprintAddResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check sprint' }
        );
      }

      if (existingResult.data) {
        return createError<SprintAddResult>(CmosErrors.sprintIdExists(sprintId));
      }

      // Insert new sprint
      const g = genesisColumns(client, 'sprints', getProjectId(client));
      const insertResult = client.execute(
        `INSERT INTO sprints (id, title, focus, status, start_date, end_date, ${g.columns.join(', ')})
        VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
        [
          sprintId,
          title.trim(),
          focus?.trim() || null,
          status?.trim() || 'Active',
          startDate?.trim() || null,
          endDate?.trim() || null,
          ...g.values,
        ]
      );

      if (!insertResult.success) {
        return createError<SprintAddResult>(
          insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create sprint' }
        );
      }

      if (insertResult.data?.changes === 0) {
        return createError<SprintAddResult>({
          code: 'DB_QUERY_FAILED',
          message: 'Sprint was not created (no rows affected)',
          suggestion: 'Check database permissions and try again',
        });
      }

      return createSuccess({
        id: sprintId,
        title: title.trim(),
        message: `Sprint '${sprintId}' created successfully`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format sprint add result for LLM readability.
 *
 * @param result - Sprint add result
 * @returns Human-readable summary
 */
export function formatSprintAddForLLM(result: CmosToolResult<SprintAddResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to create sprint', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    '✓ Sprint created successfully',
    '',
    `   ID: ${data.id}`,
    `   Title: ${data.title}`,
  ];

  return lines.join('\n');
}
