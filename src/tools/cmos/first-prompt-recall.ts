// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read-only first-prompt decision recall combines keyword rank with bounded explicit citations.
// ABOUTME: Origin/status filters precede caps; no embeddings, migrations, persistent graph, or prompt state.

import Database from 'better-sqlite3';
import { extractKeywords } from './keyword-extraction';
import { decisionCitations } from './decision-citations';
import { storedTimeMs } from './stored-time';
import { previewText } from './text-preview';
import { getProjectId } from './project-id';
import type { CmosDatabaseClient, QueryParams } from './client';
import type { CmosToolResult } from './types';

export interface RecallVia {
  readonly seedId: number;
  readonly direction: 'out' | 'in';
}
export interface RecallItem {
  readonly kind: 'decision';
  readonly id: number;
  readonly status: string;
  readonly projectId: string | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly retrievalSource: 'keyword' | 'citation' | 'keyword+citation';
  readonly via: readonly RecallVia[];
}
export interface RecallResult {
  readonly items: readonly RecallItem[];
  readonly localProjectId: string | null;
  readonly warnings: readonly string[];
  readonly available: boolean;
}
interface Row {
  id: number;
  text: string;
  createdAt: string | null;
  status: string;
  projectId: string | null;
}
interface Options {
  readonly nowMs?: number;
  readonly deadlineAtMs?: number;
}
const DAY_MS = 86_400_000;

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name));
}
function deadline(options: Options): void {
  if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    throw new Error('recall_deadline');
}
function neighbors(
  rows: Row[],
  seeds: Row[],
  options: Options
): Map<number, { rank: number; via: RecallVia[] }> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const citations = new Map<number, number[]>();
  for (const row of rows) {
    deadline(options);
    const created = storedTimeMs(row.createdAt);
    if (!Number.isFinite(created)) continue;
    citations.set(
      row.id,
      decisionCitations(row.text).filter((id) => {
        const target = byId.get(id);
        return id !== row.id && target !== undefined && storedTimeMs(target.createdAt) < created;
      })
    );
  }
  const result = new Map<number, { rank: number; via: RecallVia[] }>();
  seeds.forEach((seed, index) => {
    deadline(options);
    const accepted = new Set<number>();
    const add = (id: number, direction: RecallVia['direction']): void => {
      if (accepted.size >= 5 || accepted.has(id) || id === seed.id) return;
      accepted.add(id);
      const prior = result.get(id);
      if (!prior) result.set(id, { rank: index + 1, via: [{ seedId: seed.id, direction }] });
      else prior.via.push({ seedId: seed.id, direction });
    };
    for (const id of citations.get(seed.id) ?? []) add(id, 'out');
    for (const row of rows) if (citations.get(row.id)?.includes(seed.id)) add(row.id, 'in');
  });
  return result;
}

/** Local/legacy decisions only; unavailable reads are distinguishable from a valid empty result. */
export function recallFirstPrompt(
  dbPath: string,
  query: string,
  options: Options = {}
): RecallResult {
  let db: Database.Database | undefined;
  let localProjectId: string | null = null;
  try {
    deadline(options);
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 50 });
    const cols = columns(db, 'strategic_decisions');
    if (!['id', 'decision_text', 'created_at'].every((name) => cols.has(name)))
      throw new Error('recall_schema_missing');
    if (
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decisions_fts'").get()
    )
      throw new Error('recall_index_missing');
    const identityDb = db;
    const identityReader: Pick<CmosDatabaseClient, 'getOne' | 'path'> = {
      path: dbPath,
      getOne: <T>(sql: string, params?: QueryParams): CmosToolResult<T | undefined> => {
        // SQL/schema errors must reach the outer unavailable result; only a missing row is a
        // legitimate canonical identity fallback.
        const statement = identityDb.prepare(sql);
        return {
          success: true,
          data: (params ? statement.get(params) : statement.get()) as T | undefined,
        };
      },
    };
    localProjectId = getProjectId(identityReader);
    const where = [cols.has('status') ? "(d.status IS NULL OR d.status <> 'superseded')" : '1'];
    const params: (string | null)[] = [];
    if (cols.has('project_id')) {
      where.push('(d.project_id IS NULL OR d.project_id = ?)');
      params.push(localProjectId);
    }
    if (cols.has('superseded_by')) where.push('d.superseded_by IS NULL');
    const fields = `d.id, d.decision_text AS text, d.created_at AS createdAt,
      ${cols.has('status') ? "COALESCE(d.status,'active')" : "'active'"} AS status,
      ${cols.has('project_id') ? 'd.project_id' : 'NULL'} AS projectId`;
    const keywords = extractKeywords(query).slice(0, 64);
    if (!keywords.length) return { items: [], localProjectId, warnings: [], available: true };
    const match = keywords.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR ');
    const candidates = db
      .prepare(
        `SELECT ${fields} FROM decisions_fts JOIN strategic_decisions d ON d.id=decisions_fts.rowid
      WHERE decisions_fts MATCH ? AND ${where.join(' AND ')} ORDER BY decisions_fts.rank,d.id LIMIT 25`
      )
      .all(match, ...params) as Row[];
    deadline(options);
    if (!candidates.length) return { items: [], localProjectId, warnings: [], available: true };
    const rows = db
      .prepare(
        `SELECT ${fields} FROM strategic_decisions d WHERE ${where.join(' AND ')} ORDER BY d.id`
      )
      .all(...params) as Row[];
    const graph = neighbors(rows, candidates.slice(0, 5), options);
    const keywordRank = new Map(candidates.map((row, index) => [row.id, index + 1]));
    const now = options.nowMs ?? Date.now();
    const ranked = rows
      .filter((row) => keywordRank.has(row.id) || graph.has(row.id))
      .map((row) => {
        const keyword = keywordRank.get(row.id);
        const citation = graph.get(row.id);
        const created = storedTimeMs(row.createdAt);
        const age = Number.isFinite(created) ? Math.max(0, (now - created) / DAY_MS) : 0;
        const score =
          ((keyword ? 1 / (30 + keyword) : 0) + (citation ? 0.5 / (30 + citation.rank) : 0)) *
          (0.8 + 0.2 * Math.exp(-age / 60));
        return { row, keyword, citation, score };
      })
      .sort((a, b) => b.score - a.score || a.row.id - b.row.id)
      .slice(0, 5);
    deadline(options);
    const items: RecallItem[] = ranked.map(({ row, keyword, citation }) => {
      const preview = previewText(row.text);
      return {
        kind: 'decision',
        id: row.id,
        status: row.status,
        projectId: row.projectId,
        text: preview.preview,
        truncated: preview.truncated,
        retrievalSource: keyword ? (citation ? 'keyword+citation' : 'keyword') : 'citation',
        via: citation?.via ?? [],
      };
    });
    return { items, localProjectId, warnings: [], available: true };
  } catch (error) {
    const known = ['recall_deadline', 'recall_schema_missing', 'recall_index_missing'];
    const warning =
      error instanceof Error && known.includes(error.message)
        ? error.message
        : 'recall_query_failed';
    return { items: [], localProjectId, warnings: [warning], available: false };
  } finally {
    db?.close();
  }
}
