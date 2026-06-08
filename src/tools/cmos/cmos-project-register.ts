/**
 * cmos_project_register Tool
 *
 * MCP tool for registering a CMOS project in the persistent registry.
 * Validates CMOS presence before registration.
 *
 * @module tools/cmos/cmos-project-register
 */

import * as path from 'path';
import { z } from 'zod';
import { ProjectRegistry } from '../../intelligence/project-registry';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { withClientAsync } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';

/**
 * Result type for cmos_project_register.
 */
export interface ProjectRegisterResult {
  /** Project path that was registered */
  projectRoot: string;

  /** Display name of the project */
  name: string;

  /** Whether this project is now the default */
  isDefault: boolean;

  /** Whether project was already registered (updated) */
  wasAlreadyRegistered: boolean;

  /** Registration timestamp */
  registeredAt: string;

  /** Whether empty metadata was auto-populated */
  metadataRepaired: boolean;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters schema for cmos_project_register tool.
 */
export const cmosProjectRegisterSchema = z.object({
  /** Absolute path to project root */
  projectRoot: z.string().min(1).describe('Absolute path to the project root directory'),

  /** Optional display name for the project */
  name: z.string().optional().describe('Optional display name for the project'),

  /** Whether to set this project as the default */
  setAsDefault: z
    .boolean()
    .optional()
    .describe('Set this project as the default (for Claude Desktop fallback)'),
});

export type CmosProjectRegisterParams = z.infer<typeof cmosProjectRegisterSchema>;

/**
 * MCP Tool Definition for cmos_project_register.
 */
export const cmosProjectRegisterToolDefinition = {
  name: 'cmos_project_register',
  description:
    'Register a CMOS project in the persistent registry. ' +
    'Validates that the project has a CMOS database (cmos/db/cmos.sqlite). ' +
    'Optionally set as default project for Claude Desktop fallback.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Absolute path to the project root directory',
      },
      name: {
        type: 'string',
        description: 'Optional display name for the project',
      },
      setAsDefault: {
        type: 'boolean',
        description: 'Set this project as the default (for Claude Desktop fallback)',
      },
    },
    required: ['projectRoot'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_project_register tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with registered project or actionable error
 */
export async function cmosProjectRegister(
  params: CmosProjectRegisterParams
): Promise<CmosToolResult<ProjectRegisterResult>> {
  const { projectRoot, name, setAsDefault } = params;

  // Validate required parameters
  if (!projectRoot || projectRoot.trim() === '') {
    return createError(CmosErrors.missingParameter('projectRoot'));
  }

  try {
    const registry = await ProjectRegistry.create();
    const result = await registry.register(projectRoot, {
      name,
      setAsDefault,
    });

    if (!result.success) {
      return createError({
        code: 'CMOS_NOT_DETECTED',
        message: result.message,
        suggestion: 'Ensure the project has a cmos/db/cmos.sqlite file',
      });
    }

    // Check if this is the default
    const defaultProject = await registry.getDefault();
    const isDefault = defaultProject?.projectRoot === result.project?.projectRoot;

    // Auto-populate empty metadata in the SQLite DB
    const projectName = result.project!.name ?? path.basename(result.project!.projectRoot);
    let metadataRepaired = false;
    try {
      const repairResult = await withClientAsync(
        async (db) => {
          interface MetadataRow {
            value: string;
          }
          const pidResult = db.getOne<MetadataRow>(
            `SELECT value FROM metadata WHERE key = 'project_id'`
          );
          const pnameResult = db.getOne<MetadataRow>(
            `SELECT value FROM metadata WHERE key = 'project_name'`
          );
          const hasId = pidResult.success && pidResult.data?.value;
          const hasName = pnameResult.success && pnameResult.data?.value;

          if (!hasId || !hasName) {
            const derivedId = projectName.toLowerCase().replace(/\s+/g, '-');
            if (!hasId) {
              db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
                derivedId,
              ]);
            }
            if (!hasName) {
              db.execute(
                `INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`,
                [projectName]
              );
            }
            return createSuccess({ repaired: true });
          }
          return createSuccess({ repaired: false });
        },
        { projectRoot: result.project!.projectRoot }
      );
      metadataRepaired = repairResult.success && repairResult.data?.repaired === true;
    } catch {
      // Non-critical — metadata repair is best-effort
    }

    // s69-m05 — mirror the registration into the per-user project-graph registry
    // (project_id → store metadata) so the cross-store fan-out path + future
    // App-View Relay can discover this store without a filesystem scan. Runs after
    // metadata repair so project_id is populated. Best-effort: an optimization
    // layer, never fails the registration.
    try {
      const graph = await ProjectGraphRegistry.create();
      graph.touchOrRegisterFromStore(result.project!.projectRoot);
    } catch {
      // Non-critical — the project-graph registry is an additive discovery index.
    }

    return createSuccess({
      projectRoot: result.project!.projectRoot,
      name: result.project!.name ?? result.project!.projectRoot,
      isDefault,
      wasAlreadyRegistered: result.wasAlreadyRegistered ?? false,
      registeredAt: result.project!.registeredAt,
      metadataRepaired,
      message: result.message + (metadataRepaired ? ' (project metadata auto-populated)' : ''),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createError({
      code: 'DB_CONNECTION_FAILED',
      message: `Failed to register project: ${message}`,
      suggestion: 'Check that the path exists and is accessible',
    });
  }
}

/**
 * Format project register result for LLM readability.
 *
 * @param result - Project register result
 * @returns Human-readable summary
 */
export function formatProjectRegisterForLLM(result: CmosToolResult<ProjectRegisterResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to register project',
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
    data.wasAlreadyRegistered ? '✓ Project registration updated' : '✓ Project registered',
    '',
    `   Path: ${data.projectRoot}`,
    `   Name: ${data.name}`,
    `   Default: ${data.isDefault ? 'Yes' : 'No'}`,
  ];

  return lines.join('\n');
}
