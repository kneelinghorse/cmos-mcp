/**
 * Versioned blob migration system for master_context.
 *
 * Migrations are registered once in BLOB_MIGRATIONS and applied lazily on the
 * first cmos_context_view call after an upgrade. Each project self-heals on
 * first touch — no manual script, no per-project memory required.
 *
 * To add a future migration:
 *   1. Append a new entry to BLOB_MIGRATIONS with the next version number.
 *   2. Bump BLOB_SCHEMA_VERSION to match.
 *   Done. Existing projects migrate automatically on next read.
 *
 * Old migration entries are never removed — they are the changelog.
 * The version gate (`currentVersion >= migration.version`) makes them free
 * after they have applied.
 *
 * @module tools/cmos/blob-migrations
 */

import * as crypto from 'crypto';
import type { CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import { snapshotDedupPrunedFilter } from './schema-migrations';
import { checkWrite } from './write-guard';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Current latest blob schema version. Must match the highest version in BLOB_MIGRATIONS. */
export const BLOB_SCHEMA_VERSION = 1;

/** Metadata table key that stores the applied blob schema version per project. */
export const BLOB_SCHEMA_VERSION_KEY = 'blob_schema_version';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlobMigration {
  /** Monotonically increasing version number. Never reuse or skip. */
  version: number;
  /** Human-readable description used in logs and snapshot source labels. */
  description: string;
  /**
   * Pure transformation: blob in → blob out. No side effects.
   * Must not mutate the input — return a new object.
   */
  up: (blob: Record<string, unknown>) => Record<string, unknown>;
}

export interface BlobMigrationResult {
  /** Whether any migrations were applied. */
  migrated: boolean;
  /** Version numbers of each migration that ran, in order. */
  migrationsApplied: number[];
  /** The post-migration blob (equals input blob when migrated=false). */
  blob: Record<string, unknown>;
  /**
   * s86-m02b — DB errors from the migration's own writes (snapshot, blob write-back,
   * version bump). A half-applied migration must reach the caller's answer instead of
   * being inferred from `migrated: true`, which reports intent, not a persisted row.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

/**
 * Ordered list of all blob migrations.
 *
 * Rules:
 * - Append only. Never edit or remove an existing entry.
 * - version must be 1-indexed and strictly increasing.
 * - `up` must be a pure function (no side effects, no mutation of input).
 */
export const BLOB_MIGRATIONS: BlobMigration[] = [
  {
    version: 1,
    description:
      'Remove five duplicated sections from master_context blob (Sprint 51). ' +
      'completed_missions, completed_sprints, decisions_made, learnings, and recent_sessions ' +
      'are fully queryable from structured tables via HybridRetriever or direct SQL.',
    up: (blob) => {
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        completed_missions,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        completed_sprints,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        decisions_made,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        learnings,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        recent_sessions,
        ...rest
      } = blob;
      return rest;
    },
  },
  // Future migrations go here. Example:
  // {
  //   version: 2,
  //   description: 'Rename technical_context → stack_context (Sprint NN)',
  //   up: (blob) => {
  //     const { technical_context, ...rest } = blob;
  //     return { ...rest, stack_context: technical_context };
  //   },
  // },
];

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Read the current blob schema version from the metadata table.
 * Returns 0 (unversioned / legacy) if the key is absent or the table is missing.
 */
export function getBlobSchemaVersion(client: CmosDatabaseClient): number {
  const result = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    BLOB_SCHEMA_VERSION_KEY,
  ]);
  if (!result.success || !result.data) return 0;
  const parsed = parseInt(result.data.value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Persist the blob schema version in the metadata table.
 *
 * A failed bump leaves the store's blob transformed but its version stale, so the next
 * read re-runs the migration — the error is recorded into `warnings` rather than dropped.
 */
function setBlobSchemaVersion(
  client: CmosDatabaseClient,
  version: number,
  warnings: string[]
): void {
  checkWrite(
    client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
      BLOB_SCHEMA_VERSION_KEY,
      String(version),
    ]),
    warnings,
    `metadata.${BLOB_SCHEMA_VERSION_KEY} bump to v${version}`
  );
}

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

/**
 * Take a pre-migration snapshot of the raw blob content.
 * Skips silently if an identical snapshot already exists (content-hash dedup).
 */
function takePreMigrationSnapshot(
  client: CmosDatabaseClient,
  contextId: string,
  rawContent: string,
  migrationVersion: number,
  warnings: string[]
): void {
  const contentHash = crypto.createHash('sha256').update(rawContent).digest('hex').substring(0, 16);

  // Skip if identical snapshot already exists. s84-m04: exclude a content-tombstoned row
  // so identical content re-persists fresh instead of deduping onto the emptied row.
  const existing = client.getOne<{ id: number }>(
    `SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}`,
    [contextId, contentHash]
  );
  if (existing.success && existing.data) return;

  const now = new Date().toISOString();
  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  checkWrite(
    client.execute(
      `INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
      [
        contextId,
        null,
        `pre-migration: blob-schema-v${migrationVersion}`,
        contentHash,
        rawContent,
        now,
        ...g.values,
      ]
    ),
    warnings,
    `context_snapshots pre-migration snapshot (blob-schema-v${migrationVersion})`
  );
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply any pending blob migrations to master_context.
 *
 * Behaviour:
 * - Only runs for contextId === 'master_context'. All other contexts are no-ops.
 * - Reads blob_schema_version from metadata. If current, returns immediately.
 * - If migrations are pending:
 *     1. Takes a pre-migration snapshot (snapshot-protected, hash-deduped).
 *     2. Applies each pending migration's `up()` in version order.
 *     3. Writes the pruned blob back to the contexts table.
 *     4. Bumps blob_schema_version in metadata.
 * - Idempotent: a second call on the same DB is always a no-op.
 *
 * @param client   Open database client (write access required)
 * @param contextId  Context row ID (e.g. 'master_context')
 * @param rawContent Raw JSON string from the contexts table (pre-parse)
 * @param parsedBlob Already-parsed blob object
 * @returns BlobMigrationResult — includes the (possibly updated) blob
 */
export function applyPendingBlobMigrations(
  client: CmosDatabaseClient,
  contextId: string,
  rawContent: string,
  parsedBlob: Record<string, unknown>
): BlobMigrationResult {
  // Only master_context carries the dead sections
  if (contextId !== 'master_context') {
    return { migrated: false, migrationsApplied: [], blob: parsedBlob, warnings: [] };
  }

  const currentVersion = getBlobSchemaVersion(client);
  const pending = BLOB_MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return { migrated: false, migrationsApplied: [], blob: parsedBlob, warnings: [] };
  }

  // s86-m02b: every write below reports through this sink, so a half-applied migration
  // is disclosed rather than reported as a clean `migrated: true`.
  const warnings: string[] = [];

  // Snapshot before any writes (using the highest pending version as the label)
  const targetVersion = Math.max(...pending.map((m) => m.version));
  takePreMigrationSnapshot(client, contextId, rawContent, targetVersion, warnings);

  // Apply each pending migration in version order
  let result = parsedBlob;
  const applied: number[] = [];
  for (const migration of pending) {
    result = migration.up(result);
    applied.push(migration.version);
  }

  // Write pruned blob back to contexts table
  const newContent = JSON.stringify(result);
  const now = new Date().toISOString();
  checkWrite(
    client.execute('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?', [
      newContent,
      now,
      contextId,
    ]),
    warnings,
    `contexts.content blob write-back (${contextId}, blob-schema-v${targetVersion})`
  );

  // Bump version in metadata
  setBlobSchemaVersion(client, targetVersion, warnings);

  return { migrated: true, migrationsApplied: applied, blob: result, warnings };
}
