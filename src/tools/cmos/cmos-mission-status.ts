/**
 * cmos_mission_status Tool
 *
 * MCP tool for showing the active work queue from the CMOS database.
 * Provides a quick view of current/queued/in-progress missions to understand
 * what to work on next.
 *
 * Priority order:
 * 1. In Progress missions (actively being worked on)
 * 2. Current missions (selected but not started)
 * 3. Queued missions (limited, upcoming work)
 *
 * Optionally shows blocked missions separately for visibility.
 *
 * @module tools/cmos/cmos-mission-status
 */

import { z } from 'zod';
import { withClient, type CmosDatabaseClient } from './client';
import type { CmosToolResult, Mission, MissionStatus, Sprint } from './types';
import { createError, createSuccess } from './errors';
import { resolveCurrentSprintId } from './current-sprint';

/**
 * Mission item with sprint context for the status view.
 */
export interface StatusMissionItem {
  /** Mission ID (e.g., "s12-m07") */
  id: string;

  /** Mission name/title */
  name: string;

  /** Current status */
  status: MissionStatus;

  /** Mission objective */
  objective: string | null;

  /** Success criteria (parsed from JSON) */
  successCriteria: string[] | null;

  /** Deliverables (parsed from JSON) */
  deliverables: string[] | null;

  /** Notes about the mission */
  notes: string | null;

  /** Sprint context */
  sprint: SprintContext | null;
}

/**
 * Sprint context for a mission.
 */
export interface SprintContext {
  /** Sprint ID */
  id: string;

  /** Sprint title */
  title: string;

  /** Sprint focus area */
  focus: string | null;

  /** Sprint status */
  status: string | null;

  /** Total missions in sprint */
  totalMissions: number | null;

  /** Completed missions in sprint */
  completedMissions: number | null;
}

/**
 * Result type for cmos_mission_status.
 */
export interface CmosMissionStatusResult {
  /** Active sprint (the sprint currently being worked on) */
  activeSprint: SprintContext | null;

  /** Missions currently in progress (highest priority) */
  inProgress: StatusMissionItem[];

  /** Missions marked as current (selected, not started) */
  current: StatusMissionItem[];

  /** Queued missions (upcoming work, limited) */
  queued: StatusMissionItem[];

  /** Blocked missions (if includeBlocked was true) */
  blocked: StatusMissionItem[] | null;

  /** Summary of work queue state */
  summary: {
    /** Total active items (in_progress + current) */
    activeCount: number;

    /** Number of queued items */
    queuedCount: number;

    /** Number of blocked items (if included) */
    blockedCount: number | null;

    /** Recommendation for what to do next */
    nextAction: string;
  };
}

/**
 * Input parameters schema for cmos_mission_status tool.
 */
export const cmosMissionStatusSchema = z.object({
  /** Whether to include blocked missions separately */
  includeBlocked: z
    .boolean()
    .optional()
    .describe('Include blocked missions in a separate section (default: false)'),

  /** Maximum number of queued missions to return */
  queuedLimit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Maximum queued missions to show (1-50, default: 5)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionStatusParams = z.infer<typeof cmosMissionStatusSchema>;

/**
 * MCP Tool Definition for cmos_mission_status.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionStatusToolDefinition = {
  name: 'cmos_mission_status',
  description:
    'Show the active work queue from the CMOS database. ' +
    'Returns missions in priority order: In Progress first, then Current, then Queued. ' +
    'Each mission includes its sprint context. ' +
    'Optionally includes blocked missions in a separate section. ' +
    'Use this to quickly understand what to work on next.',
  inputSchema: {
    type: 'object',
    properties: {
      includeBlocked: {
        type: 'boolean',
        default: false,
        description: 'Include blocked missions in a separate section (default: false)',
      },
      queuedLimit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 5,
        description: 'Maximum queued missions to show (1-50, default: 5)',
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
 * Execute the cmos_mission_status tool.
 *
 * Retrieves the active work queue from the CMOS database, organized
 * by priority (in_progress > current > queued). Includes sprint context
 * for each mission to help agents understand the work context.
 *
 * @param params - Tool parameters (includeBlocked, queuedLimit, projectRoot)
 * @returns CmosToolResult with status view or actionable error
 */
export async function cmosMissionStatus(
  params: CmosMissionStatusParams = {}
): Promise<CmosToolResult<CmosMissionStatusResult>> {
  const includeBlocked = params.includeBlocked ?? false;
  const queuedLimit = params.queuedLimit ?? 5;

  return withClient(
    (client) => {
      // Fetch sprints for context lookup
      const sprintsResult = client.getMany<Sprint>('SELECT * FROM sprints');
      if (!sprintsResult.success) {
        return createError<CmosMissionStatusResult>(
          sprintsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to fetch sprints' }
        );
      }
      const sprintsMap = new Map((sprintsResult.data ?? []).map((s) => [s.id, s]));

      // Identify the active sprint for queue scoping
      const activeSprintInfo = findActiveSprint(client, sprintsMap);
      const activeSprint = activeSprintInfo ? sprintToContext(activeSprintInfo.sprint) : null;

      // Fetch In Progress missions (no limit - show all active work)
      const inProgressResult = client.getMany<Mission>(
        `SELECT * FROM missions WHERE status = 'In Progress' ORDER BY sprint_id DESC, id ASC`
      );
      if (!inProgressResult.success) {
        return createError<CmosMissionStatusResult>(
          inProgressResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to fetch in-progress missions',
          }
        );
      }

      // Fetch Current missions (selected but not started)
      const currentResult = client.getMany<Mission>(
        `SELECT * FROM missions WHERE status = 'Current' ORDER BY sprint_id DESC, id ASC`
      );
      if (!currentResult.success) {
        return createError<CmosMissionStatusResult>(
          currentResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to fetch current missions',
          }
        );
      }

      // Fetch Queued missions - scoped to active sprint when identified
      let queuedMissions: Mission[] = [];
      if (activeSprintInfo && activeSprintInfo.isComplete) {
        // Sprint is complete - no queued missions to show
        queuedMissions = [];
      } else if (activeSprintInfo) {
        // Scope queued to active sprint only
        const queuedResult = client.getMany<Mission>(
          `SELECT * FROM missions WHERE status = 'Queued' AND sprint_id = ? ORDER BY id ASC LIMIT ?`,
          [activeSprintInfo.sprint.id, queuedLimit]
        );
        if (!queuedResult.success) {
          return createError<CmosMissionStatusResult>(
            queuedResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to fetch queued missions',
            }
          );
        }
        queuedMissions = queuedResult.data ?? [];
      } else {
        // No active sprint - show all queued as fallback
        const queuedResult = client.getMany<Mission>(
          `SELECT * FROM missions WHERE status = 'Queued' ORDER BY sprint_id DESC, id ASC LIMIT ?`,
          [queuedLimit]
        );
        if (!queuedResult.success) {
          return createError<CmosMissionStatusResult>(
            queuedResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to fetch queued missions',
            }
          );
        }
        queuedMissions = queuedResult.data ?? [];
      }

      // Fetch Blocked missions if requested
      let blockedMissions: StatusMissionItem[] | null = null;
      if (includeBlocked) {
        const blockedResult = client.getMany<Mission>(
          `SELECT * FROM missions WHERE status = 'Blocked' ORDER BY sprint_id DESC, id ASC`
        );
        if (!blockedResult.success) {
          return createError<CmosMissionStatusResult>(
            blockedResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to fetch blocked missions',
            }
          );
        }
        blockedMissions = (blockedResult.data ?? []).map((m) =>
          parseMissionWithContext(m, sprintsMap)
        );
      }

      // Parse missions with context
      const inProgress = (inProgressResult.data ?? []).map((m) =>
        parseMissionWithContext(m, sprintsMap)
      );
      const current = (currentResult.data ?? []).map((m) => parseMissionWithContext(m, sprintsMap));
      const queued = queuedMissions.map((m) => parseMissionWithContext(m, sprintsMap));

      // Calculate summary
      const activeCount = inProgress.length + current.length;
      const queuedCount = queued.length;
      const blockedCount = blockedMissions?.length ?? null;

      // Determine next action recommendation
      const nextAction = determineNextAction(
        inProgress,
        current,
        queued,
        blockedMissions,
        activeSprintInfo
      );

      return createSuccess({
        activeSprint,
        inProgress,
        current,
        queued,
        blocked: blockedMissions,
        summary: {
          activeCount,
          queuedCount,
          blockedCount,
          nextAction,
        },
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Parse a mission record with sprint context.
 */
function parseMissionWithContext(
  mission: Mission,
  sprintsMap: Map<string, Sprint>
): StatusMissionItem {
  const sprint = mission.sprint_id ? sprintsMap.get(mission.sprint_id) : null;

  return {
    id: mission.id,
    name: mission.name,
    status: mission.status,
    objective: mission.objective,
    successCriteria: parseJsonArray(mission.success_criteria),
    deliverables: parseJsonArray(mission.deliverables),
    notes: mission.notes,
    sprint: sprint
      ? {
          id: sprint.id,
          title: sprint.title,
          focus: sprint.focus,
          status: sprint.status,
          totalMissions: sprint.total_missions,
          completedMissions: sprint.completed_missions,
        }
      : null,
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
 * Convert a Sprint record to SprintContext format.
 */
function sprintToContext(sprint: Sprint): SprintContext {
  return {
    id: sprint.id,
    title: sprint.title,
    focus: sprint.focus,
    status: sprint.status,
    totalMissions: sprint.total_missions,
    completedMissions: sprint.completed_missions,
  };
}

/**
 * Active sprint detection result.
 */
interface ActiveSprintInfo {
  /** The sprint record */
  sprint: Sprint;
  /** Whether the sprint has no remaining work (all completed/blocked) */
  isComplete: boolean;
}

/**
 * Find the active sprint by examining mission states.
 *
 * s77-m02: identity is delegated to the canonical resolveCurrentSprintId so this
 * surface names the SAME current sprint as onboard / review / session-start (was
 * a divergent 3-step picker whose `start_date ASC` Step 2 disagreed with onboard's
 * `DESC` — the #853 split). `isComplete` stays a LOCAL computation: the resolved
 * sprint has missions and none of them are still open.
 */
function findActiveSprint(
  client: CmosDatabaseClient,
  sprintsMap: Map<string, Sprint>
): ActiveSprintInfo | null {
  const sprintId = resolveCurrentSprintId(client);
  if (!sprintId) {
    return null;
  }
  const sprint = sprintsMap.get(sprintId);
  if (!sprint) {
    return null;
  }
  return { sprint, isComplete: isSprintComplete(client, sprintId) };
}

/**
 * A sprint is "complete" for queue-scoping when it has at least one mission and
 * none are still open (In Progress / Current / Queued / Blocked). A sprint with no
 * missions yet is not complete (there is nothing done).
 */
function isSprintComplete(client: CmosDatabaseClient, sprintId: string): boolean {
  const hasMissions = client.getOne<{ one: number }>(
    `SELECT 1 AS one FROM missions WHERE sprint_id = ? LIMIT 1`,
    [sprintId]
  );
  if (!hasMissions.success || !hasMissions.data) {
    return false;
  }
  const openMission = client.getOne<{ one: number }>(
    `SELECT 1 AS one FROM missions
      WHERE sprint_id = ?
        AND status IN ('In Progress', 'Current', 'Queued', 'Blocked')
      LIMIT 1`,
    [sprintId]
  );
  return !(openMission.success && openMission.data);
}

/**
 * Determine the recommended next action based on queue state.
 */
function determineNextAction(
  inProgress: StatusMissionItem[],
  current: StatusMissionItem[],
  queued: StatusMissionItem[],
  blocked: StatusMissionItem[] | null,
  activeSprintInfo: ActiveSprintInfo | null
): string {
  // If there's work in progress, continue it
  if (inProgress.length > 0) {
    if (inProgress.length === 1) {
      return `Continue working on ${inProgress[0].id}: ${inProgress[0].name}`;
    }
    return `${inProgress.length} missions in progress. Continue with ${inProgress[0].id} or review parallelism.`;
  }

  // If there's a current mission, start it
  if (current.length > 0) {
    return `Start the current mission: ${current[0].id}: ${current[0].name}`;
  }

  // If there are queued missions, promote the first one
  if (queued.length > 0) {
    return `No active mission. Promote and start ${queued[0].id}: ${queued[0].name}`;
  }

  // Sprint completion: active sprint has no remaining work
  if (activeSprintInfo?.isComplete) {
    return `Sprint ${activeSprintInfo.sprint.id} complete. Sprint review recommended before starting next sprint.`;
  }

  // If blocked missions exist and nothing else is available
  if (blocked && blocked.length > 0) {
    return `All missions blocked (${blocked.length}). Resolve blockers before continuing.`;
  }

  // Queue is empty
  return 'No missions in queue. Add new missions to continue work.';
}

/**
 * Format mission status result for LLM readability.
 *
 * @param result - Mission status result
 * @returns Human-readable summary
 */
export function formatMissionStatusForLLM(result: CmosToolResult<CmosMissionStatusResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      'Failed to get mission status',
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
  const lines: string[] = [];

  // Header with summary
  lines.push('**Work Queue Status**');
  lines.push('');
  if (data.activeSprint) {
    lines.push(`**Sprint**: ${data.activeSprint.id} - ${data.activeSprint.title}`);
    if (data.activeSprint.focus) {
      lines.push(`  Focus: ${data.activeSprint.focus}`);
    }
    lines.push('');
  }
  lines.push(
    `Active: ${data.summary.activeCount} | Queued: ${data.summary.queuedCount}${data.summary.blockedCount !== null ? ` | Blocked: ${data.summary.blockedCount}` : ''}`
  );
  lines.push('');

  // In Progress section
  if (data.inProgress.length > 0) {
    lines.push('**In Progress:**');
    for (const m of data.inProgress) {
      lines.push(`  ${m.id}: ${m.name}`);
      if (m.objective) {
        lines.push(`    -> ${truncate(m.objective, 70)}`);
      }
      if (m.sprint) {
        lines.push(`    [${m.sprint.id}: ${m.sprint.title}]`);
      }
    }
    lines.push('');
  }

  // Current section
  if (data.current.length > 0) {
    lines.push('**Current (Ready to Start):**');
    for (const m of data.current) {
      lines.push(`  ${m.id}: ${m.name}`);
      if (m.objective) {
        lines.push(`    -> ${truncate(m.objective, 70)}`);
      }
      if (m.sprint) {
        lines.push(`    [${m.sprint.id}: ${m.sprint.title}]`);
      }
    }
    lines.push('');
  }

  // Queued section
  if (data.queued.length > 0) {
    lines.push('**Queued (Upcoming):**');
    for (const m of data.queued) {
      lines.push(`  ${m.id}: ${m.name}`);
      if (m.sprint) {
        lines.push(`    [${m.sprint.id}]`);
      }
    }
    lines.push('');
  }

  // Blocked section (if included)
  if (data.blocked && data.blocked.length > 0) {
    lines.push('**Blocked:**');
    for (const m of data.blocked) {
      lines.push(`  ${m.id}: ${m.name}`);
      if (m.notes) {
        lines.push(`    Reason: ${truncate(m.notes, 60)}`);
      }
    }
    lines.push('');
  }

  // Next action recommendation
  lines.push('---');
  lines.push(`**Next:** ${data.summary.nextAction}`);

  return lines.join('\n');
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
