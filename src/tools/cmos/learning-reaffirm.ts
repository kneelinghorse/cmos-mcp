// ABOUTME: Learning auto-reaffirm — bumps last_reviewed_at on cited learnings.
// ABOUTME: Sprint 61 m01. Keeps still-true institutional rules out of the staleness pile.

import type { CmosDatabaseClient } from './client';
import type { SanitizedField } from '../../intelligence/content-sanitizer';
import { ensureReviewTimestamps } from './schema-migrations';
import { extractKeywords } from './supersession-detection';
import { HybridRetriever } from './fts5-retriever';
import { checkWrite, type WriteFailure } from './write-guard';

/**
 * Hybrid candidate-pool size for the implicit-reaffirm lookup.
 *
 * Bounds how many learnings the retriever surfaces before the strict
 * IMPLICIT_REAFFIRM_KEYWORD_FLOOR filter runs. Sized to give the keyword-overlap
 * threshold plenty of room to find genuine matches without re-introducing the
 * full-table scan the m02 FTS5 parity migration eliminated.
 */
const IMPLICIT_REAFFIRM_CANDIDATE_POOL = 30;

/**
 * Minimum keyword overlap before an *implicit* (content-based) reaffirm fires.
 *
 * Calibrated against the supersession-detection floor of MIN_KEYWORDS_FOR_SEARCH=2 —
 * a 15-keyword overlap is well above casual incidental matches and indicates the new
 * capture is genuinely talking about the same subject as the cited learning. Lower
 * values would over-bump on any new capture that shares boilerplate vocabulary
 * (e.g. "sprint", "mission", "test") with an unrelated learning. Sprint 61 m01.
 */
export const IMPLICIT_REAFFIRM_KEYWORD_FLOOR = 15;

/**
 * Result of a reaffirm pass — which learnings actually had their timestamps bumped,
 * and any IDs the caller provided that did not resolve to existing rows.
 */
export interface LearningReaffirmOutcome {
  /** Learning IDs touched by the explicit `citesLearningIds[]` path. */
  explicitlyReaffirmedIds: number[];
  /** Learning IDs touched by the implicit FTS5/keyword-overlap path. */
  implicitlyReaffirmedIds: number[];
  /** Explicit IDs the caller supplied that did not resolve to a learning row. */
  missingIds: number[];
  /**
   * s86-m02b — DB failures from this pass, for the caller's `writeFailures` channel.
   *
   * EMPTY IS THE NORMAL CASE. A non-empty entry means the corpus lists above are INCOMPLETE,
   * not that a learning is missing: an id absent from both `missingIds` and the reaffirmed
   * lists was never classified because the query that would have classified it errored.
   */
  writeFailures: WriteFailure[];
}

/**
 * Sanitize a list of incoming learning IDs.
 *
 * Drops entries that are not finite positive integers and surfaces each dropped
 * entry on `sanitizedFields` so the agent can re-emit cleanly. Mirrors the
 * `sanitizeStringArray` contract from `intelligence/content-sanitizer.ts`.
 */
export function sanitizeLearningIds(
  fieldName: string,
  values: readonly unknown[] | undefined
): { cleaned: number[]; sanitizedFields: SanitizedField[] } {
  if (!values) return { cleaned: [], sanitizedFields: [] };
  const cleaned: number[] = [];
  const sanitizedFields: SanitizedField[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      if (!seen.has(value)) {
        seen.add(value);
        cleaned.push(value);
      }
      continue;
    }
    sanitizedFields.push({
      field: `${fieldName}[${i}]`,
      reason: `Dropped non-integer learning id ${JSON.stringify(value)} — citesLearningIds entries must be positive integer learning IDs.`,
    });
  }
  return { cleaned, sanitizedFields };
}

/**
 * Bump `last_reviewed_at` on the given learning IDs in a single UPDATE.
 *
 * Returns the IDs that resolved to existing rows alongside any explicit IDs
 * the caller supplied that did not exist (so the caller can surface them).
 * Idempotent — touching the same row repeatedly is a no-op beyond the timestamp.
 *
 * s86-m02b: both halves say only what they know. A failed existence SELECT classifies NOTHING
 * (see below), and a failed UPDATE reports NO id as reaffirmed; either way the DB error travels
 * out on `writeFailures`.
 */
export function reaffirmLearningsByIds(
  client: CmosDatabaseClient,
  ids: readonly number[],
  reaffirmedAt: string
): { reaffirmedIds: number[]; missingIds: number[]; writeFailures: WriteFailure[] } {
  if (ids.length === 0) return { reaffirmedIds: [], missingIds: [], writeFailures: [] };
  ensureReviewTimestamps(client);
  const writeFailures: WriteFailure[] = [];
  const placeholders = ids.map(() => '?').join(', ');
  const existsResult = client.getMany<{ id: number }>(
    `SELECT id FROM learnings WHERE id IN (${placeholders})`,
    [...ids]
  );
  if (!existsResult.success || !existsResult.data) {
    // "The query failed" is NOT "the learning is absent". Folding a failed SELECT into an empty
    // Set put EVERY cited id into missingIds, and the caller renders that as
    // missingCitedLearningIds — a false claim about the corpus. Classify nothing, disclose the
    // error. (The read side is not walked by the no-silent-write gate; this arm is by hand.)
    writeFailures.push({
      op: 'learnings existence lookup',
      code: existsResult.error?.code ?? 'DB_ERROR',
      message: existsResult.error?.message ?? 'unknown',
    });
    return { reaffirmedIds: [], missingIds: [], writeFailures };
  }
  const existingIds = new Set<number>(existsResult.data.map((r) => r.id));
  const reaffirmedIds: number[] = [];
  const missingIds: number[] = [];
  for (const id of ids) {
    if (existingIds.has(id)) {
      reaffirmedIds.push(id);
    } else {
      missingIds.push(id);
    }
  }
  if (reaffirmedIds.length === 0) {
    return { reaffirmedIds: [], missingIds, writeFailures };
  }
  const idPlaceholders = reaffirmedIds.map(() => '?').join(', ');
  const updateResult = client.execute(
    `UPDATE learnings SET last_reviewed_at = ? WHERE id IN (${idPlaceholders})`,
    [reaffirmedAt, ...reaffirmedIds]
  );
  if (!checkWrite(updateResult, { failures: writeFailures }, 'learnings.last_reviewed_at')) {
    // Nothing was bumped, so nothing may be reported as reaffirmed. The rows still exist, so
    // they are not missing either — the failure entry is the only true thing to say about them.
    return { reaffirmedIds: [], missingIds, writeFailures };
  }
  return { reaffirmedIds, missingIds, writeFailures };
}

/**
 * Detect active learnings whose content overlaps `newContent` by at least
 * `IMPLICIT_REAFFIRM_KEYWORD_FLOOR` keywords.
 *
 * Sprint 66 m05: HybridRetriever surfaces the top candidates from the
 * learnings_fts + learnings_vec substrate (m02). The strict keyword-overlap
 * floor still gates the final set — hybrid widens the candidate pool to
 * include paraphrases, but only rows with ≥15 surface-keyword overlap
 * implicitly reaffirm. Replaces the full-table linear scan over 205+ rows.
 */
export async function detectImplicitLearningCites(
  client: CmosDatabaseClient,
  newContent: string
): Promise<number[]> {
  const keywords = extractKeywords(newContent);
  if (keywords.length < IMPLICIT_REAFFIRM_KEYWORD_FLOOR) {
    return [];
  }
  const tableExists = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'",
    []
  );
  if (!tableExists.success || !tableExists.data) return [];

  const retriever = new HybridRetriever(client);
  const hits = await retriever.search(newContent, {
    types: ['learning'],
    limit: IMPLICIT_REAFFIRM_CANDIDATE_POOL,
    statusFilter: ['active'],
    // s82-m04: deliberately NO expandGraph — this is a precision, corpus-mutating path
    // (drives implicit learning reaffirm); graph-adjacent candidates would over-reaffirm.
  });
  if (hits.length === 0) return [];

  const matched: number[] = [];
  for (const hit of hits) {
    if (countKeywordOverlap(hit.text, keywords) >= IMPLICIT_REAFFIRM_KEYWORD_FLOOR) {
      const id = typeof hit.id === 'number' ? hit.id : Number(hit.id);
      matched.push(id);
    }
  }
  return matched;
}

/**
 * Run the full reaffirm pipeline for a new capture: explicit IDs first,
 * then implicit overlap detection on the capture's text. Implicit IDs that
 * are already covered by the explicit list are not double-counted.
 */
export async function applyLearningReaffirm(
  client: CmosDatabaseClient,
  options: {
    explicitIds: readonly number[];
    newContent: string;
    reaffirmedAt: string;
    /**
     * Learning IDs to drop from implicit-overlap matches. Use this to skip the
     * freshly-inserted learning row when the new capture is itself a learning —
     * a learning shouldn't reaffirm itself via its own content overlap.
     */
    excludeIds?: readonly number[];
  }
): Promise<LearningReaffirmOutcome> {
  const { explicitIds, newContent, reaffirmedAt, excludeIds } = options;

  const explicit = reaffirmLearningsByIds(client, explicitIds, reaffirmedAt);

  const implicitCandidates = await detectImplicitLearningCites(client, newContent);
  const explicitSet = new Set(explicit.reaffirmedIds);
  const excludeSet = new Set(excludeIds ?? []);
  const implicitOnly = implicitCandidates.filter(
    (id) => !explicitSet.has(id) && !excludeSet.has(id)
  );

  const implicit = reaffirmLearningsByIds(client, implicitOnly, reaffirmedAt);

  return {
    explicitlyReaffirmedIds: explicit.reaffirmedIds,
    implicitlyReaffirmedIds: implicit.reaffirmedIds,
    missingIds: explicit.missingIds,
    writeFailures: [...explicit.writeFailures, ...implicit.writeFailures],
  };
}

function countKeywordOverlap(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) count++;
    if (count >= IMPLICIT_REAFFIRM_KEYWORD_FLOOR) return count;
  }
  return count;
}
