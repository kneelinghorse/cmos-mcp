// ABOUTME: Persistence helper for the Sprint 56 m03 agentFeedback standing channel.
// ABOUTME: Called by cmos_session, cmos_mission_transition, cmos_agent_onboard when the optional field is set.

import type { CmosDatabaseClient } from './client';
import { ensureAgentFeedbackTable } from './schema-migrations';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import type { SanitizedFieldReport } from './types';
import { checkWrite } from './write-guard';

/** Context that follows the feedback row so triage can scope by sprint/session/mission. */
export interface AgentFeedbackContext {
  toolName: string;
  sessionId?: string | null;
  sprintId?: string | null;
  missionId?: string | null;
  projectId?: string | null;
}

export interface RecordAgentFeedbackResult {
  feedbackId: number | null;
  sanitizedFields: SanitizedFieldReport[];
  /**
   * Sprint 86 m02b — the DB error when the agent_feedback INSERT failed, which
   * used to be swallowed into a null feedbackId. Callers splice these into their
   * own warnings sink so the answer never implies the feedback was recorded.
   */
  warnings: string[];
}

/**
 * Persist a single agentFeedback entry, sanitizing the body before write so
 * corrupted XML markup cannot land in the feedback channel either.
 *
 * Returns `{feedbackId: null, sanitizedFields: []}` when the trimmed body is
 * empty (the caller passed an empty string) — no row is written. All null
 * context fields are persisted as NULL so the list/triage surface can group
 * cleanly by tool even when session/sprint/mission context is missing.
 */
export function recordAgentFeedback(
  client: CmosDatabaseClient,
  body: string,
  context: AgentFeedbackContext
): RecordAgentFeedbackResult {
  const trimmed = body.trim();
  if (!trimmed) {
    return { feedbackId: null, sanitizedFields: [], warnings: [] };
  }

  ensureAgentFeedbackTable(client);

  const sanitizedFields: SanitizedFieldReport[] = [];
  const sanitation = sanitizeContentField(trimmed);
  if (sanitation.wasModified) {
    sanitizedFields.push({
      field: 'agentFeedback',
      reason: sanitation.reason ?? 'Stripped XML marshalling artifact.',
    });
  }

  const cleaned = sanitation.cleaned;
  if (!cleaned) {
    return { feedbackId: null, sanitizedFields, warnings: [] };
  }

  const now = new Date().toISOString();
  const insertResult = client.execute(
    `INSERT INTO agent_feedback (
      tool_name, body, status, session_id, sprint_id, mission_id, project_id, created_at
    ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
    [
      context.toolName,
      cleaned,
      context.sessionId ?? null,
      context.sprintId ?? null,
      context.missionId ?? null,
      context.projectId ?? null,
      now,
    ]
  );

  const warnings: string[] = [];
  checkWrite(insertResult, warnings, 'agent feedback insert');

  const feedbackId =
    insertResult.success && insertResult.data ? Number(insertResult.data.lastInsertRowid) : null;
  return { feedbackId, sanitizedFields, warnings };
}
