// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Defines the one SQL ordering contract for sprint IDs across CMOS read paths.
// ABOUTME: Sorts sprint-N numerically while keeping legacy IDs and NULLs deterministic.

type SprintOrderDirection = 'ASC' | 'DESC';

const TRUSTED_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Build the comma-separated SQL keys that order a sprint-ID expression.
 *
 * Canonical `sprint-<digits>` IDs sort numerically and always precede legacy shapes. The raw
 * binary ID is both the deterministic fallback for legacy values and the tie-break for numeric
 * aliases such as `sprint-01` and `sprint-1`. NULL is kept last in either direction.
 *
 * Callers must pass a trusted SQL column expression, never user input.
 */
export function sprintIdOrderSql(expression: string, direction: SprintOrderDirection): string {
  if (!TRUSTED_SQL_IDENTIFIER.test(expression)) {
    throw new Error(`Invalid sprint-ID SQL expression: ${expression}`);
  }
  if (direction !== 'ASC' && direction !== 'DESC') {
    throw new Error(`Invalid sprint-ID sort direction: ${String(direction)}`);
  }

  const canonical = `${expression} GLOB 'sprint-[0-9]*' AND SUBSTR(${expression}, 8) NOT GLOB '*[^0-9]*'`;

  return `CASE
        WHEN ${expression} IS NULL THEN 2
        WHEN ${canonical} THEN 0
        ELSE 1
      END ASC,
      CASE WHEN ${canonical} THEN CAST(SUBSTR(${expression}, 8) AS INTEGER) END ${direction},
      ${expression} COLLATE BINARY ${direction}`;
}
