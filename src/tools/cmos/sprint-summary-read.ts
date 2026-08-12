// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m08 — how a sprint_summary reader selects parked_missions on a store whose view
// ABOUTME: the migration was allowed to fail to upgrade, and how it says so when a read errors.

import type { CmosToolError } from './types';
import type { SprintSummaryViewResult } from './schema-migrations';

/**
 * The `parked_missions` projection, chosen by whether the column actually exists.
 *
 * WHY THIS IS NOT JUST `'parked_missions'`. `ensureSprintSummaryView` is DOCUMENTED as allowed
 * to fail: it leaves a same-named base table alone, it cannot write to a read-only store, and its
 * DROP can lose a race for the write lock. On any of those stores the view still has the old
 * shape — and a reader that selects the new column unconditionally does not degrade, it returns
 * `no such column: parked_missions`. That would be a REGRESSION: `cmos_sprint(list)` and
 * `(show)` answered fine on those stores before this column existed.
 *
 * So the reader asks first. When the column is absent it projects a literal `0` under the same
 * name, the answer keeps its shape, and the migration's warning (carried on the same result)
 * tells the operator that parked work is still inside `total_missions` on this store. A zero the
 * caller is told to distrust beats an error that explains nothing.
 */
export function parkedColumn(parkedAvailable: boolean): string {
  return parkedAvailable ? 'parked_missions' : '0 AS parked_missions';
}

/**
 * Attach the migration's warnings to an error the migration may have caused.
 *
 * `createError` has no warnings channel — an error envelope carries `suggestion`, not
 * `warnings` — so a failed read on a store whose view could not be upgraded would otherwise
 * surface as a bare DB error with the one fact that explains it thrown away. This folds that
 * fact into the suggestion, which formatters DO render.
 */
export function withViewContext(
  error: CmosToolError,
  migration: SprintSummaryViewResult
): CmosToolError {
  const notes = migration.warnings ?? [];
  if (notes.length === 0) return error;

  const context = notes.join(' ');
  return {
    ...error,
    suggestion: error.suggestion ? `${error.suggestion} — ${context}` : context,
  };
}
