/**
 * Supersession Detection
 *
 * When a new decision is captured, searches existing active decisions for
 * relevant matches. Sprint 66 m05: routes through HybridRetriever
 * (BM25 + sqlite-vec via RRF k=60) so paraphrase-supersessions that share no
 * surface keywords are surfaced too. Returns candidate decisions that the new
 * one may supersede. No auto-supersession — returns suggestions only.
 *
 * @module tools/cmos/supersession-detection
 */

import type { CmosDatabaseClient } from './client';
import { HybridRetriever } from './fts5-retriever';

const MAX_CANDIDATES = 3;
const CANDIDATE_POOL_MULTIPLIER = 3;
const MIN_KEYWORD_LENGTH = 3;
const MIN_KEYWORDS_FOR_SEARCH = 2;

export interface SupersessionCandidate {
  /** ID of the existing decision */
  id: number;

  /** Text of the existing decision */
  decisionText: string;

  /** Sprint the existing decision belongs to */
  sprintId: string | null;

  /** When the existing decision was created */
  createdAt: string;

  /** Number of overlapping keywords */
  overlapCount: number;
}

export interface SupersessionSuggestion {
  /** Candidates that may be superseded by the new decision */
  candidates: SupersessionCandidate[];

  /** Human-readable suggestion text */
  message: string | null;
}

/**
 * Detect potential supersession candidates for a newly captured decision.
 *
 * Routes the new decision text through HybridRetriever and returns up to
 * MAX_CANDIDATES matches. `overlapCount` is preserved as the secondary filter
 * + display metric so the suggestion message reads the same as before.
 *
 * @param client - Database client
 * @param newDecisionText - The newly captured decision text
 * @param excludeDecisionId - ID of the new decision to exclude from results
 * @returns Supersession suggestion with candidates
 */
export async function detectSupersessionCandidates(
  client: CmosDatabaseClient,
  newDecisionText: string,
  excludeDecisionId?: number
): Promise<SupersessionSuggestion> {
  const keywords = extractKeywords(newDecisionText);

  if (keywords.length < MIN_KEYWORDS_FOR_SEARCH) {
    return { candidates: [], message: null };
  }

  const retriever = new HybridRetriever(client);
  const results = await retriever.search(newDecisionText, {
    types: ['decision'],
    limit: MAX_CANDIDATES * CANDIDATE_POOL_MULTIPLIER,
    statusFilter: ['active'],
    // s82-m04: deliberately NO expandGraph — this is a precision, corpus-mutating path
    // (drives supersession marking); graph-adjacent candidates would over-mark.
  });

  const candidates: SupersessionCandidate[] = results
    .filter((r) => {
      if (excludeDecisionId === undefined) return true;
      const idNum = typeof r.id === 'number' ? r.id : Number(r.id);
      return idNum !== excludeDecisionId;
    })
    .map((r) => ({
      id: typeof r.id === 'number' ? r.id : Number(r.id),
      decisionText: r.text,
      sprintId: r.sprintId,
      createdAt: r.createdAt ?? '',
      overlapCount: countKeywordOverlap(r.text, keywords),
    }))
    .filter((c) => c.overlapCount >= MIN_KEYWORDS_FOR_SEARCH)
    .sort((a, b) => b.overlapCount - a.overlapCount);

  if (candidates.length === 0) {
    return { candidates: [], message: null };
  }

  const limited = candidates.slice(0, MAX_CANDIDATES);
  const message = formatSuggestionMessage(limited);

  return { candidates: limited, message };
}

/**
 * Extract meaningful keywords from decision text.
 * Filters out stop words and short tokens.
 */
export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH);

  const unique = [...new Set(tokens)].filter((t) => !STOP_WORDS.has(t));
  return unique;
}

function countKeywordOverlap(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((count, kw) => count + (lower.includes(kw) ? 1 : 0), 0);
}

function formatSuggestionMessage(candidates: SupersessionCandidate[]): string {
  if (candidates.length === 0) return '';

  const lines = ['Potential supersession detected:'];
  for (const c of candidates) {
    const sprint = c.sprintId ? ` (${c.sprintId})` : '';
    const preview =
      c.decisionText.length > 80 ? c.decisionText.slice(0, 80) + '...' : c.decisionText;
    lines.push(`  - Decision #${c.id}${sprint}: "${preview}" (${c.overlapCount} keyword overlap)`);
  }
  lines.push('');
  lines.push('To mark as superseded: cmos_decisions update decisionId=<id> supersededBy=<new_id>');
  return lines.join('\n');
}

/**
 * Common English stop words to filter from keyword extraction.
 */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'have',
  'been',
  'will',
  'from',
  'they',
  'each',
  'make',
  'like',
  'been',
  'this',
  'that',
  'with',
  'into',
  'then',
  'than',
  'them',
  'these',
  'some',
  'would',
  'other',
  'about',
  'which',
  'when',
  'what',
  'there',
  'their',
  'said',
  'use',
  'used',
  'using',
  'should',
  'also',
  'does',
  'did',
  'just',
  'more',
  'most',
  'very',
  'after',
  'before',
  'between',
  'could',
  'still',
  'over',
  'such',
  'only',
  'where',
  'while',
  'being',
  'same',
  'both',
  'way',
]);
