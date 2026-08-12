/**
 * Staleness Detection
 *
 * Detects and flags decisions/learnings that are older than N sprints
 * and haven't been referenced. Surfaces stale counts for agent awareness.
 *
 * Staleness is sprint-based: items linked to sprints older than the threshold
 * (default 20) relative to the current sprint are candidates. Items that are
 * referenced (via supersession chains or evidence links) are exempt.
 *
 * @module tools/cmos/staleness-detection
 */

import type { CmosDatabaseClient } from './client';
import { ensureReviewTimestamps, ensureLearningsTable } from './schema-migrations';
import { countWrite } from './write-guard';

/**
 * Default staleness threshold in sprints.
 *
 * Sprint 61 m02 — raised from 10 → 20. Halves trigger frequency without losing
 * the abandonment signal: a learning that hasn't been touched OR cited across
 * 20 sprints is genuinely stale, not just dormant. The original 10-sprint
 * threshold was tripping the same institutional rules every sprint and
 * compounding the staleness pile faster than it could be triaged.
 *
 * Override at runtime via `CMOS_STALENESS_THRESHOLD_SPRINTS`. Tests should
 * import this constant rather than hard-coding 20 so future bumps don't
 * require test churn.
 */
export const DEFAULT_STALENESS_THRESHOLD = 20;
const STALENESS_THRESHOLD_ENV = 'CMOS_STALENESS_THRESHOLD_SPRINTS';

/**
 * Result of staleness detection.
 */
export interface StalenessResult {
  /** Number of decisions flagged as stale in this run */
  decisionsFlagged: number;

  /** Number of learnings flagged as stale in this run */
  learningsFlagged: number;

  /** Total stale decisions (including previously flagged) */
  totalStaleDecisions: number;

  /** Total stale learnings (including previously flagged) */
  totalStaleLearnings: number;

  /** The sprint threshold used */
  threshold: number;

  /** Current sprint number used for comparison */
  currentSprintNumber: number | null;

  /** Cutoff sprint number (items at or below this are stale candidates) */
  cutoffSprintNumber: number | null;

  /**
   * s86-m02b — failed flagging writes, in the shape `<what> failed: <code> — <message>`.
   *
   * `decisionsFlagged` / `learningsFlagged` are row COUNTS, and before this field an
   * errored `UPDATE ... SET status = 'stale'` folded into the same 0 as "the WHERE clause
   * matched nothing". The triage surfaces built on those counts (cmos_agent_onboard,
   * cmos_context(view)) therefore reported a clean staleness pass over a store where CMOS
   * had written no status value at all. Both call sites hold a `warnings` array they push
   * into; splice this into it.
   *
   * OPTIONAL so the read-only-role stand-in literal at cmos-context-view.ts stays
   * assignable — a legitimate zero carries no warnings, and only an errored statement
   * populates it.
   */
  warnings?: string[];
}

/**
 * Detect and flag stale decisions and learnings.
 *
 * Idempotent: re-running produces the same result. Items already flagged as
 * 'stale' are not re-flagged. Items with status other than 'active' are skipped.
 *
 * Referenced items are exempt:
 * - Decisions that are the target of another decision's superseded_by
 * - Decisions with non-null evidence links
 *
 * @param client - Database client
 * @param options - Optional threshold override
 * @returns Staleness detection result with counts
 */
export function detectAndFlagStaleness(
  client: CmosDatabaseClient,
  options?: { threshold?: number }
): StalenessResult {
  const threshold = resolveThreshold(options?.threshold);

  // Sprint 52 m03: ensure last_reviewed_at exists before the staleness query reads it.
  // Sprint 61 m03: ensure the learnings.evergreen column exists on the read path so
  // un-migrated DBs self-heal before the WHERE evergreen = 0 filter is evaluated.
  // Both calls are idempotent and cheap once the columns are in place.
  ensureReviewTimestamps(client);
  ensureLearningsTable(client);

  // Get the current sprint number
  const currentSprintNumber = getCurrentSprintNumber(client);
  if (currentSprintNumber === null) {
    // No sprints — nothing to flag
    return {
      decisionsFlagged: 0,
      learningsFlagged: 0,
      totalStaleDecisions: countStale(client, 'strategic_decisions'),
      totalStaleLearnings: countStale(client, 'learnings'),
      threshold,
      currentSprintNumber: null,
      cutoffSprintNumber: null,
    };
  }

  const cutoffSprintNumber = currentSprintNumber - threshold;
  if (cutoffSprintNumber < 1) {
    // Not enough sprints to trigger staleness
    return {
      decisionsFlagged: 0,
      learningsFlagged: 0,
      totalStaleDecisions: countStale(client, 'strategic_decisions'),
      totalStaleLearnings: countStale(client, 'learnings'),
      threshold,
      currentSprintNumber,
      cutoffSprintNumber,
    };
  }

  // Get sprint IDs that are at or below the cutoff
  const staleSprintIds = getStaleSprintIds(client, cutoffSprintNumber);
  if (staleSprintIds.length === 0) {
    return {
      decisionsFlagged: 0,
      learningsFlagged: 0,
      totalStaleDecisions: countStale(client, 'strategic_decisions'),
      totalStaleLearnings: countStale(client, 'learnings'),
      threshold,
      currentSprintNumber,
      cutoffSprintNumber,
    };
  }

  const placeholders = staleSprintIds.map(() => '?').join(', ');

  // s86-m02b: both flag helpers write a status value; a failed UPDATE must not arrive here
  // as an ordinary zero.
  const warnings: string[] = [];

  // Flag stale decisions (excluding referenced ones)
  const decisionsFlagged = flagStaleDecisions(client, staleSprintIds, placeholders, warnings);

  // Flag stale learnings
  const learningsFlagged = flagStaleLearnings(client, staleSprintIds, placeholders, warnings);

  return {
    decisionsFlagged,
    learningsFlagged,
    totalStaleDecisions: countStale(client, 'strategic_decisions'),
    totalStaleLearnings: countStale(client, 'learnings'),
    threshold,
    currentSprintNumber,
    cutoffSprintNumber,
    warnings,
  };
}

/**
 * Get stale counts without flagging (read-only).
 * Useful when you want to report counts without mutating.
 *
 * Sprint 61 m03: ensures the learnings.evergreen column exists before reading
 * (the count filters on `evergreen = 0` to exclude institutional rules).
 */
export function getStaleCounts(client: CmosDatabaseClient): {
  staleDecisions: number;
  staleLearnings: number;
} {
  ensureLearningsTable(client);
  return {
    staleDecisions: countStale(client, 'strategic_decisions'),
    staleLearnings: countStale(client, 'learnings'),
  };
}

/**
 * Per-decision staleness detail with scoring and suggested action.
 */
export interface StaleDecisionDetail {
  /** Decision ID */
  id: number;
  /** Decision text (truncated to 200 chars) */
  text: string;
  /** Current status */
  status: string;
  /** Sprint ID the decision belongs to */
  sprintId: string | null;
  /** Sprint age: how many sprints ago this decision was made */
  sprintAge: number;
  /** Staleness score: 0 (fresh) to 1.0 (very stale) */
  stalenessScore: number;
  /** Category of the decision */
  category: string | null;
  /** Whether this decision has evidence references */
  hasEvidence: boolean;
  /** Whether this decision is referenced by a supersession chain */
  isReferenced: boolean;
  /** Suggested lifecycle action */
  suggestedAction: 'archive' | 'review' | 'confirm';
  /** Reason for the suggestion */
  suggestedReason: string;
}

/**
 * Result of a decision lifecycle review.
 */
export interface DecisionReviewResult {
  /** Decisions needing attention (stale or approaching staleness) */
  decisions: StaleDecisionDetail[];
  /** Total active decisions */
  totalActive: number;
  /** Total stale decisions */
  totalStale: number;
  /** Current sprint number */
  currentSprintNumber: number | null;
  /** Staleness threshold in sprints */
  threshold: number;
}

/**
 * Get detailed staleness review for all decisions needing attention.
 * Returns per-decision scoring and suggested actions.
 *
 * Unlike detectAndFlagStaleness, this does NOT mutate the database.
 * It provides a read-only view for agents to triage.
 */
export function reviewDecisionStaleness(
  client: CmosDatabaseClient,
  options?: { threshold?: number; includeApproaching?: boolean }
): DecisionReviewResult {
  const threshold = resolveThreshold(options?.threshold);
  const includeApproaching = options?.includeApproaching ?? true;
  const currentSprintNumber = getCurrentSprintNumber(client);

  const totalActive = countByStatus(client, 'strategic_decisions', 'active');
  const totalStale = countStale(client, 'strategic_decisions');

  if (currentSprintNumber === null) {
    return { decisions: [], totalActive, totalStale, currentSprintNumber: null, threshold };
  }

  // Get referenced decision IDs (supersession targets)
  const referencedIds = getReferencedDecisionIds(client);

  // Load candidates: stale + active decisions with sprint IDs
  const statusFilter = includeApproaching ? `status IN ('stale', 'active')` : `status = 'stale'`;

  const result = client.getMany<{
    id: number;
    decision_text: string;
    status: string;
    sprint_id: string | null;
    category: string | null;
    evidence: string | null;
  }>(
    `SELECT id, decision_text, status, sprint_id, category, evidence
     FROM strategic_decisions
     WHERE ${statusFilter} AND sprint_id IS NOT NULL
     ORDER BY sprint_id ASC, id ASC`,
    []
  );

  if (!result.success || !result.data) {
    return { decisions: [], totalActive, totalStale, currentSprintNumber, threshold };
  }

  const decisions: StaleDecisionDetail[] = [];

  for (const row of result.data) {
    const sprintNum = extractSprintNumber(row.sprint_id!);
    if (sprintNum === null) continue;

    const sprintAge = currentSprintNumber - sprintNum;
    if (sprintAge < 1) continue; // Skip current sprint decisions

    // Only include decisions beyond half the threshold (approaching) or already stale
    if (includeApproaching && sprintAge < Math.floor(threshold / 2) && row.status !== 'stale') {
      continue;
    }

    const stalenessScore = Math.min(sprintAge / threshold, 1.0);
    const hasEvidence = !!(row.evidence && row.evidence !== '[]' && row.evidence !== '');
    const isReferenced = referencedIds.has(row.id);

    // Determine suggested action
    let suggestedAction: StaleDecisionDetail['suggestedAction'];
    let suggestedReason: string;

    if (hasEvidence || isReferenced) {
      suggestedAction = 'confirm';
      suggestedReason = hasEvidence
        ? 'Has evidence references — confirm still relevant or archive'
        : 'Referenced by supersession chain — confirm still relevant';
    } else if (stalenessScore >= 0.8) {
      suggestedAction = 'archive';
      suggestedReason = `${sprintAge} sprints old — likely no longer actionable`;
    } else {
      suggestedAction = 'review';
      suggestedReason = `${sprintAge} sprints old — approaching staleness threshold (${threshold})`;
    }

    decisions.push({
      id: row.id,
      text:
        row.decision_text.length > 200
          ? row.decision_text.slice(0, 197) + '...'
          : row.decision_text,
      status: row.status,
      sprintId: row.sprint_id,
      sprintAge,
      stalenessScore: Math.round(stalenessScore * 100) / 100,
      category: row.category,
      hasEvidence,
      isReferenced,
      suggestedAction,
      suggestedReason,
    });
  }

  // Sort by staleness score descending (most stale first)
  decisions.sort((a, b) => b.stalenessScore - a.stalenessScore);

  return { decisions, totalActive, totalStale, currentSprintNumber, threshold };
}

/**
 * Get IDs of decisions that are referenced by supersession chains.
 */
function getReferencedDecisionIds(client: CmosDatabaseClient): Set<number> {
  const result = client.getMany<{ superseded_by: number }>(
    `SELECT DISTINCT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL`,
    []
  );
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((r) => r.superseded_by));
}

function countByStatus(client: CmosDatabaseClient, tableName: string, status: string): number {
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${tableName} WHERE status = ?`,
    [status]
  );
  return result.success ? (result.data?.count ?? 0) : 0;
}

function resolveThreshold(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) {
    return explicit;
  }

  const envValue = process.env[STALENESS_THRESHOLD_ENV];
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_STALENESS_THRESHOLD;
}

/**
 * Get the current (most recent active/planned) sprint number.
 * Returns the highest sprint number from non-completed sprints,
 * or the highest overall if all are completed.
 */
function getCurrentSprintNumber(client: CmosDatabaseClient): number | null {
  // Try active sprint first
  const activeResult = client.getOne<{ id: string }>(
    `SELECT id FROM sprints
     WHERE status IN ('Active', 'In Progress', 'Current')
     ORDER BY rowid DESC LIMIT 1`,
    []
  );
  if (activeResult.success && activeResult.data) {
    const num = extractSprintNumber(activeResult.data.id);
    if (num !== null) return num;
  }

  // Fallback to highest numbered sprint
  const allResult = client.getMany<{ id: string }>(
    'SELECT id FROM sprints ORDER BY rowid DESC',
    []
  );
  if (allResult.success && allResult.data) {
    for (const row of allResult.data) {
      const num = extractSprintNumber(row.id);
      if (num !== null) return num;
    }
  }

  return null;
}

/**
 * Extract the numeric suffix from a sprint ID like "sprint-26" → 26.
 */
function extractSprintNumber(sprintId: string): number | null {
  const match = sprintId.match(/^sprint-(\d+)$/);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) ? num : null;
}

/**
 * Get sprint IDs whose numeric suffix is at or below the cutoff.
 */
function getStaleSprintIds(client: CmosDatabaseClient, cutoffSprintNumber: number): string[] {
  const result = client.getMany<{ id: string }>('SELECT id FROM sprints', []);
  if (!result.success || !result.data) return [];

  return result.data
    .filter((row) => {
      const num = extractSprintNumber(row.id);
      return num !== null && num <= cutoffSprintNumber;
    })
    .map((row) => row.id);
}

/**
 * Flag stale decisions. Excludes:
 * - Decisions that are targets of supersession chains (another decision points to them)
 * - Decisions with non-null evidence
 */
function flagStaleDecisions(
  client: CmosDatabaseClient,
  staleSprintIds: string[],
  placeholders: string,
  warnings: string[] = []
): number {
  // Check if the table and required columns exist
  const columns = getTableColumns(client, 'strategic_decisions');
  if (!columns.has('status') || !columns.has('sprint_id')) return 0;

  const hasSupersededBy = columns.has('superseded_by');
  const hasEvidence = columns.has('evidence');
  const hasReviewTimestamp = columns.has('last_reviewed_at');

  // Build exclusion clause for referenced decisions
  const exclusions: string[] = [];
  if (hasSupersededBy) {
    exclusions.push(
      `id NOT IN (SELECT DISTINCT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL)`
    );
  }
  if (hasEvidence) {
    exclusions.push(`(evidence IS NULL OR evidence = '[]' OR evidence = '')`);
  }

  const exclusionClause = exclusions.length > 0 ? `AND ${exclusions.join(' AND ')}` : '';
  const reviewClause = hasReviewTimestamp
    ? `AND (last_reviewed_at IS NULL OR last_reviewed_at < ?)`
    : '';
  const cutoffIso = computeReviewCutoffIso();
  const params: unknown[] = [...staleSprintIds];
  if (hasReviewTimestamp) params.push(cutoffIso);

  const result = client.execute(
    `UPDATE strategic_decisions SET status = 'stale'
     WHERE status = 'active'
       AND sprint_id IN (${placeholders})
       ${reviewClause}
       ${exclusionClause}`,
    params
  );

  return countWrite(result, warnings, "strategic_decisions.status = 'stale'");
}

/**
 * Flag stale learnings.
 *
 * Sprint 52 m03: learnings whose last_reviewed_at (or, when null, created_at) is
 * newer than the cutoff are exempt. This stops re-flagging learnings that an
 * operator has already triaged — archive/supersede/reaffirm all bump the review
 * timestamp, so the next staleness pass leaves them alone.
 *
 * Sprint 61 m03: learnings flagged `evergreen = 1` (institutional rules) drop
 * out of staleness entirely. The column is added by `ensureLearningsTable` on
 * the read path, so un-migrated DBs self-heal before this query runs.
 */
function flagStaleLearnings(
  client: CmosDatabaseClient,
  staleSprintIds: string[],
  placeholders: string,
  warnings: string[] = []
): number {
  const columns = getTableColumns(client, 'learnings');
  if (!columns.has('status') || !columns.has('sprint_id')) return 0;

  const hasReviewTimestamp = columns.has('last_reviewed_at');
  const hasEvergreen = columns.has('evergreen');
  // A learning with a recent last_reviewed_at has been triaged by an operator
  // (status change or reaffirm) and must not be re-flagged by the sprint-age rule.
  // When last_reviewed_at is NULL the sprint-id rule alone governs staleness (preserves
  // historical behavior). The cutoff is ~threshold × 14 days back from now.
  const reviewClause = hasReviewTimestamp
    ? `AND (last_reviewed_at IS NULL OR last_reviewed_at < ?)`
    : '';
  const evergreenClause = hasEvergreen ? `AND evergreen = 0` : '';
  const cutoffIso = computeReviewCutoffIso();

  const params: unknown[] = [...staleSprintIds];
  if (hasReviewTimestamp) params.push(cutoffIso);

  const result = client.execute(
    `UPDATE learnings SET status = 'stale'
     WHERE status = 'active'
       AND sprint_id IN (${placeholders})
       ${reviewClause}
       ${evergreenClause}`,
    params
  );
  return countWrite(result, warnings, "learnings.status = 'stale'");
}

/**
 * Compute a review cutoff date: now - (DEFAULT_STALENESS_THRESHOLD * ~14 days/sprint).
 * A learning whose last_reviewed_at is newer than this cutoff is considered "recently
 * triaged" and exempt from re-flagging.
 */
function computeReviewCutoffIso(): string {
  const msPerSprint = 14 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - DEFAULT_STALENESS_THRESHOLD * msPerSprint).toISOString();
}

function countStale(client: CmosDatabaseClient, tableName: string): number {
  const columns = getTableColumns(client, tableName);
  if (!columns.has('status')) return 0;

  // Sprint 61 m03: evergreen rows on the learnings table are excluded from the
  // surfaced count so an institutional-rule learning that was flagged `stale`
  // BEFORE evergreen was set drops out of the warning the moment the operator
  // toggles the flag — without needing to reset its status.
  const evergreenClause = columns.has('evergreen') ? ` AND evergreen = 0` : '';

  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${tableName} WHERE status = 'stale'${evergreenClause}`,
    []
  );
  return result.success ? (result.data?.count ?? 0) : 0;
}

function getTableColumns(client: CmosDatabaseClient, tableName: string): Set<string> {
  const result = client.getMany<{ name: string }>(`PRAGMA table_info('${tableName}')`, []);
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((row) => row.name));
}
