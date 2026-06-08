/**
 * cmos_mission_list Tool
 *
 * MCP tool for listing missions from the CMOS database.
 * Supports filtering by status, sprint, and pagination.
 * Returns structured mission objects with actionable error messages.
 *
 * @module tools/cmos/cmos-mission-list
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult, Mission, MissionStatus } from './types';
import { createError, createSuccess, CmosErrors, VALID_MISSION_STATUSES } from './errors';

/**
 * Mission with parsed JSON fields for return to caller.
 */
export interface MissionListItem {
  /** Mission ID (e.g., "s12-m05") */
  id: string;

  /** Sprint ID (e.g., "sprint-12") */
  sprintId: string | null;

  /** Mission name/title */
  name: string;

  /** Current status */
  status: MissionStatus;

  /** Completion timestamp */
  completedAt: string | null;

  /** Notes about the mission */
  notes: string | null;

  /** Mission objective */
  objective: string | null;

  /** Success criteria (parsed from JSON) */
  successCriteria: string[] | null;

  /** Deliverables (parsed from JSON) */
  deliverables: string[] | null;
}

/**
 * Result type for cmos_mission_list.
 */
export interface CmosMissionListResult {
  /** List of missions matching the filters */
  missions: MissionListItem[];

  /** Total count matching filters (before limit applied) */
  totalCount: number;

  /** Filters applied to the query */
  filters: {
    status: MissionStatus | null;
    sprintId: string | null;
    limit: number;
  };
}

/**
 * Input parameters schema for cmos_mission_list tool.
 */
export const cmosMissionListSchema = z.object({
  /** Filter by mission status */
  status: z
    .enum(['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'])
    .optional()
    .describe('Filter by mission status'),

  /** Filter by sprint ID */
  sprintId: z.string().optional().describe('Filter by sprint ID (e.g., "sprint-12")'),

  /** Maximum number of missions to return */
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Maximum missions to return (1-100, default: 20)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionListParams = z.infer<typeof cmosMissionListSchema>;

/**
 * MCP Tool Definition for cmos_mission_list.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionListToolDefinition = {
  name: 'cmos_mission_list',
  description:
    'List missions from the CMOS database with optional filtering. ' +
    'Supports filtering by status (Queued, Current, In Progress, Completed, Blocked, Dropped, Deferred), ' +
    'sprint ID, and pagination. Returns structured mission objects including ID, name, ' +
    'status, objective, success criteria, and deliverables.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'],
        description: 'Filter by mission status',
      },
      sprintId: {
        type: 'string',
        description: 'Filter by sprint ID (e.g., "sprint-12")',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Maximum missions to return (1-100, default: 20)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_list tool.
 *
 * Retrieves missions from the CMOS database with optional filtering
 * by status and sprint ID. Returns structured mission objects with
 * parsed JSON fields.
 *
 * @param params - Tool parameters (status, sprintId, limit, projectRoot)
 * @returns CmosToolResult with mission list or actionable error
 */
export async function cmosMissionList(
  params: CmosMissionListParams = {}
): Promise<CmosToolResult<CmosMissionListResult>> {
  // Validate status if provided
  if (params.status && !VALID_MISSION_STATUSES.includes(params.status)) {
    return createError(
      CmosErrors.invalidParameter('status', params.status, VALID_MISSION_STATUSES as string[])
    );
  }

  const limit = params.limit ?? 20;

  return withClient(
    (client) => {
      // Build query dynamically based on filters
      const { sql, countSql, queryParams } = buildQuery(params.status, params.sprintId, limit);

      // Get total count first
      const countResult = client.getOne<{ count: number }>(countSql, queryParams.slice(0, -1));
      if (!countResult.success || !countResult.data) {
        return createError<CmosMissionListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get mission count' }
        );
      }
      const totalCount = countResult.data.count;

      // Get filtered missions
      const missionsResult = client.getMany<Mission>(sql, queryParams);
      if (!missionsResult.success || !missionsResult.data) {
        return createError<CmosMissionListResult>(
          missionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get missions' }
        );
      }

      // Parse and transform missions
      const missions = missionsResult.data.map(parseMission);

      return createSuccess({
        missions,
        totalCount,
        filters: {
          status: params.status ?? null,
          sprintId: params.sprintId ?? null,
          limit,
        },
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Build SQL query based on filters.
 */
function buildQuery(
  status: MissionStatus | undefined,
  sprintId: string | undefined,
  limit: number
): { sql: string; countSql: string; queryParams: unknown[] } {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (status) {
    conditions.push('status = ?');
    queryParams.push(status);
  }

  if (sprintId) {
    conditions.push('sprint_id = ?');
    queryParams.push(sprintId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count query (without limit)
  const countSql = `SELECT COUNT(*) as count FROM missions ${whereClause}`;

  // Main query with ordering and limit
  // Order by sprint (nulls last), then by id for consistent ordering
  const sql = `
    SELECT
      id, sprint_id, name, status, completed_at, notes,
      objective, context, success_criteria, deliverables,
      reference_docs, domain_fields, metadata
    FROM missions
    ${whereClause}
    ORDER BY
      CASE WHEN sprint_id IS NULL THEN 1 ELSE 0 END,
      sprint_id DESC,
      id ASC
    LIMIT ?
  `;

  queryParams.push(limit);

  return { sql, countSql, queryParams };
}

/**
 * Parse a mission record into a MissionListItem.
 * Handles JSON field parsing with graceful fallbacks.
 */
function parseMission(mission: Mission): MissionListItem {
  return {
    id: mission.id,
    sprintId: mission.sprint_id,
    name: mission.name,
    status: mission.status,
    completedAt: mission.completed_at,
    notes: mission.notes,
    objective: mission.objective,
    successCriteria: parseJsonArray(mission.success_criteria),
    deliverables: parseJsonArray(mission.deliverables),
  };
}

/**
 * Safely parse a JSON array string.
 */
function parseJsonArray(jsonString: string | null): string[] | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format mission list result for LLM readability.
 *
 * @param result - Mission list result
 * @returns Human-readable summary
 */
export function formatMissionListForLLM(result: CmosToolResult<CmosMissionListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list missions', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    if (error?.validValues) {
      lines.push('');
      lines.push(`Valid values: ${error.validValues.join(', ')}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header with filter info
  const filterParts: string[] = [];
  if (data.filters.status) filterParts.push(`status=${data.filters.status}`);
  if (data.filters.sprintId) filterParts.push(`sprint=${data.filters.sprintId}`);

  const filterStr = filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';
  lines.push(`**Missions${filterStr}**: ${data.missions.length} of ${data.totalCount}`);
  lines.push('');

  if (data.missions.length === 0) {
    lines.push('No missions found matching the filters.');
    return lines.join('\n');
  }

  // Group by sprint for readability
  const bySprintMap = new Map<string, MissionListItem[]>();
  for (const mission of data.missions) {
    const sprintKey = mission.sprintId ?? '(no sprint)';
    if (!bySprintMap.has(sprintKey)) {
      bySprintMap.set(sprintKey, []);
    }
    bySprintMap.get(sprintKey)!.push(mission);
  }

  for (const [sprintKey, missions] of bySprintMap) {
    lines.push(`**${sprintKey}**`);
    for (const m of missions) {
      const statusIcon = getStatusIcon(m.status);
      lines.push(`  ${statusIcon} ${m.id}: ${m.name} [${m.status}]`);
      if (m.objective) {
        lines.push(`     └─ ${truncate(m.objective, 60)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Get a status icon for display.
 */
function getStatusIcon(status: MissionStatus): string {
  switch (status) {
    case 'Queued':
      return '○';
    case 'Current':
      return '◉';
    case 'In Progress':
      return '◐';
    case 'Completed':
      return '✓';
    case 'Blocked':
      return '⊘';
    default:
      return '?';
  }
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
