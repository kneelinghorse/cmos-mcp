/**
 * cmos_session_capture Tool
 *
 * MCP tool for capturing insights during an active session.
 * Supports categories: decision, learning, constraint, context, next-step.
 *
 * @module tools/cmos/cmos-session-capture
 */

import { z } from 'zod';
import { withClientAsync } from './client';
import type { CmosToolResult, Session } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { sanitizeContentField, type SanitizedField } from '../../intelligence/content-sanitizer';
import { ensureMissionIdColumn } from './cmos-mission-complete';
import { genesisColumns, getProjectId } from './genesis-columns';
import { resolveOpenSprintIdForWrite } from './current-sprint';
import {
  ensureLearningsTable,
  ensureSessionMissionsTable,
  ensureConstraintsTable,
  ensureAuthorNamespaceColumns,
  computeContentHash,
} from './schema-migrations';
import { detectSupersessionCandidates, type SupersessionCandidate } from './supersession-detection';
import { applyLearningReaffirm, sanitizeLearningIds } from './learning-reaffirm';
import {
  recordEmbedding,
  decisionEmbeddingInput,
  learningEmbeddingInput,
} from '../../intelligence/embedding-pipeline';
import { appendWarnings, appendWriteFailures } from './format-warnings';
import { checkWrite, type WriteFailure } from './write-guard';

/**
 * Valid capture categories matching the Python session_runtime.
 */
export const VALID_CAPTURE_CATEGORIES = [
  'decision',
  'learning',
  'constraint',
  'context',
  'next-step',
] as const;

export type CaptureCategory = (typeof VALID_CAPTURE_CATEGORIES)[number];

/**
 * Result of session capture operation.
 */
export interface CmosSessionCaptureResult {
  /** Session ID the capture was added to */
  sessionId: string;

  /** Category of the capture */
  category: CaptureCategory;

  /** Content of the capture */
  content: string;

  /** When the capture was recorded */
  timestamp: string;

  /** Total captures in the session after this one */
  captureCount: number;

  /** Message describing the result */
  message: string;

  /**
   * s86-m02b — writes this capture ATTEMPTED and the database REJECTED. Always present, `[]` on
   * the happy path. The extraction flags above report what actually landed.
   */
  writeFailures: WriteFailure[];

  /** Associated mission ID (when missionId was provided) */
  missionId?: string;

  /** Number of decisions extracted (present for decision category captures) */
  decisionExtractionCount?: number;

  /** Whether the decision was already extracted (present for decision category captures) */
  decisionAlreadyExtracted?: boolean;

  /**
   * s86-m02b — THE THIRD STATE. Present ONLY when the strategic_decisions INSERT was attempted
   * and the database REJECTED it, carrying the DB error verbatim.
   *
   * There have always been two reported outcomes — "already exists" and "auto-extracted (n)" —
   * and an `else` arm (present since Sprint 20) that set count=0 + alreadyExtracted=false on a
   * FAILED insert. The formatter rendered that pair as "Decision Extraction: Extraction skipped".
   * Nothing was skipped; an INSERT errored, and the answer positively asserted a false event.
   * A third state is the fix — not a new branch, since the branch already existed.
   */
  decisionExtractionFailed?: string;

  /** Source chunk IDs for decision provenance tracking */
  sourceChunkIds?: string[];

  /** Evidence references stored with the decision */
  evidenceStored?: Array<{ type: string; id: string }>;

  /**
   * Whether a learning was extracted to the learnings table.
   * s86-m02b: `false` now means ONLY "a duplicate already existed". A failed INSERT is reported
   * through `writeFailures` instead of collapsing into this flag, which used to mean both.
   */
  learningExtracted?: boolean;

  /**
   * Whether a constraint was extracted to the constraints table.
   * s86-m02b: same split as `learningExtracted` — `false` means duplicate, never "errored".
   */
  constraintExtracted?: boolean;

  /** Supersession candidates detected for this decision */
  supersessionCandidates?: SupersessionCandidate[];

  /** Human-readable supersession suggestion */
  supersessionMessage?: string;

  /**
   * Learning IDs whose `last_reviewed_at` was bumped because the caller
   * passed them in `citesLearningIds[]`. Sprint 61 m01.
   */
  explicitlyReaffirmedLearningIds?: number[];

  /**
   * Learning IDs whose `last_reviewed_at` was bumped because the new capture's
   * content overlapped them by at least IMPLICIT_REAFFIRM_KEYWORD_FLOOR keywords.
   * Sprint 61 m01.
   */
  implicitlyReaffirmedLearningIds?: number[];

  /**
   * Learning IDs the caller passed in `citesLearningIds[]` that did not
   * resolve to existing rows. Sprint 61 m01.
   */
  missingCitedLearningIds?: number[];
}

/**
 * Input parameters schema for cmos_session_capture tool.
 */
export const cmosSessionCaptureSchema = z.object({
  /** Session ID to capture to (optional - uses active session if not provided) */
  sessionId: z
    .string()
    .optional()
    .describe('Session ID to add capture to (uses active session if not provided)'),

  /** Capture category */
  category: z
    .enum(VALID_CAPTURE_CATEGORIES)
    .describe('Category: decision, learning, constraint, context, or next-step'),

  /** Content to capture */
  content: z.string().min(1).max(1000).describe('The insight to capture (1-1000 characters)'),

  /** Optional context/reason for the capture */
  context: z.string().max(500).optional().describe('Optional context or reason for this capture'),

  /** Optional mission ID to associate this capture with */
  missionId: z
    .string()
    .optional()
    .describe(
      'Associate this capture with a specific mission (creates strategic_decisions when category=decision)'
    ),

  /** Optional evidence references for decision captures */
  evidence: z
    .array(
      z.object({
        type: z.string().min(1).describe('Evidence type (e.g. "collection", "document", "chunk")'),
        id: z
          .string()
          .min(1)
          .describe('Evidence identifier (e.g. TraceLab collection/document ID)'),
      })
    )
    .optional()
    .describe('Array of TraceLab evidence references [{type, id}] to link with a decision capture'),

  /** Optional expiry date for constraint captures (ISO 8601) */
  expiresAt: z
    .string()
    .optional()
    .describe(
      'Optional expiry date for constraint captures (ISO 8601, e.g. "2026-03-20T00:00:00Z")'
    ),

  /** Optional agent name */
  agent: z
    .string()
    .default('assistant')
    .optional()
    .describe('Agent making the capture (default: "assistant")'),

  /**
   * Optional explicit list of learning IDs this capture cites. When set, those
   * learnings get their `last_reviewed_at` bumped to now — keeping still-true
   * institutional rules out of the staleness pile (Sprint 61 m01).
   */
  citesLearningIds: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Learning IDs this capture cites. Bumps last_reviewed_at on each — applies to category=decision|learning.'
    ),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSessionCaptureParams = z.infer<typeof cmosSessionCaptureSchema>;

/**
 * MCP Tool Definition for cmos_session_capture.
 */
export const cmosSessionCaptureToolDefinition = {
  name: 'cmos_session_capture',
  description:
    'Capture an insight during an active session. Categories: decision (choices made), learning (what was learned), constraint (limitations discovered), context (background info), next-step (action items). Captures are aggregated into master context when the session completes.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID to add capture to (uses active session if not provided)',
      },
      category: {
        type: 'string',
        enum: VALID_CAPTURE_CATEGORIES,
        description: 'Category: decision, learning, constraint, context, or next-step',
      },
      content: {
        type: 'string',
        description: 'The insight to capture (1-1000 characters)',
        minLength: 1,
        maxLength: 1000,
      },
      context: {
        type: 'string',
        description: 'Optional context or reason for this capture',
        maxLength: 500,
      },
      missionId: {
        type: 'string',
        description:
          'Associate this capture with a specific mission (creates strategic_decisions when category=decision)',
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Evidence type (e.g. "collection", "document", "chunk")',
            },
            id: {
              type: 'string',
              description: 'Evidence identifier (e.g. TraceLab collection/document ID)',
            },
          },
          required: ['type', 'id'],
        },
        description:
          'Array of TraceLab evidence references [{type, id}] to link with a decision capture',
      },
      expiresAt: {
        type: 'string',
        description:
          'Optional expiry date for constraint captures (ISO 8601, e.g. "2026-03-20T00:00:00Z")',
      },
      agent: {
        type: 'string',
        description: 'Agent making the capture (default: "assistant")',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'Learning IDs this capture cites. Bumps last_reviewed_at on each — applies to category=decision|learning.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['category', 'content'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_session_capture tool.
 *
 * Adds a capture to an active session. If sessionId is not provided,
 * uses the currently active session.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with capture info or actionable error
 */
export async function cmosSessionCapture(
  params: CmosSessionCaptureParams
): Promise<CmosToolResult<CmosSessionCaptureResult>> {
  // Validate parameters
  if (!params.content || params.content.trim() === '') {
    return createError(CmosErrors.missingParameter('content'));
  }

  const category = params.category;
  const sanitizedFields: SanitizedField[] = [];
  const contentSan = sanitizeContentField(params.content.trim());
  if (contentSan.wasModified) {
    sanitizedFields.push({ field: 'content', reason: contentSan.reason ?? '' });
  }
  const content = contentSan.cleaned;
  const rawCaptureContext = params.context?.trim() ?? null;
  let captureContext = rawCaptureContext;
  if (rawCaptureContext) {
    const ctxSan = sanitizeContentField(rawCaptureContext);
    if (ctxSan.wasModified) {
      sanitizedFields.push({ field: 'context', reason: ctxSan.reason ?? '' });
      captureContext = ctxSan.cleaned;
    }
  }
  const citesLearningIdsSan = sanitizeLearningIds(
    'citesLearningIds',
    params.citesLearningIds as readonly unknown[] | undefined
  );
  sanitizedFields.push(...citesLearningIdsSan.sanitizedFields);
  const citesLearningIds = citesLearningIdsSan.cleaned;
  const agent = params.agent ?? 'assistant';

  return withClientAsync(
    async (client) => {
      // s86-m02b — SINK HOISTING. `warnings` was declared ~400 lines below, AFTER the decision
      // INSERT, the learning arm and the constraint arm. Wiring their failures into it required
      // moving the declaration here; the alternative — a second array — is explicitly forbidden.
      const warnings: string[] = [];
      // Writes attempted and rejected. Distinct from `warnings` (fork f09): a lost decision must
      // not be buried beside "you forgot missionId".
      const writeSink = { failures: [] as WriteFailure[] };

      // Find the session to capture to
      let sessionId = params.sessionId;

      if (!sessionId) {
        // Find the active session
        const activeResult = client.getOne<Session>('SELECT id FROM sessions WHERE status = ?', [
          'active',
        ]);

        if (!activeResult.success) {
          return createError<CmosSessionCaptureResult>(
            activeResult.error ?? {
              code: 'DB_QUERY_FAILED',
              message: 'Failed to find active session',
            }
          );
        }

        if (!activeResult.data) {
          return createError<CmosSessionCaptureResult>({
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
        'SELECT id, status, captures, sprint_id FROM sessions WHERE id = ?',
        [sessionId]
      );

      if (!sessionResult.success) {
        return createError<CmosSessionCaptureResult>(
          sessionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query session' }
        );
      }

      if (!sessionResult.data) {
        return createError<CmosSessionCaptureResult>(CmosErrors.sessionNotFound(sessionId));
      }

      const session = sessionResult.data;

      if (session.status !== 'active') {
        return createError<CmosSessionCaptureResult>(CmosErrors.sessionNotActive(sessionId));
      }

      // Parse existing captures
      let captures: Array<{
        timestamp: string;
        category: string;
        content: string;
        context?: string;
      }> = [];
      try {
        captures = session.captures ? JSON.parse(session.captures) : [];
      } catch {
        captures = [];
      }

      // Add new capture
      const now = new Date().toISOString();
      const missionId = params.missionId?.trim() || undefined;
      const newCapture: {
        timestamp: string;
        category: string;
        content: string;
        context?: string;
        missionId?: string;
        expiresAt?: string;
      } = {
        timestamp: now,
        category,
        content,
      };
      if (captureContext) {
        newCapture.context = captureContext;
      }
      if (missionId) {
        newCapture.missionId = missionId;
      }
      // s86-m03: the SECOND of expiresAt's two independent drops. The direct-write path below
      // already reads `params.expiresAt` into the constraints INSERT, so forwarding the router
      // param alone makes THAT leg work — while cmos-session-complete.ts:589, which extracts
      // `expiresAt` off this stored capture blob to build the constraint at session close, stays
      // permanently undefined. A test exercising only capture would report the bug fixed.
      if (params.expiresAt) {
        newCapture.expiresAt = params.expiresAt;
      }
      captures.push(newCapture);

      // Update the session
      const updateResult = client.execute('UPDATE sessions SET captures = ? WHERE id = ?', [
        JSON.stringify(captures),
        sessionId,
      ]);

      if (!updateResult.success) {
        return createError<CmosSessionCaptureResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to save capture: ${updateResult.error?.message ?? 'Unknown error'}`,
          suggestion: 'Check database permissions',
        });
      }

      // Insert session event
      const summary = `[${category}] ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`;
      const rawEvent = JSON.stringify({
        ts: now,
        agent,
        session: sessionId,
        action: 'capture',
        category,
        status: 'active',
        summary,
        missionId,
      });

      checkWrite(
        client.execute(
          `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
           VALUES (?, ?, ?, 'capture', 'active', ?, ?, ?)`,
          [now, agent, sessionId, summary, captureContext, rawEvent]
        ),
        warnings,
        'capture event logging'
      );

      // Track session→mission association when missionId is provided
      if (missionId) {
        ensureSessionMissionsTable(client);
        // INSERT OR IGNORE: idempotent — won't duplicate if already linked
        checkWrite(
          client.execute(
            `INSERT OR IGNORE INTO session_missions (session_id, mission_id, linked_at, source)
             VALUES (?, ?, ?, 'capture')`,
            [sessionId, missionId, now]
          ),
          warnings,
          'session-to-mission association'
        );
      }

      // Decision extraction with mission association
      const resultData: CmosSessionCaptureResult = {
        sessionId,
        category,
        content,
        timestamp: now,
        captureCount: captures.length,
        message: `Captured ${category} in session '${sessionId}' (${captures.length} total captures)`,
        writeFailures: writeSink.failures,
      };

      if (missionId) {
        resultData.missionId = missionId;
      }

      if (category === 'decision') {
        // Ensure mission_id column exists for decision association
        if (missionId) {
          ensureMissionIdColumn(client);
        }

        // Get sprint_id from session or mission
        let sprintId: string | null = null;
        if (missionId) {
          const missionResult = client.getOne<{ sprint_id: string | null }>(
            'SELECT sprint_id FROM missions WHERE id = ?',
            [missionId]
          );
          sprintId = missionResult.success ? (missionResult.data?.sprint_id ?? null) : null;
        }
        if (!sprintId) {
          sprintId = session.sprint_id ?? inferSprintIdForDecisionCapture(client);
        }

        // Get project_domain from metadata
        const domainResult = client.getOne<{ value: string }>(
          "SELECT value FROM metadata WHERE key = 'project_domain'",
          []
        );
        const projectDomain = domainResult.success ? (domainResult.data?.value ?? null) : null;

        // s69-m04 — settle the author_* rename (session_id → author_session_id)
        // BEFORE the dedup SELECT/INSERT below so both reference the live column
        // name. Marker-gated fast no-op once applied; the later genesisColumns call
        // would also run it, but that is after this dedup query.
        // s86-m02b (fork f23): a half-applied rename must not be silent.
        warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));

        // Check for duplicate
        const existingResult = client.getOne<{ id: number }>(
          'SELECT id FROM strategic_decisions WHERE decision_text = ? AND author_session_id = ?',
          [content, sessionId]
        );

        if (existingResult.success && existingResult.data) {
          resultData.decisionAlreadyExtracted = true;
          resultData.decisionExtractionCount = 0;
        } else {
          // Build dynamic column list
          const columns = [
            'decision_text',
            'created_at',
            'sprint_id',
            'project_domain',
            'author_session_id',
          ];
          const insertParams: unknown[] = [content, now, sprintId, projectDomain, sessionId];

          if (missionId) {
            columns.push('mission_id');
            insertParams.push(missionId);
          }

          // Serialize and store evidence if provided
          const evidenceArray = params.evidence;
          const evidenceJson =
            evidenceArray && evidenceArray.length > 0 ? JSON.stringify(evidenceArray) : null;
          if (evidenceJson) {
            columns.push('evidence');
            insertParams.push(evidenceJson);
          }

          // s69-m03 — stamp the per-row genesis columns into the dynamic list.
          const genesis = genesisColumns(client, 'strategic_decisions', getProjectId(client));
          columns.push(...genesis.columns);
          insertParams.push(...genesis.values);

          const insertColumns = columns.join(', ');
          const insertPlaceholders = columns.map(() => '?').join(', ');

          const insertResult = client.execute(
            `INSERT INTO strategic_decisions (${insertColumns}) VALUES (${insertPlaceholders})`,
            insertParams
          );

          // s86-m02b: routed through checkWrite rather than tested positively, so the DISCHARGE
          // is attributable to THIS binding. `insertResult` is reused by the learning and
          // constraint arms below; under a name-keyed rule their checkWrite calls silently
          // satisfied this site too, and reverting this arm to the old lie left the gate green.
          if (checkWrite(insertResult, writeSink, 'strategic_decisions.insert')) {
            resultData.decisionExtractionCount = 1;
            resultData.decisionAlreadyExtracted = false;
            if (evidenceArray && evidenceArray.length > 0) {
              resultData.evidenceStored = evidenceArray;
            }

            // Detect potential supersession candidates
            const newDecisionId =
              typeof insertResult.data?.lastInsertRowid === 'number'
                ? insertResult.data.lastInsertRowid
                : typeof insertResult.data?.lastInsertRowid === 'bigint'
                  ? Number(insertResult.data.lastInsertRowid)
                  : undefined;

            const suggestion = await detectSupersessionCandidates(client, content, newDecisionId);

            if (suggestion.candidates.length > 0) {
              resultData.supersessionCandidates = suggestion.candidates;
              resultData.supersessionMessage = suggestion.message ?? undefined;
            }

            // Sprint 66 m03 — write-path embedding hook
            if (newDecisionId !== undefined) {
              const embedResult = await recordEmbedding(client, {
                type: 'decision',
                id: newDecisionId,
                inputText: decisionEmbeddingInput(content),
              });
              warnings.push(...(embedResult.warnings ?? []));
            }
          } else {
            // s86-m02b — THE FLAGSHIP FIX. This arm has existed since Sprint 20 and set
            // count=0 + alreadyExtracted=false, which the formatter rendered as
            // "Extraction skipped". Nothing was skipped: the INSERT errored and a strategic
            // decision was LOST while the answer reported a clean, uneventful capture.
            resultData.decisionExtractionCount = 0;
            resultData.decisionAlreadyExtracted = false;
            resultData.decisionExtractionFailed = `${insertResult.error?.code ?? 'DB_ERROR'}: ${
              insertResult.error?.message ?? 'unknown'
            }`;
          }
        }
      }

      let newlyInsertedLearningId: number | undefined;
      if (category === 'learning') {
        // Ensure learnings table exists
        ensureLearningsTable(client);

        // Get sprint_id from session or mission
        let sprintId: string | null = null;
        if (missionId) {
          const missionResult = client.getOne<{ sprint_id: string | null }>(
            'SELECT sprint_id FROM missions WHERE id = ?',
            [missionId]
          );
          sprintId = missionResult.success ? (missionResult.data?.sprint_id ?? null) : null;
        }
        if (!sprintId) {
          sprintId = session.sprint_id ?? inferSprintIdForDecisionCapture(client);
        }

        // s69-m04 — settle the author_* rename before the dedup SELECT/INSERT.
        // s86-m02b (fork f23): a half-applied rename must not be silent.
        warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));

        // Check for duplicate
        const existingLearning = client.getOne<{ id: number }>(
          'SELECT id FROM learnings WHERE content = ? AND author_session_id = ?',
          [content, sessionId]
        );

        // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and
        // falls through to the INSERT. Behaviour UNCHANGED — a duplicate learning is recoverable
        // and detectable, unlike a lost write — but the operator is told.
        if (!existingLearning.success) {
          warnings.push(
            `learning de-duplication check failed; a duplicate row may have been written: ` +
              `${existingLearning.error?.code ?? 'DB_ERROR'} — ${existingLearning.error?.message ?? 'unknown'}`
          );
        }

        if (!existingLearning.success || !existingLearning.data) {
          const g = genesisColumns(client, 'learnings', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO learnings (content, category, status, sprint_id, author_session_id, mission_id, created_at, ${g.columns.join(', ')})
             VALUES (?, ?, 'active', ?, ?, ?, ?, ${g.placeholders})`,
            [content, null, sprintId, sessionId, missionId ?? null, now, ...g.values]
          );
          // s86-m02b: `learningExtracted` used to be the INSERT's success flag, so `false` meant
          // BOTH "a duplicate already existed" (the else arm below) and "the INSERT errored".
          // The error case now has its own channel and the flag means only what it says.
          resultData.learningExtracted = checkWrite(insertResult, writeSink, 'learnings.insert');
          if (resultData.learningExtracted) {
            const lastId = insertResult.data?.lastInsertRowid;
            if (typeof lastId === 'number') {
              newlyInsertedLearningId = lastId;
            } else if (typeof lastId === 'bigint') {
              newlyInsertedLearningId = Number(lastId);
            }

            // Sprint 66 m03 — write-path embedding hook
            if (newlyInsertedLearningId !== undefined) {
              const embedResult = await recordEmbedding(client, {
                type: 'learning',
                id: newlyInsertedLearningId,
                inputText: learningEmbeddingInput(content),
              });
              warnings.push(...(embedResult.warnings ?? []));
            }
          }
        } else {
          resultData.learningExtracted = false;
          newlyInsertedLearningId = existingLearning.data.id;
        }
      }

      if (category === 'constraint') {
        ensureConstraintsTable(client);

        // Get sprint_id from session or mission
        let sprintId: string | null = null;
        if (missionId) {
          const missionResult = client.getOne<{ sprint_id: string | null }>(
            'SELECT sprint_id FROM missions WHERE id = ?',
            [missionId]
          );
          sprintId = missionResult.success ? (missionResult.data?.sprint_id ?? null) : null;
        }
        if (!sprintId) {
          sprintId = session.sprint_id ?? inferSprintIdForDecisionCapture(client);
        }

        // Dedup via content hash
        const hash = computeContentHash(content, 'constraint');
        const existingConstraint = client.getOne<{ id: number }>(
          'SELECT id FROM constraints WHERE content_hash = ? AND status = ?',
          [hash, 'active']
        );

        // s86-m02b (fork f10, read side): same disclosure as the learning arm above.
        if (!existingConstraint.success) {
          warnings.push(
            `constraint de-duplication check failed; a duplicate row may have been written: ` +
              `${existingConstraint.error?.code ?? 'DB_ERROR'} — ${existingConstraint.error?.message ?? 'unknown'}`
          );
        }

        if (!existingConstraint.success || !existingConstraint.data) {
          const expiresAt = params.expiresAt ?? null;
          const g = genesisColumns(client, 'constraints', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO constraints (content, status, session_id, sprint_id, created_at, expires_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'active', ?, ?, ?, ?, ?, ${g.placeholders})`,
            [content, sessionId, sprintId, now, expiresAt, hash, ...g.values]
          );
          // s86-m02b: same split as `learningExtracted` — `false` now means duplicate only.
          resultData.constraintExtracted = checkWrite(
            insertResult,
            writeSink,
            'constraints.insert'
          );
        } else {
          resultData.constraintExtracted = false;
        }
      }

      // Sprint 61 m01 — auto-reaffirm cited learnings.
      // Explicit IDs from `citesLearningIds[]` always bump. Implicit overlap fires
      // only for decision/learning captures (other categories are unrelated to the
      // institutional-rule corpus). For learning captures, exclude the freshly
      // inserted row from implicit matches so a learning can't reaffirm itself.
      if (category === 'decision' || category === 'learning') {
        const reaffirm = await applyLearningReaffirm(client, {
          explicitIds: citesLearningIds,
          newContent: content,
          reaffirmedAt: now,
          excludeIds: newlyInsertedLearningId !== undefined ? [newlyInsertedLearningId] : undefined,
        });
        // s86-m02b: a failed existence lookup classifies NOTHING, so the reaffirmed/missing
        // lists above are INCOMPLETE rather than authoritative. That has to reach the answer, or
        // the caller reads a partial corpus view as a complete one.
        writeSink.failures.push(...reaffirm.writeFailures);
        if (reaffirm.explicitlyReaffirmedIds.length > 0) {
          resultData.explicitlyReaffirmedLearningIds = reaffirm.explicitlyReaffirmedIds;
        }
        if (reaffirm.implicitlyReaffirmedIds.length > 0) {
          resultData.implicitlyReaffirmedLearningIds = reaffirm.implicitlyReaffirmedIds;
        }
        if (reaffirm.missingIds.length > 0) {
          resultData.missingCitedLearningIds = reaffirm.missingIds;
        }
      }

      // s85-m04 — THE SUPPLY LEVER. The two SQL omissions explain only 26 of 342 unstamped
      // decisions; the dominant cause is agents simply not passing the OPTIONAL missionId
      // (176/981 captures = 17.9%, and learnings-stamped exactly equals
      // learning-captures-with-missionId). So the lever is asking, not inferring.
      //
      // NEVER silently pick a mission: a wrong mission_id is an unrecoverable false provenance
      // claim with no FK to catch it (verified — pragma_foreign_key_list('learnings') returns
      // zero rows on the migrated store even though the seed declares the FK). Warn instead.
      //
      // Deliberately NOT on the next-step path: 96.4% of next_steps are born at session
      // complete when zero mission is in progress, so it would be pure noise.
      if (!missionId && (category === 'decision' || category === 'learning')) {
        const candidates = client.getMany<{ id: string; status: string }>(
          `SELECT id, status FROM missions
            WHERE status IN ('In Progress', 'Current')
            ORDER BY CASE status WHEN 'In Progress' THEN 0 ELSE 1 END, id ASC
            LIMIT 5`,
          []
        );
        const rows = candidates.success ? (candidates.data ?? []) : [];
        if (rows.length > 0) {
          const names = rows.map((r) => `${r.id} (${r.status})`).join(', ');
          warnings.push(
            `This ${category} was captured without a missionId while ${rows.length} mission(s) ` +
              `are open: ${names}. The row is stored UNSTAMPED, so it will not appear in ` +
              `cmos_${category === 'decision' ? 'decisions' : 'learnings'}(action="list", missionId=…). ` +
              `Pass missionId on the capture to record which mission this belongs to — it is not ` +
              `inferred, because a wrong mission_id is an unrecoverable false provenance claim.`
          );
        }
      }

      return createSuccess<CmosSessionCaptureResult>(
        resultData,
        warnings.length > 0 ? warnings : undefined,
        sanitizedFields
      );
    },
    { projectRoot: params.projectRoot }
  );
}

function inferSprintIdForDecisionCapture(
  client: Parameters<Parameters<typeof withClientAsync>[0]>[0]
): string | null {
  const activeMission = client.getOne<{ sprint_id: string | null }>(
    `SELECT sprint_id
       FROM missions
      WHERE status IN ('In Progress', 'Current')
        AND sprint_id IS NOT NULL
      ORDER BY CASE status
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        ELSE 2
      END, id ASC
      LIMIT 1`,
    []
  );

  if (activeMission.success && activeMission.data?.sprint_id) {
    return activeMission.data.sprint_id;
  }

  // s85-m03: the fallback now resolves through resolveOpenSprintIdForWrite, NOT the display
  // resolver. This MUST ship together with the cmos-session-start.ts swap: fixing only
  // session-start does not shrink the blast radius, it RELOCATES it. Once sessions.sprint_id
  // is NULL, the `session.sprint_id ?? inferSprintIdForDecisionCapture(...)` fallthrough at
  // the decision/learning/constraint call sites fires MORE often, so the dead sprint id would
  // simply land on those three tables instead of on the session.
  //
  // The mission-first leg above is unchanged and still wins: a decision captured mid-work
  // belongs to the active mission's sprint whatever the sprint's own status says.
  return resolveOpenSprintIdForWrite(client);
}

/**
 * Format session capture result for LLM readability.
 */
export function formatSessionCaptureForLLM(
  result: CmosToolResult<CmosSessionCaptureResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to capture insight',
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
  const categoryIcon: Record<CaptureCategory, string> = {
    decision: '⚖️',
    learning: '💡',
    constraint: '🚧',
    context: '📋',
    'next-step': '➡️',
  };

  const lines = [
    `${categoryIcon[data.category]} **${data.category.charAt(0).toUpperCase() + data.category.slice(1)} Captured**`,
    '',
    `**Session**: ${data.sessionId}`,
    `**Content**: ${data.content}`,
    `**Capture #${data.captureCount}** in this session`,
  ];

  if (data.missionId) {
    lines.push(`**Mission**: ${data.missionId}`);
  }

  if (data.category === 'decision' && data.decisionExtractionCount !== undefined) {
    lines.push('');

    if (data.decisionExtractionFailed) {
      // s86-m02b: the third state. This branch used to be unreachable-by-omission — a failed
      // INSERT fell into the `else` below and was announced as "Extraction skipped".
      lines.push(`**Decision Extraction**: FAILED — the decision was NOT stored.`);
      lines.push(`  ${data.decisionExtractionFailed}`);
    } else if (data.decisionAlreadyExtracted) {
      lines.push('**Decision Extraction**: Already exists in strategic decisions');
    } else if (data.decisionExtractionCount > 0) {
      lines.push(`**Decision Extraction**: Auto-extracted (${data.decisionExtractionCount})`);
    } else {
      lines.push('**Decision Extraction**: Extraction skipped');
    }
  }

  if (data.supersessionMessage) {
    lines.push('');
    lines.push('⚠️ **Supersession Suggestion**');
    lines.push(data.supersessionMessage);
  }

  if (data.evidenceStored?.length) {
    lines.push(`**Evidence**: ${data.evidenceStored.map((e) => `${e.type}:${e.id}`).join(', ')}`);
  }

  if (data.sourceChunkIds?.length) {
    lines.push(`**Source Chunks**: ${data.sourceChunkIds.join(', ')}`);
  }

  appendWriteFailures(lines, data.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}
