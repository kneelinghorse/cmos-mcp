// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Durable reservations prevent overlapping selectors from copying a source row twice.
// ABOUTME: Source and target ledgers bind exact physical stores, payloads and copied graph effects.
import type { CmosDatabaseClient } from './client';
import type {
  SpinOutCopyPlan,
  SpinOutIdMapping,
  SpinOutManifest,
  SpinOutKey,
} from './spin-out-types';
import { SPIN_OUT_TABLES, spinOutKeyText } from './spin-out-columns';
import { SPIN_OUT_ROW_PREFIX, SPIN_OUT_ORIGIN_PREFIX } from './spin-out-types';
import { fingerprintSpinOutPayload } from './spin-out-manifest';
import { requireSpinOut, type BoundSpinOutIdentity } from './spin-out-store';

export interface SpinOutOperation {
  readonly operationId: string;
  readonly source: BoundSpinOutIdentity;
  readonly target: BoundSpinOutIdentity;
  readonly manifest: SpinOutManifest;
  readonly mapping: readonly SpinOutIdMapping[];
  readonly plan: SpinOutCopyPlan;
  readonly phase: 'reserved' | 'marked';
}
export interface SpinOutTargetLedger {
  readonly operation: SpinOutOperation;
  readonly phase: 'copied';
  readonly linkSources: readonly { kind: string; id: number }[];
  readonly proof: string;
}
export function operationKey(id: string): string {
  return `spin_out_operation:${id}`;
}
const reservationKey = (key: SpinOutKey): string => `spin_out_reservation:${spinOutKeyText(key)}`;
export function readSpinOutMetadata<T>(client: CmosDatabaseClient, key: string): T | undefined {
  const row = requireSpinOut(
    client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key=?', [key]),
    `Read ${key}`
  );
  if (!row) return undefined;
  const value: unknown = JSON.parse(row.value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Malformed spin-out metadata ${key}`);
  return value as T;
}
export function writeSpinOutRow(
  client: CmosDatabaseClient,
  sql: string,
  params: unknown[],
  step: string
): void {
  const write = requireSpinOut(client.execute(sql, params), step);
  if (write.changes !== 1)
    throw new Error(`${step}: expected exactly one changed row; received ${write.changes}`);
}
export function writeSpinOutMetadata(
  client: CmosDatabaseClient,
  key: string,
  value: unknown
): void {
  writeSpinOutRow(
    client,
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, JSON.stringify(value)],
    `Write ${key}`
  );
  if (
    fingerprintSpinOutPayload(readSpinOutMetadata(client, key)) !== fingerprintSpinOutPayload(value)
  )
    throw new Error(`Written metadata ${key} did not retain its exact payload`);
}
export function verifySpinOutBinding(
  operation: SpinOutOperation,
  source: BoundSpinOutIdentity,
  target: BoundSpinOutIdentity
): void {
  if (
    !['reserved', 'marked'].includes(operation.phase) ||
    !Array.isArray(operation.mapping) ||
    !operation.plan ||
    !Array.isArray(operation.plan.provenance)
  )
    throw new Error('Malformed spin-out operation; preserve the ledgers for review');
  if (
    fingerprintSpinOutPayload(operation.source) !== fingerprintSpinOutPayload(source) ||
    fingerprintSpinOutPayload(operation.target) !== fingerprintSpinOutPayload(target)
  )
    throw new Error(
      'A bound spin-out store was replaced, moved or re-keyed. Preserve both versions and review the original operation.'
    );
}
export function reserveSpinOut(client: CmosDatabaseClient, operation: SpinOutOperation): void {
  for (const entry of operation.mapping) {
    const finalized = readSpinOutMetadata<{ operationId: string }>(
      client,
      SPIN_OUT_ROW_PREFIX + spinOutKeyText(entry.source)
    );
    if (finalized)
      throw new Error(
        `Source ${spinOutKeyText(entry.source)} was already transferred by ${finalized.operationId}; use its target copy.`
      );
    const owner = readSpinOutMetadata<{ operationId: string }>(
      client,
      reservationKey(entry.source)
    );
    if (owner && owner.operationId !== operation.operationId)
      throw new Error(
        `Source ${spinOutKeyText(entry.source)} is reserved by ${owner.operationId}; finish/review that operation instead of copying it again.`
      );
  }
  for (const entry of operation.mapping)
    writeSpinOutMetadata(client, reservationKey(entry.source), {
      operationId: operation.operationId,
    });
  writeSpinOutMetadata(client, operationKey(operation.operationId), operation);
}
export function verifySpinOutReservations(
  client: CmosDatabaseClient,
  operation: SpinOutOperation
): void {
  for (const entry of operation.mapping)
    if (
      readSpinOutMetadata<{ operationId: string }>(client, reservationKey(entry.source))
        ?.operationId !== operation.operationId
    )
      throw new Error(
        `Reservation for ${spinOutKeyText(entry.source)} no longer belongs to this operation`
      );
}
export function spinOutLinks(client: CmosDatabaseClient): Record<string, unknown>[] {
  return requireSpinOut(
    client.getMany<Record<string, unknown>>(
      'SELECT * FROM record_links ORDER BY from_kind,from_id,to_kind,to_id,resolution'
    ),
    'Read exact record links'
  );
}
export function spinOutTargetProof(
  client: CmosDatabaseClient,
  operation: SpinOutOperation,
  linkSources: readonly { kind: string; id: number }[]
): string {
  const rows = operation.mapping.map(({ target }) => {
    const value = requireSpinOut(
      client.getOne(`SELECT * FROM ${SPIN_OUT_TABLES[target.kind]} WHERE id=?`, [target.id]),
      'Verify mapped target row'
    );
    if (!value) throw new Error(`Mapped target ${spinOutKeyText(target)} is missing`);
    return {
      key: target,
      value,
      origin: readSpinOutMetadata(client, SPIN_OUT_ORIGIN_PREFIX + spinOutKeyText(target)) ?? null,
    };
  });
  const missions = operation.mapping
    .filter((entry) => entry.target.kind === 'mission')
    .map((entry) => entry.target.id);
  const dependencies = requireSpinOut(
    client.getMany(
      `SELECT from_id,to_id,type FROM mission_dependencies WHERE from_id IN (${missions.map(() => '?').join(',')}) OR to_id IN (${missions.map(() => '?').join(',')}) ORDER BY from_id,to_id,type`,
      [...missions, ...missions]
    ),
    'Verify copied dependencies'
  );
  const all = spinOutLinks(client);
  const links = linkSources.map((source) => ({
    source,
    rows: all.filter((row) => row.from_kind === source.kind && row.from_id === source.id),
  }));
  return fingerprintSpinOutPayload({ rows, dependencies, links });
}
export function verifySpinOutTarget(
  client: CmosDatabaseClient,
  operation: SpinOutOperation
): SpinOutTargetLedger | undefined {
  const ledger = readSpinOutMetadata<SpinOutTargetLedger>(
    client,
    operationKey(operation.operationId)
  );
  if (!ledger) return undefined;
  if (
    ledger.phase !== 'copied' ||
    fingerprintSpinOutPayload(ledger.operation) !==
      fingerprintSpinOutPayload({ ...operation, phase: 'reserved' }) ||
    !Array.isArray(ledger.linkSources)
  )
    throw new Error('Committed target operation ledger changed');
  if (spinOutTargetProof(client, operation, ledger.linkSources) !== ledger.proof)
    throw new Error(
      'Committed target rows, provenance, dependencies or links changed; source marking refused'
    );
  return ledger;
}
export function verifySpinOutMarked(client: CmosDatabaseClient, operation: SpinOutOperation): void {
  verifySpinOutReservations(client, operation);
  for (const provenance of operation.plan.provenance) {
    const rowKey = { kind: provenance.kind, id: provenance.sourceId } as SpinOutKey;
    const pointer = readSpinOutMetadata(client, SPIN_OUT_ROW_PREFIX + spinOutKeyText(rowKey));
    if (fingerprintSpinOutPayload(pointer ?? null) !== fingerprintSpinOutPayload(provenance))
      throw new Error(`Completed source pointer ${spinOutKeyText(rowKey)} is missing or changed`);
  }
}
