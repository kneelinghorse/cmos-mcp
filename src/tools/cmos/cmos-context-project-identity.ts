// ABOUTME: Handlers for cmos_context(contextType="project_identity") — view and update actions.
// Wraps project-identity.ts core functions into the standard CmosToolResult response shape.

import { withClient, withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CMOS_ERROR_CODES } from './errors';
import {
  getProjectIdentity,
  applyProjectIdentityFieldUpdate,
  ensureProjectIdentityRow,
  type ProjectIdentityData,
} from './project-identity';
import { appendWarnings } from './format-warnings';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProjectIdentityViewResult {
  projectIdentity: ProjectIdentityData;
  seeded: boolean;
}

export interface ProjectIdentityUpdateResult {
  fieldsUpdated: string[];
  projectIdentity: ProjectIdentityData;
  message: string;
}

// ─── Params ─────────────────────────────────────────────────────────────────

export interface ProjectIdentityViewParams {
  projectRoot?: string;
}

export interface ProjectIdentityUpdateParams {
  fieldUpdates?: Array<{ path: string; value: unknown }>;
  projectRoot?: string;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * View the project_identity context row.
 * Auto-seeds the row if it doesn't exist yet.
 */
export async function cmosContextViewProjectIdentity(
  params: ProjectIdentityViewParams
): Promise<CmosToolResult<ProjectIdentityViewResult>> {
  return withClient(
    (client) => {
      const migration = ensureProjectIdentityRow(client);
      const identity = getProjectIdentity(client);

      if (!identity) {
        return createError<ProjectIdentityViewResult>({
          code: CMOS_ERROR_CODES.CONTEXT_NOT_FOUND,
          message: 'project_identity context row could not be created or read.',
          suggestion: 'Check database connectivity and ensure the contexts table exists.',
        });
      }

      // s86-m02b: `seeded` is derived from `alreadyCurrent`, which a FAILED seed INSERT sets
      // exactly the way a genuinely-present row does — so `seeded: false` would report "the
      // row already existed" off a write that never landed. The migration's warnings channel
      // carries the DB error onto the envelope (rendered by appendWarnings below).
      return createSuccess<ProjectIdentityViewResult>(
        {
          projectIdentity: identity,
          seeded: !migration.alreadyCurrent,
        },
        migration.warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Update fields in the project_identity context row.
 * Accepts fieldUpdates using dot notation (top-level or type_fields.key).
 */
export async function cmosContextUpdateProjectIdentity(
  params: ProjectIdentityUpdateParams
): Promise<CmosToolResult<ProjectIdentityUpdateResult>> {
  return withClientValidated(
    (client) => {
      const fieldUpdates = params.fieldUpdates ?? [];

      if (fieldUpdates.length === 0) {
        return createError<ProjectIdentityUpdateResult>({
          code: CMOS_ERROR_CODES.INVALID_PARAMETER,
          message: 'project_identity update requires fieldUpdates.',
          suggestion:
            'Provide fieldUpdates with dot-notation paths like "description", "domain", "objectives", "type_fields.stack".',
        });
      }

      const updatedPaths: string[] = [];

      for (const update of fieldUpdates) {
        const result = applyProjectIdentityFieldUpdate(client, update.path, update.value);
        if (!result.success) {
          return createError<ProjectIdentityUpdateResult>({
            code: CMOS_ERROR_CODES.INVALID_PARAMETER,
            message: result.message ?? `Failed to update field "${update.path}"`,
            suggestion: 'Use top-level field names or "type_fields.fieldName" notation.',
          });
        }
        updatedPaths.push(update.path);
      }

      const identity = getProjectIdentity(client);
      if (!identity) {
        return createError<ProjectIdentityUpdateResult>({
          code: CMOS_ERROR_CODES.CONTEXT_NOT_FOUND,
          message: 'Could not read project_identity after update.',
          suggestion: 'Check database connectivity.',
        });
      }

      return createSuccess<ProjectIdentityUpdateResult>({
        fieldsUpdated: updatedPaths,
        projectIdentity: identity,
        message: `Updated ${updatedPaths.length} field(s) in project_identity.`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Formatters ─────────────────────────────────────────────────────────────

export function formatProjectIdentityViewForLLM(
  result: CmosToolResult<ProjectIdentityViewResult>
): string {
  if (!result.success || !result.data) {
    return `❌ Failed to view project_identity: ${result.error?.message ?? 'Unknown error'}`;
  }

  const { projectIdentity, seeded } = result.data;
  const lines: string[] = [];

  if (seeded) {
    lines.push('ℹ️ project_identity row was created automatically (seeded from existing context).');
    lines.push('');
  }

  lines.push(`# Project Identity — ${projectIdentity.project_name || '(unnamed)'}`);
  lines.push('');
  lines.push(`**Address:** ${projectIdentity.cmos_address || '(not set)'}`);
  lines.push(`**Platform:** ${projectIdentity.platform}`);
  lines.push(`**Domain:** ${projectIdentity.domain || '(not set)'}`);
  lines.push(`**Type:** ${projectIdentity.project_type} | **Tier:** ${projectIdentity.tier}`);
  lines.push(`**Status:** ${projectIdentity.status}`);
  lines.push(`**Version:** ${projectIdentity.identity_contract_version}`);
  lines.push('');

  if (projectIdentity.description) {
    lines.push(`**Description:**`);
    lines.push(projectIdentity.description);
    lines.push('');
  }

  if (projectIdentity.objectives.length > 0) {
    lines.push(`**Objectives (${projectIdentity.objectives.length}):**`);
    projectIdentity.objectives.forEach((o) => lines.push(`  - ${o}`));
    lines.push('');
  }

  if (projectIdentity.related_projects.length > 0) {
    lines.push(`**Related Projects:**`);
    projectIdentity.related_projects.forEach((rp) =>
      lines.push(`  - ${rp.name} (${rp.address}) — ${rp.relationship}`)
    );
    lines.push('');
  }

  if (projectIdentity.foundational_docs.length > 0) {
    lines.push(`**Foundational Docs:**`);
    projectIdentity.foundational_docs.forEach((d) => lines.push(`  - ${d.title}: ${d.path}`));
    lines.push('');
  }

  if (projectIdentity.tracelab_refs.length > 0) {
    lines.push(`**TraceLab Refs:**`);
    projectIdentity.tracelab_refs.forEach((ref) =>
      lines.push(`  - [${ref.type}:${ref.id}] ${ref.label}`)
    );
    lines.push('');
  }

  const typeFieldKeys = Object.keys(projectIdentity.type_fields ?? {});
  if (typeFieldKeys.length > 0) {
    lines.push(`**Type Fields (${projectIdentity.project_type}):**`);
    typeFieldKeys.forEach((k) => {
      const v = projectIdentity.type_fields[k];
      const display = Array.isArray(v) ? v.join(', ') : String(v);
      lines.push(`  - ${k}: ${display}`);
    });
    lines.push('');
  }

  lines.push(
    `*Updated: ${projectIdentity.updated_at ? new Date(projectIdentity.updated_at).toLocaleString() : 'unknown'}*`
  );

  appendWarnings(lines, result);

  return lines.join('\n');
}

export function formatProjectIdentityUpdateForLLM(
  result: CmosToolResult<ProjectIdentityUpdateResult>
): string {
  if (!result.success || !result.data) {
    return `❌ Failed to update project_identity: ${result.error?.message ?? 'Unknown error'}`;
  }

  const { fieldsUpdated, message } = result.data;
  const lines = [`✓ ${message}`, ''];

  if (fieldsUpdated.length > 0) {
    lines.push('**Fields updated:**');
    fieldsUpdated.forEach((f) => lines.push(`  - ${f}`));
  }

  // Sprint 72 m03 (#790): render folded-in collab-sync warnings so a superseded
  // project_identity push surfaces its restore hint to the operator.
  appendWarnings(lines, result);

  return lines.join('\n');
}
