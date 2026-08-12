/**
 * cmos_project_list Tool
 *
 * MCP tool for listing registered CMOS projects.
 * Returns project summaries with status indicators.
 *
 * @module tools/cmos/cmos-project-list
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { CmosToolResult } from './types';
import { createError, createSuccess } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Project summary for list output.
 */
export interface ProjectListItem {
  /** Project path */
  projectRoot: string;

  /** Display name */
  name: string;

  /** Whether this is the default project */
  isDefault: boolean;

  /** Whether the CMOS database exists on disk */
  dbExists: boolean;

  /** Registration timestamp */
  registeredAt: string;

  /** Last access timestamp */
  lastAccessedAt: string;
}

/**
 * Summary statistics for projects.
 */
export interface ProjectListSummary {
  /** Total number of projects */
  total: number;
}

/**
 * Result type for cmos_project_list.
 */
export interface ProjectListResult {
  /** List of registered projects */
  projects: ProjectListItem[];

  /** Number of projects with missing databases */
  missingCount: number;

  /** Summary statistics */
  summary: ProjectListSummary;

  /** Path to the registry file */
  registryPath: string;
}

/**
 * Input parameters schema for cmos_project_list tool.
 */
export const cmosProjectListSchema = z.object({});

export type CmosProjectListParams = z.infer<typeof cmosProjectListSchema>;

/**
 * MCP Tool Definition for cmos_project_list.
 */
export const cmosProjectListToolDefinition = {
  name: 'cmos_project_list',
  description:
    'List all registered CMOS projects. ' +
    'Returns project paths, names, and default status. ' +
    'Use cmos_project(action="validate") to check project health.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_project_list tool.
 *
 * @param _params - Tool parameters (unused)
 * @returns CmosToolResult with project list or error
 */
export async function cmosProjectList(
  _params: CmosProjectListParams
): Promise<CmosToolResult<ProjectListResult>> {
  try {
    // s79-m03 — the project-graph registry is the sole discovery read source.
    const graph = await ProjectGraphRegistry.create();
    const rows = graph.list();
    const defaultId = graph.getDefault()?.project_id;

    const items: ProjectListItem[] = rows.map((row) => ({
      projectRoot: row.store_path,
      name: row.name ?? row.store_path,
      isDefault: row.project_id === defaultId,
      dbExists: fs.existsSync(path.join(row.store_path, 'cmos', 'db', 'cmos.sqlite')),
      registeredAt: new Date(row.registered_at).toISOString(),
      lastAccessedAt: new Date(row.last_seen_at).toISOString(),
    }));

    const missingCount = items.filter((p) => !p.dbExists).length;

    return createSuccess({
      projects: items,
      missingCount,
      summary: {
        total: items.length,
      },
      registryPath: graph.path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createError({
      code: 'DB_CONNECTION_FAILED',
      message: `Failed to list projects: ${message}`,
      suggestion: 'Check registry file permissions',
    });
  }
}

/**
 * Format project list result for LLM readability.
 *
 * @param result - Project list result
 * @returns Human-readable summary
 */
export function formatProjectListForLLM(result: CmosToolResult<ProjectListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list projects', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  if (data.projects.length === 0) {
    lines.push('📋 No projects registered');
    lines.push('');
    lines.push('Use cmos_project(action="register") to add a project.');
  } else {
    const header =
      data.missingCount > 0
        ? `📋 Registered Projects (${data.summary.total}, ${data.missingCount} missing)`
        : `📋 Registered Projects (${data.summary.total})`;
    lines.push(header);
    lines.push('');

    for (const project of data.projects) {
      const defaultMarker = project.isDefault ? ' (default)' : '';
      const missingMarker = project.dbExists ? '' : ' [MISSING]';
      lines.push(`   ${project.name}${defaultMarker}${missingMarker}`);
      lines.push(`   └─ ${project.projectRoot}`);
      lines.push('');
    }

    if (data.missingCount > 0) {
      lines.push('Tip: Run cmos_project(action="prune") to remove missing entries.');
    }
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
