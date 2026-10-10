// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Coordinates required citation links with the caller's record transaction.
// ABOUTME: Schema readiness is checked before the transaction; materialization never commits it.

import type { CmosDatabaseClient } from './client';
import type { CitationDiscards } from './record-link-extractor';
import type { CmosToolResult } from './types';
import { createError, createSuccess } from './errors';
import { loadLinkInventory } from './record-link-store';
import { inspectRecordLinkSchema } from './record-link-schema';
import { repairLinkSources } from './record-link-materialize';
export { ensureRecordLinks } from './record-link-migration';
export { readRecordLinks } from './record-link-reader';
export type { RecordLinkReader } from './record-link-store';
export type { RecordLink } from './record-link-extractor';

const failed = (error: unknown): CmosToolResult<never> =>
  createError({
    code: 'RECORD_LINKS_WRITE_FAILED',
    message: `Required citation links failed: ${error instanceof Error ? error.message : String(error)}`,
    suggestion:
      'Retry the record after repairing the citation schema; the required record transaction must roll back.',
  });

export function materializeRecordLinks(
  client: CmosDatabaseClient,
  kind: 'decision' | 'learning',
  id: number
): CmosToolResult<{ linkCount: number; discarded?: CitationDiscards }> {
  try {
    if (inspectRecordLinkSchema(client).marker !== '1')
      throw new Error('Run ensureRecordLinks before the record transaction');
    const inventory = loadLinkInventory(client, true);
    const source = inventory.sources.find((row) => row.kind === kind && row.id === id);
    if (!source) throw new Error(`Required ${kind} ${id} is absent`);
    const result = repairLinkSources(client, inventory, [source]);
    return createSuccess({ linkCount: result.linkCount, discarded: result.discarded });
  } catch (error) {
    return failed(error);
  }
}

/** Full local-source repair is deliberately bounded by this store, including prior sync pages. */
export function repairRecordLinksBatch(
  client: CmosDatabaseClient,
  records: readonly { kind: 'decision' | 'learning'; id: number }[]
): CmosToolResult<{ linksChanged: number; sourcesChecked: number; discarded?: CitationDiscards }> {
  try {
    if (inspectRecordLinkSchema(client).marker !== '1')
      throw new Error('Run ensureRecordLinks before the record transaction');
    const inventory = loadLinkInventory(client, true);
    for (const row of records)
      if (!inventory.sources.some((source) => source.kind === row.kind && source.id === row.id))
        throw new Error(`Required ${row.kind} ${row.id} is absent`);
    if (records.length === 0) return createSuccess({ linksChanged: 0, sourcesChecked: 0 });
    const result = repairLinkSources(client, inventory, inventory.sources);
    return createSuccess({
      linksChanged: result.linksChanged,
      sourcesChecked: inventory.sources.length,
      discarded: result.discarded,
    });
  } catch (error) {
    return failed(error);
  }
}
