/**
 * cmos_context_snapshot Tool
 *
 * MCP tool for taking strategic snapshots of CMOS contexts.
 * Creates entry in context_snapshots table with timestamp.
 * Use for sprint completions, major decisions, and strategic milestones.
 *
 * @module tools/cmos/cmos-context-snapshot
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import { withClientValidated } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import { snapshotDedupPrunedFilter } from './schema-migrations';
import type { CmosToolResult, Context } from './types';
import { CmosErrors, createError, createSuccess, CMOS_ERROR_CODES } from './errors';

/**
 * Result of context snapshot operation.
 */
export interface CmosContextSnapshotResult {
  /** Snapshot ID in the database */
  snapshotId: number;

  /** Context ID that was snapshotted */
  contextId: string;

  /** Source description provided for the snapshot */
  source: string;

  /** SHA-256 hash of the content */
  contentHash: string;

  /** Timestamp when snapshot was created */
  createdAt: string;

  /** Whether this is a new snapshot (vs duplicate detected) */
  isNew: boolean;

  /** Message describing the result */
  message: string;
}

/**
 * Input parameters schema for cmos_context_snapshot tool.
 */
export const cmosContextSnapshotSchema = z.object({
  /** Context type to snapshot */
  contextType: z
    .enum(['master_context', 'project_context'])
    .describe(
      'Which context to snapshot: master_context (strategic memory) or project_context (session state)'
    ),

  /** Descriptive source/reason for the snapshot */
  source: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Descriptive label for why this snapshot was taken (e.g., "Sprint 12 completed", "Architecture decision: chose PostgreSQL")'
    ),

  /** Optional session ID to associate with this snapshot */
  sessionId: z.string().optional().describe('Optional session ID to associate this snapshot with'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosContextSnapshotParams = z.infer<typeof cmosContextSnapshotSchema>;

/**
 * MCP Tool Definition for cmos_context_snapshot.
 */
export const cmosContextSnapshotToolDefinition = {
  name: 'cmos_context_snapshot',
  description:
    'Take a strategic snapshot of a CMOS context. Creates an entry in context_snapshots table with timestamp. Use after sprint completions, major architectural decisions, or strategic milestones to preserve context history.',
  inputSchema: {
    type: 'object',
    properties: {
      contextType: {
        type: 'string',
        enum: ['master_context', 'project_context'],
        description:
          'Which context to snapshot: master_context (strategic memory) or project_context (session state)',
      },
      source: {
        type: 'string',
        description:
          'Descriptive label for why this snapshot was taken (e.g., "Sprint 12 completed")',
        minLength: 1,
        maxLength: 500,
      },
      sessionId: {
        type: 'string',
        description: 'Optional session ID to associate this snapshot with',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['contextType', 'source'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_context_snapshot tool.
 *
 * Creates a snapshot of the specified context in the context_snapshots table.
 * Includes duplicate detection via content hash to avoid redundant snapshots.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with snapshot info or actionable error
 */
export async function cmosContextSnapshot(
  params: CmosContextSnapshotParams
): Promise<CmosToolResult<CmosContextSnapshotResult>> {
  // Validate required parameters
  if (!params.source || params.source.trim() === '') {
    return createError(CmosErrors.missingParameter('source'));
  }

  const contextType = params.contextType;
  const source = params.source.trim();

  return withClientValidated(
    (client) => {
      // Get the current context content
      const contextResult = client.getOne<Context>(
        'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
        [contextType]
      );

      if (!contextResult.success) {
        return createError<CmosContextSnapshotResult>(
          contextResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query context' }
        );
      }

      if (!contextResult.data) {
        return createError<CmosContextSnapshotResult>(CmosErrors.contextNotFound(contextType));
      }

      const context = contextResult.data;
      const content = context.content;

      // Calculate content hash for duplicate detection
      const contentHash = crypto
        .createHash('sha256')
        .update(content)
        .digest('hex')
        .substring(0, 16);

      // Check if we already have a snapshot with the same hash. s84-m04: exclude a
      // content-tombstoned row (content emptied by the prune) so a re-appearing identical
      // content forces a fresh content-bearing insert instead of deduping onto the empty row.
      const existingResult = client.getOne<{ id: number; created_at: string }>(
        `SELECT id, created_at FROM context_snapshots WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}`,
        [contextType, contentHash]
      );

      if (existingResult.success && existingResult.data) {
        // Duplicate detected - return existing snapshot info
        return createSuccess<CmosContextSnapshotResult>({
          snapshotId: existingResult.data.id,
          contextId: contextType,
          source,
          contentHash,
          createdAt: existingResult.data.created_at,
          isNew: false,
          message: `Duplicate snapshot detected. Content unchanged since ${existingResult.data.created_at}. No new snapshot created.`,
        });
      }

      // Create new snapshot
      const now = new Date().toISOString();

      const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
      const insertResult = client.execute(
        `INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
        [contextType, params.sessionId ?? null, source, contentHash, content, now, ...g.values]
      );

      if (!insertResult.success) {
        return createError<CmosContextSnapshotResult>({
          code: CMOS_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
          message: `Failed to create snapshot: ${insertResult.error?.message ?? 'Unknown error'}`,
          suggestion: 'Check database permissions and schema integrity',
        });
      }

      const snapshotId = Number(insertResult.data?.lastInsertRowid);

      return createSuccess<CmosContextSnapshotResult>({
        snapshotId,
        contextId: contextType,
        source,
        contentHash,
        createdAt: now,
        isNew: true,
        message: `Snapshot created for ${contextType}: "${source}"`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format context snapshot result for LLM readability.
 *
 * @param result - Snapshot result
 * @returns Human-readable summary
 */
export function formatContextSnapshotForLLM(
  result: CmosToolResult<CmosContextSnapshotResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to create context snapshot',
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
  const icon = data.isNew ? '📸' : '🔄';
  const status = data.isNew ? 'created' : 'duplicate detected';

  const lines = [
    `${icon} **Context Snapshot ${status}**`,
    '',
    `**Context**: ${data.contextId}`,
    `**Source**: ${data.source}`,
    `**Snapshot ID**: ${data.snapshotId}`,
    `**Created**: ${data.createdAt}`,
    `**Content Hash**: ${data.contentHash}`,
    '',
    data.message,
  ];

  return lines.join('\n');
}
