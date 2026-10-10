// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Allocate and map copies without opening stores or taking ownership of transactions.
// ABOUTME: Only proven local references move; original source scope remains in per-row provenance.
import type { CmosToolResult } from './types';
import { createError, createSuccess } from './errors';
import { computeContentHash } from './schema-migrations';
import {
  SPIN_OUT_TABLES,
  spinOutKeyText,
  spinOutColumnPolicy,
  validateSpinOutSnapshot,
} from './spin-out-columns';
import { rewriteSpinOutText, sourceLocal } from './spin-out-citations';
import { spinOutEvidence, spinOutMissionMetadata, spinOutProvenance } from './spin-out-provenance';
import type {
  SpinOutReader,
  SpinOutSourceSnapshot,
  SpinOutIdMapping,
  SpinOutMappingContext,
  SpinOutCopyPlan,
  SpinOutKind,
  SpinOutKey,
  SpinOutSqlValue,
} from './spin-out-types';

function failed(error: unknown): CmosToolResult<never> {
  return createError({
    code: 'SPIN_OUT_MAPPING_FAILED',
    message: error instanceof Error ? error.message : String(error),
    suggestion:
      'Review the source and target schema, identities and selected rows before retrying spin-out; do not mark the source after a failed copy.',
  });
}
function requireRead<T>(result: CmosToolResult<T>, label: string): T | undefined {
  if (!result.success) throw new Error(`${label}: ${result.error?.message ?? 'query failed'}`);
  return result.data;
}
const ordered = (snapshot: SpinOutSourceSnapshot) =>
  [...snapshot.rows].sort(
    (a, b) =>
      a.key.kind.localeCompare(b.key.kind) ||
      (typeof a.key.id === 'number' && typeof b.key.id === 'number'
        ? a.key.id - b.key.id
        : String(a.key.id).localeCompare(String(b.key.id)))
  );

/** Caller holds the target write reservation through allocation and all INSERTs. */
export function allocateSpinOutIds(
  target: SpinOutReader,
  snapshot: SpinOutSourceSnapshot
): CmosToolResult<SpinOutIdMapping[]> {
  try {
    validateSpinOutSnapshot(snapshot);
    if (
      !requireRead(
        target.getOne<{ id: string }>('SELECT id FROM contexts WHERE id=?', ['master_context']),
        'Target master context'
      )
    )
      throw new Error('Target master_context is absent');
    const ids = new Map<SpinOutKind, Set<string | number>>();
    for (const [kind, table] of Object.entries(SPIN_OUT_TABLES)) {
      const rows =
        requireRead(
          target.getMany<{ id: string | number }>(`SELECT id FROM ${table}`),
          `${table} target allocation`
        ) ?? [];
      for (const row of rows) spinOutKeyText({ kind, id: row.id } as SpinOutKey);
      ids.set(kind as SpinOutKind, new Set(rows.map((row) => row.id)));
    }
    // A collision suffix must not steal another selected mission's originally free identity.
    const existingMissions = new Set(ids.get('mission'));
    for (const { key } of snapshot.rows)
      if (key.kind === 'mission' && !existingMissions.has(key.id)) ids.get('mission')!.add(key.id);
    return createSuccess(
      ordered(snapshot).map(({ key }) => {
        const used = ids.get(key.kind)!;
        let id: string | number;
        if (key.kind === 'mission') {
          id = key.id;
          if (existingMissions.has(id))
            for (let suffix = 1; used.has(id); suffix++) id = `${key.id}-${suffix}`;
        } else {
          let largest = 0;
          for (const value of used) largest = Math.max(largest, value as number);
          id = largest + 1;
          if (!Number.isSafeInteger(id))
            throw new Error(`Target ${key.kind} id allocation exhausted`);
        }
        used.add(id);
        return { source: key, target: { kind: key.kind, id } as SpinOutKey };
      })
    );
  } catch (error) {
    return failed(error);
  }
}

/** Pure row plans omit genesis; supersession FKs are applied only after the full union exists. */
export function mapSpinOutRows(
  snapshot: SpinOutSourceSnapshot,
  mapping: readonly SpinOutIdMapping[],
  context: SpinOutMappingContext
): CmosToolResult<SpinOutCopyPlan> {
  try {
    validateSpinOutSnapshot(snapshot);
    if (
      context.source.projectId !== snapshot.sourceProjectId ||
      !context.target.projectId.trim() ||
      context.target.projectId === snapshot.sourceProjectId ||
      context.masterContextId !== 'master_context' ||
      !/^cmos:\/\/[^\s#]+$/.test(context.sourceUri)
    )
      throw new Error('Invalid source or target mapping identity');
    const sourceRows = new Map(snapshot.rows.map((row) => [spinOutKeyText(row.key), row]));
    const bySource = new Map<string, SpinOutIdMapping>();
    const targets = new Set<string>();
    for (const pair of mapping) {
      const source = spinOutKeyText(pair.source),
        target = spinOutKeyText(pair.target);
      if (
        pair.source.kind !== pair.target.kind ||
        bySource.has(source) ||
        targets.has(target) ||
        !sourceRows.has(source)
      )
        throw new Error('Incomplete, duplicate or incompatible row mapping');
      bySource.set(source, pair);
      targets.add(target);
    }
    if (bySource.size !== sourceRows.size) throw new Error('Incomplete source row mapping');
    const localMapping = (kind: SpinOutKind, id: SpinOutSqlValue): SpinOutIdMapping | undefined => {
      const key = `${kind}:${id}`,
        row = sourceRows.get(key);
      return row &&
        row.key.id === id &&
        sourceLocal(row.values.project_id, snapshot.sourceProjectId)
        ? bySource.get(key)
        : undefined;
    };
    const deferredSupersessions: { id: number; supersededBy: number }[] = [];
    let rewritten = 0,
      qualified = 0;
    const provenance: SpinOutCopyPlan['provenance'][number][] = [];
    const rows = ordered(snapshot).map((row) => {
      const pair = bySource.get(spinOutKeyText(row.key))!;
      const values: Record<string, SpinOutSqlValue> = {};
      const local = sourceLocal(row.values.project_id, snapshot.sourceProjectId);
      const rewrite = (text: string): string => {
        const result = rewriteSpinOutText(text, row, snapshot, mapping, context);
        rewritten += result.report.rewritten;
        qualified += result.report.qualified;
        return result.text;
      };
      const rewriteArray = (text: string): string => {
        try {
          const parsed: unknown = JSON.parse(text);
          if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
            const next = parsed.map((item) => (typeof item === 'string' ? rewrite(item) : item));
            return JSON.stringify(next) === JSON.stringify(parsed) ? text : JSON.stringify(next);
          }
        } catch {
          /* Historical malformed text is one field, never an inherited array item. */
        }
        return rewrite(text);
      };
      for (const [column, value] of Object.entries(row.values)) {
        const policy = spinOutColumnPolicy(row.key.kind, column);
        switch (policy) {
          case 'genesis':
            break;
          case 'id':
            values[column] = pair.target.id;
            break;
          case 'null':
            values[column] = null;
            break;
          case 'legacy-session':
            values.author_session_id = null;
            break;
          case 'context':
            values[column] = context.masterContextId;
            break;
          case 'mission':
            values[column] = local ? (localMapping('mission', value)?.target.id ?? null) : null;
            break;
          case 'supersession': {
            values[column] = null;
            const target = local ? localMapping('decision', value)?.target : undefined;
            if (target && target.kind !== 'mission' && pair.target.kind !== 'mission')
              deferredSupersessions.push({ id: pair.target.id, supersededBy: target.id });
            break;
          }
          case 'text': {
            // Arbitrary structured mission context has no declared reference paths.
            let structured = false;
            if (column === 'context' && typeof value === 'string') {
              try {
                const parsed: unknown = JSON.parse(value);
                structured = parsed !== null && typeof parsed === 'object';
              } catch {
                /* ordinary text */
              }
            }
            values[column] = typeof value === 'string' && !structured ? rewrite(value) : value;
            break;
          }
          case 'text-array':
            values[column] = typeof value === 'string' ? rewriteArray(value) : value;
            break;
          case 'evidence':
            values[column] = spinOutEvidence(value, row, context);
            break;
          case 'metadata':
            values[column] = spinOutMissionMetadata(value, row, context);
            break;
          case 'domain': {
            values[column] = value;
            if (typeof value !== 'string') break;
            try {
              const parsed: unknown = JSON.parse(value);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
              const original = parsed as Record<string, unknown>,
                next = { ...original };
              for (const key of [
                'blocker',
                'previousBlocker',
                'resolution',
                'droppedReason',
                'deferredReason',
              ])
                if (typeof next[key] === 'string') next[key] = rewrite(next[key]);
              if (Array.isArray(next.blockers))
                next.blockers = next.blockers.map((item) =>
                  typeof item === 'string' ? rewrite(item) : item
                );
              if (JSON.stringify(next) !== JSON.stringify(original))
                values[column] = JSON.stringify(next);
            } catch {
              /* Exact original bytes are preserved, not reset to an empty object. */
            }
            break;
          }
          case 'hash':
            values[column] = null;
            break;
          case 'keep':
            values[column] = value;
            break;
        }
      }
      if (Object.prototype.hasOwnProperty.call(values, 'content_hash')) {
        const text = row.key.kind === 'decision' ? values.decision_text : values.content;
        const domain =
          row.key.kind === 'decision'
            ? (values.project_domain ?? 'general')
            : row.key.kind === 'learning'
              ? (values.category ?? '')
              : 'next-step';
        values.content_hash = computeContentHash(String(text ?? ''), String(domain));
      }
      provenance.push(spinOutProvenance(row, pair, context));
      return { source: row.key, target: pair.target, table: SPIN_OUT_TABLES[row.key.kind], values };
    });
    const dependencies: SpinOutCopyPlan['dependencies'][number][] = [],
      boundaryDependencies: SpinOutCopyPlan['boundaryDependencies'][number][] = [];
    for (const edge of snapshot.dependencies) {
      const from = localMapping('mission', edge.from_id),
        to = localMapping('mission', edge.to_id);
      if (from?.target.kind === 'mission' && to?.target.kind === 'mission')
        dependencies.push({ ...edge, from_id: from.target.id, to_id: to.target.id });
      else boundaryDependencies.push(edge);
    }
    return createSuccess({
      rows,
      deferredSupersessions,
      dependencies,
      boundaryDependencies,
      provenance,
      citationReport: { rewritten, qualified },
    });
  } catch (error) {
    return failed(error);
  }
}
