/**
 * cmos_session_list Tool
 *
 * MCP tool for listing sessions with optional filters.
 * Returns paginated list of sessions.
 *
 * @module tools/cmos/cmos-session-list
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult, Session } from './types';
import { createError, createSuccess } from './errors';
import { VALID_SESSION_TYPES, type SessionType } from './cmos-session-start';
import { getProjectId, tableHasColumn } from './genesis-columns';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import { appendWarnings } from './format-warnings';

/**
 * Valid session statuses.
 */
export const VALID_SESSION_STATUSES = ['active', 'completed', 'canceled'] as const;

export type SessionStatus = (typeof VALID_SESSION_STATUSES)[number];

/**
 * Session list item.
 */
export interface SessionListItem {
  /** Session ID */
  id: string;

  /** Session type */
  type: SessionType;

  /** Session title */
  title: string;

  /** Session status */
  status: SessionStatus;

  /** When the session started */
  startedAt: string;

  /** When the session was completed (if completed) */
  completedAt: string | null;

  /** Agent who ran the session */
  agent: string;

  /** Session summary (if completed) */
  summary: string | null;

  /** Number of captures in this session */
  captureCount: number;

  /** Associated sprint ID (if any) */
  sprintId: string | null;

  /** s84-m03: the session's own project_id (guarded read). Foreign → title/summary framed. */
  projectId?: string | null;
}

/**
 * Result of session list operation.
 */
export interface CmosSessionListResult {
  /** List of sessions */
  sessions: SessionListItem[];

  /** Total count matching filters */
  totalCount: number;

  /** Page number returned */
  page: number;

  /** Page size */
  pageSize: number;

  /** Whether there are more results */
  hasMore: boolean;

  /** Applied filters */
  filters: {
    status?: SessionStatus;
    type?: SessionType;
    sprintId?: string;
  };

  /** s84-m03: the querying store's own project_id. Sessions whose projectId differs are
   *  foreign (pull-merged) and framed as untrusted in the render. */
  localProjectId?: string | null;
}

/**
 * Input parameters schema for cmos_session_list tool.
 */
export const cmosSessionListSchema = z.object({
  /** Filter by status */
  status: z
    .enum(VALID_SESSION_STATUSES)
    .optional()
    .describe('Filter by session status: active, completed, or canceled'),

  /** Filter by type */
  type: z
    .enum(VALID_SESSION_TYPES)
    .optional()
    .describe(
      'Filter by session type: onboarding, planning, review, research, check-in, or custom'
    ),

  /** Filter by sprint */
  sprintId: z.string().optional().describe('Filter by sprint ID'),

  /** Page number */
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .optional()
    .describe('Page number (1-indexed, default: 1)'),

  /** Page size */
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .optional()
    .describe('Results per page (1-100, default: 20)'),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSessionListParams = z.infer<typeof cmosSessionListSchema>;

/**
 * MCP Tool Definition for cmos_session_list.
 */
export const cmosSessionListToolDefinition = {
  name: 'cmos_session_list',
  description:
    'List sessions with optional filtering by status, type, or sprint. Returns paginated results sorted by most recent first.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: VALID_SESSION_STATUSES,
        description: 'Filter by session status: active, completed, or canceled',
      },
      type: {
        type: 'string',
        enum: VALID_SESSION_TYPES,
        description:
          'Filter by session type: onboarding, planning, review, research, check-in, or custom',
      },
      sprintId: {
        type: 'string',
        description: 'Filter by sprint ID',
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
 * Execute the cmos_session_list tool.
 *
 * Lists sessions with optional filters and pagination.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with session list or actionable error
 */
export async function cmosSessionList(
  params: CmosSessionListParams
): Promise<CmosToolResult<CmosSessionListResult>> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  return withClient(
    (client) => {
      // Build query with filters
      const conditions: string[] = [];
      const queryParams: unknown[] = [];

      if (params.status) {
        conditions.push('status = ?');
        queryParams.push(params.status);
      }

      if (params.type) {
        conditions.push('type = ?');
        queryParams.push(params.type);
      }

      if (params.sprintId) {
        conditions.push('sprint_id = ?');
        queryParams.push(params.sprintId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = client.getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM sessions ${whereClause}`,
        queryParams
      );

      if (!countResult.success) {
        return createError<CmosSessionListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to count sessions' }
        );
      }

      const totalCount = countResult.data?.count ?? 0;

      // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
      const projectIdExpr = tableHasColumn(client, 'sessions', 'project_id')
        ? 'project_id'
        : 'NULL AS project_id';

      // Get sessions
      const sessionsResult = client.getMany<Session>(
        `SELECT id, type, title, status, started_at, completed_at, agent, summary, captures, sprint_id, ${projectIdExpr}
         FROM sessions
         ${whereClause}
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
        [...queryParams, pageSize, offset]
      );

      if (!sessionsResult.success) {
        return createError<CmosSessionListResult>(
          sessionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to list sessions' }
        );
      }

      const sessions: SessionListItem[] = (sessionsResult.data ?? []).map((s) => {
        // Count captures
        let captureCount = 0;
        try {
          const captures = s.captures ? JSON.parse(s.captures) : [];
          captureCount = Array.isArray(captures) ? captures.length : 0;
        } catch {
          captureCount = 0;
        }

        return {
          id: s.id,
          type: s.type as SessionType,
          title: s.title,
          status: s.status as SessionStatus,
          startedAt: s.started_at,
          completedAt: s.completed_at,
          agent: s.agent,
          summary: s.summary,
          captureCount,
          sprintId: s.sprint_id,
          projectId: (s as unknown as Record<string, string | null>).project_id ?? null,
        };
      });

      const hasMore = offset + sessions.length < totalCount;

      return createSuccess<CmosSessionListResult>({
        sessions,
        totalCount,
        page,
        pageSize,
        hasMore,
        filters: {
          ...(params.status && { status: params.status }),
          ...(params.type && { type: params.type }),
          ...(params.sprintId && { sprintId: params.sprintId }),
        },
        localProjectId: getProjectId(client),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format session list result for LLM readability.
 */
export function formatSessionListForLLM(result: CmosToolResult<CmosSessionListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list sessions', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;

  if (data.sessions.length === 0) {
    const filterDesc = Object.entries(data.filters)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return filterDesc ? `No sessions found matching filters: ${filterDesc}` : 'No sessions found';
  }

  const lines = [`📋 **Sessions** (${data.sessions.length} of ${data.totalCount})`, ''];

  // Apply filters description
  const filterEntries = Object.entries(data.filters);
  if (filterEntries.length > 0) {
    const filterDesc = filterEntries.map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`*Filters: ${filterDesc}*`);
    lines.push('');
  }

  const statusIcon: Record<SessionStatus, string> = {
    active: '🟢',
    completed: '✅',
    canceled: '❌',
  };

  for (const session of data.sessions) {
    const icon = statusIcon[session.status] ?? '📄';
    const captureInfo = session.captureCount > 0 ? ` (${session.captureCount} captures)` : '';
    // s84-m03: a foreign (pull-merged) session's title/summary is untrusted DATA — frame
    // inline; a local/NULL-project session renders byte-identical to 2.3.0.
    const title = frameInlineIfForeign(session.title, session.projectId, data.localProjectId);
    lines.push(`${icon} **${session.id}** - ${title}${captureInfo}`);
    lines.push(`   Type: ${session.type} | Status: ${session.status} | Agent: ${session.agent}`);
    if (session.summary) {
      const shortSummary =
        session.summary.length > 80 ? session.summary.slice(0, 80) + '...' : session.summary;
      lines.push(
        `   Summary: ${frameInlineIfForeign(shortSummary, session.projectId, data.localProjectId)}`
      );
    }
    lines.push('');
  }

  if (data.hasMore) {
    lines.push(
      `*Page ${data.page} of ${Math.ceil(data.totalCount / data.pageSize)}. Use page parameter for more.*`
    );
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
