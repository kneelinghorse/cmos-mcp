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
import { resolveCurrentSprintId } from './current-sprint';
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

  /** Associated mission ID (when missionId was provided) */
  missionId?: string;

  /** Number of decisions extracted (present for decision category captures) */
  decisionExtractionCount?: number;

  /** Whether the decision was already extracted (present for decision category captures) */
  decisionAlreadyExtracted?: boolean;

  /** Source chunk IDs for decision provenance tracking */
  sourceChunkIds?: string[];

  /** Evidence references stored with the decision */
  evidenceStored?: Array<{ type: string; id: string }>;

  /** Whether a learning was extracted to the learnings table */
  learningExtracted?: boolean;

  /** Whether a constraint was extracted to the constraints table */
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
            suggestion: 'Start a session first with cmos_session_start, or provide a sessionId',
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

      client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
         VALUES (?, ?, ?, 'capture', 'active', ?, ?, ?)`,
        [now, agent, sessionId, summary, captureContext, rawEvent]
      );

      // Track session→mission association when missionId is provided
      if (missionId) {
        ensureSessionMissionsTable(client);
        // INSERT OR IGNORE: idempotent — won't duplicate if already linked
        client.execute(
          `INSERT OR IGNORE INTO session_missions (session_id, mission_id, linked_at, source)
           VALUES (?, ?, ?, 'capture')`,
          [sessionId, missionId, now]
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
        ensureAuthorNamespaceColumns(client);

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

          if (insertResult.success) {
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
              await recordEmbedding(client, {
                type: 'decision',
                id: newDecisionId,
                inputText: decisionEmbeddingInput(content),
              });
            }
          } else {
            resultData.decisionExtractionCount = 0;
            resultData.decisionAlreadyExtracted = false;
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
        ensureAuthorNamespaceColumns(client);

        // Check for duplicate
        const existingLearning = client.getOne<{ id: number }>(
          'SELECT id FROM learnings WHERE content = ? AND author_session_id = ?',
          [content, sessionId]
        );

        if (!existingLearning.success || !existingLearning.data) {
          const g = genesisColumns(client, 'learnings', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO learnings (content, category, status, sprint_id, author_session_id, mission_id, created_at, ${g.columns.join(', ')})
             VALUES (?, ?, 'active', ?, ?, ?, ?, ${g.placeholders})`,
            [content, null, sprintId, sessionId, missionId ?? null, now, ...g.values]
          );
          resultData.learningExtracted = insertResult.success;
          if (insertResult.success) {
            const lastId = insertResult.data?.lastInsertRowid;
            if (typeof lastId === 'number') {
              newlyInsertedLearningId = lastId;
            } else if (typeof lastId === 'bigint') {
              newlyInsertedLearningId = Number(lastId);
            }

            // Sprint 66 m03 — write-path embedding hook
            if (newlyInsertedLearningId !== undefined) {
              await recordEmbedding(client, {
                type: 'learning',
                id: newlyInsertedLearningId,
                inputText: learningEmbeddingInput(content),
              });
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

        if (!existingConstraint.success || !existingConstraint.data) {
          const expiresAt = params.expiresAt ?? null;
          const g = genesisColumns(client, 'constraints', getProjectId(client));
          const insertResult = client.execute(
            `INSERT INTO constraints (content, status, session_id, sprint_id, created_at, expires_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'active', ?, ?, ?, ?, ?, ${g.placeholders})`,
            [content, sessionId, sprintId, now, expiresAt, hash, ...g.values]
          );
          resultData.constraintExtracted = insertResult.success;
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

      return createSuccess<CmosSessionCaptureResult>(resultData, undefined, sanitizedFields);
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

  // s77-m02 Fork 2a: keep the mission-first leg above (a decision captured mid-work
  // belongs to the active mission's sprint), but route the no-active-mission
  // FALLBACK through the canonical resolver so a captured decision lands on the
  // SAME current sprint the other surfaces name (and inherits the dead-status
  // exclusions the old bare recent-activity query lacked).
  return resolveCurrentSprintId(client);
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

    if (data.decisionAlreadyExtracted) {
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

  return lines.join('\n');
}
