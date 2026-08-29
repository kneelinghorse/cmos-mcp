// ABOUTME: Sprint 69 m05 — the per-user project-graph registry (s68 ADR Section 3).
// ABOUTME: A lightweight SQLite map project_id → store metadata for dynamic store discovery.

/**
 * ProjectGraphRegistry — per-USER SQLite registry mapping `project_id` → store
 * metadata (s68 ADR Section 3). It is the precondition for the cross-store
 * fan-out read path (s69-m06) and the future App-View polling Relay: instead of
 * a filesystem scan on every poll, the Relay/fan-out reads this indexed map to
 * learn which per-project stores exist and where.
 *
 * **Scope: per-user, NOT per-project.** One file holds every project the user
 * owns. It lives at `<configDir>/project-graph.sqlite`, where `configDir`
 * resolves as: explicit option → `CMOS_CONFIG_DIR` env → `~/.config/cmos-mcp`. The ADR sketch
 * said `~/.cmos/`, but deferring to the codebase's established config-dir pattern
 * (a) keeps all per-user CMOS state in one place and (b) makes test runs
 * automatically isolated (Jest globalSetup points `CMOS_CONFIG_DIR` at a tmpdir).
 *
 * **Keyed by `project_id`** (the per-project store's `metadata.project_id`), NOT
 * by filesystem path — the cross-store layer keys on `project_id` (it is the leading
 * aggregation key per the ADR), and a store can be moved on disk without losing its
 * identity.
 *
 * **Soft-delete via `archived_at`** because operators occasionally delete project
 * DBs from disk without de-registering. Archived rows skip the future Relay poll
 * but remain restorable via `unarchive` (a one-row UPDATE); `list()` hides them
 * unless `includeArchived` is passed.
 *
 * **Concurrency:** multiple MCP-server processes (one per Claude Code session)
 * share this one file and all write `last_seen_at`. WAL mode + a `busy_timeout`
 * make concurrent writers wait-and-retry rather than error; each `touch` is a
 * single atomic UPDATE (last-writer-wins on `last_seen_at`, which is the intended
 * semantic), so there are no lost updates.
 *
 * @module intelligence/project-graph-registry
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensureDir } from '../utils/fs';
import { isReadOnlyAgentSession } from '../tools/cmos/read-only-agent-guard';
import { currentToolCallActionMode } from '../tools/cmos/tool-call-context';

/**
 * s86-m01 — write the one diagnostic this module emits (the registration-collision
 * refusal in {@link ProjectGraphRegistry.register}) straight to fd 2 rather than
 * through the global console object.
 *
 * This site has its OWN rationale, distinct from the checkpoint modules: it is
 * genuinely reachable from the fire-and-forget checkpoint IIFE, and the chain is
 * short — checkpoint-backfill.ts `await ProjectGraphRegistry.create()` →
 * `create()` runs `maybeBackfill()` and `maybeIdentityBackfill()`, each of which
 * calls `register()`, which reaches the refusal below. Both backfills are
 * marker-gated (one-shot per registry file), so the reach is real but rare — which
 * is exactly the profile of a late log that shows up as an intermittent CI exit 1
 * rather than a reproducible failure. A plan-time critic asserted this site is not
 * on the detached path; that assertion is refuted by the chain above.
 *
 * Guarded by tests/tools/cmos/detached-log-gate.test.ts Arm A.
 */
function log(line: string): void {
  process.stderr.write(line + '\n');
}

/** Compare roots by physical location when they exist, falling back to absolute spelling. */
function physicalStorePath(storePath: string): string {
  const resolved = path.resolve(storePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isSameStorePath(left: string, right: string): boolean {
  return physicalStorePath(left) === physicalStorePath(right);
}

/**
 * Override the default `~/.config/cmos-mcp` config directory. When set (and no
 * explicit `configDir` option is passed), the registry reads/writes here instead
 * of the user's home-config path. Used by Jest globalSetup to keep test runs from
 * polluting the real registry. (s80-m02: moved here from the deleted JSON
 * `project-registry.ts` — this is now the single owner of the config-dir contract.)
 */
export const CMOS_CONFIG_DIR_ENV = 'CMOS_CONFIG_DIR';

/**
 * Current schema version stamped on each row + in registry_meta.
 * v2 (s81-m03): added the nullable `last_synced_at` column (last dashboard-converged
 * push time, ms). The registry has no migration mechanism (ensureSchema is
 * CREATE IF NOT EXISTS only), so v1→v2 is an explicit, column-existence-guarded ALTER
 * (see {@link ProjectGraphRegistry.ensureLastSyncedColumn}) — safe when older 2.1.0
 * sibling dists share the WAL file (the column is nullable, so their column-listed
 * register() INSERT that omits it still works).
 */
export const PROJECT_GRAPH_SCHEMA_VERSION = 2;

/** Busy timeout (ms) so concurrent writers from sibling MCP processes wait. */
const BUSY_TIMEOUT_MS = 5000;

/** registry_meta key set once the s69-m05 one-time backfill has run. */
const BACKFILL_MARKER_KEY = 'backfill_done';

/**
 * registry_meta key set once the s79-m01 identity backfill has run. SEPARATE from
 * {@link BACKFILL_MARKER_KEY}: existing operators already have that marker set, so
 * the s69 backfill is a no-op for them — but the identity/default compatibility
 * migration still needs its own exactly-once marker. Since s88-m08 it skips id-less stores.
 */
const IDENTITY_BACKFILL_MARKER_KEY = 'identity_backfill_done';

/**
 * registry_meta key holding the authoritative default project's `project_id`
 * (s79-m01, F1). The graph's answer to the JSON registry's `defaultProject`.
 */
const DEFAULT_PROJECT_META_KEY = 'default_project_id';

/** Legacy default path waiting for its store to receive a durable project_id. */
const PENDING_LEGACY_DEFAULT_PATH_META_KEY = 'pending_legacy_default_store_path';

/** A row in the project-graph registry. Timestamps are Unix epoch milliseconds. */
export interface ProjectGraphEntry {
  /** ULID/slug — matches the per-project store's metadata.project_id. */
  project_id: string;
  /** Absolute path to the project ROOT (the dir containing cmos/db/cmos.sqlite). */
  store_path: string;
  /** Human-readable project name. */
  name: string;
  /** When first registered (Unix ms). */
  registered_at: number;
  /** Updated on registration or an explicit eligible touch (Unix ms). */
  last_seen_at: number;
  /** Per-row schema version. */
  schema_version: number;
  /** Soft-delete timestamp (Unix ms); null = active. */
  archived_at: number | null;
  /**
   * s81-m03 — last time THIS machine converged a dashboard push for the project (Unix
   * ms). Written by {@link ProjectGraphRegistry.updateLastSynced} on a successful
   * checkpoint file-sync. null = never pushed from this machine (pre-v2 rows, or
   * never-synced) → the drift reader treats it as no-signal (never a false positive).
   */
  last_synced_at: number | null;
}

/** Upsert payload for {@link ProjectGraphRegistry.register}. */
export interface ProjectGraphRegisterInput {
  project_id: string;
  store_path: string;
  name: string;
}

/** Options for config-dir override + test isolation. */
export interface ProjectGraphRegistryOptions {
  /** Override config directory (default: CMOS_CONFIG_DIR env → ~/.config/cmos-mcp). */
  configDir?: string;
  /** Override registry filename (default: project-graph.sqlite). */
  registryFilename?: string;
  /** Injectable clock for deterministic tests (default: Date.now). */
  now?: () => number;
}

interface MetaRow {
  value: string;
}

/**
 * Per-user project-graph registry — the single discovery source (s80-m02). A
 * singleton + async `create()` lifecycle; the config dir resolves via the
 * `CMOS_CONFIG_DIR` seam so test runs stay isolated.
 */
export class ProjectGraphRegistry {
  private static instance?: ProjectGraphRegistry;

  private readonly configDir: string;
  private readonly registryPath: string;
  private readonly now: () => number;
  private db: Database.Database | null = null;

  private constructor(options: ProjectGraphRegistryOptions = {}) {
    this.configDir =
      options.configDir ??
      process.env[CMOS_CONFIG_DIR_ENV] ??
      path.join(os.homedir(), '.config', 'cmos-mcp');
    const filename = options.registryFilename ?? 'project-graph.sqlite';
    this.registryPath = path.join(this.configDir, filename);
    this.now = options.now ?? Date.now;
  }

  /** Singleton accessor. */
  static getInstance(options?: ProjectGraphRegistryOptions): ProjectGraphRegistry {
    if (!ProjectGraphRegistry.instance) {
      ProjectGraphRegistry.instance = new ProjectGraphRegistry(options);
    }
    return ProjectGraphRegistry.instance;
  }

  /** Reset singleton (closes the open connection) — for tests. */
  static resetInstance(): void {
    if (ProjectGraphRegistry.instance) {
      ProjectGraphRegistry.instance.close();
    }
    ProjectGraphRegistry.instance = undefined;
  }

  /**
   * Async factory: ensure the config dir + schema exist, then, outside read/review calls, run the
   * one-time legacy-registry backfills (marker-gated, so they no-op after first completion).
   */
  static async create(options?: ProjectGraphRegistryOptions): Promise<ProjectGraphRegistry> {
    const registry = ProjectGraphRegistry.getInstance(options);
    await ensureDir(registry.configDir);
    registry.ensureSchema();
    // Legacy import is a compatibility WRITE. A read-classified/review call may open and query
    // the graph schema, but must neither consume the one-shot markers nor add legacy rows. The
    // first later write/direct administrative open performs the deferred migration.
    if (currentToolCallActionMode() !== 'read' && !isReadOnlyAgentSession()) {
      await registry.maybeBackfill();
      await registry.maybeIdentityBackfill();
    }
    return registry;
  }

  /** Absolute path to the registry SQLite file. */
  get path(): string {
    return this.registryPath;
  }

  /** Open (lazily) the registry DB with WAL + busy_timeout and ensure the schema. */
  private connection(): Database.Database {
    if (this.db) return this.db;
    // Arm the busy handler via the CONSTRUCTOR option, not a later pragma: the
    // `journal_mode = WAL` flip below briefly takes an exclusive lock (and creates
    // the -wal/-shm sidecars on first open), which is the most likely point to
    // contend with a sibling MCP-server process opening the same file at session
    // start. If the timeout were armed only by a pragma AFTER the flip, that flip
    // would throw SQLITE_BUSY immediately instead of waiting. Mirrors the
    // convention in client.ts (constructor timeout, then WAL).
    const db = new Database(this.registryPath, { timeout: BUSY_TIMEOUT_MS });
    db.pragma('journal_mode = WAL');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`); // redundant w/ constructor; kept explicit
    this.db = db;
    return db;
  }

  /** Create the projects + registry_meta tables if absent. Idempotent. */
  private ensureSchema(): void {
    const db = this.connection();
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id     TEXT PRIMARY KEY,
        store_path     TEXT NOT NULL,
        name           TEXT NOT NULL,
        registered_at  INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT ${PROJECT_GRAPH_SCHEMA_VERSION},
        archived_at    INTEGER,
        last_synced_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects (last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects (archived_at);
      CREATE TABLE IF NOT EXISTS registry_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // v1→v2 migration for registries created before s81-m03 (the CREATE above no-ops on
    // an existing table, so a v1 registry would never gain the column without this).
    this.ensureLastSyncedColumn();
  }

  /**
   * s81-m03 — the v1→v2 registry migration: add the nullable `last_synced_at` column
   * when absent. The registry has NO general migration mechanism (ensureSchema is
   * CREATE IF NOT EXISTS only), so this explicit, column-existence-guarded ALTER is the
   * bump. Idempotent + race-safe: a concurrent sibling MCP process may add the column
   * between our PRAGMA check and the ALTER (SQLITE 'duplicate column name'); that (and
   * any other ALTER failure) is swallowed so registry open never fails — if the column
   * still doesn't exist, `updateLastSynced` no-ops and the drift reader sees no-signal.
   * Safe under concurrent older 2.1.0 dists: the column is nullable with no default, so
   * their column-listed register() INSERT (which omits it) keeps working.
   */
  private ensureLastSyncedColumn(): void {
    const db = this.connection();
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'last_synced_at')) return;
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN last_synced_at INTEGER`);
    } catch {
      // Idempotent/race-safe: a concurrent sibling won the ALTER, or the ALTER failed;
      // either way registry open must not fail. no-signal (NULL) is the safe degrade.
    }
  }

  /**
   * Insert or update a project. On conflict (project_id exists) it refreshes
   * `store_path`, `name`, and `last_seen_at` (a moved/renamed store updates in
   * place) and clears `archived_at` (re-registering un-archives). Returns the row.
   *
   * **Collision guard (s79-m01, F2):** a second store claiming an existing
   * `project_id` from a DIFFERENT path is refused-and-logged **only when** the
   * incumbent path still resolves to that same id (i.e. a live store is genuinely
   * holding it — two projects colliding on a shared slug). The two legitimate
   * same-id-different-path cases update cleanly: a **moved** store (the incumbent
   * path no longer resolves the id) and a **re-touch** from the same path. This
   * replaces the old silent `ON CONFLICT` `store_path` overwrite, which would
   * collapse two colliding projects into one row.
   */
  register(input: ProjectGraphRegisterInput): ProjectGraphEntry {
    const db = this.connection();
    const now = this.now();
    const resolvedPath = path.resolve(input.store_path);
    const incumbent = this.get(input.project_id);

    if (incumbent && !isSameStorePath(incumbent.store_path, resolvedPath)) {
      // A different path is claiming an id that already has a row. Distinguish a
      // genuine collision (incumbent is still a live store holding this id) from
      // a legitimate move (incumbent path no longer resolves the id).
      const incumbentIdentity = readStoreIdentity(incumbent.store_path);
      if (incumbentIdentity?.project_id === input.project_id) {
        log(
          `[CMOS] project-graph collision refused: project_id '${input.project_id}' is held by ` +
            `live store '${incumbent.store_path}'; ignoring conflicting registration from ` +
            `'${resolvedPath}'. Re-key one of the two projects (metadata.project_id) to resolve.`
        );
        return incumbent;
      }
      // else: incumbent path is gone/re-keyed → the store moved → update below.
    }

    db.prepare(
      `INSERT INTO projects (project_id, store_path, name, registered_at, last_seen_at, schema_version, archived_at)
       VALUES (@project_id, @store_path, @name, @now, @now, @schema_version, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         store_path   = excluded.store_path,
         name         = excluded.name,
         last_seen_at = excluded.last_seen_at,
         archived_at  = NULL`
    ).run({
      project_id: input.project_id,
      store_path: resolvedPath,
      name: input.name,
      now,
      schema_version: PROJECT_GRAPH_SCHEMA_VERSION,
    });
    // Non-null: we just inserted/updated this id.
    return this.get(input.project_id) as ProjectGraphEntry;
  }

  /** Hard-delete a project row. Returns true if a row was removed. */
  unregister(projectId: string): boolean {
    const db = this.connection();
    const info = db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
    return info.changes > 0;
  }

  /** Fetch one project by id (including archived). Undefined if absent. */
  get(projectId: string): ProjectGraphEntry | undefined {
    const db = this.connection();
    const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as
      | ProjectGraphEntry
      | undefined;
    return row;
  }

  /**
   * Resolve a store ROOT path to its `project_id` (s79-m01) — the inverse of the
   * `project_id`-keyed table, so path-keyed callers (e.g. `resolveProjectRoot`'s
   * JSON compat layer, the m02 derivation writer) can repoint onto the graph.
   * The input is resolved before lookup; returns null if no row matches.
   */
  getByStorePath(storePath: string): string | null {
    const db = this.connection();
    const resolvedPath = path.resolve(storePath);
    const row = db
      .prepare('SELECT project_id FROM projects WHERE store_path = ?')
      .get(resolvedPath) as { project_id: string } | undefined;
    if (row) return row.project_id;

    // macOS commonly exposes one temp root as both /var/... and /private/var/...;
    // symlinked workspaces are equivalent. Compare physical roots only after the indexed hit.
    const candidates = db.prepare('SELECT project_id, store_path FROM projects').all() as Array<{
      project_id: string;
      store_path: string;
    }>;
    return (
      candidates.find((candidate) => isSameStorePath(candidate.store_path, resolvedPath))
        ?.project_id ?? null
    );
  }

  /**
   * The authoritative default project (s79-m01, F1) — the graph's answer to the
   * JSON registry's `defaultProject`. Reads `registry_meta.default_project_id` and
   * resolves the row; returns null when unset or the referenced project is gone.
   */
  getDefault(): ProjectGraphEntry | null {
    const id = this.readMeta(DEFAULT_PROJECT_META_KEY);
    if (!id) return null;
    return this.get(id) ?? null;
  }

  /**
   * Set the default project by `project_id`. Refuses (returns false) when the id
   * is not registered — mirrors `ProjectRegistry.setDefault`, which won't point
   * the default at an unknown project.
   */
  setDefault(projectId: string): boolean {
    if (!this.get(projectId)) return false;
    this.writeMeta(DEFAULT_PROJECT_META_KEY, projectId);
    return true;
  }

  /** Clear the default project (removes the `registry_meta` key). */
  clearDefault(): void {
    const db = this.connection();
    db.prepare('DELETE FROM registry_meta WHERE key = ?').run(DEFAULT_PROJECT_META_KEY);
  }

  /**
   * List projects, active-only by default. Pass `{ includeArchived: true }` to
   * include soft-deleted rows (for restore UIs). Ordered by `last_seen_at` DESC.
   */
  list(opts: { includeArchived?: boolean } = {}): ProjectGraphEntry[] {
    const db = this.connection();
    const where = opts.includeArchived ? '' : 'WHERE archived_at IS NULL';
    return db
      .prepare(`SELECT * FROM projects ${where} ORDER BY last_seen_at DESC`)
      .all() as ProjectGraphEntry[];
  }

  /**
   * Update `last_seen_at` for a project — the highest-frequency write (session
   * open). A single atomic UPDATE; last-writer-wins is the intended semantic.
   * Returns false if the project is not registered.
   */
  touch(projectId: string): boolean {
    const db = this.connection();
    const info = db
      .prepare('UPDATE projects SET last_seen_at = ? WHERE project_id = ?')
      .run(this.now(), projectId);
    return info.changes > 0;
  }

  /**
   * s81-m03 — record the last dashboard-converged push time for a project (Unix ms).
   * A single atomic UPDATE (like {@link touch}), last-writer-wins. Ensures the v2
   * column exists first (idempotent), so it works even if `create()` was never called
   * on this instance. Returns false when the project has no row on THIS machine — the
   * caller no-ops safely, leaving `last_synced_at` NULL (no-signal for the drift reader).
   *
   * Callers on the checkpoint/push hot path MUST wrap this: a registry lock/ALTER/UPDATE
   * error must NEVER fail a checkpoint (this is the only registry write on the push path,
   * which imported the registry zero times before s81-m03).
   */
  updateLastSynced(projectId: string, syncedAt: number): boolean {
    this.ensureLastSyncedColumn();
    const db = this.connection();
    const info = db
      .prepare('UPDATE projects SET last_synced_at = ? WHERE project_id = ?')
      .run(syncedAt, projectId);
    return info.changes > 0;
  }

  /**
   * s79-m03 — archive every ACTIVE row whose store's `cmos/db/cmos.sqlite` no
   * longer exists on disk (operators delete project DBs without de-registering).
   * Archive (soft) rather than hard-delete keeps the row recoverable; a later
   * re-register/touch un-archives it. Returns the number archived. Powers the
   * boot-time prune + `cmos_project validate(prune=true)`. (s80-m02: no JSON mirror
   * to re-derive afterward — the graph is the single source.)
   */
  pruneMissingStores(): number {
    let pruned = 0;
    for (const row of this.list()) {
      const dbPath = path.join(row.store_path, 'cmos', 'db', 'cmos.sqlite');
      if (!existsSync(dbPath) && this.archive(row.project_id)) pruned++;
    }
    return pruned;
  }

  /** Soft-delete: set `archived_at`. Returns false if absent or already archived. */
  archive(projectId: string): boolean {
    const db = this.connection();
    const info = db
      .prepare('UPDATE projects SET archived_at = ? WHERE project_id = ? AND archived_at IS NULL')
      .run(this.now(), projectId);
    return info.changes > 0;
  }

  /** Restore a soft-deleted project (clear `archived_at`). Returns false if absent or active. */
  unarchive(projectId: string): boolean {
    const db = this.connection();
    const info = db
      .prepare(
        'UPDATE projects SET archived_at = NULL WHERE project_id = ? AND archived_at IS NOT NULL'
      )
      .run(projectId);
    return info.changes > 0;
  }

  /**
   * Integration helper for compatibility/discovery migrations: read the
   * store's identity (metadata.project_id + project_name) from `storePath` (the
   * project ROOT) and upsert it. Returns the row, or null when the store has no
   * readable project_id (nothing to key on). Best-effort: never throws.
   */
  touchOrRegisterFromStore(storePath: string): ProjectGraphEntry | null {
    const identity = readStoreIdentity(storePath);
    if (!identity) return null;
    return this.register({
      project_id: identity.project_id,
      store_path: storePath,
      name: identity.name,
    });
  }

  /**
   * s79-m02 — the authoritative registration primitive for discovery-write
   * handlers (`cmos_project` init/register and write-client registration). Give
   * the store a STABLE project_id and upsert it. Id resolution, in order:
   *   1. reuse the id an already-registered row at this path holds (stable across
   *      re-registration, even when the store DB is momentarily unreadable);
   *   2. `mintProjectId` — a readable store keeps its existing id or gets a minted
   *      UUID written into `metadata.project_id`;
   *   3. a slug of the basename — the degenerate fallback for a store whose DB is
   *      unreadable/invalid (it cannot be a portfolio member, but stays tracked
   *      rather than being dropped).
   * (s80-m02: the graph is the single source — no JSON mirror to re-materialize.)
   */
  registerStore(
    projectRoot: string,
    opts: { name?: string; setAsDefault?: boolean; requireStoredIdentity?: boolean } = {}
  ): ProjectGraphEntry {
    const resolved = path.resolve(projectRoot);
    const existingGraphId = this.getByStorePath(resolved);
    // When an existing graph row outlived an accidentally-cleared metadata row, restore that
    // SAME id rather than minting a replacement. Otherwise two first writers generate their own
    // candidates and the conditional UPSERT in mintProjectId makes both observe one winner.
    const storedProjectId = mintProjectId(resolved, existingGraphId ?? undefined);
    if (opts.requireStoredIdentity && !storedProjectId) {
      throw new Error(
        `Unable to persist a project identity in ${path.join(resolved, 'cmos', 'db', 'cmos.sqlite')}`
      );
    }
    if (
      opts.requireStoredIdentity &&
      existingGraphId &&
      storedProjectId &&
      storedProjectId !== existingGraphId
    ) {
      throw new Error(
        `Stored project identity '${storedProjectId}' conflicts with graph identity ` +
          `'${existingGraphId}' for ${resolved}`
      );
    }
    const projectId = existingGraphId ?? storedProjectId ?? slugifyName(path.basename(resolved));
    const identity = readStoreIdentity(resolved);
    const name = opts.name ?? identity?.name ?? path.basename(resolved);
    const entry = this.register({ project_id: projectId, store_path: resolved, name });
    if (entry.project_id !== projectId || !isSameStorePath(entry.store_path, resolved)) {
      throw new Error(
        `Project identity collision: '${projectId}' is already registered to ` +
          `'${entry.store_path}', so '${resolved}' was not registered.`
      );
    }

    const pendingLegacyDefault = this.readMeta(PENDING_LEGACY_DEFAULT_PATH_META_KEY);
    const restoresLegacyDefault =
      pendingLegacyDefault !== null && isSameStorePath(pendingLegacyDefault, resolved);
    if (opts.setAsDefault || restoresLegacyDefault) {
      this.setDefault(entry.project_id);
      // An explicit replacement default supersedes any deferred legacy pointer; registering the
      // deferred path consumes it. Either way it must not override a later operator choice.
      if (pendingLegacyDefault !== null) {
        this.connection()
          .prepare('DELETE FROM registry_meta WHERE key = ?')
          .run(PENDING_LEGACY_DEFAULT_PATH_META_KEY);
      }
    }
    return entry;
  }

  /**
   * s79-m02 — hard-remove a store by its ROOT path (the authoritative counterpart
   * to `cmos_project unregister`). Clears the default when the removed project was
   * it. Returns whether a row was removed + whether it had been the default.
   * (s80-m02: the graph is the single source — no JSON mirror to re-derive.)
   */
  unregisterStore(projectRoot: string): { removed: boolean; wasDefault: boolean } {
    const projectId = this.getByStorePath(projectRoot);
    if (!projectId) return { removed: false, wasDefault: false };
    const wasDefault = this.getDefault()?.project_id === projectId;
    this.unregister(projectId);
    if (wasDefault) this.clearDefault();
    return { removed: true, wasDefault };
  }

  // s80-m02: `deriveJson()` (the project-registry.json re-materialization) was
  // deleted along with the JSON `ProjectRegistry` — the graph is the genuine single
  // discovery source, so there is no mirror to keep in sync. The one-time backfills
  // below still READ the legacy JSON (via `readLegacyJsonRegistry`) to migrate
  // pre-s80 operators, but nothing WRITES it any more.

  /** Close the underlying connection. Safe to call repeatedly. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Read one `registry_meta` value (null if absent). */
  private readMeta(key: string): string | null {
    const db = this.connection();
    const row = db.prepare('SELECT value FROM registry_meta WHERE key = ?').get(key) as
      | MetaRow
      | undefined;
    return row?.value ?? null;
  }

  /** Upsert one `registry_meta` value. */
  private writeMeta(key: string, value: string): void {
    const db = this.connection();
    db.prepare('INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /**
   * One-time compatibility backfill so operators with projects from before s69-m05 don't have
   * to re-register. Marker-gated (registry_meta.backfill_done): runs once from a non-read context,
   * then fast-no-ops. Reads the deleted registry system's JSON artifact as a finite migration
   * input and imports only stores that already record metadata.project_id/project_name. Gone,
   * unreadable, and identity-less stores are skipped silently; no filesystem walk is performed.
   */
  private async maybeBackfill(): Promise<void> {
    const db = this.connection();
    const marker = db
      .prepare('SELECT value FROM registry_meta WHERE key = ?')
      .get(BACKFILL_MARKER_KEY) as MetaRow | undefined;
    if (marker) return;

    try {
      // Read the legacy project-registry.json ONCE (if it still exists) against the
      // SAME configDir as this graph — otherwise an explicit `configDir` (tests,
      // custom callers) would read a DIFFERENT directory than the one it populates,
      // pulling in unrelated projects. In production both resolve to the env/default
      // dir, so this is a no-op there. (s80-m02: raw file read via
      // readLegacyJsonRegistry — the JSON ProjectRegistry class is deleted.)
      const legacy = readLegacyJsonRegistry(this.configDir);
      for (const proj of legacy?.projects ?? []) {
        const identity = readStoreIdentity(proj.projectRoot);
        if (!identity) continue;
        // Don't clobber a row already present (e.g. registered between create
        // calls); keep the first registration's timestamps.
        if (this.get(identity.project_id)) continue;
        this.register({
          project_id: identity.project_id,
          store_path: proj.projectRoot,
          name: identity.name,
        });
      }
    } catch {
      // Backfill is best-effort; never block registry availability on it. The
      // marker is still set so we don't re-scan on every open. A missed store stays absent until
      // an explicit/write registration path adds it; read-classified cmos_review never does.
    } finally {
      db.prepare('INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)').run(
        BACKFILL_MARKER_KEY,
        String(this.now())
      );
    }
  }

  /**
   * s79-m01 identity backfill (marker-gated, SEPARATE marker), narrowed by s88-m08.
   * Walk every JSON-known store and migrate stores that ALREADY record an identity plus the
   * legacy default pointer. An identity-less store is skipped: opening the discovery registry is
   * a read/compatibility path, not an operator registration, and must never mint into a project
   * store. Explicit write registration handles those stores later. Best-effort and run-once.
   */
  private async maybeIdentityBackfill(): Promise<void> {
    if (this.readMeta(IDENTITY_BACKFILL_MARKER_KEY)) return;

    try {
      // Same-configDir resolution as maybeBackfill (see its rationale). s80-m02:
      // raw legacy-JSON read; nothing writes the JSON any more.
      const legacy = readLegacyJsonRegistry(this.configDir);
      for (const proj of legacy?.projects ?? []) {
        const identity = readStoreIdentity(proj.projectRoot);
        if (!identity) continue; // registration, not a registry read, owns identity minting
        const projectId = identity.project_id;
        if (this.get(projectId)) continue; // already present (e.g. s69 backfill)
        this.register({
          project_id: projectId,
          store_path: proj.projectRoot,
          name: identity.name,
        });
      }

      // Migrate the legacy JSON default → graph default (a DATA migration, not
      // behavior-only). If it is still identity-less, retain the path so the later authoritative
      // registration can promote the minted row instead of losing the operator's old default.
      const jsonDefaultPath = legacy?.defaultProject;
      if (jsonDefaultPath) {
        const defaultId =
          readStoreIdentity(jsonDefaultPath)?.project_id ?? this.getByStorePath(jsonDefaultPath);
        if (defaultId) {
          this.setDefault(defaultId);
          this.connection()
            .prepare('DELETE FROM registry_meta WHERE key = ?')
            .run(PENDING_LEGACY_DEFAULT_PATH_META_KEY);
        } else {
          this.writeMeta(PENDING_LEGACY_DEFAULT_PATH_META_KEY, path.resolve(jsonDefaultPath));
        }
      }
    } catch {
      // Best-effort — mirror maybeBackfill: never block availability on it.
    } finally {
      this.writeMeta(IDENTITY_BACKFILL_MARKER_KEY, String(this.now()));
    }
  }
}

/** The shape the graph backfills need from the legacy `project-registry.json`. */
interface LegacyJsonRegistry {
  /** Known project roots (path + optional display name). */
  projects: Array<{ projectRoot: string; name?: string }>;
  /** Absolute path of the legacy default project, if one was set. */
  defaultProject?: string;
}

/**
 * s80-m02 (Fork F1=A) — read the legacy `project-registry.json` ONCE, if present,
 * WRITING NOTHING. This is the ~10-line replacement for the deleted JSON
 * `ProjectRegistry` class that preserves the v1.x→s80 migration: the two one-time
 * marker-gated backfills consume it to seed the graph (known project roots) and to
 * migrate the default-project pointer. Best-effort: returns null on absent file or
 * any parse error (a corrupt legacy file must never block registry availability).
 *
 * **Module-private on purpose** (s80-m02 review): NOT exported, so no other src file can turn the
 * legacy JSON into a live discovery source (the split-brain this sprint deleted). The file is a
 * read-only, one-time compatibility input until the marker-gated import runs; it is never written
 * and is not consulted afterward. Operators may safely delete it after migration (deleting it
 * earlier means its projects/default may need explicit re-registration).
 *
 * @param configDir the config dir holding `project-registry.json`.
 */
function readLegacyJsonRegistry(configDir: string): LegacyJsonRegistry | null {
  try {
    const file = path.join(configDir, 'project-registry.json');
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      defaultProject?: string;
      projects?: Record<string, { projectRoot?: string; name?: string }>;
    };
    const projects = Object.values(parsed.projects ?? {})
      .filter(
        (p): p is { projectRoot: string; name?: string } => typeof p?.projectRoot === 'string'
      )
      .map((p) => ({ projectRoot: p.projectRoot, name: p.name }));
    return { projects, defaultProject: parsed.defaultProject };
  } catch {
    return null;
  }
}

/**
 * Read a per-project store's identity (project_id + display name) from its
 * `metadata` table, opening the SQLite read-only. Returns null when the DB is
 * absent, unreadable, or carries no non-empty project_id. Never throws.
 *
 * @param storePath absolute path to the project ROOT (cmos/db/cmos.sqlite under it).
 */
export function readStoreIdentity(storePath: string): { project_id: string; name: string } | null {
  const dbPath = path.join(storePath, 'cmos', 'db', 'cmos.sqlite');
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    const idRow = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
      | MetaRow
      | undefined;
    const projectId = idRow?.value?.trim();
    if (!projectId) return null;
    const nameRow = db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get() as
      | MetaRow
      | undefined;
    const name = nameRow?.value?.trim() || path.basename(path.resolve(storePath));
    return { project_id: projectId, name };
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

/**
 * Ensure a per-project store has a stable `metadata.project_id`, minting a UUID
 * only where one is absent (s79-m01). Mirrors `cmos_project init` (`randomUUID`)
 * — an existing id (slug OR UUID) is returned untouched (never churned; the
 * dashboard keys on slugs). Returns the resolved/minted id, or null when the
 * store DB is absent/unreadable. Opens the store read-WRITE only to insert.
 *
 * @param storePath absolute path to the project ROOT (cmos/db/cmos.sqlite under it).
 */
/** Derive a stable slug id from a name/basename (degenerate unreadable-store fallback). */
function slugifyName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-') || 'project';
}

export function mintProjectId(storePath: string, preferredId?: string): string | null {
  const dbPath = path.join(storePath, 'cmos', 'db', 'cmos.sqlite');
  if (!existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    const idRow = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
      | MetaRow
      | undefined;
    const existing = idRow?.value?.trim();
    if (existing) return existing; // never churn an existing id
    const minted = preferredId ?? randomUUID();
    // One conditional UPSERT, rather than SELECT + unconditional REPLACE. Two MCP processes can
    // observe the same blank row concurrently; the first committed UUID wins and the second must
    // not overwrite it. Re-read the persisted winner after the statement.
    db.prepare(
      `INSERT INTO metadata (key, value) VALUES ('project_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE TRIM(COALESCE(metadata.value, '')) = ''`
    ).run(minted);
    const persisted = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
      | MetaRow
      | undefined;
    return persisted?.value?.trim() || null;
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}
