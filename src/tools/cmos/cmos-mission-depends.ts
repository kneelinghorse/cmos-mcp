/**
 * cmos_mission_depends Tool
 *
 * MCP tool for creating mission dependencies in the CMOS database.
 * Supports dependency types: Blocks, Requires, Enables.
 *
 * @module tools/cmos/cmos-mission-depends
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { appendWarnings } from './format-warnings';
import { checkWrite } from './write-guard';

/**
 * Valid dependency types.
 */
export const VALID_DEPENDENCY_TYPES = ['Blocks', 'Requires', 'Enables'] as const;
export type DependencyType = (typeof VALID_DEPENDENCY_TYPES)[number];

export const MISSION_DEPENDENCY_DISCLOSURE =
  'Dependency relationships are recorded for ordering and graph expansion; they are not enforced at mission start or completion.';

/**
 * Result type for cmos_mission_depends.
 */
export interface MissionDependsResult {
  /** The dependent mission ID */
  fromId: string;

  /** The dependency mission ID */
  toId: string;

  /** Dependency type */
  type: DependencyType;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters schema for cmos_mission_depends tool.
 */
export const cmosMissionDependsSchema = z.object({
  /** The dependent mission ID */
  fromId: z
    .string()
    .min(1)
    .describe('The dependent mission ID (the mission that depends on another)'),

  /** The dependency mission ID */
  toId: z.string().min(1).describe('The dependency mission ID (the mission being depended upon)'),

  /** Dependency type */
  type: z
    .enum(['Blocks', 'Requires', 'Enables'])
    .describe(
      `Dependency label: 'Blocks', 'Requires', or 'Enables'. ${MISSION_DEPENDENCY_DISCLOSURE}`
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionDependsParams = z.infer<typeof cmosMissionDependsSchema>;

/**
 * MCP Tool Definition for cmos_mission_depends.
 */
export const cmosMissionDependsToolDefinition = {
  name: 'cmos_mission_depends',
  description:
    'Create a dependency relationship between two missions in the CMOS database. ' +
    "Validates that both missions exist. Supports relationship labels: 'Blocks', 'Requires', and 'Enables'. " +
    MISSION_DEPENDENCY_DISCLOSURE,
  inputSchema: {
    type: 'object',
    properties: {
      fromId: {
        type: 'string',
        description: 'The dependent mission ID (the mission that depends on another)',
      },
      toId: {
        type: 'string',
        description: 'The dependency mission ID (the mission being depended upon)',
      },
      type: {
        type: 'string',
        enum: ['Blocks', 'Requires', 'Enables'],
        description: `Dependency label: 'Blocks', 'Requires', or 'Enables'. ${MISSION_DEPENDENCY_DISCLOSURE}`,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['fromId', 'toId', 'type'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_depends tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with dependency creation result or actionable error
 */
export async function cmosMissionDepends(
  params: CmosMissionDependsParams
): Promise<CmosToolResult<MissionDependsResult>> {
  const { fromId, toId, type } = params;

  // Validate required parameters
  if (!fromId || fromId.trim() === '') {
    return createError(CmosErrors.missingParameter('fromId'));
  }

  if (!toId || toId.trim() === '') {
    return createError(CmosErrors.missingParameter('toId'));
  }

  if (!type) {
    return createError(CmosErrors.missingParameter('type'));
  }

  // Validate dependency type
  if (!VALID_DEPENDENCY_TYPES.includes(type)) {
    return createError(CmosErrors.invalidParameter('type', type, [...VALID_DEPENDENCY_TYPES]));
  }

  // Prevent self-dependency
  if (fromId.trim() === toId.trim()) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'A mission cannot depend on itself',
      suggestion: 'Provide different mission IDs for fromId and toId',
    });
  }

  return withClientValidated(
    (client) => {
      const warnings: string[] = [];

      // Verify fromId mission exists
      const fromResult = client.getOne<{ id: string }>('SELECT id FROM missions WHERE id = ?', [
        fromId.trim(),
      ]);

      if (!fromResult.success) {
        return createError<MissionDependsResult>(
          fromResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to verify mission' }
        );
      }

      if (!fromResult.data) {
        return createError<MissionDependsResult>(CmosErrors.missionNotFound(fromId));
      }

      // Verify toId mission exists
      const toResult = client.getOne<{ id: string }>('SELECT id FROM missions WHERE id = ?', [
        toId.trim(),
      ]);

      if (!toResult.success) {
        return createError<MissionDependsResult>(
          toResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to verify mission' }
        );
      }

      if (!toResult.data) {
        return createError<MissionDependsResult>(CmosErrors.missionNotFound(toId));
      }

      // Check if dependency already exists
      const existingResult = client.getOne<{ from_id: string; to_id: string }>(
        'SELECT from_id, to_id FROM mission_dependencies WHERE from_id = ? AND to_id = ?',
        [fromId.trim(), toId.trim()]
      );

      if (!existingResult.success) {
        return createError<MissionDependsResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check dependency' }
        );
      }

      if (existingResult.data) {
        return createError<MissionDependsResult>({
          code: CMOS_ERROR_CODES.INVALID_PARAMETER,
          message: `Dependency from '${fromId}' to '${toId}' already exists`,
          suggestion: 'Use a different pair of missions or remove the existing dependency first',
        });
      }

      // Insert the dependency
      const insertResult = client.execute(
        `INSERT INTO mission_dependencies (from_id, to_id, type)
         VALUES (?, ?, ?)`,
        [fromId.trim(), toId.trim(), type]
      );

      if (!insertResult.success) {
        return createError<MissionDependsResult>(
          insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create dependency' }
        );
      }

      if (insertResult.data?.changes === 0) {
        return createError<MissionDependsResult>({
          code: 'DB_QUERY_FAILED',
          message: 'Dependency was not created (no rows affected)',
          suggestion: 'Check database permissions and try again',
        });
      }

      // Log creation event
      const now = new Date().toISOString();
      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'dependency', ?, ?, ?)`,
        [
          now,
          fromId,
          'dependency_created',
          `Created ${type} dependency: ${fromId} -> ${toId}`,
          JSON.stringify({
            tool: 'cmos_mission_depends',
            fromId: fromId.trim(),
            toId: toId.trim(),
            type,
          }),
        ]
      );

      checkWrite(eventResult, warnings, 'mission dependency create event logging');

      const description =
        `Recorded ${type} dependency: '${fromId.trim()}' -> '${toId.trim()}'. ` +
        MISSION_DEPENDENCY_DISCLOSURE;

      return createSuccess(
        {
          fromId: fromId.trim(),
          toId: toId.trim(),
          type,
          message: description,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format mission depends result for LLM readability.
 *
 * @param result - Mission depends result
 * @returns Human-readable summary
 */
export function formatMissionDependsForLLM(result: CmosToolResult<MissionDependsResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'Failed to create mission dependency',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    'Dependency created',
    '',
    `From: ${data.fromId}`,
    `To: ${data.toId}`,
    `Type: ${data.type}`,
    '',
    data.message,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}
