/**
 * cmos_context_history Tool
 *
 * MCP tool for viewing the context snapshot timeline.
 * Returns paginated list of snapshots for a given context type.
 * Supports filtering by date range and session ID.
 *
 * @module tools/cmos/cmos-context-history
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess } from './errors';
import { tableHasColumn } from './genesis-columns';

/**
 * A single snapshot entry in the history.
 */
export interface ContextSnapshotEntry {
  /** Snapshot ID */
  id: number;

  /** Context ID (master_context or project_context) */
  contextId: string;

  /** Associated session ID, if any */
  sessionId: string | null;

  /** Source/reason for the snapshot */
  source: string;

  /** Content hash for duplicate detection */
  contentHash: string;

  /** Timestamp when snapshot was created */
  createdAt: string;

  /** Size of content in characters (approximate) */
  contentSize: number;

  /** s84-m04: true when this row's content was reclaimed by the bounded-retention prune
   *  (content-tombstoned). The row + metadata + FK link are intact; `contentSize` is 0. */
  contentPruned: boolean;
}

/**
 * Result of context history query.
 */
export interface CmosContextHistoryResult {
  /** List of snapshots */
  snapshots: ContextSnapshotEntry[];

  /** Total count of snapshots matching filters (for pagination) */
  totalCount: number;

  /** Current page number */
  page: number;

  /** Page size used */
  pageSize: number;

  /** Whether there are more pages */
  hasMore: boolean;

  /** Context type filter applied */
  contextType: string | null;
}

/**
 * Input parameters schema for cmos_context_history tool.
 */
export const cmosContextHistorySchema = z.object({
  /** Optional: filter to specific context type */
  contextType: z
    .enum(['master_context', 'project_context'])
    .optional()
    .describe(
      'Filter to specific context type. If omitted, returns snapshots for all context types.'
    ),

  /** Optional: filter snapshots created after this date */
  since: z
    .string()
    .optional()
    .describe('Filter snapshots created after this ISO date (e.g., "2024-01-01T00:00:00Z")'),

  /** Optional: filter snapshots created before this date */
  until: z.string().optional().describe('Filter snapshots created before this ISO date'),

  /** Optional: filter by session ID */
  sessionId: z
    .string()
    .optional()
    .describe('Filter to snapshots associated with a specific session'),

  /** Page number (1-indexed) */
  page: z.number().int().min(1).optional().describe('Page number (1-indexed, default: 1)'),

  /** Number of results per page */
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Results per page (1-100, default: 20)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosContextHistoryParams = z.infer<typeof cmosContextHistorySchema>;

/**
 * MCP Tool Definition for cmos_context_history.
 */
export const cmosContextHistoryToolDefinition = {
  name: 'cmos_context_history',
  description:
    'View the context snapshot timeline. Returns a paginated list of snapshots showing when contexts were captured. Use to understand project history, review past states, or find a specific snapshot to restore.',
  inputSchema: {
    type: 'object',
    properties: {
      contextType: {
        type: 'string',
        enum: ['master_context', 'project_context'],
        description:
          'Filter to specific context type. If omitted, returns snapshots for all context types.',
      },
      since: {
        type: 'string',
        description: 'Filter snapshots created after this ISO date (e.g., "2024-01-01T00:00:00Z")',
      },
      until: {
        type: 'string',
        description: 'Filter snapshots created before this ISO date',
      },
      sessionId: {
        type: 'string',
        description: 'Filter to snapshots associated with a specific session',
      },
      page: {
        type: 'number',
        description: 'Page number (1-indexed, default: 1)',
        minimum: 1,
      },
      pageSize: {
        type: 'number',
        description: 'Results per page (1-100, default: 20)',
        minimum: 1,
        maximum: 100,
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
 * Execute the cmos_context_history tool.
 *
 * Retrieves paginated snapshot history from the context_snapshots table.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with snapshot history or actionable error
 */
export async function cmosContextHistory(
  params: CmosContextHistoryParams = {}
): Promise<CmosToolResult<CmosContextHistoryResult>> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  return withClient(
    (client) => {
      // Build WHERE clause dynamically
      const conditions: string[] = [];
      const queryParams: (string | number)[] = [];

      if (params.contextType) {
        conditions.push('context_id = ?');
        queryParams.push(params.contextType);
      }

      if (params.since) {
        conditions.push('created_at >= ?');
        queryParams.push(params.since);
      }

      if (params.until) {
        conditions.push('created_at <= ?');
        queryParams.push(params.until);
      }

      if (params.sessionId) {
        conditions.push('session_id = ?');
        queryParams.push(params.sessionId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = client.getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM context_snapshots ${whereClause}`,
        queryParams
      );

      if (!countResult.success) {
        return createError<CmosContextHistoryResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to count snapshots' }
        );
      }

      const totalCount = countResult.data?.count ?? 0;

      // s84-m04: guarded content_pruned_at read (NULL AS on an ancient store) so the
      // timeline honestly flags content-tombstoned rows without throwing.
      const prunedExpr = tableHasColumn(client, 'context_snapshots', 'content_pruned_at')
        ? 'content_pruned_at'
        : 'NULL AS content_pruned_at';

      // Get snapshots with pagination
      const snapshotsResult = client.getMany<{
        id: number;
        context_id: string;
        session_id: string | null;
        source: string;
        content_hash: string;
        content: string;
        created_at: string;
        content_pruned_at: string | null;
      }>(
        `SELECT id, context_id, session_id, source, content_hash, content, created_at, ${prunedExpr}
         FROM context_snapshots
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...queryParams, pageSize, offset]
      );

      if (!snapshotsResult.success) {
        return createError<CmosContextHistoryResult>(
          snapshotsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query snapshots' }
        );
      }

      const snapshots: ContextSnapshotEntry[] = (snapshotsResult.data ?? []).map((row) => ({
        id: row.id,
        contextId: row.context_id,
        sessionId: row.session_id,
        source: row.source,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        contentSize: row.content.length,
        contentPruned: row.content_pruned_at != null,
      }));

      const hasMore = offset + snapshots.length < totalCount;

      return createSuccess<CmosContextHistoryResult>({
        snapshots,
        totalCount,
        page,
        pageSize,
        hasMore,
        contextType: params.contextType ?? null,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format context history result for LLM readability.
 *
 * @param result - History query result
 * @returns Human-readable summary
 */
export function formatContextHistoryForLLM(
  result: CmosToolResult<CmosContextHistoryResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to retrieve context history',
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
  const lines: string[] = [];

  // Header
  const typeFilter = data.contextType ? ` (${data.contextType})` : '';
  lines.push(`📜 **Context Snapshot History${typeFilter}**`);
  lines.push('');
  lines.push(
    `Showing ${data.snapshots.length} of ${data.totalCount} snapshots (page ${data.page})`
  );
  lines.push('');

  if (data.snapshots.length === 0) {
    lines.push('_No snapshots found matching criteria._');
    lines.push('');
    lines.push('Use cmos_context(action="snapshot") to create your first snapshot.');
    return lines.join('\n');
  }

  // Snapshot list
  lines.push('| ID | Context | Source | Created | Size |');
  lines.push('|---|---|---|---|---|');

  for (const snap of data.snapshots) {
    const dateStr = new Date(snap.createdAt).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    // s84-m04: a content-tombstoned row shows its content reclaimed, not a real 0-byte snapshot.
    const sizeStr = snap.contentPruned ? 'pruned' : formatBytes(snap.contentSize);
    const sourceShort =
      snap.source.length > 40 ? snap.source.substring(0, 37) + '...' : snap.source;

    lines.push(`| ${snap.id} | ${snap.contextId} | ${sourceShort} | ${dateStr} | ${sizeStr} |`);
  }

  // Pagination info
  if (data.hasMore) {
    lines.push('');
    lines.push(`_More results available. Use page: ${data.page + 1} to see more._`);
  }

  return lines.join('\n');
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
