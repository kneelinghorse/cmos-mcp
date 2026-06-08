// ABOUTME: Loads the sqlite-vec extension into a better-sqlite3 Database, enabling vec0 virtual tables.
// Safe to call multiple times per process — successive loads on the same connection are no-ops at the SQLite layer.

import type { Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Track which DB connections have had sqlite-vec loaded already so repeated
 * `ensureConnection()` calls don't re-issue `loadExtension` against the same
 * handle. WeakSet keeps GC'd connections from leaking entries.
 */
const loadedConnections = new WeakSet<DatabaseType>();

/**
 * Load the sqlite-vec loadable extension into a better-sqlite3 Database.
 *
 * Idempotent per connection — returns immediately for an already-loaded handle.
 *
 * Throws if the platform binary is missing (sqlite-vec ships per-platform
 * optionalDependencies; an unsupported platform will fail at require-resolve
 * time inside `sqliteVec.load`). Callers in the hot path should let the throw
 * surface — without vec0 the hybrid retriever cannot function and silent
 * degradation would mask a deploy-environment problem.
 */
export function loadVecExtension(db: DatabaseType): void {
  if (loadedConnections.has(db)) return;
  sqliteVec.load(db);
  loadedConnections.add(db);
}
