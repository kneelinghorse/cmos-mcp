// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Single source of truth for terminal (dead / no-open-work) sprint and mission
// ABOUTME: status sets + a case-folded NOT-IN helper, killing the hand-written NOT-IN drift.

/**
 * Terminal status sets + comparison helpers.
 *
 * Three separate hand-written `NOT IN (…terminal statuses…)` lists drifted apart
 * and each shipped the same bug class — a terminal status omitted from one list,
 * so a dead sprint/mission leaked in as if it were live (s74-m02 currentSprint;
 * c265768 'Reverted'; orphan-detection.ts). Centralize the sets here so a new
 * terminal status is added in ONE place, and route every membership check through
 * the case-folded helpers so a drifted-case status ('failed', 'completed') cannot
 * dodge the comparison.
 *
 * @module tools/cmos/terminal-status
 */

/**
 * Sprint statuses that are terminal in the "no resumable work, and not merely
 * completed" sense — a dead sprint. EXCLUDES 'Completed' so the Completed-aware
 * fallbacks (e.g. "most recently active sprint, including Completed") can re-admit
 * a completed sprint by excluding only this set.
 */
export const SPRINT_TERMINAL_STATUSES = ['Archived', 'Failed', 'Dropped', 'Reverted'] as const;

/**
 * Sprint statuses that carry NO OPEN WORK: the dead set plus 'Completed'. A
 * completed sprint has nothing to resume, so open-work hunts treat it as terminal.
 * This is the "Completed-when-applicable" flavor of the sprint-terminal set.
 */
export const SPRINT_NO_OPEN_WORK_STATUSES = [...SPRINT_TERMINAL_STATUSES, 'Completed'] as const;

/**
 * Mission statuses that are terminal — the mission is done and not live work.
 * Distinct from the sprint set: missions are never 'Archived'/'Reverted', but can
 * be 'Deferred' (temporarily parked — still terminal for orphan / live purposes).
 */
export const MISSION_TERMINAL_STATUSES = ['Completed', 'Failed', 'Dropped', 'Deferred'] as const;

/**
 * Sprint statuses that hold an OPEN (current, resumable) sprint. The
 * single-current-sprint invariant (s77-m01) forbids more than one sprint from
 * carrying an OPEN status at a time: putting a sprint into this set auto-demotes
 * every OTHER open sprint to 'Planned'. Centralized here (was hand-spelled in
 * cmos-sprint-add / cmos-sprint-update) so a new open status is added in ONE
 * place and every membership check goes through the case-folded helpers below.
 */
export const SPRINT_OPEN_STATUSES = ['Active', 'In Progress', 'Current'] as const;

/**
 * Positive counterpart of {@link statusNotInSql}: build a case-insensitive
 * `UPPER(<expr>) IN (…)` SQL fragment from a static status list so a drifted-case
 * status ('active') is still matched. The statuses are compile-time constants,
 * never user input, so direct interpolation is safe.
 */
export function statusInSql(statusExpr: string, statuses: readonly string[]): string {
  const list = statuses.map((s) => `'${s.toUpperCase()}'`).join(', ');
  return `UPPER(${statusExpr}) IN (${list})`;
}

/**
 * Case-folded membership test for the sprint OPEN set (mirrors isTerminalStatus'
 * case-insensitivity). Returns true when `status` is one of SPRINT_OPEN_STATUSES
 * regardless of case; a null/undefined status is never open.
 */
export function isOpenStatus(status: string | null | undefined): boolean {
  if (status == null) return false;
  const upper = status.toUpperCase();
  return SPRINT_OPEN_STATUSES.some((s) => s.toUpperCase() === upper);
}

/**
 * Build a case-insensitive `UPPER(<expr>) NOT IN (…)` SQL fragment from a static
 * status list, so a drifted-case status (lowercase 'failed'/'completed') cannot
 * dodge the exclusion. The statuses are compile-time constants, never user input,
 * so direct interpolation is safe. A NULL `<expr>` yields NULL (row excluded from a
 * `WHERE … NOT IN` predicate) — matching plain-SQL `NOT IN` NULL semantics.
 */
export function statusNotInSql(statusExpr: string, statuses: readonly string[]): string {
  const list = statuses.map((s) => `'${s.toUpperCase()}'`).join(', ');
  return `UPPER(${statusExpr}) NOT IN (${list})`;
}

/**
 * Case-folded membership test for JS-side checks (mirrors statusNotInSql's
 * case-insensitivity). Returns true when `status` is in `statuses` regardless of
 * case; a null/undefined status is never terminal.
 */
export function isTerminalStatus(
  status: string | null | undefined,
  statuses: readonly string[]
): boolean {
  if (status == null) return false;
  const upper = status.toUpperCase();
  return statuses.some((s) => s.toUpperCase() === upper);
}

/**
 * s86-m08 — the statuses `sprint_summary` counts as PARKED rather than as work the sprint owned.
 *
 * A mission the sprint deliberately set down (Deferred) or abandoned (Dropped) is neither a
 * success nor a failure of that sprint's execution, and counting it in the denominator punished
 * a sprint for parking work honestly. It is excluded from `total_missions` and reported in
 * `parked_missions` — visible, just not counted against.
 *
 * DELIBERATELY NOT `MISSION_TERMINAL_STATUSES`: that set also contains Completed and Failed,
 * which ARE outcomes the sprint owns. Two sets, two questions.
 */
export const PARKED_MISSION_STATUSES = ['Deferred', 'Dropped'] as const;

/**
 * JS-side twin of the `parked_missions` predicate in the view. Case-folded, and a NULL/absent
 * status is NOT parked — matching the SQL, where `COALESCE(m.status,'')` lands an unknown status
 * in `total_missions` rather than letting it vanish from both counts.
 */
export function isParkedMissionStatus(status: string | null | undefined): boolean {
  return isTerminalStatus(status, PARKED_MISSION_STATUSES);
}
