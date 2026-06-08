/**
 * cmos_mission_show Tool
 *
 * MCP tool for retrieving full mission details by ID from the CMOS database.
 * Returns complete mission specification including objective, context,
 * success criteria, deliverables, and reference docs.
 *
 * @module tools/cmos/cmos-mission-show
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult, Mission, MissionStatus, Sprint } from './types';
import { createError, createSuccess, CmosErrors } from './errors';

/**
 * Full mission details with parsed JSON fields.
 */
export interface MissionShowResult {
  /** Mission ID (e.g., "s12-m06") */
  id: string;

  /** Mission name/title */
  name: string;

  /** Current status */
  status: MissionStatus;

  /** Mission objective - what this mission aims to achieve */
  objective: string | null;

  /** Context explaining why this mission matters */
  context: string | null;

  /** Success criteria (parsed from JSON) */
  successCriteria: string[] | null;

  /** Deliverables (parsed from JSON) */
  deliverables: string[] | null;

  /** Reference docs (parsed from JSON) */
  referenceDocs: string[] | null;

  /** Domain-specific fields (parsed from JSON) */
  domainFields: Record<string, unknown> | null;

  /** Notes about the mission */
  notes: string | null;

  /** Completion timestamp */
  completedAt: string | null;

  /** When mission was created */
  createdAt: string | null;

  /** When mission first moved to In Progress */
  startedAt: string | null;

  /** Last state change timestamp */
  updatedAt: string | null;

  /** Additional metadata (parsed from JSON) */
  metadata: Record<string, unknown> | null;

  /** Sprint information (if mission belongs to a sprint) */
  sprint: SprintInfo | null;
}

/**
 * Minimal sprint info for context.
 */
export interface SprintInfo {
  id: string;
  title: string;
  focus: string | null;
  status: string | null;
}

/**
 * Input parameters schema for cmos_mission_show tool.
 */
export const cmosMissionShowSchema = z.object({
  /** The mission ID to retrieve */
  missionId: z.string().min(1).describe('The mission ID to retrieve (e.g., "s12-m06")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionShowParams = z.infer<typeof cmosMissionShowSchema>;

/**
 * MCP Tool Definition for cmos_mission_show.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionShowToolDefinition = {
  name: 'cmos_mission_show',
  description:
    'Get full details of a specific mission by ID. ' +
    'Returns complete mission specification including objective, context, ' +
    'success criteria, deliverables, reference docs, and sprint information. ' +
    'Use this when you need the complete mission spec to execute work.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to retrieve (e.g., "s12-m06")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_show tool.
 *
 * Retrieves full mission details from the CMOS database by mission ID.
 * Includes sprint context if the mission belongs to a sprint.
 *
 * @param params - Tool parameters (missionId, projectRoot)
 * @returns CmosToolResult with full mission details or actionable error
 */
export async function cmosMissionShow(
  params: CmosMissionShowParams
): Promise<CmosToolResult<MissionShowResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();

  return withClient(
    (client) => {
      // Query mission by ID (with soft column detection for timestamps)
      const missionColumns = getMissionColumns(client);
      const createdAtExpr = missionColumns.has('created_at') ? 'created_at' : 'NULL AS created_at';
      const startedAtExpr = missionColumns.has('started_at') ? 'started_at' : 'NULL AS started_at';
      const updatedAtExpr = missionColumns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at';

      const missionResult = client.getOne<Mission>(
        `
        SELECT
          id, sprint_id, name, status, completed_at, notes,
          objective, context, success_criteria, deliverables,
          reference_docs, domain_fields, metadata,
          ${createdAtExpr}, ${startedAtExpr}, ${updatedAtExpr}
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionShowResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionShowResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;

      // Get sprint info if mission has a sprint_id
      let sprintInfo: SprintInfo | null = null;
      if (mission.sprint_id) {
        const sprintResult = client.getOne<Sprint>(
          `
          SELECT id, title, focus, status
          FROM sprints
          WHERE id = ?
        `,
          [mission.sprint_id]
        );

        if (sprintResult.success && sprintResult.data) {
          sprintInfo = {
            id: sprintResult.data.id,
            title: sprintResult.data.title,
            focus: sprintResult.data.focus,
            status: sprintResult.data.status,
          };
        }
      }

      // Parse and transform mission
      const result: MissionShowResult = {
        id: mission.id,
        name: mission.name,
        status: mission.status,
        objective: mission.objective,
        context: mission.context,
        successCriteria: parseJsonArray(mission.success_criteria),
        deliverables: parseJsonArray(mission.deliverables),
        referenceDocs: parseJsonArray(mission.reference_docs),
        domainFields: parseJsonObject(mission.domain_fields),
        notes: mission.notes,
        completedAt: mission.completed_at,
        createdAt: (mission as unknown as Record<string, string | null>).created_at ?? null,
        startedAt: (mission as unknown as Record<string, string | null>).started_at ?? null,
        updatedAt: (mission as unknown as Record<string, string | null>).updated_at ?? null,
        metadata: parseJsonObject(mission.metadata),
        sprint: sprintInfo,
      };

      return createSuccess(result);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Get the set of column names for the missions table.
 */
function getMissionColumns(client: Parameters<Parameters<typeof withClient>[0]>[0]): Set<string> {
  const result = client.getMany<{ name: string }>("PRAGMA table_info('missions')", []);
  if (!result.success || !result.data) {
    return new Set();
  }
  return new Set(result.data.map((row) => row.name));
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
 * Safely parse a JSON object string.
 */
function parseJsonObject(jsonString: string | null): Record<string, unknown> | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format mission show result for LLM readability.
 *
 * @param result - Mission show result
 * @returns Human-readable formatted mission details
 */
export function formatMissionShowForLLM(result: CmosToolResult<MissionShowResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to retrieve mission',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const m = result.data;
  const lines: string[] = [];

  // Header with ID and status
  const statusIcon = getStatusIcon(m.status);
  lines.push(`# ${m.id}: ${m.name}`);
  lines.push(`**Status**: ${statusIcon} ${m.status}`);

  // Sprint context
  if (m.sprint) {
    lines.push(`**Sprint**: ${m.sprint.id} - ${m.sprint.title}`);
    if (m.sprint.focus) {
      lines.push(`**Focus**: ${m.sprint.focus}`);
    }
  }

  lines.push('');

  // Objective
  if (m.objective) {
    lines.push('## Objective');
    lines.push(m.objective);
    lines.push('');
  }

  // Context
  if (m.context) {
    lines.push('## Context');
    lines.push(m.context);
    lines.push('');
  }

  // Success Criteria
  if (m.successCriteria && m.successCriteria.length > 0) {
    lines.push('## Success Criteria');
    for (const criterion of m.successCriteria) {
      lines.push(`- [ ] ${criterion}`);
    }
    lines.push('');
  }

  // Deliverables
  if (m.deliverables && m.deliverables.length > 0) {
    lines.push('## Deliverables');
    for (const deliverable of m.deliverables) {
      lines.push(`- ${deliverable}`);
    }
    lines.push('');
  }

  // Reference Docs
  if (m.referenceDocs && m.referenceDocs.length > 0) {
    lines.push('## Reference Docs');
    for (const doc of m.referenceDocs) {
      lines.push(`- ${doc}`);
    }
    lines.push('');
  }

  // Notes
  if (m.notes) {
    lines.push('## Notes');
    lines.push(m.notes);
    lines.push('');
  }

  // Completion info
  if (m.completedAt) {
    lines.push(`**Completed**: ${m.completedAt}`);
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
