/**
 * Schema migrations for CMOS database evolution.
 *
 * Handles backward-compatible schema changes via ALTER TABLE
 * with soft column detection (PRAGMA table_info).
 *
 * @module tools/cmos/schema-migrations
 */

import * as crypto from 'crypto';
import { ulid } from 'ulid';
import type { CmosDatabaseClient } from './client';
import { checkWrite, countWrite } from './write-guard';
import { isReadOnlyAgentSession } from './read-only-agent-guard';
import { SPRINT_SUMMARY_VIEW_SQL } from './schema';
import {
  FIREHOSE_TABLES,
  GENESIS_TYPE_BY_TABLE,
  type FirehoseTable,
} from '../../types/event-types';

/**
 * Valid decision categories.
 */
export const DECISION_CATEGORIES = [
  'architectural',
  'process',
  'tooling',
  'design',
  'business',
] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

/**
 * Valid decision statuses.
 */
export const DECISION_STATUSES = ['active', 'superseded', 'archived'] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

interface ColumnSpec {
  name: string;
  type: string;
  defaultValue?: string;
}

/**
 * New columns for the strategic_decisions evolution (v2.0 → v2.1).
 */
const STRATEGIC_DECISIONS_V21_COLUMNS: ColumnSpec[] = [
  { name: 'mission_id', type: 'TEXT' },
  { name: 'category', type: 'TEXT' },
  { name: 'superseded_by', type: 'INTEGER' },
  { name: 'status', type: "TEXT DEFAULT 'active'" },
  { name: 'evidence', type: 'TEXT' },
];

/**
 * Indexes for the strategic_decisions evolution (v2.1).
 */
const STRATEGIC_DECISIONS_V21_INDEXES = [
  {
    name: 'idx_strategic_decisions_mission',
    sql: 'CREATE INDEX IF NOT EXISTS idx_strategic_decisions_mission ON strategic_decisions (mission_id)',
  },
  {
    name: 'idx_strategic_decisions_status',
    sql: 'CREATE INDEX IF NOT EXISTS idx_strategic_decisions_status ON strategic_decisions (status)',
  },
  {
    name: 'idx_strategic_decisions_category',
    sql: 'CREATE INDEX IF NOT EXISTS idx_strategic_decisions_category ON strategic_decisions (category)',
  },
];

/**
 * Get the set of column names for a given table.
 */
function getTableColumns(client: CmosDatabaseClient, tableName: string): Set<string> {
  const result = client.getMany<{ name: string }>(`PRAGMA table_info('${tableName}')`, []);
  if (!result.success || !result.data) {
    return new Set();
  }
  return new Set(result.data.map((row) => row.name));
}

/**
 * Ensure a column exists on a table, adding it via ALTER TABLE if missing.
 * Returns true if the column was added, false if it already existed.
 */
function ensureColumn(
  client: CmosDatabaseClient,
  tableName: string,
  column: ColumnSpec,
  existingColumns: Set<string>,
  warnings: string[] = []
): boolean {
  if (existingColumns.has(column.name)) {
    return false;
  }

  const result = client.execute(
    `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.type}`,
    []
  );
  return checkWrite(result, warnings, `ALTER TABLE ${tableName} ADD COLUMN ${column.name}`);
}

export interface MigrationResult {
  columnsAdded: string[];
  indexesCreated: string[];
  rowsUpdated: number;
  alreadyCurrent: boolean;
  /**
   * s86-m02b (fork f23) — the failed-write channel for migrations. A migration that
   * silently half-applies is the purest form of "report intent as fact": `columnsAdded`
   * and `alreadyCurrent` describe what the code MEANT to do, and before this field a
   * failed `ALTER`/`CREATE INDEX`/`INSERT INTO metadata` was indistinguishable from
   * "nothing to do".
   *
   * WHAT IS ACTUALLY GUARDED (counted, not asserted). 28 of the 38 `client.execute`
   * calls in this module route through `checkWrite`/`countWrite` into the enclosing
   * helper's warnings array. The other 10 are already fail-loud — they `throw
   * SchemaMigrationError` rather than disclose (the ALTER/backfill steps of
   * `ensureRenamedColumn`, `ensureColumnWithCheck`, `migrateFirehoseTable` and
   * `ensureAuthorNamespaceColumns`, plus the row copy inside
   * `rebuildTableWithConstraints`). The s88-m09 pre-fix raw baseline was 18 call sites:
   * nine discarded trigger CREATEs, five vector-storage virtual-table CREATEs bound without a
   * negative arm, and four inspected results. The fix centralizes those 14 violations plus the
   * formerly inspected-but-nondiagnostic decisions_fts CREATE in two helper call sites guarded by
   * `checkWrite`; the post-fix module has five raw call sites total (those two guarded helpers and
   * three sites with explicit negative arms). In particular, failed vec0/FTS5 creates populate
   * `warnings`, keep `alreadyCurrent` false, and cannot advance the schema version; trigger names
   * enter `indexesCreated` only after their own CREATE succeeds.
   *
   * CARRIER DESIGN. Producers retain their local `warnings` arrays; consumers splice
   * `result.warnings` into an existing answer carrier. No producer takes a sink parameter, and
   * there is no module-scope collector whose mutable state could cross concurrent client opens.
   *
   * ── EXECUTABLE REACH MAP (s88-m09) ───────────────────────────────────────────────────────
   *
   * The authoritative census is the semantic TypeScript gate at
   * `tests/tools/cmos/migration-warning-reachability.test.ts`. Reproduce it exactly with:
   *
   *   npx jest tests/tools/cmos/migration-warning-reachability.test.ts --runInBand --coverage=false
   *
   * SCOPE: 21 exported functions declared in THIS module whose return type is assignable to
   * `MigrationResult`, and their 48 shipped call sites under `src/`. This deliberately excludes
   * tests/scripts and MigrationResult producers declared elsewhere (for example,
   * project-identity.ts). Semantic assignability matters: {@link ensureSprintSummaryView} returns
   * the narrower `SprintSummaryViewResult`, so the old name/return-text grep missed that producer
   * and its three already-spliced callers.
   *
   * The fresh pre-fix RED was A=11 / B=30 / C=7. After s88-m09 it is A=41 / B=0 / C=7:
   *
   *  A. CONSUMED — 41 sites reach a rendered warning/error carrier: 36 run inside a result
   *     initializer whose only post-initializer return is
   *     `attachWarnings(result, thatExactWarningSink)`, and 5 travel through four shared helpers.
   *     The gate resolves aliases/bindings, correlates the producer read with that exact sink,
   *     and symbol-traces each helper's result or mutable-sink forwarding through every shipped
   *     caller. A mere owner-level `.warnings` read therefore cannot make an early error path
   *     false-green.
   *
   *  B. REACHABLE BUT DROPPED — zero. All 30 pre-fix sites whose enclosing answer already had a
   *     disclosure carrier now consume the migration result.
   *
   *  C. STRUCTURAL RESIDUALS — 7 sites have no answer warning carrier to attach to:
   *     genesis-columns.ts ×2 (`GenesisStamp` feeds SQL writes), fts5-retriever.ts ×2
   *     (`search()` returns `RankedResult[]`), and staleness-detection.ts ×3
   *     (`StalenessResult` / a bare count pair). The gate names each residual by
   *     file + enclosing function + producer and fails if this set changes silently.
   *
   * HISTORICAL CORRECTION, KEPT COMPACT. The inherited 45/A7/B29/C7 prose was stale: the three
   * `ensureSprintSummaryView` subtype calls account for 45→48 and A7→A10;
   * cmos-mission-move.ts and cmos-learnings-reaffirm.ts were omitted from B, while
   * cmos-session-capture.ts's `ensureLearningsTable` had already moved from B to A, yielding the
   * measured pre-fix A11/B30/C7. The older claim that `ensureMissionIdColumn` returned `void` is
   * also false now: it returns `ensureStrategicDecisionsSchema(...).warnings ?? []`, and all three
   * callers splice that string array. The still-valid earlier corrections remain:
   * {@link migrateStrategicDecisionsV21} is reachable through `ensureStrategicDecisionsSchema`,
   * and the sprint-current-invariant sites have cmos_sprint answer carriers; neither belongs in C.
   */
  warnings?: string[];
}

/**
 * Run the strategic_decisions v2.1 migration.
 *
 * Adds category, superseded_by, status, evidence columns.
 * Sets status='active' on existing rows where status is NULL.
 * Creates indexes on status, category, and mission_id.
 *
 * Safe to call multiple times (idempotent).
 *
 * s86-m02b, corrected through s88-m09: this helper is NOT test-only, and its `warnings` are
 * reachable. Its module-local caller {@link ensureStrategicDecisionsSchema} delegates the result
 * verbatim. `ensureMissionIdColumn` reads that result's warnings and returns a `string[]`; all
 * three callers (mission complete, session capture, and session complete) splice the array into
 * their rendered warning carriers. This path is therefore consumed group A in the executable
 * {@link MigrationResult.warnings} reachability census.
 */
export function migrateStrategicDecisionsV21(client: CmosDatabaseClient): MigrationResult {
  const existingColumns = getTableColumns(client, 'strategic_decisions');

  if (existingColumns.size === 0) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: false };
  }

  const columnsAdded: string[] = [];
  const warnings: string[] = [];

  for (const column of STRATEGIC_DECISIONS_V21_COLUMNS) {
    if (ensureColumn(client, 'strategic_decisions', column, existingColumns, warnings)) {
      columnsAdded.push(column.name);
    }
  }

  // Set status='active' on any existing rows where status is NULL
  let rowsUpdated = 0;
  if (columnsAdded.includes('status')) {
    const updateResult = client.execute(
      "UPDATE strategic_decisions SET status = 'active' WHERE status IS NULL",
      []
    );
    rowsUpdated = countWrite(updateResult, warnings, 'strategic_decisions.status backfill');
  }

  // Create indexes
  const indexesCreated: string[] = [];
  for (const index of STRATEGIC_DECISIONS_V21_INDEXES) {
    const result = client.execute(index.sql, []);
    if (checkWrite(result, warnings, `CREATE INDEX ${index.name}`)) {
      indexesCreated.push(index.name);
    }
  }

  // Update schema version in metadata
  const versionResult = client.execute(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '2.1')",
    []
  );
  checkWrite(versionResult, warnings, "metadata.schema_version = '2.1'");

  return {
    columnsAdded,
    indexesCreated,
    rowsUpdated,
    alreadyCurrent: columnsAdded.length === 0,
    warnings,
  };
}

/**
 * Run all pending migrations for the strategic_decisions table.
 * Currently only v2.1 migration exists.
 */
export function ensureStrategicDecisionsSchema(client: CmosDatabaseClient): MigrationResult {
  return migrateStrategicDecisionsV21(client);
}

/**
 * New columns for the missions table (v2.1).
 */
const MISSIONS_TIMESTAMP_COLUMNS: ColumnSpec[] = [
  { name: 'created_at', type: 'TEXT' },
  { name: 'started_at', type: 'TEXT' },
  { name: 'updated_at', type: 'TEXT' },
];

/**
 * Ensure missions table has timestamp columns.
 * Adds created_at, started_at, updated_at if missing.
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureMissionTimestamps(client: CmosDatabaseClient): MigrationResult {
  const existingColumns = getTableColumns(client, 'missions');

  if (existingColumns.size === 0) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: false };
  }

  const columnsAdded: string[] = [];
  const warnings: string[] = [];

  for (const column of MISSIONS_TIMESTAMP_COLUMNS) {
    if (ensureColumn(client, 'missions', column, existingColumns, warnings)) {
      columnsAdded.push(column.name);
    }
  }

  return {
    columnsAdded,
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: columnsAdded.length === 0,
    warnings,
  };
}

/**
 * Valid learning categories.
 */
export const LEARNING_CATEGORIES = ['technical', 'process', 'agent-behavior', 'tooling'] as const;

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

/**
 * Ensure the learnings table exists.
 * Creates the table and indexes if they don't exist, and runs the lazy
 * column-level migrations (`evergreen` — Sprint 61 m03) on pre-existing tables.
 *
 * Sprint 61 m03 — `evergreen INTEGER DEFAULT 0` is now part of the canonical
 * schema. It is set to 1 by an operator (or by `cmos_learnings(action="update",
 * evergreen=true)`) on institutional-rule learnings that should never trip the
 * staleness signal. The staleness query gates on `evergreen = 0` so flagged
 * institutional rules drop out of the pile entirely.
 *
 * MUST be called on read paths in addition to write paths — un-migrated DBs
 * would otherwise hit `no such column: evergreen` the first time the staleness
 * query runs against learnings.
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureLearningsTable(client: CmosDatabaseClient): MigrationResult {
  const warnings: string[] = [];
  const createResult = client.execute(
    // s69-m04: create with the post-rename canonical name author_session_id (NOT
    // session_id). Critical: ensureAuthorNamespaceColumns is marker-gated and the
    // marker can be set while `learnings` is still absent (a store that recorded
    // sessions/missions/decisions but no learnings) — so if this helper created the
    // table with session_id, the later marker-short-circuited rename would never
    // fire and the author_session_id-hardcoded write path would crash on first
    // learning capture. Creating it canonical makes the rename a !hasOld&&hasNew
    // no-op and keeps the column name single-sourced with schema.ts.
    `CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sprint_id TEXT,
      author_session_id TEXT,
      mission_id TEXT,
      created_at TEXT NOT NULL,
      evergreen INTEGER NOT NULL DEFAULT 0
    )`,
    []
  );

  const tableCreated = checkWrite(createResult, warnings, 'CREATE TABLE learnings');
  const columnsAdded: string[] = tableCreated ? ['learnings (table)'] : [];

  // Lazy column migration for pre-existing tables (added pre-Sprint 61 m03).
  const existingColumns = getTableColumns(client, 'learnings');
  if (existingColumns.size > 0 && !existingColumns.has('evergreen')) {
    const alterResult = client.execute(
      `ALTER TABLE learnings ADD COLUMN evergreen INTEGER NOT NULL DEFAULT 0`,
      []
    );
    if (checkWrite(alterResult, warnings, 'ALTER TABLE learnings ADD COLUMN evergreen')) {
      columnsAdded.push('learnings.evergreen');
    }
  }

  const indexResults: string[] = [];
  const indexes = [
    {
      name: 'idx_learnings_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings (status)',
    },
    {
      name: 'idx_learnings_sprint',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_sprint ON learnings (sprint_id)',
    },
    {
      name: 'idx_learnings_category',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings (category)',
    },
    {
      name: 'idx_learnings_evergreen',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_evergreen ON learnings (evergreen)',
    },
    {
      // s85-m04 (#487): verified MISSING on the live store; backs cmos_learnings(list, missionId).
      name: 'idx_learnings_mission',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_mission ON learnings (mission_id)',
    },
    {
      // s69-m04 — parity with schema.ts greenfield (author_session_id drill-down).
      name: 'idx_learnings_author_session',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_author_session ON learnings (author_session_id)',
    },
  ];

  for (const index of indexes) {
    const result = client.execute(index.sql, []);
    if (checkWrite(result, warnings, `CREATE INDEX ${index.name}`)) {
      indexResults.push(index.name);
    }
  }

  return {
    columnsAdded,
    indexesCreated: indexResults,
    rowsUpdated: 0,
    alreadyCurrent: false,
    warnings,
  };
}

/**
 * Content hash columns for dedup (v2.2).
 * Adds content_hash to strategic_decisions and learnings tables.
 */
const CONTENT_HASH_COLUMNS: {
  table: string;
  column: ColumnSpec;
  index: { name: string; sql: string };
}[] = [
  {
    table: 'strategic_decisions',
    column: { name: 'content_hash', type: 'TEXT' },
    index: {
      name: 'idx_strategic_decisions_hash',
      sql: 'CREATE INDEX IF NOT EXISTS idx_strategic_decisions_hash ON strategic_decisions (content_hash)',
    },
  },
  {
    table: 'learnings',
    column: { name: 'content_hash', type: 'TEXT' },
    index: {
      name: 'idx_learnings_hash',
      sql: 'CREATE INDEX IF NOT EXISTS idx_learnings_hash ON learnings (content_hash)',
    },
  },
];

/**
 * Run the content_hash migration (v2.2).
 *
 * Adds content_hash column to strategic_decisions and learnings tables.
 * Computes SHA-256 hashes for existing records.
 *
 * Safe to call multiple times (idempotent).
 */
export function migrateContentHash(client: CmosDatabaseClient): MigrationResult {
  const columnsAdded: string[] = [];
  const indexesCreated: string[] = [];
  const warnings: string[] = [];
  let rowsUpdated = 0;

  for (const spec of CONTENT_HASH_COLUMNS) {
    const existingColumns = getTableColumns(client, spec.table);
    if (existingColumns.size === 0) continue;

    if (ensureColumn(client, spec.table, spec.column, existingColumns, warnings)) {
      columnsAdded.push(`${spec.table}.${spec.column.name}`);
    }

    const indexResult = client.execute(spec.index.sql, []);
    if (checkWrite(indexResult, warnings, `CREATE INDEX ${spec.index.name}`)) {
      indexesCreated.push(spec.index.name);
    }
  }

  // Backfill hashes for existing decisions without content_hash
  const unhashed = client.getMany<{
    id: number;
    decision_text: string;
    project_domain: string | null;
  }>(
    `SELECT id, decision_text, project_domain FROM strategic_decisions WHERE content_hash IS NULL`,
    []
  );
  if (unhashed.success && unhashed.data) {
    for (const row of unhashed.data) {
      const hash = computeContentHash(row.decision_text, row.project_domain ?? 'general');
      const hashed = client.execute(
        `UPDATE strategic_decisions SET content_hash = ? WHERE id = ?`,
        [hash, row.id]
      );
      rowsUpdated += countWrite(
        hashed,
        warnings,
        `strategic_decisions.content_hash backfill (id ${row.id})`
      );
    }
  }

  // Backfill hashes for existing learnings without content_hash
  const unhashedLearnings = client.getMany<{
    id: number;
    content: string;
    category: string | null;
  }>(`SELECT id, content, category FROM learnings WHERE content_hash IS NULL`, []);
  if (unhashedLearnings.success && unhashedLearnings.data) {
    for (const row of unhashedLearnings.data) {
      const hash = computeContentHash(row.content, row.category ?? '');
      const hashedLearning = client.execute(`UPDATE learnings SET content_hash = ? WHERE id = ?`, [
        hash,
        row.id,
      ]);
      rowsUpdated += countWrite(
        hashedLearning,
        warnings,
        `learnings.content_hash backfill (id ${row.id})`
      );
    }
  }

  if (columnsAdded.length > 0) {
    const versionResult = client.execute(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '2.2')",
      []
    );
    checkWrite(versionResult, warnings, "metadata.schema_version = '2.2'");
  }

  return {
    columnsAdded,
    indexesCreated,
    rowsUpdated,
    alreadyCurrent: columnsAdded.length === 0 && rowsUpdated === 0,
    warnings,
  };
}

/**
 * Archival-reachability columns (Sprint 52 m04; rename-aware s69-m04).
 *
 * The sprint-close archival query reads the decision/learning session-of-origin
 * column. DBs seeded by `ensureLearningsTable` or pre-v2.1 `strategic_decisions`
 * layouts lack it, which makes the ALTER-less UPDATE fail with `no such column`
 * — silently reducing archival to zero rows. This migration backfills it on any
 * DB that lacks it.
 *
 * s69-m04 renamed that column `session_id` → `author_session_id`. This helper is
 * now rename-aware: it adds `author_session_id` ONLY when the table carries
 * NEITHER name. If the legacy `session_id` is still present (a store that has not
 * yet run {@link ensureAuthorNamespaceColumns}), it is left untouched — adding
 * `author_session_id` alongside it would create the both-present state that the
 * rename's 4-case guard rejects. The rename migration then renames `session_id`
 * in place; here we never resurrect it.
 */
const ARCHIVAL_SESSION_TABLES = ['strategic_decisions', 'learnings'] as const;

/**
 * Ensure the session-of-origin column (`author_session_id`, formerly `session_id`)
 * exists on learnings and strategic_decisions so sprint-close archival can
 * cross-reference sessions. Idempotent and rename-safe (see above).
 */
export function ensureArchivalColumns(client: CmosDatabaseClient): MigrationResult {
  const columnsAdded: string[] = [];
  const warnings: string[] = [];
  for (const table of ARCHIVAL_SESSION_TABLES) {
    const existing = getTableColumns(client, table);
    if (existing.size === 0) continue;
    // Either name present → the archival query has a column to read. Only a table
    // with NEITHER (fresh/foreign) gets the post-rename name added.
    if (existing.has('author_session_id') || existing.has('session_id')) continue;
    if (
      ensureColumn(client, table, { name: 'author_session_id', type: 'TEXT' }, existing, warnings)
    ) {
      columnsAdded.push(`${table}.author_session_id`);
    }
  }
  return {
    columnsAdded,
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: columnsAdded.length === 0,
    warnings,
  };
}

/**
 * Review-timestamp columns (Sprint 52 m03).
 *
 * Adds last_reviewed_at to learnings and strategic_decisions so staleness detection can
 * respect operator triage. Before this, staleness re-fired on sprint_id every time the
 * cutoff moved, re-flagging learnings that had just been archived/reaffirmed.
 */
const REVIEW_TIMESTAMP_TABLES: { table: string; column: ColumnSpec }[] = [
  { table: 'learnings', column: { name: 'last_reviewed_at', type: 'TEXT' } },
  { table: 'strategic_decisions', column: { name: 'last_reviewed_at', type: 'TEXT' } },
];

/**
 * Ensure last_reviewed_at columns exist on learnings and strategic_decisions.
 * Idempotent — safe to call on DBs where the column already exists.
 */
export function ensureReviewTimestamps(client: CmosDatabaseClient): MigrationResult {
  const columnsAdded: string[] = [];
  const warnings: string[] = [];

  for (const spec of REVIEW_TIMESTAMP_TABLES) {
    const existing = getTableColumns(client, spec.table);
    if (existing.size === 0) continue; // table doesn't exist on this DB
    if (ensureColumn(client, spec.table, spec.column, existing, warnings)) {
      columnsAdded.push(`${spec.table}.${spec.column.name}`);
    }
  }

  return {
    columnsAdded,
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: columnsAdded.length === 0,
    warnings,
  };
}

/**
 * Compute a SHA-256 content hash for dedup.
 * Uses canonical JSON of (text, domain) for consistent hashing.
 */
export function computeContentHash(text: string, domain: string): string {
  const canonical = JSON.stringify({ d: domain, t: text });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Ensure the FTS5 virtual table for decisions exists and is synced.
 *
 * Creates:
 * - decisions_fts FTS5 virtual table (content-external, synced with strategic_decisions)
 * - Triggers for auto-sync on INSERT, UPDATE, DELETE
 *
 * Safe to call multiple times (idempotent).
 */
/**
 * Ensure the session_missions junction table exists.
 * Creates the table and index if they don't exist.
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureSessionMissionsTable(client: CmosDatabaseClient): MigrationResult {
  const warnings: string[] = [];
  const createResult = client.execute(
    `CREATE TABLE IF NOT EXISTS session_missions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'capture',
      PRIMARY KEY (session_id, mission_id)
    )`,
    []
  );

  const tableCreated = checkWrite(createResult, warnings, 'CREATE TABLE session_missions');

  const indexResults: string[] = [];
  const indexResult = client.execute(
    'CREATE INDEX IF NOT EXISTS idx_session_missions_mission ON session_missions (mission_id)',
    []
  );
  if (checkWrite(indexResult, warnings, 'CREATE INDEX idx_session_missions_mission')) {
    indexResults.push('idx_session_missions_mission');
  }

  return {
    columnsAdded: tableCreated ? ['session_missions (table)'] : [],
    indexesCreated: indexResults,
    rowsUpdated: 0,
    alreadyCurrent: false,
    warnings,
  };
}

/**
 * Valid next-step statuses.
 */
export const NEXT_STEP_STATUSES = ['pending', 'completed', 'carried', 'dropped'] as const;

export type NextStepStatus = (typeof NEXT_STEP_STATUSES)[number];

/**
 * Ensure the next_steps table exists.
 * Creates the table and indexes if they don't exist.
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureNextStepsTable(client: CmosDatabaseClient): MigrationResult {
  const warnings: string[] = [];
  const createResult = client.execute(
    `CREATE TABLE IF NOT EXISTS next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      carried_to_sprint TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      content_hash TEXT
    )`,
    []
  );

  const tableCreated = checkWrite(createResult, warnings, 'CREATE TABLE next_steps');

  const indexResults: string[] = [];
  const indexes = [
    {
      name: 'idx_next_steps_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_next_steps_status ON next_steps (status)',
    },
    {
      name: 'idx_next_steps_sprint',
      sql: 'CREATE INDEX IF NOT EXISTS idx_next_steps_sprint ON next_steps (sprint_id)',
    },
    {
      name: 'idx_next_steps_hash',
      sql: 'CREATE INDEX IF NOT EXISTS idx_next_steps_hash ON next_steps (content_hash)',
    },
    {
      // s85-m04 (#487): verified MISSING on the live store — the only mission_id indexes were
      // idx_strategic_decisions_mission and idx_session_missions_mission — so the new
      // cmos_context(next_steps, missionId) filter would have table-scanned.
      name: 'idx_next_steps_mission',
      sql: 'CREATE INDEX IF NOT EXISTS idx_next_steps_mission ON next_steps (mission_id)',
    },
  ];

  for (const index of indexes) {
    const result = client.execute(index.sql, []);
    if (checkWrite(result, warnings, `CREATE INDEX ${index.name}`)) {
      indexResults.push(index.name);
    }
  }

  return {
    columnsAdded: tableCreated ? ['next_steps (table)'] : [],
    indexesCreated: indexResults,
    rowsUpdated: 0,
    alreadyCurrent: false,
    warnings,
  };
}

/**
 * Valid constraint statuses.
 */
export const CONSTRAINT_STATUSES = ['active', 'archived', 'expired'] as const;

export type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];

/**
 * Ensure the constraints table exists.
 * Creates the table and indexes if they don't exist.
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureConstraintsTable(client: CmosDatabaseClient): MigrationResult {
  const warnings: string[] = [];
  const createResult = client.execute(
    `CREATE TABLE IF NOT EXISTS constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      archived_at TEXT,
      content_hash TEXT
    )`,
    []
  );

  const tableCreated = checkWrite(createResult, warnings, 'CREATE TABLE constraints');

  const indexResults: string[] = [];
  const indexes = [
    {
      name: 'idx_constraints_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_constraints_status ON constraints (status)',
    },
    {
      name: 'idx_constraints_expires',
      sql: 'CREATE INDEX IF NOT EXISTS idx_constraints_expires ON constraints (expires_at)',
    },
    {
      name: 'idx_constraints_hash',
      sql: 'CREATE INDEX IF NOT EXISTS idx_constraints_hash ON constraints (content_hash)',
    },
  ];

  for (const index of indexes) {
    const result = client.execute(index.sql, []);
    if (checkWrite(result, warnings, `CREATE INDEX ${index.name}`)) {
      indexResults.push(index.name);
    }
  }

  return {
    columnsAdded: tableCreated ? ['constraints (table)'] : [],
    indexesCreated: indexResults,
    rowsUpdated: 0,
    alreadyCurrent: false,
    warnings,
  };
}

/**
 * Ensure last_reviewed_at exists on the constraints table (Sprint 82 m01).
 *
 * Mirrors {@link ensureReviewTimestamps} (which owns learnings/strategic_decisions)
 * for the constraints table, so a constraint can be reaffirmed — its staleness clock
 * reset — the same way learnings are (`cmos_learnings(action="reaffirm")`). Staleness
 * scoring anchors on `COALESCE(last_reviewed_at, created_at)`, so **no backfill is
 * needed**: a NULL last_reviewed_at falls back to created_at (pre-migration behavior).
 * Idempotent — safe to call on a DB where the column already exists or the table is absent.
 */
export function ensureConstraintReviewTimestamp(client: CmosDatabaseClient): MigrationResult {
  const existing = getTableColumns(client, 'constraints');
  if (existing.size === 0) {
    // Table doesn't exist on this DB yet — nothing to alter.
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }
  const warnings: string[] = [];
  const added = ensureColumn(
    client,
    'constraints',
    { name: 'last_reviewed_at', type: 'TEXT' },
    existing,
    warnings
  );
  return {
    columnsAdded: added ? ['constraints.last_reviewed_at'] : [],
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: !added,
    warnings,
  };
}

/**
 * s84-m04 (#478) — add `context_snapshots.content_pruned_at` (the content-tombstone marker).
 * Mirrors {@link ensureConstraintReviewTimestamp}: a plain `ALTER ADD COLUMN` (NOT the 12-step
 * firehose rebuild), idempotent, no backfill (NULL = not-pruned = the pre-migration meaning).
 * The prune script runs this before tombstoning; the seed schema carries the column for fresh
 * stores. Safe on a DB where the column already exists or the table is absent.
 */
export function ensureContentPrunedColumn(client: CmosDatabaseClient): MigrationResult {
  const existing = getTableColumns(client, 'context_snapshots');
  if (existing.size === 0) {
    // Table doesn't exist on this DB yet — nothing to alter.
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }
  const warnings: string[] = [];
  const added = ensureColumn(
    client,
    'context_snapshots',
    { name: 'content_pruned_at', type: 'TEXT' },
    existing,
    warnings
  );
  return {
    columnsAdded: added ? ['context_snapshots.content_pruned_at'] : [],
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: !added,
    warnings,
  };
}

/**
 * s84-m05 — add `constraints.evergreen` (a durable "never trip staleness" flag), mirroring
 * `learnings.evergreen` (s61-m03) and {@link ensureConstraintReviewTimestamp}. Plain
 * `ALTER ADD COLUMN evergreen INTEGER NOT NULL DEFAULT 0`, idempotent, no backfill (0 = the
 * pre-migration meaning). An evergreen constraint (an institutional rule like the ≤4KB review
 * digest) is excluded from staleness review/count so it never ages past the surfacing floor —
 * expiry alone could not achieve this (a set expiry still accrues the age score). Safe on a DB
 * where the column already exists or the table is absent.
 */
export function ensureConstraintEvergreen(client: CmosDatabaseClient): MigrationResult {
  const existing = getTableColumns(client, 'constraints');
  if (existing.size === 0) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }
  const warnings: string[] = [];
  const added = ensureColumn(
    client,
    'constraints',
    { name: 'evergreen', type: 'INTEGER NOT NULL DEFAULT 0' },
    existing,
    warnings
  );
  return {
    columnsAdded: added ? ['constraints.evergreen'] : [],
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: !added,
    warnings,
  };
}

/**
 * s84-m04 (critic Rev4 — the dedup black-hole fix) — the WHERE-clause fragment every
 * `context_snapshots` content_hash dedup SELECT appends so a content-TOMBSTONED row (its content
 * emptied by the prune) is never a dedup hit. Without it, a future identical-content write would
 * "dedup" onto the emptied row and silently lose the content. Column-presence guarded: a
 * tombstoned row can only exist once `content_pruned_at` exists, so on a store predating the
 * column the fragment is empty (no filter, no `no such column` throw) — exact and never-throw.
 */
export function snapshotDedupPrunedFilter(client: CmosDatabaseClient): string {
  return getTableColumns(client, 'context_snapshots').has('content_pruned_at')
    ? ' AND content_pruned_at IS NULL'
    : '';
}

type VirtualTableModule = 'fts5' | 'vec0';

interface EnsuredSchemaObject {
  readonly ready: boolean;
  readonly created: boolean;
}

interface TriggerSpec {
  readonly name: string;
  readonly sql: string;
}

interface ExternalFtsResult {
  readonly ready: boolean;
  readonly tableCreated: boolean;
  readonly triggersCreated: string[];
  readonly rowsUpdated: number;
  readonly rebuilt: boolean;
}

/**
 * Tokenize stored CREATE SQL for definition comparisons without making formatting part of the
 * schema contract. SQLite preserves much of the caller's original spelling in sqlite_master, so
 * whitespace, comments, a benign IF NOT EXISTS, keyword case, and trailing semicolons must not
 * turn an equivalent object into a collision. Quoted string contents remain byte-sensitive: FTS5
 * commands such as 'delete' are data, not case-insensitive SQL syntax.
 */
function normalizeSchemaSql(sql: string): string {
  const tokens: string[] = [];

  for (let index = 0; index < sql.length; ) {
    const char = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let token = quote;
      index += 1;
      while (index < sql.length) {
        token += sql[index];
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            token += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push(token);
      continue;
    }
    if (char === '[') {
      const end = sql.indexOf(']', index + 1);
      const tokenEnd = end === -1 ? sql.length : end + 1;
      tokens.push(sql.slice(index, tokenEnd).toLowerCase());
      index = tokenEnd;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      tokens.push(sql.slice(index, end).toLowerCase());
      index = end;
      continue;
    }

    const twoCharacterOperator = sql.slice(index, index + 2);
    if (['<=', '>=', '<>', '!=', '==', '||', '->'].includes(twoCharacterOperator)) {
      tokens.push(twoCharacterOperator);
      index += 2;
      continue;
    }
    tokens.push(char);
    index += 1;
  }

  const withoutIfNotExists: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === 'if' && tokens[index + 1] === 'not' && tokens[index + 2] === 'exists') {
      index += 2;
      continue;
    }
    withoutIfNotExists.push(tokens[index]);
  }
  while (withoutIfNotExists[withoutIfNotExists.length - 1] === ';') withoutIfNotExists.pop();
  return withoutIfNotExists.join('\u001f');
}

/**
 * Ensure `name` is the expected virtual-table module, not merely any same-named SQLite object.
 * A collision is advisory and non-destructive: leave the foreign object untouched and name it in
 * the migration warnings instead of treating a plain table/view/index as a working vec0/FTS5 table.
 */
function ensureVirtualTableObject(
  client: CmosDatabaseClient,
  name: string,
  moduleName: VirtualTableModule,
  createSql: string,
  warnings: string[]
): EnsuredSchemaObject {
  const existing = client.getOne<{ type: string; sql: string | null }>(
    'SELECT type, sql FROM sqlite_master WHERE name = ?',
    [name]
  );
  if (!existing.success) {
    warnings.push(
      `CREATE VIRTUAL TABLE ${name} preflight failed: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
    );
    return { ready: false, created: false };
  }

  if (existing.data) {
    const sql = existing.data.sql ?? '';
    const isExpectedVirtualTable =
      existing.data.type === 'table' &&
      /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql) &&
      new RegExp(`\\bUSING\\s+${moduleName}\\b`, 'i').test(sql);
    if (isExpectedVirtualTable && normalizeSchemaSql(sql) === normalizeSchemaSql(createSql)) {
      return { ready: true, created: false };
    }
    if (isExpectedVirtualTable) {
      warnings.push(
        `CREATE VIRTUAL TABLE ${name} blocked: DB_SCHEMA_MISMATCH — Existing ${moduleName} virtual table '${name}' has a different definition; drop or rename it, then retry.`
      );
      return { ready: false, created: false };
    }
    warnings.push(
      `CREATE VIRTUAL TABLE ${name} blocked: DB_SCHEMA_MISMATCH — Existing ${existing.data.type} '${name}' is not a ${moduleName} virtual table.`
    );
    return { ready: false, created: false };
  }

  const created = checkWrite(client.raw(createSql), warnings, `CREATE VIRTUAL TABLE ${name}`);
  return { ready: created, created };
}

/** Ensure a trigger exists, while reporting a name collision and only claiming a real CREATE. */
function ensureSchemaTrigger(
  client: CmosDatabaseClient,
  spec: TriggerSpec,
  warnings: string[]
): EnsuredSchemaObject {
  const existing = client.getOne<{ type: string; sql: string | null }>(
    'SELECT type, sql FROM sqlite_master WHERE name = ?',
    [spec.name]
  );
  if (!existing.success) {
    warnings.push(
      `CREATE TRIGGER ${spec.name} preflight failed: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
    );
    return { ready: false, created: false };
  }
  if (existing.data) {
    if (
      existing.data.type === 'trigger' &&
      normalizeSchemaSql(existing.data.sql ?? '') === normalizeSchemaSql(spec.sql)
    ) {
      return { ready: true, created: false };
    }
    if (existing.data.type === 'trigger') {
      warnings.push(
        `CREATE TRIGGER ${spec.name} blocked: DB_SCHEMA_MISMATCH — Existing trigger '${spec.name}' has a different definition; drop or rename it, then retry.`
      );
      return { ready: false, created: false };
    }
    warnings.push(
      `CREATE TRIGGER ${spec.name} blocked: DB_SCHEMA_MISMATCH — Existing ${existing.data.type} '${spec.name}' is not a trigger.`
    );
    return { ready: false, created: false };
  }

  const created = checkWrite(client.raw(spec.sql), warnings, `CREATE TRIGGER ${spec.name}`);
  return { ready: created, created };
}

function readMigrationCount(
  client: CmosDatabaseClient,
  sql: string,
  warnings: string[],
  what: string
): number | null {
  const result = client.getOne<{ count: number }>(sql, []);
  if (!result.success) {
    warnings.push(
      `${what} failed: ${result.error?.code ?? 'DB_ERROR'} — ${result.error?.message ?? 'unknown'}`
    );
    return null;
  }
  return result.data?.count ?? 0;
}

/**
 * Ensure one external-content FTS5 table, its three source triggers, and its initial/retry rebuild.
 * `forceRebuild` is the durable retry signal used by vector storage while schema_version is stale.
 * Without it, a docsize/source count mismatch detects a prior decisions_fts rebuild failure.
 */
function ensureExternalFts(
  client: CmosDatabaseClient,
  params: {
    readonly name: string;
    readonly sourceTable: string;
    readonly createSql: string;
    readonly triggers: readonly TriggerSpec[];
    readonly forceRebuild: boolean;
    readonly verifyIndexedRowCount: boolean;
  },
  warnings: string[]
): ExternalFtsResult {
  const table = ensureVirtualTableObject(client, params.name, 'fts5', params.createSql, warnings);
  if (!table.ready) {
    return {
      ready: false,
      tableCreated: false,
      triggersCreated: [],
      rowsUpdated: 0,
      rebuilt: false,
    };
  }

  const triggerResults = params.triggers.map((spec) => ({
    name: spec.name,
    ...ensureSchemaTrigger(client, spec, warnings),
  }));
  const triggersCreated = triggerResults.filter((result) => result.created).map((r) => r.name);
  const triggersReady = triggerResults.every((result) => result.ready);

  let readinessCheckSucceeded = true;
  let needsRebuild =
    params.forceRebuild || table.created || triggersCreated.length > 0 || !triggersReady;
  if (!needsRebuild && params.verifyIndexedRowCount) {
    const sourceCount = readMigrationCount(
      client,
      `SELECT COUNT(*) AS count FROM ${params.sourceTable}`,
      warnings,
      `${params.name} source row count`
    );
    const indexedCount = readMigrationCount(
      client,
      `SELECT COUNT(*) AS count FROM ${params.name}_docsize`,
      warnings,
      `${params.name} indexed row count`
    );
    readinessCheckSucceeded = sourceCount !== null && indexedCount !== null;
    needsRebuild = readinessCheckSucceeded && sourceCount !== indexedCount;
  }

  let rowsUpdated = 0;
  let rebuilt = false;
  let rebuildReady = true;
  if (needsRebuild) {
    rebuildReady = checkWrite(
      client.execute(`INSERT INTO ${params.name}(${params.name}) VALUES('rebuild')`, []),
      warnings,
      `${params.name} rebuild`
    );
    rebuilt = rebuildReady;
    if (rebuildReady) {
      const count = readMigrationCount(
        client,
        `SELECT COUNT(*) AS count FROM ${params.sourceTable}`,
        warnings,
        `${params.name} rebuilt row count`
      );
      if (count === null) {
        rebuildReady = false;
      } else {
        rowsUpdated = count;
      }
    }
  }

  return {
    ready: table.ready && triggersReady && readinessCheckSucceeded && rebuildReady,
    tableCreated: table.created,
    triggersCreated,
    rowsUpdated,
    rebuilt,
  };
}

export function ensureDecisionsFts5(client: CmosDatabaseClient): MigrationResult {
  const warnings: string[] = [];
  const fts = ensureExternalFts(
    client,
    {
      name: 'decisions_fts',
      sourceTable: 'strategic_decisions',
      createSql: `CREATE VIRTUAL TABLE decisions_fts USING fts5(
        decision_text,
        content='strategic_decisions',
        content_rowid='id'
      )`,
      triggers: [
        {
          name: 'decisions_fts_insert',
          sql: `CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
            INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
          END`,
        },
        {
          name: 'decisions_fts_delete',
          sql: `CREATE TRIGGER decisions_fts_delete AFTER DELETE ON strategic_decisions BEGIN
            INSERT INTO decisions_fts(decisions_fts, rowid, decision_text)
            VALUES('delete', old.id, old.decision_text);
          END`,
        },
        {
          name: 'decisions_fts_update',
          sql: `CREATE TRIGGER decisions_fts_update
            AFTER UPDATE OF decision_text ON strategic_decisions BEGIN
            INSERT INTO decisions_fts(decisions_fts, rowid, decision_text)
            VALUES('delete', old.id, old.decision_text);
            INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
          END`,
        },
      ],
      forceRebuild: false,
      verifyIndexedRowCount: true,
    },
    warnings
  );

  const didWork = fts.tableCreated || fts.triggersCreated.length > 0 || fts.rebuilt;
  return {
    columnsAdded: fts.tableCreated ? ['decisions_fts (virtual table)'] : [],
    indexesCreated: fts.triggersCreated,
    rowsUpdated: fts.rowsUpdated,
    alreadyCurrent: fts.ready && !didWork && warnings.length === 0,
    warnings,
  };
}

/**
 * Valid statuses for agent_feedback rows.
 *
 * Sprint 56 m03 — the agentFeedback standing-channel lets agents report UX
 * issues or improvement ideas from high-friction surfaces without being
 * prompted. Human operator triages periodically.
 */
export const AGENT_FEEDBACK_STATUSES = ['open', 'triaged', 'resolved', 'archived'] as const;
export type AgentFeedbackStatus = (typeof AGENT_FEEDBACK_STATUSES)[number];

/**
 * Ensure the agent_feedback table exists (Sprint 56 m03).
 *
 * Holds free-text UX reports emitted by agents through the `agentFeedback`
 * parameter on cmos_session(complete), cmos_mission_transition(complete),
 * and cmos_agent_onboard. Kept as a dedicated table rather than reusing
 * session captures so the triage surface (cmos_feedback) can filter/sort
 * without entangling sprint-close capture aggregation.
 *
 * Safe to call multiple times (idempotent).
 */
export function ensureAgentFeedbackTable(client: CmosDatabaseClient): MigrationResult {
  const warnings: string[] = [];
  const createResult = client.execute(
    `CREATE TABLE IF NOT EXISTS agent_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
      project_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_note TEXT
    )`,
    []
  );

  const tableCreated = checkWrite(createResult, warnings, 'CREATE TABLE agent_feedback');

  const indexResults: string[] = [];
  const indexes = [
    {
      name: 'idx_agent_feedback_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_agent_feedback_status ON agent_feedback (status)',
    },
    {
      name: 'idx_agent_feedback_tool',
      sql: 'CREATE INDEX IF NOT EXISTS idx_agent_feedback_tool ON agent_feedback (tool_name)',
    },
    {
      name: 'idx_agent_feedback_created',
      sql: 'CREATE INDEX IF NOT EXISTS idx_agent_feedback_created ON agent_feedback (created_at DESC)',
    },
  ];

  for (const index of indexes) {
    const result = client.execute(index.sql, []);
    if (checkWrite(result, warnings, `CREATE INDEX ${index.name}`)) {
      indexResults.push(index.name);
    }
  }

  return {
    columnsAdded: tableCreated ? ['agent_feedback (table)'] : [],
    indexesCreated: indexResults,
    rowsUpdated: 0,
    alreadyCurrent: false,
    warnings,
  };
}

/**
 * Ensure the vector retrieval substrate exists (Sprint 66 m02).
 *
 * Provisions three vec0 virtual tables (one per retrievable type), adds the
 * `last_embedded_hash` skip-on-no-op tracking column to each source table,
 * and brings FTS5 to parity by adding `learnings_fts` + `missions_fts` plus
 * INSERT/DELETE/UPDATE triggers that mirror the existing `decisions_fts`
 * pattern. Bumps `schema_version` to `2.3` on first successful application.
 *
 * Layout decisions and rationale: cmos/planning/adr/s66-vector-retrieval.md.
 *
 * Idempotent. Safe to call multiple times — existence checks early-return for
 * already-provisioned virtual tables and columns. Requires the sqlite-vec
 * extension to be loaded on the connection (handled by `loadVecExtension` in
 * `CmosDatabaseClient.ensureConnection`).
 */
export function ensureVectorStorage(client: CmosDatabaseClient): MigrationResult {
  const columnsAdded: string[] = [];
  const indexesCreated: string[] = [];
  const warnings: string[] = [];
  let rowsUpdated = 0;
  let didWork = false;
  let allReady = true;

  const schemaVersion = client.getOne<{ value: string }>(
    "SELECT value FROM metadata WHERE key = 'schema_version'",
    []
  );
  const versionMatch = /^(\d+)\.(\d+)$/.exec(schemaVersion.data?.value ?? '');
  const markerCurrent =
    schemaVersion.success &&
    versionMatch !== null &&
    (Number(versionMatch[1]) > 2 ||
      (Number(versionMatch[1]) === 2 && Number(versionMatch[2]) >= 3));

  // ─── Vector tables (vec0) ────────────────────────────────────────────────

  const vectorTables: ReadonlyArray<{
    readonly name: string;
    readonly sql: string;
  }> = [
    {
      name: 'decisions_vec',
      sql: `CREATE VIRTUAL TABLE decisions_vec USING vec0(
        decision_id INTEGER PRIMARY KEY,
        embedding FLOAT[384]
      )`,
    },
    {
      name: 'learnings_vec',
      sql: `CREATE VIRTUAL TABLE learnings_vec USING vec0(
        learning_id INTEGER PRIMARY KEY,
        embedding FLOAT[384]
      )`,
    },
    {
      name: 'missions_vec',
      sql: `CREATE VIRTUAL TABLE missions_vec USING vec0(
        mission_id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )`,
    },
  ];
  for (const table of vectorTables) {
    const ensured = ensureVirtualTableObject(client, table.name, 'vec0', table.sql, warnings);
    allReady = allReady && ensured.ready;
    if (ensured.created) {
      columnsAdded.push(`${table.name} (virtual table)`);
      didWork = true;
    }
  }

  // ─── Skip-on-no-op tracking columns ──────────────────────────────────────

  const embedHashCol: ColumnSpec = { name: 'last_embedded_hash', type: 'TEXT' };

  for (const table of ['strategic_decisions', 'learnings', 'missions']) {
    const cols = getTableColumns(client, table);
    if (cols.size === 0) {
      allReady = false;
      // Missing learnings/missions sources are named by their FTS trigger/rebuild checks below.
      // strategic_decisions has no FTS arm in this helper, so diagnose it here rather than let the
      // absent hash-column source silently pass the readiness gate.
      if (table !== 'strategic_decisions') continue;
      const source = client.getOne<{ type: string }>(
        'SELECT type FROM sqlite_master WHERE name = ?',
        [table]
      );
      if (!source.success) {
        warnings.push(
          `ALTER TABLE ${table} ADD COLUMN last_embedded_hash preflight failed: ${source.error?.code ?? 'DB_ERROR'} — ${source.error?.message ?? 'unknown'}`
        );
      } else if (!source.data) {
        warnings.push(
          `ALTER TABLE ${table} ADD COLUMN last_embedded_hash blocked: DB_SCHEMA_MISMATCH — Source table '${table}' does not exist.`
        );
      } else {
        warnings.push(
          `ALTER TABLE ${table} ADD COLUMN last_embedded_hash blocked: DB_SCHEMA_MISMATCH — Existing ${source.data.type} '${table}' has no readable columns.`
        );
      }
      continue;
    }

    const alreadyPresent = cols.has(embedHashCol.name);
    if (ensureColumn(client, table, embedHashCol, cols, warnings)) {
      columnsAdded.push(`${table}.last_embedded_hash`);
      didWork = true;
    } else if (!alreadyPresent) {
      allReady = false;
    }
  }

  // ─── FTS5 parity — learnings_fts ─────────────────────────────────────────

  const learningsFts = ensureExternalFts(
    client,
    {
      name: 'learnings_fts',
      sourceTable: 'learnings',
      createSql: `CREATE VIRTUAL TABLE learnings_fts USING fts5(
        content,
        content='learnings',
        content_rowid='id'
      )`,
      triggers: [
        {
          name: 'learnings_fts_insert',
          sql: `CREATE TRIGGER learnings_fts_insert AFTER INSERT ON learnings BEGIN
            INSERT INTO learnings_fts(rowid, content) VALUES (new.id, new.content);
          END`,
        },
        {
          name: 'learnings_fts_delete',
          sql: `CREATE TRIGGER learnings_fts_delete AFTER DELETE ON learnings BEGIN
            INSERT INTO learnings_fts(learnings_fts, rowid, content)
            VALUES('delete', old.id, old.content);
          END`,
        },
        {
          name: 'learnings_fts_update',
          sql: `CREATE TRIGGER learnings_fts_update AFTER UPDATE OF content ON learnings BEGIN
            INSERT INTO learnings_fts(learnings_fts, rowid, content)
            VALUES('delete', old.id, old.content);
            INSERT INTO learnings_fts(rowid, content) VALUES (new.id, new.content);
          END`,
        },
      ],
      forceRebuild: !markerCurrent,
      verifyIndexedRowCount: true,
    },
    warnings
  );
  allReady = allReady && learningsFts.ready;
  if (learningsFts.tableCreated) {
    columnsAdded.push('learnings_fts (virtual table)');
  }
  indexesCreated.push(...learningsFts.triggersCreated);
  rowsUpdated += learningsFts.rowsUpdated;
  didWork =
    didWork ||
    learningsFts.tableCreated ||
    learningsFts.triggersCreated.length > 0 ||
    learningsFts.rebuilt;

  // ─── FTS5 parity — missions_fts ──────────────────────────────────────────
  //
  // missions.id is TEXT, so FTS5's content_rowid binds to the SQLite-allocated
  // implicit `rowid` column. Retrieval joins missions_fts.rowid back to
  // missions.rowid (then SELECTs missions.id) for the public ID surface.

  const missionsFts = ensureExternalFts(
    client,
    {
      name: 'missions_fts',
      sourceTable: 'missions',
      createSql: `CREATE VIRTUAL TABLE missions_fts USING fts5(
        name,
        objective,
        notes,
        content='missions',
        content_rowid='rowid'
      )`,
      triggers: [
        {
          name: 'missions_fts_insert',
          sql: `CREATE TRIGGER missions_fts_insert AFTER INSERT ON missions BEGIN
            INSERT INTO missions_fts(rowid, name, objective, notes)
            VALUES (new.rowid, new.name, COALESCE(new.objective, ''), COALESCE(new.notes, ''));
          END`,
        },
        {
          name: 'missions_fts_delete',
          sql: `CREATE TRIGGER missions_fts_delete AFTER DELETE ON missions BEGIN
            INSERT INTO missions_fts(missions_fts, rowid, name, objective, notes)
            VALUES('delete', old.rowid, old.name, COALESCE(old.objective, ''), COALESCE(old.notes, ''));
          END`,
        },
        {
          name: 'missions_fts_update',
          sql: `CREATE TRIGGER missions_fts_update
            AFTER UPDATE OF name, objective, notes ON missions BEGIN
            INSERT INTO missions_fts(missions_fts, rowid, name, objective, notes)
            VALUES('delete', old.rowid, old.name, COALESCE(old.objective, ''), COALESCE(old.notes, ''));
            INSERT INTO missions_fts(rowid, name, objective, notes)
            VALUES (new.rowid, new.name, COALESCE(new.objective, ''), COALESCE(new.notes, ''));
          END`,
        },
      ],
      forceRebuild: !markerCurrent,
      verifyIndexedRowCount: true,
    },
    warnings
  );
  allReady = allReady && missionsFts.ready;
  if (missionsFts.tableCreated) {
    columnsAdded.push('missions_fts (virtual table)');
  }
  indexesCreated.push(...missionsFts.triggersCreated);
  rowsUpdated += missionsFts.rowsUpdated;
  didWork =
    didWork ||
    missionsFts.tableCreated ||
    missionsFts.triggersCreated.length > 0 ||
    missionsFts.rebuilt;

  // A stale marker is a durable retry signal: even when every object now exists, re-run the FTS
  // rebuilds above and retry this write. Only a warning-free, structurally ready store may claim
  // vector schema 2.3.
  if (!markerCurrent && allReady && warnings.length === 0) {
    const versionResult = client.execute(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '2.3')",
      []
    );
    if (checkWrite(versionResult, warnings, "metadata.schema_version = '2.3'")) {
      didWork = true;
    }
  }

  return {
    columnsAdded,
    indexesCreated,
    rowsUpdated,
    alreadyCurrent: markerCurrent && allReady && !didWork && warnings.length === 0,
    warnings,
  };
}

/**
 * Thrown when a schema-migration helper hits an unrecoverable, ambiguous state
 * that needs manual operator intervention rather than a silent guess. Carries a
 * remediation hint in the message so the operator knows exactly what to fix.
 *
 * Sprint 69 m02 — `ensureRenamedColumn` (both-columns-present) and
 * `ensureColumnWithCheck` (backfill left NULLs / DDL un-rewritable / rebuild
 * rolled back) both throw this so the failure is loud and actionable per the
 * s68 ADR Pre-work requirements.
 */
export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMigrationError';
  }
}

/**
 * Rename a column on a table in a snapshot-restore-safe way (Sprint 69 m02).
 *
 * A plain `ALTER TABLE ... RENAME COLUMN` is not idempotent: re-running it after
 * the rename already happened errors ("no such column"), and a snapshot restored
 * over a partially-migrated DB can leave BOTH the old and new column present at
 * once. This 4-case guard makes every combination deterministic so the helper is
 * safe to call lazily at point-of-use, exactly like the other `ensure*` helpers
 * in this module.
 *
 * | old column | new column | action                                              |
 * |------------|------------|-----------------------------------------------------|
 * | absent     | present    | no-op (already renamed)                             |
 * | present    | absent     | `ALTER TABLE ... RENAME COLUMN old TO new`           |
 * | present    | present    | **FAIL LOUDLY** (snapshot restored over partial mig) |
 * | absent     | absent     | `ADD COLUMN new <addColumnDef>` (or FAIL if omitted) |
 *
 * SQLite ≥ 3.25 automatically updates references to the renamed column inside
 * existing indexes/triggers/views, so a caller that also wants a *renamed index*
 * (e.g. `idx_x_session` → `idx_x_author_session`) must drop+recreate that index
 * itself; this helper only moves the column.
 *
 * @throws SchemaMigrationError when both columns exist, or when neither exists
 *   and no `addColumnDef` was supplied.
 */
export function ensureRenamedColumn(
  client: CmosDatabaseClient,
  table: string,
  oldName: string,
  newName: string,
  addColumnDef?: string
): MigrationResult {
  const columns = getTableColumns(client, table);

  // Table absent/unreadable — nothing to rename. No-op so a lazy caller on a
  // fresh or foreign DB doesn't crash; schema.ts (or the table's own ensure
  // helper) will create it with the new name.
  if (columns.size === 0) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  const hasOld = columns.has(oldName);
  const hasNew = columns.has(newName);

  if (hasOld && hasNew) {
    throw new SchemaMigrationError(
      `ensureRenamedColumn: table "${table}" has BOTH "${oldName}" and "${newName}" columns. ` +
        `This usually means a snapshot was restored over a partially-migrated database. ` +
        `Resolve manually: confirm which column holds the authoritative data, copy it into ` +
        `"${newName}" if needed, then drop the stale "${oldName}" column before re-running.`
    );
  }

  if (!hasOld && hasNew) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  if (hasOld && !hasNew) {
    const result = client.execute(
      `ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`,
      []
    );
    if (!result.success) {
      throw new SchemaMigrationError(
        `ensureRenamedColumn: failed to rename "${oldName}" → "${newName}" on "${table}": ` +
          `${result.error?.message ?? 'unknown error'}`
      );
    }
    return { columnsAdded: [newName], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: false };
  }

  // Neither present — add the new column (forward-compat for fresh tables that
  // never carried the old name) IF a definition was supplied.
  if (!addColumnDef) {
    throw new SchemaMigrationError(
      `ensureRenamedColumn: table "${table}" has neither "${oldName}" nor "${newName}", and no ` +
        `addColumnDef was provided to create "${newName}". Pass an addColumnDef (e.g. "TEXT") ` +
        `to add it, or verify you are pointed at the right table.`
    );
  }
  const result = client.execute(`ALTER TABLE ${table} ADD COLUMN ${newName} ${addColumnDef}`, []);
  if (!result.success) {
    throw new SchemaMigrationError(
      `ensureRenamedColumn: failed to ADD COLUMN "${newName} ${addColumnDef}" on "${table}": ` +
        `${result.error?.message ?? 'unknown error'}`
    );
  }
  return { columnsAdded: [newName], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: false };
}

/** Read the stored CREATE TABLE statement for a table from sqlite_master. */
function getTableSql(client: CmosDatabaseClient, table: string): string | null {
  const row = client.getOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    [table]
  );
  return row.success && row.data ? row.data.sql : null;
}

/** Ordered list of column names for a table, in PRAGMA table_info (cid) order. */
function getOrderedColumns(client: CmosDatabaseClient, table: string): string[] {
  const result = client.getMany<{ name: string; cid: number }>(`PRAGMA table_info('${table}')`, []);
  if (!result.success || !result.data) return [];
  return [...result.data].sort((a, b) => a.cid - b.cid).map((r) => r.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Find FTS5 virtual tables whose `content=` option mirrors `table`, so they can
 * be rebuilt after a content-table rebuild (rowids may have shifted, e.g. for a
 * TEXT-PK table like `missions` whose `missions_fts` uses `content_rowid='rowid'`).
 */
function findFtsContentTables(client: CmosDatabaseClient, table: string): string[] {
  const rows = client.getMany<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'",
    []
  );
  if (!rows.success || !rows.data) return [];
  // Match `content=` then the table name optionally quoted, then a boundary, so
  // `content='learnings'` does NOT also match a sibling `content='learnings_archive'`.
  const contentRe = new RegExp(
    `content\\s*=\\s*['"]?${escapeRegExp(table)}['"]?(?=\\s|,|\\))`,
    'i'
  );
  const targets: string[] = [];
  for (const row of rows.data) {
    if (contentRe.test(row.sql ?? '')) {
      targets.push(row.name);
    }
  }
  return targets;
}

/**
 * A NOT NULL (+ optional CHECK) constraint to apply to a column that was just
 * added bare (`<column> <type>`) during a multi-column 12-step rebuild.
 */
export interface ColumnConstraint {
  column: string;
  /** The bare type the column was added with, e.g. 'TEXT' — used to anchor the match. */
  type: string;
  /** Optional CHECK body WITHOUT the surrounding `CHECK(...)`, e.g. `event_type IN ('x')`. */
  check?: string;
}

/**
 * Build the rebuilt-table DDL: take the original CREATE TABLE statement, rename
 * the table to `tmpTable`, and inject `NOT NULL` (+ `CHECK (...)` where given)
 * into each constraint's bare `<column> <type>` definition.
 *
 * Deterministic and bounded: the table name is replaced by reconstructing the
 * prefix from the first '(' (sidesteps quoting edge cases), and each constraint
 * is injected by matching the exact `<column> <type>` token followed by a column
 * delimiter (`,` or `)`). That delimiter lookahead both anchors the match and
 * refuses to inject into a column that already carries modifiers (the helper's
 * contract is to constrain columns added bare); any constraint not matching
 * exactly once throws rather than producing malformed DDL.
 */
function buildConstrainedDdl(
  originalSql: string,
  table: string,
  tmpTable: string,
  constraints: ColumnConstraint[]
): string {
  const parenIndex = originalSql.indexOf('(');
  if (parenIndex === -1) {
    throw new SchemaMigrationError(
      `rebuildTableWithConstraints: cannot parse DDL for "${table}" (no column list found): ${originalSql}`
    );
  }
  let body = originalSql.slice(parenIndex); // "( ...columns... )"
  for (const c of constraints) {
    const columnDefRe = new RegExp(
      `(\\b${escapeRegExp(c.column)}\\s+${escapeRegExp(c.type)})\\s*(?=,|\\))`,
      'g'
    );
    const matches = body.match(columnDefRe);
    if (!matches || matches.length !== 1) {
      throw new SchemaMigrationError(
        `rebuildTableWithConstraints: expected exactly one bare "${c.column} ${c.type}" column ` +
          `definition in the DDL for "${table}", found ${matches ? matches.length : 0}. Constraints ` +
          `are only applied to columns added bare (no existing NOT NULL/DEFAULT/CHECK).`
      );
    }
    const suffix = ` NOT NULL${c.check ? ` CHECK (${c.check})` : ''}`;
    body = body.replace(columnDefRe, `$1${suffix}`);
  }
  return `CREATE TABLE ${tmpTable} ${body}`;
}

/**
 * The SQLite 12-step table rebuild that applies NOT NULL (+ CHECK) constraints
 * to one or more already-added-bare columns, with enforced validation. Shared by
 * `ensureColumnWithCheck` (single column) and the s69-m03 firehose migration
 * (six columns in one rebuild). Preserves the original DDL exactly (AUTOINCREMENT,
 * FKs, table constraints), copies rows by explicit name-matched column list,
 * recreates every index + trigger, rebuilds mirroring FTS5 content tables, and
 * runs `foreign_key_check` inside the transaction so any failure rolls back.
 * Foreign keys are disabled (outside the transaction — a no-op inside one) and
 * restored in a finally.
 *
 * @throws SchemaMigrationError if the DDL can't be rewritten, a constrained value
 *   is violated during the copy, or the rebuild introduces an FK violation.
 * @param warnings s86-m02b sink for the post-rebuild FTS5 resync, the one write here
 *   that is NOT already fail-loud: it runs AFTER the transaction committed, so it
 *   cannot throw without un-doing a successful rebuild. It is disclosed instead.
 */
function rebuildTableWithConstraints(
  client: CmosDatabaseClient,
  table: string,
  constraints: ColumnConstraint[],
  warnings: string[] = []
): void {
  const ddl = getTableSql(client, table);
  if (!ddl) {
    throw new SchemaMigrationError(
      `rebuildTableWithConstraints: lost the DDL for "${table}" mid-migration.`
    );
  }
  const tmpTable = `${table}__mig_tmp`;
  const newDdl = buildConstrainedDdl(ddl, table, tmpTable, constraints);
  const columnList = getOrderedColumns(client, table).join(', ');

  // Capture indexes + triggers to recreate (skip auto-generated ones, sql NULL).
  const objects = client.getMany<{ type: string; name: string; sql: string }>(
    "SELECT type, name, sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",
    [table]
  );
  const recreateSql = objects.success && objects.data ? objects.data.map((o) => o.sql) : [];
  const ftsTargets = findFtsContentTables(client, table);

  // Foreign keys OFF (suppresses both FK enforcement AND ON DELETE/UPDATE actions
  // — defer_foreign_keys would still fire ON DELETE SET NULL on children when the
  // parent is dropped) + legacy_alter_table ON (the final RENAME renames ONLY the
  // table, not references to it in other objects — needed for self-referential FKs
  // like strategic_decisions.superseded_by and mirroring FTS5 content tables).
  // Set via client.pragma() (db.pragma) NOT raw()/db.exec() — exec'd pragmas are
  // unreliable (the change may not apply until the next statement boundary), which
  // made foreign_keys=OFF intermittently a no-op. foreign_keys is also a hard
  // no-op inside a transaction, so we verify it actually went OFF and abort loudly
  // rather than risk firing ON DELETE actions on children. Both pragmas are
  // connection-level and survive a rollback → reset in the finally (which covers
  // every exit path, including the FK-verify abort below).
  try {
    client.pragma('foreign_keys = OFF');
    client.pragma('legacy_alter_table = ON');
    const fkAfter = client.pragma('foreign_keys');
    const fkOff = Array.isArray(fkAfter) ? fkAfter[0]?.foreign_keys === 0 : fkAfter === 0;
    if (!fkOff) {
      throw new SchemaMigrationError(
        `rebuildTableWithConstraints: could not disable foreign_keys before rebuilding "${table}" ` +
          `(a transaction is likely pending). Run the migration outside any open transaction.`
      );
    }
    const exec = (sql: string): void => {
      const r = client.raw(sql);
      if (!r.success) {
        throw new Error(`${r.error?.message ?? 'statement failed'} :: ${sql.slice(0, 160)}`);
      }
    };
    const rebuild = client.transaction(() => {
      exec(newDdl);
      const copy = client.execute(
        `INSERT INTO ${tmpTable} (${columnList}) SELECT ${columnList} FROM ${table}`,
        []
      );
      if (!copy.success) {
        throw new Error(
          `copy into rebuilt "${table}" violated a NOT NULL/CHECK constraint or failed: ` +
            `${copy.error?.message ?? 'unknown'}`
        );
      }
      exec(`DROP TABLE ${table}`);
      exec(`ALTER TABLE ${tmpTable} RENAME TO ${table}`);
      for (const sql of recreateSql) {
        exec(sql);
      }
      // Check ONLY the rebuilt table's own FK integrity. A whole-DB check would
      // fail the migration on any PRE-EXISTING, unrelated FK violation elsewhere
      // in the store (which the rebuild neither caused nor should refuse over);
      // the rebuild preserves all rows/ids, so incoming references stay valid.
      const violations = client.getMany<Record<string, unknown>>(
        `PRAGMA foreign_key_check(${table})`,
        []
      );
      if (violations.success && violations.data && violations.data.length > 0) {
        throw new Error(`rebuild introduced ${violations.data.length} foreign-key violation(s)`);
      }
      return true;
    });
    if (!rebuild.success) {
      throw new SchemaMigrationError(
        `rebuildTableWithConstraints: 12-step rebuild of "${table}" failed and was rolled back: ` +
          `${rebuild.error?.message ?? 'unknown'}`
      );
    }
  } finally {
    client.pragma('legacy_alter_table = OFF');
    client.pragma('foreign_keys = ON');
  }

  // Resync FTS5 content tables that mirror the rebuilt table.
  for (const fts of ftsTargets) {
    const resync = client.execute(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`, []);
    checkWrite(resync, warnings, `${fts} resync after rebuilding "${table}"`);
  }
}

/**
 * Add a NOT NULL column with a per-table CHECK constraint to a table that may
 * already hold data (Sprint 69 m02) — the snapshot-restore-safe counterpart to
 * `ensureColumns` for the s68 ADR's per-row `event_type` field: NOT NULL, a
 * CHECK enumerating allowed values, and NO DEFAULT (a missing value must fail
 * loudly at INSERT, never be silently substituted).
 *
 * SQLite does NOT validate a CHECK against existing rows when it is added via
 * ALTER, so the only correct way to add NOT NULL + CHECK to a populated column
 * is the documented 12-step table rebuild, which forces validation when rows are
 * copied into the new table. The four steps:
 *
 *  1. `ADD COLUMN <column> <type>` (nullable, no CHECK) if absent.
 *  2. Run `backfillSql` to populate the column on legacy rows.
 *  3. Verify zero NULLs remain — **FAIL LOUDLY** if any (the rebuild would
 *     otherwise reject or corrupt them).
 *  4. 12-step rebuild: create `<table>__mig_tmp` from the original DDL with
 *     `NOT NULL CHECK (<checkConstraint>)` injected, copy all rows (CHECK
 *     enforced here), drop the old table, rename tmp into place, recreate every
 *     index + trigger that existed on the table, and rebuild any FTS5 content
 *     table mirroring it. Foreign keys are disabled around the rebuild and
 *     `foreign_key_check` validates referential integrity before returning; any
 *     failure rolls the whole rebuild back.
 *
 * Idempotent: column already present WITH the CHECK → no-op. Column present
 * WITHOUT the CHECK (an aborted prior run) → resumes from the backfill step.
 *
 * @param type bare column type the column is added with (e.g. "TEXT"); must NOT
 *   itself carry NOT NULL/CHECK — those are applied by the rebuild. Also used to
 *   locate the column definition for injection.
 * @param backfillSql an UPDATE that leaves no NULLs in `<column>`, e.g.
 *   `UPDATE strategic_decisions SET event_type='decision_captured' WHERE event_type IS NULL`.
 * @param checkConstraint the CHECK body WITHOUT the surrounding `CHECK(...)`,
 *   e.g. `event_type IN ('decision_captured')`.
 * @throws SchemaMigrationError on any unsafe state (backfill left NULLs, DDL not
 *   rewritable unambiguously, rebuild failed/rolled back, FK violation).
 */
export function ensureColumnWithCheck(
  client: CmosDatabaseClient,
  table: string,
  column: string,
  type: string,
  backfillSql: string,
  checkConstraint: string
): MigrationResult {
  const originalSql = getTableSql(client, table);
  if (!originalSql) {
    throw new SchemaMigrationError(
      `ensureColumnWithCheck: table "${table}" does not exist (no CREATE TABLE in sqlite_master). ` +
        `Create the table before adding a checked column.`
    );
  }

  const columnsBefore = getTableColumns(client, table);
  const checkSignature = `CHECK (${checkConstraint})`;

  // Idempotency: column present AND the table DDL already carries this CHECK.
  if (
    columnsBefore.has(column) &&
    normalizeWhitespace(originalSql).includes(normalizeWhitespace(checkSignature))
  ) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  // Step 1 — add the nullable column if it isn't there yet.
  let columnAdded = false;
  if (!columnsBefore.has(column)) {
    const addResult = client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, []);
    if (!addResult.success) {
      throw new SchemaMigrationError(
        `ensureColumnWithCheck: failed to ADD COLUMN "${column} ${type}" on "${table}": ` +
          `${addResult.error?.message ?? 'unknown'}`
      );
    }
    columnAdded = true;
  }

  // Step 2 — backfill legacy rows.
  const backfillResult = client.execute(backfillSql, []);
  if (!backfillResult.success) {
    throw new SchemaMigrationError(
      `ensureColumnWithCheck: backfill failed on "${table}": ` +
        `${backfillResult.error?.message ?? 'unknown'} (sql: ${backfillSql})`
    );
  }
  const rowsUpdated = backfillResult.data?.changes ?? 0;

  // Step 3 — verify no NULLs remain.
  const nullCount = client.getOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} IS NULL`,
    []
  );
  if (!nullCount.success) {
    throw new SchemaMigrationError(
      `ensureColumnWithCheck: could not verify NULLs on "${table}.${column}": ` +
        `${nullCount.error?.message ?? 'unknown'}`
    );
  }
  if ((nullCount.data?.c ?? 0) > 0) {
    throw new SchemaMigrationError(
      `ensureColumnWithCheck: ${nullCount.data?.c} row(s) in "${table}" still have NULL "${column}" ` +
        `after backfill. The NOT NULL + CHECK rebuild would reject them. Fix the backfill SQL to ` +
        `cover every legacy row before re-running.`
    );
  }

  // Step 4 — 12-step rebuild to add NOT NULL + CHECK with enforced validation.
  const warnings: string[] = [];
  rebuildTableWithConstraints(client, table, [{ column, type, check: checkConstraint }], warnings);

  return {
    columnsAdded: columnAdded ? [column] : [],
    indexesCreated: [],
    rowsUpdated,
    alreadyCurrent: false,
    warnings,
  };
}

// ── Sprint 69 m03 — combined firehose per-row schema migration ───────────────

/** Schema version stamped in `metadata` after the firehose migration applies. */
export const FIREHOSE_SCHEMA_VERSION = '2.4';
/** Marker key in `metadata`, set only after ALL firehose tables are migrated. */
const FIREHOSE_MARKER_KEY = 'firehose_event_columns';

/**
 * SQL expression converting a firehose table's time column to Unix milliseconds
 * for the `occurred_at` backfill. Introspects which timestamp columns actually
 * exist on the table (in priority order) rather than assuming a fixed set — real
 * stores carry the full schema, but partial/older fixtures may be missing
 * `created_at` etc., and referencing a non-existent column would fail the whole
 * backfill. A NULL time coalesces to 'now' so the NOT NULL backfill never leaves
 * a hole; a genuinely unparseable value yields NULL and is caught by the
 * post-backfill verify (fail loud).
 */
function occurredAtExpr(client: CmosDatabaseClient, table: FirehoseTable): string {
  const cols = getTableColumns(client, table);
  const candidates = ['created_at', 'started_at', 'start_date', 'completed_at', 'end_date'];
  const present = candidates.filter((c) => cols.has(c));
  const chain = present.length > 0 ? `COALESCE(${present.join(', ')}, 'now')` : `'now'`;
  // Guaranteed non-NULL and non-negative: an unparseable timestamp makes strftime
  // return NULL → fall back to 'now' (one bad legacy row can't abort the whole
  // migration); a pre-1970 timestamp would be negative → clamp to 0 (so the NOT
  // NULL backfill always succeeds AND the ULID seed, which reads occurred_at,
  // can't go negative and crash `ulid()`).
  return `MAX(0, CAST(COALESCE(strftime('%s', ${chain}), strftime('%s', 'now')) AS INTEGER) * 1000)`;
}

/**
 * Resolve a non-empty project_id for the backfill: metadata `project_id` →
 * `dashboard_slug` → `project_name` → `'unknown-project'`. Mirrors
 * genesis-columns.getProjectId (inlined here to avoid a circular import, since
 * genesis-columns imports ensureFirehoseEventColumns from this module).
 *
 * s87-m04 — THE OLD RATIONALE HERE WAS FALSE AND IS REPLACED. It claimed real stores invariably
 * record an identity, so the fallback only ever fired on misconfigured or test stores. Measured
 * with immutable SQLite inspection across every CMOS store on this machine (#1038): 45 stores,
 * 32 resolving via a recorded identity, 13 collapsing to the fallback label, 0 unclassifiable.
 * The fallback fires on thirteen, and it has already fired in production — derekn.com's store
 * carries 217 rows stamped with the label across six tables.
 *
 * WHAT IS UNCHANGED: the fallback itself. Ruling #736 — fall back and warn rather than throw —
 * is REAFFIRMED by decision #1017 (D-8); only its premise is amended. The fallback still keeps
 * the NOT NULL backfill from failing on a store with no identity, and still never overrides a
 * recorded id. Sprint-87 ships NO identity write: it corrects the disclosure, the label and the
 * seed. The full amendment, with the original premise quoted verbatim, is in #1017 — it is
 * deliberately not quoted here, because a shipped-prose gate sweeps this tree for that sentence
 * and a gate a comment can trip is a gate someone will weaken.
 */
function resolveProjectId(client: CmosDatabaseClient): string {
  const read = (key: string): string => {
    const r = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
    return r.success && r.data ? (r.data.value ?? '') : '';
  };
  return read('project_id') || read('dashboard_slug') || read('project_name') || 'unknown-project';
}

/** True if `column` exists on `table` with a NOT NULL constraint (table_info). */
function columnIsNotNull(client: CmosDatabaseClient, table: string, column: string): boolean {
  const rows = client.getMany<{ name: string; notnull: number }>(
    `PRAGMA table_info('${table}')`,
    []
  );
  if (!rows.success || !rows.data) return false;
  const col = rows.data.find((r) => r.name === column);
  return !!col && col.notnull === 1;
}

/**
 * Create the `(project_id, event_type, occurred_at)` composite index. Returns
 * true only when it ACTUALLY created the index (not when it already existed), so
 * a re-run reports `alreadyCurrent` rather than re-claiming the index as new.
 */
function ensureAggIndex(
  client: CmosDatabaseClient,
  table: string,
  warnings: string[] = []
): boolean {
  const name = `idx_${table}_aggkey`;
  const existing = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
    [name]
  );
  if (existing.success && existing.data) return false;
  const result = client.execute(
    `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (project_id, event_type, occurred_at)`,
    []
  );
  return checkWrite(result, warnings, `CREATE INDEX ${name}`);
}

/**
 * Add the six per-row columns (project_id, stable_event_id, occurred_at,
 * origin_seq, event_type, schema_version) + the composite agg index to ONE
 * firehose table (s68 ADR §1, as amended s69-m03). Idempotent: a table that
 * already has `event_type` only (re)ensures its index. Backfill order: set-based
 * UPDATE for project_id/occurred_at/origin_seq/event_type, then an app-side ULID
 * loop for stable_event_id (SQLite has no ULID function; the ULID is seeded with
 * the row's occurred_at so legacy ids stay time-sortable). Then a single 12-step
 * rebuild applies all NOT NULL + the event_type CHECK with enforced validation.
 */
function migrateFirehoseTable(client: CmosDatabaseClient, table: FirehoseTable): MigrationResult {
  const warnings: string[] = [];
  const existing = getTableColumns(client, table);
  if (existing.size === 0) {
    // Table absent in this store (e.g. a partial/foreign DB) — nothing to do.
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }
  // Idempotency keys on the NOT NULL flag, not mere column presence: a fresh
  // install carries the columns NULLABLE (so the ~600 raw-firehose-insert test
  // sites don't break), and the migration must still upgrade them to NOT NULL +
  // CHECK. event_type being NOT NULL is the "fully migrated" signal.
  if (columnIsNotNull(client, table, 'event_type')) {
    const created = ensureAggIndex(client, table, warnings);
    return {
      columnsAdded: [],
      indexesCreated: created ? [`idx_${table}_aggkey`] : [],
      rowsUpdated: 0,
      alreadyCurrent: true,
      warnings,
    };
  }

  const columnsAdded: string[] = [];
  const addCol = (name: string, type: string): void => {
    if (!existing.has(name)) {
      const r = client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`, []);
      if (!r.success) {
        throw new SchemaMigrationError(
          `migrateFirehoseTable: ADD COLUMN "${name} ${type}" on "${table}" failed: ${r.error?.message ?? 'unknown'}`
        );
      }
      columnsAdded.push(name);
    }
  };

  // Step 1 — add the five bare columns + schema_version (with its DEFAULT).
  addCol('project_id', 'TEXT');
  addCol('stable_event_id', 'TEXT');
  addCol('occurred_at', 'INTEGER');
  addCol('origin_seq', 'INTEGER');
  addCol('event_type', 'TEXT');
  addCol('schema_version', 'INTEGER NOT NULL DEFAULT 1');

  // Step 2 — set-based backfill (project_id from metadata; occurred_at from the
  // table's time column; origin_seq from rowid; event_type = the genesis verb).
  const verb = GENESIS_TYPE_BY_TABLE[table];
  const projectIdValue = resolveProjectId(client);
  const backfill = client.execute(
    `UPDATE ${table} SET
       project_id = COALESCE(NULLIF(project_id, ''), ?),
       occurred_at = COALESCE(occurred_at, ${occurredAtExpr(client, table)}),
       origin_seq = COALESCE(origin_seq, rowid),
       event_type = COALESCE(NULLIF(event_type, ''), '${verb}')`,
    [projectIdValue]
  );
  if (!backfill.success) {
    throw new SchemaMigrationError(
      `migrateFirehoseTable: backfill on "${table}" failed: ${backfill.error?.message ?? 'unknown'}`
    );
  }

  // Step 3 — app-side ULID backfill for stable_event_id, seeded with occurred_at.
  // Alias `rowid AS rid`: on an INTEGER-PRIMARY-KEY table SQLite aliases rowid to
  // the PK column, so a bare `SELECT rowid` comes back under the PK name (e.g.
  // `id`) and `row.rowid` would be undefined — silently matching 0 rows.
  const nullIds = client.getMany<{ rid: number; occurred_at: number }>(
    `SELECT rowid AS rid, occurred_at FROM ${table} WHERE stable_event_id IS NULL`,
    []
  );
  if (nullIds.success && nullIds.data) {
    for (const row of nullIds.data) {
      const seed = typeof row.occurred_at === 'number' ? row.occurred_at : undefined;
      const upd = client.execute(`UPDATE ${table} SET stable_event_id = ? WHERE rowid = ?`, [
        ulid(seed),
        row.rid,
      ]);
      if (!upd.success) {
        throw new SchemaMigrationError(
          `migrateFirehoseTable: stable_event_id backfill on "${table}" rowid ${row.rid} failed: ${upd.error?.message ?? 'unknown'}`
        );
      }
    }
  }

  // Step 4 — verify no NULLs remain in the five NOT-NULL columns (fail loud).
  for (const col of ['project_id', 'stable_event_id', 'occurred_at', 'origin_seq', 'event_type']) {
    const n = client.getOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IS NULL`,
      []
    );
    if (!n.success) {
      throw new SchemaMigrationError(
        `migrateFirehoseTable: NULL check on "${table}.${col}" failed: ${n.error?.message ?? 'unknown'}`
      );
    }
    if ((n.data?.c ?? 0) > 0) {
      throw new SchemaMigrationError(
        `migrateFirehoseTable: ${n.data?.c} row(s) in "${table}" still have NULL "${col}" after ` +
          `backfill (likely metadata.project_id is missing, or a created_at value is unparseable). ` +
          `Fix the store before re-running.`
      );
    }
  }

  // Step 5 — one 12-step rebuild applying all NOT NULL + the event_type CHECK.
  rebuildTableWithConstraints(
    client,
    table,
    [
      { column: 'project_id', type: 'TEXT' },
      { column: 'stable_event_id', type: 'TEXT' },
      { column: 'occurred_at', type: 'INTEGER' },
      { column: 'origin_seq', type: 'INTEGER' },
      { column: 'event_type', type: 'TEXT', check: `event_type IN ('${verb}')` },
    ],
    warnings
  );

  // Step 6 — composite index.
  const idxCreated = ensureAggIndex(client, table, warnings);

  return {
    columnsAdded,
    indexesCreated: idxCreated ? [`idx_${table}_aggkey`] : [],
    rowsUpdated: 0,
    alreadyCurrent: false,
    warnings,
  };
}

/**
 * The combined s69-m03 migration: add the 6 per-row columns + the
 * `(project_id, event_type, occurred_at)` composite index to all 8 firehose
 * tables (s68 ADR §1, as amended s69-m03), in one lazy `ensure*` invoked at
 * point-of-use (CMOS has no central migration runner). Idempotent and resumable;
 * a fast `metadata` marker short-circuits the hot insert path once every table
 * is migrated. The marker stores `FIREHOSE_SCHEMA_VERSION` (not just "applied"),
 * so bumping that version — e.g. when a new firehose table joins the set — makes
 * already-migrated stores re-run (idempotently, fast) and pick up the addition.
 * On completion it also bumps `metadata.schema_version` (NOT `PRAGMA user_version`,
 * which CMOS does not use).
 */
export function ensureFirehoseEventColumns(client: CmosDatabaseClient): MigrationResult {
  const marker = client.getOne<{ value: string }>(
    `SELECT value FROM metadata WHERE key='${FIREHOSE_MARKER_KEY}'`,
    []
  );
  if (marker.success && marker.data?.value === FIREHOSE_SCHEMA_VERSION) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  const columnsAdded: string[] = [];
  const indexesCreated: string[] = [];
  const warnings: string[] = [];
  let anyMigrated = false; // any table did real work (added cols OR upgraded NOT NULL)
  for (const table of FIREHOSE_TABLES) {
    const res = migrateFirehoseTable(client, table);
    columnsAdded.push(...res.columnsAdded);
    indexesCreated.push(...res.indexesCreated);
    if (res.warnings) warnings.push(...res.warnings);
    if (!res.alreadyCurrent) anyMigrated = true;
  }

  const markerResult = client.execute(
    `INSERT OR REPLACE INTO metadata (key, value) VALUES ('${FIREHOSE_MARKER_KEY}', '${FIREHOSE_SCHEMA_VERSION}')`,
    []
  );
  checkWrite(markerResult, warnings, `metadata.${FIREHOSE_MARKER_KEY} marker`);
  const versionResult = client.execute(
    `INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '${FIREHOSE_SCHEMA_VERSION}')`,
    []
  );
  checkWrite(versionResult, warnings, `metadata.schema_version = '${FIREHOSE_SCHEMA_VERSION}'`);

  return {
    columnsAdded,
    indexesCreated,
    rowsUpdated: 0,
    // alreadyCurrent only when EVERY table was already migrated — a greenfield
    // store upgrades nullable→NOT NULL without adding columns/indexes, which is
    // still real work.
    alreadyCurrent: !anyMigrated,
    warnings,
  };
}

// ── Sprint 69 m04 — author_* namespace migration ─────────────────────────────

/** Schema version stamped in `metadata` after the author-namespace migration. */
export const AUTHOR_NAMESPACE_SCHEMA_VERSION = '1.0';
/** Marker key in `metadata`, set only after the author-namespace migration applies. */
const AUTHOR_NAMESPACE_MARKER_KEY = 'author_namespace_columns';

/**
 * The two firehose tables whose session-of-origin column is renamed from
 * `session_id` to `author_session_id` (s68 ADR Deferred 1). These are the only
 * two tables that historically carried a `session_id` FK to `sessions(id)` as a
 * decision/learning author hint; `context_snapshots`/`next_steps`/`constraints`
 * keep their `session_id` (a different, infrastructural association — NOT renamed).
 */
const AUTHOR_SESSION_RENAME_TABLES = ['strategic_decisions', 'learnings'] as const;

/**
 * The combined s69-m04 migration: land the `author_*` namespace coherently in one
 * pass (s68 ADR Deferred 1 + s69-m04 mission spec).
 *
 *   1. Rename `session_id` → `author_session_id` on `strategic_decisions` and
 *      `learnings` via {@link ensureRenamedColumn} (snapshot-restore-safe 4-case
 *      guard; a both-present DB FAILS LOUDLY rather than silently picking one).
 *   2. Rename the supporting index `idx_<t>_session` → `idx_<t>_author_session`
 *      (DROP-then-CREATE so the index name tracks the column rename).
 *   3. Add `author_user_id TEXT` (NULLABLE) to all 8 firehose tables.
 *   4. Add `user_id TEXT` (NULLABLE) to `sessions`.
 *
 * **`author_user_id` / `user_id` are NULLABLE on purpose.** This migration lands
 * the column NAMES now (forward-compat-cheap) but does NOT bind actual user
 * identity — there is no multi-user identity layer yet, so there is no value to
 * write. A later sprint introduces the identity source and flips these to NOT NULL
 * once every row can carry an author. Until then `genesisColumns` does not stamp
 * them (they stay NULL on new rows), which is correct.
 *
 * **`session.id` scope (resolved s69-m04, the mission's required first step).**
 * `generateSessionId` ([cmos-session-start.ts]) mints `PS-YYYY-MM-DD-NNN`, a
 * per-project daily counter — it is **project-scoped**, NOT a client-scoped ULID
 * persisted across a user's project DBs. Consequence: `author_session_id` is
 * **opaque across stores** (the same `PS-2026-05-30-001` in two projects denotes
 * two unrelated sessions), so cross-store aggregation by `author_session_id` is
 * NOT meaningful — it is a within-project drill-down key only. The dominant
 * cross-store aggregation keys remain `(project_id, author_user_id, occurred_at)`
 * per the ADR; `author_user_id` (not `author_session_id`) is the cross-store
 * author axis once the identity layer populates it. The rename still lands now so
 * the `author_*` namespace is coherent from day one; only this framing changes.
 *
 * **Transaction-safety.** Unlike the m03 firehose migration, this one performs NO
 * 12-step rebuild — only bare `ALTER … RENAME COLUMN`, `ALTER … ADD COLUMN`, and
 * `DROP/CREATE INDEX`, none of which toggle `foreign_keys`. It is therefore safe
 * to run lazily even inside an open transaction. SQLite (with the default
 * `legacy_alter_table = OFF`) rewrites the renamed column's reference in the
 * table's own FK clause and in any index/trigger that names it, so the
 * `ON DELETE SET NULL` FK and the FTS5 triggers (which reference `decision_text`/
 * `content`, not `session_id`) survive the rename untouched.
 *
 * Idempotent and resumable: a `metadata` marker short-circuits the hot path once
 * applied; clearing the marker re-runs it as a fast no-op on an already-migrated
 * store. Returns `alreadyCurrent: true` only when nothing changed.
 */
export function ensureAuthorNamespaceColumns(client: CmosDatabaseClient): MigrationResult {
  const marker = client.getOne<{ value: string }>(
    `SELECT value FROM metadata WHERE key='${AUTHOR_NAMESPACE_MARKER_KEY}'`,
    []
  );
  if (marker.success && marker.data?.value === AUTHOR_NAMESPACE_SCHEMA_VERSION) {
    return { columnsAdded: [], indexesCreated: [], rowsUpdated: 0, alreadyCurrent: true };
  }

  const columnsAdded: string[] = [];
  const indexesCreated: string[] = [];
  const warnings: string[] = [];
  let anyWork = false;

  // 1. Rename session_id → author_session_id (the 4-case guard throws on a
  //    both-present snapshot-restore; addColumnDef='TEXT' creates it on a fresh
  //    table that never carried session_id — though greenfield schema.ts already
  //    ships author_session_id, so that path is a no-op there).
  for (const table of AUTHOR_SESSION_RENAME_TABLES) {
    const res = ensureRenamedColumn(client, table, 'session_id', 'author_session_id', 'TEXT');
    for (const col of res.columnsAdded) columnsAdded.push(`${table}.${col}`);
    if (!res.alreadyCurrent) anyWork = true;
  }

  // 2. Index rename. Only idx_strategic_decisions_session exists historically
  //    (idx_learnings_session was named in the ADR's "current state" but was never
  //    actually created — see s69-m04 completion notes); the DROP IF EXISTS makes
  //    that asymmetry a no-op, and idx_learnings_author_session lands net-new for
  //    symmetry with decisions per the mission deliverable list.
  const indexRenames: ReadonlyArray<{ table: string; oldName: string; newName: string }> = [
    {
      table: 'strategic_decisions',
      oldName: 'idx_strategic_decisions_session',
      newName: 'idx_strategic_decisions_author_session',
    },
    {
      table: 'learnings',
      oldName: 'idx_learnings_session',
      newName: 'idx_learnings_author_session',
    },
  ];
  for (const { table, oldName, newName } of indexRenames) {
    // Skip a table absent from this store, or one whose rename didn't land (e.g.
    // a foreign DB without the column) — an index on a missing column would fail.
    if (!getTableColumns(client, table).has('author_session_id')) continue;
    const dropped = client.execute(`DROP INDEX IF EXISTS ${oldName}`, []);
    checkWrite(dropped, warnings, `DROP INDEX ${oldName}`);
    const existsNew = client.getOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
      [newName]
    );
    const hadNew = existsNew.success && !!existsNew.data;
    const created = client.execute(
      `CREATE INDEX IF NOT EXISTS ${newName} ON ${table} (author_session_id)`,
      []
    );
    if (checkWrite(created, warnings, `CREATE INDEX ${newName}`) && !hadNew) {
      indexesCreated.push(newName);
      anyWork = true;
    }
  }

  // 3. author_user_id (nullable) on all 8 firehose tables.
  for (const table of FIREHOSE_TABLES) {
    const cols = getTableColumns(client, table);
    if (cols.size === 0) continue; // table absent in this store
    if (!cols.has('author_user_id')) {
      const r = client.execute(`ALTER TABLE ${table} ADD COLUMN author_user_id TEXT`, []);
      if (!r.success) {
        throw new SchemaMigrationError(
          `ensureAuthorNamespaceColumns: ADD COLUMN author_user_id on "${table}" failed: ${r.error?.message ?? 'unknown'}`
        );
      }
      columnsAdded.push(`${table}.author_user_id`);
      anyWork = true;
    }
  }

  // 4. user_id (nullable) on sessions — the author identity author_session_id
  //    points at once the multi-user layer populates it.
  const sessionCols = getTableColumns(client, 'sessions');
  if (sessionCols.size > 0 && !sessionCols.has('user_id')) {
    const r = client.execute(`ALTER TABLE sessions ADD COLUMN user_id TEXT`, []);
    if (!r.success) {
      throw new SchemaMigrationError(
        `ensureAuthorNamespaceColumns: ADD COLUMN user_id on "sessions" failed: ${r.error?.message ?? 'unknown'}`
      );
    }
    columnsAdded.push('sessions.user_id');
    anyWork = true;
  }

  const markerResult = client.execute(
    `INSERT OR REPLACE INTO metadata (key, value) VALUES ('${AUTHOR_NAMESPACE_MARKER_KEY}', '${AUTHOR_NAMESPACE_SCHEMA_VERSION}')`,
    []
  );
  checkWrite(markerResult, warnings, `metadata.${AUTHOR_NAMESPACE_MARKER_KEY} marker`);

  return { columnsAdded, indexesCreated, rowsUpdated: 0, alreadyCurrent: !anyWork, warnings };
}

/**
 * s86-m08 — bring a store's `sprint_summary` view up to the current definition.
 *
 * WHY A MIGRATION AT ALL. `CREATE VIEW IF NOT EXISTS` is a no-op against an existing view, so
 * the corrected counting rule in {@link SPRINT_SUMMARY_VIEW_SQL} would reach FRESH stores only.
 * Every store created before this change would keep reporting Deferred and Dropped work inside
 * `total_missions` while new stores did not — the same column name meaning two different things
 * across the fleet, which is worse than either rule alone.
 *
 * COMPARE-THEN-WRITE. The steady state performs ZERO writes: this runs on READ paths
 * (cmos_sprint list/show/analytics), and a read path that writes on every call would be both a
 * surprise and a hazard on a store opened read-only. Only a genuinely stale definition is
 * rewritten, and only once.
 *
 * IT NEVER DESTROYS SOMETHING IT DID NOT CREATE. If `sprint_summary` is a base TABLE — a shape
 * that exists in this repo's own fixtures — it is left completely alone. `DROP VIEW` against a
 * table does not silently no-op, it errors ("use DROP TABLE to delete table sprint_summary"),
 * and a "helpful" DROP TABLE variant on a READ path would be a data-loss event.
 *
 * A MISSING BASE TABLE IS SAFE. SQLite permits `CREATE VIEW` over tables that do not exist (the
 * error surfaces at query time, not definition time), so a foreign or partial store — one of the
 * fleet stores missing `missions` or `strategic_decisions` — neither throws nor changes.
 *
 * NO SILENT FAIL-OPEN. On a read-only store the DROP/CREATE fails; `client.raw()` maps
 * SQLITE_READONLY to a failed envelope rather than throwing, and that failure is RECORDED in
 * `warnings` so the calling handler can tell the operator its totals still include parked work.
 * Swallowing it would leave an answer quietly reporting the old rule under the new column name.
 *
 * (Contract note: this block documents `ensureSprintSummaryView` below.)
 */
/**
 * `CREATE VIEW IF NOT EXISTS` vs `CREATE VIEW`, and a trailing semicolon, are not differences —
 * SQLite stores the statement text verbatim in `sqlite_master.sql` EXCEPT that it drops the
 * `IF NOT EXISTS` clause. Everything else is compared EXACTLY.
 *
 * WHY NOT COLLAPSE WHITESPACE. An earlier form ran `.replace(/\s+/g, ' ')`, which also collapses
 * whitespace INSIDE quoted string literals — so a view differing only in `'In  Progress'` would
 * have compared equal and never been rewritten. Exact comparison outside those two normalizations
 * is both simpler and stricter; the round-trip is asserted by the idempotence test (a second call
 * must report alreadyCurrent), which is what proves this comparison does not rewrite forever.
 */
function normalizeViewSql(sql: string): string {
  return sql
    .replace(/CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS/i, 'CREATE VIEW')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * What a caller needs to know beyond "did it work": whether it may SELECT `parked_missions`.
 *
 * THIS FIELD EXISTS BECAUSE THE MIGRATION IS ALLOWED TO FAIL. A store whose `sprint_summary` is
 * a base table, or that is open read-only, or whose DROP loses a race for the write lock, keeps
 * the OLD view — and a reader that then selects the new column does not degrade, it ERRORS. The
 * boolean lets the reader ask the question instead of assuming the answer.
 */
export interface SprintSummaryViewResult extends MigrationResult {
  /** True when `sprint_summary` now carries `parked_missions` and a reader may select it. */
  parkedAvailable: boolean;
}

export function ensureSprintSummaryView(client: CmosDatabaseClient): SprintSummaryViewResult {
  const warnings: string[] = [];

  // s86-m08 critic: cmos_sprint list/show are classified 'read' by the fail-closed security
  // taxonomy (action-taxonomy.ts), and a review-pinned agent is promised that a read mutates
  // NOTHING anywhere. A DROP VIEW / CREATE VIEW on that path would break that promise even
  // though it is idempotent and loses no data. Suppressed at the same layer cmos_review already
  // suppresses its registry touch — and the reader is told why its totals are the old rule,
  // rather than being handed a silently stale number.
  if (isReadOnlyAgentSession()) {
    return {
      columnsAdded: [],
      indexesCreated: [],
      rowsUpdated: 0,
      alreadyCurrent: false,
      parkedAvailable: false,
      warnings: [
        'sprint_summary was not upgraded because this is a read-only agent session; total_missions on this store still counts Deferred and Dropped work, and parked_missions is reported as 0.',
      ],
    };
  }
  const none: SprintSummaryViewResult = {
    columnsAdded: [],
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: true,
    parkedAvailable: true,
  };

  const existing = client.getOne<{ type: string; sql: string | null }>(
    `SELECT type, sql FROM sqlite_master WHERE name = 'sprint_summary'`,
    []
  );

  if (!existing.success) {
    // Cannot read sqlite_master: say so rather than assuming the view is fine.
    warnings.push(
      `sprint_summary view check failed: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
    );
    return { ...none, alreadyCurrent: false, parkedAvailable: false, warnings };
  }

  const row = existing.data;

  // A base table of this name is a fixture/consumer artifact. Leave it exactly as it is.
  if (row && row.type !== 'view') {
    return {
      ...none,
      alreadyCurrent: false,
      // Its columns are whatever the caller made them; the reader must not assume ours.
      parkedAvailable: false,
      warnings: [
        `sprint_summary exists as a ${row.type}, not a view — leaving it untouched. Totals from it are whatever that ${row.type} holds, not the current counting rule.`,
      ],
    };
  }

  if (row && row.sql && normalizeViewSql(row.sql) === normalizeViewSql(SPRINT_SUMMARY_VIEW_SQL)) {
    return none; // steady state: no writes, ever again
  }

  if (row) {
    const dropResult = client.raw('DROP VIEW IF EXISTS sprint_summary;');
    if (!dropResult.success) {
      warnings.push(
        `sprint_summary view is stale on this store and could not be replaced (${dropResult.error?.code ?? 'DB_ERROR'} — ${dropResult.error?.message ?? 'unknown'}); total_missions still counts Deferred and Dropped work.`
      );
      return { ...none, alreadyCurrent: false, parkedAvailable: false, warnings };
    }
  }

  const createResult = client.raw(SPRINT_SUMMARY_VIEW_SQL);
  if (!createResult.success) {
    warnings.push(
      `sprint_summary view could not be created (${createResult.error?.code ?? 'DB_ERROR'} — ${createResult.error?.message ?? 'unknown'}); sprint totals are unavailable or stale on this store.`
    );
    return { ...none, alreadyCurrent: false, parkedAvailable: false, warnings };
  }

  return {
    columnsAdded: [],
    indexesCreated: ['sprint_summary'],
    rowsUpdated: 0,
    alreadyCurrent: false,
    parkedAvailable: true,
    warnings,
  };
}
