// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read canonical source rows and the five-table collision inventory through a readonly adapter.
// ABOUTME: Query failures throw named context instead of masquerading as missing or empty data.

import type { CmosDatabaseClient } from './client';
import type { CmosToolResult } from './types';
import type { CitationIdentity, InventoryKind, RecordKind } from './record-link-extractor';

export type RecordLinkReader = Pick<CmosDatabaseClient, 'getOne' | 'getMany' | 'path'>;
export type StoredLinkSource = CitationIdentity & {
  kind: RecordKind;
  fields: Record<string, unknown>;
};
export interface LinkInventory {
  localProjectId: string | null;
  sources: StoredLinkSource[];
  identities: (CitationIdentity & { kind: InventoryKind })[];
}
export function requireLinkSuccess<T>(result: CmosToolResult<T>, step: string): T | undefined {
  if (!result.success)
    throw new Error(
      `${step}: ${result.error?.code ?? 'DB_ERROR'} — ${result.error?.message ?? 'unknown'}`
    );
  return result.data;
}
export function linkObject(
  reader: RecordLinkReader,
  name: string
): { type: string; sql: string | null } | undefined {
  return requireLinkSuccess(
    reader.getOne<{ type: string; sql: string | null }>(
      'SELECT type, sql FROM sqlite_master WHERE name=?',
      [name]
    ),
    `${name} schema read`
  );
}

/** Missing optional historical tables are empty; malformed existing tables are never empty. */
export function loadLinkInventory(reader: RecordLinkReader, requireSources = false): LinkInventory {
  const localProjectId =
    requireLinkSuccess(
      reader.getOne<{ value: string }>('SELECT value FROM metadata WHERE key=?', ['project_id']),
      'citation project identity'
    )?.value ?? null;
  const sources: StoredLinkSource[] = [];
  const identities: LinkInventory['identities'] = [];
  const tables = [
    ['strategic_decisions', 'decision', 'decision_text'],
    ['learnings', 'learning', 'content'],
    ['constraints', 'constraint', null],
    ['next_steps', 'next_step', null],
    ['agent_feedback', 'feedback', null],
  ] as const;
  for (const [table, kind, textColumn] of tables) {
    const object = linkObject(reader, table);
    if (!object) {
      if (requireSources && textColumn)
        throw new Error(`Required citation source ${table} is absent`);
      continue;
    }
    if (object.type !== 'table') throw new Error(`Citation source ${table} is not a table`);
    const columns = new Set(
      requireLinkSuccess(
        reader.getMany<{ name: string }>(`PRAGMA table_info(${table})`),
        `${table} columns`
      )?.map((row) => row.name)
    );
    if (
      !columns.has('id') ||
      !columns.has('created_at') ||
      (textColumn && !columns.has(textColumn))
    )
      throw new Error(`Citation source ${table} lacks required id, time or text columns`);
    const rows =
      requireLinkSuccess(
        reader.getMany<Record<string, unknown>>(`SELECT * FROM ${table}`),
        `${table} citation rows`
      ) ?? [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0)
        throw new Error(`Citation source ${table} has an invalid record id`);
      const identity = {
        kind,
        id: Number(row.id),
        created_at: typeof row.created_at === 'string' ? row.created_at : null,
        project_id: typeof row.project_id === 'string' ? row.project_id : null,
      };
      identities.push(identity);
      if (kind === 'decision' || kind === 'learning')
        sources.push({ ...identity, kind, fields: row });
    }
  }
  return { localProjectId, sources, identities };
}
