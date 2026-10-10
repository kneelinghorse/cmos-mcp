// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reads committed spin-out pointers without changing stores or hiding pending copies.
// ABOUTME: Shares validated visibility predicates across bounded retrieval and historical lookups.
import type Database from 'better-sqlite3';
import type { CmosDatabaseClient } from './client';
import type { SpinOutKind, SpinOutPointer } from './spin-out-types';
import { SPIN_OUT_ROW_PREFIX, SPIN_OUT_ORIGIN_PREFIX } from './spin-out-types';
export type { SpinOutKind, SpinOutPointer } from './spin-out-types';
export type SpinOutReader = Pick<CmosDatabaseClient, 'getOne' | 'getMany'>;
export interface SpinOutRead {
  hidden(kind: SpinOutKind, id: string | number): boolean;
  pointer(kind: SpinOutKind, id: string | number): SpinOutPointer | undefined;
  origin(kind: SpinOutKind, id: string | number): SpinOutPointer | undefined;
  predicate(kind: SpinOutKind, idSql: string): { sql: string; params: string[] };
}
export interface SpinOutDetails {
  spunOutTo?: SpinOutPointer;
  spinOutOrigin?: SpinOutPointer;
}
export function spinOutDetails(
  read: SpinOutRead,
  kind: SpinOutKind,
  id: string | number
): SpinOutDetails {
  const outgoing = read.pointer(kind, id);
  const incoming = read.origin(kind, id);
  return {
    ...(outgoing ? { spunOutTo: outgoing } : {}),
    ...(incoming ? { spinOutOrigin: incoming } : {}),
  };
}
export function spinOutPointerLines(details: SpinOutDetails): string[] {
  const lines: string[] = [];
  if (details.spunOutTo) {
    const p = details.spunOutTo;
    lines.push(
      `Spun out: ${p.sourceRoot} #${p.sourceId} → ${p.targetRoot} #${p.targetId} (operation ${p.operationId}).`
    );
  }
  if (details.spinOutOrigin) {
    const p = details.spinOutOrigin;
    lines.push(
      `Copied from: ${p.sourceRoot} #${p.sourceId} → ${p.targetRoot} #${p.targetId} (operation ${p.operationId}).`
    );
  }
  return lines;
}
/** Historical reports retain every mission and explain transferred work beside unchanged KPIs. */
export function spinOutHistoryLines(read: SpinOutRead, missionIds: readonly string[]): string[] {
  return missionIds.flatMap((id) => spinOutPointerLines(spinOutDetails(read, 'mission', id)));
}
export function spinOutSqliteReader(db: Database.Database): SpinOutReader {
  return {
    getOne: <T>(sql: string, params: unknown[] = []) => ({
      success: true,
      data: db.prepare(sql).get(...params) as T | undefined,
    }),
    getMany: <T>(sql: string, params: unknown[] = []) => ({
      success: true,
      data: db.prepare(sql).all(...params) as T[],
    }),
  };
}
const kinds: readonly SpinOutKind[] = ['mission', 'decision', 'learning', 'next-step'];
const key = (kind: SpinOutKind, id: string | number): string => `${kind}:${id}`;
function fail(message: string): never {
  throw new Error(`SPIN_OUT_READ_FAILED: ${message}`);
}
function validId(kind: SpinOutKind, id: unknown): boolean {
  return kind === 'mission'
    ? typeof id === 'string' && id.trim().length > 0
    : typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}
/** Call once per read operation; no negative cache survives another call or transaction. */
export function prepareSpinOutRead(reader: SpinOutReader): SpinOutRead {
  try {
    const object = reader.getOne<{ type: string }>(
      "SELECT type FROM sqlite_master WHERE name='metadata'"
    );
    if (!object.success) fail(object.error?.message ?? 'metadata schema inspection failed');
    if (object.data && object.data.type !== 'table') fail('metadata is not a table');
    const outgoing = new Map<string, SpinOutPointer>();
    const incoming = new Map<string, SpinOutPointer>();
    if (object.data) {
      const rows = reader.getMany<{ key: string; value: string }>(
        "SELECT key,value FROM metadata WHERE key GLOB 'spin_out_row:*' OR key GLOB 'spin_out_origin:*'"
      );
      if (!rows.success) fail(rows.error?.message ?? 'pointer query failed');
      for (const row of rows.data ?? []) {
        const origin = row.key.startsWith(SPIN_OUT_ORIGIN_PREFIX);
        const suffix = row.key.slice(
          (origin ? SPIN_OUT_ORIGIN_PREFIX : SPIN_OUT_ROW_PREFIX).length
        );
        const kind = suffix.slice(0, suffix.indexOf(':')) as SpinOutKind;
        const pointer = JSON.parse(row.value) as SpinOutPointer;
        if (!kinds.includes(kind) || !pointer || typeof pointer !== 'object')
          fail(`invalid pointer ${row.key}`);
        for (const field of [
          'operationId',
          'sourceProjectId',
          'sourceRoot',
          'targetProjectId',
          'targetRoot',
        ] as const)
          if (typeof pointer[field] !== 'string' || !pointer[field].trim())
            fail(`invalid ${field} in ${row.key}`);
        if (
          !validId(kind, pointer.sourceId) ||
          !validId(kind, pointer.targetId) ||
          suffix !== key(kind, origin ? pointer.targetId : pointer.sourceId)
        )
          fail(`pointer identity does not match ${row.key}`);
        (origin ? incoming : outgoing).set(suffix, pointer);
      }
    }
    return {
      hidden: (kind, id) => outgoing.has(key(kind, id)),
      pointer: (kind, id) => outgoing.get(key(kind, id)),
      origin: (kind, id) => incoming.get(key(kind, id)),
      predicate: (kind, idSql) => {
        if (!kinds.includes(kind) || !/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(idSql))
          fail('invalid visibility identifier');
        return object.data
          ? {
              sql: `NOT EXISTS (SELECT 1 FROM metadata spin_out_visibility WHERE spin_out_visibility.key = ? || CAST(${idSql} AS TEXT))`,
              params: [`${SPIN_OUT_ROW_PREFIX}${kind}:`],
            }
          : { sql: '1=1', params: [] };
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SPIN_OUT_READ_FAILED:')) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
}
