/**
 * Constraint Lifecycle Handler
 *
 * Manages structured constraints with staleness detection and archival:
 * - list: View active/all constraints
 * - review: Show stale + expired constraints with staleness scores
 * - archive: Batch archive stale/expired constraints
 *
 * Wired into cmos_context(action="constraints").
 *
 * @module tools/cmos/cmos-constraints
 */

import { withClient, type CmosDatabaseClient } from './client';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import {
  ensureConstraintsTable,
  ensureConstraintReviewTimestamp,
  ensureConstraintEvergreen,
  type ConstraintStatus,
} from './schema-migrations';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConstraintRecord {
  id: number;
  content: string;
  status: ConstraintStatus;
  sessionId: string | null;
  sprintId: string | null;
  createdAt: string;
  expiresAt: string | null;
  archivedAt: string | null;
  /** ISO timestamp of the last reaffirm/review, null if never reviewed (Sprint 82 m01). */
  lastReviewedAt: string | null;
  /** s84-m05: durable "never trip staleness" flag. An evergreen constraint is excluded from
   *  review/count so an institutional rule never ages past the surfacing floor. */
  evergreen: boolean;
}

export interface ConstraintReviewItem extends ConstraintRecord {
  /** 0-100 staleness score. Higher = more stale. */
  stalenessScore: number;
  /** Why this constraint is flagged */
  reason: 'expired' | 'stale_no_expiry' | 'old_sprint';
}

export interface ConstraintsResult {
  constraintAction: string;
  items?: ConstraintRecord[];
  reviewItems?: ConstraintReviewItem[];
  affected: number;
  message: string;
  /** Constraint acted on by reaffirm (Sprint 82 m01). */
  constraintId?: number;
  /** ISO timestamp the reaffirm bumped last_reviewed_at to (Sprint 82 m01). */
  reaffirmedAt?: string;
}

export interface CmosConstraintsParams {
  /** Sub-action: list | review | archive | reaffirm */
  constraintAction: 'list' | 'review' | 'archive' | 'reaffirm';
  /** Filter by status (for list, default: active) */
  constraintStatus?: ConstraintStatus;
  /** Constraint IDs to archive */
  constraintIds?: number[];
  /** Constraint ID to reaffirm (Sprint 82 m01) */
  constraintId?: number;
  /** s84-m05: on reaffirm, optionally set/clear the durable evergreen flag (true = never
   *  trip staleness). Omitted → the reaffirm only bumps last_reviewed_at (unchanged behavior). */
  evergreen?: boolean;
  /** Staleness threshold in days (for review, default: 30) */
  stalenessThresholdDays?: number;
  /** Optional project root */
  projectRoot?: string;
}

// ─── Staleness Scoring ───────────────────────────────────────────────────────

const DEFAULT_STALENESS_THRESHOLD_DAYS = 30;

/**
 * Compute a staleness score (0-100) for a constraint.
 * - Expired constraints get 100
 * - Age-based scoring: linearly increases from 0 to 80 over threshold days
 * - No expiry adds 20 bonus points (incentivizes setting TTLs)
 *
 * Sprint 82 m01: age is measured from `COALESCE(last_reviewed_at, created_at)`, so a
 * reaffirmed constraint (its `last_reviewed_at` bumped to now) resets to a low score —
 * mirroring learnings staleness. A NULL last_reviewed_at falls back to created_at
 * (pre-migration behavior), so no backfill is needed. Expiry is untouched by reaffirm.
 */
function computeStalenessScore(
  constraint: {
    created_at: string;
    expires_at: string | null;
    sprint_id: string | null;
    last_reviewed_at?: string | null;
  },
  now: Date,
  thresholdDays: number
): { score: number; reason: 'expired' | 'stale_no_expiry' | 'old_sprint' } {
  // Expired constraints are maximally stale
  if (constraint.expires_at) {
    const expiresAt = new Date(constraint.expires_at);
    if (expiresAt <= now) {
      return { score: 100, reason: 'expired' };
    }
  }

  const anchorIso = constraint.last_reviewed_at ?? constraint.created_at;
  const anchoredAt = new Date(anchorIso);
  const ageDays = (now.getTime() - anchoredAt.getTime()) / (1000 * 60 * 60 * 24);

  // Age-based score: 0 at 0 days, 80 at thresholdDays
  const ageScore = Math.min(80, Math.round((ageDays / thresholdDays) * 80));

  // Bonus for no expiry set
  const noExpiryBonus = constraint.expires_at ? 0 : 20;

  const score = Math.min(100, ageScore + noExpiryBonus);
  const reason = constraint.expires_at ? 'old_sprint' : 'stale_no_expiry';

  return { score, reason };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function cmosConstraints(
  params: CmosConstraintsParams
): Promise<CmosToolResult<ConstraintsResult>> {
  const action = params.constraintAction;

  if (!action || !['list', 'review', 'archive', 'reaffirm'].includes(action)) {
    return createError<ConstraintsResult>({
      code: 'INVALID_ACTION',
      message: `Invalid constraint action: '${action}'`,
      suggestion: 'Use constraintAction: list | review | archive | reaffirm',
      validValues: ['list', 'review', 'archive', 'reaffirm'],
    });
  }

  return withClient(
    (client) => {
      ensureConstraintsTable(client);
      // Sprint 82 m01: ensure last_reviewed_at exists so review/reaffirm can read+bump it.
      ensureConstraintReviewTimestamp(client);
      // s84-m05: ensure the durable `evergreen` flag column exists (excluded from staleness).
      ensureConstraintEvergreen(client);

      switch (action) {
        case 'list':
          return listConstraints(client, params.constraintStatus ?? 'active');
        case 'review':
          return reviewConstraints(
            client,
            params.stalenessThresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS
          );
        case 'archive':
          return archiveConstraints(client, params.constraintIds);
        case 'reaffirm':
          return reaffirmConstraint(client, params.constraintId, params.evergreen);
        default:
          return createError<ConstraintsResult>({
            code: 'INVALID_ACTION',
            message: `Unknown constraint action: '${action}'`,
          });
      }
    },
    { projectRoot: params.projectRoot }
  );
}

function listConstraints(
  client: CmosDatabaseClient,
  status: ConstraintStatus
): CmosToolResult<ConstraintsResult> {
  const result = client.getMany<{
    id: number;
    content: string;
    status: string;
    session_id: string | null;
    sprint_id: string | null;
    created_at: string;
    expires_at: string | null;
    archived_at: string | null;
    last_reviewed_at: string | null;
    evergreen: number | null;
  }>(
    `SELECT id, content, status, session_id, sprint_id, created_at, expires_at, archived_at, last_reviewed_at, evergreen
     FROM constraints WHERE status = ? ORDER BY created_at ASC`,
    [status]
  );

  if (!result.success || !result.data) {
    return createError<ConstraintsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query constraints',
    });
  }

  const items: ConstraintRecord[] = result.data.map((row) => ({
    id: row.id,
    content: row.content,
    status: row.status as ConstraintStatus,
    sessionId: row.session_id,
    sprintId: row.sprint_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    archivedAt: row.archived_at,
    lastReviewedAt: row.last_reviewed_at,
    evergreen: !!row.evergreen,
  }));

  return createSuccess<ConstraintsResult>({
    constraintAction: 'list',
    items,
    affected: items.length,
    message: `Found ${items.length} constraint(s) with status '${status}'`,
  });
}

function reviewConstraints(
  client: CmosDatabaseClient,
  thresholdDays: number
): CmosToolResult<ConstraintsResult> {
  // Get all active constraints. s84-m05: EXCLUDE evergreen constraints — an institutional rule
  // (e.g. the ≤4KB review digest, constraint #2) must never surface as stale. The write-path
  // migration (cmosConstraints) guarantees the column exists here, so a bare reference is safe.
  const result = client.getMany<{
    id: number;
    content: string;
    status: string;
    session_id: string | null;
    sprint_id: string | null;
    created_at: string;
    expires_at: string | null;
    archived_at: string | null;
    last_reviewed_at: string | null;
    evergreen: number | null;
  }>(
    `SELECT id, content, status, session_id, sprint_id, created_at, expires_at, archived_at, last_reviewed_at, evergreen
     FROM constraints WHERE status = 'active' AND evergreen = 0 ORDER BY created_at ASC`,
    []
  );

  if (!result.success || !result.data) {
    return createError<ConstraintsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query constraints for review',
    });
  }

  const now = new Date();
  const reviewItems: ConstraintReviewItem[] = [];

  for (const row of result.data) {
    const { score, reason } = computeStalenessScore(row, now, thresholdDays);

    // Only include constraints that are stale (score >= 50) or expired
    if (score >= 50) {
      reviewItems.push({
        id: row.id,
        content: row.content,
        status: row.status as ConstraintStatus,
        sessionId: row.session_id,
        sprintId: row.sprint_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        archivedAt: row.archived_at,
        lastReviewedAt: row.last_reviewed_at,
        evergreen: !!row.evergreen,
        stalenessScore: score,
        reason,
      });
    }
  }

  // Sort by staleness score descending
  reviewItems.sort((a, b) => b.stalenessScore - a.stalenessScore);

  return createSuccess<ConstraintsResult>({
    constraintAction: 'review',
    reviewItems,
    affected: reviewItems.length,
    message:
      reviewItems.length > 0
        ? `${reviewItems.length} constraint(s) flagged for review (threshold: ${thresholdDays} days)`
        : `No stale constraints found (threshold: ${thresholdDays} days)`,
  });
}

function archiveConstraints(
  client: CmosDatabaseClient,
  ids: number[] | undefined
): CmosToolResult<ConstraintsResult> {
  const now = new Date().toISOString();

  if (!ids || ids.length === 0) {
    // Archive all expired constraints
    const result = client.execute(
      `UPDATE constraints SET status = 'archived', archived_at = ?
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
      [now, now]
    );
    const affected = result.success && result.data?.changes ? result.data.changes : 0;
    return createSuccess<ConstraintsResult>({
      constraintAction: 'archive',
      affected,
      message:
        affected > 0
          ? `${affected} expired constraint(s) archived`
          : 'No expired constraints to archive',
    });
  }

  let affected = 0;
  for (const id of ids) {
    const result = client.execute(
      `UPDATE constraints SET status = 'archived', archived_at = ? WHERE id = ? AND status = 'active'`,
      [now, id]
    );
    if (result.success && result.data?.changes && result.data.changes > 0) {
      affected++;
    }
  }

  return createSuccess<ConstraintsResult>({
    constraintAction: 'archive',
    affected,
    message: `${affected} constraint(s) archived`,
  });
}

/**
 * Reaffirm an active constraint by bumping last_reviewed_at to now, without changing
 * its status (Sprint 82 m01). Mirrors `cmos_learnings(action="reaffirm")`. Because
 * staleness scoring anchors on COALESCE(last_reviewed_at, created_at), a reaffirmed
 * constraint drops back below the surfacing floor until it ages out again — the review
 * clock is reset without archiving a still-valid rule.
 */
function reaffirmConstraint(
  client: CmosDatabaseClient,
  id: number | undefined,
  evergreen?: boolean
): CmosToolResult<ConstraintsResult> {
  if (id === undefined || typeof id !== 'number') {
    return createError<ConstraintsResult>(CmosErrors.missingParameter('constraintId'));
  }

  const existing = client.getOne<{ id: number; status: string }>(
    'SELECT id, status FROM constraints WHERE id = ?',
    [id]
  );
  if (!existing.success || !existing.data) {
    return createError<ConstraintsResult>({
      code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
      message: `Constraint #${id} not found`,
      suggestion: 'Use cmos_context(action="constraints", constraintAction="list") to find IDs',
    });
  }

  const nowIso = new Date().toISOString();
  // s84-m05: when `evergreen` is supplied, set/clear the durable flag alongside the review-clock
  // bump; when omitted, this is the unchanged Sprint-82 reaffirm (last_reviewed_at only).
  const updateResult =
    evergreen === undefined
      ? client.execute('UPDATE constraints SET last_reviewed_at = ? WHERE id = ?', [nowIso, id])
      : client.execute('UPDATE constraints SET last_reviewed_at = ?, evergreen = ? WHERE id = ?', [
          nowIso,
          evergreen ? 1 : 0,
          id,
        ]);
  if (!updateResult.success) {
    return createError<ConstraintsResult>({
      code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
      message: `Failed to reaffirm constraint: ${updateResult.error?.message ?? 'Unknown error'}`,
    });
  }

  const evergreenNote = evergreen === undefined ? '' : `, evergreen=${evergreen ? 1 : 0}`;
  return createSuccess<ConstraintsResult>({
    constraintAction: 'reaffirm',
    constraintId: id,
    reaffirmedAt: nowIso,
    affected: 1,
    message: `Constraint #${id} reaffirmed — last_reviewed_at bumped${evergreenNote} (status ${existing.data.status}, unchanged)`,
  });
}

// ─── Staleness Helpers (for onboard integration) ─────────────────────────────

/**
 * Read-only check for whether the constraints table carries a given column.
 * Used on the onboard read path so it can degrade to created_at anchoring on an
 * un-migrated store WITHOUT triggering a schema write (Sprint 82 m01).
 */
function constraintsHasColumn(client: CmosDatabaseClient, column: string): boolean {
  const cols = client.getMany<{ name: string }>(`PRAGMA table_info('constraints')`, []);
  if (!cols.success || !cols.data) return false;
  return cols.data.some((c) => c.name === column);
}

/**
 * Count stale + expired active constraints.
 * Returns 0 if the constraints table doesn't exist.
 */
export function getStaleConstraintCount(
  client: CmosDatabaseClient,
  thresholdDays: number = DEFAULT_STALENESS_THRESHOLD_DAYS
): number {
  const tableCheck = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='constraints'",
    []
  );
  if (!tableCheck.success || !tableCheck.data) return 0;

  const now = new Date();
  const thresholdDate = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  // s84-m05: exclude evergreen constraints from the onboard/cmos_review staleness count so an
  // institutional rule (constraint #2) never inflates the banner. READ path — column-guarded
  // (never a schema write), mirroring the last_reviewed_at guard below.
  const hasEvergreen = constraintsHasColumn(client, 'evergreen');
  const evergreenFilter = hasEvergreen ? ' AND evergreen = 0' : '';

  // Count expired
  const expiredResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM constraints
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?${evergreenFilter}`,
    [now.toISOString()]
  );
  const expired = expiredResult.success && expiredResult.data ? expiredResult.data.count : 0;

  // Count old without expiry. Sprint 82 m01: age from COALESCE(last_reviewed_at, created_at)
  // so a reaffirmed constraint drops out of the banner until it ages out again. This is a
  // READ path (called by onboard, possibly under a read-only agent session), so it must
  // never write — the column is detected rather than lazily added (mirrors countStale's
  // `evergreen` guard in staleness-detection.ts). The write-capable cmosConstraints entry
  // owns the ensureConstraintReviewTimestamp migration.
  const hasReviewTs = constraintsHasColumn(client, 'last_reviewed_at');
  const ageAnchor = hasReviewTs ? 'COALESCE(last_reviewed_at, created_at)' : 'created_at';
  const staleResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM constraints
     WHERE status = 'active' AND expires_at IS NULL AND ${ageAnchor} <= ?${evergreenFilter}`,
    [thresholdDate]
  );
  const stale = staleResult.success && staleResult.data ? staleResult.data.count : 0;

  return expired + stale;
}

// ─── LLM Formatter ──────────────────────────────────────────────────────────

export function formatConstraintsForLLM(result: CmosToolResult<ConstraintsResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return `Failed to manage constraints: ${error?.message ?? 'Unknown error'}`;
  }

  const d = result.data;

  if (d.constraintAction === 'list' && d.items) {
    if (d.items.length === 0) {
      return 'No active constraints found.';
    }
    const lines = [`**Constraints (${d.items.length})**`, ''];
    for (const item of d.items) {
      const expiry = item.expiresAt ? ` [expires: ${item.expiresAt.split('T')[0]}]` : '';
      const sprint = item.sprintId ? ` (${item.sprintId})` : '';
      lines.push(`  #${item.id} [${item.status}]${sprint}${expiry}: ${item.content}`);
    }
    return lines.join('\n');
  }

  if (d.constraintAction === 'review' && d.reviewItems) {
    if (d.reviewItems.length === 0) {
      return 'No stale constraints found.';
    }
    const lines = [`**Constraint Review (${d.reviewItems.length} flagged)**`, ''];
    for (const item of d.reviewItems) {
      const expiry = item.expiresAt
        ? ` [expires: ${item.expiresAt.split('T')[0]}]`
        : ' [no expiry]';
      lines.push(
        `  #${item.id} [score: ${item.stalenessScore}] (${item.reason})${expiry}: ${item.content}`
      );
    }
    lines.push('');
    lines.push(
      'Use constraintAction="archive" with constraintIds to archive stale constraints, ' +
        'or constraintAction="reaffirm" with constraintId to reset a still-valid one.'
    );
    return lines.join('\n');
  }

  if (d.constraintAction === 'reaffirm') {
    return [
      '✓ **Constraint Reaffirmed**',
      '',
      `**Constraint**: #${d.constraintId}`,
      `**Reaffirmed at**: ${d.reaffirmedAt}`,
      d.message,
    ].join('\n');
  }

  return d.message;
}
