// ABOUTME: Sprint 69 m03 — the single shared helper every firehose-table INSERT
// routes through to stamp the 6 per-row genesis columns (s68 ADR §1/§2, as
// amended s69-m03). Centralizing the stamp turns the ~21-site call-site sweep
// into mechanical splices and gives the AST coverage test a sharp target.

import { ulid } from 'ulid';
import type { CmosDatabaseClient } from './client';
import { GENESIS_TYPE_BY_TABLE, type FirehoseTable } from '../../types/event-types';
import { ensureAuthorNamespaceColumns, ensureFirehoseEventColumns } from './schema-migrations';

/** The 6 genesis columns, in canonical order, stamped on every firehose row. */
export const GENESIS_COLUMN_NAMES = [
  'project_id',
  'stable_event_id',
  'occurred_at',
  'origin_seq',
  'event_type',
  'schema_version',
] as const;

export interface GenesisStamp {
  /** Column names to splice into the INSERT column list. */
  columns: readonly string[];
  /** '?, ?, …' placeholders matching `columns`, to splice into VALUES. */
  placeholders: string;
  /** Bound values matching `columns`, to append to the params array. */
  values: unknown[];
}

let warnedMissingProjectId = false;

/**
 * Read the store's `project_id` from `metadata`. Explicit pass-through with no
 * process-level caching (matches the no-silent-state discipline that gives
 * `event_type` no DEFAULT).
 *
 * When `project_id` is missing or empty it falls back to the next-best store
 * identifier (`dashboard_slug` → `project_name` → `'unknown-project'`) and emits
 * a one-time stderr WARN rather than throwing. Rationale: every real CMOS store
 * carries a non-empty `project_id` (set at init/register), so the fallback never
 * fires in production — the real id is always used. A hard throw, by contrast,
 * would make any read path that lazily writes a genesis row (e.g. blob-migration
 * snapshots) fail on a misconfigured store, and would break a large body of test
 * fixtures that seed firehose rows without a project identity. The WARN keeps the
 * gap audible; the non-empty fallback keeps cross-store aggregation able to group
 * the row instead of writing an empty id.
 */
export function getProjectId(client: CmosDatabaseClient): string {
  const read = (key: string): string => {
    const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
    return row.success && row.data ? (row.data.value ?? '') : '';
  };
  const projectId = read('project_id');
  if (projectId) return projectId;

  const fallback = read('dashboard_slug') || read('project_name') || 'unknown-project';
  if (!warnedMissingProjectId) {
    warnedMissingProjectId = true;
    process.stderr.write(
      `[WARN] cmos-mcp: metadata.project_id is missing/empty; stamping genesis rows with ` +
        `fallback project_id="${fallback}". Set the project identity (init/register) to fix.\n`
    );
  }
  return fallback;
}

/**
 * Produce the 6 genesis-stamp columns for a row INSERT into a firehose table
 * (s68 ADR §1 + §2, as amended s69-m03). Splice `columns` into the INSERT column
 * list, `placeholders` into VALUES, and append `values` to the params array:
 *
 * ```ts
 * const pid = getProjectId(client);
 * const g = genesisColumns(client, 'strategic_decisions', pid);
 * client.execute(
 *   `INSERT INTO strategic_decisions (decision_text, created_at, ${g.columns.join(', ')})
 *    VALUES (?, ?, ${g.placeholders})`,
 *   [text, now, ...g.values]
 * );
 * ```
 *
 * Stamps: `project_id` (passed in), `stable_event_id` (fresh ULID, app-side —
 * SQLite has no ULID function), `occurred_at` (now ms), `origin_seq` (per-table
 * MAX+1; synchronous single-writer per process), `event_type` (the table's
 * genesis verb from GENESIS_TYPE_BY_TABLE — explicit, no DEFAULT), `schema_version`
 * (1).
 *
 * Lazily runs the firehose column migration (idempotent, fast metadata-marker
 * short-circuit) so the columns exist before the INSERT — the point-of-use ensure
 * pattern the rest of the codebase uses. A handler that wraps its genesis write in
 * a transaction must call `ensureFirehoseEventColumns` at its entry (before the
 * transaction) instead, because the 12-step rebuild cannot run inside one; the
 * migration's own loud abort surfaces that case.
 *
 * @param now injectable clock (defaults to Date.now()) for deterministic tests.
 */
export function genesisColumns(
  client: CmosDatabaseClient,
  table: FirehoseTable,
  projectId: string,
  now: number = Date.now()
): GenesisStamp {
  const eventType = GENESIS_TYPE_BY_TABLE[table];
  if (!eventType) {
    throw new Error(`genesisColumns: "${table}" is not a firehose table with a genesis verb.`);
  }
  // Lazy point-of-use migration (idempotent; fast metadata-marker no-op once applied).
  ensureFirehoseEventColumns(client);
  // s69-m04 — settle the author_* namespace (session_id→author_session_id rename +
  // nullable author_user_id/user_id) at the same point of use. Marker-gated no-op
  // once applied; all transaction-safe ALTERs (no 12-step rebuild), so it is safe
  // here even when the caller is mid-transaction (e.g. sprint closeout snapshots).
  ensureAuthorNamespaceColumns(client);

  const seqRow = client.getOne<{ next: number }>(
    `SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM ${table}`,
    []
  );
  const originSeq = seqRow.success && seqRow.data ? seqRow.data.next : 1;

  return {
    columns: GENESIS_COLUMN_NAMES,
    placeholders: GENESIS_COLUMN_NAMES.map(() => '?').join(', '),
    values: [projectId, ulid(now), now, originSeq, eventType, 1],
  };
}
