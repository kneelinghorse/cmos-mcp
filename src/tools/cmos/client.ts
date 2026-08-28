/**
 * CmosDatabaseClient - Core database client wrapper for CMOS SQLite operations
 *
 * Provides:
 * - Connection management with auto-close
 * - Standard query patterns (getOne, getMany, execute)
 * - Error translation to structured CmosToolError
 * - Integration with CmosDetector for database path discovery
 *
 * All methods return CmosToolResult<T> for consistent agent-friendly responses.
 *
 * @module tools/cmos/client
 */

import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import { CmosDetector, type CmosDetectionResult } from '../../intelligence/cmos-detector';
import {
  resolveProjectRootEnhanced,
  ProjectResolutionError,
} from '../../intelligence/project-resolution';
import type { CmosToolResult, DbHealthResult } from './types';
import { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } from './errors';
import { loadVecExtension } from './vec-loader';
import { assertJestDbPathIsolated, RealStoreGuardError } from './real-store-guard';

// Re-export the resolver for convenience. s80-m01 trimmed the dead JSON
// `ProjectRegistry` / `RegisteredProject` / `ProjectValidation` /
// `resolveProjectRootPath` / `ProjectResolutionResult` re-exports (grep-confirmed
// no importers); the resolver now lives in `intelligence/project-resolution.ts`.
export { resolveProjectRootEnhanced, ProjectResolutionError };

/**
 * Environment variable for CMOS project root.
 * When set, tools use this as default instead of process.cwd().
 * Useful for Claude Desktop where cwd may not be the project directory.
 */
export const CMOS_PROJECT_ROOT_ENV = 'CMOS_PROJECT_ROOT';

/**
 * Environment variable for project ID validation.
 * Used together with database self-protection: if database has project_id
 * in metadata, this env var MUST match for mutation operations.
 */
export const CMOS_PROJECT_ID_ENV = 'CMOS_PROJECT_ID';

/**
 * Resolve the project root directory (synchronous, simple fallback).
 *
 * Priority: explicit param > CMOS_PROJECT_ROOT env var > process.cwd()
 *
 * s87-m04 — THIS SENTENCE IS TRUE AND IS DELIBERATELY LEFT ALONE. A sweep that corrected the
 * other resolution-order claims in this file would be tempted to "fix" it too, because it names
 * an env step the ENHANCED resolver does not have. But this function is not that resolver: the
 * line below really does read `process.env[CMOS_PROJECT_ROOT_ENV]`. The claim describes THIS
 * function's behaviour exactly. `resolveProjectRootEnhanced` dropped its env step in sprint-53
 * m02; the two resolvers genuinely differ, and deleting a true statement to make a directory
 * uniform is its own kind of dishonesty.
 *
 * @deprecated Use resolveProjectRootEnhanced() for full 5-step resolution
 * with auto-discovery and registry fallback. This synchronous version
 * is kept for backward compatibility but doesn't support the registry.
 *
 * @param explicitRoot - Explicitly provided project root
 * @returns Resolved project root path
 */
export function resolveProjectRoot(explicitRoot?: string): string {
  return explicitRoot ?? process.env[CMOS_PROJECT_ROOT_ENV] ?? process.cwd();
}

/**
 * Options for creating a CmosDatabaseClient
 */
export interface CmosDatabaseClientOptions {
  /** Explicit database path (overrides detection) */
  dbPath?: string;

  /** Project root for CMOS detection (defaults to cwd) */
  projectRoot?: string;

  /** SQLite connection timeout in milliseconds */
  timeout?: number;

  /** Whether to open in read-only mode */
  readonly?: boolean;

  /** Enable verbose mode for debugging */
  verbose?: boolean;
}

/**
 * Query parameters for parameterized queries
 */
export type QueryParams = Record<string, unknown> | unknown[];

/**
 * Result of a database mutation (INSERT, UPDATE, DELETE)
 */
export interface MutationResult {
  /** Number of rows affected */
  changes: number;

  /** Last inserted row ID (for INSERT) */
  lastInsertRowid: number | bigint;
}

/**
 * CmosDatabaseClient - Wrapper around better-sqlite3 for CMOS operations
 *
 * Usage:
 * ```typescript
 * // Create client (auto-detects database)
 * const client = await CmosDatabaseClient.create();
 *
 * // Query operations
 * const missions = await client.getMany<Mission>('SELECT * FROM missions WHERE status = ?', ['In Progress']);
 * const mission = await client.getOne<Mission>('SELECT * FROM missions WHERE id = ?', ['s12-m03']);
 *
 * // Mutation operations
 * const result = await client.execute(
 *   'UPDATE missions SET status = ? WHERE id = ?',
 *   ['Completed', 's12-m03']
 * );
 *
 * // Always close when done
 * client.close();
 * ```
 */
export class CmosDatabaseClient {
  private db: DatabaseType | null = null;
  private readonly dbPath: string;
  private readonly options: Required<Omit<CmosDatabaseClientOptions, 'dbPath' | 'projectRoot'>>;
  private statementCache: Map<string, Statement> = new Map();

  /**
   * Private constructor - use CmosDatabaseClient.create() instead
   */
  private constructor(dbPath: string, options: CmosDatabaseClientOptions = {}) {
    this.dbPath = dbPath;
    this.options = {
      timeout: options.timeout ?? 5000,
      readonly: options.readonly ?? false,
      verbose: options.verbose ?? false,
    };
  }

  /**
   * Create a new CmosDatabaseClient
   *
   * Resolution priority, s87-m04 — CORRECTED. This block listed a `CMOS_PROJECT_ROOT`
   * environment step that `resolveProjectRootEnhanced` has not had since sprint-53 m02, which
   * removed it deliberately (see that function's docblock: the env var is still read at
   * `src/index.ts` for .env bootstrap, and is never consulted during resolution). An operator who
   * set the variable expecting it to steer resolution was reading a step that does not run.
   * 1. Explicit dbPath option
   * 2. Explicit projectRoot option
   * 3. Auto-discover from cwd
   * 4. Registry fallback (default project)
   * 5. Error with actionable guidance
   *
   * NOTE the deliberate difference from {@link resolveProjectRoot} above, which DOES read the env
   * var and whose docblock correctly says so. Two resolvers, two behaviours, two true sentences.
   *
   * @param options - Client options
   * @returns CmosToolResult with the client or an error
   */
  static async create(
    options: CmosDatabaseClientOptions = {}
  ): Promise<CmosToolResult<CmosDatabaseClient>> {
    try {
      let dbPath = options.dbPath;

      // If no explicit dbPath, resolve project root and detect database
      if (!dbPath) {
        let projectRoot: string;

        // If explicit projectRoot provided, use it directly
        if (options.projectRoot) {
          projectRoot = options.projectRoot;
        } else {
          // Use enhanced resolution (auto-discover → registry → error). s87-m04: this comment
          // used to name an `env` step first. There is none — sprint-53 m02 removed it.
          //
          // s87-m04 / D-9, recorded where it is reachable: this arm passes
          // `autoRegister: true`, so resolution here can MINT a project-graph registry row —
          // including for a read action, before any action-taxonomy check runs. That makes the
          // read-only agent guard's "No database was opened and no row/credential was mutated"
          // not literally true on this path. NOT fixed this sprint: it is an input to
          // SPLIT-THE-PATHS (Arc F sprint 2), which must decide the same question for the
          // explicit-projectRoot arm, and fixing one half now would prejudge the other.
          try {
            const resolution = await resolveProjectRootEnhanced(undefined, {
              autoRegister: true,
              silent: true,
            });
            projectRoot = resolution.projectRoot;
          } catch (error) {
            if (error instanceof ProjectResolutionError) {
              return createError({
                code: CMOS_ERROR_CODES.CMOS_NOT_DETECTED,
                message: error.message,
                suggestion: error.suggestion,
              });
            }
            throw error;
          }
        }

        const detector = CmosDetector.getInstance();
        const detection = await detector.detect(projectRoot);

        if (!detection.hasCmosDirectory) {
          return createError(CmosErrors.cmosNotDetected(projectRoot));
        }

        if (!detection.hasDatabase || !detection.databasePath) {
          return createError(CmosErrors.dbNotFound(detection.cmosDirectory));
        }

        dbPath = detection.databasePath;
      }

      const client = new CmosDatabaseClient(dbPath, options);

      // Test connection
      const connectionResult = client.ensureConnection();
      if (!connectionResult.success) {
        return connectionResult as CmosToolResult<CmosDatabaseClient>;
      }

      return createSuccess(client);
    } catch (error) {
      // Sprint 70 m01: never mask the real-store isolation guard. ensureConnection()
      // throws RealStoreGuardError before opening; if we folded it into a
      // DB_CONNECTION_FAILED result a leaking test could silently tolerate it.
      // Re-throw so it fails loud with its stack trace. (decision #754)
      if (error instanceof RealStoreGuardError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return createError({
        code: CMOS_ERROR_CODES.DB_CONNECTION_FAILED,
        message: `Failed to create database client: ${message}`,
        suggestion: 'Check that the cmos/ directory exists and contains db/cmos.sqlite',
      });
    }
  }

  /**
   * Create a CmosDatabaseClient from a detection result
   *
   * Useful when you've already run detection and want to avoid re-detecting.
   *
   * @param detection - CmosDetectionResult from CmosDetector
   * @param options - Additional client options
   * @returns CmosToolResult with the client or an error
   */
  static fromDetection(
    detection: CmosDetectionResult,
    options: Omit<CmosDatabaseClientOptions, 'dbPath' | 'projectRoot'> = {}
  ): CmosToolResult<CmosDatabaseClient> {
    if (!detection.hasDatabase || !detection.databasePath) {
      return createError(CmosErrors.dbNotFound(detection.cmosDirectory));
    }

    const client = new CmosDatabaseClient(detection.databasePath, options);

    // Test connection
    const connectionResult = client.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<CmosDatabaseClient>;
    }

    return createSuccess(client);
  }

  /**
   * Get the database path
   */
  get path(): string {
    return this.dbPath;
  }

  /**
   * Check if the database connection is open
   */
  get isOpen(): boolean {
    return this.db !== null && this.db.open;
  }

  /**
   * Ensure database connection is established
   *
   * @returns CmosToolResult indicating success or connection error
   */
  private ensureConnection(): CmosToolResult<void> {
    if (this.db && this.db.open) {
      return createSuccess(undefined);
    }

    // Sprint 70 m01 (decision #754): real-store isolation guard. Strict no-op
    // outside Jest. Under Jest it throws BEFORE opening — so a stray
    // cwd-resolved open of the real dogfood store fails loud with a stack trace
    // instead of silently running a schema migration against production data.
    assertJestDbPathIsolated(this.dbPath);

    try {
      this.db = new Database(this.dbPath, {
        readonly: this.options.readonly,
        timeout: this.options.timeout,
        verbose: this.options.verbose ? console.log : undefined,
      });

      // Enable foreign keys for referential integrity
      this.db.pragma('foreign_keys = ON');

      // Enable WAL mode for better concurrent access.
      //
      // s87-m03 (#535) — GUARDED, because `journal_mode = WAL` IS A WRITE. On a store that is
      // not already in WAL mode, setting it rewrites the database header, so issuing it
      // unconditionally made `CmosDatabaseClient.create({ readonly: true })` fail outright with
      // `DB_CONNECTION_FAILED: attempt to write a readonly database` — a read-only client that
      // could not open a delete-mode store at all. Read the mode first and only set it when the
      // connection is writable AND the mode actually differs; on an already-WAL store the write
      // never happens either way, which is why this went unnoticed.
      //
      // HONEST SCOPE, so this is not read as a bigger rescue than it is: NO `src/` site currently
      // passes `readonly: true` to this client — all eight read-only opens in the tree are raw
      // `better-sqlite3` calls. This fix is therefore LATENT, not live. It exists because the
      // read/write distinction at the client layer is the signal SPLIT-THE-PATHS needs next
      // sprint, and because a pragma that writes should not run on a connection that declares
      // it will not write.
      const currentJournalMode = String(
        (this.db.pragma('journal_mode', { simple: true }) as string | undefined) ?? ''
      ).toLowerCase();
      if (!this.options.readonly && currentJournalMode !== 'wal') {
        this.db.pragma('journal_mode = WAL');
      }

      // Load sqlite-vec extension so vec0 virtual tables created by
      // ensureVectorStorage (and queried by the hybrid retriever) are available.
      // Idempotent per connection — see vec-loader.ts.
      loadVecExtension(this.db);

      return createSuccess(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return createError(CmosErrors.dbConnectionFailed(this.dbPath, message));
    }
  }

  /**
   * Get a single row from the database
   *
   * @param sql - SQL query (should return at most one row)
   * @param params - Query parameters (array for positional, object for named)
   * @returns CmosToolResult with the row or undefined if not found
   */
  getOne<T = Record<string, unknown>>(
    sql: string,
    params?: QueryParams
  ): CmosToolResult<T | undefined> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<T | undefined>;
    }

    try {
      const stmt = this.prepareStatement(sql);
      const row = (params ? stmt.get(params) : stmt.get()) as T | undefined;
      return createSuccess(row);
    } catch (error) {
      return this.handleQueryError(error, sql);
    }
  }

  /**
   * Get multiple rows from the database
   *
   * @param sql - SQL query
   * @param params - Query parameters (array for positional, object for named)
   * @returns CmosToolResult with array of rows (empty array if none found)
   */
  getMany<T = Record<string, unknown>>(sql: string, params?: QueryParams): CmosToolResult<T[]> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<T[]>;
    }

    try {
      const stmt = this.prepareStatement(sql);
      const rows = (params ? stmt.all(params) : stmt.all()) as T[];
      return createSuccess(rows);
    } catch (error) {
      return this.handleQueryError(error, sql);
    }
  }

  /**
   * Execute a mutation query (INSERT, UPDATE, DELETE)
   *
   * @param sql - SQL mutation query
   * @param params - Query parameters (array for positional, object for named)
   * @returns CmosToolResult with mutation result (changes, lastInsertRowid)
   */
  execute(sql: string, params?: QueryParams): CmosToolResult<MutationResult> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<MutationResult>;
    }

    try {
      const stmt = this.prepareStatement(sql);
      const result = params ? stmt.run(params) : stmt.run();
      return createSuccess({
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      });
    } catch (error) {
      return this.handleQueryError(error, sql);
    }
  }

  /**
   * Execute multiple statements in a transaction
   *
   * All statements succeed or all fail (atomic).
   *
   * @param fn - Function that performs database operations
   * @returns CmosToolResult with the function's return value
   */
  transaction<T>(fn: () => T): CmosToolResult<T> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<T>;
    }

    try {
      const db = this.db!;
      const transaction = db.transaction(fn);
      const result = transaction();
      return createSuccess(result);
    } catch (error) {
      return this.handleQueryError(error, 'TRANSACTION');
    }
  }

  /**
   * Execute raw SQL (for complex operations like PRAGMA)
   *
   * Use with caution - prefer getOne/getMany/execute for standard queries.
   *
   * @param sql - Raw SQL to execute
   * @returns CmosToolResult indicating success or error
   */
  raw(sql: string): CmosToolResult<void> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<void>;
    }

    try {
      this.db!.exec(sql);
      return createSuccess(undefined);
    } catch (error) {
      return this.handleQueryError(error, sql);
    }
  }

  /**
   * Set or read a PRAGMA via better-sqlite3's dedicated `db.pragma()` API.
   *
   * Use this for connection-state pragmas like `foreign_keys` / `legacy_alter_table`:
   * setting them via `raw()` (i.e. `db.exec('PRAGMA ...')`) is UNRELIABLE — the
   * change may not take effect until the next prepared-statement boundary, which
   * is what made the 12-step rebuild's `foreign_keys = OFF` intermittently a
   * no-op and risked firing ON DELETE actions on children. `db.pragma()` applies
   * the setting immediately. Returns the pragma's result (number for simple
   * pragmas, rows otherwise).
   */
  pragma(pragmaString: string): unknown {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return undefined;
    }
    return this.db!.pragma(pragmaString);
  }

  /**
   * Check database health and return statistics
   *
   * @returns CmosToolResult with database health information
   */
  health(): CmosToolResult<DbHealthResult> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<DbHealthResult>;
    }

    try {
      const db = this.db!;

      // Get SQLite version
      const versionRow = db.prepare('SELECT sqlite_version() as version').get() as {
        version: string;
      };

      // Get table list
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as { name: string }[];

      // Get counts for key tables
      const missionCount = this.safeCount('missions');
      const sessionCount = this.safeCount('sessions');
      const contextCount = this.safeCount('contexts');

      return createSuccess({
        connected: true,
        version: versionRow.version,
        path: this.dbPath,
        tables: tables.map((t) => t.name),
        missionCount,
        sessionCount,
        contextCount,
      });
    } catch (error) {
      return this.handleQueryError(error, 'HEALTH_CHECK');
    }
  }

  /**
   * Close the database connection
   *
   * Clears the statement cache and releases all resources.
   * Safe to call multiple times.
   */
  close(): void {
    this.statementCache.clear();
    if (this.db && this.db.open) {
      this.db.close();
    }
    this.db = null;
  }

  /**
   * Get a prepared statement (cached for performance)
   */
  private prepareStatement(sql: string): Statement {
    let stmt = this.statementCache.get(sql);
    if (!stmt) {
      stmt = this.db!.prepare(sql);
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Safely count rows in a table
   */
  private safeCount(tableName: string): number {
    try {
      const row = this.db!.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as {
        count: number;
      };
      return row.count;
    } catch {
      return 0;
    }
  }

  /**
   * Handle query errors and translate to CmosToolError
   */
  private handleQueryError<T>(error: unknown, _sql: string): CmosToolResult<T> {
    // s86-m02b: DUCK-TYPED, not `instanceof Error`. A better-sqlite3 SqliteError that crosses a
    // module-registry / realm boundary (Jest's per-file registry is the everyday case) fails
    // `instanceof`, and the old fallback `String(error)` then produced the class-name-prefixed
    // "SqliteError: <msg>" instead of "<msg>". That text is now DISCLOSED IN ANSWERS via
    // checkWrite/countWrite, so a message that changes shape depending on which realm threw it
    // makes the answer non-deterministic — and made a mission test order-dependent.
    const rawMessage =
      typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : String(error ?? 'Unknown database error');
    const message = rawMessage.toLowerCase();
    const sqliteCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'string'
        ? ((error as { code: string }).code ?? '').toUpperCase()
        : '';

    // Check for specific SQLite error patterns
    if (message.includes('no such table')) {
      const tableMatch = rawMessage.match(/no such table:\s*(?:\w+\.)?([\w-]+)/i);
      const tableName = tableMatch?.[1] ?? 'unknown';
      return createError({
        code: CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Table '${tableName}' does not exist`,
        suggestion: 'Ensure the database schema is up to date. Run migrations if needed.',
      });
    }

    if (message.includes('no such column') || message.includes('has no column named')) {
      const columnMatch = rawMessage.match(
        /(?:no such column|has no column named):?\s*(?:\w+\.)?([\w-]+)/i
      );
      const columnName = columnMatch?.[1] ?? 'unknown';
      return createError({
        code: CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Column '${columnName}' does not exist`,
        suggestion: 'Ensure the database schema is up to date. Run migrations if needed.',
      });
    }

    if (message.includes('unique constraint failed') || sqliteCode.includes('CONSTRAINT_UNIQUE')) {
      const fieldMatch = rawMessage.match(/UNIQUE constraint failed:\s*(\S+)/i);
      const field = fieldMatch?.[1] ?? 'unknown';
      return createError({
        code: CMOS_ERROR_CODES.INVALID_PARAMETER,
        message: `Duplicate value for unique field '${field}'`,
        field: field.split('.').pop(),
        suggestion: 'Use a unique value for this field or update the existing record.',
      });
    }

    if (
      message.includes('foreign key constraint failed') ||
      sqliteCode.includes('CONSTRAINT_FOREIGNKEY')
    ) {
      return createError({
        code: CMOS_ERROR_CODES.INVALID_PARAMETER,
        message: 'Foreign key constraint violation',
        suggestion: 'Ensure referenced records exist before inserting or updating.',
      });
    }

    if (message.includes('database is locked') || sqliteCode === 'SQLITE_BUSY') {
      return createError({
        code: CMOS_ERROR_CODES.DB_CONNECTION_FAILED,
        message: 'Database is locked by another process',
        suggestion: 'Wait and retry, or close other applications using the database.',
      });
    }

    if (message.includes('sqlite_readonly') || sqliteCode === 'SQLITE_READONLY') {
      return createError({
        code: CMOS_ERROR_CODES.DB_CONNECTION_FAILED,
        message: 'Database is opened in read-only mode',
        suggestion: 'Reopen the database with readonly: false to perform mutations.',
      });
    }

    // Generic query error
    return createError({
      code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
      message: `Query failed: ${rawMessage}`,
      suggestion: 'Check the SQL syntax and parameters.',
    });
  }

  /**
   * Validate project ID matches expected value from environment.
   *
   * Database self-protection: If the database has a project_id in metadata,
   * the CMOS_PROJECT_ID env var MUST be set and match. This prevents
   * cross-project contamination when multiple projects use CMOS.
   *
   * - Database has project_id + env var matches → success
   * - Database has project_id + env var missing → error (protection active)
   * - Database has project_id + env var mismatch → error
   * - Database has no project_id → success (backward compatible)
   *
   * @returns CmosToolResult indicating success or mismatch error
   */
  validateProjectId(): CmosToolResult<void> {
    const expectedProjectId = process.env[CMOS_PROJECT_ID_ENV];

    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as CmosToolResult<void>;
    }

    try {
      // Read project_id from metadata table
      const stmt = this.db!.prepare('SELECT value FROM metadata WHERE key = ?');
      const row = stmt.get('project_id') as { value: string } | undefined;
      const databaseProjectId = row?.value ?? '';

      // If database has no project_id, skip validation (backward compatible)
      if (!databaseProjectId) {
        return createSuccess(undefined);
      }

      // Database has project_id - enforce validation
      if (!expectedProjectId) {
        return createError({
          code: CMOS_ERROR_CODES.PROJECT_ID_MISMATCH,
          message: `This database requires project ID validation. Database project: "${databaseProjectId}"`,
          suggestion: `Set CMOS_PROJECT_ID="${databaseProjectId}" environment variable to write to this database.`,
        });
      }

      if (databaseProjectId !== expectedProjectId) {
        return createError({
          code: CMOS_ERROR_CODES.PROJECT_ID_MISMATCH,
          message: `Project ID mismatch: env has "${expectedProjectId}", database has "${databaseProjectId}"`,
          suggestion: `You may be connected to the wrong database. Set CMOS_PROJECT_ID="${databaseProjectId}" or check your projectRoot.`,
        });
      }

      return createSuccess(undefined);
    } catch (error) {
      // If metadata table doesn't exist, skip validation (old database)
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (/no such table:\s*(?:\w+\.)?metadata/i.test(message)) {
        // No metadata table = old database, skip validation for backward compatibility
        return createSuccess(undefined);
      }
      return this.handleQueryError(error, 'validateProjectId');
    }
  }
}

/**
 * Convenience function to create a client and run a single operation
 *
 * Automatically closes the connection after the operation.
 *
 * @param fn - Function that uses the client
 * @param options - Client options
 * @returns Result of the operation
 */
export async function withClient<T>(
  fn: (client: CmosDatabaseClient) => CmosToolResult<T>,
  options?: CmosDatabaseClientOptions
): Promise<CmosToolResult<T>> {
  const clientResult = await CmosDatabaseClient.create(options);
  if (!clientResult.success || !clientResult.data) {
    return clientResult as CmosToolResult<T>;
  }

  const client = clientResult.data;
  try {
    return fn(client);
  } finally {
    client.close();
  }
}

/**
 * Convenience function for async operations with automatic cleanup
 *
 * @param fn - Async function that uses the client
 * @param options - Client options
 * @returns Result of the operation
 */
export async function withClientAsync<T>(
  fn: (client: CmosDatabaseClient) => Promise<CmosToolResult<T>>,
  options?: CmosDatabaseClientOptions
): Promise<CmosToolResult<T>> {
  const clientResult = await CmosDatabaseClient.create(options);
  if (!clientResult.success || !clientResult.data) {
    return clientResult as CmosToolResult<T>;
  }

  const client = clientResult.data;
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * Convenience function for mutation operations.
 *
 * NOTE: Project ID validation has been removed. The explicit projectRoot
 * requirement (no cwd fallback) provides sufficient protection against
 * cross-project contamination without requiring env var configuration.
 *
 * This function is now identical to withClient but kept for backward
 * compatibility with existing tool implementations.
 *
 * @param fn - Function that uses the client
 * @param options - Client options
 * @returns Result of the operation
 */
export async function withClientValidated<T>(
  fn: (client: CmosDatabaseClient) => CmosToolResult<T>,
  options?: CmosDatabaseClientOptions
): Promise<CmosToolResult<T>> {
  // Simply delegate to withClient - no additional validation needed
  // since projectRoot is now required (no cwd fallback)
  return withClient(fn, options);
}
