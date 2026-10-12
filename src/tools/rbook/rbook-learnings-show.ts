// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 — rbook_learnings(action="show"): one learning in full, by id. Search answers carry
// ABOUTME: 300-character previews, and this is how an agent expands one of them.

import {
  prepareSpinOutRead,
  spinOutDetails,
  spinOutPointerLines,
  type SpinOutDetails,
} from './spin-out-read';
import { frameForeignText } from '../../intelligence/provenance-frame';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { appendWarnings } from './format-warnings';
import { getProjectId, tableHasColumn } from './genesis-columns';
import type { RbookToolResult } from './types';

export interface RbookLearningsShowParams {
  learningId: number;
  projectRoot?: string;
}

export interface RbookLearningsShowResult extends SpinOutDetails {
  id: number;
  /** The full text, never a preview. */
  content: string;
  status: string;
  category: string | null;
  sprintId: string | null;
  missionId: string | null;
  evergreen: boolean;
  createdAt: string;
  lastReviewedAt: string | null;
  authorSessionId: string | null;
  /** The row's genesis project; a pull-merged row carries its origin's id. */
  projectId: string | null;
  localProjectId: string | null;
}

interface LearningRow {
  id: number;
  content: string;
  status: string | null;
  category: string | null;
  sprint_id: string | null;
  created_at: string;
  mission_id: string | null;
  evergreen: number | null;
  last_reviewed_at: string | null;
  author_session_id: string | null;
  project_id: string | null;
}

/** A column that older stores may lack reads as NULL there instead of failing the read. */
function columnOrNull(client: RbookDatabaseClient, column: string): string {
  return tableHasColumn(client, 'learnings', column) ? column : `NULL AS ${column}`;
}

export async function rbookLearningsShow(
  params: RbookLearningsShowParams
): Promise<RbookToolResult<RbookLearningsShowResult>> {
  if (!Number.isInteger(params.learningId) || params.learningId < 1) {
    return createError(RbookErrors.missingParameter('learningId'));
  }
  return withClientAsync(
    async (client) => {
      const optional = ['mission_id', 'evergreen', 'last_reviewed_at']
        .concat(['author_session_id', 'project_id'])
        .map((column) => columnOrNull(client, column))
        .join(', ');
      const row = client.getOne<LearningRow>(
        `SELECT id, content, status, category, sprint_id, created_at, ${optional}
           FROM learnings WHERE id = ?`,
        [params.learningId]
      );
      if (!row.success) {
        return createError<RbookLearningsShowResult>(
          row.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to read the learning',
          }
        );
      }
      if (!row.data) {
        return createError<RbookLearningsShowResult>(
          RbookErrors.recordNotFound('learning', params.learningId)
        );
      }
      const l = row.data;
      return createSuccess<RbookLearningsShowResult>({
        ...spinOutDetails(prepareSpinOutRead(client), 'learning', l.id),
        id: l.id,
        content: l.content,
        status: l.status ?? 'active',
        category: l.category,
        sprintId: l.sprint_id,
        missionId: l.mission_id,
        evergreen: l.evergreen === 1,
        createdAt: l.created_at,
        lastReviewedAt: l.last_reviewed_at,
        authorSessionId: l.author_session_id,
        projectId: l.project_id,
        localProjectId: getProjectId(client),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatLearningsShowForLLM(
  result: RbookToolResult<RbookLearningsShowResult>
): string {
  if (!result.success || !result.data) {
    const lines = [
      '❌ Failed to show learning',
      '',
      `Error: ${result.error?.message ?? 'Unknown error'}`,
    ];
    if (result.error?.suggestion) lines.push('', `Suggestion: ${result.error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  const l = result.data;
  const meta = [
    l.category ? `category ${l.category}` : null,
    l.sprintId ? `sprint ${l.sprintId}` : null,
    l.missionId ? `mission ${l.missionId}` : null,
    l.evergreen ? 'evergreen' : null,
    `recorded ${l.createdAt}`,
  ].filter((part): part is string => part !== null);
  const lines = [`💡 **Learning #${l.id}** (${l.status})`, meta.join(' | '), ''];
  // A row pull-merged from another project is foreign, untrusted text: fenced, never bare.
  const isForeign =
    l.projectId != null && (l.localProjectId == null || l.projectId !== l.localProjectId);
  if (isForeign) {
    lines.push(`[proj:${l.projectId}]`);
    lines.push(frameForeignText(l.content, `proj:${l.projectId}`));
  } else {
    lines.push(l.content);
  }
  lines.push(...spinOutPointerLines(l));
  appendWarnings(lines, result);
  return lines.join('\n');
}
