/**
 * cmos_project_unregister Tool
 *
 * MCP tool for removing a project from the persistent registry.
 * Does not delete any files, only removes the registry entry.
 *
 * @module tools/cmos/cmos-project-unregister
 */

import * as path from 'path';
import { z } from 'zod';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Result type for cmos_project_unregister.
 */
export interface ProjectUnregisterResult {
  /** Project path that was unregistered */
  projectRoot: string;

  /** Whether the project was the default (now cleared) */
  wasDefault: boolean;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters schema for cmos_project_unregister tool.
 */
export const cmosProjectUnregisterSchema = z.object({
  /** Absolute path to project root */
  projectRoot: z.string().min(1).describe('Absolute path to the project to unregister'),
});

export type CmosProjectUnregisterParams = z.infer<typeof cmosProjectUnregisterSchema>;

/**
 * MCP Tool Definition for cmos_project_unregister.
 */
export const cmosProjectUnregisterToolDefinition = {
  name: 'cmos_project_unregister',
  description:
    'Remove a project from the CMOS registry. ' +
    'Does not delete any files, only removes the registry entry. ' +
    'If the project was the default, the default is cleared.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Absolute path to the project to unregister',
      },
    },
    required: ['projectRoot'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_project_unregister tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with unregistration result or error
 */
export async function cmosProjectUnregister(
  params: CmosProjectUnregisterParams
): Promise<CmosToolResult<ProjectUnregisterResult>> {
  const { projectRoot } = params;

  // Validate required parameters
  if (!projectRoot || projectRoot.trim() === '') {
    return createError(CmosErrors.missingParameter('projectRoot'));
  }

  try {
    // s79-m02 — remove from the project-graph registry (the sole discovery store).
    // s80-m02: the graph is the single source — no JSON mirror to re-derive.
    const resolvedPath = path.resolve(projectRoot);
    const graph = await ProjectGraphRegistry.create();
    const { removed, wasDefault } = graph.unregisterStore(resolvedPath);

    if (!removed) {
      return createError({
        code: 'MISSION_NOT_FOUND',
        message: `Project not found in registry: ${resolvedPath}`,
        suggestion: 'Use cmos_project(action="list") to see registered projects',
      });
    }

    return createSuccess({
      projectRoot,
      wasDefault,
      message: `Unregistered project: ${resolvedPath}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createError({
      code: 'DB_CONNECTION_FAILED',
      message: `Failed to unregister project: ${message}`,
      suggestion: 'Check registry file permissions',
    });
  }
}

/**
 * Format project unregister result for LLM readability.
 *
 * @param result - Project unregister result
 * @returns Human-readable summary
 */
export function formatProjectUnregisterForLLM(
  result: CmosToolResult<ProjectUnregisterResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to unregister project',
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
  const lines: string[] = ['✓ Project unregistered', '', `   Path: ${data.projectRoot}`];

  if (data.wasDefault) {
    lines.push('   Note: This was the default project. Default has been cleared.');
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
