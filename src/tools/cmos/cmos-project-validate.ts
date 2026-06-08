/**
 * cmos_project_validate Tool
 *
 * MCP tool for validating all registered CMOS projects.
 * Checks that project directories and CMOS databases still exist.
 *
 * @module tools/cmos/cmos-project-validate
 */

import { z } from 'zod';
import { ProjectRegistry } from '../../intelligence/project-registry';
import type { ProjectValidation } from '../../intelligence/project-registry';
import type { CmosToolResult } from './types';
import { createError, createSuccess } from './errors';

/**
 * Validation result for a single project.
 */
export interface ProjectValidationItem {
  /** Project path */
  projectRoot: string;

  /** Project display name */
  name: string;

  /** Validation status */
  status: 'active' | 'stale' | 'missing';

  /** Human-readable status message */
  message: string;
}

/**
 * Summary statistics for validation.
 */
export interface ValidationSummary {
  /** Total projects validated */
  total: number;

  /** Number of active (healthy) projects */
  active: number;

  /** Number of stale projects (DB missing/invalid) */
  stale: number;

  /** Number of missing projects (directory gone) */
  missing: number;
}

/**
 * Result type for cmos_project_validate.
 */
export interface ProjectValidateResult {
  /** Validation results for each project */
  validations: ProjectValidationItem[];

  /** Summary statistics */
  summary: ValidationSummary;
}

/**
 * Input parameters schema for cmos_project_validate tool.
 */
export const cmosProjectValidateSchema = z.object({
  /** Whether to automatically prune stale/missing entries */
  prune: z
    .boolean()
    .optional()
    .describe('Automatically remove stale and missing projects from registry'),
});

export type CmosProjectValidateParams = z.infer<typeof cmosProjectValidateSchema>;

/**
 * MCP Tool Definition for cmos_project_validate.
 */
export const cmosProjectValidateToolDefinition = {
  name: 'cmos_project_validate',
  description:
    'Validate all registered CMOS projects. ' +
    'Checks that project directories exist and contain CMOS databases. ' +
    'Reports active, stale, and missing projects. ' +
    'Optionally prune invalid entries with prune=true.',
  inputSchema: {
    type: 'object',
    properties: {
      prune: {
        type: 'boolean',
        description: 'Automatically remove stale and missing projects from registry',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_project_validate tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with validation results or error
 */
export async function cmosProjectValidate(
  params: CmosProjectValidateParams
): Promise<CmosToolResult<ProjectValidateResult>> {
  const { prune = false } = params;

  try {
    const registry = await ProjectRegistry.create();
    const validations: ProjectValidation[] = await registry.validate();

    const items: ProjectValidationItem[] = validations.map((v) => ({
      projectRoot: v.project.projectRoot,
      name: v.project.name ?? v.project.projectRoot,
      status: v.status,
      message: v.message,
    }));

    const summary: ValidationSummary = {
      total: items.length,
      active: items.filter((v) => v.status === 'active').length,
      stale: items.filter((v) => v.status === 'stale').length,
      missing: items.filter((v) => v.status === 'missing').length,
    };

    // Optionally prune invalid entries
    if (prune && (summary.stale > 0 || summary.missing > 0)) {
      await registry.prune();
    }

    return createSuccess({
      validations: items,
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createError({
      code: 'DB_CONNECTION_FAILED',
      message: `Failed to validate projects: ${message}`,
      suggestion: 'Check registry file permissions',
    });
  }
}

/**
 * Format project validate result for LLM readability.
 *
 * @param result - Project validate result
 * @returns Human-readable summary
 */
export function formatProjectValidateForLLM(result: CmosToolResult<ProjectValidateResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to validate projects',
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
  const { summary } = data;
  const lines: string[] = [];

  if (summary.total === 0) {
    lines.push('📋 No projects to validate');
    lines.push('');
    lines.push('Use cmos_project_register to add a project.');
    return lines.join('\n');
  }

  // Summary header
  const statusIcon =
    summary.stale === 0 && summary.missing === 0 ? '✓' : summary.active === 0 ? '❌' : '⚠️';
  lines.push(`${statusIcon} Validation Complete`);
  lines.push('');
  lines.push(
    `   Active: ${summary.active}  |  Stale: ${summary.stale}  |  Missing: ${summary.missing}`
  );
  lines.push('');

  // Group by status
  const active = data.validations.filter((v) => v.status === 'active');
  const stale = data.validations.filter((v) => v.status === 'stale');
  const missing = data.validations.filter((v) => v.status === 'missing');

  if (active.length > 0) {
    lines.push('Active Projects:');
    for (const v of active) {
      lines.push(`   ✓ ${v.name}`);
    }
    lines.push('');
  }

  if (stale.length > 0) {
    lines.push('Stale Projects (CMOS database missing):');
    for (const v of stale) {
      lines.push(`   ⚠️ ${v.name}`);
      lines.push(`      ${v.projectRoot}`);
    }
    lines.push('');
  }

  if (missing.length > 0) {
    lines.push('Missing Projects (directory not found):');
    for (const v of missing) {
      lines.push(`   ❌ ${v.name}`);
      lines.push(`      ${v.projectRoot}`);
    }
    lines.push('');
  }

  if (stale.length > 0 || missing.length > 0) {
    lines.push('Tip: Use cmos_project_validate(prune=true) to remove invalid entries.');
  }

  return lines.join('\n');
}
