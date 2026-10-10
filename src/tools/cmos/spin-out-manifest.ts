// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Bind an operation to exact source rows, selection results and citation collision proof.
// ABOUTME: Canonical hashing sorts structural keys while preserving stored text and JSON bytes.
import type { SpinOutSourceSnapshot, SpinOutManifest } from './spin-out-types';
import { createHash } from 'crypto';
import { spinOutKeyText, validateSpinOutSnapshot } from './spin-out-columns';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value)))
    throw new Error('Noncanonical spin-out manifest value');
  return value;
}
export function fingerprintSpinOutPayload(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function captureSpinOutManifest(snapshot: SpinOutSourceSnapshot): SpinOutManifest {
  validateSpinOutSnapshot(snapshot);
  const rows = snapshot.rows
    .map((row) => ({ key: row.key, hash: fingerprintSpinOutPayload(row.values) }))
    .sort((a, b) => spinOutKeyText(a.key).localeCompare(spinOutKeyText(b.key)));
  const dependencyHash = fingerprintSpinOutPayload(
    [...snapshot.dependencies].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
  const collisionHash = fingerprintSpinOutPayload(
    [...snapshot.collisionInventory].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)
    )
  );
  const schemaHash = fingerprintSpinOutPayload(
    Object.fromEntries(
      Object.entries(snapshot.columns).map(([kind, columns]) => [kind, [...columns].sort()])
    )
  );
  const selectionHash = fingerprintSpinOutPayload(snapshot.selectionDescriptor);
  const parts = { selectionHash, schemaHash, collisionHash, rows, dependencyHash };
  return {
    hash: fingerprintSpinOutPayload({ sourceProjectId: snapshot.sourceProjectId, ...parts }),
    ...parts,
  };
}
