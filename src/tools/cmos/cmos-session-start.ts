/**
 * cmos_session_start Tool
 *
 * MCP tool for starting a new session in CMOS.
 * Sessions capture planning, onboarding, review, and research activities.
 *
 * @module tools/cmos/cmos-session-start
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import { resolveCurrentSprintId } from './current-sprint';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult, Session } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  VALID_SESSION_TYPES,
  type SessionType,
} from './errors';
import {
  calculateContextFreshness,
  buildContextStalenessWarning,
  refreshMasterContextFromRecentActivity,
  type ContextFreshness,
} from './context-freshness';

// Re-export for convenience
export { VALID_SESSION_TYPES };
export type { SessionType };

/**
 * Result of session start operation.
 */
export interface CmosSessionStartResult {
  /** Generated session ID (e.g., PS-2024-12-10-001) */
  sessionId: string;

  /** Session type */
  type: SessionType;

  /** Session title */
  title: string;

  /** When the session was started */
  startedAt: string;

  /** Agent that started the session */
  agent: string;

  /** Associated sprint ID (if any) */
  sprintId: string | null;

  /** Whether the sprintId was auto-detected from the active sprint */
  sprintAutoTagged: boolean;

  /** Master context auto-refresh status for this start operation */
  contextAutoRefresh: {
    enabled: boolean;
    refreshed: boolean;
    missionsAdded: number;
    sprintsAdded: number;
    snapshotId: number | null;
  };

  /** Freshness of master_context after start handling */
  contextFreshness: ContextFreshness;

  /** Message describing the result */
  message: string;
}

/**
 * Input parameters schema for cmos_session_start tool.
 */
export const cmosSessionStartSchema = z.object({
  /** Session type */
  type: z
    .enum(VALID_SESSION_TYPES)
    .describe('Session type: onboarding, planning, review, research, check-in, or custom'),

  /** Session title */
  title: z
    .string()
    .min(1)
    .max(255)
    .describe('Short descriptive title for the session (e.g., "Sprint 13 planning")'),

  /** Optional agent name */
  agent: z
    .string()
    .default('assistant')
    .optional()
    .describe('Agent starting the session (default: "assistant")'),

  /** Optional sprint ID */
  sprintId: z.string().optional().describe('Optional sprint ID to associate with this session'),

  /** Optional auto-refresh behavior for master_context */
  autoRefreshMasterContext: z
    .boolean()
    .optional()
    .describe(
      'Whether to auto-refresh master_context from recent completed missions/sprints before starting the session (default: true)'
    ),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSessionStartParams = z.infer<typeof cmosSessionStartSchema>;

/**
 * MCP Tool Definition for cmos_session_start.
 */
export const cmosSessionStartToolDefinition = {
  name: 'cmos_session_start',
  description:
    'Start a new session for planning, onboarding, review, or research work. Sessions capture insights and decisions outside of mission-oriented build work. Only one session can be active at a time.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: VALID_SESSION_TYPES,
        description: 'Session type: onboarding, planning, review, research, check-in, or custom',
      },
      title: {
        type: 'string',
        description: 'Short descriptive title for the session (e.g., "Sprint 13 planning")',
        minLength: 1,
        maxLength: 255,
      },
      agent: {
        type: 'string',
        description: 'Agent starting the session (default: "assistant")',
      },
      sprintId: {
        type: 'string',
        description: 'Optional sprint ID to associate with this session',
      },
      autoRefreshMasterContext: {
        type: 'boolean',
        description:
          'Whether to auto-refresh master_context from recent completed missions/sprints before starting the session (default: true)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['type', 'title'],
    additionalProperties: false,
  },
} as const;

/**
 * Generate a session ID in the format PS-YYYY-MM-DD-NNN.
 */
export function generateSessionId(existingIds: string[]): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const prefix = `PS-${dateStr}-`;

  // Find the highest counter for today
  let maxCounter = 0;
  for (const id of existingIds) {
    if (id.startsWith(prefix)) {
      const counterStr = id.slice(prefix.length);
      const counter = parseInt(counterStr, 10);
      if (!isNaN(counter) && counter > maxCounter) {
        maxCounter = counter;
      }
    }
  }

  return `${prefix}${String(maxCounter + 1).padStart(3, '0')}`;
}

/**
 * Execute the cmos_session_start tool.
 *
 * Creates a new session in the database. Only one session can be active at a time.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with session info or actionable error
 */
export async function cmosSessionStart(
  params: CmosSessionStartParams
): Promise<CmosToolResult<CmosSessionStartResult>> {
  // Explicit empty/whitespace title check returns the domain-specific
  // MISSING_PARAMETER code rather than a generic Zod validation error.
  if (!params.title || params.title.trim() === '') {
    return createError(CmosErrors.missingParameter('title'));
  }

  // Validate all remaining parameters against the schema (catches type/length
  // violations regardless of call site — MCP layer or direct invocation).
  const parseResult = cmosSessionStartSchema.safeParse(params);
  if (!parseResult.success) {
    const firstError = parseResult.error.errors[0];
    return createError({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: `Validation error: ${firstError?.message ?? 'Unknown error'}`,
      field: firstError?.path.join('.') || undefined,
      providedValue: firstError?.path.length
        ? (params as Record<string, unknown>)[String(firstError.path[0])]
        : undefined,
    });
  }

  const sessionType = params.type;
  const title = params.title.trim();
  const agent = params.agent ?? 'assistant';
  const autoRefreshMasterContext = params.autoRefreshMasterContext ?? true;

  return withClientValidated(
    (client) => {
      const warnings: string[] = [];

      // Check for existing active session
      const activeResult = client.getOne<Session>(
        'SELECT id, type, title, started_at FROM sessions WHERE status = ?',
        ['active']
      );

      if (!activeResult.success) {
        return createError<CmosSessionStartResult>(
          activeResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to check for active sessions',
          }
        );
      }

      if (activeResult.data) {
        const active = activeResult.data;
        return createError<CmosSessionStartResult>({
          code: CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE,
          message: `Session '${active.id}' is already active`,
          suggestion: `Complete the active session first with cmos_session_complete, or use cmos_session_capture to add to it`,
          currentState: active.id,
        });
      }

      const now = new Date().toISOString();

      let refreshSummary: {
        enabled: boolean;
        refreshed: boolean;
        missionsAdded: number;
        sprintsAdded: number;
        snapshotId: number | null;
      } = {
        enabled: autoRefreshMasterContext,
        refreshed: false,
        missionsAdded: 0,
        sprintsAdded: 0,
        snapshotId: null,
      };

      if (autoRefreshMasterContext) {
        const refreshResult = refreshMasterContextFromRecentActivity(client, {
          source: 'session_start:auto_refresh',
          now,
        });
        warnings.push(...refreshResult.warnings);
        refreshSummary = {
          enabled: true,
          refreshed: refreshResult.refreshed,
          missionsAdded: refreshResult.missionsAdded,
          sprintsAdded: refreshResult.sprintsAdded,
          snapshotId: refreshResult.snapshotId,
        };
      }

      const freshnessResult = calculateContextFreshness(client, { contextId: 'master_context' });
      warnings.push(...freshnessResult.warnings);
      const staleWarning = buildContextStalenessWarning(freshnessResult.freshness);
      if (staleWarning) {
        const suffix = autoRefreshMasterContext
          ? 'Auto-refresh ran, but context is still behind the latest activity.'
          : 'Auto-refresh was disabled for this session start.';
        warnings.push(`${staleWarning} ${suffix}`);
      }

      // Auto-detect the current sprint if sprintId not explicitly provided.
      // s77-m02: delegate to the canonical resolveCurrentSprintId instead of an
      // inline `status='Active' ORDER BY start_date DESC` SELECT (the surface that
      // mis-tagged PS-2026-07-08-002) so a new session tags to the SAME sprint
      // onboard/review name.
      let sprintId = params.sprintId ?? null;
      let sprintAutoTagged = false;
      if (!sprintId) {
        const resolvedSprintId = resolveCurrentSprintId(client);
        if (resolvedSprintId) {
          sprintId = resolvedSprintId;
          sprintAutoTagged = true;
        }
      }

      // Insert the new session, retrying on UNIQUE constraint collision (e.g. DB restore
      // or concurrent write between SELECT and INSERT).
      const todayPrefix = `PS-${new Date().toISOString().split('T')[0]}-`;
      const MAX_ID_RETRIES = 3;
      let sessionId = '';
      let insertResult = client.execute('SELECT 1', []); // placeholder; overwritten in loop
      insertResult = { success: false }; // ensure loop runs at least once

      for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
        const existingResult = client.getMany<{ id: string }>(
          'SELECT id FROM sessions WHERE id LIKE ? ORDER BY id DESC',
          [`${todayPrefix}%`]
        );
        const existingIds =
          existingResult.success && existingResult.data ? existingResult.data.map((r) => r.id) : [];

        sessionId = generateSessionId(existingIds);

        const g = genesisColumns(client, 'sessions', getProjectId(client));
        insertResult = client.execute(
          `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures, next_steps, metadata, ${g.columns.join(', ')})
           VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', NULL, NULL, ${g.placeholders})`,
          [sessionId, sessionType, title, sprintId, now, agent, ...g.values]
        );

        if (insertResult.success) break;

        // Only retry on UNIQUE constraint violation on the session ID field
        const isIdCollision =
          insertResult.error?.code === CMOS_ERROR_CODES.INVALID_PARAMETER &&
          insertResult.error?.field === 'id';
        if (!isIdCollision) break;
      }

      if (!insertResult.success) {
        return createError<CmosSessionStartResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to create session: ${insertResult.error?.message ?? 'Unknown error'}`,
          suggestion: 'Check database permissions and schema integrity',
        });
      }

      // Insert session event
      const rawEvent = JSON.stringify({
        ts: now,
        agent,
        session: sessionId,
        action: 'start',
        status: 'active',
        summary: title,
      });

      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
         VALUES (?, ?, ?, 'start', 'active', ?, ?, ?)`,
        [now, agent, sessionId, title, sprintId, rawEvent]
      );

      return createSuccess<CmosSessionStartResult>(
        {
          sessionId,
          type: sessionType,
          title,
          startedAt: now,
          agent,
          sprintId,
          sprintAutoTagged,
          contextAutoRefresh: refreshSummary,
          contextFreshness: freshnessResult.freshness,
          message: sprintAutoTagged
            ? `Session '${sessionId}' started: ${title} (auto-tagged to ${sprintId})`
            : `Session '${sessionId}' started: ${title}`,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format session start result for LLM readability.
 */
export function formatSessionStartForLLM(result: CmosToolResult<CmosSessionStartResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to start session', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines = [
    `🎬 **Session Started**`,
    '',
    `**Session ID**: ${data.sessionId}`,
    `**Type**: ${data.type}`,
    `**Title**: ${data.title}`,
    `**Agent**: ${data.agent}`,
    `**Started**: ${data.startedAt}`,
  ];

  if (data.sprintId) {
    lines.push(`**Sprint**: ${data.sprintId}${data.sprintAutoTagged ? ' (auto-tagged)' : ''}`);
  }

  lines.push(`**Auto-refresh**: ${data.contextAutoRefresh.enabled ? 'enabled' : 'disabled'}`);
  if (data.contextAutoRefresh.enabled) {
    lines.push(
      `  refreshed=${data.contextAutoRefresh.refreshed}, missions_added=${data.contextAutoRefresh.missionsAdded}, sprints_added=${data.contextAutoRefresh.sprintsAdded}`
    );
  }

  lines.push(
    `**Context Freshness**: ${data.contextFreshness.isStale ? 'stale' : 'fresh'}${
      data.contextFreshness.lagDays !== null
        ? ` (${data.contextFreshness.lagDays.toFixed(1)} day lag)`
        : ''
    }`
  );

  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push('');
  lines.push(
    'Next: Use `cmos_session_capture` to record insights, then `cmos_session_complete` when done.'
  );

  return lines.join('\n');
}
