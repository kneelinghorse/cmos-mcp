// ABOUTME: Sprint 69 m03 — the single shared helper every firehose-table INSERT
// routes through to stamp the 6 per-row genesis columns (s68 ADR §1/§2, as
// amended s69-m03). Centralizing the stamp turns the ~21-site call-site sweep
// into mechanical splices and gives the AST coverage test a sharp target.

import { ulid } from 'ulid';
import type { CmosDatabaseClient } from './client';
import { GENESIS_TYPE_BY_TABLE, type FirehoseTable } from '../../types/event-types';
import { ensureAuthorNamespaceColumns, ensureFirehoseEventColumns } from './schema-migrations';
import { recordProjectIdentityDisclosure } from './tool-call-context';

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

/**
 * s87-m04 — PER STORE, not per process.
 *
 * This was a single module-level boolean, so N identity-less stores opened in one process
 * produced ONE stderr line — and that line named no path, only the fallback VALUE. An operator
 * reading it could not tell which store had no identity, or how many did. The #1038 immutable
 * remeasurement found that 13 of the 45 CMOS stores on this machine resolve to the literal.
 *
 * Keyed by the store's own path so each one discloses exactly once. Still de-duplicated, because
 * the alternative is a line per genesis row.
 */
const warnedStorePaths = new Set<string>();

/** Bound and encode untrusted store metadata before it crosses into an MCP answer or stderr. */
function encodeDisclosureValue(value: string): string {
  const maxLength = 320;
  const bounded =
    value.length > maxLength
      ? `${value.slice(0, maxLength)}… [truncated; original length=${value.length}]`
      : value;
  return JSON.stringify(bounded)
    .replace(/`/g, '\\u0060')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Read the store's `project_id` from `metadata`. Explicit pass-through with no
 * process-level caching (matches the no-silent-state discipline that gives
 * `event_type` no DEFAULT).
 *
 * When `project_id` is missing or empty it falls back to the next-best store identifier
 * (`dashboard_slug` → `project_name` → `'unknown-project'`) rather than throwing. It emits stderr
 * once per store and attaches one request-de-duplicated disclosure to every affected MCP answer.
 *
 * WHY IT FALLS BACK RATHER THAN THROWING — ruling #736, REAFFIRMED by decision #1017 (D-8). A
 * hard throw breaks any read path that lazily writes a genesis row (blob-migration snapshots) on
 * a store with no identity, and `getProjectId` serves 36 call sites across 26 files, 16 of them
 * read/display. It would also do nothing for rows already stamped with the fallback.
 *
 * WHY THE OLD RATIONALE IS GONE. It asserted that every real store records an identity at
 * init/register, so the fallback could not fire outside test fixtures — and that premise was the
 * entire basis on which the fallback was approved over throwing. It is MEASURABLY FALSE. (The
 * original sentence is quoted verbatim in decision #1017, where a quotation belongs; it is
 * paraphrased here because a shipped-prose gate sweeps this tree for it.) Measured
 * 2026-08-28, using immutable SQLite inspection, with its command —
 *   find ~ -maxdepth 7 -path '*\/cmos/db/cmos.sqlite' -not -path '*\/node_modules/*'
 * → 45 stores; 32 resolve via a non-empty `project_id`; 13 collapse to the literal; 0 are
 * unclassifiable. The fallback has already fired in
 * production: `derekn.com`'s store carries 217 rows stamped `unknown-project` across six tables.
 *
 * The RULING stands and is reaffirmed; only its PREMISE is amended (#1017). Sprint 87 changed the
 * fallback LABEL, added stderr once per store, and corrected the SEED that manufactures new
 * instances. Sprint 88 m08 adds the encoded, bounded warning on every affected MCP answer and
 * splits read resolution from write registration. Neither disclosure itself identifies a store;
 * only the explicit/write registration path may persist the identity.
 */
export function getProjectId(client: CmosDatabaseClient): string {
  const read = (key: string): string => {
    const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
    return row.success && row.data ? (row.data.value ?? '') : '';
  };
  const projectId = read('project_id');
  if (projectId) return projectId;

  const fallback = read('dashboard_slug') || read('project_name') || 'unknown-project';
  const storePath = client.path;
  const disclosure =
    `[WARN] cmos-mcp: store=${encodeDisclosureValue(storePath)} has NO RECORDED project identity ` +
    `(metadata.project_id is missing/empty). This operation resolved identity as ` +
    `project_id=${encodeDisclosureValue(fallback)}, which is a fallback label and not a project identity. ` +
    `Any provenance row written before registration will use the fallback. Register or initialize ` +
    `the project before provenance writes.`;

  // Agent-visible and PER CALL. The surrounding request context de-duplicates repeated rows in
  // one answer, but a prior stderr warning must never make a later agent answer silent.
  recordProjectIdentityDisclosure(disclosure);

  if (!warnedStorePaths.has(storePath)) {
    warnedStorePaths.add(storePath);
    // Names the STORE and says the id is UNRECORDED. The old wording said only that a fallback
    // value was being stamped, which reads as though `unknown-project` were a project.
    process.stderr.write(`${disclosure}\n`);
  }
  return fallback;
}

/**
 * s84-m03 — PRAGMA column-presence guard. True when `table` has `column`. Used by the
 * foreign-row read-time framing surfaces to read a row's `project_id` ONLY when the
 * column exists, so an ancient/un-migrated store (no `project_id` column) degrades to a
 * NULL row project_id (→ rendered bare) instead of throwing on `SELECT project_id`.
 * Never throws — a failed PRAGMA returns false. Mirrors the existing local copies in
 * decision-memory.ts / cmos-context-view.ts, DRY'd for the ~6 m03 SELECT surfaces.
 */
export function tableHasColumn(client: CmosDatabaseClient, table: string, column: string): boolean {
  const res = client.getMany<{ name: string }>(`PRAGMA table_info('${table}')`, []);
  return res.success && !!res.data?.some((c) => c.name === column);
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
