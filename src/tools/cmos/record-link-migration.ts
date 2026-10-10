// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Create and backfill the owned citation schema in one immediate transaction.
// ABOUTME: Version metadata commits last, with lock rereads and failures that never claim readiness.

import type { CmosDatabaseClient } from './client';
import type { CitationDiscards } from './record-link-extractor';
import type { MigrationResult } from './schema-migrations';
import { asLazyRepair, callMayWrite } from './tool-call-context';
import {
  inspectRecordLinkSchema,
  RECORD_LINKS_INDEX_SQL,
  RECORD_LINKS_MARKER,
  RECORD_LINKS_TABLE_SQL,
} from './record-link-schema';
import { loadLinkInventory, requireLinkSuccess } from './record-link-store';
import { repairLinkSources } from './record-link-materialize';

export function ensureRecordLinks(
  client: CmosDatabaseClient
): MigrationResult & { ready: boolean; discarded?: CitationDiscards } {
  const empty = {
    columnsAdded: [],
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: false,
    ready: false,
  };
  let begun = false;
  try {
    const before = inspectRecordLinkSchema(client);
    if (before.marker === '1') return { ...empty, alreadyCurrent: true, ready: true, warnings: [] };
    if (!callMayWrite())
      throw new Error('Citation schema migration is deferred to a write; this call is read-only');
    return asLazyRepair(() => {
      requireLinkSuccess(client.raw('BEGIN IMMEDIATE'), 'citation migration lock');
      begun = true;
      const state = inspectRecordLinkSchema(client);
      if (state.marker === '1') {
        requireLinkSuccess(client.raw('COMMIT'), 'citation migration commit');
        begun = false;
        return { ...empty, alreadyCurrent: true, ready: true, warnings: [] };
      }
      const inventory = loadLinkInventory(client, true);
      if (!state.table)
        requireLinkSuccess(client.raw(RECORD_LINKS_TABLE_SQL), 'create citation table');
      if (!state.index)
        requireLinkSuccess(client.raw(RECORD_LINKS_INDEX_SQL), 'create citation index');
      const repaired = repairLinkSources(client, inventory, inventory.sources);
      requireLinkSuccess(
        client.execute(
          'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          [RECORD_LINKS_MARKER, '1']
        ),
        'stamp citation migration'
      );
      requireLinkSuccess(client.raw('COMMIT'), 'citation migration commit');
      begun = false;
      return {
        ...empty,
        indexesCreated: state.index ? [] : ['idx_record_links_target'],
        rowsUpdated: repaired.linksChanged,
        discarded: repaired.discarded,
        ready: true,
        warnings: [],
      };
    });
  } catch (error) {
    const warnings = [
      `RECORD_LINKS_MIGRATION_FAILED: ${error instanceof Error ? error.message : String(error)}. Repair citation schema before recording.`,
    ];
    if (begun) {
      const rollback = client.raw('ROLLBACK');
      if (!rollback.success)
        warnings.push(
          `RECORD_LINKS_ROLLBACK_FAILED: ${rollback.error?.message ?? 'unknown rollback failure'}`
        );
    }
    return { ...empty, warnings };
  }
}
