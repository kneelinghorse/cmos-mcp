/**
 * cmos_session_start Tool
 *
 * MCP tool for starting a new session in CMOS.
 * Sessions capture planning, onboarding, review, and research activities.
 *
 * @module tools/cmos/cmos-session-start
 */

import { z } from 'zod';
import { withClientAsync, withClientValidated } from './client';
import { resolveCurrentSprintId, resolveOpenSprintIdForWrite } from './current-sprint';
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
import { appendWarnings, attachWarnings } from './format-warnings';
import {
  closeStaleSessionsBeforeStart,
  closedSessionLines,
  type ClosedSessionReceipt,
} from './implicit-session-lifecycle';
import { ensureImplicitSessionColumns } from './schema-migrations';
import { summarizeSessionCaptures } from './session-capture-state';
import { insertNewSession } from './session-owner';

// Re-export for convenience
export { VALID_SESSION_TYPES };
export type { SessionType };
// s92-m03: the generator moved beside the one session INSERT it serves.
export { generateSessionId } from './session-owner';

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

  /**
   * s85-m03: the sprint the DISPLAY surfaces name, populated ONLY when nothing is open and
   * `sprintId` was therefore persisted as NULL. It is a hint, not a stamp — no row carries it.
   * A separate field because `{sprintId, sprintAutoTagged: false}` already means "the caller
   * passed sprintId explicitly", so the two states would otherwise be indistinguishable.
   */
  advisorySprintId?: string | null;

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

  /**
   * s92-m03: sessions this start closed first, each with the deterministic summary it was closed
   * with: explicit sessions idle past 12 h (the blocker a forgotten start leaves) and orphaned
   * implicit sessions. Absent when nothing was closed.
   */
  closedSessions?: ClosedSessionReceipt[];

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
  sprintId: z
    .string()
    .optional()
    .describe(
      'Optional existing sprint ID to tag this session with (any status); a sprint that does not exist is refused by name'
    ),

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
    'Start a new session for planning, onboarding, review, or research work. Sessions are optional: a capture with no session open lands in an implicit session the server opens for its process. Only one explicit session can be active at a time; one idle for more than 12 hours is closed first, with a receipt.',
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
        description:
          'Optional existing sprint ID to tag this session with (any status); a sprint that does not exist is refused by name',
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
  const explicitSprintId = params.sprintId?.trim() || null;

  // s92-m03 (#589): an explicit sprintId names an existing sprint of any status (a Planned sprint
  // for a planning session), and a missing one is refused by name before anything is closed.
  if (explicitSprintId) {
    const sprint = await withClientAsync(
      async (client) => {
        const found = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
          explicitSprintId,
        ]);
        return found.success
          ? createSuccess(Boolean(found.data))
          : createError<boolean>(
              found.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to look up the sprint' }
            );
      },
      { projectRoot: params.projectRoot }
    );
    if (!sprint.success) return createError<CmosSessionStartResult>(sprint.error!);
    if (!sprint.data) {
      return createError<CmosSessionStartResult>(CmosErrors.sprintNotFound(explicitSprintId));
    }
  }

  // s92-m03: close what would block or clutter this start, outside its own connection: explicit
  // sessions idle past 12 h, and implicit sessions whose process is gone or idle past 12 h.
  const stale = await closeStaleSessionsBeforeStart(params.projectRoot);

  // One warning sink for every answer this start can give, refusals included.
  const warnings: string[] = [...stale.warnings];
  const result = await withClientValidated(
    (client) => {
      warnings.push(...(ensureImplicitSessionColumns(client).warnings ?? []));

      // s92-m03: one active EXPLICIT session per project. Implicit sessions belong to processes
      // and never block a start.
      const activeResult = client.getOne<
        Pick<Session, 'id' | 'type' | 'title' | 'started_at' | 'captures'>
      >(
        'SELECT id, type, title, started_at, captures FROM sessions WHERE status = ? AND implicit = 0',
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
        const captures = summarizeSessionCaptures(active.captures);
        return createError<CmosSessionStartResult>({
          code: CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE,
          message: `Session '${active.id}' is already active`,
          suggestion: `Complete the active session first with cmos_session(action="complete"), or use cmos_session(action="capture") to add to it`,
          currentState: {
            id: active.id,
            type: active.type,
            title: active.title,
            startedAt: active.started_at,
            captureCount: captures.captureCount,
          },
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

      // Auto-detect the sprint if sprintId was not explicitly provided.
      //
      // s85-m03: this is a DURABLE WRITE, so it resolves through
      // resolveOpenSprintIdForWrite, NOT resolveCurrentSprintId. The s77-m02 change that
      // routed it through the display resolver removed the wrong divergence: the display
      // resolver re-admits Completed sprints (correct for "which sprint am I looking at?",
      // wrong for a stamp that lives forever), so on an all-Completed store every new
      // session inherited a dead sprint. When nothing is open we now persist NULL and
      // surface the read-resolved sprint separately as advisorySprintId — see below.
      let sprintId = explicitSprintId;
      let sprintAutoTagged = false;
      let advisorySprintId: string | null = null;
      if (!sprintId) {
        const resolvedSprintId = resolveOpenSprintIdForWrite(client);
        if (resolvedSprintId) {
          sprintId = resolvedSprintId;
          sprintAutoTagged = true;
        } else {
          // Nothing open. Persist NULL, but still tell the caller which sprint the DISPLAY
          // surfaces will name, so the answer is actionable rather than merely empty.
          //
          // This goes in a NEW field rather than in sprintId, because
          // {sprintId: 'sprint-84', sprintAutoTagged: false} is ALREADY the signature for
          // "the caller passed sprintId explicitly". Overloading it would make the two
          // states indistinguishable on the wire.
          advisorySprintId = resolveCurrentSprintId(client);
          warnings.push(
            advisorySprintId
              ? `No sprint is in an open status (Active / In Progress / Current), so this session is recorded with sprint_id NULL — decisions, learnings, constraints and next-steps captured in it will be untagged too. Display surfaces still name '${advisorySprintId}' (the most recent non-dead sprint). Run cmos_sprint(action="add") to open a sprint before starting mission work.`
              : 'No sprint is in an open status (Active / In Progress / Current), so this session is recorded with sprint_id NULL — decisions, learnings, constraints and next-steps captured in it will be untagged too. Run cmos_sprint(action="add") to open a sprint before starting mission work.'
          );
        }
      }

      // s92-m03: the shared insert (id-collision retry, genesis stamping, start event) that the
      // implicit open uses too, so there is one local session INSERT.
      const inserted = insertNewSession(client, {
        type: sessionType,
        title,
        sprintId,
        agent,
        now,
        implicit: false,
        ownerKey: null,
      });
      if (!inserted.ok) {
        return createError<CmosSessionStartResult>(inserted.error);
      }
      const sessionId = inserted.sessionId;
      warnings.push(...inserted.warnings);

      return createSuccess<CmosSessionStartResult>(
        {
          sessionId,
          type: sessionType,
          title,
          startedAt: now,
          agent,
          sprintId,
          sprintAutoTagged,
          ...(advisorySprintId !== null ? { advisorySprintId } : {}),
          contextAutoRefresh: refreshSummary,
          contextFreshness: freshnessResult.freshness,
          ...(stale.receipts.length > 0 ? { closedSessions: stale.receipts } : {}),
          message: sprintAutoTagged
            ? `Session '${sessionId}' started: ${title} (auto-tagged to ${sprintId})`
            : `Session '${sessionId}' started: ${title}`,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Format session start result for LLM readability.
 */
export function formatSessionStartForLLM(result: CmosToolResult<CmosSessionStartResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to start session', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (
      error?.code === CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE &&
      isActiveSessionState(error.currentState)
    ) {
      lines.push('');
      lines.push(`Active session: ${error.currentState.id}`);
      lines.push(`Type: ${error.currentState.type}`);
      lines.push(`Title: ${error.currentState.title}`);
      lines.push(`Started at: ${error.currentState.startedAt}`);
      lines.push(
        `Capture count: ${
          error.currentState.captureCount === null
            ? 'unknown'
            : `${error.currentState.captureCount} capture(s)`
        }`
      );
    }

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    // s92-m03: a refusal carries the start's warnings too (one sink, attached on every answer).
    appendWarnings(lines, result);
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
  } else if (data.advisorySprintId) {
    // s85-m03: nothing open, so nothing was stamped. Name the display sprint explicitly as
    // an advisory so the reader does not mistake the absent stamp for a missing sprint.
    lines.push(
      `**Sprint**: none open — recorded untagged (display names ${data.advisorySprintId})`
    );
  } else {
    lines.push('**Sprint**: none open — recorded untagged');
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

  if (data.closedSessions && data.closedSessions.length > 0) {
    lines.push('**Closed before start**:');
    for (const line of closedSessionLines(data.closedSessions)) lines.push(`  ${line}`);
  }

  appendWarnings(lines, result);

  lines.push('');
  lines.push(
    'Next: Use `cmos_session(action="capture")` to record insights, then `cmos_session(action="complete")` when done.'
  );

  return lines.join('\n');
}

interface ActiveSessionState {
  id: string;
  type: string;
  title: string;
  startedAt: string;
  captureCount: number | null;
}

function isActiveSessionState(value: unknown): value is ActiveSessionState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.id === 'string' &&
    typeof state.type === 'string' &&
    typeof state.title === 'string' &&
    typeof state.startedAt === 'string' &&
    (typeof state.captureCount === 'number' || state.captureCount === null)
  );
}
