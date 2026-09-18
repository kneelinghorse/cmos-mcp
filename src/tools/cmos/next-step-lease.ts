// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The next-steps lease (policy 2, s91-m06): age is sprint closes survived since creation or
// ABOUTME: last carry; warn at 3, drop at 4 unless carried. One counting rule, shared by every surface.

import type { CmosDatabaseClient } from './client';

/**
 * WHY A LEASE. Next-steps and carry-forwards accumulated with no way to expire: rows #486-#506
 * were six closes old at sprint-91 planning and nothing had disposed of them. Policy 2 (operator,
 * 2026-09-17): a row holds a lease that lapses unless renewed. CARRY is the renewal — it stamps
 * `resolved_at` and resets the clock. REOPEN clears `resolved_at`, so the clock restarts from
 * `created_at`: a reopened row is deliberately not renewed by being reopened.
 *
 * NO SCHEMA CHANGE. Both anchors (`created_at`, the last carry's `resolved_at`) and every close's
 * `sprints.end_date` are already on disk. A carry COUNT would need a column; the policy needs age.
 */

export const LEASE_WARN_AT = 3;
export const LEASE_LAPSE_AT = 4;

/**
 * Published verbatim on every surface that shows the number. The denominator names its own hole:
 * a Completed sprint with no recorded end_date (sprint-13..16 and 18..20 on the origin store) is
 * not counted.
 */
export const LEASE_COUNTING_RULE =
  "closes survived = Completed sprints with a recorded end_date later than the row's last carry " +
  '(resolved_at) or, if never carried, its created_at; a close counts only after it completes, so ' +
  'the closing sprint never counts toward its own close';

/** Correlated subquery over `next_steps` aliased as `n`. */
export const CLOSES_SURVIVED_SQL = `(SELECT COUNT(*) FROM sprints s
    WHERE s.status = 'Completed'
      AND s.end_date IS NOT NULL AND s.end_date <> ''
      AND s.end_date > COALESCE(n.resolved_at, n.created_at))`;

/** Statuses a lease applies to — the open ones. */
export const LEASED_STATUS_SQL = "n.status IN ('pending','carried')";

/**
 * `lapsing`: the next close drops it unless it is carried first. `warning`: the next close warns,
 * the one after drops. The close computes ages BEFORE it writes its own end_date, so a row at
 * LEASE_LAPSE_AT going into a close is dropped by that close.
 */
export type LeaseState = 'ok' | 'warning' | 'lapsing';

export function leaseState(closesSurvived: number): LeaseState {
  if (closesSurvived >= LEASE_LAPSE_AT) return 'lapsing';
  if (closesSurvived >= LEASE_WARN_AT) return 'warning';
  return 'ok';
}

export interface LeaseAge {
  id: number;
  status: 'pending' | 'carried';
  closesSurvived: number;
}

/** Ages of every open next-step, or `null` when the read failed (never a silent zero). */
export function readLeaseAges(client: CmosDatabaseClient): LeaseAge[] | null {
  const rows = client.getMany<LeaseAge>(
    `SELECT n.id AS id, n.status AS status, ${CLOSES_SURVIVED_SQL} AS closesSurvived
       FROM next_steps n
      WHERE ${LEASED_STATUS_SQL}
      ORDER BY n.id ASC`,
    []
  );
  return rows.success && rows.data ? rows.data : null;
}

/** The exact command that undoes a lease drop, printed beside the ids it drops. */
export function reopenCommand(ids: readonly number[]): string {
  return `cmos_context(action="next_steps", nextStepAction="reopen", nextStepIds=[${ids.join(', ')}])`;
}
