/**
 * cmos_decisions_search Tool
 *
 * MCP tool for searching strategic decisions by keyword.
 * Uses SQLite LIKE for full-text search across decision content.
 *
 * @module tools/cmos/cmos-decisions-search
 */

import { withClientAsync, type CmosDatabaseClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import { loadUnifiedDecisionRecords, type DecisionSource } from './decision-memory';
import { HybridRetriever } from './fts5-retriever';

/**
 * Strategic decision search result.
 */
export interface DecisionSearchResult {
  /** Decision ID */
  id: number;

  /** Decision text */
  decision: string;

  /** Domain (e.g., 'ai-studio', 'general') */
  domain: string | null;

  /** Associated sprint ID */
  sprintId: string | null;

  /** Associated mission ID */
  missionId: string | null;

  /** When the decision was recorded */
  createdAt: string;

  /** Relevance score (higher = more matches) */
  relevance: number;

  /** Where this decision was sourced from */
  source: DecisionSource;

  /** Decision category (architectural, process, tooling, design, business) */
  category: string | null;

  /** Decision status (active, superseded, archived) */
  status: string | null;

  /** JSON array of TraceLab evidence references */
  evidence: string | null;
}

/**
 * Result of decisions search operation.
 */
export interface CmosDecisionsSearchResult {
  /** Search query used */
  query: string;

  /** List of matching decisions */
  results: DecisionSearchResult[];

  /** Total matches found */
  totalMatches: number;

  /** Whether results were limited */
  limited: boolean;
}

/**
 * Input parameters for cmos_decisions_search tool.
 */
export interface CmosDecisionsSearchParams {
  /** Search query (required) */
  query: string;

  /** Optional: filter by domain */
  domain?: string;

  /** Optional: filter by sprint ID */
  sprintId?: string;

  /** Optional: maximum results to return (1-50, default: 20) */
  limit?: number;

  /** Optional: explicit project root to search from */
  projectRoot?: string;
}

/**
 * MCP Tool Definition for cmos_decisions_search.
 */
export const cmosDecisionsSearchToolDefinition = {
  name: 'cmos_decisions_search',
  description:
    'Search strategic decisions by keyword. Returns matching decisions ranked by relevance. Supports filtering by domain and sprint.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Search query - keywords to find in decision text',
      },
      domain: {
        type: 'string',
        description: 'Filter by project domain (e.g., "ai-studio")',
      },
      sprintId: {
        type: 'string',
        description: 'Filter by sprint ID (e.g., "sprint-14")',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        description: 'Maximum results to return (1-50, default: 20)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the cmos_decisions_search tool.
 *
 * Searches strategic decisions using SQLite LIKE with multiple keywords.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with search results
 */
export async function cmosDecisionsSearch(
  params: CmosDecisionsSearchParams
): Promise<CmosToolResult<CmosDecisionsSearchResult>> {
  if (!params.query || params.query.trim().length === 0) {
    return createError(CmosErrors.missingParameter('query'));
  }

  const limit = params.limit ?? 20;
  const query = params.query.trim();

  // Split query into keywords for better matching
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return createError(
      CmosErrors.invalidParameter('query', query, ['At least one keyword with 2+ characters'])
    );
  }

  return withClientAsync(
    async (client) => {
      // Hybrid retrieval first; fall back to keyword AND-match on unified records
      // when hybrid surfaces nothing (e.g. very small corpus or embedder disabled).
      const hybridMatched = await tryHybridSearch(
        client,
        query,
        limit,
        params.domain,
        params.sprintId
      );

      let matched: Array<{
        row: ReturnType<typeof loadUnifiedDecisionRecords>[number];
        relevance: number;
      }>;

      if (hybridMatched.length > 0) {
        matched = hybridMatched;
      } else {
        // Fallback: keyword AND-matching on unified records (preserves the
        // pre-hybrid contract that "every keyword must appear" — useful for
        // strict-quoted queries that hybrid scoring might rank low).
        matched = loadUnifiedDecisionRecords(client, {
          domain: params.domain,
          sprintId: params.sprintId,
        })
          .map((row) => ({
            row,
            relevance: keywords.reduce(
              (count, keyword) => count + (row.decision.toLowerCase().includes(keyword) ? 1 : 0),
              0
            ),
          }))
          .filter((entry) => entry.relevance === keywords.length)
          .sort(
            (a, b) =>
              b.relevance - a.relevance ||
              b.row.createdAt.localeCompare(a.row.createdAt) ||
              b.row.id - a.row.id
          );
      }

      const totalMatches = matched.length;
      const results: DecisionSearchResult[] = matched.slice(0, limit).map(({ row, relevance }) => ({
        id: row.id,
        decision: row.decision,
        domain: row.domain,
        sprintId: row.sprintId,
        missionId: row.missionId,
        createdAt: row.createdAt,
        relevance,
        source: row.source,
        category: row.category,
        status: row.status,
        evidence: row.evidence,
      }));

      return createSuccess<CmosDecisionsSearchResult>({
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
 * Search via HybridRetriever (BM25 + sqlite-vec via RRF k=60), then re-anchor the
 * results against the unified-records loader so domain/sprintId filters apply
 * post-hoc and the response envelope (DecisionSearchResult) carries everything
 * loadUnifiedDecisionRecords exposes (e.g. `domain` is not on RankedResult).
 *
 * Returns [] when hybrid surfaces nothing (caller falls back to keyword AND-match).
 */
async function tryHybridSearch(
  client: CmosDatabaseClient,
  query: string,
  limit: number,
  domain?: string,
  sprintId?: string
): Promise<
  Array<{ row: ReturnType<typeof loadUnifiedDecisionRecords>[number]; relevance: number }>
> {
  const retriever = new HybridRetriever(client);
  const hits = await retriever.search(query, {
    types: ['decision'],
    limit: limit * 2,
    statusFilter: ['active', 'superseded', 'archived'],
  });
  if (hits.length === 0) return [];

  // Hybrid surfaces top hits with score. Re-load the unified records (which
  // expose domain/missionId/source — fields the retriever doesn't carry) and
  // filter post-hoc to the hybrid candidate set, preserving the hybrid rank.
  const orderById = new Map<number, number>();
  hits.forEach((h, i) => {
    const id = typeof h.id === 'number' ? h.id : Number(h.id);
    orderById.set(id, i);
  });

  const lowered = query.toLowerCase();
  const queryKeywords = lowered.split(/\s+/).filter((k) => k.length >= 2);

  const allRecords = loadUnifiedDecisionRecords(client, { domain, sprintId });
  return allRecords
    .filter((record) => orderById.has(record.id))
    .map((record) => ({
      row: record,
      relevance: queryKeywords.reduce(
        (count, keyword) => count + (record.decision.toLowerCase().includes(keyword) ? 1 : 0),
        0
      ),
    }))
    .sort((a, b) => {
      const rankA = orderById.get(a.row.id) ?? Infinity;
      const rankB = orderById.get(b.row.id) ?? Infinity;
      return rankA - rankB || b.relevance - a.relevance;
    });
}

/**
 * Format decisions search result for LLM readability.
 *
 * @param result - Decisions search result
 * @returns Human-readable summary
 */
export function formatDecisionsSearchForLLM(
  result: CmosToolResult<CmosDecisionsSearchResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to search decisions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header
  lines.push('🔍 **Decision Search Results**');
  lines.push('');
  lines.push(`Query: "${data.query}"`);
  lines.push(`Found: ${data.totalMatches} match${data.totalMatches === 1 ? '' : 'es'}`);
  if (data.limited) {
    lines.push(`(Showing top ${data.results.length} results)`);
  }
  lines.push('');

  if (data.results.length === 0) {
    lines.push('No decisions found matching the query.');
    lines.push('');
    lines.push('**Suggestions**:');
    lines.push('  • Try different keywords');
    lines.push('  • Use cmos_decisions_list to browse all decisions');
    return lines.join('\n');
  }

  // List results
  for (const r of data.results) {
    const domain = r.domain ? ` [${r.domain}]` : '';
    const sprint = r.sprintId ? ` (${r.sprintId})` : '';
    const mission = r.missionId ? ` {${r.missionId}}` : '';
    const source = r.source === 'session_capture' ? ' [session capture]' : '';
    lines.push(`• ${r.decision}${domain}${sprint}${mission}${source}`);
    lines.push(`  Created: ${r.createdAt} | Relevance: ${r.relevance}`);
    lines.push('');
  }

  return lines.join('\n');
}
