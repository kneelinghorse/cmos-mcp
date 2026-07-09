/**
 * cmos_context_update Tool
 *
 * MCP tool for aggregating recent session captures into master_context.
 * Pulls decisions, learnings, constraints from completed sessions
 * and updates the context JSON.
 *
 * @module tools/cmos/cmos-context-update
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import { withClientValidated, type CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult, Context } from './types';
import { createError, createSuccess, CMOS_ERROR_CODES } from './errors';
import {
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import {
  buildContextSizeWarning,
  condenseContextForRetention,
  getContextRetentionPolicy,
  resolveContextSizeSettings,
} from './context-retention';

/**
 * Capture item from session captures JSON.
 */
interface CaptureItem {
  category: string;
  content: string;
  timestamp?: string;
  context?: string;
}

/**
 * Session with captures.
 */
interface SessionWithCaptures {
  id: string;
  type: string;
  title: string;
  completed_at: string;
  captures: string | null;
  sprint_id: string | null;
}

/**
 * Aggregated items by category.
 * decisions and learnings removed (Sprint 51 blob reduction — now table-driven).
 */
interface AggregatedItems {
  constraints: string[];
}

/**
 * Manual array updates for context content.
 * decisions_made and learnings removed (Sprint 51 blob reduction — queryable from tables).
 */
interface ContextArrayUpdates {
  constraints?: string[];
  context_notes?: string[];
}

/**
 * Manual nested field update operation.
 */
interface ContextFieldUpdate {
  path: string;
  value: unknown;
}

/**
 * Result of context update operation.
 */
export interface CmosContextUpdateResult {
  /** Update mode used */
  mode?: 'aggregate' | 'manual';

  /** Context type updated (manual mode) */
  contextType?: 'master_context' | 'project_context';

  /** Number of sessions processed */
  sessionsProcessed: number;

  /** Number of decisions aggregated */
  decisionsAdded: number;

  /** Number of learnings aggregated */
  learningsAdded: number;

  /** Number of constraints aggregated */
  constraintsAdded: number;

  /** Total items aggregated */
  totalItemsAdded: number;

  /** Snapshot ID created (null if no changes) */
  snapshotId: number | null;

  /** Last session processed timestamp */
  lastSessionTimestamp: string | null;

  /** Whether the context was actually updated */
  contextUpdated: boolean;

  /** Manual nested fields updated */
  fieldsUpdated?: string[];

  /** Completed sprints whose detail was condensed */
  archivedSprintIds?: string[];

  /** Snapshot containing pre-condensed detail, when archival occurred */
  archiveSnapshotId?: number | null;

  /** Context size after update */
  contextSizeKb?: number;

  /** Percent of configured size limit used after update */
  contextUsagePercent?: number;

  /** Message describing the result */
  message: string;
}

/**
 * Input parameters schema for cmos_context_update tool.
 */
export const cmosContextUpdateSchema = z.object({
  /** Optional: explicit mode, inferred from provided fields if omitted */
  mode: z
    .enum(['aggregate', 'manual'])
    .optional()
    .describe(
      'Update mode: aggregate (session capture aggregation) or manual (direct context field updates).'
    ),

  /** Optional: context to update in manual mode */
  contextType: z
    .enum(['master_context', 'project_context'])
    .optional()
    .describe('Context target for manual mode. Defaults to master_context.'),

  /** Optional: array entries to merge into context arrays (manual mode) */
  arrayUpdates: z
    .object({
      constraints: z.array(z.string()).optional(),
      context_notes: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      'Manual mode: append unique entries into context arrays (constraints, context_notes). decisions_made and learnings are now queryable from tables — not stored in blob.'
    ),

  /** Optional: nested field updates (manual mode) */
  fieldUpdates: z
    .array(
      z.object({
        path: z.string().min(1),
        value: z.unknown(),
      })
    )
    .optional()
    .describe(
      'Manual mode: update nested fields using dot notation (e.g. technical_foundation.stack).'
    ),

  /** Optional: Only process sessions after this timestamp */
  since: z
    .string()
    .optional()
    .describe(
      'Only process sessions completed after this ISO timestamp (defaults to last context update)'
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosContextUpdateParams = z.infer<typeof cmosContextUpdateSchema>;

/**
 * MCP Tool Definition for cmos_context_update.
 */
export const cmosContextUpdateToolDefinition = {
  name: 'cmos_context_update',
  description:
    'Update CMOS contexts in aggregate or manual mode. Aggregate mode pulls recent session captures into master_context. Manual mode supports merge-only array updates and nested field updates in master_context or project_context. Creates automatic snapshot after each update.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['aggregate', 'manual'],
        description:
          'Update mode: aggregate (session capture aggregation) or manual (direct context field updates).',
      },
      contextType: {
        type: 'string',
        enum: ['master_context', 'project_context'],
        description: 'Context target for manual mode (defaults to master_context).',
      },
      arrayUpdates: {
        type: 'object',
        description:
          'Manual mode: append unique entries into context arrays without replacing existing data. decisions_made and learnings are no longer stored in the blob.',
        properties: {
          constraints: {
            type: 'array',
            items: { type: 'string' },
          },
          context_notes: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      fieldUpdates: {
        type: 'array',
        description: 'Manual mode: nested field updates using dot notation paths.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            value: {},
          },
          required: ['path', 'value'],
          additionalProperties: false,
        },
      },
      since: {
        type: 'string',
        description:
          'Only process sessions completed after this ISO timestamp (defaults to last context update)',
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
 * Execute the cmos_context_update tool.
 *
 * Aggregates decisions, learnings, and constraints from completed sessions
 * into master_context, then creates a snapshot.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with aggregation stats or actionable error
 */
export async function cmosContextUpdate(
  params: CmosContextUpdateParams = {}
): Promise<CmosToolResult<CmosContextUpdateResult>> {
  return withClientValidated(
    (client) => {
      if (shouldUseManualMode(params)) {
        return runManualUpdate(client, params);
      }

      return runAggregationUpdate(client, params);
    },
    { projectRoot: params.projectRoot }
  );
}

function shouldUseManualMode(params: CmosContextUpdateParams): boolean {
  if (params.mode === 'manual') {
    return true;
  }

  return Boolean(params.contextType || params.arrayUpdates || params.fieldUpdates);
}

function runAggregationUpdate(
  client: CmosDatabaseClient,
  params: CmosContextUpdateParams
): CmosToolResult<CmosContextUpdateResult> {
  // Get master_context and its last update time
  const contextResult = client.getOne<Context>(
    'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
    ['master_context']
  );

  // Determine cutoff timestamp
  let sinceTimestamp: string | null = params.since ?? null;

  if (!sinceTimestamp && contextResult.success && contextResult.data?.updated_at) {
    sinceTimestamp = contextResult.data.updated_at;
  }

  // Build query for completed sessions
  let sessionsQuery = `
    SELECT id, type, title, completed_at, captures, sprint_id
    FROM sessions
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
  `;
  const queryParams: (string | null)[] = [];

  if (sinceTimestamp) {
    sessionsQuery += ' AND completed_at > ?';
    queryParams.push(sinceTimestamp);
  }

  sessionsQuery += ' ORDER BY completed_at ASC';

  // Get sessions to process
  const sessionsResult = client.getMany<SessionWithCaptures>(sessionsQuery, queryParams);

  if (!sessionsResult.success) {
    return createError<CmosContextUpdateResult>({
      code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
      message: `Failed to query sessions: ${sessionsResult.error?.message ?? 'Unknown error'}`,
      suggestion: 'Check database connectivity and schema',
    });
  }

  const sessions = sessionsResult.data ?? [];

  if (sessions.length === 0) {
    return createSuccess<CmosContextUpdateResult>({
      mode: 'aggregate',
      contextType: 'master_context',
      sessionsProcessed: 0,
      decisionsAdded: 0,
      learningsAdded: 0,
      constraintsAdded: 0,
      totalItemsAdded: 0,
      snapshotId: null,
      lastSessionTimestamp: null,
      contextUpdated: false,
      message: sinceTimestamp
        ? `No completed sessions found since ${sinceTimestamp}`
        : 'No completed sessions found',
    });
  }

  // Aggregate captures from sessions (constraints only — decisions/learnings are table-driven)
  const aggregated = aggregateCapturesFromSessions(sessions);
  const totalItems = aggregated.constraints.length;

  if (totalItems === 0) {
    return createSuccess<CmosContextUpdateResult>({
      mode: 'aggregate',
      contextType: 'master_context',
      sessionsProcessed: sessions.length,
      decisionsAdded: 0,
      learningsAdded: 0,
      constraintsAdded: 0,
      totalItemsAdded: 0,
      snapshotId: null,
      lastSessionTimestamp: sessions[sessions.length - 1].completed_at,
      contextUpdated: false,
      message: `Processed ${sessions.length} session(s) but found no constraints to aggregate`,
    });
  }

  // Get or create master_context
  let masterContent: Record<string, unknown> = {};
  if (contextResult.success && contextResult.data) {
    try {
      masterContent = JSON.parse(contextResult.data.content);
    } catch {
      masterContent = {};
    }
  }

  // Update master_context with aggregated items
  const updatedContent = updateMasterContext(masterContent, aggregated);
  const policy = getContextRetentionPolicy();
  const condensation = condenseContextForRetention(client, 'master_context', updatedContent, {
    source: 'context_update:aggregate',
    policy,
  });
  const sizeSettings = resolveContextSizeSettings(updatedContent, policy);
  upsertContextHealthMetadata(updatedContent, sizeSettings, policy.keepDetailSprints);

  const warnings = [...condensation.notes];
  const sizeWarning = buildContextSizeWarning('master_context', condensation.sizeAfter);
  if (sizeWarning) {
    warnings.push(sizeWarning);
  }

  const now = new Date().toISOString();

  // Save updated context
  if (contextResult.success && contextResult.data) {
    // Update existing context
    const updateResult = client.execute(
      'UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(updatedContent), now, 'master_context']
    );

    if (!updateResult.success) {
      return createError<CmosContextUpdateResult>({
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to update master_context: ${updateResult.error?.message ?? 'Unknown error'}`,
        suggestion: 'Check database permissions',
      });
    }
  } else {
    // Create new master_context
    const insertResult = client.execute(
      'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
      ['master_context', 'context/MASTER_CONTEXT.json', JSON.stringify(updatedContent), now]
    );

    if (!insertResult.success) {
      return createError<CmosContextUpdateResult>({
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to create master_context: ${insertResult.error?.message ?? 'Unknown error'}`,
        suggestion: 'Check database permissions and schema',
      });
    }
  }

  // Create snapshot
  const snapshotResult = createSnapshot(
    client,
    'master_context',
    JSON.stringify(updatedContent),
    `Context update: aggregated ${totalItems} items from ${sessions.length} session(s)`
  );

  const snapshotId =
    snapshotResult.success && snapshotResult.snapshotId ? snapshotResult.snapshotId : null;

  return createSuccess<CmosContextUpdateResult>(
    {
      mode: 'aggregate',
      contextType: 'master_context',
      sessionsProcessed: sessions.length,
      decisionsAdded: 0,
      learningsAdded: 0,
      constraintsAdded: aggregated.constraints.length,
      totalItemsAdded: totalItems,
      snapshotId,
      archiveSnapshotId: condensation.archiveSnapshotId,
      archivedSprintIds: condensation.archivedSprintIds,
      lastSessionTimestamp: sessions[sessions.length - 1].completed_at,
      contextSizeKb: condensation.sizeAfter.sizeKb,
      contextUsagePercent: condensation.sizeAfter.usagePercent,
      contextUpdated: true,
      message: `Aggregated ${totalItems} constraint(s) from ${sessions.length} session(s)`,
    },
    warnings
  );
}

function runManualUpdate(
  client: CmosDatabaseClient,
  params: CmosContextUpdateParams
): CmosToolResult<CmosContextUpdateResult> {
  const contextType: 'master_context' | 'project_context' = params.contextType ?? 'master_context';
  const sanitizedFields: SanitizedField[] = [];
  const fieldUpdates: ContextFieldUpdate[] = (params.fieldUpdates ?? []).map((update) => {
    if (typeof update.value !== 'string') {
      return { path: update.path, value: update.value };
    }
    const r = sanitizeContentField(update.value);
    if (r.wasModified) {
      sanitizedFields.push({
        field: `fieldUpdates[${update.path}]`,
        reason: r.reason ?? '',
      });
    }
    return { path: update.path, value: r.cleaned };
  });
  const rawArrayUpdates: ContextArrayUpdates = params.arrayUpdates ?? {};
  const arrayUpdates: ContextArrayUpdates = { ...rawArrayUpdates };
  if (rawArrayUpdates.constraints) {
    const r = sanitizeStringArray('arrayUpdates.constraints', rawArrayUpdates.constraints);
    sanitizedFields.push(...r.sanitizedFields);
    arrayUpdates.constraints = r.cleaned;
  }
  if (rawArrayUpdates.context_notes) {
    const r = sanitizeStringArray('arrayUpdates.context_notes', rawArrayUpdates.context_notes);
    sanitizedFields.push(...r.sanitizedFields);
    arrayUpdates.context_notes = r.cleaned;
  }

  if (!hasArrayUpdates(arrayUpdates) && fieldUpdates.length === 0) {
    return createError<CmosContextUpdateResult>({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'Manual mode requires arrayUpdates and/or fieldUpdates.',
      suggestion:
        'Provide arrayUpdates (decisions_made/learnings/constraints/context_notes) or fieldUpdates.',
    });
  }

  const contextResult = client.getOne<Context>(
    'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
    [contextType]
  );

  if (!contextResult.success) {
    return createError<CmosContextUpdateResult>({
      code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
      message: `Failed to load ${contextType}: ${contextResult.error?.message ?? 'Unknown error'}`,
      suggestion: 'Check database connectivity and schema.',
    });
  }

  let content: Record<string, unknown> = {};
  if (contextResult.data?.content) {
    try {
      content = JSON.parse(contextResult.data.content);
    } catch {
      return createError<CmosContextUpdateResult>({
        code: CMOS_ERROR_CODES.CONTEXT_PARSE_ERROR,
        message: `${contextType} content is not valid JSON.`,
        suggestion: 'Repair the stored context JSON before running manual updates.',
      });
    }
  }

  const originalSerialized = JSON.stringify(content);
  // decisions_made and learnings no longer stored in blob (Sprint 51 blob reduction).
  const constraintsAdded = appendUniqueArrayValues(
    content,
    'constraints',
    arrayUpdates.constraints
  );
  const contextNotesAdded = appendUniqueArrayValues(
    content,
    'context_notes',
    arrayUpdates.context_notes
  );

  const updatedPaths: string[] = [];
  for (const update of fieldUpdates) {
    const updateResult = applyNestedFieldUpdate(content, update.path, update.value);
    if (!updateResult.success) {
      return createError<CmosContextUpdateResult>({
        code: CMOS_ERROR_CODES.INVALID_PARAMETER,
        message: updateResult.message ?? 'Invalid field update path.',
        field: 'fieldUpdates.path',
        suggestion: updateResult.suggestion,
      });
    }
    if (updateResult.changed) {
      updatedPaths.push(update.path);
    }
  }

  const policy = getContextRetentionPolicy();
  const condensation = condenseContextForRetention(client, contextType, content, {
    source: `context_update:manual:${contextType}`,
    policy,
  });
  const sizeSettings = resolveContextSizeSettings(content, policy);
  upsertContextHealthMetadata(content, sizeSettings, policy.keepDetailSprints);

  const warnings = [...condensation.notes];
  const sizeWarning = buildContextSizeWarning(contextType, condensation.sizeAfter);
  if (sizeWarning) {
    warnings.push(sizeWarning);
  }

  const updatedSerialized = JSON.stringify(content);
  if (updatedSerialized === originalSerialized) {
    return createSuccess<CmosContextUpdateResult>(
      {
        mode: 'manual',
        contextType,
        sessionsProcessed: 0,
        decisionsAdded: 0,
        learningsAdded: 0,
        constraintsAdded: 0,
        totalItemsAdded: 0,
        snapshotId: null,
        archiveSnapshotId: null,
        archivedSprintIds: [],
        lastSessionTimestamp: null,
        contextSizeKb: condensation.sizeAfter.sizeKb,
        contextUsagePercent: condensation.sizeAfter.usagePercent,
        contextUpdated: false,
        fieldsUpdated: [],
        message: `${contextType} unchanged (no new array entries or field changes).`,
      },
      warnings,
      sanitizedFields
    );
  }

  const now = new Date().toISOString();
  if (contextResult.data) {
    const updateResult = client.execute(
      'UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?',
      [updatedSerialized, now, contextType]
    );

    if (!updateResult.success) {
      return createError<CmosContextUpdateResult>({
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to update ${contextType}: ${updateResult.error?.message ?? 'Unknown error'}`,
        suggestion: 'Check database permissions.',
      });
    }
  } else {
    const sourcePath =
      contextType === 'master_context'
        ? 'context/MASTER_CONTEXT.json'
        : 'context/PROJECT_CONTEXT.json';

    const insertResult = client.execute(
      'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
      [contextType, sourcePath, updatedSerialized, now]
    );

    if (!insertResult.success) {
      return createError<CmosContextUpdateResult>({
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to create ${contextType}: ${insertResult.error?.message ?? 'Unknown error'}`,
        suggestion: 'Check database permissions and schema.',
      });
    }
  }

  const snapshotResult = createSnapshot(
    client,
    contextType,
    updatedSerialized,
    `Context update: manual merge (${contextType})`
  );
  const snapshotId =
    snapshotResult.success && snapshotResult.snapshotId ? snapshotResult.snapshotId : null;

  const totalItemsAdded = constraintsAdded + contextNotesAdded + updatedPaths.length;

  return createSuccess<CmosContextUpdateResult>(
    {
      mode: 'manual',
      contextType,
      sessionsProcessed: 0,
      decisionsAdded: 0,
      learningsAdded: 0,
      constraintsAdded,
      totalItemsAdded,
      snapshotId,
      archiveSnapshotId: condensation.archiveSnapshotId,
      archivedSprintIds: condensation.archivedSprintIds,
      lastSessionTimestamp: null,
      contextSizeKb: condensation.sizeAfter.sizeKb,
      contextUsagePercent: condensation.sizeAfter.usagePercent,
      contextUpdated: true,
      fieldsUpdated: updatedPaths,
      message:
        `${contextType} updated: ${totalItemsAdded} merged change(s)` +
        ` (${constraintsAdded} constraints, ${contextNotesAdded} context_notes, ${updatedPaths.length} field updates).`,
    },
    warnings,
    sanitizedFields
  );
}

/**
 * Aggregate captures from sessions.
 * Only constraints are collected — decisions and learnings are no longer blob-backed
 * (Sprint 51 blob reduction: they live in strategic_decisions and learnings tables).
 */
function aggregateCapturesFromSessions(sessions: SessionWithCaptures[]): AggregatedItems {
  const aggregated: AggregatedItems = { constraints: [] };

  for (const session of sessions) {
    if (!session.captures) continue;

    try {
      const captures = JSON.parse(session.captures);
      if (!Array.isArray(captures)) continue;

      for (const capture of captures) {
        if (!capture || typeof capture !== 'object') continue;

        const item = capture as CaptureItem;
        const content = item.content || (typeof capture === 'string' ? capture : null);

        if (!content) continue;

        if (item.category === 'constraint') {
          aggregated.constraints.push(content);
        }
      }
    } catch {
      // Skip malformed captures
    }
  }

  return aggregated;
}

/**
 * Update master_context with aggregated items.
 *
 * decisions and learnings are no longer stored in the blob (Sprint 51 blob reduction).
 * They are queryable from strategic_decisions and learnings tables via HybridRetriever.
 * Only constraints remain blob-backed (low-volume, no dedicated table yet).
 */
function updateMasterContext(
  content: Record<string, unknown>,
  aggregated: AggregatedItems
): Record<string, unknown> {
  if (!Array.isArray(content.constraints)) {
    content.constraints = [];
  }

  const existingConstraints = new Set(content.constraints as string[]);

  for (const constraint of aggregated.constraints) {
    if (!existingConstraints.has(constraint)) {
      (content.constraints as string[]).push(constraint);
      existingConstraints.add(constraint);
    }
  }

  return content;
}

function hasArrayUpdates(updates: ContextArrayUpdates): boolean {
  return Boolean(updates.constraints?.length || updates.context_notes?.length);
}

function appendUniqueArrayValues(
  content: Record<string, unknown>,
  key: keyof ContextArrayUpdates,
  values?: string[]
): number {
  if (!values || values.length === 0) {
    return 0;
  }

  if (!Array.isArray(content[key])) {
    content[key] = [];
  }

  const target = content[key] as string[];
  const existing = new Set(target);
  let added = 0;

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || existing.has(normalized)) {
      continue;
    }
    target.push(normalized);
    existing.add(normalized);
    added += 1;
  }

  return added;
}

function applyNestedFieldUpdate(
  content: Record<string, unknown>,
  pathExpression: string,
  value: unknown
): { success: boolean; changed: boolean; message?: string; suggestion?: string } {
  const trimmedPath = pathExpression.trim();
  if (!trimmedPath) {
    return {
      success: false,
      changed: false,
      message: 'fieldUpdates.path cannot be empty.',
      suggestion: 'Use dot notation like technical_foundation.stack.',
    };
  }

  const segments = trimmedPath.split('.').map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    return {
      success: false,
      changed: false,
      message: `Invalid field path '${pathExpression}'.`,
      suggestion: 'Use dot notation with non-empty segments (example: project_identity.status).',
    };
  }

  if (segments.some((segment) => !isSafePathSegment(segment))) {
    return {
      success: false,
      changed: false,
      message: `Unsafe field path '${pathExpression}'.`,
      suggestion: 'Avoid reserved object prototype keys in field paths.',
    };
  }

  let cursor: Record<string, unknown> = content;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = cursor[segment];
    if (existing === undefined) {
      cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
      continue;
    }

    if (!isPlainObject(existing)) {
      return {
        success: false,
        changed: false,
        message: `Cannot update '${pathExpression}': '${segments.slice(0, i + 1).join('.')}' is not an object.`,
        suggestion: 'Choose a path where each parent segment resolves to an object.',
      };
    }

    cursor = existing;
  }

  const leafKey = segments[segments.length - 1];
  const previousValue = cursor[leafKey];

  if (isPlainObject(previousValue) && isPlainObject(value)) {
    const merged = deepMerge(previousValue, value);
    const changed = JSON.stringify(previousValue) !== JSON.stringify(merged);
    cursor[leafKey] = merged;
    return { success: true, changed };
  }

  const changed = JSON.stringify(previousValue) !== JSON.stringify(value);
  cursor[leafKey] = value;
  return { success: true, changed };
}

function isSafePathSegment(segment: string): boolean {
  return segment !== '__proto__' && segment !== 'constructor' && segment !== 'prototype';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
      continue;
    }
    result[key] = sourceValue;
  }

  return result;
}

function upsertContextHealthMetadata(
  content: Record<string, unknown>,
  sizeSettings: { limitKb: number; warningThresholdPercent: number },
  keepDetailSprints: number
): void {
  const contextHealth = isPlainObject(content.context_health) ? content.context_health : {};
  const serialized = JSON.stringify(content);
  const sizeKb = Math.round((Buffer.byteLength(serialized, 'utf8') / 1024) * 100) / 100;

  contextHealth['size_kb'] = sizeKb;
  contextHealth['size_limit_kb'] = sizeSettings.limitKb;
  contextHealth['warning_threshold_percent'] = sizeSettings.warningThresholdPercent;
  contextHealth['retention_keep_sprints'] = keepDetailSprints;
  contextHealth['last_update'] =
    typeof contextHealth['last_update'] === 'string'
      ? contextHealth['last_update']
      : new Date().toISOString();

  content.context_health = contextHealth;
}

/**
 * Create a snapshot of the context.
 */
function createSnapshot(
  client: CmosDatabaseClient,
  contextId: string,
  content: string,
  source: string
): { success: boolean; snapshotId?: number } {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const now = new Date().toISOString();

  // Check for duplicate
  const existingResult = client.getOne<{ id: number }>(
    'SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?',
    [contextId, contentHash]
  );

  if (existingResult.success && existingResult.data) {
    return { success: true, snapshotId: existingResult.data.id };
  }

  // Create new snapshot
  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextId, source, contentHash, content, now, ...g.values]
  );

  if (!insertResult.success) {
    return { success: false };
  }

  return { success: true, snapshotId: Number(insertResult.data?.lastInsertRowid) };
}

/**
 * Format context update result for LLM readability.
 *
 * @param result - Update result
 * @returns Human-readable summary
 */
export function formatContextUpdateForLLM(result: CmosToolResult<CmosContextUpdateResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to update context',
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

  if (!data.contextUpdated) {
    return [
      '📝 **Context Update**',
      '',
      `Sessions processed: ${data.sessionsProcessed}`,
      '',
      data.message,
    ].join('\n');
  }

  const lines = [
    '✓ **Context Updated**',
    '',
    `**Mode**: ${data.mode ?? 'aggregate'}`,
    `**Context**: ${data.contextType ?? 'master_context'}`,
    '',
    `**Sessions processed**: ${data.sessionsProcessed}`,
    '',
    '**Items aggregated**:',
    `  • Decisions: ${data.decisionsAdded}`,
    `  • Learnings: ${data.learningsAdded}`,
    `  • Constraints: ${data.constraintsAdded}`,
    `  • Total: ${data.totalItemsAdded}`,
  ];

  if (data.snapshotId) {
    lines.push('');
    lines.push(`**Snapshot**: #${data.snapshotId}`);
  }

  if (data.lastSessionTimestamp) {
    lines.push('');
    lines.push(`**Last session**: ${data.lastSessionTimestamp}`);
  }

  if (data.fieldsUpdated && data.fieldsUpdated.length > 0) {
    lines.push('');
    lines.push(`**Fields updated**: ${data.fieldsUpdated.join(', ')}`);
  }

  return lines.join('\n');
}
