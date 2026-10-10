// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Rewrite only source-proven citation spans, before target IDs can influence resolution.
// ABOUTME: Explicit punctuation preserves local namespaces; unresolved addresses remain parser-inert.
import { citationSpans } from './decision-citations';
import { storedTimeMs } from './stored-time';
import type {
  SpinOutSourceRow,
  SpinOutSourceSnapshot,
  SpinOutIdMapping,
  SpinOutMappingContext,
  SpinOutCitationReport,
  SpinOutKind,
} from './spin-out-types';

export function sourceLocal(projectId: unknown, sourceProjectId: string): boolean {
  return projectId == null || projectId === sourceProjectId;
}
export function spinOutSourceAddress(base: string, kind: string, id: string | number): string {
  return `${base}#${kind}-${encodeURIComponent(id)}`;
}
export function rewriteSpinOutText(
  text: string,
  row: SpinOutSourceRow,
  snapshot: SpinOutSourceSnapshot,
  mapping: readonly SpinOutIdMapping[],
  context: SpinOutMappingContext
): { text: string; report: SpinOutCitationReport } {
  let rewritten = 0,
    qualified = 0;
  const sourceTime = storedTimeMs(
    typeof row.values.created_at === 'string' ? row.values.created_at : null
  );
  const spans = citationSpans(text);
  for (const span of [...spans].reverse()) {
    // An issue/ADR, named foreign attribution or malformed reference already has inert scope.
    // Replacing it with a CMOS address would change what the original author cited.
    if (span.prefix === 'blocked') continue;
    const replacements = span.ids.map((id) => {
      const kind =
        span.prefix === 'd'
          ? 'decision'
          : span.prefix === 'l'
            ? 'learning'
            : span.prefix === 'n'
              ? 'next_step'
              : span.prefix === 'c'
                ? 'constraint'
                : null;
      const possible = snapshot.collisionInventory.filter((entry) => entry.id === id);
      const candidate = kind
        ? possible.find((entry) => entry.kind === kind)
        : possible.length === 1
          ? possible[0]
          : undefined;
      const copyKind: SpinOutKind | undefined =
        candidate?.kind === 'next_step'
          ? 'next-step'
          : candidate?.kind === 'decision' || candidate?.kind === 'learning'
            ? candidate.kind
            : undefined;
      const targetTime = candidate ? storedTimeMs(candidate.created_at) : NaN;
      const copy = copyKind
        ? mapping.find((entry) => entry.source.kind === copyKind && entry.source.id === id)
        : undefined;
      const canMove =
        span.prefix !== 'c' &&
        candidate &&
        copy &&
        sourceLocal(row.values.project_id, snapshot.sourceProjectId) &&
        sourceLocal(candidate.project_id, snapshot.sourceProjectId) &&
        Number.isFinite(sourceTime) &&
        Number.isFinite(targetTime) &&
        targetTime < sourceTime &&
        (kind !== null ||
          possible.every((entry) => Number.isFinite(storedTimeMs(entry.created_at))));
      if (canMove) {
        rewritten++;
        const prefix = copyKind === 'decision' ? 'd' : copyKind === 'learning' ? 'l' : 'n';
        // A bare replacement after an inherited noun can change scope; punctuation is a parser boundary.
        return `— ${prefix}:${copy.target.id}`;
      }
      qualified++;
      return spinOutSourceAddress(context.sourceUri, kind ?? 'citation', id);
    });
    text = text.slice(0, span.start) + replacements.join(', ') + text.slice(span.end);
  }
  return { text, report: { rewritten, qualified } };
}
