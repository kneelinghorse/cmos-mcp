/**
 * Supersession Detection
 *
 * When a new decision is captured, searches existing active decisions for
 * relevant matches. Sprint 66 m05: routes through HybridRetriever
 * (BM25 + sqlite-vec via RRF k=60) so paraphrase-supersessions that share no
 * surface keywords are surfaced too. Returns candidate decisions that the new
 * one may supersede. No auto-supersession — returns suggestions only.
 *
 * s92-m04: NO WRITE PATH CALLS THE DETECTOR ANY MORE. Replayed over every historical capture, 69 of
 * 9,035 offers were true, and 28-61% of real supersessions crossed sprints where it could not see
 * them (cmos/research/2026-10-strategy/retrieval-natural-labels.md §5), so capture and record stopped
 * offering candidates; a correction names its target with supersedes=[...]. The module stays for
 * `extractKeywords` (relevance surfacing and the FTS5 retriever use it) and for that replay.
 *
 * @module tools/cmos/supersession-detection
 */

import type { CmosDatabaseClient } from './client';
import { HybridRetriever } from './fts5-retriever';

const MAX_CANDIDATES = 3;
/**
 * s91-m05: the retriever ranks ALL active decisions, and only same-sprint rows survive the sprint
 * filter below, so the pool is widened from 9 to 30 to keep a same-sprint candidate from being
 * crowded out by other sprints' rows. Retriever scoring itself is untouched.
 */
const CANDIDATE_POOL = 30;
const MIN_KEYWORD_LENGTH = 3;
const MIN_KEYWORDS_FOR_SEARCH = 2;
/** Shared tokens with a non-zero weight a candidate needs before it is offered. */
const MIN_WEIGHTED_OVERLAP = 2;
/**
 * Length-normalized floor. Raw overlap grows with text length: two unrelated sprint-88 review
 * rows of 3-8 KB shared 55 weighted tokens. MEASURED on the live corpus (s91-m05): release rows
 * offered across sprints for #1140 sat at 0.02; the genuine #1135 -> #1134 supersession is 0.129.
 */
const MIN_SIMILARITY = 0.05;
/** A token present in more than this share of active decisions is house style, not a claim. */
const COMMON_TOKEN_SHARE = 0.3;
/** Below this many active decisions, document frequency says nothing, so no token is zeroed. */
const MIN_CORPUS_FOR_COMMON_CUTOFF = 10;
export const CANDIDATE_PREVIEW_CHARS = 100;

export interface SupersessionCandidate {
  /** ID of the existing decision */
  id: number;

  /**
   * s91-m05: the first CANDIDATE_PREVIEW_CHARS characters of the existing decision — the same
   * value as `preview`. The key is kept (not removed) so the receipt shape stays additive.
   */
  decisionText: string;

  /** The first CANDIDATE_PREVIEW_CHARS characters of the existing decision. */
  preview: string;

  /** Sprint the existing decision belongs to (always the capturing row's sprint, s91-m05) */
  sprintId: string | null;

  /** When the existing decision was created */
  createdAt: string;

  /** Number of shared whole tokens that carry weight (rare enough to be a claim) */
  overlapCount: number;

  /** Cosine similarity of the two IDF-weighted token sets, 0..1 (rounded to 3 places) */
  score: number;
}

export interface SupersessionSuggestion {
  /** Candidates that may be superseded by the new decision */
  candidates: SupersessionCandidate[];

  /** Human-readable suggestion text */
  message: string | null;
}

export interface SupersessionDetectionOptions {
  /**
   * The capturing row's sprint. Only active decisions in the SAME sprint are candidates; NULL
   * matches NULL. A prior sprint's decisions are archived by its close, so any still active are
   * the untagged rows — which is why the rule is "same sprint", not "open sprint".
   */
  sprintId: string | null;
  /** The new decision's own id, never offered as its own candidate. */
  excludeDecisionId?: number;
}

/**
 * Detect potential supersession candidates for a newly captured decision.
 *
 * s91-m05 — eight independent reports showed the detector offering the historical review verdicts
 * a good close cites, because (1) it ranked every sprint's active decisions, (2) it counted
 * SUBSTRING hits (`sprint` hit `sprints`, `api` hit `capital`), (3) house-style vocabulary
 * ("MEASURED", "THE RULING", review, close, mission) scored like a claim, and (4) a row the new
 * text cites by `#id` was offered as the row it replaces. Now: same-sprint candidacy; whole-token
 * overlap weighted by inverse document frequency over the active-decision corpus, with tokens in
 * more than COMMON_TOKEN_SHARE of it contributing nothing (once the corpus has
 * MIN_CORPUS_FOR_COMMON_CUTOFF rows), ranked by length-normalized cosine similarity; cited ids
 * excluded; and a bounded preview on the receipt.
 *
 * KNOWN RESIDUAL, measured rather than tuned away: #1086 -> #1085 (both sprint-88) scores 0.116
 * against the genuine #1135 -> #1134 at 0.129. #1086 resolves an item #1085 raised without citing
 * it by `#id`; no text-similarity threshold separates "resolves an item from" and "supersedes"
 * with one positive to calibrate against, so this pair stays offerable.
 *
 * NOT LOOKED AT: fts5-retriever.ts scoring and its unused `sprintRange` option;
 * relevance-surfacing.ts (mission-start surfacing is deliberately cross-sprint).
 */
export async function detectSupersessionCandidates(
  client: CmosDatabaseClient,
  newDecisionText: string,
  options: SupersessionDetectionOptions
): Promise<SupersessionSuggestion> {
  const keywords = extractKeywords(newDecisionText);

  if (keywords.length < MIN_KEYWORDS_FOR_SEARCH) {
    return { candidates: [], message: null };
  }

  const retriever = new HybridRetriever(client);
  const results = await retriever.search(newDecisionText, {
    types: ['decision'],
    limit: CANDIDATE_POOL,
    statusFilter: ['active'],
    // s82-m04: deliberately NO expandGraph — this is a precision, corpus-mutating path
    // (drives supersession marking); graph-adjacent candidates would over-mark.
  });

  const cited = citedDecisionIds(newDecisionText);
  const weights = tokenWeights(client);
  const newTokens = new Set(keywords);

  const newNorm = vectorNorm(keywords, weights);

  const candidates: SupersessionCandidate[] = results
    .map((r) => ({ ...r, idNum: typeof r.id === 'number' ? r.id : Number(r.id) }))
    .filter((r) => r.idNum !== options.excludeDecisionId)
    .filter((r) => !cited.has(r.idNum))
    .filter((r) => (r.sprintId ?? null) === options.sprintId)
    .map((r) => {
      const candidateTokens = extractKeywords(r.text);
      const weighted = candidateTokens
        .filter((t) => newTokens.has(t))
        .map((t) => weights(t))
        .filter((w) => w > 0);
      const norms = newNorm * vectorNorm(candidateTokens, weights);
      const similarity = norms > 0 ? weighted.reduce((sum, w) => sum + w * w, 0) / norms : 0;
      const preview = r.text.slice(0, CANDIDATE_PREVIEW_CHARS);
      return {
        id: r.idNum,
        decisionText: preview,
        preview,
        sprintId: r.sprintId ?? null,
        createdAt: r.createdAt ?? '',
        overlapCount: weighted.length,
        score: Math.round(similarity * 1000) / 1000,
      };
    })
    .filter((c) => c.overlapCount >= MIN_WEIGHTED_OVERLAP && c.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { candidates: [], message: null };
  }

  const limited = candidates.slice(0, MAX_CANDIDATES);
  const message = formatSuggestionMessage(limited, options.excludeDecisionId);

  return { candidates: limited, message };
}

/**
 * Extract meaningful keywords from decision text: whole lower-cased tokens, stop words removed.
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

/** Euclidean norm of a binary token vector under the IDF weights. */
function vectorNorm(tokens: readonly string[], weights: (token: string) => number): number {
  return Math.sqrt(tokens.reduce((sum, t) => sum + weights(t) ** 2, 0));
}

/** Every `#<id>` the text names. A row cited by reference is carried, not replaced. */
function citedDecisionIds(text: string): Set<number> {
  return new Set([...text.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])));
}

/**
 * Inverse-document-frequency weight per token over the ACTIVE decision corpus, computed at query
 * time (a maintained term table would be a migration to save milliseconds). A token in more than
 * COMMON_TOKEN_SHARE of the corpus weighs zero once the corpus is large enough for that share to
 * mean anything.
 */
function tokenWeights(client: CmosDatabaseClient): (token: string) => number {
  const corpus = client.getMany<{ decision_text: string }>(
    `SELECT decision_text FROM strategic_decisions WHERE status = 'active'`,
    []
  );
  const docs = corpus.success ? (corpus.data ?? []) : [];
  const n = docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of extractKeywords(doc.decision_text ?? '')) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return (token) => {
    const count = df.get(token) ?? 0;
    if (n >= MIN_CORPUS_FOR_COMMON_CUTOFF && count / n > COMMON_TOKEN_SHARE) return 0;
    return Math.log((n + 1) / (count + 1)) + 1;
  };
}

function formatSuggestionMessage(
  candidates: SupersessionCandidate[],
  newDecisionId?: number
): string {
  if (candidates.length === 0) return '';

  const lines = ['Potential supersession detected:'];
  for (const c of candidates) {
    const sprint = c.sprintId ? ` (${c.sprintId})` : '';
    const preview =
      c.decisionText.length > 80 ? c.decisionText.slice(0, 80) + '...' : c.decisionText;
    lines.push(
      `  - Decision #${c.id}${sprint}: "${preview}" (${c.overlapCount} shared rare terms, score ${c.score})`
    );
  }
  lines.push('');
  lines.push('To mark a candidate as superseded:');
  for (const c of candidates) {
    lines.push(
      `  cmos_decisions(action="update", decisionId=${c.id}, supersededBy=${newDecisionId ?? '<new_decision_id>'})`
    );
  }
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
