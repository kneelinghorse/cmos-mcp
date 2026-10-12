/**
 * rbook_project_register Tool
 *
 * MCP tool for registering a Reasonbook project in the persistent registry.
 * Validates Reasonbook presence before registration.
 *
 * @module tools/rbook/rbook-project-register
 */

import * as path from 'path';
import { z } from 'zod';
import { ProjectGraphRegistry, readStoreIdentity } from '../../intelligence/project-graph-registry';
import { RbookDetector } from '../../intelligence/rbook-detector';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { appendWarnings } from './format-warnings';

/**
 * Result type for rbook_project_register.
 */
export interface ProjectRegisterResult {
  /** Project path that was registered */
  projectRoot: string;

  /** Display name of the project */
  name: string;

  /** Whether this project is now the default */
  isDefault: boolean;

  /**
   * s92-m01 — whether resolution may use this default. False for a default written before 3.2.0
   * and never re-confirmed; true once `setAsDefault: true` confirms it.
   */
  defaultApplied: boolean;

  /**
   * s92-m01 — whether the path lies under an ephemeral location (the OS temp dir, /tmp,
   * /private/tmp, or RBOOK_EPHEMERAL_PATHS). `rbook_project(action="validate", prune=true)`
   * archives such rows even while the store exists.
   */
  ephemeral: boolean;

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
 * Input parameters schema for rbook_project_register tool.
 */
export const rbookProjectRegisterSchema = z.object({
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

export type RbookProjectRegisterParams = z.infer<typeof rbookProjectRegisterSchema>;

/**
 * MCP Tool Definition for rbook_project_register.
 */
export const rbookProjectRegisterToolDefinition = {
  name: 'rbook_project_register',
  description:
    'Register a Reasonbook project in the persistent registry. ' +
    'Validates that the project has a Reasonbook database (rbook/db/rbook.sqlite). ' +
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
 * Execute the rbook_project_register tool.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with registered project or actionable error
 */
export async function rbookProjectRegister(
  params: RbookProjectRegisterParams
): Promise<RbookToolResult<ProjectRegisterResult>> {
  const { projectRoot, name, setAsDefault } = params;

  // Validate required parameters
  if (!projectRoot || projectRoot.trim() === '') {
    return createError(RbookErrors.missingParameter('projectRoot'));
  }

  try {
    const resolvedPath = path.resolve(projectRoot);

    // Verify the project has a Reasonbook database before registering (the file must
    // exist; validity is not required — a store may carry an unreadable/legacy DB).
    const detector = RbookDetector.getInstance();
    const detection = await detector.detect(resolvedPath, { forceRefresh: true });
    if (!detection.hasRbookDirectory || !detection.hasDatabase) {
      return createError({
        code: 'RBOOK_NOT_DETECTED',
        message: `No Reasonbook database found at ${resolvedPath}. Ensure rbook/db/rbook.sqlite exists.`,
        suggestion: `Initialize it with rbook_project(action="init", projectRoot=${JSON.stringify(resolvedPath)}), then retry register.`,
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
    const defaultStatus = graph.getDefaultStatus();
    const isDefault = defaultStatus.entry?.project_id === entry.project_id;
    const ephemeral = graph.isEphemeral(resolvedPath);
    const baseMessage = wasAlreadyRegistered
      ? `Updated project registration: ${entry.name}`
      : `Registered project: ${entry.name}`;
    const warnings = ephemeral
      ? [
          `${resolvedPath} is in an ephemeral location; rbook_project(action="validate", prune=true) archives it even while the store exists.`,
        ]
      : undefined;

    return createSuccess(
      {
        projectRoot: resolvedPath,
        name: entry.name,
        isDefault,
        defaultApplied: isDefault && defaultStatus.applied,
        ephemeral,
        wasAlreadyRegistered,
        registeredAt: new Date(entry.registered_at).toISOString(),
        metadataRepaired,
        message: baseMessage + (metadataRepaired ? ' (project metadata auto-populated)' : ''),
      },
      warnings
    );
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
export function formatProjectRegisterForLLM(
  result: RbookToolResult<ProjectRegisterResult>
): string {
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
    `   Default: ${
      data.isDefault
        ? data.defaultApplied
          ? 'Yes'
          : 'Yes, not applied (set before 3.2.0; re-run with setAsDefault=true to apply it)'
        : 'No'
    }`,
  ];
  if (data.ephemeral) lines.push('   Ephemeral: Yes (archived by validate with prune=true)');

  appendWarnings(lines, result);

  return lines.join('\n');
}
