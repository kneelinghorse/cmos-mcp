/**
 * cmos_learnings search action
 *
 * Searches learnings by keyword using LIKE matching.
 * Supports filtering by category and sprint.
 *
 * @module tools/cmos/cmos-learnings-search
 */

import { withClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { ensureLearningsTable } from './schema-migrations';

/**
 * Learning search result.
 */
export interface LearningSearchResult {
  /** Learning ID */
  id: number;

  /** Learning content text */
  content: string;

  /** Category (technical, process, agent-behavior, tooling) */
  category: string | null;

  /** Status (active, archived, superseded) */
  status: string;

  /** Associated sprint ID */
  sprintId: string | null;

  /** Associated session ID */
  sessionId: string | null;

  /** Associated mission ID */
  missionId: string | null;

  /** When the learning was recorded */
  createdAt: string;

  /** Relevance score (higher = more keyword matches) */
  relevance: number;
}

/**
 * Result of learnings search operation.
 */
export interface CmosLearningsSearchResult {
  /** Search query used */
  query: string;

  /** Matching learnings */
  results: LearningSearchResult[];

  /** Total matches found */
  totalMatches: number;

  /** Whether results were limited */
  limited: boolean;
}

/**
 * Input parameters for learnings search action.
 */
export interface CmosLearningsSearchParams {
  /** Search query (required) */
  query: string;

  /** Optional: filter by category */
  category?: string;

  /** Optional: filter by sprint ID */
  sprintId?: string;

  /** Optional: maximum results (1-50, default: 20) */
  limit?: number;

  /** Optional: explicit project root */
  projectRoot?: string;
}

/**
 * Execute the learnings search action.
 */
export async function cmosLearningsSearch(
  params: CmosLearningsSearchParams
): Promise<CmosToolResult<CmosLearningsSearchResult>> {
  if (!params.query || params.query.trim().length === 0) {
    return createError(CmosErrors.missingParameter('query'));
  }

  const limit = params.limit ?? 20;
  const query = params.query.trim();

  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return createError(
      CmosErrors.invalidParameter('query', query, ['At least one keyword with 2+ characters'])
    );
  }

  return withClient(
    (client) => {
      // Sprint 61 m03: lazy-migrate the evergreen column on the search read path.
      ensureLearningsTable(client);

      const conditions: string[] = [];
      const queryParams: (string | number)[] = [];

      if (params.category) {
        conditions.push('category = ?');
        queryParams.push(params.category);
      }

      if (params.sprintId) {
        conditions.push('sprint_id = ?');
        queryParams.push(params.sprintId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // s69-m04: session_id renamed → author_session_id. Resolve the live column
      // so search works on migrated and legacy snapshot-restored stores alike.
      const learningCols = client.getMany<{ name: string }>("PRAGMA table_info('learnings')", []);
      const sessCol =
        learningCols.success && learningCols.data?.some((c) => c.name === 'author_session_id')
          ? 'author_session_id'
          : 'session_id';

      const allResult = client.getMany<{
        id: number;
        content: string;
        category: string | null;
        status: string;
        sprint_id: string | null;
        session_id: string | null;
        mission_id: string | null;
        created_at: string;
      }>(
        `SELECT id, content, category, status, sprint_id, ${sessCol} AS session_id, mission_id, created_at
         FROM learnings ${whereClause}
         ORDER BY created_at DESC, id DESC`,
        queryParams
      );

      if (!allResult.success || !allResult.data) {
        return createSuccess<CmosLearningsSearchResult>({
          query,
          results: [],
          totalMatches: 0,
          limited: false,
        });
      }

      const matched = allResult.data
        .map((row) => ({
          row,
          relevance: keywords.reduce(
            (count, keyword) => count + (row.content.toLowerCase().includes(keyword) ? 1 : 0),
            0
          ),
        }))
        .filter((entry) => entry.relevance > 0)
        .sort(
          (a, b) =>
            b.relevance - a.relevance ||
            b.row.created_at.localeCompare(a.row.created_at) ||
            b.row.id - a.row.id
        );

      const totalMatches = matched.length;
      const results: LearningSearchResult[] = matched.slice(0, limit).map(({ row, relevance }) => ({
        id: row.id,
        content: row.content,
        category: row.category,
        status: row.status,
        sprintId: row.sprint_id,
        sessionId: row.session_id,
        missionId: row.mission_id,
        createdAt: row.created_at,
        relevance,
      }));

      return createSuccess<CmosLearningsSearchResult>({
        query,
        results,
        totalMatches,
        limited: totalMatches > limit,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format learnings search result for LLM readability.
 */
export function formatLearningsSearchForLLM(
  result: CmosToolResult<CmosLearningsSearchResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to search learnings',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  lines.push('🔍 **Learning Search Results**');
  lines.push('');
  lines.push(`Query: "${data.query}"`);
  lines.push(`Found: ${data.totalMatches} match${data.totalMatches === 1 ? '' : 'es'}`);
  if (data.limited) {
    lines.push(`(Showing top ${data.results.length} results)`);
  }
  lines.push('');

  if (data.results.length === 0) {
    lines.push('No learnings found matching the query.');
    lines.push('');
    lines.push('**Suggestions**:');
    lines.push('  • Try different keywords');
    lines.push('  • Use cmos_learnings list to browse all learnings');
    return lines.join('\n');
  }

  for (const r of data.results) {
    const category = r.category ? ` <${r.category}>` : '';
    const sprint = r.sprintId ? ` (${r.sprintId})` : '';
    const mission = r.missionId ? ` {${r.missionId}}` : '';
    const status = r.status !== 'active' ? ` [${r.status}]` : '';
    lines.push(`• ${r.content}${category}${sprint}${mission}${status}`);
    lines.push(`  Created: ${r.createdAt} | Relevance: ${r.relevance}`);
    lines.push('');
  }

  return lines.join('\n');
}
