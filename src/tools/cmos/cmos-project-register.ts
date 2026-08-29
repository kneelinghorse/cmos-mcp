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
import { ProjectGraphRegistry, readStoreIdentity } from '../../intelligence/project-graph-registry';
import { CmosDetector } from '../../intelligence/cmos-detector';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { appendWarnings } from './format-warnings';

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
    const resolvedPath = path.resolve(projectRoot);

    // Verify the project has a CMOS database before registering (the file must
    // exist; validity is not required — a store may carry an unreadable/legacy DB).
    const detector = CmosDetector.getInstance();
    const detection = await detector.detect(resolvedPath, { forceRefresh: true });
    if (!detection.hasCmosDirectory || !detection.hasDatabase) {
      return createError({
        code: 'CMOS_NOT_DETECTED',
        message: `No CMOS database found at ${resolvedPath}. Ensure cmos/db/cmos.sqlite exists.`,
        suggestion: 'Ensure the project has a cmos/db/cmos.sqlite file',
      });
    }

    // s79-m02 — the project-graph registry is the sole discovery store. Give the
    // store a stable project_id (mint a UUID where absent) and upsert into the
    // graph. (s80-m02: the graph is the single source — no JSON mirror to derive.)
    const graph = await ProjectGraphRegistry.create();
    const wasAlreadyRegistered = graph.getByStorePath(resolvedPath) !== null;
    const hadId = readStoreIdentity(resolvedPath) !== null;
    const entry = graph.registerStore(resolvedPath, {
      name,
      setAsDefault,
      requireStoredIdentity: true,
    });

    const metadataRepaired = !hadId && readStoreIdentity(resolvedPath) !== null;
    const isDefault = graph.getDefault()?.project_id === entry.project_id;
    const baseMessage = wasAlreadyRegistered
      ? `Updated project registration: ${entry.name}`
      : `Registered project: ${entry.name}`;

    return createSuccess({
      projectRoot: resolvedPath,
      name: entry.name,
      isDefault,
      wasAlreadyRegistered,
      registeredAt: new Date(entry.registered_at).toISOString(),
      metadataRepaired,
      message: baseMessage + (metadataRepaired ? ' (project metadata auto-populated)' : ''),
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

  appendWarnings(lines, result);

  return lines.join('\n');
}
