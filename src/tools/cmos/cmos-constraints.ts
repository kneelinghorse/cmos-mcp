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
import { createError, createSuccess } from './errors';
import { ensureConstraintsTable, type ConstraintStatus } from './schema-migrations';

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
}

export interface CmosConstraintsParams {
  /** Sub-action: list | review | archive */
  constraintAction: 'list' | 'review' | 'archive';
  /** Filter by status (for list, default: active) */
  constraintStatus?: ConstraintStatus;
  /** Constraint IDs to archive */
  constraintIds?: number[];
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
 */
function computeStalenessScore(
  constraint: { created_at: string; expires_at: string | null; sprint_id: string | null },
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

  const createdAt = new Date(constraint.created_at);
  const ageDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

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

  if (!action || !['list', 'review', 'archive'].includes(action)) {
    return createError<ConstraintsResult>({
      code: 'INVALID_ACTION',
      message: `Invalid constraint action: '${action}'`,
      suggestion: 'Use constraintAction: list | review | archive',
      validValues: ['list', 'review', 'archive'],
    });
  }

  return withClient(
    (client) => {
      ensureConstraintsTable(client);

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
  }>(
    `SELECT id, content, status, session_id, sprint_id, created_at, expires_at, archived_at
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
  // Get all active constraints
  const result = client.getMany<{
    id: number;
    content: string;
    status: string;
    session_id: string | null;
    sprint_id: string | null;
    created_at: string;
    expires_at: string | null;
    archived_at: string | null;
  }>(
    `SELECT id, content, status, session_id, sprint_id, created_at, expires_at, archived_at
     FROM constraints WHERE status = 'active' ORDER BY created_at ASC`,
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

// ─── Staleness Helpers (for onboard integration) ─────────────────────────────

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

  // Count expired
  const expiredResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM constraints
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    [now.toISOString()]
  );
  const expired = expiredResult.success && expiredResult.data ? expiredResult.data.count : 0;

  // Count old without expiry
  const staleResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM constraints
     WHERE status = 'active' AND expires_at IS NULL AND created_at <= ?`,
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
    lines.push('Use constraintAction="archive" with constraintIds to archive stale constraints.');
    return lines.join('\n');
  }

  return d.message;
}
