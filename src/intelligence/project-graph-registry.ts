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
 * resolves exactly like {@link ProjectRegistry} (the existing JSON registry):
 * explicit option → `CMOS_CONFIG_DIR` env → `~/.config/cmos-mcp`. The ADR sketch
 * said `~/.cmos/`, but deferring to the codebase's established config-dir pattern
 * (a) keeps all per-user CMOS state in one place and (b) makes test runs
 * automatically isolated (Jest globalSetup points `CMOS_CONFIG_DIR` at a tmpdir).
 *
 * **Keyed by `project_id`** (the per-project store's `metadata.project_id`), NOT
 * by filesystem path the way `ProjectRegistry` is — the cross-store layer keys on
 * `project_id` (it is the leading aggregation key per the ADR), and a store can be
 * moved on disk without losing its identity.
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
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensureDir } from '../utils/fs';
import { CMOS_CONFIG_DIR_ENV, ProjectRegistry } from './project-registry';

/** Current schema version stamped on each row + in registry_meta. */
export const PROJECT_GRAPH_SCHEMA_VERSION = 1;

/** Busy timeout (ms) so concurrent writers from sibling MCP processes wait. */
const BUSY_TIMEOUT_MS = 5000;

/** registry_meta key set once the one-time backfill has run. */
const BACKFILL_MARKER_KEY = 'backfill_done';

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
  /** Updated on every CMOS-MCP open / register (Unix ms). */
  last_seen_at: number;
  /** Per-row schema version. */
  schema_version: number;
  /** Soft-delete timestamp (Unix ms); null = active. */
  archived_at: number | null;
}

/** Upsert payload for {@link ProjectGraphRegistry.register}. */
export interface ProjectGraphRegisterInput {
  project_id: string;
  store_path: string;
  name: string;
}

/** Options mirroring {@link ProjectRegistry} for config-dir override + test isolation. */
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
 * Per-user project-graph registry. Mirrors {@link ProjectRegistry}'s singleton +
 * async `create()` lifecycle so the two registries resolve the same config dir
 * and share the test-isolation seam.
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
   * Async factory: ensure the config dir + schema exist, then run the one-time
   * filesystem/registry backfill (marker-gated, so it is a no-op after first run).
   */
  static async create(options?: ProjectGraphRegistryOptions): Promise<ProjectGraphRegistry> {
    const registry = ProjectGraphRegistry.getInstance(options);
    await ensureDir(registry.configDir);
    registry.ensureSchema();
    await registry.maybeBackfill();
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
        archived_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects (last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects (archived_at);
      CREATE TABLE IF NOT EXISTS registry_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Insert or update a project. On conflict (project_id exists) it refreshes
   * `store_path`, `name`, and `last_seen_at` (a moved/renamed store updates in
   * place) and clears `archived_at` (re-registering un-archives). Returns the row.
   */
  register(input: ProjectGraphRegisterInput): ProjectGraphEntry {
    const db = this.connection();
    const now = this.now();
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
      store_path: path.resolve(input.store_path),
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
   * Integration helper for `cmos_review` / `cmos_project register`: read the
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

  /** Close the underlying connection. Safe to call repeatedly. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * One-time backfill so operators with projects from before s69-m05 don't have
   * to re-register. Marker-gated (registry_meta.backfill_done): runs once, then a
   * fast no-op. Sources the existing {@link ProjectRegistry} (the user's known
   * project roots — itself populated by auto-discovery), reading each store's
   * metadata.project_id/project_name. Stores that are gone or unreadable are
   * skipped silently. (A redundant raw filesystem walk is intentionally omitted:
   * ProjectRegistry already IS the discovered-project set.)
   */
  private async maybeBackfill(): Promise<void> {
    const db = this.connection();
    const marker = db
      .prepare('SELECT value FROM registry_meta WHERE key = ?')
      .get(BACKFILL_MARKER_KEY) as MetaRow | undefined;
    if (marker) return;

    try {
      // Resolve the JSON ProjectRegistry against the SAME configDir as this graph
      // registry — otherwise an explicit `configDir` (tests, custom callers) would
      // be ignored and the backfill would read a DIFFERENT directory than the one
      // it is populating (e.g. ~/.config), pulling in unrelated projects. In
      // production both resolve to the env/default dir, so this is a no-op there.
      const projectRegistry = await ProjectRegistry.create({ configDir: this.configDir });
      const known = await projectRegistry.list();
      for (const proj of known) {
        const identity = readStoreIdentity(proj.projectRoot);
        if (!identity) continue;
        // Don't clobber a row already present (e.g. registered between create
        // calls); INSERT OR IGNORE keeps the first registration's timestamps.
        const exists = this.get(identity.project_id);
        if (exists) continue;
        this.register({
          project_id: identity.project_id,
          store_path: proj.projectRoot,
          name: identity.name,
        });
      }
    } catch {
      // Backfill is best-effort; never block registry availability on it. The
      // marker is still set so we don't re-scan on every open — a missed store
      // will be picked up by cmos_review's touchOrRegisterFromStore on next open.
    } finally {
      db.prepare('INSERT OR REPLACE INTO registry_meta (key, value) VALUES (?, ?)').run(
        BACKFILL_MARKER_KEY,
        String(this.now())
      );
    }
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
