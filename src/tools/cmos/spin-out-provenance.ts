// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preserve exact approval and reference values separately from the new copy's local identity.
// ABOUTME: Evidence and mission metadata point back to the unchanged source record and its store.
import { isSpinOutReferenceColumn } from './spin-out-columns';
import { spinOutSourceAddress } from './spin-out-citations';
import type {
  SpinOutSourceRow,
  SpinOutIdMapping,
  SpinOutMappingContext,
  SpinOutProvenance,
  SpinOutSqlValue,
} from './spin-out-types';

export function spinOutProvenance(
  row: SpinOutSourceRow,
  mapping: SpinOutIdMapping,
  context: SpinOutMappingContext
): SpinOutProvenance {
  return {
    kind: row.key.kind,
    operationId: context.operationId,
    sourceProjectId: context.source.projectId,
    sourceRoot: context.source.root,
    sourceStorePath: context.source.storePath,
    sourceId: row.key.id,
    targetProjectId: context.target.projectId,
    targetRoot: context.target.root,
    targetId: mapping.target.id,
    originalProjectId: row.values.project_id ?? null,
    originalReferences: Object.fromEntries(
      Object.entries(row.values).filter(
        ([column]) => isSpinOutReferenceColumn(column) || column === 'source_chunk_ids'
      )
    ),
    ...(row.key.kind === 'decision'
      ? {
          originalApproval: {
            mode: row.values.approval_mode ?? null,
            draft: row.values.approval_draft ?? null,
            words: row.values.approval_words ?? null,
          },
        }
      : {}),
  };
}
export function spinOutEvidence(
  value: SpinOutSqlValue,
  row: SpinOutSourceRow,
  context: SpinOutMappingContext
): string {
  let original: unknown[] = [];
  if (typeof value === 'string' && value.length) {
    try {
      const parsed: unknown = JSON.parse(value);
      original = Array.isArray(parsed) ? parsed : [{ type: 'source-evidence', id: value }];
    } catch {
      original = [{ type: 'source-evidence', id: value }];
    }
  }
  return JSON.stringify([
    ...original,
    { type: 'cmos', id: spinOutSourceAddress(context.sourceUri, row.key.kind, row.key.id) },
  ]);
}
export function spinOutMissionMetadata(
  value: SpinOutSqlValue,
  row: SpinOutSourceRow,
  context: SpinOutMappingContext
): string {
  let original: Record<string, unknown> = {};
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        original = parsed as Record<string, unknown>;
    } catch {
      /* The exact malformed original is retained in row provenance. */
    }
  }
  return JSON.stringify({
    ...original,
    source: {
      projectId: context.source.projectId,
      storePath: context.source.storePath,
      id: row.key.id,
      originalProjectId: row.values.project_id ?? null,
    },
  });
}
