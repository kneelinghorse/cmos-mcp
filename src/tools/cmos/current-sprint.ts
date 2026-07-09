// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m02 — the ONE canonical current-sprint resolver. Collapses the four
// divergent pickers (onboard, mission-status, session-start, capture) onto one cascade.

/**
 * Canonical current-sprint resolver (s77-m02).
 *
 * Before s77 there were FOUR divergent "current sprint" pickers, and two of them
 * disagreed on a multi-Active store: onboard's `getExplicitOpenSprintId` ordered
 * `start_date DESC` (newest wins) while mission-status' `findActiveSprint` ordered
 * `start_date ASC` (oldest wins) — the recorded s75 #853 split (A said sprint-76,
 * B said sprint-75). This module is the single source of truth every surface now
 * delegates to, so they can never disagree again.
 *
 * The write-time invariant (s77-m01) keeps any store THIS server writes to a
 * single open sprint; this read-side resolver is the safety net for legacy /
 * foreign stores we don't control that already hold two open sprints.
 *
 * `resolveCurrentSprintId` returns the sprint ID only; callers layer their own
 * context/shape on top (onboard's `getSprintContextById`, mission-status'
 * `isComplete`, etc.).
 *
 * @module tools/cmos/current-sprint
 */

import type { CmosDatabaseClient } from './client';
import {
  SPRINT_TERMINAL_STATUSES as DEAD_SPRINT_STATUSES,
  SPRINT_NO_OPEN_WORK_STATUSES as NO_OPEN_WORK_STATUSES,
  SPRINT_OPEN_STATUSES,
  statusInSql,
  statusNotInSql as statusNotIn,
} from './terminal-status';

/**
 * Resolve the single current sprint ID via a mission-aware 6-step cascade.
 *
 * DEAD_SPRINT_STATUSES (Archived/Failed/Dropped/Reverted) never surface as
 * current even with recent activity (extends the s55-m03 Archived-only exclusion,
 * decision #567); the Completed-aware fallbacks re-admit Completed by excluding
 * only the DEAD set. Matching is case-insensitive (decision #839 / s75-m02).
 *
 * Strategy:
 * 1. Sprint with In Progress or Current missions (active work)
 * 2. Explicit open (In Progress/Current/Active) sprint that still has open work or
 *    no missions yet — tie-broken by most-recent real activity (s77-m02 Fork 1b)
 * 3. Most recently active non-Completed sprint when status fields drift behind reality
 * 4. Earliest non-completed sprint with Queued missions (next work)
 * 5. Most recently active sprint by real activity (any non-Archived, includes Completed)
 * 6. Fall back to status-based ordering
 */
export function resolveCurrentSprintId(client: CmosDatabaseClient): string | null {
  // Step 1: Find sprint with active work (In Progress or Current missions) on a
  // non-Archived sprint.
  const activeWorkResult = client.getOne<{ sprint_id: string }>(
    `SELECT m.sprint_id FROM missions m
       JOIN sprints s ON s.id = m.sprint_id
      WHERE m.status IN ('In Progress', 'Current')
        AND m.sprint_id IS NOT NULL
        AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
      LIMIT 1`,
    []
  );
  if (activeWorkResult.success && activeWorkResult.data?.sprint_id) {
    return activeWorkResult.data.sprint_id;
  }

  // Step 2: Prefer an explicitly open sprint unless it already looks fully completed.
  const explicitOpenSprintId = getExplicitOpenSprintId(client);
  if (explicitOpenSprintId) {
    return explicitOpenSprintId;
  }

  // Step 3: Most recently active sprint with mission/session activity, even if the
  // sprint status was never advanced beyond Planned.
  const recentActivitySprintId = getMostRecentlyActiveSprintId(client);
  if (recentActivitySprintId) {
    return recentActivitySprintId;
  }

  // Step 4: Earliest non-completed, non-archived sprint with Queued missions.
  const queuedWorkResult = client.getOne<{ sprint_id: string }>(
    `SELECT m.sprint_id FROM missions m
     JOIN sprints s ON m.sprint_id = s.id
     WHERE m.status = 'Queued' AND m.sprint_id IS NOT NULL
       AND ${statusNotIn("COALESCE(s.status, 'Planned')", NO_OPEN_WORK_STATUSES)}
     ORDER BY CASE COALESCE(s.status, 'Planned')
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        WHEN 'Planned' THEN 3
        ELSE 4
      END, COALESCE(s.start_date, '9999-12-31') ASC, s.rowid ASC
     LIMIT 1`,
    []
  );
  if (queuedWorkResult.success && queuedWorkResult.data?.sprint_id) {
    return queuedWorkResult.data.sprint_id;
  }

  // Step 5: Most recently active non-Archived sprint by real mission/session
  // activity, allowing Completed status. sprints.end_date (Step 6) is
  // admin-editable and drifts later than real activity (Sprint 63 m01), so
  // mission/session timestamps yield the genuinely most-recent shipped sprint.
  const recentlyActiveSprintId = getMostRecentlyActiveSprintIdIncludingCompleted(client);
  if (recentlyActiveSprintId) {
    return recentlyActiveSprintId;
  }

  // Step 6: Fall back to status-based ordering, with dead sprints excluded. When
  // no Active/In Progress/Planned sprint exists, prefer the latest Completed
  // sprint over silently returning a dead record.
  const result = client.getOne<{ id: string }>(
    `SELECT id
       FROM sprints
      WHERE ${statusNotIn("COALESCE(status, 'Planned')", DEAD_SPRINT_STATUSES)}
      ORDER BY CASE status
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        WHEN 'Planned' THEN 3
        WHEN 'Completed' THEN 4
        ELSE 5
      END, COALESCE(end_date, start_date, '') DESC, rowid DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.id ?? null) : null;
}

/**
 * Step 2: the highest-priority explicitly-open sprint that still has open work (or
 * no missions yet).
 *
 * s77-m02 Fork 1b: within a status tier the tie-break is **most-recent real
 * activity** (max mission.completed_at / session timestamp) then `rowid DESC` —
 * NOT `start_date DESC`. This reuses the same activity signal Steps 3/5 already
 * trust (decision #661) and makes a multi-Active store deterministic: the sprint
 * that shipped work most recently wins, so onboard and mission-status agree
 * (retires the #853 ASC-vs-DESC divergence).
 */
function getExplicitOpenSprintId(client: CmosDatabaseClient): string | null {
  const result = client.getOne<{ id: string }>(
    `SELECT s.id
       FROM sprints s
       LEFT JOIN (
         SELECT sprint_id, MAX(activity_at) AS last_activity
           FROM (
             SELECT m.sprint_id AS sprint_id, m.completed_at AS activity_at
               FROM missions m
              WHERE m.sprint_id IS NOT NULL AND m.completed_at IS NOT NULL
             UNION ALL
             SELECT sess.sprint_id AS sprint_id,
                    COALESCE(sess.completed_at, sess.started_at) AS activity_at
               FROM sessions sess
              WHERE sess.sprint_id IS NOT NULL
           )
          GROUP BY sprint_id
       ) act ON act.sprint_id = s.id
      WHERE ${statusInSql("COALESCE(s.status, 'Planned')", SPRINT_OPEN_STATUSES)}
        AND (
          NOT EXISTS (
            SELECT 1 FROM missions m WHERE m.sprint_id = s.id
          )
          OR EXISTS (
            SELECT 1 FROM missions m
             WHERE m.sprint_id = s.id AND COALESCE(m.status, '') != 'Completed'
          )
        )
      ORDER BY CASE COALESCE(s.status, 'Planned')
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        ELSE 3
      END, COALESCE(act.last_activity, '') DESC, s.rowid DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.id ?? null) : null;
}

/**
 * Step 3: most recently active sprint by real mission/session activity, excluding
 * the full NO_OPEN_WORK set (Archived/Failed/Dropped/Completed) so only genuinely
 * live parent sprints bubble up before the Completed-aware Step 5 (Sprint 74 m02).
 */
function getMostRecentlyActiveSprintId(client: CmosDatabaseClient): string | null {
  const result = client.getOne<{ sprint_id: string }>(
    `SELECT activity.sprint_id
       FROM (
         SELECT m.sprint_id, m.completed_at AS activity_at
           FROM missions m
           JOIN sprints s ON s.id = m.sprint_id
          WHERE m.sprint_id IS NOT NULL
            AND m.completed_at IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", NO_OPEN_WORK_STATUSES)}
         UNION ALL
         SELECT sess.sprint_id, COALESCE(sess.completed_at, sess.started_at) AS activity_at
           FROM sessions sess
           JOIN sprints s ON s.id = sess.sprint_id
          WHERE sess.sprint_id IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", NO_OPEN_WORK_STATUSES)}
       ) AS activity
      WHERE activity.activity_at IS NOT NULL
      GROUP BY activity.sprint_id
      ORDER BY MAX(activity.activity_at) DESC, activity.sprint_id DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.sprint_id ?? null) : null;
}

/**
 * Step 5: variant of {@link getMostRecentlyActiveSprintId} that allows Completed
 * sprints (the steady-state fallback for fork-and-forget projects where every
 * sprint is Completed) but still excludes the DEAD set (Sprint 63 m01 / 74 m02).
 */
function getMostRecentlyActiveSprintIdIncludingCompleted(
  client: CmosDatabaseClient
): string | null {
  const result = client.getOne<{ sprint_id: string }>(
    `SELECT activity.sprint_id
       FROM (
         SELECT m.sprint_id, m.completed_at AS activity_at
           FROM missions m
           JOIN sprints s ON s.id = m.sprint_id
          WHERE m.sprint_id IS NOT NULL
            AND m.completed_at IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
         UNION ALL
         SELECT sess.sprint_id, COALESCE(sess.completed_at, sess.started_at) AS activity_at
           FROM sessions sess
           JOIN sprints s ON s.id = sess.sprint_id
          WHERE sess.sprint_id IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
       ) AS activity
      WHERE activity.activity_at IS NOT NULL
      GROUP BY activity.sprint_id
      ORDER BY MAX(activity.activity_at) DESC, activity.sprint_id DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.sprint_id ?? null) : null;
}
