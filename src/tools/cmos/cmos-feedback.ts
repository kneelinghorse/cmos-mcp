// ABOUTME: cmos_feedback — review surface for agent_feedback rows written by the Sprint 56 m03 standing channel.
// ABOUTME: Consolidated tool with list | triage | resolve | archive actions.

/**
 * cmos_feedback Tool
 *
 * Review/triage surface for the agent_feedback standing channel. Agents write
 * UX feedback via the `agentFeedback` parameter on cmos_session_complete,
 * cmos_mission_transition, and cmos_agent_onboard. The operator uses this
 * tool to read, triage, resolve, and archive those entries.
 *
 * @module tools/cmos/cmos-feedback
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CMOS_ERROR_CODES } from './errors';
import {
  ensureAgentFeedbackTable,
  AGENT_FEEDBACK_STATUSES,
  type AgentFeedbackStatus,
} from './schema-migrations';

/** Valid actions on the cmos_feedback consolidated tool. */
export const CMOS_FEEDBACK_ACTIONS = ['list', 'triage', 'resolve', 'archive'] as const;
export type CmosFeedbackAction = (typeof CMOS_FEEDBACK_ACTIONS)[number];

/** One agent_feedback row as returned by cmos_feedback(action="list"). */
export interface AgentFeedbackEntry {
  id: number;
  toolName: string;
  body: string;
  status: AgentFeedbackStatus;
  sessionId: string | null;
  sprintId: string | null;
  missionId: string | null;
  projectId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface CmosFeedbackListResult {
  /** Entries returned, newest-first. */
  entries: AgentFeedbackEntry[];
  /** Count broken down by tool_name for quick triage. */
  countsByTool: Record<string, number>;
  /** Count broken down by status across the filtered set. */
  countsByStatus: Record<string, number>;
  /** Total entries matching the filter (may exceed entries.length when limit was applied). */
  totalCount: number;
  /** Limit that was applied. */
  limit: number;
}

export interface CmosFeedbackMutationResult {
  /** The feedback row that was mutated. */
  feedbackId: number;
  /** Previous status before the mutation. */
  previousStatus: AgentFeedbackStatus;
  /** New status after the mutation. */
  currentStatus: AgentFeedbackStatus;
  /** Resolution note (only populated for resolve/archive). */
  resolutionNote: string | null;
  message: string;
}

export type CmosFeedbackResult = CmosFeedbackListResult | CmosFeedbackMutationResult;

export const cmosFeedbackSchema = z
  .object({
    action: z
      .enum(CMOS_FEEDBACK_ACTIONS)
      .describe('Feedback action: list | triage | resolve | archive'),
    feedbackId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Target feedback row ID (required for triage/resolve/archive)'),
    status: z
      .enum(AGENT_FEEDBACK_STATUSES)
      .optional()
      .describe('Filter by status on list (default: "open")'),
    toolName: z
      .string()
      .optional()
      .describe('Filter by originating tool name on list (e.g. "cmos_mission_transition")'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max entries to return on list (default 50, max 200)'),
    resolutionNote: z
      .string()
      .max(1000)
      .optional()
      .describe('Optional free-text note for resolve/archive actions'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for CMOS database (defaults to cwd)'),
  })
  .strict();

export type CmosFeedbackParams = z.infer<typeof cmosFeedbackSchema>;

export const cmosFeedbackToolDefinition = {
  name: 'cmos_feedback',
  description:
    'Review and triage the agent_feedback standing channel. Actions: list (filterable by status + tool_name), triage (mark under review), resolve (close with optional note), archive (hide without resolving).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_FEEDBACK_ACTIONS],
        description: 'Feedback action: list | triage | resolve | archive',
      },
      feedbackId: {
        type: 'number',
        description: 'Target feedback row ID (required for triage/resolve/archive)',
      },
      status: {
        type: 'string',
        enum: [...AGENT_FEEDBACK_STATUSES],
        description: 'Filter by status on list (default: "open")',
      },
      toolName: {
        type: 'string',
        description: 'Filter by originating tool name on list',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        description: 'Max entries to return on list (default 50, max 200)',
      },
      resolutionNote: {
        type: 'string',
        maxLength: 1000,
        description: 'Optional free-text note for resolve/archive actions',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

interface FeedbackRow {
  id: number;
  tool_name: string;
  body: string;
  status: AgentFeedbackStatus;
  session_id: string | null;
  sprint_id: string | null;
  mission_id: string | null;
  project_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

function rowToEntry(row: FeedbackRow): AgentFeedbackEntry {
  return {
    id: row.id,
    toolName: row.tool_name,
    body: row.body,
    status: row.status,
    sessionId: row.session_id,
    sprintId: row.sprint_id,
    missionId: row.mission_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  };
}

export async function cmosFeedback(
  params: CmosFeedbackParams
): Promise<CmosToolResult<CmosFeedbackResult>> {
  const action = params.action;
  return withClientValidated<CmosFeedbackResult>(
    (client) => {
      ensureAgentFeedbackTable(client);

      if (action === 'list') {
        const status = params.status ?? 'open';
        const limit = params.limit ?? 50;
        const conditions: string[] = ['status = ?'];
        const args: unknown[] = [status];
        if (params.toolName) {
          conditions.push('tool_name = ?');
          args.push(params.toolName);
        }
        const where = `WHERE ${conditions.join(' AND ')}`;
        const rowsResult = client.getMany<FeedbackRow>(
          `SELECT id, tool_name, body, status, session_id, sprint_id, mission_id, project_id,
                  created_at, resolved_at, resolution_note
           FROM agent_feedback ${where}
           ORDER BY created_at DESC
           LIMIT ${limit}`,
          args
        );
        if (!rowsResult.success) {
          return createError<CmosFeedbackResult>(
            rowsResult.error ?? {
              code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
              message: 'Failed to list agent feedback',
            }
          );
        }
        const rows = rowsResult.data ?? [];
        const entries = rows.map(rowToEntry);

        const totalResult = client.getOne<{ count: number }>(
          `SELECT COUNT(*) as count FROM agent_feedback ${where}`,
          args
        );
        const totalCount =
          totalResult.success && totalResult.data ? totalResult.data.count : entries.length;

        const toolGroupsResult = client.getMany<{ tool_name: string; c: number }>(
          `SELECT tool_name, COUNT(*) as c FROM agent_feedback ${where}
           GROUP BY tool_name ORDER BY c DESC`,
          args
        );
        const countsByTool: Record<string, number> = {};
        if (toolGroupsResult.success && toolGroupsResult.data) {
          for (const g of toolGroupsResult.data) {
            countsByTool[g.tool_name] = g.c;
          }
        }

        const statusGroupsResult = client.getMany<{ status: string; c: number }>(
          `SELECT status, COUNT(*) as c FROM agent_feedback ${params.toolName ? 'WHERE tool_name = ?' : ''}
           GROUP BY status`,
          params.toolName ? [params.toolName] : []
        );
        const countsByStatus: Record<string, number> = {};
        if (statusGroupsResult.success && statusGroupsResult.data) {
          for (const g of statusGroupsResult.data) {
            countsByStatus[g.status] = g.c;
          }
        }

        return createSuccess<CmosFeedbackResult>({
          entries,
          countsByTool,
          countsByStatus,
          totalCount,
          limit,
        });
      }

      // mutation actions: triage | resolve | archive
      if (typeof params.feedbackId !== 'number') {
        return createError<CmosFeedbackResult>({
          code: CMOS_ERROR_CODES.MISSING_PARAMETER,
          message: `feedbackId is required for action='${action}'`,
          suggestion: 'Pass feedbackId (integer, as returned from cmos_feedback action="list")',
        });
      }

      const currentResult = client.getOne<FeedbackRow>(
        'SELECT id, status, resolved_at, resolution_note FROM agent_feedback WHERE id = ?',
        [params.feedbackId]
      );
      if (!currentResult.success) {
        return createError<CmosFeedbackResult>(
          currentResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to load feedback row',
          }
        );
      }
      if (!currentResult.data) {
        return createError<CmosFeedbackResult>({
          code: 'FEEDBACK_NOT_FOUND',
          message: `Feedback #${params.feedbackId} not found`,
          suggestion: 'Use cmos_feedback(action="list") to see available entries',
        });
      }

      const previousStatus = currentResult.data.status;
      let nextStatus: AgentFeedbackStatus;
      let resolvedAt: string | null = currentResult.data.resolved_at;
      let resolutionNote: string | null = currentResult.data.resolution_note;

      if (action === 'triage') {
        nextStatus = 'triaged';
      } else if (action === 'resolve') {
        nextStatus = 'resolved';
        resolvedAt = new Date().toISOString();
        resolutionNote = params.resolutionNote?.trim() || resolutionNote;
      } else {
        nextStatus = 'archived';
        resolvedAt = resolvedAt ?? new Date().toISOString();
        resolutionNote = params.resolutionNote?.trim() || resolutionNote;
      }

      const updateResult = client.execute(
        `UPDATE agent_feedback
         SET status = ?, resolved_at = ?, resolution_note = ?
         WHERE id = ?`,
        [nextStatus, resolvedAt, resolutionNote, params.feedbackId]
      );
      if (!updateResult.success) {
        return createError<CmosFeedbackResult>(
          updateResult.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to update feedback row',
          }
        );
      }

      return createSuccess<CmosFeedbackResult>({
        feedbackId: params.feedbackId,
        previousStatus,
        currentStatus: nextStatus,
        resolutionNote,
        message: `Feedback #${params.feedbackId}: ${previousStatus} → ${nextStatus}`,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatFeedbackForLLM(
  action: CmosFeedbackAction,
  result: CmosToolResult<CmosFeedbackResult>
): string {
  if (!result.success || !result.data) {
    const err = result.error;
    return `❌ cmos_feedback(${action}) failed: ${err?.message ?? 'Unknown error'}${err?.suggestion ? `\n  Suggestion: ${err.suggestion}` : ''}`;
  }
  if (action === 'list') {
    const d = result.data as CmosFeedbackListResult;
    if (d.entries.length === 0) {
      return `No agent feedback matching filter (limit ${d.limit}).`;
    }
    const head = `Agent feedback — ${d.entries.length} of ${d.totalCount} entries (limit ${d.limit}).`;
    const byTool = Object.entries(d.countsByTool)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const byStatus = Object.entries(d.countsByStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const meta = `By tool: ${byTool || '(none)'} | All statuses: ${byStatus || '(none)'}`;
    const lines = d.entries.slice(0, 10).map((e) => {
      const snippet = e.body.length > 140 ? `${e.body.slice(0, 137)}…` : e.body;
      return `  #${e.id} [${e.status}] ${e.toolName} @ ${e.createdAt}\n    ${snippet}`;
    });
    const more = d.entries.length > 10 ? `\n  ... ${d.entries.length - 10} more` : '';
    return `${head}\n${meta}\n${lines.join('\n')}${more}`;
  }
  const m = result.data as CmosFeedbackMutationResult;
  const noteLine = m.resolutionNote ? `\n  Note: ${m.resolutionNote}` : '';
  return `${m.message}${noteLine}`;
}
