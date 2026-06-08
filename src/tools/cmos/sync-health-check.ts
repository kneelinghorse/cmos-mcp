/**
 * Sync Health Check — Read-Only Drift Diagnostics
 *
 * Compares SQLite source-of-truth counts against PG mirror counts
 * and reports mismatches as read-only diagnostics.
 *
 * @module tools/cmos/sync-health-check
 */

import { cmosDbReconcile } from './cmos-db-backfill';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SyncHealthCheckResult {
  /** Whether reconciliation succeeded */
  checked: boolean;

  /** Whether all tables match */
  allMatch: boolean;

  /** Total absolute delta across all mismatched tables */
  totalDelta: number;

  /** Number of mismatched tables */
  mismatchedTables: number;

  /** Per-table details (only mismatches) */
  mismatches: Array<{
    table: string;
    sqliteCount: number;
    pgCount: number;
    delta: number;
  }>;

  /** Human-readable summary */
  message: string;

  /** Warnings for surfacing to agent */
  warnings: string[];
}

// ─── Core Health Check ──────────────────────────────────────────────────────

/**
 * Run a sync health check: reconcile SQLite vs PG counts (read-only).
 *
 * @param options - Configuration options
 * @returns SyncHealthCheckResult with drift details
 */
export async function checkSyncHealth(
  options: {
    projectRoot?: string;
  } = {}
): Promise<SyncHealthCheckResult> {
  const reconcileResult = await cmosDbReconcile({
    projectRoot: options.projectRoot,
  });

  if (!reconcileResult.success || !reconcileResult.data) {
    return {
      checked: false,
      allMatch: false,
      totalDelta: 0,
      mismatchedTables: 0,
      mismatches: [],
      message: `Sync health check skipped: ${reconcileResult.error?.message ?? 'dashboard unreachable'}`,
      warnings: [],
    };
  }

  const reconciliation = reconcileResult.data;

  if (reconciliation.allMatch) {
    return {
      checked: true,
      allMatch: true,
      totalDelta: 0,
      mismatchedTables: 0,
      mismatches: [],
      message: 'Sync health: all tables match',
      warnings: [],
    };
  }

  // Calculate drift metrics
  const mismatches = reconciliation.tables
    .filter((t) => !t.match)
    .map((t) => ({
      table: t.table,
      sqliteCount: t.sqliteCount,
      pgCount: t.pgCount,
      delta: t.delta,
    }));

  const totalDelta = mismatches.reduce((sum, m) => sum + Math.abs(m.delta), 0);
  const warnings: string[] = [];

  warnings.push(
    `Sync drift detected: ${mismatches.length} table(s) mismatched, total delta ${totalDelta}`
  );

  for (const m of mismatches) {
    const direction = m.delta > 0 ? 'SQLite ahead' : 'PG ahead';
    warnings.push(
      `  ${m.table}: SQLite=${m.sqliteCount} PG=${m.pgCount} (${direction} by ${Math.abs(m.delta)})`
    );
  }

  return {
    checked: true,
    allMatch: false,
    totalDelta,
    mismatchedTables: mismatches.length,
    mismatches,
    message: `Sync drift detected: delta ${totalDelta}`,
    warnings,
  };
}

/**
 * Format sync health check result for LLM readability.
 */
export function formatSyncHealthForLLM(result: SyncHealthCheckResult): string {
  if (!result.checked) {
    return result.message;
  }

  if (result.allMatch) {
    return 'Sync health: all tables match between SQLite and PG mirror';
  }

  const lines = [
    `Sync drift: ${result.mismatchedTables} table(s), total delta ${result.totalDelta}`,
  ];

  for (const m of result.mismatches) {
    const direction = m.delta > 0 ? 'SQLite ahead' : 'PG ahead';
    lines.push(
      `  ${m.table}: SQLite=${m.sqliteCount} PG=${m.pgCount} (${direction} by ${Math.abs(m.delta)})`
    );
  }

  return lines.join('\n');
}
