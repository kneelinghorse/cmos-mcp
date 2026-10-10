// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Expand eligible local citation neighbors without altering the store or precision defaults.
// ABOUTME: Supersession follows current pointers; bounded one-hop edges retain their seed provenance.
import { readRecordLinks, type RecordLinkReader } from './record-links';
import { requireLinkSuccess } from './record-link-store';
import { recordStoreUpkeepNote } from './tool-call-context';
import { prepareSpinOutRead } from './spin-out-read';

const SEED_LIMIT = 5;
const NEIGHBORS_PER_SEED = 5;
export const CITATION_SUPERSESSION_LIMIT = 32;
type SourceRow = {
  id: number;
  status?: string | null;
  project_id?: string | null;
  superseded_by?: number | null;
};

export interface CitationNeighbor {
  rank: number;
  via: Array<{ seedId: number; direction: 'out' | 'in' }>;
}
export interface CitationExpansion {
  available: boolean;
  bySeed: Map<number, number[]>;
  neighbors: Map<number, CitationNeighbor>;
  warnings: string[];
}
export function citationNeighbors(
  reader: RecordLinkReader,
  kind: 'decision' | 'learning',
  orderedSeedIds: readonly number[],
  options: { statusFilter?: readonly string[]; deadlineAtMs?: number } = {}
): CitationExpansion {
  const empty = (available: boolean, warnings: string[] = []): CitationExpansion => ({
    available,
    bySeed: new Map(),
    neighbors: new Map(),
    warnings,
  });
  const fail = (warnings: string[]): CitationExpansion => {
    for (const warning of warnings) {
      recordStoreUpkeepNote(warning);
      console.error(`[WARN] citationNeighbors: ${warning}`);
    }
    return empty(false, warnings);
  };
  const deadline = (): void => {
    if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
      throw new Error('recall_deadline');
  };
  try {
    deadline();
    const visibility = prepareSpinOutRead(reader);
    const graph = readRecordLinks(reader);
    if (!graph.available) return fail(graph.warnings);
    const table = kind === 'decision' ? 'strategic_decisions' : 'learnings';
    const rows =
      requireLinkSuccess(
        reader.getMany<SourceRow>(`SELECT * FROM ${table}`),
        'citation endpoint rows'
      ) ?? [];
    const project =
      requireLinkSuccess(
        reader.getOne<{ value: string }>('SELECT value FROM metadata WHERE key=?', ['project_id']),
        'citation endpoint identity'
      )?.value ?? null;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const local = (row: SourceRow): boolean => row.project_id == null || row.project_id === project;
    const statusEligible = (row: SourceRow): boolean =>
      row.status !== 'superseded' &&
      (!options.statusFilter?.length ||
        (row.status != null && options.statusFilter.includes(row.status)));
    const hasPointer = (row: SourceRow): boolean =>
      kind === 'decision' && row.superseded_by != null;
    // A source's obsolete text never becomes its superseder's text. Pointer resolution is
    // for target/seed identity only; incoming sources must themselves remain eligible.
    const sourceEligible = (row: SourceRow): boolean =>
      !visibility.hidden(kind, row.id) && local(row) && statusEligible(row) && !hasPointer(row);
    const resolve = (id: number): number | undefined => {
      const seen = new Set<number>();
      for (let hops = 0; hops <= CITATION_SUPERSESSION_LIMIT; hops++) {
        const row = byId.get(id);
        if (!row || visibility.hidden(kind, id) || !local(row) || seen.has(id)) return undefined;
        seen.add(id);
        if (!hasPointer(row)) return statusEligible(row) ? id : undefined;
        if (!Number.isSafeInteger(row.superseded_by) || Number(row.superseded_by) <= 0)
          return undefined;
        id = row.superseded_by!;
      }
      return undefined;
    };
    const seeds: Array<{ id: number; effective: number }> = [];
    const seenSeeds = new Set<number>();
    for (const id of orderedSeedIds) {
      const effective = resolve(id);
      if (effective === undefined || seenSeeds.has(effective)) continue;
      seenSeeds.add(effective);
      seeds.push({ id, effective });
      if (seeds.length === SEED_LIMIT) break;
    }
    const edges = graph.links
      .filter((edge) => edge.from_kind === kind && edge.to_kind === kind)
      .flatMap((edge) => {
        const source = byId.get(edge.from_id);
        const target = resolve(edge.to_id);
        return source && sourceEligible(source) && target !== undefined
          ? [{ from: source.id, to: target }]
          : [];
      });
    const result = empty(true);
    seeds.forEach((seed, index) => {
      deadline();
      const accepted = new Set<number>();
      const add = (id: number, direction: 'out' | 'in'): void => {
        if (
          id === seed.effective ||
          id === seed.id ||
          accepted.has(id) ||
          accepted.size >= NEIGHBORS_PER_SEED
        )
          return;
        accepted.add(id);
        const prior = result.neighbors.get(id);
        const via = { seedId: seed.id, direction };
        if (prior) prior.via.push(via);
        else result.neighbors.set(id, { rank: index + 1, via: [via] });
      };
      // Stable direction/id ordering is independent of SQLite's table scan plan.
      for (const id of edges
        .filter((edge) => edge.from === seed.effective)
        .map((edge) => edge.to)
        .sort((a, b) => a - b))
        add(id, 'out');
      for (const id of edges
        .filter((edge) => edge.to === seed.effective)
        .map((edge) => edge.from)
        .sort((a, b) => a - b))
        add(id, 'in');
      if (accepted.size) result.bySeed.set(seed.id, [...accepted]);
    });
    return result;
  } catch (error) {
    return fail([
      `RECORD_LINKS_READ_FAILED: ${error instanceof Error ? error.message : String(error)}. Citation expansion is unavailable until this query or schema is repaired.`,
    ]);
  }
}
