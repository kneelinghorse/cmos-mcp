/**
 * cmos_backlog_export Tool
 *
 * MCP tool for exporting missions to YAML or JSON format.
 * Enables CLI consolidation by providing full mission spec exports
 * that can be used for backups, migrations, or external tooling.
 *
 * @module tools/cmos/cmos-backlog-export
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess } from './errors';

/**
 * Export format options.
 */
export type ExportFormat = 'yaml' | 'json';

/**
 * Valid export formats.
 */
export const VALID_EXPORT_FORMATS: ExportFormat[] = ['yaml', 'json'];

/**
 * Exported mission with full spec.
 */
export interface ExportedMission {
  /** Mission ID */
  id: string;

  /** Mission name */
  name: string;

  /** Current status */
  status: string;

  /** Mission objective */
  objective: string | null;

  /** Context explaining why this mission matters */
  context: string | null;

  /** Success criteria (array of strings) */
  successCriteria: string[];

  /** Expected deliverables (array of strings) */
  deliverables: string[];

  /** Reference documentation (array of strings) */
  referenceDocs: string[];

  /** Domain-specific fields */
  domainFields: Record<string, unknown> | null;

  /** Completion timestamp */
  completedAt: string | null;

  /** Notes about the mission */
  notes: string | null;
}

/**
 * Exported sprint with missions.
 */
export interface ExportedSprint {
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

  /** Missions in this sprint */
  missions: ExportedMission[];
}

/**
 * Result type for cmos_backlog_export.
 */
export interface CmosBacklogExportResult {
  /** Export format used */
  format: ExportFormat;

  /** Formatted output content (YAML or JSON string) */
  content: string;

  /** Number of sprints included */
  sprintCount: number;

  /** Number of missions included */
  missionCount: number;

  /** Filter applied (null if no filter) */
  sprintFilter: string | null;
}

/**
 * Raw mission row from database.
 */
interface MissionRow {
  id: string;
  sprint_id: string | null;
  name: string;
  status: string;
  objective: string | null;
  context: string | null;
  success_criteria: string | null;
  deliverables: string | null;
  reference_docs: string | null;
  domain_fields: string | null;
  completed_at: string | null;
  notes: string | null;
}

/**
 * Raw sprint row from database.
 */
interface SprintRow {
  id: string;
  title: string;
  focus: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
}

/**
 * Input parameters schema for cmos_backlog_export tool.
 */
export const cmosBacklogExportSchema = z.object({
  /** Filter by sprint ID (exports all sprints if not specified) */
  sprintId: z.string().optional().describe('Filter to export only missions from this sprint ID'),

  /** Export format: yaml or json (default: yaml) */
  format: z.enum(['yaml', 'json']).optional().describe("Output format: 'yaml' (default) or 'json'"),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosBacklogExportParams = z.infer<typeof cmosBacklogExportSchema>;

/**
 * MCP Tool Definition for cmos_backlog_export.
 */
export const cmosBacklogExportToolDefinition = {
  name: 'cmos_backlog_export',
  description:
    'Export missions from the CMOS database to YAML or JSON format. ' +
    'Exports full mission specifications including objective, context, success criteria, ' +
    'deliverables, and reference docs. Can export all sprints or filter by sprint ID. ' +
    'YAML format includes human-readable comments for readability.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'Filter to export only missions from this sprint ID (e.g., "sprint-14")',
      },
      format: {
        type: 'string',
        enum: ['yaml', 'json'],
        default: 'yaml',
        description: "Output format: 'yaml' (default, human-readable) or 'json' (machine-readable)",
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
 * Execute the cmos_backlog_export tool.
 *
 * @param params - Tool parameters (sprintId, format, projectRoot)
 * @returns CmosToolResult with export content or actionable error
 */
export async function cmosBacklogExport(
  params: CmosBacklogExportParams = {}
): Promise<CmosToolResult<CmosBacklogExportResult>> {
  const format: ExportFormat = params.format ?? 'yaml';

  return withClient(
    (client) => {
      // Get sprints
      const sprintsResult = params.sprintId
        ? client.getMany<SprintRow>(
            'SELECT id, title, focus, status, start_date, end_date FROM sprints WHERE id = ?',
            [params.sprintId]
          )
        : client.getMany<SprintRow>(
            `SELECT id, title, focus, status, start_date, end_date FROM sprints
             ORDER BY CASE WHEN start_date IS NULL THEN 1 ELSE 0 END, start_date DESC, id DESC`
          );

      if (!sprintsResult.success || !sprintsResult.data) {
        return createError<CmosBacklogExportResult>(
          sprintsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get sprints' }
        );
      }

      // Check if sprint filter found anything
      if (params.sprintId && sprintsResult.data.length === 0) {
        return createError<CmosBacklogExportResult>({
          code: 'SPRINT_NOT_FOUND',
          message: `Sprint '${params.sprintId}' not found`,
          suggestion: 'Use cmos_sprint with action="list" to see available sprints',
        });
      }

      // Get missions
      const missionsResult = params.sprintId
        ? client.getMany<MissionRow>(
            `SELECT id, sprint_id, name, status, objective, context,
                    success_criteria, deliverables, reference_docs, domain_fields,
                    completed_at, notes
             FROM missions WHERE sprint_id = ?
             ORDER BY id`,
            [params.sprintId]
          )
        : client.getMany<MissionRow>(
            `SELECT id, sprint_id, name, status, objective, context,
                    success_criteria, deliverables, reference_docs, domain_fields,
                    completed_at, notes
             FROM missions
             ORDER BY sprint_id, id`
          );

      if (!missionsResult.success || !missionsResult.data) {
        return createError<CmosBacklogExportResult>(
          missionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get missions' }
        );
      }

      // Group missions by sprint
      const missionsBySprintId = new Map<string, MissionRow[]>();
      for (const mission of missionsResult.data) {
        const sprintId = mission.sprint_id ?? '__no_sprint__';
        if (!missionsBySprintId.has(sprintId)) {
          missionsBySprintId.set(sprintId, []);
        }
        missionsBySprintId.get(sprintId)!.push(mission);
      }

      // Build export structure
      const exportedSprints: ExportedSprint[] = sprintsResult.data.map((sprint) => ({
        id: sprint.id,
        title: sprint.title,
        focus: sprint.focus,
        status: sprint.status,
        startDate: sprint.start_date,
        endDate: sprint.end_date,
        missions: (missionsBySprintId.get(sprint.id) ?? []).map(parseMissionRow),
      }));

      // Handle orphan missions (no sprint)
      const orphanMissions = missionsBySprintId.get('__no_sprint__') ?? [];
      if (orphanMissions.length > 0 && !params.sprintId) {
        exportedSprints.push({
          id: '__unassigned__',
          title: 'Unassigned Missions',
          focus: null,
          status: null,
          startDate: null,
          endDate: null,
          missions: orphanMissions.map(parseMissionRow),
        });
      }

      // Format output
      const content =
        format === 'yaml'
          ? formatAsYaml(exportedSprints)
          : JSON.stringify({ sprints: exportedSprints }, null, 2);

      const missionCount = exportedSprints.reduce((sum, s) => sum + s.missions.length, 0);

      return createSuccess({
        format,
        content,
        sprintCount: exportedSprints.length,
        missionCount,
        sprintFilter: params.sprintId ?? null,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Parse a mission row into an ExportedMission.
 */
function parseMissionRow(row: MissionRow): ExportedMission {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    objective: row.objective,
    context: row.context,
    successCriteria: parseJsonArray(row.success_criteria),
    deliverables: parseJsonArray(row.deliverables),
    referenceDocs: parseJsonArray(row.reference_docs),
    domainFields: parseJsonObject(row.domain_fields),
    completedAt: row.completed_at,
    notes: row.notes,
  };
}

/**
 * Parse a JSON array string, returning empty array if invalid.
 */
function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse a JSON object string, returning null if invalid.
 */
function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Format export data as YAML with human-readable comments.
 */
function formatAsYaml(sprints: ExportedSprint[]): string {
  const lines: string[] = [];

  lines.push('# CMOS Backlog Export');
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('sprints:');

  for (const sprint of sprints) {
    lines.push('');
    lines.push(`  # ${sprint.title}${sprint.focus ? ` - ${sprint.focus}` : ''}`);
    lines.push(`  - id: ${yamlString(sprint.id)}`);
    lines.push(`    title: ${yamlString(sprint.title)}`);

    if (sprint.focus) {
      lines.push(`    focus: ${yamlString(sprint.focus)}`);
    }
    if (sprint.status) {
      lines.push(`    status: ${yamlString(sprint.status)}`);
    }
    if (sprint.startDate) {
      lines.push(`    startDate: ${yamlString(sprint.startDate)}`);
    }
    if (sprint.endDate) {
      lines.push(`    endDate: ${yamlString(sprint.endDate)}`);
    }

    lines.push('    missions:');

    if (sprint.missions.length === 0) {
      lines.push('      []');
    } else {
      for (const mission of sprint.missions) {
        lines.push('');
        lines.push(`      # ${mission.name} [${mission.status}]`);
        lines.push(`      - id: ${yamlString(mission.id)}`);
        lines.push(`        name: ${yamlString(mission.name)}`);
        lines.push(`        status: ${yamlString(mission.status)}`);

        if (mission.objective) {
          lines.push(`        objective: ${yamlMultilineString(mission.objective)}`);
        }

        if (mission.context) {
          lines.push(`        context: ${yamlMultilineString(mission.context)}`);
        }

        if (mission.successCriteria.length > 0) {
          lines.push('        successCriteria:');
          for (const criterion of mission.successCriteria) {
            lines.push(`          - ${yamlString(criterion)}`);
          }
        }

        if (mission.deliverables.length > 0) {
          lines.push('        deliverables:');
          for (const deliverable of mission.deliverables) {
            lines.push(`          - ${yamlString(deliverable)}`);
          }
        }

        if (mission.referenceDocs.length > 0) {
          lines.push('        referenceDocs:');
          for (const doc of mission.referenceDocs) {
            lines.push(`          - ${yamlString(doc)}`);
          }
        }

        if (mission.domainFields && Object.keys(mission.domainFields).length > 0) {
          lines.push(`        domainFields: ${JSON.stringify(mission.domainFields)}`);
        }

        if (mission.completedAt) {
          lines.push(`        completedAt: ${yamlString(mission.completedAt)}`);
        }

        if (mission.notes) {
          lines.push(`        notes: ${yamlMultilineString(mission.notes)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a string for YAML output.
 * Quotes strings that need escaping.
 */
function yamlString(value: string): string {
  // Check if string needs quoting
  if (
    value.includes(':') ||
    value.includes('#') ||
    value.includes("'") ||
    value.includes('"') ||
    value.includes('\n') ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value === '' ||
    /^[[\]{}&*!|>'"%@`]/.test(value) ||
    /^(true|false|null|yes|no|on|off)$/i.test(value)
  ) {
    // Use double quotes and escape
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return value;
}

/**
 * Format a potentially multiline string for YAML.
 * Uses literal block style for multiline, quotes for single line.
 */
function yamlMultilineString(value: string): string {
  if (value.includes('\n')) {
    // Use literal block style
    const indented = value
      .split('\n')
      .map((line) => `          ${line}`)
      .join('\n');
    return `|\n${indented}`;
  }
  return yamlString(value);
}

/**
 * Format backlog export result for LLM readability.
 *
 * @param result - Backlog export result
 * @returns Human-readable summary
 */
export function formatBacklogExportForLLM(result: CmosToolResult<CmosBacklogExportResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['Failed to export backlog', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  lines.push(`**Backlog Export** (${data.format.toUpperCase()})`);
  lines.push('');
  lines.push(`Sprints: ${data.sprintCount}`);
  lines.push(`Missions: ${data.missionCount}`);

  if (data.sprintFilter) {
    lines.push(`Filter: sprint_id = ${data.sprintFilter}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(data.content);

  return lines.join('\n');
}
