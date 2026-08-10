// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s85-m03 — the "N rows have no sprint tag" advisories. Sprint-scoped surfaces count
// ABOUTME: strictly by sprint_id, so honest NULLs must be reported, never silently dropped.

/**
 * Untagged-row advisories (s85-m03).
 *
 * s85-m03 made a session started with no open sprint record `sprint_id = NULL` instead of
 * inheriting a Completed sprint. That is the honest record, but it has a cost: every surface
 * that counts strictly by `sessions.sprint_id = ?` or `strategic_decisions.sprint_id` now
 * under-reports, and an under-report is indistinguishable from "there was no work".
 *
 * The fix is to SAY SO rather than to guess. Deliberately NOT done: falling back to
 * `session_missions` to re-attribute an untagged session — that would reinvent exactly the
 * attribution the write path just refused to invent (RF-10).
 *
 * Three consumers: `cmos_sprint(action="retro")`, `cmos_sprint(action="complete")` and
 * `cmos_decisions(action="review")`. One implementation each so the wording cannot drift.
 *
 * @module tools/cmos/untagged-advisory
 */

import type { CmosDatabaseClient } from './client';

/**
 * Count sessions carrying no sprint tag, or `null` when the query cannot run.
 *
 * Global rather than sprint-scoped by necessity: an untagged row has no sprint to scope to.
 * That is the whole point — these rows are invisible to every sprint-scoped query.
 */
export function countUntaggedSessions(client: CmosDatabaseClient): number | null {
  const result = client.getOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM sessions WHERE sprint_id IS NULL',
    []
  );
  return result.success && result.data ? result.data.count : null;
}

/**
 * Build the sprint-surface advisory, or `null` when there is nothing to report.
 *
 * Used by retro and by the sprint-close summary. Both count sessions (and, through them,
 * decisions and learnings) strictly by `sprint_id`, so both under-report by exactly this many.
 */
export function buildUntaggedSessionAdvisory(client: CmosDatabaseClient): string | null {
  const count = countUntaggedSessions(client);
  if (count === null || count === 0) return null;
  return (
    `${count} session(s) in this store carry no sprint tag and are therefore NOT counted here ` +
    `(nor are the decisions, learnings, constraints and next-steps captured in them). This is ` +
    `expected for sessions started while no sprint was in an open status — the record is ` +
    `untagged by design, not missing. Run cmos_sprint(action="add") before starting work if ` +
    `you want it sprint-scoped.`
  );
}

/**
 * Build the decision-triage advisory, or `null` when there is nothing to report.
 *
 * `cmos_decisions(action="review")` filters `sprint_id IS NOT NULL` when selecting candidates
 * for staleness scoring, so an untagged active decision is permanently invisible to triage —
 * it can never be flagged stale, no matter how old it gets. This is a known, accepted
 * consequence of s85-m03; the advisory is the mitigation, not a fix.
 */
export function buildUntaggedDecisionAdvisory(client: CmosDatabaseClient): string | null {
  const result = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM strategic_decisions WHERE sprint_id IS NULL AND COALESCE(status, 'active') = 'active'",
    []
  );
  if (!result.success || !result.data || result.data.count === 0) return null;
  return (
    `${result.data.count} active decision(s) have no sprint tag and are EXCLUDED from staleness ` +
    `scoring — this review filters on sprint_id IS NOT NULL, so they can never be flagged stale ` +
    `however old they get. Decisions captured while no sprint was open are untagged by design ` +
    `(s85-m03). Review them directly with cmos_decisions(action="list").`
  );
}
