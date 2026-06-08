/**
 * cmos_session_search Tool
 *
 * MCP tool for searching session history by keyword.
 * Searches across titles, summaries, and captures.
 *
 * @module tools/cmos/cmos-session-search
 */

import { z } from 'zod';
import { withClient } from './client';
import type { CmosToolResult } from './types';
import {
  createError,
  createSuccess,
  CmosErrors,
  VALID_SESSION_TYPES,
  type SessionType,
} from './errors';
import { VALID_CAPTURE_CATEGORIES, type CaptureCategory } from './cmos-session-capture';

// Re-export for convenience
export { VALID_SESSION_TYPES };
export type { SessionType };

/**
 * Matched capture with context.
 */
export interface MatchedCapture {
  /** Capture category */
  category: CaptureCategory;

  /** Capture content */
  content: string;

  /** Timestamp of capture */
  timestamp: string;

  /** Highlight snippet showing match context */
  highlight: string;
}

/**
 * Session search result.
 */
export interface SessionSearchResult {
  /** Session ID */
  id: string;

  /** Session type */
  type: string;

  /** Session title */
  title: string;

  /** Session status */
  status: string;

  /** Associated sprint ID */
  sprintId: string | null;

  /** When the session started */
  startedAt: string;

  /** When the session completed (if completed) */
  completedAt: string | null;

  /** Session summary (if available) */
  summary: string | null;

  /** Total captures in session */
  captureCount: number;

  /** Matched captures (only those matching the query) */
  matchedCaptures: MatchedCapture[];

  /** Match location: where the query was found */
  matchedIn: ('title' | 'summary' | 'captures')[];

  /** Relevance score (higher = more matches) */
  relevance: number;
}

/**
 * Result of session search operation.
 */
export interface CmosSessionSearchResult {
  /** Search query used */
  query: string;

  /** List of matching sessions */
  results: SessionSearchResult[];

  /** Total matches found */
  totalMatches: number;

  /** Whether results were limited */
  limited: boolean;

  /** Filters applied */
  filters: {
    category?: CaptureCategory;
    type?: SessionType;
    since?: string;
    until?: string;
  };
}

/**
 * Input parameters schema for cmos_session_search tool.
 */
export const cmosSessionSearchSchema = z.object({
  /** Search query (required) */
  query: z
    .string()
    .min(1)
    .describe('Search query - keywords to find in session titles, summaries, and captures'),

  /** Filter by capture category */
  category: z
    .enum(VALID_CAPTURE_CATEGORIES)
    .optional()
    .describe('Filter by capture category: decision, learning, constraint, context, next-step'),

  /** Filter by session type */
  type: z
    .enum(VALID_SESSION_TYPES)
    .optional()
    .describe('Filter by session type: planning, review, research, onboarding, check-in, custom'),

  /** Filter sessions created after this date */
  since: z
    .string()
    .optional()
    .describe('Filter sessions started after this ISO date (e.g., "2024-01-01")'),

  /** Filter sessions created before this date */
  until: z.string().optional().describe('Filter sessions started before this ISO date'),

  /** Maximum results to return */
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .optional()
    .describe('Maximum sessions to return (1-100, default: 20)'),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for CMOS database (defaults to cwd)'),
});

export type CmosSessionSearchParams = z.infer<typeof cmosSessionSearchSchema>;

/**
 * MCP Tool Definition for cmos_session_search.
 */
export const cmosSessionSearchToolDefinition = {
  name: 'cmos_session_search',
  description:
    'Search session history by keyword. Searches across titles, summaries, and captures. Supports filtering by capture category, session type, and date range.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Search query - keywords to find in session titles, summaries, and captures',
      },
      category: {
        type: 'string',
        enum: VALID_CAPTURE_CATEGORIES,
        description:
          'Filter by capture category: decision, learning, constraint, context, next-step',
      },
      type: {
        type: 'string',
        enum: VALID_SESSION_TYPES,
        description:
          'Filter by session type: planning, review, research, onboarding, check-in, custom',
      },
      since: {
        type: 'string',
        description: 'Filter sessions started after this ISO date (e.g., "2024-01-01")',
      },
      until: {
        type: 'string',
        description: 'Filter sessions started before this ISO date',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Maximum sessions to return (1-100, default: 20)',
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
 * Session row from database.
 */
interface SessionRow {
  id: string;
  type: string;
  title: string;
  status: string;
  sprint_id: string | null;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  captures: string | null;
}

/**
 * Parsed capture from JSON.
 */
interface ParsedCapture {
  category: string;
  content: string;
  timestamp: string;
  context?: string;
}

/**
 * Execute the cmos_session_search tool.
 *
 * Searches sessions using SQLite LIKE with multiple keywords.
 *
 * @param params - Tool parameters
 * @returns CmosToolResult with search results
 */
export async function cmosSessionSearch(
  params: CmosSessionSearchParams
): Promise<CmosToolResult<CmosSessionSearchResult>> {
  if (!params.query || params.query.trim().length === 0) {
    return createError(CmosErrors.missingParameter('query'));
  }

  const limit = params.limit ?? 20;
  const query = params.query.trim().toLowerCase();

  // Split query into keywords for better matching
  const keywords = query.split(/\s+/).filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return createError(
      CmosErrors.invalidParameter('query', query, ['At least one keyword with 2+ characters'])
    );
  }

  return withClient(
    (client) => {
      // Build WHERE clauses for session-level filters
      const clauses: string[] = [];
      const queryParams: (string | number)[] = [];

      // Add session type filter
      if (params.type) {
        clauses.push('type = ?');
        queryParams.push(params.type);
      }

      // Add date range filters
      if (params.since) {
        clauses.push('started_at >= ?');
        queryParams.push(params.since);
      }

      if (params.until) {
        clauses.push('started_at <= ?');
        queryParams.push(params.until);
      }

      // Build search condition (search in title, summary, and captures)
      const searchConditions: string[] = [];
      for (const keyword of keywords) {
        searchConditions.push(
          `(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(COALESCE(captures, '')) LIKE ?)`
        );
        queryParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
      }

      if (searchConditions.length > 0) {
        clauses.push(`(${searchConditions.join(' AND ')})`);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      // Get matching sessions
      const result = client.getMany<SessionRow>(
        `SELECT id, type, title, status, sprint_id, started_at, completed_at, summary, captures
           FROM sessions
           ${whereClause}
          ORDER BY started_at DESC
          LIMIT ?`,
        [...queryParams, limit + 10] // Fetch extra for filtering
      );

      if (!result.success || !result.data) {
        return createSuccess<CmosSessionSearchResult>({
          query: params.query,
          results: [],
          totalMatches: 0,
          limited: false,
          filters: {
            category: params.category,
            type: params.type,
            since: params.since,
            until: params.until,
          },
        });
      }

      // Process results and compute relevance
      const processedResults: SessionSearchResult[] = [];

      for (const row of result.data) {
        // Parse captures JSON
        let captures: ParsedCapture[] = [];
        try {
          captures = JSON.parse(row.captures || '[]');
        } catch {
          captures = [];
        }

        // Filter captures by category if specified
        if (params.category) {
          captures = captures.filter((c) => c.category === params.category);
        }

        // Find matches
        const matchedIn: ('title' | 'summary' | 'captures')[] = [];
        let relevance = 0;

        // Check title
        const titleLower = row.title.toLowerCase();
        for (const keyword of keywords) {
          if (titleLower.includes(keyword)) {
            if (!matchedIn.includes('title')) matchedIn.push('title');
            relevance += 3; // Title matches are weighted higher
          }
        }

        // Check summary
        const summaryLower = (row.summary || '').toLowerCase();
        for (const keyword of keywords) {
          if (summaryLower.includes(keyword)) {
            if (!matchedIn.includes('summary')) matchedIn.push('summary');
            relevance += 2; // Summary matches are weighted medium
          }
        }

        // Check captures and find matching ones
        const matchedCaptures: MatchedCapture[] = [];
        for (const capture of captures) {
          const contentLower = capture.content.toLowerCase();
          let captureMatches = false;

          for (const keyword of keywords) {
            if (contentLower.includes(keyword)) {
              captureMatches = true;
              relevance += 1;
            }
          }

          if (captureMatches) {
            if (!matchedIn.includes('captures')) matchedIn.push('captures');

            // Create highlight snippet
            const highlight = createHighlight(capture.content, keywords);

            matchedCaptures.push({
              category: capture.category as CaptureCategory,
              content: capture.content,
              timestamp: capture.timestamp,
              highlight,
            });
          }
        }

        // Skip if no matches found
        if (matchedIn.length === 0) continue;

        // Skip if category filter is set and no matching captures
        if (
          params.category &&
          matchedCaptures.length === 0 &&
          !matchedIn.includes('title') &&
          !matchedIn.includes('summary')
        ) {
          continue;
        }

        processedResults.push({
          id: row.id,
          type: row.type,
          title: row.title,
          status: row.status,
          sprintId: row.sprint_id,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          summary: row.summary,
          captureCount: captures.length,
          matchedCaptures,
          matchedIn,
          relevance,
        });
      }

      // Sort by relevance
      processedResults.sort((a, b) => b.relevance - a.relevance);

      // Apply limit
      const limitedResults = processedResults.slice(0, limit);
      const totalMatches = processedResults.length;

      return createSuccess<CmosSessionSearchResult>({
        query: params.query,
        results: limitedResults,
        totalMatches,
        limited: totalMatches > limit,
        filters: {
          category: params.category,
          type: params.type,
          since: params.since,
          until: params.until,
        },
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Create a highlight snippet showing keyword matches in context.
 */
function createHighlight(content: string, keywords: string[]): string {
  const maxLength = 100;
  const contentLower = content.toLowerCase();

  // Find first keyword position
  let firstMatchPos = content.length;
  for (const keyword of keywords) {
    const pos = contentLower.indexOf(keyword);
    if (pos !== -1 && pos < firstMatchPos) {
      firstMatchPos = pos;
    }
  }

  // Extract snippet around the match
  const start = Math.max(0, firstMatchPos - 20);
  const end = Math.min(content.length, firstMatchPos + maxLength - 20);

  let snippet = content.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

/**
 * Format session search result for LLM readability.
 *
 * @param result - Session search result
 * @returns Human-readable summary
 */
export function formatSessionSearchForLLM(result: CmosToolResult<CmosSessionSearchResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '? Failed to search sessions',
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
  lines.push('? **Session Search Results**');
  lines.push('');
  lines.push(`Query: "${data.query}"`);
  lines.push(`Found: ${data.totalMatches} session${data.totalMatches === 1 ? '' : 's'}`);

  // Show filters if applied
  const activeFilters: string[] = [];
  if (data.filters.category) activeFilters.push(`category: ${data.filters.category}`);
  if (data.filters.type) activeFilters.push(`type: ${data.filters.type}`);
  if (data.filters.since) activeFilters.push(`since: ${data.filters.since}`);
  if (data.filters.until) activeFilters.push(`until: ${data.filters.until}`);
  if (activeFilters.length > 0) {
    lines.push(`Filters: ${activeFilters.join(', ')}`);
  }

  if (data.limited) {
    lines.push(`(Showing top ${data.results.length} results)`);
  }
  lines.push('');

  if (data.results.length === 0) {
    lines.push('No sessions found matching the query.');
    lines.push('');
    lines.push('**Suggestions**:');
    lines.push('  - Try different keywords');
    lines.push('  - Remove filters to broaden search');
    lines.push('  - Use cmos_session_list to browse all sessions');
    return lines.join('\n');
  }

  // List results
  for (const r of data.results) {
    const statusIcon = r.status === 'active' ? '?' : '?';
    lines.push(`${statusIcon} **${r.title}** (${r.type})`);
    lines.push(`   ID: ${r.id} | Status: ${r.status}`);
    lines.push(
      `   Started: ${r.startedAt}${r.completedAt ? ` | Completed: ${r.completedAt}` : ''}`
    );
    lines.push(`   Matched in: ${r.matchedIn.join(', ')} | Relevance: ${r.relevance}`);

    if (r.matchedCaptures.length > 0) {
      lines.push(`   Matching captures (${r.matchedCaptures.length}):`);
      for (const mc of r.matchedCaptures.slice(0, 3)) {
        lines.push(`     - [${mc.category}] ${mc.highlight}`);
      }
      if (r.matchedCaptures.length > 3) {
        lines.push(`     ... and ${r.matchedCaptures.length - 3} more`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
