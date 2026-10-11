// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reads stored project identities without migrations, repairs, or journal-mode changes.
// ABOUTME: Address lookup needs complete discovery because an unreadable store can hide a duplicate.

import Database from 'better-sqlite3';
import path from 'path';
import { processBusyTimeout } from '../tools/cmos/sqlite-busy';
import type { ProjectGraphRegistry } from './project-graph-registry';

export const ADDRESS_REMEDY =
  'Call cmos_project(action="list") to see registered addresses and paths, then pass projectRoot as an exact address or a project folder.';

export interface StoredProjectAddress {
  readonly id: string;
  readonly address: string | null;
}

export type StoredAddressResult =
  | { readonly identity: StoredProjectAddress; readonly error?: never }
  | { readonly identity: null; readonly error: string };

/** Includes invalid spellings so an attempted address never becomes a relative filesystem path. */
export function isProjectAddress(value: string): boolean {
  return /^cmos:/i.test(value.trim()) || value === 'local-only';
}

const ADDRESS_PATTERN = /^cmos:\/\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;

/** No client wrapper here: that wrapper may migrate, seed identity, or turn on WAL. */
export function readStoredProjectAddress(projectRoot: string): StoredAddressResult {
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(projectRoot, 'cmos/db/cmos.sqlite'), {
      readonly: true,
      fileMustExist: true,
      timeout: processBusyTimeout() ?? 5000,
    });
    const row = db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as
      | { content: unknown }
      | undefined;
    // The metadata row is the canonical ID; older identity blobs can leave their copy empty.
    const idRow = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
      | { value: unknown }
      | undefined;
    const id = idRow?.value;
    if (typeof id !== 'string' || !id.trim()) throw new Error('metadata has no stored project_id');
    // Normal init defers this row until a later write. A successful empty SELECT proves no
    // stored address; it is distinct from a NULL/malformed row or an unreadable table.
    if (row === undefined) return { identity: { id, address: null } };
    if (typeof row.content !== 'string')
      throw new Error('project_identity content is NULL or invalid');
    const identity: unknown = JSON.parse(row.content);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new Error('project_identity is not an object');
    }
    const { cmos_address: address } = identity as Record<string, unknown>;
    if (address !== null && typeof address !== 'string') {
      throw new Error('project_identity has an invalid cmos_address');
    }
    if (address && !ADDRESS_PATTERN.test(address)) {
      throw new Error('project_identity has an invalid cmos_address');
    }
    return { identity: { id, address: address || null } };
  } catch (error) {
    return { identity: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/** Returns a path only after every active store was readable and exactly one address matched. */
export function resolveRegisteredAddress(
  address: string,
  registry: ProjectGraphRegistry
): { readonly projectRoot: string } | { readonly error: string } {
  if (!ADDRESS_PATTERN.test(address)) {
    return {
      error: `Project address '${address}' is not an exact cmos://owner/project address. Local-only projects need a folder.`,
    };
  }
  const matches: string[] = [];
  const unreadable: string[] = [];
  for (const row of registry.list()) {
    const result = readStoredProjectAddress(row.store_path);
    if (!result.identity) unreadable.push(`${row.store_path}: ${result.error}`);
    else if (result.identity.address === address) matches.push(row.store_path);
  }
  if (unreadable.length) {
    return {
      error: `Cannot resolve '${address}': unreadable registered identity could hide a duplicate. ${unreadable.join('; ')}`,
    };
  }
  if (matches.length !== 1) {
    return {
      error: `Project address '${address}' has ${matches.length} matching active registered stores. Exactly one is required.`,
    };
  }
  return { projectRoot: matches[0] };
}
