/**
 * cmos_sprint_show Tool
 *
 * MCP tool for getting detailed sprint information.
 * Returns sprint details with aggregated statistics and mission list.
 *
 * @module tools/cmos/cmos-sprint-show
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult, MissionStatus } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { getSprintDecisionCounts } from './decision-memory';
import { appendWarnings, attachWarnings } from './format-warnings';
import { ensureSprintSummaryView } from './schema-migrations';
import { parkedColumn } from './sprint-summary-read';

/**
 * Mission summary within a sprint.
 */
export interface SprintMissionSummary {
  /** Mission ID */
  id: string;

  /** Mission name */
  name: string;

  /** Mission status */
  status: MissionStatus;

  /** Mission objective */
  objective: string | null;
}

/**
 * Full sprint details result.
 */
export interface SprintShowResult {
  /** Sprint ID */
  id: string;

  /** Sprint title */
  title: string;

  /** Strategic focus */
  focus: string | null;

  /** Sprint status */
  status: string | null;

  /** Start date (ISO format) */
  startDate: string | null;

  /** End date (ISO format) */
  endDate: string | null;

  /** Total missions in sprint */
  totalMissions: number;

  /** Completed missions */
  completedMissions: number;

  /** Blocked missions */
  blockedMissions: number;

  /** Active missions (Current + In Progress) */
  activeMissions: number;

  /** s86-m08: Deferred + Dropped missions — parked work, excluded from totalMissions and
   *  reported here so it is neither counted against the sprint nor hidden from the reader. */
  parkedMissions: number;

  /** Strategic decisions count */
  decisionsCount: number;

  /** Session-derived decisions not present in strategic_decisions */
  sessionDecisionsCount: number;

  /** Total decision count combining strategic and session-derived records */
  totalDecisionsCount: number;

  /** Missions in this sprint */
  missions: SprintMissionSummary[];
}

/**
 * Raw row from sprint_summary view.
 */
interface SprintSummaryRow {
  sprint_id: string;
  title: string;
  status: string | null;
  focus: string | null;
  start_date: string | null;
  end_date: string | null;
  total_missions: number;
  completed_missions: number;
  blocked_missions: number;
  active_missions: number;
  /** s86-m08: Deferred + Dropped — the work this sprint owned and parked. Excluded from
   *  total_missions so a sprint is not punished for parking honestly, surfaced here so it
   *  is not hidden either. On a store whose view could not be upgraded the reader projects
   *  `0 AS parked_missions` (see parkedColumn) and the answer carries a warning saying so —
   *  the column is always present in the ROW, the zero is the part to distrust. */
  parked_missions: number;
  decisions_count: number;
}

/**
 * Raw mission row.
 */
interface MissionRow {
  id: string;
  name: string;
  status: MissionStatus;
  objective: string | null;
}

/**
 * Input parameters schema for cmos_sprint_show tool.
 */
export const cmosSprintShowSchema = z.object({
  /** Sprint ID to retrieve */
  sprintId: z.string().min(1).describe('The sprint ID to retrieve (e.g., "sprint-14")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSprintShowParams = z.infer<typeof cmosSprintShowSchema>;

/**
 * MCP Tool Definition for cmos_sprint_show.
 */
export const cmosSprintShowToolDefinition = {
  name: 'cmos_sprint_show',
  description:
    'Get detailed information about a specific sprint including all associated missions. ' +
    'Returns sprint metadata, mission counts, and a list of all missions in the sprint.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'The sprint ID to retrieve (e.g., "sprint-14")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_sprint_show tool.
 *
 * @param params - Tool parameters (sprintId, projectRoot)
 * @returns CmosToolResult with sprint details or actionable error
 */
export async function cmosSprintShow(
  params: CmosSprintShowParams
): Promise<CmosToolResult<SprintShowResult>> {
  const { sprintId } = params;

  if (!sprintId || sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  const warnings: string[] = [];
  const result = await withClient(
    (client) => {
      // s86-m08: upgrade a pre-migration store's view before reading it (zero writes once
      // current; a base table of the same name is left untouched).
      const viewMigration = ensureSprintSummaryView(client);
      warnings.push(...(viewMigration.warnings ?? []));

      // Get sprint from sprint_summary view
      const sprintResult = client.getOne<SprintSummaryRow>(
        `SELECT
          sprint_id, title, status, focus, start_date, end_date,
          total_missions, completed_missions, blocked_missions,
          active_missions, ${parkedColumn(viewMigration.parkedAvailable)}, decisions_count
        FROM sprint_summary
        WHERE sprint_id = ?`,
        [sprintId]
      );

      if (!sprintResult.success) {
        return createError<SprintShowResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query sprint' }
        );
      }

      if (!sprintResult.data) {
        return createError<SprintShowResult>(CmosErrors.sprintNotFound(sprintId));
      }

      const sprint = sprintResult.data;
      const decisionCounts = getSprintDecisionCounts(client, sprintId);

      // Get missions for this sprint
      const missionsResult = client.getMany<MissionRow>(
        `SELECT id, name, status, objective
        FROM missions
        WHERE sprint_id = ?
        ORDER BY
          CASE status
            WHEN 'In Progress' THEN 1
            WHEN 'Current' THEN 2
            WHEN 'Blocked' THEN 3
            WHEN 'Queued' THEN 4
            WHEN 'Completed' THEN 5
            ELSE 6
          END,
          id ASC`,
        [sprintId]
      );

      if (!missionsResult.success || !missionsResult.data) {
        return createError<SprintShowResult>(
          missionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query missions' }
        );
      }

      // Build result
      const result: SprintShowResult = {
        id: sprint.sprint_id,
        title: sprint.title,
        focus: sprint.focus,
        status: sprint.status,
        startDate: sprint.start_date,
        endDate: sprint.end_date,
        totalMissions: sprint.total_missions ?? 0,
        completedMissions: sprint.completed_missions ?? 0,
        blockedMissions: sprint.blocked_missions ?? 0,
        activeMissions: sprint.active_missions ?? 0,
        parkedMissions: sprint.parked_missions ?? 0,
        decisionsCount: decisionCounts.strategicDecisionsCount,
        sessionDecisionsCount: decisionCounts.sessionDecisionsCount,
        totalDecisionsCount: decisionCounts.totalDecisionsCount,
        missions: missionsResult.data.map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status,
          objective: m.objective,
        })),
      };

      return createSuccess(result, viewMigration.warnings);
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Format sprint show result for LLM readability.
 *
 * @param result - Sprint show result
 * @returns Human-readable summary
 */
export function formatSprintShowForLLM(result: CmosToolResult<SprintShowResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to get sprint details',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const s = result.data;
  const lines: string[] = [];

  // Header
  const statusIcon = getStatusIcon(s.status);
  lines.push(`${statusIcon} **Sprint: ${s.id}**`);
  lines.push(`   Title: ${s.title}`);

  if (s.focus) {
    lines.push(`   Focus: ${s.focus}`);
  }

  if (s.status) {
    lines.push(`   Status: ${s.status}`);
  }

  // Dates
  if (s.startDate || s.endDate) {
    const dateRange = s.endDate ? `${s.startDate} → ${s.endDate}` : `Started: ${s.startDate}`;
    lines.push(`   Dates: ${dateRange}`);
  }

  lines.push('');

  // Statistics
  lines.push('**Progress**');
  lines.push(`   Completed: ${s.completedMissions}/${s.totalMissions} missions`);

  if (s.parkedMissions > 0) {
    // s86-m08: parked work is stated in its own line — it is outside the denominator above,
    // and saying so is the difference between an honest number and a flattering one.
    lines.push(`   Parked (Deferred/Dropped): ${s.parkedMissions}`);
  }

  if (s.activeMissions > 0) {
    lines.push(`   Active: ${s.activeMissions}`);
  }

  if (s.blockedMissions > 0) {
    lines.push(`   Blocked: ${s.blockedMissions}`);
  }

  if (s.totalDecisionsCount > 0) {
    if (s.sessionDecisionsCount > 0) {
      lines.push(
        `   Decisions: ${s.decisionsCount} strategic, ${s.sessionDecisionsCount} session-derived (${s.totalDecisionsCount} total)`
      );
    } else {
      lines.push(`   Decisions: ${s.decisionsCount}`);
    }
  }

  lines.push('');

  // Missions
  if (s.missions.length > 0) {
    lines.push('**Missions**');
    for (const m of s.missions) {
      const missionIcon = getMissionStatusIcon(m.status);
      lines.push(`   ${missionIcon} ${m.id}: ${m.name} [${m.status}]`);
      if (m.objective) {
        lines.push(`      └─ ${truncate(m.objective, 55)}`);
      }
    }
  } else {
    lines.push('**Missions**: None');
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * Get a status icon for sprint display.
 */
function getStatusIcon(status: string | null): string {
  switch (status?.toLowerCase()) {
    case 'active':
    case 'current':
      return '◉';
    case 'completed':
      return '✓';
    case 'planned':
    case 'queued':
      return '○';
    default:
      return '•';
  }
}

/**
 * Get a status icon for mission display.
 */
function getMissionStatusIcon(status: MissionStatus): string {
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
