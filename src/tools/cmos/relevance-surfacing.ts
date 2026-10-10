// ABOUTME: Surfaces decisions from the production retriever with a rich-text overlap floor.
// ABOUTME: Emits headline previews while scoring persisted decision context and alternatives.
/**
 * Relevance Surfacing
 *
 * Finds active decisions relevant to a mission's objective and success criteria.
 * Sprint 66 m05: routes through HybridRetriever (BM25 + sqlite-vec via RRF k=60)
 * so paraphrase queries surface decisions whose surface keywords don't overlap.
 *
 * @module tools/cmos/relevance-surfacing
 */

import { prepareSpinOutRead } from './spin-out-read';
import type { CmosDatabaseClient } from './client';
import type { CmosToolResult } from './types';
import { HybridRetriever } from './fts5-retriever';
import { extractKeywords } from './supersession-detection';
import { previewText } from './text-preview';
import {
  composeDecisionText,
  decisionTextProjection,
  type DecisionTextRow,
} from './decision-fields';
import { recordStoreUpkeepNote } from './tool-call-context';

const MAX_RELEVANT_DECISIONS = 5;
const MIN_RELEVANCE_KEYWORDS = 2;

export interface RelevantDecision {
  /** Decision ID */
  id: number;

  /**
   * s92-m08: a preview of the decision text, at most 300 characters (retrieval R5). Scoring
   * read the full text; read it in full with cmos_decisions(action="show", decisionId).
   */
  decisionText: string;

  /** s92-m08: whether decisionText was cut, and the full text's length. */
  truncated: boolean;
  fullLength: number;

  /** s92-m08: the decision's status. */
  status: string | null;

  /** Category (architectural, process, tooling, etc.) */
  category: string | null;

  /** Sprint where the decision was made */
  sprintId: string | null;

  /**
   * s83-m06: the decision's genesis project_id (null on ancient stores). A
   * pull-merged decision carries the FOREIGN origin's id; the mission-start
   * renderer frames it as untrusted when it differs from the local project.
   */
  projectId: string | null;

  /** Evidence references (JSON array of TraceLab refs) */
  evidence: string | null;

  /** Number of keyword matches */
  relevanceScore: number;
}

/**
 * Find decisions relevant to a mission's objective and criteria: every status but superseded
 * (s92-m07), each carrying its status.
 *
 * Routes the mission text through HybridRetriever (BM25 + sqlite-vec) and
 * maps the top hits into RelevantDecision rows. The keyword-overlap count is
 * preserved as `relevanceScore` so existing telemetry/displays don't change
 * shape. A minimum-keyword guard short-circuits before any DB call so
 * single-word missions still no-op cheaply.
 */
export async function findRelevantDecisions(
  client: CmosDatabaseClient,
  missionText: string
): Promise<RelevantDecision[]> {
  const keywords = extractKeywords(missionText);

  if (keywords.length < MIN_RELEVANCE_KEYWORDS) {
    return [];
  }

  const retriever = new HybridRetriever(client);
  const results = await retriever.search(missionText, {
    types: ['decision'],
    limit: MAX_RELEVANT_DECISIONS,
    // s92-m07 (R1): no statusFilter, so only superseded rows drop out. A decision archived at a
    // sprint close is still the record; on 276 mission -> decision citations, active-only surfacing
    // found 0.192 of what the mission text named (R@5), and dropping only superseded rows 0.320.
    // Recall uses citation edges; mutation-oriented precision callers keep the opt-in off.
    citationRecall: true,
  });

  if (!results.length) return [];
  const columns = client.getMany<{ name: string }>('PRAGMA table_info(strategic_decisions)');
  const rich: CmosToolResult<(DecisionTextRow & { id: number })[]> = columns.success
    ? client.getMany<DecisionTextRow & { id: number }>(
        `SELECT id,decision_text,${decisionTextProjection(new Set(columns.data?.map((c) => c.name) ?? []))}
     FROM strategic_decisions WHERE id IN (${results.map(() => '?').join(',')})`,
        results.map((r) => Number(r.id))
      )
    : { success: false, error: columns.error };
  if (!rich.success) {
    const warning =
      'DECISION_OVERLAP_READ_FAILED: rich decision text could not be read; mission context is unavailable.';
    recordStoreUpkeepNote(warning);
    console.error(warning);
    return [];
  }
  const visibility = prepareSpinOutRead(client);
  const fullTexts = new Map((rich.data ?? []).map((row) => [row.id, composeDecisionText(row)]));
  return results
    .filter((r) => !visibility.hidden('decision', r.id))
    .map((r) => {
      const preview = previewText(r.text);
      return {
        id: typeof r.id === 'number' ? r.id : Number(r.id),
        decisionText: preview.preview,
        truncated: preview.truncated,
        fullLength: preview.fullLength,
        status: r.status,
        category: r.category,
        sprintId: r.sprintId,
        projectId: r.projectId,
        evidence: r.evidence,
        // Scored on the FULL text: the preview would undercount long decisions.
        relevanceScore: countOverlap(fullTexts.get(Number(r.id)) ?? r.text, keywords),
      };
    })
    .filter((d) => d.relevanceScore >= MIN_RELEVANCE_KEYWORDS);
}

/**
 * Build a search string from mission objective and success criteria.
 */
export function buildMissionSearchText(
  objective: string | null,
  successCriteria: string | null
): string {
  const parts: string[] = [];
  if (objective) parts.push(objective);
  if (successCriteria) {
    try {
      const parsed = JSON.parse(successCriteria);
      if (Array.isArray(parsed)) {
        parts.push(...parsed.filter((s: unknown) => typeof s === 'string'));
      }
    } catch {
      parts.push(successCriteria);
    }
  }
  return parts.join(' ');
}

function countOverlap(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((count, kw) => count + (lower.includes(kw) ? 1 : 0), 0);
}
