// ABOUTME: Layer 3 working retrieval. HybridRetriever (async, BM25 + sqlite-vec cosine via RRF k=60,
// recency applied after fusion) is the Sprint 66 m04 backend covering decisions, learnings, and missions
// per cmos/planning/adr/s66-vector-retrieval.md. (s80-m03: the dead sync FTS5Retriever was removed.)

import { getEmbedder, packEmbedding, type Embedder } from '../../intelligence/embedding-pipeline';
import type { CmosDatabaseClient } from './client';
import { ensureDecisionsFts5, ensureVectorStorage } from './schema-migrations';
import { extractKeywords } from './supersession-detection';

// ─── Public Interface ─────────────────────────────────────────────────────────

export type RankedResultType = 'decision' | 'learning' | 'mission' | 'session';

/** A single ranked retrieval result. */
export interface RankedResult {
  /** Unique row ID in the source table. INTEGER for decisions/learnings, TEXT for missions. */
  id: number | string;

  /** Content type */
  type: RankedResultType;

  /** The primary text of the result */
  text: string;

  /** Combined relevance + recency score (higher is better) */
  score: number;

  /** Raw BM25 score from FTS5 (positive, higher is better). 0 when only the vector arm matched. */
  bm25Score: number;

  /** Recency decay factor 0–1 (1 = fresh, approaches 0 for old items) */
  recencyFactor: number;

  /** Age in days at retrieval time */
  ageDays: number;

  /** Sprint the item belongs to (null if unknown) */
  sprintId: string | null;

  /** Item category (decisions only, null otherwise) */
  category: string | null;

  /** Evidence references (decisions only, null otherwise) */
  evidence: string | null;

  /** ISO timestamp the item was created */
  createdAt: string | null;

  /** Cosine similarity from the vector arm (vector/hybrid backends only; null for fts5-only) */
  vectorSimilarity?: number | null;

  /** Pre-recency RRF score (hybrid backend only; null otherwise) */
  rrfScore?: number | null;
}

/** Options for retrieval. */
export interface RetrievalOptions {
  /** Max results to return (default: 5) */
  limit?: number;

  /** Content types to include (default: ['decision']) */
  types?: RankedResultType[];

  /** Last N sprints to include (0 = all, default: 0) */
  sprintRange?: number;

  /** Weight given to recency decay: 0 = pure BM25, 1 = full decay (default: 0.5) */
  recencyWeight?: number;

  /** Minimum combined score to include in results (default: 0) */
  minScore?: number;

  /** Status filter for decisions (default: ['active']) */
  statusFilter?: string[];

  /** RRF k parameter for the hybrid backend (default: 60 per s66 ADR Decision 3). */
  rrfK?: number;
}

/** What a retriever backend supports. */
export interface RetrieverCapabilities {
  /** Backend identifier */
  backend: 'fts5' | 'vector' | 'hybrid';

  /** Whether semantic (embedding-based) search is supported */
  semanticSearch: boolean;

  /** Content types this retriever can search */
  supportedTypes: RankedResultType[];

  /** Whether recency boost is applied */
  recencyBoost: boolean;
}

/**
 * Async retrieval interface for backends that require non-blocking I/O on the search path
 * (e.g. query embedding via @xenova/transformers). Implemented by HybridRetriever.
 * (s80-m03: the sync `IRetriever` + its sole implementor `FTS5Retriever` were deleted.)
 */
export interface IAsyncRetriever {
  search(query: string, options?: RetrievalOptions): Promise<RankedResult[]>;
  get(id: number | string, type: RankedResultType): RankedResult | null;
  capabilities(): RetrieverCapabilities;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Recency decay half-life in days. After this many days, score is halved. */
const RECENCY_HALF_LIFE_DAYS = 60;

/** Default recency weight (blend between BM25 and recency decay). Empirically tuned
 *  in Sprint 67 m02 against the production fixture set (cmos/db/cmos.sqlite, 22
 *  hand-authored paraphrases) — 0.2 wins MRR@10 over the canonical 0.5 because the
 *  active-decision corpus skews older and aggressive recency decay penalizes the
 *  expected hits below their RRF-fused rank. See decision captured at s67-m02 close. */
const DEFAULT_RECENCY_WEIGHT = 0.2;

/** Default number of results to return. */
const DEFAULT_LIMIT = 5;

/** FTS5 candidate pool multiplier before score filtering. */
const CANDIDATE_POOL_MULTIPLIER = 5;

/** Reciprocal Rank Fusion `k` parameter — Cormack et al. 2009 used k=60 as a canonical
 *  default; the Sprint 67 m02 sweep against the production fixtures preferred k=30 (a
 *  smaller k inflates 1/(k+rank) for top ranks, sharpening the fused signal when both
 *  arms agree on a candidate). See decision captured at s67-m02 close. */
const DEFAULT_RRF_K = 30;

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Compute the recency decay factor for an item created at the given ISO timestamp.
 * Formula: exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
 * Range: 0–1 (1 = just created, approaches 0 for very old items).
 */
export function computeRecencyFactor(ageDays: number): number {
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Compute item age in days from its created_at ISO timestamp.
 * Returns 0 for null/invalid timestamps (treat as current).
 */
export function computeAgeDays(createdAt: string | null): number {
  if (!createdAt) return 0;
  const created = new Date(createdAt).getTime();
  if (isNaN(created)) return 0;
  const nowMs = Date.now();
  return Math.max(0, (nowMs - created) / (1000 * 60 * 60 * 24));
}

// ─── HybridRetriever ──────────────────────────────────────────────────────────

/** Subset of RankedResultType supported by the hybrid backend (no `session`). */
type RetrievableType = 'decision' | 'learning' | 'mission';

/** Normalized source-row shape feeding RankedResult assembly. */
interface SourceRow {
  id: number | string;
  text: string;
  sprintId: string | null;
  category: string | null;
  evidence: string | null;
  createdAt: string | null;
}

/**
 * Hybrid retriever — Sprint 66 m04.
 *
 * Backends:
 * - `vector` — pure k-NN cosine similarity over the `<type>_vec` virtual tables.
 *   Pulls `limit × CANDIDATE_POOL_MULTIPLIER` neighbours, scores `cosine × recency`,
 *   returns top-`limit`.
 * - `hybrid` — Reciprocal Rank Fusion of BM25 (FTS5 `<type>_fts`) and vector cosine.
 *   RRF score: `Σ 1 / (k + rank_i)` across both arms (k=60). Recency is applied
 *   multiplicatively to the fused score, keeping recency orthogonal to ranking.
 *
 * Covers all three retrievable types (decision, learning, mission). Async because
 * query embedding via `@xenova/transformers` is async (~10–50 ms after warmup;
 * the embedder caches after first load).
 *
 * Failure posture (Decision 4 of the s66 ADR): if the embedder throws,
 * `vector` returns []; `hybrid` degrades to BM25-only ranking.
 *
 * Architecture: cmos/planning/adr/s66-vector-retrieval.md (Decision 3 — RRF formula).
 */
export class HybridRetriever implements IAsyncRetriever {
  constructor(
    private readonly client: CmosDatabaseClient,
    private readonly hybridOptions: {
      backend?: 'vector' | 'hybrid';
      /** Test-only embedder override. Production callers omit this and let
       *  the singleton in embedding-pipeline.ts resolve. */
      embedder?: Embedder;
    } = {}
  ) {}

  capabilities(): RetrieverCapabilities {
    return {
      backend: this.hybridOptions.backend ?? 'hybrid',
      semanticSearch: true,
      supportedTypes: ['decision', 'learning', 'mission'],
      recencyBoost: true,
    };
  }

  async search(query: string, options: RetrievalOptions = {}): Promise<RankedResult[]> {
    const backend = this.hybridOptions.backend ?? 'hybrid';
    const {
      limit = DEFAULT_LIMIT,
      types = ['decision'],
      recencyWeight = DEFAULT_RECENCY_WEIGHT,
      minScore = 0,
      statusFilter = ['active'],
      rrfK = DEFAULT_RRF_K,
    } = options;

    // Ensure the FTS5 + vec0 substrate exists. Idempotent at the migration layer.
    ensureDecisionsFts5(this.client);
    ensureVectorStorage(this.client);

    const queryVec = await this.embedQuery(query);
    const candidateLimit = Math.max(1, limit * CANDIDATE_POOL_MULTIPLIER);
    const aggregated: RankedResult[] = [];

    for (const t of types) {
      if (t !== 'decision' && t !== 'learning' && t !== 'mission') continue;
      const type = t as RetrievableType;

      const perType =
        backend === 'vector'
          ? this.searchVectorForType(type, queryVec, candidateLimit, recencyWeight, statusFilter)
          : this.searchHybridForType(
              type,
              query,
              queryVec,
              candidateLimit,
              recencyWeight,
              statusFilter,
              rrfK
            );
      aggregated.push(...perType);
    }

    return aggregated
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get(id: number | string, type: RankedResultType): RankedResult | null {
    if (type !== 'decision' && type !== 'learning' && type !== 'mission') return null;
    const rt = type as RetrievableType;
    const rows = this.fetchSourceRows(rt, [id], []);
    if (rows.length === 0) return null;
    const row = rows[0];
    const ageDays = computeAgeDays(row.createdAt);
    const recencyFactor = computeRecencyFactor(ageDays);
    return {
      id: row.id,
      type: rt,
      text: row.text,
      score: recencyFactor,
      bm25Score: 1.0,
      recencyFactor,
      ageDays,
      sprintId: row.sprintId,
      category: row.category,
      evidence: row.evidence,
      createdAt: row.createdAt,
      vectorSimilarity: null,
      rrfScore: null,
    };
  }

  // ─── Private: embedding ────────────────────────────────────────────────────

  private async embedQuery(query: string): Promise<Float32Array | null> {
    try {
      const embedder = this.hybridOptions.embedder ?? (await getEmbedder());
      return await embedder(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      console.error(`[WARN] HybridRetriever: query embed failed — ${message}`);
      return null;
    }
  }

  // ─── Private: pure vector branch ───────────────────────────────────────────

  private searchVectorForType(
    type: RetrievableType,
    queryVec: Float32Array | null,
    candidateLimit: number,
    recencyWeight: number,
    statusFilter: string[]
  ): RankedResult[] {
    if (queryVec === null) return [];
    const vecCandidates = this.vectorCandidatesForType(type, queryVec, candidateLimit);
    if (vecCandidates.length === 0) return [];

    const ids = vecCandidates.map((c) => c.id);
    const rows = this.fetchSourceRows(type, ids, statusFilter);
    const rowById = new Map(rows.map((r) => [String(r.id), r]));

    const results: RankedResult[] = [];
    for (const candidate of vecCandidates) {
      const row = rowById.get(String(candidate.id));
      if (!row) continue; // candidate filtered out by status filter (e.g. superseded decision)
      const similarity = distanceToCosineSimilarity(candidate.distance);
      const ageDays = computeAgeDays(row.createdAt);
      const recencyFactor = computeRecencyFactor(ageDays);
      const score = similarity * (1 - recencyWeight + recencyWeight * recencyFactor);
      results.push({
        id: row.id,
        type,
        text: row.text,
        score,
        bm25Score: 0,
        recencyFactor,
        ageDays,
        sprintId: row.sprintId,
        category: row.category,
        evidence: row.evidence,
        createdAt: row.createdAt,
        vectorSimilarity: similarity,
        rrfScore: null,
      });
    }
    return results;
  }

  // ─── Private: hybrid branch (RRF fusion) ───────────────────────────────────

  private searchHybridForType(
    type: RetrievableType,
    query: string,
    queryVec: Float32Array | null,
    candidateLimit: number,
    recencyWeight: number,
    statusFilter: string[],
    rrfK: number
  ): RankedResult[] {
    const bm25Candidates = this.fts5CandidatesForType(type, query, candidateLimit);
    const vecCandidates =
      queryVec !== null ? this.vectorCandidatesForType(type, queryVec, candidateLimit) : [];

    // Build per-arm rank maps keyed by stringified id (the canonical cross-type identifier).
    // Ranks are 1-indexed for RRF: `Σ 1 / (k + rank_i)`.
    const bm25Rank = new Map<string, number>();
    const bm25Raw = new Map<string, number>();
    bm25Candidates.forEach((c, idx) => {
      const key = String(c.id);
      bm25Rank.set(key, idx + 1);
      // FTS5 rank is negative — flip to positive for the telemetry-friendly bm25Score field.
      bm25Raw.set(key, Math.abs(c.rank));
    });

    const vecRank = new Map<string, number>();
    const vecSim = new Map<string, number>();
    vecCandidates.forEach((c, idx) => {
      const key = String(c.id);
      vecRank.set(key, idx + 1);
      vecSim.set(key, distanceToCosineSimilarity(c.distance));
    });

    // Union of candidate IDs preserving first-seen order so the post-fetch loop is deterministic.
    const allIds: Array<number | string> = [];
    const seen = new Set<string>();
    for (const c of bm25Candidates) {
      const key = String(c.id);
      if (!seen.has(key)) {
        seen.add(key);
        allIds.push(c.id);
      }
    }
    for (const c of vecCandidates) {
      const key = String(c.id);
      if (!seen.has(key)) {
        seen.add(key);
        allIds.push(c.id);
      }
    }

    if (allIds.length === 0) return [];

    const rows = this.fetchSourceRows(type, allIds, statusFilter);
    const results: RankedResult[] = [];
    for (const row of rows) {
      const key = String(row.id);
      const bm = bm25Rank.get(key);
      const vk = vecRank.get(key);
      const rrf =
        (bm !== undefined ? 1 / (rrfK + bm) : 0) + (vk !== undefined ? 1 / (rrfK + vk) : 0);
      const ageDays = computeAgeDays(row.createdAt);
      const recencyFactor = computeRecencyFactor(ageDays);
      const finalScore = rrf * (1 - recencyWeight + recencyWeight * recencyFactor);
      results.push({
        id: row.id,
        type,
        text: row.text,
        score: finalScore,
        bm25Score: bm25Raw.get(key) ?? 0,
        recencyFactor,
        ageDays,
        sprintId: row.sprintId,
        category: row.category,
        evidence: row.evidence,
        createdAt: row.createdAt,
        vectorSimilarity: vecSim.get(key) ?? null,
        rrfScore: rrf,
      });
    }
    return results;
  }

  // ─── Private: BM25 candidates per type ─────────────────────────────────────

  private fts5CandidatesForType(
    type: RetrievableType,
    query: string,
    candidateLimit: number
  ): Array<{ id: number | string; rank: number }> {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];

    const ftsTable = ftsTableForType(type);
    const tableCheck = this.client.getOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [ftsTable]
    );
    if (!tableCheck.success || !tableCheck.data) return [];

    const ftsQuery = keywords
      .slice(0, 10)
      .map((k) => `"${k.replace(/"/g, '""')}"`)
      .join(' OR ');

    let raw: Array<{ rowid: number; rank: number }>;
    try {
      const result = this.client.getMany<{ rowid: number; rank: number }>(
        `SELECT rowid, rank FROM ${ftsTable}
         WHERE ${ftsTable} MATCH ?
         ORDER BY rank
         LIMIT ?`,
        [ftsQuery, candidateLimit]
      );
      if (!result.success || !result.data) return [];
      raw = result.data;
    } catch {
      return [];
    }

    // For decisions and learnings, rowid == id (INTEGER PRIMARY KEY AUTOINCREMENT aliases rowid).
    // For missions, missions_fts.rowid maps to missions.rowid (auto-allocated); translate to the
    // public TEXT id via a single batched lookup before returning.
    if (type === 'mission') {
      if (raw.length === 0) return [];
      const placeholders = raw.map(() => '?').join(', ');
      const idLookup = this.client.getMany<{ rowid: number; id: string }>(
        `SELECT rowid, id FROM missions WHERE rowid IN (${placeholders})`,
        raw.map((r) => r.rowid)
      );
      const rowidToId = new Map<number, string>();
      (idLookup.data ?? []).forEach((r) => rowidToId.set(r.rowid, r.id));
      const out: Array<{ id: number | string; rank: number }> = [];
      for (const r of raw) {
        const publicId = rowidToId.get(r.rowid);
        if (publicId) out.push({ id: publicId, rank: r.rank });
      }
      return out;
    }

    return raw.map((r) => ({ id: r.rowid, rank: r.rank }));
  }

  // ─── Private: vector candidates per type ───────────────────────────────────

  private vectorCandidatesForType(
    type: RetrievableType,
    queryVec: Float32Array,
    candidateLimit: number
  ): Array<{ id: number | string; distance: number }> {
    const vecTable = vecTableForType(type);
    const idColumn = vecIdColumnForType(type);

    const blob = packEmbedding(queryVec);
    try {
      const result = this.client.getMany<{ id: number | string; distance: number }>(
        `SELECT ${idColumn} AS id, distance FROM ${vecTable}
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
        [blob, candidateLimit]
      );
      if (!result.success || !result.data) return [];
      return result.data.map((r) => ({ id: r.id, distance: r.distance }));
    } catch {
      return [];
    }
  }

  // ─── Private: source row fetch per type ────────────────────────────────────

  private fetchSourceRows(
    type: RetrievableType,
    ids: Array<number | string>,
    statusFilter: string[]
  ): SourceRow[] {
    if (ids.length === 0) return [];
    if (type === 'decision') return this.fetchDecisionRows(ids as number[], statusFilter);
    if (type === 'learning') return this.fetchLearningRows(ids as number[], statusFilter);
    return this.fetchMissionRows(ids as string[]);
  }

  private fetchDecisionRows(ids: number[], statusFilter: string[]): SourceRow[] {
    const idPlaceholders = ids.map(() => '?').join(', ');
    const applyStatus = statusFilter.length > 0;
    const statusClause = applyStatus
      ? ` AND status IN (${statusFilter.map(() => '?').join(', ')})`
      : '';
    const result = this.client.getMany<{
      id: number;
      decision_text: string;
      category: string | null;
      sprint_id: string | null;
      evidence: string | null;
      created_at: string | null;
    }>(
      `SELECT id, decision_text, category, sprint_id, evidence, created_at
       FROM strategic_decisions
       WHERE id IN (${idPlaceholders})${statusClause}`,
      applyStatus ? [...ids, ...statusFilter] : ids
    );
    if (!result.success || !result.data) return [];
    return result.data.map((r) => ({
      id: r.id,
      text: r.decision_text,
      sprintId: r.sprint_id,
      category: r.category,
      evidence: r.evidence,
      createdAt: r.created_at,
    }));
  }

  private fetchLearningRows(ids: number[], statusFilter: string[]): SourceRow[] {
    const idPlaceholders = ids.map(() => '?').join(', ');
    const applyStatus = statusFilter.length > 0;
    const statusClause = applyStatus
      ? ` AND status IN (${statusFilter.map(() => '?').join(', ')})`
      : '';
    const result = this.client.getMany<{
      id: number;
      content: string;
      category: string | null;
      sprint_id: string | null;
      created_at: string | null;
    }>(
      `SELECT id, content, category, sprint_id, created_at
       FROM learnings
       WHERE id IN (${idPlaceholders})${statusClause}`,
      applyStatus ? [...ids, ...statusFilter] : ids
    );
    if (!result.success || !result.data) return [];
    return result.data.map((r) => ({
      id: r.id,
      text: r.content,
      sprintId: r.sprint_id,
      category: r.category,
      evidence: null,
      createdAt: r.created_at,
    }));
  }

  private fetchMissionRows(ids: string[]): SourceRow[] {
    // Missions don't share the 'active' status convention; their lifecycle states
    // (Queued, In Progress, Completed, ...) are orthogonal. No status filter applied here —
    // callers can post-filter on RankedResult fields if needed.
    const idPlaceholders = ids.map(() => '?').join(', ');
    const result = this.client.getMany<{
      id: string;
      name: string;
      objective: string | null;
      notes: string | null;
      sprint_id: string | null;
      created_at: string | null;
    }>(
      `SELECT id, name, objective, notes, sprint_id, created_at
       FROM missions
       WHERE id IN (${idPlaceholders})`,
      ids
    );
    if (!result.success || !result.data) return [];
    return result.data.map((r) => ({
      id: r.id,
      text: formatMissionText(r.name, r.objective, r.notes),
      sprintId: r.sprint_id,
      category: null,
      evidence: null,
      createdAt: r.created_at,
    }));
  }
}

// ─── Type metadata helpers ────────────────────────────────────────────────────

function ftsTableForType(type: RetrievableType): string {
  switch (type) {
    case 'decision':
      return 'decisions_fts';
    case 'learning':
      return 'learnings_fts';
    case 'mission':
      return 'missions_fts';
  }
}

function vecTableForType(type: RetrievableType): string {
  switch (type) {
    case 'decision':
      return 'decisions_vec';
    case 'learning':
      return 'learnings_vec';
    case 'mission':
      return 'missions_vec';
  }
}

function vecIdColumnForType(type: RetrievableType): string {
  switch (type) {
    case 'decision':
      return 'decision_id';
    case 'learning':
      return 'learning_id';
    case 'mission':
      return 'mission_id';
  }
}

function formatMissionText(name: string, objective: string | null, notes: string | null): string {
  const parts = [name];
  if (objective && objective.trim()) parts.push(` — ${objective.trim()}`);
  if (notes && notes.trim()) parts.push(` | ${notes.trim()}`);
  return parts.join('');
}

/**
 * Convert sqlite-vec's L2 (Euclidean) distance into cosine similarity, valid because
 * the embedding pipeline produces L2-normalized 384-dim vectors (s66 ADR Decision 2,
 * `{ pooling: 'mean', normalize: true }`). For unit vectors:
 *   ||a - b||² = 2 − 2(a · b)  ⇒  cosine_similarity = 1 − distance² / 2
 * Result range is approximately [-1, 1]; numerical noise can produce values slightly > 1
 * on self-matches, harmless for ranking.
 */
function distanceToCosineSimilarity(distance: number): number {
  return 1 - (distance * distance) / 2;
}
