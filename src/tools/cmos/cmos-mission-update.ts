/**
 * cmos_mission_update Tool
 *
 * MCP tool for partially updating mission fields in the CMOS database.
 * Only provided fields are updated, others remain unchanged.
 *
 * @module tools/cmos/cmos-mission-update
 */

import { z } from 'zod';
import { withClientAsync } from './client';
import type { CmosToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  VALID_MISSION_STATUSES,
  VALID_STATE_TRANSITIONS,
} from './errors';
import {
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import { recordEmbedding, missionEmbeddingInput } from '../../intelligence/embedding-pipeline';

/**
 * Fields that can be updated on a mission.
 * Matches the missions table schema.
 */
export interface MissionUpdateFields {
  /** Mission name/title */
  name?: string;

  /** Mission status (validates state transitions) */
  status?: MissionStatus;

  /** Mission objective */
  objective?: string;

  /** Context explaining why this mission matters */
  context?: string;

  /** Success criteria (array of strings) */
  successCriteria?: string[];

  /** Deliverables (array of strings) */
  deliverables?: string[];

  /** Reference docs (array of strings) */
  referenceDocs?: string[];

  /** Domain-specific fields (key-value object) */
  domainFields?: Record<string, unknown>;

  /** Notes about the mission */
  notes?: string;

  /** Additional metadata (key-value object) */
  metadata?: Record<string, unknown>;
}

/**
 * Result of updating a mission.
 */
export interface MissionUpdateResult {
  /** The mission ID that was updated */
  missionId: string;

  /** Fields that were updated */
  updatedFields: string[];

  /** Human-readable message */
  message: string;

  /** Previous status (if status was changed) */
  previousStatus?: MissionStatus;

  /** Current status (if status was changed) */
  currentStatus?: MissionStatus;
}

/**
 * Input parameters schema for cmos_mission_update tool.
 */
export const cmosMissionUpdateSchema = z.object({
  /** The mission ID to update */
  missionId: z.string().min(1).describe('The mission ID to update (e.g., "s12-m06")'),

  /** Fields to update (only provided fields are changed) */
  fields: z
    .object({
      name: z.string().optional().describe('Mission name/title'),
      status: z
        .enum(['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'])
        .optional()
        .describe('Mission status (validates state transitions)'),
      objective: z.string().optional().describe('Mission objective'),
      context: z.string().optional().describe('Context explaining why this mission matters'),
      successCriteria: z
        .array(z.string())
        .optional()
        .describe('Success criteria (array of strings)'),
      deliverables: z.array(z.string()).optional().describe('Deliverables (array of strings)'),
      referenceDocs: z.array(z.string()).optional().describe('Reference docs (array of strings)'),
      domainFields: z
        .record(z.unknown())
        .optional()
        .describe('Domain-specific fields (key-value object)'),
      notes: z.string().optional().describe('Notes about the mission'),
      metadata: z.record(z.unknown()).optional().describe('Additional metadata (key-value object)'),
    })
    .describe('Fields to update (only provided fields are changed)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionUpdateParams = z.infer<typeof cmosMissionUpdateSchema>;

/**
 * MCP Tool Definition for cmos_mission_update.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionUpdateToolDefinition = {
  name: 'cmos_mission_update',
  description:
    'Update specific fields of a mission without replacing the entire record. ' +
    'Only provided fields are updated, others remain unchanged. ' +
    'If updating status, validates state transitions and returns INVALID_STATE_TRANSITION error if invalid.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to update (e.g., "s12-m06")',
      },
      fields: {
        type: 'object',
        description: 'Fields to update (only provided fields are changed)',
        properties: {
          name: {
            type: 'string',
            description: 'Mission name/title',
          },
          status: {
            type: 'string',
            enum: [
              'Queued',
              'Current',
              'In Progress',
              'Completed',
              'Blocked',
              'Dropped',
              'Deferred',
            ],
            description: 'Mission status (validates state transitions)',
          },
          objective: {
            type: 'string',
            description: 'Mission objective',
          },
          context: {
            type: 'string',
            description: 'Context explaining why this mission matters',
          },
          successCriteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Success criteria (array of strings)',
          },
          deliverables: {
            type: 'array',
            items: { type: 'string' },
            description: 'Deliverables (array of strings)',
          },
          referenceDocs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Reference docs (array of strings)',
          },
          domainFields: {
            type: 'object',
            description: 'Domain-specific fields (key-value object)',
          },
          notes: {
            type: 'string',
            description: 'Notes about the mission',
          },
          metadata: {
            type: 'object',
            description: 'Additional metadata (key-value object)',
          },
        },
        additionalProperties: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId', 'fields'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_update tool.
 *
 * Partially updates mission fields in the CMOS database.
 * Only fields included in the `fields` object are updated.
 *
 * @param params - Tool parameters (missionId, fields, projectRoot)
 * @returns CmosToolResult with update result or actionable error
 */
export async function cmosMissionUpdate(
  params: CmosMissionUpdateParams
): Promise<CmosToolResult<MissionUpdateResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const sanitizedFields: SanitizedField[] = [];
  const rawFields = params.fields;
  const fields: MissionUpdateFields = { ...rawFields };

  const scalarFieldNames = ['name', 'objective', 'context', 'notes'] as const;
  for (const key of scalarFieldNames) {
    const value = fields[key];
    if (typeof value === 'string') {
      const r = sanitizeContentField(value);
      if (r.wasModified) {
        sanitizedFields.push({ field: `fields.${key}`, reason: r.reason ?? '' });
        fields[key] = r.cleaned;
      }
    }
  }
  const arrayFieldNames = ['successCriteria', 'deliverables', 'referenceDocs'] as const;
  for (const key of arrayFieldNames) {
    const value = fields[key];
    if (Array.isArray(value)) {
      const r = sanitizeStringArray(`fields.${key}`, value);
      sanitizedFields.push(...r.sanitizedFields);
      fields[key] = r.cleaned as string[];
    }
  }

  // Check if any fields are provided
  const fieldKeys = Object.keys(fields).filter(
    (k) => fields[k as keyof MissionUpdateFields] !== undefined
  );

  if (fieldKeys.length === 0) {
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'No fields provided to update',
      suggestion: 'Provide at least one field to update (e.g., name, status, objective, notes)',
    });
  }

  // Validate status if provided
  if (fields.status !== undefined && !VALID_MISSION_STATUSES.includes(fields.status)) {
    return createError(
      CmosErrors.invalidParameter('status', fields.status, VALID_MISSION_STATUSES)
    );
  }

  return withClientAsync(
    async (client) => {
      // Query mission by ID
      const missionResult = client.getOne<Mission>(
        `
        SELECT id, status, name
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionUpdateResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionUpdateResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;
      let previousStatus: MissionStatus | undefined;
      let newStatus: MissionStatus | undefined;

      // Validate status transition if status is being changed
      if (fields.status !== undefined && fields.status !== currentStatus) {
        const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
        if (!validTransitions.includes(fields.status)) {
          return createError<MissionUpdateResult>(
            CmosErrors.missionInvalidTransition(missionId, currentStatus, fields.status)
          );
        }
        previousStatus = currentStatus;
        newStatus = fields.status;
      }

      // Build dynamic UPDATE query
      const setClauses: string[] = [];
      const queryParams: (string | null)[] = [];

      // Map of TypeScript field names to database column names
      const fieldMapping: Record<string, string> = {
        name: 'name',
        status: 'status',
        objective: 'objective',
        context: 'context',
        successCriteria: 'success_criteria',
        deliverables: 'deliverables',
        referenceDocs: 'reference_docs',
        domainFields: 'domain_fields',
        notes: 'notes',
        metadata: 'metadata',
      };

      // JSON fields that need serialization
      const jsonFields = new Set([
        'successCriteria',
        'deliverables',
        'referenceDocs',
        'domainFields',
        'metadata',
      ]);

      for (const key of fieldKeys) {
        const dbColumn = fieldMapping[key];
        if (!dbColumn) continue;

        const value = fields[key as keyof MissionUpdateFields];
        if (value === undefined) continue;

        setClauses.push(`${dbColumn} = ?`);

        if (jsonFields.has(key)) {
          queryParams.push(JSON.stringify(value));
        } else {
          queryParams.push(value as string);
        }
      }

      // Handle completed_at for status changes
      if (newStatus === 'Completed') {
        setClauses.push('completed_at = ?');
        queryParams.push(new Date().toISOString());
      }
      // Note: Completed is a terminal state per VALID_STATE_TRANSITIONS,
      // so we cannot move away from it. No need to clear completed_at.

      // Add missionId as the last parameter for WHERE clause
      queryParams.push(missionId);

      const updateQuery = `
        UPDATE missions
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `;

      const updateResult = client.execute(updateQuery, queryParams);

      if (!updateResult.success) {
        return createError<MissionUpdateResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionUpdateResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      // Log the state change to session_events if status changed
      if (previousStatus !== undefined && newStatus !== undefined) {
        const now = new Date().toISOString();
        const eventResult = client.execute(
          `
          INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
          VALUES (?, 'mcp-tool', ?, 'update', ?, ?, ?)
        `,
          [
            now,
            missionId,
            newStatus,
            `Updated mission ${missionId}: status changed from ${previousStatus} to ${newStatus}`,
            JSON.stringify({
              tool: 'cmos_mission_update',
              missionId,
              previousStatus,
              newStatus,
              updatedFields: fieldKeys,
            }),
          ]
        );

        // Don't fail the operation if event logging fails (non-critical)
        if (!eventResult.success) {
          console.warn('Failed to log mission update event:', eventResult.error);
        }
      }

      // Sprint 66 m03 — write-path embedding hook. recordEmbedding hashes the
      // composed input text and skips when unchanged, so status-only updates
      // pay no embed cost. Only fields that touch the embedding input
      // (name, objective, notes, success_criteria) trigger an actual embed.
      const refreshed = client.getOne<{
        name: string;
        objective: string | null;
        notes: string | null;
        success_criteria: string | null;
      }>(`SELECT name, objective, notes, success_criteria FROM missions WHERE id = ?`, [missionId]);
      if (refreshed.success && refreshed.data) {
        const row = refreshed.data;
        let criteria: string[] | null = null;
        if (row.success_criteria) {
          try {
            const parsed = JSON.parse(row.success_criteria);
            if (Array.isArray(parsed)) criteria = parsed.filter((s) => typeof s === 'string');
          } catch {
            // Malformed JSON in legacy rows — skip success_criteria for embedding.
          }
        }
        await recordEmbedding(client, {
          type: 'mission',
          id: missionId,
          inputText: missionEmbeddingInput({
            name: row.name,
            objective: row.objective,
            notes: row.notes,
            successCriteria: criteria,
          }),
        });
      }

      // Build result
      const result: MissionUpdateResult = {
        missionId,
        updatedFields: fieldKeys,
        message: `Mission '${missionId}' updated successfully (${fieldKeys.length} field${fieldKeys.length === 1 ? '' : 's'})`,
      };

      if (previousStatus !== undefined && newStatus !== undefined) {
        result.previousStatus = previousStatus;
        result.currentStatus = newStatus;
      }

      return createSuccess(result, undefined, sanitizedFields);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format mission update result for LLM readability.
 *
 * @param result - Mission update result
 * @returns Human-readable formatted result
 */
export function formatMissionUpdateForLLM(result: CmosToolResult<MissionUpdateResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['Failed to update mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.currentState) {
      lines.push(`Current status: ${error.currentState}`);
    }

    if (error?.validTransitions && error.validTransitions.length > 0) {
      lines.push(`Valid transitions: ${error.validTransitions.join(', ')}`);
    }

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `Mission '${data.missionId}' updated`,
    '',
    `Updated fields: ${data.updatedFields.join(', ')}`,
  ];

  if (data.previousStatus && data.currentStatus) {
    lines.push(`Status: ${data.previousStatus} -> ${data.currentStatus}`);
  }

  return lines.join('\n');
}
