// SPDX-License-Identifier: Apache-2.0
// ABOUTME: cmos_decisions(action="record") — write a decision with no session required, and supersede
// ABOUTME: the rows it corrects in the same transaction so the pointer exists when the correction does.

import { withClientAsync } from './client';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { sanitizeContentField, type SanitizedField } from '../../intelligence/content-sanitizer';
import { ensureMissionIdColumn } from './cmos-mission-complete';
import { resolveOpenSprintIdForWrite } from './current-sprint';
import {
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
  ensureImplicitSessionColumns,
} from './schema-migrations';
import { findExistingDecisionId, insertDecisionRow, followDecisionInsert } from './decision-write';
import { applyLearningReaffirm, sanitizeLearningIds } from './learning-reaffirm';
import type { SupersessionCandidate } from './supersession-detection';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { checkWrite, type WriteFailure } from './write-guard';
import type { CmosToolResult } from './types';
import { resolveCallerSession } from './session-owner';
import {
  closedSessionLines,
  reconcileStoreOnce,
  type ClosedSessionReceipt,
} from './implicit-session-lifecycle';

/**
 * s91-m04 — policy 3 (decisions keep the ADR lifecycle), made writable. A decision is born
 * `active`; archival is the sprint close's job and supersession is the pointer's job, so there is
 * no `status` parameter. Text is never amended in place: a correction is a new row that names the
 * rows it supersedes, and each named row gets `status='superseded', superseded_by=<new id>` in the
 * SAME transaction as the INSERT, so there is no window where the correction exists without its
 * pointer.
 *
 * SPRINT: the mission's sprint when `missionId` is given, else an explicit existing `sprintId`,
 * else `resolveOpenSprintIdForWrite` — which is `null` when no sprint is open (s85-m03), and that
 * null is disclosed on the answer rather than replaced by a guess.
 *
 * AUTHOR (s92-m03): the caller's session. The project's open explicit session, else this
 * process's own implicit session, opened if it has none, so every recorded row is attributed to the
 * process that wrote it. The dedup key is (text, author_session_id), so a lost-and-retried `record`
 * from the same process returns the row it already wrote instead of writing a second one.
 */

export interface CmosDecisionsRecordParams {
  content: string;
  missionId?: string;
  sprintId?: string;
  supersedes?: number[];
  evidence?: Array<{ type: string; id: string }>;
  citesLearningIds?: number[];
  domain?: string;
  projectRoot?: string;
}

export interface SupersededEcho {
  id: number;
  previousStatus: string;
  newStatus: 'superseded';
}

export interface CmosDecisionsRecordResult {
  decisionId: number;
  /** `existing` when an identical decision by the same author was already recorded. */
  materialization: 'materialized' | 'existing';
  /** The sprint the row carries; `null` when no mission, sprintId, or open sprint named one. */
  sprintId: string | null;
  missionId?: string;
  authorSessionId: string | null;
  superseded: SupersededEcho[];
  /** @deprecated s92-m04: no longer populated. The automatic supersession offer was retired (69 of 9,035 historical offers were true); a correction names what it replaces with cmos_decisions(action="record", supersedes=[...]). Kept declared so 3.2.0 removes no field. */
  supersessionCandidates?: SupersessionCandidate[];
  /** @deprecated s92-m04: no longer populated. The automatic supersession offer was retired (69 of 9,035 historical offers were true); a correction names what it replaces with cmos_decisions(action="record", supersedes=[...]). Kept declared so 3.2.0 removes no field. */
  supersessionMessage?: string;
  explicitlyReaffirmedLearningIds?: number[];
  missingCitedLearningIds?: number[];
  /** s92-m03: present when the author is this process's implicit session; `opened` by this call. */
  implicitSession?: { opened: boolean };
  /** s92-m03: stale implicit sessions closed after this call opened one. */
  closedSessions?: ClosedSessionReceipt[];
  writeFailures: WriteFailure[];
  message: string;
}

/** Thrown inside the transaction so better-sqlite3 rolls the INSERT back with the UPDATEs. */
class RecordRollback extends Error {}

export async function cmosDecisionsRecord(
  params: CmosDecisionsRecordParams
): Promise<CmosToolResult<CmosDecisionsRecordResult>> {
  // A wrong-typed `content` is refused by the router's boundary guard (param-type-guard.ts).
  const rawContent = (params.content ?? '').trim();
  if (rawContent === '') {
    return createError(CmosErrors.missingParameter('content'));
  }

  const sanitizedFields: SanitizedField[] = [];
  const sanitized = sanitizeContentField(rawContent);
  if (sanitized.wasModified) {
    sanitizedFields.push({ field: 'content', reason: sanitized.reason ?? '' });
  }
  const content = sanitized.cleaned;

  const supersedes = [...new Set(params.supersedes ?? [])];
  const missionId = params.missionId?.trim() || undefined;
  const cited = sanitizeLearningIds('citesLearningIds', params.citesLearningIds);
  sanitizedFields.push(...cited.sanitizedFields);

  const warnings: string[] = [];
  const writeSink = { failures: [] as WriteFailure[] };

  // s92-m03: the store this call wrote to, for its once-per-store reconcile after the connection.
  let storePath: string | null = null;
  const result = await withClientAsync(
    async (client) => {
      storePath = client.path;
      // Sprint resolution, in the order the module docblock publishes.
      let sprintId: string | null;
      if (missionId) {
        const mission = client.getOne<{ sprint_id: string | null }>(
          'SELECT sprint_id FROM missions WHERE id = ?',
          [missionId]
        );
        if (!mission.success || !mission.data) {
          return createError<CmosDecisionsRecordResult>(CmosErrors.missionNotFound(missionId));
        }
        sprintId = mission.data.sprint_id;
        warnings.push(...ensureMissionIdColumn(client));
      } else if (params.sprintId?.trim()) {
        const explicit = params.sprintId.trim();
        const sprint = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
          explicit,
        ]);
        if (!sprint.success || !sprint.data) {
          return createError<CmosDecisionsRecordResult>(CmosErrors.sprintNotFound(explicit));
        }
        sprintId = explicit;
      } else {
        sprintId = resolveOpenSprintIdForWrite(client);
      }
      if (sprintId === null) {
        warnings.push(
          'Recorded with sprint_id NULL: no missionId or sprintId was given and there is no open ' +
            'sprint to tag. Pass missionId or sprintId to tag it.'
        );
      }

      // Every supersedes target must exist before anything is written.
      const targets = new Map<number, string>();
      for (const id of supersedes) {
        const target = client.getOne<{ status: string }>(
          'SELECT status FROM strategic_decisions WHERE id = ?',
          [id]
        );
        if (!target.success || !target.data) {
          return createError<CmosDecisionsRecordResult>({
            code: CMOS_ERROR_CODES.INVALID_PARAMETER,
            message: `supersedes names decision #${id}, which does not exist`,
            field: 'supersedes',
            providedValue: id,
            suggestion:
              'Each supersedes id must be an existing decision; nothing was written. Find the id ' +
              'with cmos_decisions(action="list") and record again.',
          });
        }
        targets.set(id, target.data.status);
      }

      // s92-m03: the caller's session, never another process's implicit session.
      warnings.push(...(ensureImplicitSessionColumns(client).warnings ?? []));
      const caller = resolveCallerSession(client, { open: true });
      if (!caller.ok) {
        return createError<CmosDecisionsRecordResult>(caller.error);
      }
      warnings.push(...caller.warnings);
      const authorSessionId = caller.session?.sessionId ?? null;

      // Migrations that toggle foreign_keys are no-ops inside a transaction: run them first.
      warnings.push(...(ensureFirehoseEventColumns(client).warnings ?? []));
      warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));

      const existingId = findExistingDecisionId(client, content, authorSessionId);
      if (existingId !== undefined && targets.has(existingId)) {
        return createError<CmosDecisionsRecordResult>({
          code: CMOS_ERROR_CODES.INVALID_PARAMETER,
          message: `Decision #${existingId} cannot supersede itself`,
          field: 'supersedes',
          providedValue: existingId,
          suggestion: `Remove #${existingId} from supersedes; this text is already recorded as #${existingId}.`,
        });
      }

      const now = new Date().toISOString();
      const committed = client.transaction(() => {
        let decisionId = existingId;
        if (decisionId === undefined) {
          const written = insertDecisionRow(
            client,
            {
              content,
              now,
              sprintId,
              authorSessionId,
              missionId,
              evidence: params.evidence,
              projectDomain: params.domain?.trim() || undefined,
            },
            writeSink
          );
          if (written.kind === 'failed' || written.decisionId === undefined) {
            throw new RecordRollback('strategic_decisions.insert');
          }
          decisionId = written.decisionId;
        }
        for (const id of supersedes) {
          const updated = client.execute(
            `UPDATE strategic_decisions SET status = 'superseded', superseded_by = ? WHERE id = ?`,
            [decisionId, id]
          );
          if (!checkWrite(updated, writeSink, `strategic_decisions.supersede#${id}`)) {
            throw new RecordRollback(`strategic_decisions.supersede#${id}`);
          }
        }
        return decisionId;
      });

      if (!committed.success || committed.data === undefined) {
        return createError<CmosDecisionsRecordResult>({
          code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
          message:
            'The decision was not recorded and no supersedes pointer was written; the ' +
            `transaction rolled back (${writeSink.failures.map((f) => `${f.op}: ${f.message}`).join('; ') || committed.error?.message || 'unknown'}).`,
        });
      }

      const decisionId = committed.data;
      const answer: CmosDecisionsRecordResult = {
        decisionId,
        materialization: existingId === undefined ? 'materialized' : 'existing',
        sprintId,
        authorSessionId,
        superseded: supersedes.map((id) => ({
          id,
          previousStatus: targets.get(id) ?? 'unknown',
          newStatus: 'superseded' as const,
        })),
        writeFailures: writeSink.failures,
        message:
          existingId === undefined
            ? `Recorded decision #${decisionId}`
            : `Decision #${decisionId} was already recorded with this text`,
      };
      if (missionId) answer.missionId = missionId;
      if (caller.session?.implicit) answer.implicitSession = { opened: caller.session.opened };

      if (existingId === undefined) {
        // s92-m04: embedding only; the automatic supersession offer is retired.
        await followDecisionInsert(client, content, decisionId, warnings);
      }

      if (cited.cleaned.length > 0) {
        const reaffirm = await applyLearningReaffirm(
          client,
          { explicitIds: cited.cleaned, reaffirmedAt: now },
          warnings
        );
        writeSink.failures.push(...reaffirm.writeFailures);
        if (reaffirm.explicitlyReaffirmedIds.length > 0) {
          answer.explicitlyReaffirmedLearningIds = reaffirm.explicitlyReaffirmedIds;
        }
        if (reaffirm.missingIds.length > 0) {
          answer.missingCitedLearningIds = reaffirm.missingIds;
        }
      }

      return createSuccess(answer, undefined, sanitizedFields);
    },
    { projectRoot: params.projectRoot }
  );

  // s92-m03: on this process's first write to the store, close orphaned or idle implicit sessions,
  // outside the record's own connection, even if the record itself then failed.
  const reconciled = await reconcileStoreOnce(storePath);
  warnings.push(...reconciled.warnings);
  if (reconciled.receipts.length > 0) {
    if (result.success && result.data) result.data.closedSessions = reconciled.receipts;
    else warnings.push(...closedSessionLines(reconciled.receipts));
  }
  // Every exit after a migration carries its warnings, including the refusals.
  return attachWarnings(result, warnings);
}

export function formatDecisionsRecordForLLM(
  result: CmosToolResult<CmosDecisionsRecordResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to record decision',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) lines.push('', `Suggestion: ${error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const d = result.data;
  const lines = [
    d.materialization === 'existing'
      ? '✓ **Decision Already Recorded**'
      : '✓ **Decision Recorded**',
    '',
    `**Decision**: #${d.decisionId}`,
    `**Sprint**: ${d.sprintId ?? '(none — no open sprint)'}`,
  ];
  if (d.missionId) lines.push(`**Mission**: ${d.missionId}`);
  if (d.superseded.length > 0) {
    lines.push('**Superseded**:');
    for (const s of d.superseded) {
      lines.push(`  - #${s.id}: ${s.previousStatus} → ${s.newStatus}`);
    }
  }
  if (d.closedSessions && d.closedSessions.length > 0) {
    lines.push('**Closed stale sessions**:');
    for (const line of closedSessionLines(d.closedSessions)) lines.push(`  ${line}`);
  }
  appendWriteFailures(lines, d.writeFailures);
  appendWarnings(lines, result);
  return lines.join('\n');
}
