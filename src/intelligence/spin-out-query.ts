// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Applies committed spin-out visibility on each existing cross-store read connection.
// ABOUTME: Filtering precedes the sentinel cap and preserves the fan-out merge comparator.
import type { CrossStoreQueryOptions, CrossStoreRow } from './cross-store-query';
import {
  prepareSpinOutRead,
  spinOutSqliteReader,
  type SpinOutKind,
} from '../tools/cmos/spin-out-read';

export function spinOutQuery(
  kind: SpinOutKind,
  sql: string,
  params: unknown[] = []
): NonNullable<CrossStoreQueryOptions['perStoreQuery']> {
  return (db, _store, limitWithSentinel) => {
    const visible = prepareSpinOutRead(spinOutSqliteReader(db)).predicate(kind, 'visible_row.id');
    return db
      .prepare(
        `SELECT * FROM (${sql}) visible_row WHERE ${visible.sql}
      ORDER BY IFNULL(occurred_at,0) DESC, IFNULL(origin_seq,0) DESC, project_id ASC LIMIT ?`
      )
      .all(...params, ...visible.params, limitWithSentinel) as CrossStoreRow[];
  };
}
