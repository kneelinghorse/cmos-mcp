/**
 * cmos_mission_complete Tool
 *
 * MCP tool for completing a mission - transitions from In Progress to Completed.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/cmos/cmos-mission-complete
 */

import * as crypto from 'crypto';
import { z } from 'zod';
import { withClientAsync, type CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { CmosToolResult, MissionStatus, SanitizedFieldReport } from './types';
import { recordAgentFeedback } from './agent-feedback';
import {
  createError,
  createSuccess,
  CmosErrors,
  CMOS_ERROR_CODES,
  VALID_STATE_TRANSITIONS,
} from './errors';
import {
  ensureStrategicDecisionsSchema,
  ensureMissionTimestamps,
  snapshotDedupPrunedFilter,
} from './schema-migrations';
import { sanitizeContentField, sanitizeStringArray } from '../../intelligence/content-sanitizer';
import { recordEmbedding, decisionEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { patchProjectIdentity, type ProjectIdentityData } from './project-identity';
import { appendWarnings } from './format-warnings';
import { checkWrite } from './write-guard';

interface MissionCompletionRecord {
  id: string;
  status: MissionStatus;
  name: string;
  sprint_id: string | null;
  objective: string | null;
}

/**
 * Result of completing a mission.
 */
export interface MissionCompleteResult {
  /** The mission ID that was completed */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'Completed') */
  currentStatus: MissionStatus;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was completed */
  completedAt: string;

  /** Whether master_context was updated with mission completion summary */
  contextAggregated?: boolean;

  /** Whether a sprint completion summary was added */
  sprintSummaryAdded?: boolean;

  /** Snapshot ID created for context aggregation */
  contextSnapshotId?: number | null;

  /** Number of decisions this completion actually INSERTed. s86-m02b: this was `decisions.length`
   *  — the number ATTEMPTED — so a rejected INSERT still counted. A decision the database refused
   *  is excluded here and named on `warnings` instead. */
  decisionCount?: number;

  /** Total decisions captured for this mission's sprint */
  sprintDecisionCount?: number;

  /** Number of learnings captured for this mission */
  learningCount?: number;

  /** Persisted agent_feedback.id when agentFeedback was supplied (Sprint 56 m03). */
  feedbackId?: number;
}

/**
 * Input parameters schema for cmos_mission_complete tool.
 */
export const cmosMissionCompleteSchema = z.object({
  /** The mission ID to complete */
  missionId: z.string().min(1).describe('The mission ID to complete (e.g., "s12-m06")'),

  /** Optional notes or outcome summary */
  notes: z.string().optional().describe('Optional notes or outcome summary for completion'),

  /** Optional decisions made during this mission */
  decisions: z
    .array(z.string())
    .optional()
    .describe(
      'Decisions made during this mission. When omitted, a soft warning is included in the response.'
    ),

  /** Optional free-text UX feedback from the agent (Sprint 56 m03). */
  agentFeedback: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit while working this mission. Reviewed periodically via cmos_feedback(action="list").'
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosMissionCompleteParams = z.infer<typeof cmosMissionCompleteSchema>;

/**
 * MCP Tool Definition for cmos_mission_complete.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const cmosMissionCompleteToolDefinition = {
  name: 'cmos_mission_complete',
  description:
    'Complete a mission by transitioning it to Completed status. ' +
    'Valid only from In Progress status. ' +
    'Returns INVALID_STATE_TRANSITION error with current_state and valid_transitions if the mission cannot be completed.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to complete (e.g., "s12-m06")',
      },
      notes: {
        type: 'string',
        description: 'Optional notes or outcome summary for completion',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Decisions made during this mission. When omitted, a soft warning is included in the response.',
      },
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit while working this mission. Reviewed periodically via cmos_feedback(action="list").',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_mission_complete tool.
 *
 * Transitions a mission from In Progress to Completed.
 * Validates the state transition and returns actionable errors if invalid.
 *
 * @param params - Tool parameters (missionId, notes, projectRoot)
 * @returns CmosToolResult with completion result or actionable error
 */
export async function cmosMissionComplete(
  params: CmosMissionCompleteParams
): Promise<CmosToolResult<MissionCompleteResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'Completed';

  // Sanitize free-text inputs before persistence (Sprint 60 m02).
  // Mission notes and the decisions[] array can absorb sibling XML parameter
  // tags when an agent's tool call is marshalled with a dropped closing tag.
  const inputSanitized: SanitizedFieldReport[] = [];
  let cleanNotes = params.notes;
  if (typeof cleanNotes === 'string') {
    const r = sanitizeContentField(cleanNotes);
    if (r.wasModified) {
      cleanNotes = r.cleaned;
      inputSanitized.push({ field: 'notes', reason: r.reason ?? '' });
    }
  }
  let cleanDecisions = params.decisions;
  if (Array.isArray(cleanDecisions)) {
    const r = sanitizeStringArray('decisions', cleanDecisions);
    cleanDecisions = r.cleaned;
    inputSanitized.push(...r.sanitizedFields);
  }

  return withClientAsync(
    async (client) => {
      const warnings: string[] = [];

      // Query mission by ID
      const missionResult = client.getOne<MissionCompletionRecord>(
        `
        SELECT id, status, name, sprint_id, objective
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionCompleteResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionCompleteResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      // Check if already completed
      if (currentStatus === targetStatus) {
        return createError<MissionCompleteResult>({
          code: CMOS_ERROR_CODES.MISSION_ALREADY_COMPLETED,
          message: `Mission '${missionId}' is already Completed`,
          currentState: currentStatus,
          suggestion: 'This mission has already been completed. No action needed.',
        });
      }

      // Validate state transition
      const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionCompleteResult>(
          CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      // Perform the update
      const now = new Date().toISOString();

      // Ensure timestamp columns exist (migration)
      ensureMissionTimestamps(client);

      // Build update query - include notes, completed_at, and updated_at
      let updateQuery: string;
      let updateParams: (string | null)[];

      if (cleanNotes) {
        updateQuery = `
          UPDATE missions
          SET status = ?, completed_at = ?, updated_at = ?,
              notes = COALESCE(notes || ' | ', '') || ?
          WHERE id = ?
        `;
        updateParams = [targetStatus, now, now, `[Completed] ${cleanNotes}`, missionId];
      } else {
        updateQuery = `
          UPDATE missions
          SET status = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `;
        updateParams = [targetStatus, now, now, missionId];
      }

      const updateResult = client.execute(updateQuery, updateParams);

      if (!updateResult.success) {
        return createError<MissionCompleteResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionCompleteResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      // Log the state change to session_events
      const eventResult = client.execute(
        `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, 'complete', ?, ?, ?)
      `,
        [
          now,
          missionId,
          targetStatus,
          cleanNotes ?? `Completed mission ${missionId}`,
          JSON.stringify({
            tool: 'cmos_mission_complete',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            notes: cleanNotes,
          }),
        ]
      );

      // Don't fail the operation if event logging fails (non-critical)
      if (!eventResult.success) {
        console.warn('Failed to log mission complete event:', eventResult.error);
        warnings.push('Mission completion event logging failed.');
      }

      const aggregationResult = aggregateMissionCompletionContext(client, {
        missionId,
        missionName: mission.name,
        missionObjective: mission.objective,
        sprintId: mission.sprint_id,
        completedAt: now,
        completionNotes: cleanNotes ?? null,
      });

      if (!aggregationResult.success) {
        warnings.push(
          aggregationResult.errorMessage ??
            'Context aggregation hook failed after mission completion update.'
        );
      }

      // Decision capture soft gate
      const decisionResult = await captureDecisions(
        client,
        {
          missionId,
          sprintId: mission.sprint_id,
          decisions: cleanDecisions,
          completedAt: now,
        },
        warnings
      );

      if (decisionResult.warning) {
        warnings.push(decisionResult.warning);
      }

      // Learning capture soft nudge
      const learningCountResult = client.getOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM learnings WHERE mission_id = ?',
        [missionId]
      );
      const learningCount =
        learningCountResult.success && learningCountResult.data
          ? learningCountResult.data.count
          : 0;

      if (learningCount === 0) {
        warnings.push(
          'No learnings captured for this mission. Consider capturing at least one learning before proceeding.'
        );
      }

      // Sprint closeout guardrail: nudge when this was the last mission
      if (mission.sprint_id && isSprintFullyCompleted(client, mission.sprint_id)) {
        warnings.push(
          `This was the last mission in ${mission.sprint_id}. Run cmos_sprint(action="complete") to close it out.`
        );
      }

      let feedbackId: number | undefined;
      const feedbackSanitized: SanitizedFieldReport[] = [];
      if (params.agentFeedback && params.agentFeedback.trim().length > 0) {
        const fb = recordAgentFeedback(client, params.agentFeedback, {
          toolName: 'cmos_mission_transition',
          missionId,
          sprintId: mission.sprint_id ?? null,
        });
        if (fb.feedbackId !== null) feedbackId = fb.feedbackId;
        feedbackSanitized.push(...fb.sanitizedFields);
        warnings.push(...fb.warnings);
      }

      return createSuccess<MissionCompleteResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          message: `Mission '${missionId}' has been completed`,
          completedAt: now,
          contextAggregated: aggregationResult.success,
          sprintSummaryAdded: aggregationResult.sprintSummaryAdded,
          contextSnapshotId: aggregationResult.snapshotId,
          decisionCount: decisionResult.decisionCount,
          sprintDecisionCount: decisionResult.sprintDecisionCount,
          learningCount,
          ...(feedbackId !== undefined ? { feedbackId } : {}),
        },
        warnings,
        [...inputSanitized, ...feedbackSanitized]
      );
    },
    { projectRoot: params.projectRoot }
  );
}

interface DecisionCaptureInput {
  missionId: string;
  sprintId: string | null;
  decisions: string[] | undefined;
  completedAt: string;
}

interface DecisionCaptureResult {
  /** Rows the strategic_decisions INSERT actually landed — NOT `decisions.length` (s86-m02b). */
  decisionCount: number;
  sprintDecisionCount: number;
  warning?: string;
}

async function captureDecisions(
  client: CmosDatabaseClient,
  input: DecisionCaptureInput,
  warnings: string[]
): Promise<DecisionCaptureResult> {
  // Ensure mission_id column exists (defensive DDL for existing databases)
  ensureMissionIdColumn(client);

  const decisions = input.decisions?.filter((d) => d.trim().length > 0) ?? [];
  // s86-m02b: rows the database ACCEPTED, not rows we meant to write. See the return below.
  let insertedCount = 0;

  if (decisions.length > 0) {
    // Get project_domain from metadata
    const domainResult = client.getOne<{ value: string }>(
      "SELECT value FROM metadata WHERE key = 'project_domain'",
      []
    );
    const projectDomain = domainResult.success ? (domainResult.data?.value ?? null) : null;

    // Get active session ID if one exists
    const sessionResult = client.getOne<{ id: string }>(
      "SELECT id FROM sessions WHERE status = 'active' LIMIT 1",
      []
    );
    const sessionId = sessionResult.success ? (sessionResult.data?.id ?? null) : null;

    for (const decision of decisions) {
      const trimmed = decision.trim();
      const g = genesisColumns(client, 'strategic_decisions', getProjectId(client));
      const insertResult = client.execute(
        // s69-m04: session_id renamed → author_session_id. genesisColumns above
        // ran the rename migration, so the column exists by this INSERT.
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, project_domain, author_session_id, mission_id, ${g.columns.join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
        [
          trimmed,
          input.completedAt,
          input.sprintId,
          projectDomain,
          sessionId,
          input.missionId,
          ...g.values,
        ]
      );

      // s86-m02b: the return value is the count. It used to be discarded, and `decisionCount`
      // reported `decisions.length` — the number the code MEANT to insert — so a rejected INSERT
      // still rendered as "Decisions captured: N" with the decision nowhere in the store. The DB
      // error rides out on `warnings`, which formatMissionCompleteForLLM renders.
      if (checkWrite(insertResult, warnings, 'strategic_decisions insert')) {
        insertedCount++;
      }

      // Sprint 66 m03 — write-path embedding hook
      if (insertResult.success) {
        const newId = insertResult.data?.lastInsertRowid;
        const numericId =
          typeof newId === 'bigint' ? Number(newId) : typeof newId === 'number' ? newId : null;
        if (numericId !== null) {
          const embedding = await recordEmbedding(client, {
            type: 'decision',
            id: numericId,
            inputText: decisionEmbeddingInput(trimmed),
          });
          if (embedding.warnings) warnings.push(...embedding.warnings);
        }
      }
    }
  }

  // Get sprint decision count
  let sprintDecisionCount = 0;
  if (input.sprintId) {
    const countResult = client.getOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM strategic_decisions WHERE sprint_id = ?',
      [input.sprintId]
    );
    sprintDecisionCount = countResult.success && countResult.data ? countResult.data.count : 0;
  }

  const result: DecisionCaptureResult = {
    decisionCount: insertedCount,
    sprintDecisionCount,
  };

  // Soft gate warning when no decisions provided. Deliberately keyed on what the CALLER supplied,
  // not on `insertedCount`: this nudge is "you documented no architectural choices", and firing it
  // when the agent supplied decisions the database then rejected would give misdirected advice for
  // a failure `warnings` already names (s86-m02b).
  if (decisions.length === 0) {
    result.warning =
      'No decisions captured for this mission. Consider documenting architectural choices made during implementation.';
  }

  return result;
}

export function ensureMissionIdColumn(client: CmosDatabaseClient): void {
  // Delegate to the full schema migration which handles mission_id
  // and all other v2.1 columns (category, status, superseded_by, evidence)
  ensureStrategicDecisionsSchema(client);
}

interface MissionAggregationInput {
  missionId: string;
  missionName: string;
  missionObjective: string | null;
  sprintId: string | null;
  completionNotes: string | null;
  completedAt: string;
}

interface MissionAggregationResult {
  success: boolean;
  sprintSummaryAdded: boolean;
  snapshotId: number | null;
  errorMessage?: string;
}

function aggregateMissionCompletionContext(
  client: CmosDatabaseClient,
  input: MissionAggregationInput
): MissionAggregationResult {
  const contextResult = client.getOne<{ source_path: string; content: string }>(
    'SELECT source_path, content FROM contexts WHERE id = ?',
    ['master_context']
  );

  if (!contextResult.success) {
    return {
      success: false,
      sprintSummaryAdded: false,
      snapshotId: null,
      errorMessage:
        contextResult.error?.message ?? 'Failed to load master_context for completion aggregation.',
    };
  }

  const sourcePath = contextResult.data?.source_path ?? 'context/MASTER_CONTEXT.json';
  let masterContext: Record<string, unknown> = {};

  if (contextResult.data?.content) {
    try {
      masterContext = JSON.parse(contextResult.data.content);
    } catch {
      return {
        success: false,
        sprintSummaryAdded: false,
        snapshotId: null,
        errorMessage: 'master_context contains invalid JSON and cannot be aggregated.',
      };
    }
  }

  const beforeContent = JSON.stringify(masterContext);
  syncProjectIdentityFromMetadata(client, masterContext, input.completedAt);

  // completed_missions and completed_sprints are no longer stored in the blob.
  // Both are queryable from the missions/sprints tables (Sprint 51 blob reduction).
  const sprintSummaryAdded = false;

  const afterContent = JSON.stringify(masterContext);
  if (afterContent === beforeContent) {
    return {
      success: true,
      sprintSummaryAdded,
      snapshotId: null,
    };
  }

  const persistResult = contextResult.data
    ? client.execute('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?', [
        afterContent,
        input.completedAt,
        'master_context',
      ])
    : client.execute(
        'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
        ['master_context', sourcePath, afterContent, input.completedAt]
      );

  if (!persistResult.success) {
    return {
      success: false,
      sprintSummaryAdded: false,
      snapshotId: null,
      errorMessage:
        persistResult.error?.message ?? 'Failed to persist mission completion aggregation context.',
    };
  }

  const snapshotId = createContextSnapshot(
    client,
    'master_context',
    afterContent,
    sprintSummaryAdded
      ? `mission_complete:${input.missionId}:sprint_complete`
      : `mission_complete:${input.missionId}`
  );

  return {
    success: true,
    sprintSummaryAdded,
    snapshotId,
  };
}

function syncProjectIdentityFromMetadata(
  client: CmosDatabaseClient,
  content: Record<string, unknown>,
  completedAt: string
): void {
  const projectIdentity = isPlainObject(content.project_identity)
    ? { ...content.project_identity }
    : {};

  const projectName = getMetadataValue(client, 'project_name');
  const projectDescription = getMetadataValue(client, 'project_description');
  const projectStatus = getMetadataValue(client, 'project_status');
  const tracelabProjectId = getMetadataValue(client, 'tracelab_project_id');

  if (projectName) {
    projectIdentity.name = projectName;
  }
  if (projectDescription) {
    projectIdentity.description = projectDescription;
  }
  if (projectStatus) {
    projectIdentity.status = projectStatus;
  }
  if (tracelabProjectId) {
    projectIdentity.tracelab_project_id = tracelabProjectId;
  }

  projectIdentity.last_sync_at = completedAt;
  content.project_identity = projectIdentity;

  // s81-m04 (Fork B convergence): the master_context blob section stamped above is only
  // the FIRST projection of identity. The Layer-0 `project_identity` ROW is the second,
  // and the two drifted (the row's description went EMPTY while the blob held the correct
  // one). Make THIS guard the SINGLE convergence point: stamp the row from the SAME
  // metadata seed so they can no longer diverge. Pass ONLY {description,status,
  // project_name} — NEVER cmos_address/objectives/foundational_docs, which a broad set
  // would revert to defaults and silently undo user-set values (decision #682 precedent).
  // ISOLATED try/failure: a Layer-0 write failure must NEVER fail a mission-complete for
  // any sibling (dist blast radius) — the blob convergence above already succeeded.
  try {
    const rowUpdates: Partial<ProjectIdentityData> = {};
    if (projectName) rowUpdates.project_name = projectName;
    if (projectDescription) rowUpdates.description = projectDescription;
    if (projectStatus) rowUpdates.status = projectStatus;
    if (Object.keys(rowUpdates).length > 0) {
      patchProjectIdentity(client, rowUpdates);
    }
  } catch {
    // Best-effort Layer-0 convergence — never block or fail a mission-complete.
  }
}

function getMetadataValue(client: CmosDatabaseClient, key: string): string | null {
  const metadataResult = client.getOne<{ value: string }>(
    'SELECT value FROM metadata WHERE key = ?',
    [key]
  );

  if (!metadataResult.success || !metadataResult.data?.value) {
    return null;
  }

  const normalized = metadataResult.data.value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isSprintFullyCompleted(client: CmosDatabaseClient, sprintId: string): boolean {
  const totalResult = client.getOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM missions WHERE sprint_id = ?',
    [sprintId]
  );
  const remainingResult = client.getOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM missions WHERE sprint_id = ? AND status != 'Completed'",
    [sprintId]
  );

  if (
    !totalResult.success ||
    !remainingResult.success ||
    !totalResult.data ||
    !remainingResult.data
  ) {
    return false;
  }

  return totalResult.data.count > 0 && remainingResult.data.count === 0;
}

function createContextSnapshot(
  client: CmosDatabaseClient,
  contextId: string,
  content: string,
  source: string
): number | null {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const now = new Date().toISOString();

  const existingSnapshot = client.getOne<{ id: number }>(
    // s84-m04: exclude a content-tombstoned row so identical content re-persists fresh.
    `SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}`,
    [contextId, contentHash]
  );

  if (existingSnapshot.success && existingSnapshot.data) {
    return existingSnapshot.data.id;
  }

  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextId, source, contentHash, content, now, ...g.values]
  );

  if (!insertResult.success) {
    return null;
  }

  return Number(insertResult.data?.lastInsertRowid);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Format mission complete result for LLM readability.
 *
 * @param result - Mission complete result
 * @returns Human-readable formatted result
 */
export function formatMissionCompleteForLLM(result: CmosToolResult<MissionCompleteResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to complete mission',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.currentState) {
      lines.push(`Current status: ${error.currentState}`);
    }

    if (error?.validTransitions && error.validTransitions.length > 0) {
      lines.push(`Valid transitions: ${error.validTransitions.join(', ')}`);
    }

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `✓ Mission '${data.missionId}' completed`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Completed at: ${data.completedAt}`,
  ];

  if (data.contextAggregated !== undefined) {
    lines.push(`Context aggregated: ${data.contextAggregated ? 'yes' : 'no'}`);
  }

  if (data.sprintSummaryAdded) {
    lines.push('Sprint summary added: yes');
  }

  if (data.contextSnapshotId) {
    lines.push(`Context snapshot: #${data.contextSnapshotId}`);
  }

  if (data.decisionCount !== undefined) {
    lines.push(`Decisions captured: ${data.decisionCount}`);
  }

  if (data.sprintDecisionCount !== undefined) {
    lines.push(`Sprint decision total: ${data.sprintDecisionCount}`);
  }

  if (data.learningCount !== undefined) {
    lines.push(`Learnings captured: ${data.learningCount}`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
