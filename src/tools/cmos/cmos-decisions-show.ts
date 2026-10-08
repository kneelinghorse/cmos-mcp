// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 — cmos_decisions(action="show"): one decision in full, by id. Retrieval answers
// ABOUTME: carry 300-character previews, and this is how an agent expands one of them.

import { frameForeignText } from '../../intelligence/provenance-frame';
import { withClientAsync, type CmosDatabaseClient } from './client';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { appendWarnings } from './format-warnings';
import { getProjectId, tableHasColumn } from './genesis-columns';
import type { CmosToolResult } from './types';

export interface CmosDecisionsShowParams {
  decisionId: number;
  projectRoot?: string;
}

export interface CmosDecisionsShowResult {
  id: number;
  /** The full text, never a preview. */
  decisionText: string;
  status: string;
  sprintId: string | null;
  missionId: string | null;
  category: string | null;
  domain: string | null;
  supersededBy: number | null;
  createdAt: string;
  evidence: string | null;
  authorSessionId: string | null;
  /** The row's genesis project; a pull-merged row carries its origin's id. */
  projectId: string | null;
  localProjectId: string | null;
}

interface DecisionRow {
  id: number;
  decision_text: string;
  status: string | null;
  sprint_id: string | null;
  mission_id: string | null;
  category: string | null;
  project_domain: string | null;
  superseded_by: number | null;
  created_at: string;
  evidence: string | null;
  author_session_id: string | null;
  project_id: string | null;
}

/** A column that older stores may lack reads as NULL there instead of failing the read. */
function columnOrNull(client: CmosDatabaseClient, column: string): string {
  return tableHasColumn(client, 'strategic_decisions', column) ? column : `NULL AS ${column}`;
}

export async function cmosDecisionsShow(
  params: CmosDecisionsShowParams
): Promise<CmosToolResult<CmosDecisionsShowResult>> {
  if (!Number.isInteger(params.decisionId) || params.decisionId < 1) {
    return createError(CmosErrors.missingParameter('decisionId'));
  }
  return withClientAsync(
    async (client) => {
      const optional = ['mission_id', 'category', 'project_domain', 'superseded_by', 'evidence']
        .concat(['author_session_id', 'project_id'])
        .map((column) => columnOrNull(client, column))
        .join(', ');
      const row = client.getOne<DecisionRow>(
        `SELECT id, decision_text, status, sprint_id, created_at, ${optional}
           FROM strategic_decisions WHERE id = ?`,
        [params.decisionId]
      );
      if (!row.success) {
        return createError<CmosDecisionsShowResult>(
          row.error ?? {
            code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to read the decision',
          }
        );
      }
      if (!row.data) {
        return createError<CmosDecisionsShowResult>(
          CmosErrors.recordNotFound('decision', params.decisionId)
        );
      }
      const d = row.data;
      return createSuccess<CmosDecisionsShowResult>({
        id: d.id,
        decisionText: d.decision_text,
        status: d.status ?? 'active',
        sprintId: d.sprint_id,
        missionId: d.mission_id,
        category: d.category,
        domain: d.project_domain,
        supersededBy: d.superseded_by,
        createdAt: d.created_at,
        evidence: d.evidence,
        authorSessionId: d.author_session_id,
        projectId: d.project_id,
        localProjectId: getProjectId(client),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatDecisionsShowForLLM(result: CmosToolResult<CmosDecisionsShowResult>): string {
  if (!result.success || !result.data) {
    const lines = [
      '❌ Failed to show decision',
      '',
      `Error: ${result.error?.message ?? 'Unknown error'}`,
    ];
    if (result.error?.suggestion) lines.push('', `Suggestion: ${result.error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  const d = result.data;
  const meta = [
    d.sprintId ? `sprint ${d.sprintId}` : null,
    d.missionId ? `mission ${d.missionId}` : null,
    d.category ? `category ${d.category}` : null,
    `recorded ${d.createdAt}`,
  ].filter((part): part is string => part !== null);
  const lines = [`⚖️ **Decision #${d.id}** (${d.status})`, meta.join(' | ')];
  if (d.supersededBy !== null) lines.push(`Superseded by #${d.supersededBy}`);
  lines.push('');
  // A row pull-merged from another project is foreign, untrusted text: fenced, never bare.
  const isForeign =
    d.projectId != null && (d.localProjectId == null || d.projectId !== d.localProjectId);
  if (isForeign) {
    lines.push(`[proj:${d.projectId}]`);
    lines.push(frameForeignText(d.decisionText, `proj:${d.projectId}`));
    if (d.evidence) lines.push('Evidence:', frameForeignText(d.evidence, `proj:${d.projectId}`));
  } else {
    lines.push(d.decisionText);
    if (d.evidence) lines.push('', `Evidence: ${d.evidence}`);
  }
  appendWarnings(lines, result);
  return lines.join('\n');
}
