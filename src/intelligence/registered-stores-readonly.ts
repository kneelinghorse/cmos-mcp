// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Discover active stores from an existing registry without creating, migrating or backfilling it.
// ABOUTME: Missing registries are empty; unreadable registries fail explicitly rather than hide fleet work.

import Database from 'better-sqlite3';
import { statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectGraphEntry } from './project-graph-registry';

/** A bounded read of the canonical registry, also usable by short-lived hook processes. */
export function listRegisteredStoresReadOnly(
  env: NodeJS.ProcessEnv = process.env
): ProjectGraphEntry[] {
  const configDir = env.CMOS_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'cmos-mcp');
  const file = path.join(configDir, 'project-graph.sqlite');
  try {
    statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const synced = columns.some((column) => column.name === 'last_synced_at')
      ? 'last_synced_at'
      : 'NULL AS last_synced_at';
    return db
      .prepare(
        `SELECT project_id,store_path,name,registered_at,last_seen_at,schema_version,
        archived_at,${synced} FROM projects WHERE archived_at IS NULL
        ORDER BY last_seen_at DESC,project_id ASC`
      )
      .all() as ProjectGraphEntry[];
  } finally {
    db.close();
  }
}
