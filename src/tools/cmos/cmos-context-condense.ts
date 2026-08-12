/**
 * cmos_context_condense Tool
 *
 * MCP tool for automatically reducing context size while preserving
 * semantic value. Addresses monotonic context growth where master_context
 * grows indefinitely with no automated reduction mechanism.
 *
 * Three strategy levels:
 * - conservative: Only removes old entries, trims summaries
 * - auto (default): Conservative + deduplication + sprint-level collapse
 * - aggressive: Auto + removes old sprint detail + limits decisions
 *
 * @module tools/cmos/cmos-context-condense
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import { withClientValidated, type CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import { snapshotDedupPrunedFilter } from './schema-migrations';
import type { CmosToolResult, Context } from './types';
import { createError, createSuccess, CMOS_ERROR_CODES } from './errors';
import {
  calculateContextSizeMetrics,
  resolveContextSizeSettings,
  type ContextSizeMetrics,
} from './context-retention';
import { appendWarnings } from './format-warnings';

/**
 * Per-section condensation detail.
 */
export interface SectionCondensation {
  section: string;
  beforeBytes: number;
  afterBytes: number;
  action: string;
  preview?: string[];
}

/**
 * Result of context condense operation.
 */
export interface CmosContextCondenseResult {
  /** Size before condensation */
  beforeSize: ContextSizeMetrics;

  /** Size after condensation (same as before in dryRun) */
  afterSize: ContextSizeMetrics;

  /** Reduction percentage */
  reductionPercent: number;

  /** Target size in KB derived from targetSizePercent */
  targetSizeKb: number;

  /** Target percentage requested by the caller */
  targetSizePercent: number;

  /** Whether the target was met after condensation */
  targetMet: boolean;

  /** Per-section breakdown */
  sectionsCondensed: SectionCondensation[];

  /** Snapshot ID from auto-snapshot (null in dryRun) */
  snapshotId: number | null;

  /** Strategy used */
  strategy: 'conservative' | 'auto' | 'aggressive';

  /** Whether this was a dry run */
  dryRun: boolean;

  /** Context type condensed */
  contextType: 'master_context' | 'project_context';

  /** Summary message */
  message: string;
}

/**
 * Input parameters schema for cmos_context_condense tool.
 */
export const cmosContextCondenseSchema = z.object({
  contextType: z.enum(['master_context', 'project_context']).describe('Which context to condense'),

  targetSizePercent: z
    .number()
    .min(1)
    .max(100)
    .default(60)
    .describe('Target percentage of the 100KB limit (default: 60)'),

  strategy: z
    .enum(['conservative', 'auto', 'aggressive'])
    .default('auto')
    .describe(
      'Condensation strategy: conservative (old entries only), auto (conservative + dedup + collapse), aggressive (auto + remove old sprint detail + limit decisions)'
    ),

  dryRun: z.boolean().default(false).describe('Preview changes without applying (default: false)'),

  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosContextCondenseParams = z.infer<typeof cmosContextCondenseSchema>;

/**
 * MCP Tool Definition for cmos_context_condense.
 */
export const cmosContextCondenseToolDefinition = {
  name: 'cmos_context_condense',
  description:
    'Automatically reduce context size while preserving semantic value. Supports three strategies: conservative (remove stale next_steps), auto (conservative + prune session_history), aggressive (auto + limit context_notes + archived_sprint_summaries + clear table-backed constraints). Use dryRun=true to preview changes.',
  inputSchema: {
    type: 'object',
    properties: {
      contextType: {
        type: 'string',
        enum: ['master_context', 'project_context'],
        description: 'Which context to condense',
      },
      targetSizePercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 60,
        description: 'Target percentage of the 100KB limit (default: 60)',
      },
      strategy: {
        type: 'string',
        enum: ['conservative', 'auto', 'aggressive'],
        default: 'auto',
        description: 'Condensation strategy: conservative, auto (default), or aggressive',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Preview changes without applying (default: false)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['contextType'],
    additionalProperties: false,
  },
} as const;

const AUTO_SESSION_HISTORY_LIMIT = 5;
const AGGRESSIVE_MAX_CONTEXT_NOTES = 15;
const AGGRESSIVE_MAX_ARCHIVED_SUMMARIES = 5;

/**
 * Execute the cmos_context_condense tool.
 */
export async function cmosContextCondense(
  params: CmosContextCondenseParams
): Promise<CmosToolResult<CmosContextCondenseResult>> {
  return withClientValidated(
    (client) => {
      const contextType = params.contextType;
      const strategy = params.strategy ?? 'auto';
      const dryRun = params.dryRun ?? false;
      const targetSizePercent = params.targetSizePercent ?? 60;

      // Load context
      const contextResult = client.getOne<Context>(
        'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
        [contextType]
      );

      if (!contextResult.success || !contextResult.data) {
        return createError<CmosContextCondenseResult>({
          code: CMOS_ERROR_CODES.CONTEXT_NOT_FOUND,
          message: `Context '${contextType}' not found`,
          suggestion: 'Use cmos_context(action="view") to check available contexts',
        });
      }

      let content: Record<string, unknown>;
      try {
        const parsed = JSON.parse(contextResult.data.content);
        if (!isPlainObject(parsed)) {
          return createError<CmosContextCondenseResult>({
            code: CMOS_ERROR_CODES.CONTEXT_PARSE_ERROR,
            message: `${contextType} content must be a JSON object`,
            suggestion:
              'Repair the stored context JSON so it serializes to an object before condensing',
            phase: 'parse_context',
            operation: 'JSON.parse(context.content)',
            details: `Parsed value shape: ${describeValueShape(parsed)}`,
          });
        }
        content = parsed;
      } catch {
        return createError<CmosContextCondenseResult>({
          code: CMOS_ERROR_CODES.CONTEXT_PARSE_ERROR,
          message: `${contextType} content is not valid JSON`,
          suggestion: 'Repair the stored context JSON before condensing',
        });
      }

      const sizeSettings = resolveContextSizeSettings(content);
      const beforeSize = calculateContextSizeMetrics(contextResult.data.content, sizeSettings);
      const sectionsCondensed: SectionCondensation[] = [];
      const targetSizeKb = roundNumber((sizeSettings.limitKb * targetSizePercent) / 100);
      const shouldEnforceTarget = beforeSize.sizeKb > targetSizeKb;

      // Get completed mission IDs for stale next_steps cleanup
      const completedMissionIds = getCompletedMissionIds(client);

      // Common to all strategies: remove stale next_steps referencing completed missions
      const commonCleanupError = runCondensationPhase(
        {
          contextType,
          strategy,
          phase: 'common_cleanup',
          operation: 'applyCommonCleanup',
          content,
          section: 'recent_sessions',
        },
        () => applyCommonCleanup(content, completedMissionIds, sectionsCondensed)
      );
      if (commonCleanupError) {
        return commonCleanupError;
      }

      if (
        (strategy === 'auto' || strategy === 'aggressive') &&
        shouldContinueCondensing(shouldEnforceTarget, content, sizeSettings, targetSizeKb)
      ) {
        // Prune session_history to last N entries
        const pruneError = runCondensationPhase(
          {
            contextType,
            strategy,
            phase: 'prune_session_history',
            operation: 'pruneSessionHistory',
            content,
            section: 'working_memory.session_history',
          },
          () => pruneSessionHistory(content, sectionsCondensed)
        );
        if (pruneError) {
          return pruneError;
        }
      }

      // ── Extended aggressive rules ──

      if (
        strategy === 'aggressive' &&
        shouldContinueCondensing(shouldEnforceTarget, content, sizeSettings, targetSizeKb)
      ) {
        runCondensationPhase(
          {
            contextType,
            strategy,
            phase: 'aggressive_context_notes',
            operation: 'limitContextNotes',
            content,
            section: 'context_notes',
          },
          () =>
            limitArraySection(
              content,
              'context_notes',
              AGGRESSIVE_MAX_CONTEXT_NOTES,
              sectionsCondensed
            )
        );
      }

      if (
        strategy === 'aggressive' &&
        shouldContinueCondensing(shouldEnforceTarget, content, sizeSettings, targetSizeKb)
      ) {
        runCondensationPhase(
          {
            contextType,
            strategy,
            phase: 'aggressive_archived_summaries',
            operation: 'limitArchivedSummaries',
            content,
            section: 'archived_sprint_summaries',
          },
          () =>
            limitArraySection(
              content,
              'archived_sprint_summaries',
              AGGRESSIVE_MAX_ARCHIVED_SUMMARIES,
              sectionsCondensed
            )
        );
      }

      if (
        strategy === 'aggressive' &&
        shouldContinueCondensing(shouldEnforceTarget, content, sizeSettings, targetSizeKb)
      ) {
        // Trim constraints from JSON if they exist in the structured table
        runCondensationPhase(
          {
            contextType,
            strategy,
            phase: 'aggressive_constraints_cleanup',
            operation: 'removeTableBackedConstraints',
            content,
            section: 'constraints',
          },
          () => removeTableBackedConstraints(client, content, sectionsCondensed)
        );
      }

      let updatedSerialized = '';
      const serializationError = runCondensationPhase(
        {
          contextType,
          strategy,
          phase: 'serialize_context',
          operation: 'JSON.stringify(updated content)',
          content,
        },
        () => {
          updatedSerialized = JSON.stringify(content);
        }
      );
      if (serializationError) {
        return serializationError;
      }

      const afterSize = calculateContextSizeMetrics(updatedSerialized, sizeSettings);
      const targetMet = afterSize.sizeKb <= targetSizeKb;
      const reductionPercent =
        beforeSize.sizeBytes > 0
          ? Math.round(
              ((beforeSize.sizeBytes - afterSize.sizeBytes) / beforeSize.sizeBytes) * 10000
            ) / 100
          : 0;
      const warnings: string[] = [];

      if (shouldEnforceTarget && !targetMet) {
        warnings.push(
          `${contextType} remains above target size (${afterSize.sizeKb.toFixed(2)}KB > ${targetSizeKb.toFixed(2)}KB) after exhausting ${strategy} strategy rules.`
        );
      }

      if (dryRun) {
        return createSuccess<CmosContextCondenseResult>(
          {
            beforeSize,
            afterSize,
            reductionPercent,
            targetSizeKb,
            targetSizePercent,
            targetMet,
            sectionsCondensed,
            snapshotId: null,
            strategy,
            dryRun: true,
            contextType,
            message: buildCondenseSummaryMessage({
              dryRun: true,
              contextType,
              beforeSizeKb: beforeSize.sizeKb,
              afterSizeKb: afterSize.sizeKb,
              reductionPercent,
              strategy,
              targetSizeKb,
              targetMet,
            }),
          },
          warnings
        );
      }

      // No changes needed
      if (updatedSerialized === contextResult.data.content) {
        return createSuccess<CmosContextCondenseResult>(
          {
            beforeSize,
            afterSize: beforeSize,
            reductionPercent: 0,
            targetSizeKb,
            targetSizePercent,
            targetMet: beforeSize.sizeKb <= targetSizeKb,
            sectionsCondensed: [],
            snapshotId: null,
            strategy,
            dryRun: false,
            contextType,
            message: `${contextType} already within target size or no condensable content found`,
          },
          warnings
        );
      }

      // Create auto-snapshot before mutation
      const snapshotId = createAutoSnapshot(
        client,
        contextType,
        contextResult.data.content,
        `context_condense:${strategy}`
      );

      // Write condensed content
      const now = new Date().toISOString();
      const writeResult = client.execute(
        'UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?',
        [updatedSerialized, now, contextType]
      );

      if (!writeResult.success) {
        return createError<CmosContextCondenseResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to write condensed ${contextType}: ${writeResult.error?.message ?? 'Unknown error'}`,
          suggestion: 'Check database permissions',
        });
      }

      return createSuccess<CmosContextCondenseResult>(
        {
          beforeSize,
          afterSize,
          reductionPercent,
          targetSizeKb,
          targetSizePercent,
          targetMet,
          sectionsCondensed,
          snapshotId,
          strategy,
          dryRun: false,
          contextType,
          message: buildCondenseSummaryMessage({
            dryRun: false,
            contextType,
            beforeSizeKb: beforeSize.sizeKb,
            afterSizeKb: afterSize.sizeKb,
            reductionPercent,
            strategy,
            targetSizeKb,
            targetMet,
          }),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Common cleanup shared by all strategies:
 * - Remove stale next_steps referencing completed missions
 */
function applyCommonCleanup(
  content: Record<string, unknown>,
  completedMissionIds: Set<string>,
  sections: SectionCondensation[]
): void {
  // Remove stale next_steps referencing completed missions
  removeStaleNextSteps(content, completedMissionIds, sections);

  // Also handle project_context working_memory.next_steps
  const workingMemory = content['working_memory'];
  if (isPlainObject(workingMemory)) {
    const wm = workingMemory as Record<string, unknown>;
    removeStaleNextStepsFromArray(
      wm,
      'next_steps',
      completedMissionIds,
      sections,
      'working_memory.next_steps'
    );
  }

  // Handle next_session_context.when_we_resume for master_context
  const nextSession = content['next_session_context'];
  if (isPlainObject(nextSession)) {
    const ns = nextSession as Record<string, unknown>;
    removeStaleNextStepsFromArray(
      ns,
      'when_we_resume',
      completedMissionIds,
      sections,
      'next_session_context.when_we_resume'
    );
  }
}

/**
 * Prune working_memory.session_history to last N entries.
 */
function pruneSessionHistory(
  content: Record<string, unknown>,
  sections: SectionCondensation[]
): void {
  const workingMemory = content['working_memory'];
  if (!isPlainObject(workingMemory)) return;

  const wm = workingMemory as Record<string, unknown>;
  if (!Array.isArray(wm['session_history'])) return;

  const history = wm['session_history'] as unknown[];
  if (history.length > AUTO_SESSION_HISTORY_LIMIT) {
    const before = JSON.stringify(history).length;
    const preview = history
      .slice(0, history.length - AUTO_SESSION_HISTORY_LIMIT)
      .map((entry) => truncatePreview(describeSessionHistoryEntry(entry)))
      .slice(0, 3);
    wm['session_history'] = history.slice(-AUTO_SESSION_HISTORY_LIMIT);
    const after = JSON.stringify(wm['session_history']).length;
    sections.push({
      section: 'working_memory.session_history',
      beforeBytes: before,
      afterBytes: after,
      action: `Pruned to last ${AUTO_SESSION_HISTORY_LIMIT} entries`,
      preview,
    });
  }
}

// --- Helpers ---

function removeStaleNextSteps(
  content: Record<string, unknown>,
  completedMissionIds: Set<string>,
  sections: SectionCondensation[]
): void {
  if (!Array.isArray(content['next_steps'])) return;

  const before = JSON.stringify(content['next_steps']).length;
  const steps = content['next_steps'] as unknown[];
  content['next_steps'] = steps.filter((step) => {
    const str = typeof step === 'string' ? step : null;
    if (!str) return true;
    // Check if step references a completed mission ID
    for (const missionId of completedMissionIds) {
      if (str.includes(missionId)) return false;
    }
    return true;
  });
  const after = JSON.stringify(content['next_steps']).length;
  if (before !== after) {
    sections.push({
      section: 'next_steps',
      beforeBytes: before,
      afterBytes: after,
      action: 'Removed steps referencing completed missions',
    });
  }
}

function removeStaleNextStepsFromArray(
  parent: Record<string, unknown>,
  key: string,
  completedMissionIds: Set<string>,
  sections: SectionCondensation[],
  sectionLabel: string
): void {
  if (!Array.isArray(parent[key])) return;

  const before = JSON.stringify(parent[key]).length;
  const steps = parent[key] as unknown[];
  parent[key] = steps.filter((step) => {
    const str = typeof step === 'string' ? step : null;
    if (!str) return true;
    for (const missionId of completedMissionIds) {
      if (str.includes(missionId)) return false;
    }
    return true;
  });
  const after = JSON.stringify(parent[key]).length;
  if (before !== after) {
    sections.push({
      section: sectionLabel,
      beforeBytes: before,
      afterBytes: after,
      action: 'Removed steps referencing completed missions',
    });
  }
}

function getCompletedMissionIds(client: CmosDatabaseClient): Set<string> {
  const result = client.getMany<{ id: string }>(
    `SELECT id FROM missions WHERE status = 'Completed'`,
    []
  );
  return new Set(result.success && result.data ? result.data.map((r) => r.id) : []);
}

function createAutoSnapshot(
  client: CmosDatabaseClient,
  contextId: string,
  content: string,
  source: string
): number | null {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const now = new Date().toISOString();

  // Check for duplicate. s84-m04: exclude a content-tombstoned row so identical content
  // re-persists fresh instead of deduping onto the emptied row.
  const existing = client.getOne<{ id: number }>(
    `SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}`,
    [contextId, contentHash]
  );
  if (existing.success && existing.data) {
    return existing.data.id;
  }

  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextId, source, contentHash, content, now, ...g.values]
  );

  if (!insertResult.success) return null;
  return Number(insertResult.data?.lastInsertRowid);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function runCondensationPhase(
  options: {
    contextType: 'master_context' | 'project_context';
    strategy: 'conservative' | 'auto' | 'aggressive';
    phase: string;
    operation: string;
    content: Record<string, unknown>;
    section?: string;
  },
  run: () => void
): CmosToolResult<CmosContextCondenseResult> | null {
  try {
    run();
    return null;
  } catch (error) {
    const detailParts = [
      `Cause: ${error instanceof Error ? error.message : String(error ?? 'Unknown error')}`,
    ];

    if (options.section) {
      detailParts.push(
        `Section '${options.section}' shape: ${describeValueShape(getValueAtPath(options.content, options.section))}`
      );
    }

    return createError<CmosContextCondenseResult>({
      code: CMOS_ERROR_CODES.CONTEXT_CONDENSATION_FAILED,
      message: `Failed to condense ${options.contextType} during ${options.phase}`,
      suggestion:
        options.strategy === 'conservative'
          ? 'Repair the malformed context data described in the details and retry condensation.'
          : "Repair the malformed context data described in the details and retry. If you need a narrower pass, retry with strategy='conservative'.",
      phase: options.phase,
      operation: options.operation,
      details: detailParts.join(' '),
    });
  }
}

function getValueAtPath(root: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = root;

  for (const segment of segments) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function describeValueShape(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    const sampleTypes = Array.from(
      new Set(value.slice(0, 5).map((entry) => describeSampleType(entry)))
    );
    return `array(length=${value.length}, sampleTypes=${sampleTypes.join(', ') || 'unknown'})`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).slice(0, 5);
    return `object(keys=${keys.join(', ') || 'none'})`;
  }

  return typeof value;
}

function describeSampleType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return isPlainObject(value) ? 'object' : typeof value;
}

/**
 * Limit an array section to the last N entries.
 * Generic helper for context_notes, learnings, archived_sprint_summaries, etc.
 */
function limitArraySection(
  content: Record<string, unknown>,
  key: string,
  maxEntries: number,
  sections: SectionCondensation[]
): void {
  if (!Array.isArray(content[key])) return;
  const arr = content[key] as unknown[];
  if (arr.length <= maxEntries) return;

  const before = JSON.stringify(arr).length;
  content[key] = arr.slice(-maxEntries);
  const after = JSON.stringify(content[key]).length;
  sections.push({
    section: key,
    beforeBytes: before,
    afterBytes: after,
    action: `Limited to last ${maxEntries} entries (was ${arr.length})`,
  });
}

/**
 * Remove constraints from the JSON blob that are backed by the constraints table.
 * Since constraints are now extracted to a structured table, the JSON copy is
 * redundant and can be safely removed during aggressive condensation.
 */
function removeTableBackedConstraints(
  client: CmosDatabaseClient,
  content: Record<string, unknown>,
  sections: SectionCondensation[]
): void {
  if (!Array.isArray(content['constraints'])) return;
  const arr = content['constraints'] as unknown[];
  if (arr.length === 0) return;

  // Check if the constraints table exists
  const tableCheck = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='constraints'",
    []
  );
  if (!tableCheck.success || !tableCheck.data) return;

  // Count active constraints in table
  const countResult = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM constraints WHERE status = 'active'",
    []
  );
  const tableCount = countResult.success && countResult.data ? countResult.data.count : 0;

  // If the table has constraints, we can safely remove the JSON copy
  if (tableCount > 0) {
    const before = JSON.stringify(arr).length;
    content['constraints'] = [];
    const after = 2; // '[]'
    sections.push({
      section: 'constraints',
      beforeBytes: before,
      afterBytes: after,
      action: `Cleared JSON constraints (${arr.length} entries) — backed by constraints table (${tableCount} active)`,
    });
  }
}

function shouldContinueCondensing(
  enforceTarget: boolean,
  content: Record<string, unknown>,
  sizeSettings: ReturnType<typeof resolveContextSizeSettings>,
  targetSizeKb: number
): boolean {
  if (!enforceTarget) {
    return true;
  }

  return calculateContextSizeMetrics(content, sizeSettings).sizeKb > targetSizeKb;
}

function buildCondenseSummaryMessage(options: {
  dryRun: boolean;
  contextType: 'master_context' | 'project_context';
  beforeSizeKb: number;
  afterSizeKb: number;
  reductionPercent: number;
  strategy: 'conservative' | 'auto' | 'aggressive';
  targetSizeKb: number;
  targetMet: boolean;
}): string {
  const prefix = options.dryRun ? 'Dry run: would reduce' : 'Condensed';
  const targetSummary = options.targetMet
    ? `Target ${options.targetSizeKb.toFixed(2)}KB met.`
    : `Target ${options.targetSizeKb.toFixed(2)}KB not met; available ${options.strategy} rules were exhausted.`;

  return `${prefix} ${options.contextType} from ${options.beforeSizeKb.toFixed(2)}KB to ${options.afterSizeKb.toFixed(2)}KB (${options.reductionPercent}% reduction) using ${options.strategy} strategy. ${targetSummary}`;
}

function describeSessionHistoryEntry(entry: unknown): string {
  if (!isPlainObject(entry)) {
    return describeValueShape(entry);
  }

  return (
    asString(entry['summary']) ||
    asString(entry['session']) ||
    asString(entry['mission']) ||
    asString(entry['action']) ||
    'session history entry'
  );
}

function truncatePreview(value: string, maxLength = 80): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Format context condense result for LLM readability.
 */
export function formatContextCondenseForLLM(
  result: CmosToolResult<CmosContextCondenseResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['Failed to condense context', '', `Error: ${error?.message ?? 'Unknown error'}`];
    if (error?.phase) {
      lines.push(`Phase: ${error.phase}`);
    }
    if (error?.operation) {
      lines.push(`Operation: ${error.operation}`);
    }
    if (error?.details) {
      lines.push(`Details: ${error.details}`);
    }
    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const data = result.data;
  const prefix = data.dryRun ? '[DRY RUN] ' : '';
  const lines = [
    `${prefix}**Context Condense** (${data.strategy})`,
    '',
    `**Context**: ${data.contextType}`,
    `**Before**: ${data.beforeSize.sizeKb.toFixed(2)}KB (${data.beforeSize.usagePercent.toFixed(1)}%)`,
    `**After**: ${data.afterSize.sizeKb.toFixed(2)}KB (${data.afterSize.usagePercent.toFixed(1)}%)`,
    `**Reduction**: ${data.reductionPercent}%`,
  ];

  if (data.snapshotId) {
    lines.push(`**Snapshot**: #${data.snapshotId}`);
  }
  lines.push(`**Target**: ${data.targetSizeKb.toFixed(2)}KB (${data.targetSizePercent}%)`);
  lines.push(`**Target Met**: ${data.targetMet ? 'yes' : 'no'}`);

  if (data.sectionsCondensed.length > 0) {
    lines.push('');
    lines.push('**Sections condensed**:');
    for (const s of data.sectionsCondensed) {
      const saved = s.beforeBytes - s.afterBytes;
      lines.push(`  - ${s.section}: ${s.action} (-${saved} bytes)`);
      if (s.preview && s.preview.length > 0) {
        for (const preview of s.preview) {
          lines.push(`    Preview: ${preview}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(data.message);

  appendWarnings(lines, result);

  return lines.join('\n');
}
