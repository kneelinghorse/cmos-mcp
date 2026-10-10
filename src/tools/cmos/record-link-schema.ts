// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Defines and verifies the owned version-one derived citation table.
// ABOUTME: Unknown versions or same-name foreign objects refuse migration and graph consumption.

import { linkObject, requireLinkSuccess, type RecordLinkReader } from './record-link-store';

export const RECORD_LINKS_MARKER = 'record_links_schema';
export const RECORD_LINKS_TABLE_SQL = `CREATE TABLE record_links (
  from_kind TEXT NOT NULL CHECK (from_kind IN ('decision', 'learning')),
  from_id INTEGER NOT NULL CHECK (from_id > 0),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('decision', 'learning')),
  to_id INTEGER NOT NULL CHECK (to_id > 0),
  resolution TEXT NOT NULL CHECK (resolution IN ('typed', 'bare')),
  PRIMARY KEY (from_kind, from_id, to_kind, to_id)
)`;
export const RECORD_LINKS_INDEX_SQL =
  'CREATE INDEX idx_record_links_target ON record_links (to_kind, to_id)';
const normalize = (sql: string): string =>
  sql
    .split(/('(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .toLowerCase()
            .replace(/if\s+not\s+exists\s+/g, '')
            .replace(/[\s;]/g, '')
    )
    .join('');
export function inspectRecordLinkSchema(reader: RecordLinkReader): {
  table: boolean;
  index: boolean;
  marker: string | undefined;
} {
  const marker = requireLinkSuccess(
    reader.getOne<{ value: string }>('SELECT value FROM metadata WHERE key=?', [
      RECORD_LINKS_MARKER,
    ]),
    'record links version'
  )?.value;
  if (marker !== undefined && marker !== '1')
    throw new Error(`Unrecognized record_links_schema version ${marker}; use a compatible server`);
  const table = linkObject(reader, 'record_links');
  const index = linkObject(reader, 'idx_record_links_target');
  if (
    table &&
    (table.type !== 'table' || normalize(table.sql ?? '') !== normalize(RECORD_LINKS_TABLE_SQL))
  )
    throw new Error(
      'Foreign or malformed record_links definition; preserve it and repair ownership before writing'
    );
  if (
    index &&
    (index.type !== 'index' || normalize(index.sql ?? '') !== normalize(RECORD_LINKS_INDEX_SQL))
  )
    throw new Error(
      'Foreign idx_record_links_target definition; preserve it and repair ownership before writing'
    );
  if (marker === '1' && (!table || !index))
    throw new Error('record_links_schema=1 disagrees with its owned objects');
  return { table: !!table, index: !!index, marker };
}
