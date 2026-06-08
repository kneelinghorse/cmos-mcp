/**
 * cmos_mission_add Tool
 *
 * MCP tool for creating new missions in the CMOS database.
 * Validates sprint exists before creation and supports all spec fields.
 *
 * @module tools/cmos/cmos-mission-add
 */

import { z } from 'zod';
import { withClientAsync } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult, MissionStatus, Sprint } from './types';
import { createError, createSuccess, CmosErrors, VALID_MISSION_STATUSES } from './errors';
import {
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import { ensureMissionTimestamps } from './schema-migrations';
import { recordEmbedding, missionEmbeddingInput } from '../../intelligence/embedding-pipeline';

/**
 * Result type for cmos_mission_add.
 */
export interface MissionAddResult {
  /** Created mission ID */
  id: string;

  /** Mission name */
  name: string;

  /** Sprint ID the mission belongs to */
  sprintId: string;

  /** Mission status */
  status: MissionStatus;

  /** Confirmation message */
  message: string;

  /** Full mission details */
  mission: {
    id: string;
    name: string;
    sprintId: string;
    status: MissionStatus;
    objective?: string;
    context?: string;
    successCriteria?: string[];
    deliverables?: string[];
    referenceDocs?: string[];
    domainFields?: Record<string, unknown>;
    notes?: string;
  };
}

/**
 * Input parameters schema for cmos_mission_add tool.
 */
export const cmosMissionAddSchema = z.object({
  /** Unique mission identifier */
  missionId: z.string().min(1).describe("The mission ID (e.g., 's14-m05')"),

  /** Mission name/title */
  name: z.string().min(1).describe('Display name for the mission'),

  /** Sprint ID to associate with */
  sprintId: z.string().min(1).describe('Must reference an existing sprint'),

  /** Mission status (default: Queued) */
  status: z
    .enum(['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'])
    .optional()
    .describe("Mission status (default: 'Queued')"),

  /** Mission objective */
  objective: z.string().optional().describe('What this mission aims to accomplish'),

  /** Mission context - can be string or object */
  context: z
    .union([z.string(), z.record(z.unknown())])
    .optional()
    .describe('Background context explaining why this mission matters'),

  /** Success criteria */
  successCriteria: z
    .array(z.string())
    .optional()
    .describe('Measurable criteria for mission completion'),

  /** Expected deliverables */
  deliverables: z.array(z.string()).optional().describe('Files or artifacts to be produced'),

  /** Reference documentation */
  referenceDocs: z
    .array(z.string())
    .optional()
    .describe('Documentation to reference during implementation'),

  /** Domain-specific fields */
  domainFields: z.record(z.unknown()).optional().describe('Domain-specific custom fields'),

  /** Notes */
  notes: z.string().optional().describe('Additional notes about the mission'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionAddParams = z.infer<typeof cmosMissionAddSchema>;

/**
 * MCP Tool Definition for cmos_mission_add.
 */
export const cmosMissionAddToolDefinition = {
  name: 'cmos_mission_add',
  description:
    'Create a new mission in the CMOS database. ' +
    'Validates that the specified sprint exists before creation. ' +
    'Supports all mission spec fields including objective, context, success criteria, deliverables, and reference docs.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: "The mission ID (e.g., 's14-m05')",
      },
      name: {
        type: 'string',
        description: 'Display name for the mission',
      },
      sprintId: {
        type: 'string',
        description: 'Must reference an existing sprint',
      },
      status: {
        type: 'string',
        enum: ['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'],
        description: "Mission status (default: 'Queued')",
      },
      objective: {
        type: 'string',
        description: 'What this mission aims to accomplish',
      },
      context: {
        oneOf: [{ type: 'string' }, { type: 'object' }],
        description: 'Background context explaining why this mission matters',
      },
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Measurable criteria for mission completion',
      },
      deliverables: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or artifacts to be produced',
      },
      referenceDocs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Documentation to reference during implementation',
      },
      domainFields: {
        type: 'object',
        description: 'Domain-specific custom fields',
      },
      notes: {
        type: 'string',
        description: 'Additional notes about the mission',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId', 'name', 'sprintId'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_add tool.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with created mission or actionable error
 */
export async function cmosMissionAdd(
  params: CmosMissionAddParams
): Promise<CmosToolResult<MissionAddResult>> {
  const sanitizedFields: SanitizedField[] = [];
  const sanitizeScalar = (
    field: 'name' | 'objective' | 'notes',
    value: string | undefined
  ): string | undefined => {
    if (typeof value !== 'string') return value;
    const r = sanitizeContentField(value);
    if (r.wasModified) sanitizedFields.push({ field, reason: r.reason ?? '' });
    return r.cleaned;
  };

  const name = sanitizeScalar('name', params.name) ?? params.name;
  const objective = sanitizeScalar('objective', params.objective);
  const notes = sanitizeScalar('notes', params.notes);
  const successCriteriaSan = sanitizeStringArray('successCriteria', params.successCriteria);
  sanitizedFields.push(...successCriteriaSan.sanitizedFields);
  const successCriteria = successCriteriaSan.cleaned;
  const deliverablesSan = sanitizeStringArray('deliverables', params.deliverables);
  sanitizedFields.push(...deliverablesSan.sanitizedFields);
  const deliverables = deliverablesSan.cleaned;
  const referenceDocsSan = sanitizeStringArray('referenceDocs', params.referenceDocs);
  sanitizedFields.push(...referenceDocsSan.sanitizedFields);
  const referenceDocs = referenceDocsSan.cleaned;
  let context = params.context;
  if (typeof context === 'string') {
    const r = sanitizeContentField(context);
    if (r.wasModified) sanitizedFields.push({ field: 'context', reason: r.reason ?? '' });
    context = r.cleaned;
  }
  const { missionId, sprintId, status = 'Queued', domainFields } = params;

  // Validate required parameters
  if (!missionId || missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  if (!name || name.trim() === '') {
    return createError(CmosErrors.missingParameter('name'));
  }

  if (!sprintId || sprintId.trim() === '') {
    return createError(CmosErrors.missingParameter('sprintId'));
  }

  // Validate status if provided
  if (status && !VALID_MISSION_STATUSES.includes(status)) {
    return createError(CmosErrors.invalidParameter('status', status, VALID_MISSION_STATUSES));
  }

  return withClientAsync(
    async (client) => {
      // Verify sprint exists
      const sprintResult = client.getOne<Sprint>('SELECT id, title FROM sprints WHERE id = ?', [
        sprintId,
      ]);

      if (!sprintResult.success) {
        return createError<MissionAddResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to verify sprint' }
        );
      }

      if (!sprintResult.data) {
        return createError<MissionAddResult>(CmosErrors.sprintNotFound(sprintId));
      }

      // Check if mission ID already exists
      const existingResult = client.getOne<{ id: string }>('SELECT id FROM missions WHERE id = ?', [
        missionId,
      ]);

      if (!existingResult.success) {
        return createError<MissionAddResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check mission' }
        );
      }

      if (existingResult.data) {
        return createError<MissionAddResult>({
          code: 'MISSION_ID_EXISTS',
          message: `Mission '${missionId}' already exists`,
          suggestion: 'Choose a different mission ID or use cmos_mission_update to modify it',
        });
      }

      // Prepare context for storage
      const contextValue =
        context !== undefined
          ? typeof context === 'string'
            ? context
            : JSON.stringify(context)
          : null;

      // Ensure timestamp columns exist (migration)
      ensureMissionTimestamps(client);

      // Insert new mission with created_at timestamp
      const createdAt = new Date().toISOString();
      const genesis = genesisColumns(client, 'missions', getProjectId(client));
      const insertResult = client.execute(
        `INSERT INTO missions (
          id, sprint_id, name, status, objective, context,
          success_criteria, deliverables, reference_docs, domain_fields, notes,
          created_at, updated_at, ${genesis.columns.join(', ')}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${genesis.placeholders})`,
        [
          missionId.trim(),
          sprintId.trim(),
          name.trim(),
          status,
          objective?.trim() || null,
          contextValue,
          successCriteria ? JSON.stringify(successCriteria) : null,
          deliverables ? JSON.stringify(deliverables) : null,
          referenceDocs ? JSON.stringify(referenceDocs) : null,
          domainFields ? JSON.stringify(domainFields) : null,
          notes?.trim() || null,
          createdAt,
          createdAt,
          ...genesis.values,
        ]
      );

      if (!insertResult.success) {
        return createError<MissionAddResult>(
          insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create mission' }
        );
      }

      if (insertResult.data?.changes === 0) {
        return createError<MissionAddResult>({
          code: 'DB_QUERY_FAILED',
          message: 'Mission was not created (no rows affected)',
          suggestion: 'Check database permissions and try again',
        });
      }

      // Log creation event
      const now = new Date().toISOString();
      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'create', ?, ?, ?)`,
        [
          now,
          missionId,
          status,
          `Created mission ${missionId} in sprint ${sprintId}`,
          JSON.stringify({
            tool: 'cmos_mission_add',
            missionId,
            sprintId,
            name: name.trim(),
            status,
          }),
        ]
      );

      // Sprint 66 m03 — write-path embedding hook
      await recordEmbedding(client, {
        type: 'mission',
        id: missionId.trim(),
        inputText: missionEmbeddingInput({
          name: name.trim(),
          objective: objective?.trim() || null,
          notes: notes?.trim() || null,
          successCriteria: successCriteria ?? null,
        }),
      });

      // Build result with full mission details
      const mission: MissionAddResult['mission'] = {
        id: missionId.trim(),
        name: name.trim(),
        sprintId: sprintId.trim(),
        status,
      };

      if (objective) mission.objective = objective.trim();
      if (context) {
        mission.context = typeof context === 'string' ? context : JSON.stringify(context);
      }
      if (successCriteria) mission.successCriteria = successCriteria;
      if (deliverables) mission.deliverables = deliverables;
      if (referenceDocs) mission.referenceDocs = referenceDocs;
      if (domainFields) mission.domainFields = domainFields;
      if (notes) mission.notes = notes.trim();

      return createSuccess(
        {
          id: missionId.trim(),
          name: name.trim(),
          sprintId: sprintId.trim(),
          status,
          message: `Mission '${missionId}' created successfully in sprint '${sprintId}'`,
          mission,
        },
        undefined,
        sanitizedFields
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format mission add result for LLM readability.
 *
 * @param result - Mission add result
 * @returns Human-readable summary
 */
export function formatMissionAddForLLM(result: CmosToolResult<MissionAddResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['Failed to create mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `Mission '${data.id}' created`,
    '',
    `Sprint: ${data.sprintId}`,
    `Name: ${data.name}`,
    `Status: ${data.status}`,
  ];

  if (data.mission.objective) {
    lines.push(`Objective: ${data.mission.objective}`);
  }

  if (data.mission.successCriteria && data.mission.successCriteria.length > 0) {
    lines.push(`Success criteria: ${data.mission.successCriteria.length} items`);
  }

  if (data.mission.deliverables && data.mission.deliverables.length > 0) {
    lines.push(`Deliverables: ${data.mission.deliverables.length} items`);
  }

  return lines.join('\n');
}
