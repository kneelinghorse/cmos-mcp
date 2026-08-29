/**
 * cmos_learnings list action
 *
 * Lists learnings from the CMOS database with filtering by category,
 * sprint, status, and date range. Supports pagination.
 *
 * @module tools/cmos/cmos-learnings-list
 */

import { withClient } from './client';
import type { CmosToolResult } from './types';
import { createSuccess } from './errors';
import { ensureLearningsTable } from './schema-migrations';
import { getProjectId } from './genesis-columns';
import { frameForeignText } from '../../intelligence/provenance-frame';
import { learningsTaggedAcrossProjects } from '../../intelligence/cross-store-queries';
import type { CrossStoreError, CrossStoreQueryResult } from '../../intelligence/cross-store-query';
import type { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { appendWarnings, attachWarnings } from './format-warnings';

/**
 * Learning record surfaced to clients.
 */
export interface Learning {
  /** Learning ID */
  id: number;

  /** Learning content text */
  content: string;

  /** Category (technical, process, agent-behavior, tooling) */
  category: string | null;

  /** Status (active, archived, superseded) */
  status: string;

  /** Associated sprint ID */
  sprintId: string | null;

  /** Associated session ID */
  sessionId: string | null;

  /** Associated mission ID */
  missionId: string | null;

  /** When the learning was recorded */
  createdAt: string;

  /** s78-m05: the row's genesis project_id (null pre-migration). Compared against the
   *  local store id to frame pull-merged foreign learnings as untrusted. */
  projectId: string | null;

  /**
   * Sprint 61 m03 — institutional-rule flag. When 1, the learning is excluded
   * from staleness flagging and from the staleness count surfaced on agent
   * onboard. Toggle via cmos_learnings(action="update", evergreen=true|false).
   */
  evergreen: boolean;
}

/**
 * Result of learnings list operation.
 */
export interface CmosLearningsListResult {
  /** List of learnings */
  learnings: Learning[];

  /** Total count (for pagination) */
  totalCount: number;

  /** Current page */
  page: number;

  /** Page size used */
  pageSize: number;

  /** Whether there are more results */
  hasMore: boolean;

  /** s78-m05: the querying store's own project_id; rows with a different projectId are
   *  foreign (pull-merged) and framed as untrusted in the render. */
  localProjectId?: string | null;

  /** s79-m05: true on the cross-store (acrossProjects) path — learnings tagged X across the portfolio. */
  acrossProjects?: boolean;

  /** s79-m05: per-store failures (isolated) — present only on the cross-store path. */
  errors?: CrossStoreError[];

  /** s79-m05: fan-out instrumentation — present only on the cross-store path. */
  crossStoreMetadata?: CrossStoreQueryResult['metadata'];
}

/**
 * Input parameters for learnings list action.
 */
export interface CmosLearningsListParams {
  /** Optional: filter by category */
  category?: string;

  /** Optional: filter by sprint ID */
  sprintId?: string;

  /** s85-m04: filter to rows stamped with this mission (#487 read surface) */
  missionId?: string;

  /** Optional: filter by status (default: all) */
  status?: string;

  /** Optional: filter by date range start (ISO format) */
  since?: string;

  /** Optional: filter by date range end (ISO format) */
  until?: string;

  /** Optional: page number (1-indexed, default: 1) */
  page?: number;

  /** Optional: results per page (1-100, default: 20) */
  pageSize?: number;

  /** Optional: explicit project root */
  projectRoot?: string;
}

/**
 * Execute the learnings list action.
 */
export async function cmosLearningsList(
  params: CmosLearningsListParams = {}
): Promise<CmosToolResult<CmosLearningsListResult>> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const warnings: string[] = [];
  const result = await withClient(
    (client) => {
      // Sprint 61 m03: lazy-migrate the evergreen column on read paths so
      // un-migrated DBs don't hit `no such column: evergreen`.
      warnings.push(...(ensureLearningsTable(client).warnings ?? []));

      const conditions: string[] = [];
      const queryParams: (string | number)[] = [];

      if (params.category) {
        conditions.push('category = ?');
        queryParams.push(params.category);
      }

      if (params.sprintId) {
        conditions.push('sprint_id = ?');
        queryParams.push(params.sprintId);
      }

      // s85-m04 (#487): mission -> row trail. Unstamped rows are excluded, not errored.
      if (params.missionId) {
        conditions.push('mission_id = ?');
        queryParams.push(params.missionId);
      }

      if (params.status) {
        conditions.push('status = ?');
        queryParams.push(params.status);
      }

      if (params.since) {
        conditions.push('created_at >= ?');
        queryParams.push(params.since);
      }

      if (params.until) {
        conditions.push('created_at <= ?');
        queryParams.push(params.until);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = client.getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM learnings ${whereClause}`,
        queryParams
      );

      const totalCount = countResult.success && countResult.data ? countResult.data.count : 0;

      // s69-m04: session_id renamed → author_session_id. Resolve the live column
      // (preferring the new name) so this read path works on migrated and legacy
      // snapshot-restored stores alike, without triggering a schema write.
      const learningCols = client.getMany<{ name: string }>("PRAGMA table_info('learnings')", []);
      const sessCol =
        learningCols.success && learningCols.data?.some((c) => c.name === 'author_session_id')
          ? 'author_session_id'
          : 'session_id';
      // s78-m05: surface the genesis project_id when present so pull-merged foreign
      // learnings can be framed as untrusted. NULL on pre-migration stores.
      const projectExpr =
        learningCols.success && learningCols.data?.some((c) => c.name === 'project_id')
          ? 'project_id'
          : 'NULL';

      // Get paginated results
      const listResult = client.getMany<{
        id: number;
        content: string;
        category: string | null;
        status: string;
        sprint_id: string | null;
        session_id: string | null;
        mission_id: string | null;
        created_at: string;
        evergreen: number | null;
        project_id: string | null;
      }>(
        `SELECT id, content, category, status, sprint_id, ${sessCol} AS session_id, mission_id, created_at, evergreen, ${projectExpr} AS project_id
         FROM learnings ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...queryParams, pageSize, offset]
      );

      const learnings: Learning[] =
        listResult.success && listResult.data
          ? listResult.data.map((row) => ({
              id: row.id,
              content: row.content,
              category: row.category,
              status: row.status,
              sprintId: row.sprint_id,
              sessionId: row.session_id,
              missionId: row.mission_id,
              createdAt: row.created_at,
              evergreen: row.evergreen === 1,
              projectId: row.project_id,
            }))
          : [];

      return createSuccess<CmosLearningsListResult>(
        {
          learnings,
          totalCount,
          page,
          pageSize,
          hasMore: offset + learnings.length < totalCount,
          localProjectId: getProjectId(client),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * s79-m05 — `cmos_learnings(list, acrossProjects=true)`. The §5.4 "learnings tagged
 * X across projects" query (query c), backed by the graph-fan-out
 * {@link learningsTaggedAcrossProjects}. The `category` param IS the tag and is
 * REQUIRED (the named query keys on it); a missing category returns a validation
 * error. Rows carry their source `projectId`; per-store failures ride on `errors`.
 * The metadata envelope is identical to `cmos_decisions(acrossProjects)`; the domain
 * payload key is `learnings`. The `registry` seam is for deterministic tests only.
 */
export async function cmosLearningsListAcrossProjects(
  params: {
    category?: string;
    limit?: number;
  },
  // s86-m03 — internal, NON-schema seam, moved out of parameter 0 onto the cmos-review.ts:294
  // precedent: an injectable ProjectGraphRegistry for deterministic tests of the cross-store
  // fan-out. NOT exposed on the tool inputSchema (it must never reach the MCP boundary). Being
  // in parameter 0 made it indistinguishable from a caller-facing param that the router drops.
  internalOpts: { registry?: ProjectGraphRegistry } = {}
): Promise<CmosToolResult<CmosLearningsListResult>> {
  const tag = params.category?.trim();
  if (!tag) {
    return {
      success: false,
      error: {
        code: 'MISSING_PARAMETER',
        message:
          'cmos_learnings(acrossProjects) requires `category` — the portfolio query is "learnings tagged X".',
        suggestion:
          'Pass a category, e.g. cmos_learnings(action="list", acrossProjects=true, category="technical").',
      },
    };
  }

  const pageSize = params.limit ?? 20;
  const fanout = await learningsTaggedAcrossProjects(tag, {
    limit: pageSize,
    registry: internalOpts.registry,
  });

  const learnings: Learning[] = fanout.results.map((row) => ({
    id: row.id,
    content: row.content,
    category: row.category,
    status: 'active',
    sprintId: null,
    sessionId: null,
    missionId: null,
    createdAt: '',
    projectId: row.project_id,
    evergreen: false,
  }));

  return createSuccess<CmosLearningsListResult>({
    learnings,
    totalCount: learnings.length,
    page: 1,
    pageSize,
    hasMore: fanout.metadata.truncated,
    acrossProjects: true,
    errors: fanout.errors,
    crossStoreMetadata: fanout.metadata,
  });
}

/**
 * Format learnings list result for LLM readability.
 */
export function formatLearningsListForLLM(result: CmosToolResult<CmosLearningsListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to retrieve learnings',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  lines.push(data.acrossProjects ? '🌐 **Learnings (portfolio)**' : '📚 **Learnings**');
  lines.push('');
  if (data.acrossProjects && data.crossStoreMetadata) {
    const meta = data.crossStoreMetadata;
    lines.push(
      `${data.learnings.length} learning(s) across ${meta.storesQueried} store(s)` +
        (meta.storesFailed > 0 ? ` — ${meta.storesFailed} unreachable` : '')
    );
  } else {
    lines.push(
      `Showing ${data.learnings.length} of ${data.totalCount} learnings (page ${data.page})`
    );
  }
  lines.push('');

  if (data.learnings.length === 0) {
    lines.push('No learnings found matching the criteria.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  for (const l of data.learnings) {
    const category = l.category ? ` <${l.category}>` : '';
    const sprint = l.sprintId ? ` (${l.sprintId})` : '';
    const mission = l.missionId ? ` {${l.missionId}}` : '';
    const status = l.status !== 'active' ? ` [${l.status}]` : '';
    const evergreen = l.evergreen ? ' [evergreen]' : '';
    const meta = `${category}${sprint}${mission}${status}${evergreen}`;
    // s78-m05: a learning from another project (pull-merged) is foreign, untrusted content —
    // frame its text rather than emitting it as a bare bullet.
    const isForeign =
      l.projectId != null && (data.localProjectId == null || l.projectId !== data.localProjectId);
    if (isForeign) {
      lines.push(`• #${l.id} [proj:${l.projectId}]${meta}`);
      lines.push(frameForeignText(l.content, `proj:${l.projectId}`));
    } else {
      lines.push(`• #${l.id} ${l.content}${meta}`);
    }
    lines.push(`  Created: ${l.createdAt}`);
    lines.push('');
  }

  if (data.hasMore) {
    lines.push(`More results available. Use page=${data.page + 1} to see next page.`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
