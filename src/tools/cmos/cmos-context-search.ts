// ABOUTME: cmos_context(action="search") handler — Layer 3 working retrieval.
// Sprint 66 m05: routes through HybridRetriever (BM25 + sqlite-vec via RRF k=60)
// across decisions / learnings / missions. Async — see IAsyncRetriever.

import { withClientAsync } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CMOS_ERROR_CODES } from './errors';
import { HybridRetriever, type RankedResult, type RankedResultType } from './fts5-retriever';

export type { RankedResultType } from './fts5-retriever';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ContextSearchResult {
  /** The query that was run */
  query: string;

  /** Ranked results, ordered by combined score (descending) */
  results: RankedResult[];

  /** Total results returned */
  count: number;

  /** Options used for this search */
  options: {
    limit: number;
    recencyWeight: number;
    types: RankedResultType[];
    statusFilter: string[];
  };

  /** Retriever backend used */
  backend: string;
}

export interface ContextSearchParams {
  /** The search query */
  query: string;

  /** Max results (default: 5) */
  limit?: number;

  /** Content types to search (default: ['decision']) */
  types?: RankedResultType[];

  /** Recency weight 0–1 (default: 0.5) */
  recencyWeight?: number;

  /** Status filter (default: ['active']) */
  statusFilter?: string[];

  /** Project root */
  projectRoot?: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Execute cmos_context(action="search").
 *
 * Runs FTS5 + recency-boosted retrieval and returns ranked results.
 * Callers receive a sorted list of decisions (and future content types)
 * relevant to their query, without preloading the full blob.
 */
export async function cmosContextSearch(
  params: ContextSearchParams
): Promise<CmosToolResult<ContextSearchResult>> {
  if (!params.query || params.query.trim().length === 0) {
    return createError<ContextSearchResult>({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      message: 'cmos_context(action="search") requires a non-empty query parameter.',
      suggestion: 'Provide query="your search topic" to retrieve relevant decisions and learnings.',
    });
  }

  const limit = params.limit ?? 5;
  const types: RankedResultType[] = params.types ?? ['decision'];
  const recencyWeight = params.recencyWeight ?? 0.5;
  const statusFilter = params.statusFilter ?? ['active'];

  return withClientAsync(
    async (client) => {
      const retriever = new HybridRetriever(client);
      const caps = retriever.capabilities();

      const results = await retriever.search(params.query, {
        limit,
        types,
        recencyWeight,
        statusFilter,
      });

      return createSuccess<ContextSearchResult>({
        query: params.query,
        results,
        count: results.length,
        options: { limit, recencyWeight, types, statusFilter },
        backend: caps.backend,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatContextSearchForLLM(result: CmosToolResult<ContextSearchResult>): string {
  if (!result.success || !result.data) {
    return `❌ Search failed: ${result.error?.message ?? 'Unknown error'}`;
  }

  const { query, results, count, options, backend } = result.data;
  const lines: string[] = [];

  lines.push(`## Search Results — "${query}"`);
  lines.push(
    `*${count} result(s) | backend: ${backend} | recencyWeight: ${options.recencyWeight}*`
  );
  lines.push('');

  if (count === 0) {
    lines.push('No matching results found.');
    lines.push('');
    lines.push('**Suggestions:**');
    lines.push('- Try broader keywords or synonyms');
    lines.push('- Check that relevant decisions have been captured in sessions');
    lines.push('- Use cmos_decisions(action="list") to browse all decisions');
    return lines.join('\n');
  }

  results.forEach((r, i) => {
    const ageDaysStr = r.ageDays < 1 ? '<1 day' : `${Math.round(r.ageDays)}d`;
    const scoreStr = r.score.toFixed(3);
    const sprintStr = r.sprintId ? ` [${r.sprintId}]` : '';
    const catStr = r.category ? ` (${r.category})` : '';

    lines.push(`**${i + 1}.** ${r.text}${sprintStr}${catStr}`);
    lines.push(
      `   *score: ${scoreStr} | age: ${ageDaysStr} | recency: ${r.recencyFactor.toFixed(2)}*`
    );
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}
