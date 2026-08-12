/**
 * cmos_session_complete Tool
 *
 * MCP tool for completing an active session.
 * Captures are aggregated into master context when session completes.
 *
 * @module tools/cmos/cmos-session-complete
 */

import { z } from 'zod';
import * as crypto from 'crypto';
import { withClientAsync, type CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult, Session, Context } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import {
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import { recordAgentFeedback } from './agent-feedback';
import type { CaptureCategory } from './cmos-session-capture';
import {
  condenseContextForRetention,
  getContextRetentionPolicy,
  type ContextRetentionPolicy,
} from './context-retention';
import {
  ensureNextStepsTable,
  ensureConstraintsTable,
  ensureAuthorNamespaceColumns,
  computeContentHash,
  snapshotDedupPrunedFilter,
} from './schema-migrations';
import { applyLearningReaffirm, sanitizeLearningIds } from './learning-reaffirm';
import { ensureMissionIdColumn } from './cmos-mission-complete';
import { recordEmbedding, decisionEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { appendWarnings, appendWriteFailures } from './format-warnings';
import { checkWrite, type WriteFailure } from './write-guard';

/**
 * Result of session complete operation.
 */
export interface CmosSessionCompleteResult {
  /** Completed session ID */
  sessionId: string;

  /** Session type */
  type: string;

  /** Session title */
  title: string;

  /** Completion summary */
  summary: string;

  /** When the session was completed */
  completedAt: string;

  /** How long the session lasted */
  durationMinutes: number;

  /** Number of captures in the session */
  captureCount: number;

  /** Breakdown of captures by category */
  capturesByCategory: Partial<Record<CaptureCategory, number>>;

  /** Next steps recorded (if any) */
  nextSteps: string[] | null;

  /** Context aggregation results */
  aggregation: {
    /** Captures routed to master_context by category */
    capturesRouted: Record<string, number>;
    /** Whether contexts were updated */
    contextsUpdated: boolean;
    /** Snapshot IDs created (null if none) */
    projectSnapshotId: number | null;
    masterSnapshotId: number | null;
    /** Retention condensation details */
    condensation?: {
      projectArchivedSprints: string[];
      masterArchivedSprints: string[];
      projectArchiveSnapshotId: number | null;
      masterArchiveSnapshotId: number | null;
    };
  };

  /** Number of next-steps extracted to the next_steps table */
  nextStepsExtracted: number;

  /**
   * Number of decisions from the `decisions[]` parameter or decision-category
   * captures that were inserted into strategic_decisions. Deduped rows
   * (already in the table for this session) are not counted.
   */
  decisionsExtracted: number;

  /** Number of constraints extracted to the constraints table */
  constraintsExtracted: number;

  /** Message describing the result */
  message: string;

  /**
   * s86-m02b — writes this call ATTEMPTED and the database REJECTED. Always present, `[]` on the
   * happy path. The extraction counts above and `aggregation.contextsUpdated` report what
   * actually landed, so a non-empty array here is the gap between intent and outcome.
   */
  writeFailures: WriteFailure[];

  /** Persisted agent_feedback.id when agentFeedback was supplied (Sprint 56 m03). */
  feedbackId?: number;

  /**
   * Learning IDs whose `last_reviewed_at` was bumped because the caller passed
   * them in `citesLearningIds[]`. Sprint 61 m01.
   */
  explicitlyReaffirmedLearningIds?: number[];

  /**
   * Learning IDs whose `last_reviewed_at` was bumped because at least one
   * decision text in `decisions[]` overlapped them by IMPLICIT_REAFFIRM_KEYWORD_FLOOR
   * keywords. Sprint 61 m01.
   */
  implicitlyReaffirmedLearningIds?: number[];

  /**
   * Learning IDs the caller passed in `citesLearningIds[]` that did not
   * resolve to existing rows. Sprint 61 m01.
   */
  missingCitedLearningIds?: number[];
}

/**
 * Input parameters schema for cmos_session_complete tool.
 */
export const cmosSessionCompleteSchema = z.object({
  /** Session ID to complete (optional - uses active session if not provided) */
  sessionId: z
    .string()
    .optional()
    .describe('Session ID to complete (uses active session if not provided)'),

  /** Completion summary */
  summary: z.string().min(1).max(2000).describe('Summary of what was accomplished in the session'),

  /** Optional next steps */
  nextSteps: z.array(z.string()).optional().describe('Optional list of next steps or action items'),

  /**
   * Optional decisions captured at session close. Each entry becomes a
   * strategic_decisions row with sprint_id derived from the session.
   */
  decisions: z
    .array(z.string())
    .optional()
    .describe('Optional list of strategic decisions to materialize into strategic_decisions rows'),

  /**
   * s85-m04: optional mission this session's work belongs to. Stamps `mission_id` on the
   * `decisions[]` and `nextSteps[]` rows this call materializes, so the mission -> row trail
   * is queryable (#487). Per-capture `missionId` still wins for capture-sourced next-steps.
   */
  missionId: z
    .string()
    .optional()
    .describe(
      'Associate the rows this call materializes (decisions[], nextSteps[]) with a mission. A per-capture missionId still wins for capture-sourced next-steps.'
    ),

  /** Optional agent name */
  agent: z
    .string()
    .default('assistant')
    .optional()
    .describe('Agent completing the session (default: "assistant")'),

  /** Optional free-text UX feedback from the agent (Sprint 56 m03). */
  agentFeedback: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit during this session. Reviewed periodically via cmos_feedback(action="list").'
    ),

  /**
   * Optional explicit list of learning IDs the session's decisions cite.
   * Bumps `last_reviewed_at` on each — keeps still-true institutional rules
   * out of the staleness pile (Sprint 61 m01).
   */
  citesLearningIds: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Learning IDs the session decisions cite. Bumps last_reviewed_at on each — applies to the decisions[] write path.'
    ),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSessionCompleteParams = z.infer<typeof cmosSessionCompleteSchema>;

/**
 * MCP Tool Definition for cmos_session_complete.
 */
export const cmosSessionCompleteToolDefinition = {
  name: 'cmos_session_complete',
  description:
    'Complete an active session with a summary. Captures are aggregated into master context. Only active sessions can be completed.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID to complete (uses active session if not provided)',
      },
      summary: {
        type: 'string',
        description: 'Summary of what was accomplished in the session',
        minLength: 1,
        maxLength: 2000,
      },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of next steps or action items',
      },
      missionId: {
        type: 'string',
        description:
          'Associate the rows this call materializes (decisions[], nextSteps[]) with a mission. A per-capture missionId still wins for capture-sourced next-steps.',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of strategic decisions to materialize into strategic_decisions rows',
      },
      agent: {
        type: 'string',
        description: 'Agent completing the session (default: "assistant")',
      },
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit during this session. Reviewed periodically via cmos_feedback(action="list").',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'Learning IDs the session decisions cite. Bumps last_reviewed_at on each — applies to the decisions[] write path.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['summary'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_session_complete tool.
 *
 * Completes an active session and marks it as completed.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with completion info or actionable error
 */
export async function cmosSessionComplete(
  params: CmosSessionCompleteParams
): Promise<CmosToolResult<CmosSessionCompleteResult>> {
  // Validate parameters
  if (!params.summary || params.summary.trim() === '') {
    return createError(CmosErrors.missingParameter('summary'));
  }

  const sanitizedFields: SanitizedField[] = [];
  const summarySan = sanitizeContentField(params.summary.trim());
  if (summarySan.wasModified) {
    sanitizedFields.push({ field: 'summary', reason: summarySan.reason ?? '' });
  }
  const summary = summarySan.cleaned;

  const trimmedNextSteps = params.nextSteps?.filter((s) => s && s.trim()) ?? null;
  const nextStepsSan = sanitizeStringArray('nextSteps', trimmedNextSteps ?? undefined);
  sanitizedFields.push(...nextStepsSan.sanitizedFields);
  const nextSteps = trimmedNextSteps === null ? null : (nextStepsSan.cleaned as string[]);

  const trimmedDecisions = params.decisions?.map((d) => d.trim()).filter((d) => d.length > 0) ?? [];
  const decisionsSan = sanitizeStringArray('decisions', trimmedDecisions);
  sanitizedFields.push(...decisionsSan.sanitizedFields);
  const decisions = decisionsSan.cleaned as string[];

  const citesLearningIdsSan = sanitizeLearningIds(
    'citesLearningIds',
    params.citesLearningIds as readonly unknown[] | undefined
  );
  sanitizedFields.push(...citesLearningIdsSan.sanitizedFields);
  const citesLearningIds = citesLearningIdsSan.cleaned;

  const agent = params.agent ?? 'assistant';

  // s85-m04 — the call-level mission for the rows THIS call materializes (decisions[] and
  // nextSteps[]). Named `callMissionId` to keep it visibly distinct from the per-capture
  // `missionId` read off each capture, which wins where it exists.
  const callMissionId = params.missionId?.trim() || null;

  return withClientAsync(
    async (client) => {
      // s86-m02b — SINK HOISTING. `warnings` used to be declared ~250 lines below, after the
      // session_events insert and all four extraction loops, so wiring their failures into it
      // would not have compiled and would have tempted a second array into existence. One sink,
      // declared before anything can write to it.
      const warnings: string[] = [];
      // Writes this handler attempted and the database rejected. Separate from `warnings`
      // (fork f09): a lost next-step row and a sprint-closeout advisory are different news.
      const writeSink = { failures: [] as WriteFailure[] };

      // Find the session to complete
      let sessionId = params.sessionId;

      if (!sessionId) {
        // Find the active session
        const activeResult = client.getOne<Session>('SELECT id FROM sessions WHERE status = ?', [
          'active',
        ]);

        if (!activeResult.success) {
          return createError<CmosSessionCompleteResult>(
            activeResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to find active session',
            }
          );
        }

        if (!activeResult.data) {
          return createError<CmosSessionCompleteResult>({
            code: CMOS_ERROR_CODES.SESSION_NOT_ACTIVE,
            message: 'No active session found',
            suggestion:
              'Start a session first with cmos_session(action="start"), or provide a sessionId',
          });
        }

        sessionId = activeResult.data.id;
      }

      // Get the session and verify it's active
      const sessionResult = client.getOne<Session>(
        'SELECT id, type, title, sprint_id, status, captures, started_at FROM sessions WHERE id = ?',
        [sessionId]
      );

      if (!sessionResult.success) {
        return createError<CmosSessionCompleteResult>(
          sessionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query session' }
        );
      }

      if (!sessionResult.data) {
        return createError<CmosSessionCompleteResult>(CmosErrors.sessionNotFound(sessionId));
      }

      const session = sessionResult.data;

      if (session.status !== 'active') {
        return createError<CmosSessionCompleteResult>({
          code: CMOS_ERROR_CODES.SESSION_NOT_ACTIVE,
          message: `Session '${sessionId}' is not active (status: ${session.status})`,
          suggestion: 'Only active sessions can be completed',
          currentState: session.status,
        });
      }

      // Parse captures and count by category
      let captures: Array<{ category: string; content?: string; missionId?: string }> = [];
      try {
        captures = session.captures ? JSON.parse(session.captures) : [];
      } catch {
        captures = [];
      }

      const capturesByCategory: Partial<Record<CaptureCategory, number>> = {};
      for (const capture of captures) {
        const cat = capture.category as CaptureCategory;
        capturesByCategory[cat] = (capturesByCategory[cat] ?? 0) + 1;
      }

      // Calculate duration
      const startedAt = new Date(session.started_at);
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const durationMinutes = Math.round(durationMs / 60000);

      const now = completedAt.toISOString();

      // Update the session
      const updateResult = client.execute(
        `UPDATE sessions
         SET status = 'completed',
             completed_at = ?,
             summary = ?,
             next_steps = ?
         WHERE id = ?`,
        [
          now,
          summary,
          nextSteps && nextSteps.length > 0 ? JSON.stringify(nextSteps) : null,
          sessionId,
        ]
      );

      if (!updateResult.success) {
        return createError<CmosSessionCompleteResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to complete session: ${updateResult.error?.message ?? 'Unknown error'}`,
          suggestion: 'Check database permissions',
        });
      }

      // Insert session event
      const rawEvent = JSON.stringify({
        ts: now,
        agent,
        session: sessionId,
        action: 'complete',
        status: 'completed',
        summary,
        nextSteps,
      });

      checkWrite(
        client.execute(
          `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
           VALUES (?, ?, ?, 'complete', 'completed', ?, ?, ?)`,
          [now, agent, sessionId, summary, nextSteps?.join('; ') ?? null, rawEvent]
        ),
        warnings,
        'session completion event logging'
      );

      // ============================================================
      // Extract next-steps to structured next_steps table
      // ============================================================
      //
      // s85-m04 ORDERING (deliberate, do not swap back). Both loops below dedup on
      // (content_hash, session_id). The capture-sourced loop carries a per-capture
      // `missionId`; the nextSteps[] param loop carries only the call-level one. When the same
      // text arrives through BOTH inputs, whichever loop runs FIRST wins and the other hits
      // `continue`. Previously the unstamped param loop ran first, so identical text let an
      // unstamped row shadow its stamped twin. The mission-bearing loop now runs first.
      //
      // Verified in code; NOT verified as an observed live defect — next_steps has exactly one
      // stamped row in the whole table, so there is nothing to observe it against.
      //
      // Accepted side effect: genesisColumns assigns origin_seq as per-table MAX+1, so
      // reordering changes which row gets which origin_seq within a single call. origin_seq is
      // only a tiebreaker in the cross-store merge key and both orderings are equally valid
      // within one call — noted so a reviewer does not read it as a regression.
      let nextStepsExtracted = 0;

      // (a) capture-sourced next-steps FIRST — these can carry a per-capture missionId.
      for (const capture of captures) {
        if (capture.category === 'next-step' && capture.content) {
          const trimmed = capture.content.trim();
          if (!trimmed) continue;
          ensureNextStepsTable(client);
          const hash = computeContentHash(trimmed, 'next-step');
          const existing = client.getOne<{ id: number }>(
            `SELECT id FROM next_steps WHERE content_hash = ? AND session_id = ?`,
            [hash, sessionId]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `next-step de-duplication check failed (next_steps); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          // Per-capture missionId WINS over the call-level default: the capture stated which
          // mission it belongs to, which is strictly better information.
          const captureMissionId =
            (capture as { missionId?: string }).missionId ?? callMissionId ?? null;
          const g = genesisColumns(client, 'next_steps', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO next_steps (content, status, session_id, sprint_id, mission_id, created_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'pending', ?, ?, ?, ?, ?, ${g.placeholders})`,
            [
              trimmed,
              sessionId,
              session.sprint_id ?? null,
              captureMissionId,
              now,
              hash,
              ...g.values,
            ]
          );
          if (checkWrite(insertResult, writeSink, 'next_steps extraction insert'))
            nextStepsExtracted++;
        }
      }

      // (b) the nextSteps[] param. s85-m04: this INSERT omitted mission_id from its column
      // list ENTIRELY — one of the two literal SQL omissions behind #487. It now stamps the
      // call-level missionId, matching the shape of the capture-sourced insert above.
      if (nextSteps && nextSteps.length > 0) {
        ensureNextStepsTable(client);
        for (const step of nextSteps) {
          const trimmed = step.trim();
          if (!trimmed) continue;
          const hash = computeContentHash(trimmed, 'next-step');
          // Dedup: skip if same content already exists as pending for this session
          const existing = client.getOne<{ id: number }>(
            `SELECT id FROM next_steps WHERE content_hash = ? AND session_id = ?`,
            [hash, sessionId]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `next-step de-duplication check failed (next_steps); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          const g = genesisColumns(client, 'next_steps', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO next_steps (content, status, session_id, sprint_id, mission_id, created_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'pending', ?, ?, ?, ?, ?, ${g.placeholders})`,
            [
              trimmed,
              sessionId,
              session.sprint_id ?? null,
              callMissionId ?? null,
              now,
              hash,
              ...g.values,
            ]
          );
          if (checkWrite(insertResult, writeSink, 'next_steps extraction insert'))
            nextStepsExtracted++;
        }
      }

      // ============================================================
      // Extract constraints to structured constraints table
      // ============================================================
      let constraintsExtracted = 0;
      for (const capture of captures) {
        if (capture.category === 'constraint' && capture.content) {
          const trimmed = capture.content.trim();
          if (!trimmed) continue;
          ensureConstraintsTable(client);
          const hash = computeContentHash(trimmed, 'constraint');
          // Dedup: skip if same content already active
          const existing = client.getOne<{ id: number }>(
            `SELECT id FROM constraints WHERE content_hash = ? AND status = 'active'`,
            [hash]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `constraint de-duplication check failed (constraints); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          const expiresAt = (capture as { expiresAt?: string }).expiresAt ?? null;
          const g = genesisColumns(client, 'constraints', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO constraints (content, status, session_id, sprint_id, created_at, expires_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'active', ?, ?, ?, ?, ?, ${g.placeholders})`,
            [trimmed, sessionId, session.sprint_id ?? null, now, expiresAt, hash, ...g.values]
          );
          if (checkWrite(insertResult, writeSink, 'constraints extraction insert'))
            constraintsExtracted++;
        }
      }

      // ============================================================
      // Sprint 55 m02: Extract decisions to strategic_decisions
      // ============================================================
      // Two sources feed this block:
      //   (1) The `decisions[]` parameter passed to session-complete — the
      //       primary use case. These had no persistence path before the
      //       fix; OODS-Foundry-MCP retros lost entire decision corpora
      //       because cmos_decisions(list) couldn't surface them.
      //   (2) Decision-category captures already on the session. The
      //       capture path eagerly promotes these so the dedup SELECT will
      //       skip them, but the defensive second pass protects against
      //       captures that landed in session.captures without going
      //       through cmos_session_capture (e.g., future synthetic paths).
      //
      // Sprint_id is inherited from the session. project_domain is pulled
      // from the metadata table. Dedup is (decision_text, author_session_id) —
      // the same key cmos_session_capture uses. FTS5 is maintained by the
      // decisions_fts_insert trigger, so no explicit index work is needed.
      let decisionsExtracted = 0;
      const decisionSources: string[] = [...decisions];
      for (const capture of captures) {
        if (capture.category === 'decision' && typeof capture.content === 'string') {
          const trimmed = capture.content.trim();
          if (trimmed && !decisionSources.includes(trimmed)) decisionSources.push(trimmed);
        }
      }
      if (decisionSources.length > 0) {
        const domainResult = client.getOne<{ value: string }>(
          "SELECT value FROM metadata WHERE key = 'project_domain'",
          []
        );
        const projectDomain = domainResult.success ? (domainResult.data?.value ?? null) : null;
        // s69-m04 — settle the author_* rename before the dedup SELECT/INSERT below.
        // s86-m02b (fork f23): one of the six migration call sites whose warnings can reach a
        // rendered answer. A half-applied rename must not be silent.
        warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));
        // s85-m04 — DECISIONS-ONLY column guard. strategic_decisions.mission_id rides the v2.1
        // migration, so an un-migrated store lacks it and the INSERT below would throw
        // "no such column". learnings.mission_id and next_steps.mission_id are in the SEED BASE
        // schema, so they need no guard. Deliberately NOT a tableHasColumn conditional-omit:
        // that would silently drop the provenance this mission exists to add (decision #926 #3
        // bans silent fail-open). ensureStrategicDecisionsSchema is plain ALTER ADD COLUMN +
        // CREATE INDEX IF NOT EXISTS (no 12-step rebuild) and this handler opens no
        // transaction, so point-of-use is correct and needs no pre-BEGIN dance.
        ensureMissionIdColumn(client);
        for (const decisionText of decisionSources) {
          const existing = client.getOne<{ id: number }>(
            'SELECT id FROM strategic_decisions WHERE decision_text = ? AND author_session_id = ?',
            [decisionText, sessionId]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `decision de-duplication check failed (strategic_decisions); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          const g = genesisColumns(client, 'strategic_decisions', getProjectId(client));
          // s85-m04: mission_id was omitted from this column list entirely — the second of the
          // two SQL omissions behind #487. The call-level missionId applies UNIFORMLY here and
          // that is correct: decisionSources flattens the decisions[] param and
          // decision-category captures into a plain string[] before this loop, discarding any
          // per-capture missionId. Do NOT restructure decisionSources to recover it — the
          // capture path already promoted and stamped those rows, so they are normally skipped
          // by the dedup SELECT above; this is a defensive second pass.
          const insertResult = client.execute(
            `INSERT INTO strategic_decisions
               (decision_text, created_at, sprint_id, project_domain, author_session_id, mission_id, ${g.columns.join(', ')})
             VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
            [
              decisionText,
              now,
              session.sprint_id ?? null,
              projectDomain,
              sessionId,
              callMissionId ?? null,
              ...g.values,
            ]
          );
          if (checkWrite(insertResult, writeSink, 'strategic_decisions extraction insert')) {
            decisionsExtracted++;
            // Sprint 66 m03 — write-path embedding hook
            const newId = insertResult.data?.lastInsertRowid;
            const numericId =
              typeof newId === 'bigint' ? Number(newId) : typeof newId === 'number' ? newId : null;
            if (numericId !== null) {
              const embedResult = await recordEmbedding(client, {
                type: 'decision',
                id: numericId,
                inputText: decisionEmbeddingInput(decisionText),
              });
              warnings.push(...(embedResult.warnings ?? []));
            }
          }
        }
      }

      // ============================================================
      // Sprint 61 m01 — auto-reaffirm cited learnings.
      // Explicit IDs from `citesLearningIds[]` always bump. Implicit overlap
      // runs once per decision text; matches are merged before applying so
      // each learning is touched at most once per session-complete call.
      // ============================================================
      const explicitlyReaffirmedSet = new Set<number>();
      const implicitlyReaffirmedSet = new Set<number>();
      const missingCitedSet = new Set<number>();
      if (citesLearningIds.length > 0 || decisionSources.length > 0) {
        for (let i = 0; i < Math.max(decisionSources.length, 1); i++) {
          const decisionText = decisionSources[i] ?? '';
          // Apply explicit IDs only on the first pass; later passes use [] so
          // we don't repeatedly bump the same explicit set.
          const explicitForThisPass = i === 0 ? citesLearningIds : [];
          const reaffirm = await applyLearningReaffirm(client, {
            explicitIds: explicitForThisPass,
            newContent: decisionText,
            reaffirmedAt: now,
          });
          // s86-m02b: see the note in cmos-session-capture.ts — an errored lookup makes these
          // lists incomplete, and the answer must say so rather than imply a clean pass.
          writeSink.failures.push(...reaffirm.writeFailures);
          for (const id of reaffirm.explicitlyReaffirmedIds) {
            explicitlyReaffirmedSet.add(id);
          }
          for (const id of reaffirm.implicitlyReaffirmedIds) {
            // An ID already explicitly bumped this call should not also count as implicit.
            if (!explicitlyReaffirmedSet.has(id)) {
              implicitlyReaffirmedSet.add(id);
            }
          }
          for (const id of reaffirm.missingIds) {
            missingCitedSet.add(id);
          }
        }
      }

      // ============================================================
      // Context Aggregation (matches Python SessionRuntime behavior)
      // ============================================================
      const aggregation = aggregateSessionIntoContexts(
        client,
        {
          sessionId,
          sprintId: session.sprint_id,
          sessionType: session.type,
          sessionTitle: session.title,
          captures: captures as CaptureItem[],
          summary,
          completedAt: now,
          agent,
          nextSteps: nextSteps && nextSteps.length > 0 ? nextSteps : null,
        },
        writeSink
      );

      // Sprint closeout guardrail
      if (session.sprint_id) {
        const totalResult = client.getOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM missions WHERE sprint_id = ?',
          [session.sprint_id]
        );
        const remainingResult = client.getOne<{ count: number }>(
          "SELECT COUNT(*) as count FROM missions WHERE sprint_id = ? AND status != 'Completed'",
          [session.sprint_id]
        );
        if (
          totalResult.success &&
          remainingResult.success &&
          totalResult.data &&
          remainingResult.data &&
          totalResult.data.count > 0 &&
          remainingResult.data.count === 0
        ) {
          warnings.push(
            `All sprint missions are complete. Consider closing the sprint with cmos_sprint(action="complete").`
          );
        }
      }

      let feedbackId: number | undefined;
      if (params.agentFeedback && params.agentFeedback.trim().length > 0) {
        const fbResult = recordAgentFeedback(client, params.agentFeedback, {
          // s86-m03: was 'cmos_session_complete' — a tool name the server no longer publishes
          // (CMOS_TOOL_DEFINITIONS holds 15 entries and none is cmos_session_complete). Until this
          // sprint the site was unreachable, so no row ever carried it; forwarding agentFeedback
          // from the router without this change would have filed brand-new DURABLE rows stamped
          // with a retired tool — this sprint's own defect class, inside its own fix. The live
          // convention is the REGISTERED name (cmos-mission-complete.ts writes
          // 'cmos_mission_transition'; cmos-agent-onboard.ts writes 'cmos_agent_onboard').
          toolName: 'cmos_session',
          sessionId,
          sprintId: session.sprint_id ?? null,
        });
        if (fbResult.feedbackId !== null) {
          feedbackId = fbResult.feedbackId;
        }
        if (fbResult.sanitizedFields.length > 0) {
          sanitizedFields.push(...fbResult.sanitizedFields);
        }
        // s86-m02b: on a rejected agent_feedback INSERT, `feedbackId` is null and simply OMITTED
        // from the answer — so the caller is told nothing, and reasonably reads that as "recorded".
        // The producer records the DB error; this is the splice that lets it be read.
        warnings.push(...fbResult.warnings);
      }

      const explicitlyReaffirmedLearningIds =
        explicitlyReaffirmedSet.size > 0
          ? Array.from(explicitlyReaffirmedSet).sort((a, b) => a - b)
          : undefined;
      const implicitlyReaffirmedLearningIds =
        implicitlyReaffirmedSet.size > 0
          ? Array.from(implicitlyReaffirmedSet).sort((a, b) => a - b)
          : undefined;
      const missingCitedLearningIds =
        missingCitedSet.size > 0 ? Array.from(missingCitedSet).sort((a, b) => a - b) : undefined;

      return createSuccess<CmosSessionCompleteResult>(
        {
          sessionId,
          type: session.type,
          title: session.title,
          summary,
          completedAt: now,
          durationMinutes,
          captureCount: captures.length,
          capturesByCategory,
          nextSteps: nextSteps && nextSteps.length > 0 ? nextSteps : null,
          nextStepsExtracted,
          decisionsExtracted,
          constraintsExtracted,
          aggregation,
          message: `Session '${sessionId}' completed (${captures.length} captures, ${durationMinutes}min, ${nextStepsExtracted} next-steps extracted, ${decisionsExtracted} decisions extracted, ${constraintsExtracted} constraints extracted)`,
          writeFailures: writeSink.failures,
          ...(feedbackId !== undefined ? { feedbackId } : {}),
          ...(explicitlyReaffirmedLearningIds ? { explicitlyReaffirmedLearningIds } : {}),
          ...(implicitlyReaffirmedLearningIds ? { implicitlyReaffirmedLearningIds } : {}),
          ...(missingCitedLearningIds ? { missingCitedLearningIds } : {}),
        },
        warnings,
        sanitizedFields
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format session complete result for LLM readability.
 */
export function formatSessionCompleteForLLM(
  result: CmosToolResult<CmosSessionCompleteResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to complete session',
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
  const lines = [
    `✅ **Session Completed**`,
    '',
    `**Session**: ${data.sessionId}`,
    `**Type**: ${data.type}`,
    `**Title**: ${data.title}`,
    `**Duration**: ${data.durationMinutes} minutes`,
    `**Captures**: ${data.captureCount}`,
  ];

  // Add capture breakdown if any
  const categories = Object.entries(data.capturesByCategory);
  if (categories.length > 0) {
    lines.push('');
    lines.push('**Capture Breakdown**:');
    for (const [cat, count] of categories) {
      lines.push(`  - ${cat}: ${count}`);
    }
  }

  lines.push('');
  lines.push(`**Summary**: ${data.summary}`);

  if (data.nextSteps && data.nextSteps.length > 0) {
    lines.push('');
    lines.push('**Next Steps**:');
    for (const step of data.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  // Aggregation info
  if (data.aggregation?.contextsUpdated) {
    lines.push('');
    lines.push('**Context Aggregation**:');
    const routed = data.aggregation.capturesRouted;
    const routedEntries = Object.entries(routed).filter(([, v]) => v > 0);
    if (routedEntries.length > 0) {
      for (const [cat, count] of routedEntries) {
        lines.push(`  - ${cat}: ${count} routed to master_context`);
      }
    } else {
      lines.push('  - No captures to route');
    }
  }

  appendWriteFailures(lines, data.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}

// ============================================================
// Context Aggregation Helpers
// ============================================================

interface CaptureItem {
  category: string;
  content: string;
  timestamp?: string;
  context?: string;
}

interface AggregationParams {
  sessionId: string;
  sprintId: string | null;
  sessionType: string;
  sessionTitle: string;
  captures: CaptureItem[];
  summary: string;
  completedAt: string;
  agent: string;
  nextSteps: string[] | null;
}

interface AggregationResult {
  capturesRouted: Record<string, number>;
  contextsUpdated: boolean;
  projectSnapshotId: number | null;
  masterSnapshotId: number | null;
  condensation: {
    projectArchivedSprints: string[];
    masterArchivedSprints: string[];
    projectArchiveSnapshotId: number | null;
    masterArchiveSnapshotId: number | null;
  };
}

const VALID_CAPTURE_CATEGORIES = ['decision', 'learning', 'constraint', 'context', 'next-step'];

/**
 * Aggregate session captures into both contexts on session completion.
 * Matches Python SessionRuntime.complete_session() behavior.
 */
function aggregateSessionIntoContexts(
  client: CmosDatabaseClient,
  params: AggregationParams,
  sink: { failures: WriteFailure[] }
): AggregationResult {
  const {
    sessionId,
    sprintId,
    sessionType,
    sessionTitle,
    captures,
    summary,
    completedAt,
    agent,
    nextSteps,
  } = params;

  // Load both contexts
  const projectContext = loadContext(client, 'project_context');
  const masterContext = loadContext(client, 'master_context');
  const retentionPolicy = getContextRetentionPolicy();

  // Step 1: Apply captures to master_context
  const capturesRouted = applyCapturesToMaster(masterContext, captures, sessionId);

  // Step 2: Record session history in project_context
  recordSessionHistory(projectContext, {
    sessionId,
    sprintId,
    sessionType,
    ts: completedAt,
    agent,
    summary,
  });

  // Step 3: Append recent session to both contexts
  appendRecentSession(projectContext, {
    id: sessionId,
    sprintId,
    type: sessionType,
    title: sessionTitle,
    summary,
    completedAt,
    capturesRouted,
    underWorkingMemory: true,
    limit: 25,
  });
  // recent_sessions no longer stored in master_context blob.
  // Sessions are queryable from the sessions table (Sprint 51 blob reduction).

  // Step 4: Record next steps in both contexts
  if (nextSteps && nextSteps.length > 0) {
    recordNextSteps(projectContext, masterContext, sessionId, nextSteps);
  }

  // Step 5: Condense detail for completed sprints
  const projectCondensation = condenseContextForRetention(
    client,
    'project_context',
    projectContext,
    {
      source: `session_complete:${sessionId}`,
      policy: retentionPolicy,
    }
  );
  const masterCondensation = condenseContextForRetention(client, 'master_context', masterContext, {
    source: `session_complete:${sessionId}`,
    policy: retentionPolicy,
  });

  // Step 6: Update context health after condensation
  updateContextHealth(projectContext, completedAt, retentionPolicy);
  updateContextHealth(masterContext, completedAt, retentionPolicy);

  // Step 7: Persist both contexts with snapshots
  const projectPersist = persistContext(
    client,
    'project_context',
    projectContext,
    sessionId,
    `session_complete:${sessionId}`,
    sink
  );
  const masterPersist = persistContext(
    client,
    'master_context',
    masterContext,
    sessionId,
    `session_complete:${sessionId}`,
    sink
  );

  return {
    // s86-m02b: this was a hardcoded `true`. It now reports whether the CONTEXT ROWS were
    // written — not whether their snapshots were, which is a different fact carried by the
    // two snapshot ids beside it. The matching `writeFailures` entry names any failure.
    capturesRouted,
    contextsUpdated: projectPersist.contextWritten && masterPersist.contextWritten,
    projectSnapshotId: projectPersist.snapshotId,
    masterSnapshotId: masterPersist.snapshotId,
    condensation: {
      projectArchivedSprints: projectCondensation.archivedSprintIds,
      masterArchivedSprints: masterCondensation.archivedSprintIds,
      projectArchiveSnapshotId: projectCondensation.archiveSnapshotId,
      masterArchiveSnapshotId: masterCondensation.archiveSnapshotId,
    },
  };
}

/**
 * Load and parse a context from the database.
 */
function loadContext(client: CmosDatabaseClient, contextId: string): Record<string, unknown> {
  const result = client.getOne<Context>('SELECT id, content FROM contexts WHERE id = ?', [
    contextId,
  ]);

  if (result.success && result.data?.content) {
    try {
      return JSON.parse(result.data.content);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Route session captures to appropriate master_context arrays.
 * Matches Python _apply_captures_to_master().
 */
function applyCapturesToMaster(
  masterContext: Record<string, unknown>,
  captures: CaptureItem[],
  sessionId: string
): Record<string, number> {
  if (!captures.length) return {};

  const counts: Record<string, number> = {};
  // decisions_made and learnings are no longer stored in the blob.
  // They are queryable from strategic_decisions and learnings tables (Sprint 51 blob reduction).
  const constraints = ensureArray(masterContext, 'constraints');
  const notes = ensureArray(masterContext, 'context_notes');
  const nextSession = ensureObject(masterContext, 'next_session_context');
  const resume = ensureArray(nextSession, 'when_we_resume');

  for (const capture of captures) {
    const category = (capture.category || '').trim().toLowerCase();
    const content = (capture.content || '').trim();
    if (!content || !VALID_CAPTURE_CATEGORIES.includes(category)) continue;

    counts[category] = (counts[category] ?? 0) + 1;

    if (category === 'constraint') {
      if (!constraintExists(constraints, content)) {
        constraints.push(content);
      }
    } else if (category === 'context') {
      notes.push(content);
    } else if (category === 'next-step') {
      const entry = `${sessionId}: ${content}`;
      if (!resume.includes(entry)) {
        resume.push(entry);
        if (resume.length > 25) resume.splice(0, resume.length - 25);
      }
    }
  }

  return counts;
}

/**
 * Record session in project_context.working_memory.session_history.
 * Matches Python _record_session_history().
 */
function recordSessionHistory(
  projectContext: Record<string, unknown>,
  opts: {
    sessionId: string;
    sprintId: string | null;
    sessionType: string;
    ts: string;
    agent: string;
    summary: string;
  }
): void {
  const working = ensureObject(projectContext, 'working_memory');
  const history = ensureArray(working, 'session_history');

  history.push({
    session: opts.sessionId,
    sprint_id: opts.sprintId,
    session_type: opts.sessionType,
    agent: opts.agent,
    summary: opts.summary,
    action: 'complete',
    ts: opts.ts,
  });

  if (history.length > 50) history.splice(0, history.length - 50);
  working['last_session'] = opts.ts;
}

/**
 * Append session metadata to context.
 * Matches Python _append_recent_session().
 */
function appendRecentSession(
  context: Record<string, unknown>,
  opts: {
    id: string;
    sprintId: string | null;
    type: string;
    title: string;
    summary: string;
    completedAt: string;
    capturesRouted: Record<string, number>;
    underWorkingMemory: boolean;
    targetKey?: string;
    limit: number;
  }
): void {
  const parent = opts.underWorkingMemory ? ensureObject(context, 'working_memory') : context;
  const key = opts.targetKey ?? 'recent_sessions';
  const container = ensureArray(parent, key);

  const captureCount = Object.values(opts.capturesRouted).reduce((a, b) => a + b, 0);
  const sanitizedCaptures: Record<string, number> = {};
  for (const [k, v] of Object.entries(opts.capturesRouted)) {
    if (v > 0) sanitizedCaptures[k] = v;
  }

  const entry: Record<string, unknown> = {
    id: opts.id,
    sprint_id: opts.sprintId,
    session_type: opts.type,
    type: opts.type,
    title: opts.title,
    summary: opts.summary,
    completed_at: opts.completedAt,
    capture_count: captureCount,
  };
  if (Object.keys(sanitizedCaptures).length > 0) {
    entry['captures'] = sanitizedCaptures;
  }

  container.push(entry);
  if (container.length > opts.limit) container.splice(0, container.length - opts.limit);
}

/**
 * Record next steps in both contexts.
 * Matches Python _record_next_steps().
 */
function recordNextSteps(
  projectContext: Record<string, unknown>,
  masterContext: Record<string, unknown>,
  sessionId: string,
  nextSteps: string[]
): void {
  const cleaned = nextSteps.map((s) => s.trim()).filter(Boolean);
  if (!cleaned.length) return;

  // Project context: working_memory.next_steps
  const working = ensureObject(projectContext, 'working_memory');
  const todo = ensureArray(working, 'next_steps');
  for (const note of cleaned) {
    const entry = `${sessionId}: ${note}`;
    if (!todo.includes(entry)) todo.push(entry);
  }
  if (todo.length > 25) todo.splice(0, todo.length - 25);

  // Master context: next_session_context.when_we_resume
  const nextSession = ensureObject(masterContext, 'next_session_context');
  const resume = ensureArray(nextSession, 'when_we_resume');
  for (const note of cleaned) {
    const entry = `${sessionId}: ${note}`;
    if (!resume.includes(entry)) resume.push(entry);
  }
  if (resume.length > 25) resume.splice(0, resume.length - 25);
}

/**
 * Update context health metrics.
 * Matches Python _update_context_health().
 */
function updateContextHealth(
  context: Record<string, unknown>,
  ts: string,
  policy: ContextRetentionPolicy
): void {
  const health = ensureObject(context, 'context_health');
  health['sessions_since_reset'] = (Number(health['sessions_since_reset']) || 0) + 1;
  health['last_update'] = ts;
  const serialized = JSON.stringify(context);
  health['size_kb'] =
    Math.round((new TextEncoder().encode(serialized).byteLength / 1024) * 100) / 100;
  health['size_limit_kb'] = Number(health['size_limit_kb']) || policy.sizeLimitKb;
  health['warning_threshold_percent'] =
    Number(health['warning_threshold_percent']) || policy.warningThresholdPercent;
  health['retention_keep_sprints'] =
    Number(health['retention_keep_sprints']) || policy.keepDetailSprints;
}

/**
 * Persist a context to the database and create a snapshot.
 */
function persistContext(
  client: CmosDatabaseClient,
  contextId: string,
  content: Record<string, unknown>,
  sessionId: string,
  snapshotSource: string,
  sink: { failures: WriteFailure[] }
): { snapshotId: number | null; contextWritten: boolean } {
  const now = new Date().toISOString();
  const contentStr = JSON.stringify(content);

  // Check if context exists
  const existing = client.getOne<{ id: string }>('SELECT id FROM contexts WHERE id = ?', [
    contextId,
  ]);

  // s86-m02b, THE READ HALF (fork f10, non-cuttable): a FAILED existence SELECT used to take the
  // INSERT arm against a row that already exists — turning a transient read error into a
  // constraint violation on a path that then reported success. Read failure is now its own case:
  // we do not guess which arm is right, we decline to write and say so.
  if (!existing.success) {
    sink.failures.push({
      op: `contexts.persist(${contextId})`,
      code: existing.error?.code ?? 'DB_ERROR',
      message:
        `could not determine whether the context row exists, so neither UPDATE nor INSERT was ` +
        `attempted: ${existing.error?.message ?? 'unknown'}`,
    });
    return { snapshotId: null, contextWritten: false };
  }

  // WHETHER THE CONTEXT ROW LANDED IS A SEPARATE QUESTION FROM WHETHER THE SNAPSHOT DID, and
  // conflating them was a false negative in the opposite direction: deriving `contextsUpdated`
  // from the snapshot id reported "contexts not updated" for a run whose contexts WERE durably
  // written and whose snapshot merely failed. Two facts, two fields.
  let contextWritten: boolean;

  if (existing.data) {
    // s86-m02b, THE WRITE HALF: this was a bare execute. On failure the function went on to write
    // a snapshot and return its id, so the answer reported a persisted context and a snapshot id
    // for content that was never stored — the single largest durable-loss site in the class.
    contextWritten = checkWrite(
      client.execute('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?', [
        contentStr,
        now,
        contextId,
      ]),
      sink,
      `contexts.update(${contextId})`
    );
  } else {
    const sourcePath =
      contextId === 'master_context'
        ? 'context/MASTER_CONTEXT.json'
        : 'context/PROJECT_CONTEXT.json';
    contextWritten = checkWrite(
      client.execute(
        'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
        [contextId, sourcePath, contentStr, now]
      ),
      sink,
      `contexts.insert(${contextId})`
    );
  }

  // DELIBERATELY NOT AN EARLY RETURN. Before s86-m02b a failed context write still fell through
  // to the snapshot INSERT, and that snapshot was the only durable copy of the aggregated
  // content — recoverable later via cmos_context(history). Returning here would have made the
  // answer honest by DESTROYING data the old code preserved, which is a worse trade. The write
  // failure is already recorded above; the snapshot still gets its chance.

  // Create snapshot with dedup
  const contentHash = crypto.createHash('sha256').update(contentStr).digest('hex').substring(0, 16);
  const existingSnapshot = client.getOne<{ id: number }>(
    // s84-m04: exclude a content-tombstoned row so identical content re-persists fresh.
    `SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}`,
    [contextId, contentHash]
  );

  // The snapshot dedup is the BENIGN direction of the same read defect (noted in fork f10 and
  // deliberately left alone): a failed dedup falls through to INSERT, producing a duplicate
  // snapshot rather than losing one. Disclosed, not "fixed".
  if (!existingSnapshot.success) {
    sink.failures.push({
      op: `context_snapshots.dedup(${contextId})`,
      code: existingSnapshot.error?.code ?? 'DB_ERROR',
      message: `snapshot de-duplication check failed; a duplicate snapshot may have been written: ${
        existingSnapshot.error?.message ?? 'unknown'
      }`,
    });
  } else if (existingSnapshot.data) {
    return { snapshotId: existingSnapshot.data.id, contextWritten };
  }

  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextId, sessionId, snapshotSource, contentHash, contentStr, now, ...g.values]
  );

  if (!checkWrite(insertResult, sink, `context_snapshots.insert(${contextId})`)) {
    return { snapshotId: null, contextWritten };
  }
  return { snapshotId: Number(insertResult.data?.lastInsertRowid), contextWritten };
}

// ---- Utility helpers ----

function ensureArray(obj: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key] as unknown[];
}

function ensureObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
    obj[key] = {};
  }
  return obj[key] as Record<string, unknown>;
}

function constraintExists(existing: unknown[], candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  return existing.some(
    (item) => typeof item === 'string' && item.trim().toLowerCase() === normalized
  );
}
