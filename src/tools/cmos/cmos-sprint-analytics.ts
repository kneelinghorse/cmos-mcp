/**
 * cmos_sprint analytics action
 *
 * Computes KPIs across sprint history: velocity, completion rate trends,
 * decision volume, session patterns, and cycle time trends.
 * Read-only — does not mutate the database.
 *
 * @module tools/cmos/cmos-sprint-analytics
 */

import { withClient, type CmosDatabaseClient } from './client';
import type { CmosToolResult } from './types';
import { createSuccess } from './errors';
import { appendWarnings } from './format-warnings';
import { ensureSprintSummaryView } from './schema-migrations';
import { parkedColumn } from './sprint-summary-read';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SprintDataPoint {
  sprintId: string;
  title: string;
  status: string | null;
  totalMissions: number;
  completedMissions: number;
  blockedMissions: number;
  /** s86-m08: Deferred + Dropped — outside totalMissions, reported so three sibling read
   *  surfaces (list, show, analytics) cannot disagree about whether parked work is visible. */
  parkedMissions: number;
  completionRate: number;
  avgCycleTimeDays: number | null;
  decisionsCount: number;
  learningsCount: number;
  sessionsCount: number;
  /** Sessions linked to at least one mission via session_missions */
  linkedSessionsCount: number;
}

export interface TrendDirection {
  direction: 'increasing' | 'decreasing' | 'stable';
  /** Change from first half average to second half average */
  changePercent: number;
}

export interface SprintAnalyticsResult {
  /** Per-sprint data points (chronological) */
  sprints: SprintDataPoint[];

  /** Aggregated cross-sprint KPIs */
  aggregates: {
    totalSprints: number;
    completedSprints: number;
    totalMissions: number;
    /** s86-m08: Deferred + Dropped across the window — outside totalMissions, stated so the
     *  TEXT answer discloses what the denominator excluded. */
    totalParked: number;
    totalCompleted: number;
    overallCompletionRate: number;
    avgVelocity: number;
    avgCycleTimeDays: number | null;
    totalDecisions: number;
    totalLearnings: number;
    totalSessions: number;
    totalLinkedSessions: number;
  };

  /** Computed trends (first half vs second half of sprint history) */
  trends: {
    velocity: TrendDirection;
    completionRate: TrendDirection;
    decisionsPerSprint: TrendDirection;
    cycleTime: TrendDirection | null;
  };

  /** Human-readable trend highlights */
  highlights: string[];

  /**
   * s86-m05 — the window these numbers actually describe. Every aggregate, trend and highlight
   * above is computed over exactly these sprints; without this field an operator reading
   * "across recent sprints" has no way to tell WHICH sprints, which is how the inverted-window
   * defect stayed invisible for as long as it did.
   */
  window: {
    /** The `limit` the caller passed, or null for an unbounded read. */
    requestedLimit: number | null;
    /** Sprints actually analyzed (≤ requestedLimit; fewer when the store holds fewer). */
    sprintCount: number;
    /** Oldest and newest sprint in the analyzed window; null when it is empty. */
    oldestSprintId: string | null;
    newestSprintId: string | null;
  };
}

export interface CmosSprintAnalyticsParams {
  /** Optional project root */
  projectRoot?: string;
  /** Limit to last N sprints (default: all completed) */
  limit?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export async function cmosSprintAnalytics(
  params: CmosSprintAnalyticsParams
): Promise<CmosToolResult<SprintAnalyticsResult>> {
  return withClient(
    (client) => {
      // s86-m08: upgrade a pre-migration store's view before reading it (see
      // ensureSprintSummaryView — zero writes once current, never touches a base table).
      const viewMigration = ensureSprintSummaryView(client);

      const { sprints, error: readError } = getSprintDataPoints(
        client,
        params.limit,
        viewMigration.parkedAvailable
      );

      // An unreadable store and an empty one are different facts. Say which one this is.
      const advisories = [...(viewMigration.warnings ?? [])];
      if (readError) {
        advisories.push(
          `sprint_summary could not be read (${readError}); no sprint data is included below — this is NOT a report that the store has no sprints.`
        );
      }

      if (sprints.length === 0) {
        return createSuccess<SprintAnalyticsResult>(
          {
            sprints: [],
            aggregates: {
              totalSprints: 0,
              completedSprints: 0,
              totalMissions: 0,
              totalParked: 0,
              totalCompleted: 0,
              overallCompletionRate: 0,
              avgVelocity: 0,
              avgCycleTimeDays: null,
              totalDecisions: 0,
              totalLearnings: 0,
              totalSessions: 0,
              totalLinkedSessions: 0,
            },
            trends: {
              velocity: { direction: 'stable', changePercent: 0 },
              completionRate: { direction: 'stable', changePercent: 0 },
              decisionsPerSprint: { direction: 'stable', changePercent: 0 },
              cycleTime: null,
            },
            highlights: [
              readError
                ? 'Sprint data could not be read on this store — see warnings. This is not a finding that there are no sprints.'
                : 'No completed sprints found for analysis.',
            ],
            window: {
              requestedLimit: params.limit && params.limit > 0 ? params.limit : null,
              sprintCount: 0,
              oldestSprintId: null,
              newestSprintId: null,
            },
          },
          advisories
        );
      }

      const aggregates = computeAggregates(sprints);
      const trends = computeTrends(sprints);
      const highlights = generateHighlights(sprints, aggregates, trends);

      return createSuccess<SprintAnalyticsResult>(
        {
          sprints,
          aggregates,
          trends,
          highlights,
          // `sprints` is oldest-first by construction (see getSprintDataPoints), so the ends of
          // the array ARE the ends of the window.
          //
          // requestedLimit reports the bound that was APPLIED, not the number that was passed.
          // `limitClause` is built with a truthiness test, so limit=0 (and any negative) produces
          // NO LIMIT clause and the call is unbounded — echoing `0` back would make this field,
          // whose entire purpose is to stop the answer misdescribing its own window, do exactly
          // that. Non-positive limits report null, which is what actually happened.
          window: {
            requestedLimit: params.limit && params.limit > 0 ? params.limit : null,
            sprintCount: sprints.length,
            oldestSprintId: sprints[0].sprintId,
            newestSprintId: sprints[sprints.length - 1].sprintId,
          },
        },
        advisories
      );
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Data Retrieval ──────────────────────────────────────────────────────────

interface SprintSummaryRow {
  sprint_id: string;
  title: string;
  status: string | null;
  total_missions: number;
  completed_missions: number;
  blocked_missions: number;
  parked_missions: number;
  decisions_count: number;
}

function getSprintDataPoints(
  client: CmosDatabaseClient,
  limit: number | undefined,
  parkedAvailable: boolean
): { sprints: SprintDataPoint[]; error: string | null } {
  // Get sprints with mission counts from the sprint_summary view.
  //
  // s86-m05 (next-step #514): this read used to be `ORDER BY sprint_id ASC ${limitClause}`, so
  // `limit=N` returned the OLDEST N sprints while the highlights below called them "recent".
  // Measured on the live store (77 sprints match the filter): limit=8 returned sprint-09..sprint-16
  // and reported velocity trending DOWN 44%, where the unlimited call reports stable +8% — a
  // wrong answer, not a stale one.
  //
  // The bound is applied to a DESC ordering INSIDE a subquery and oldest-first is restored
  // OUTSIDE it, rather than flipping this ORDER BY to DESC. computeTrendDirection compares the
  // first half of the array to the second, so an oldest-first array is what "trend" MEANS here;
  // a bare DESC flip would silently invert every reported direction, which is worse than the
  // bug it fixed. The subquery makes the ordering correct by construction, so a later refactor
  // of the .map() below cannot undo it. With `limit` undefined, limitClause is '' and the outer
  // ASC leaves the unlimited call byte-identical in ordering to its pre-fix behaviour.
  //
  // sprint_id is TEXT, so this ordering is LEXICOGRAPHIC. It is correct only while sprint
  // numbers stay two-digit zero-padded (live range today: sprint-09..sprint-86); at sprint-100,
  // 'sprint-100' sorts before 'sprint-99'. Deliberately NOT fixed here — a next-step row carries
  // it, because widening the key touches every sprint-ordered read in the tree, not just this one.
  const limitClause = limit ? `LIMIT ${Math.floor(limit)}` : '';
  const sprintsResult = client.getMany<SprintSummaryRow>(
    `SELECT * FROM (
       SELECT sprint_id, title, status, total_missions, completed_missions, blocked_missions, ${parkedColumn(parkedAvailable)}, decisions_count
       FROM sprint_summary
       WHERE status IN ('Completed', 'Active')
       ORDER BY sprint_id DESC
       ${limitClause}
     ) ORDER BY sprint_id ASC`
  );

  // s86-m08 critic: this used to `return []`, and the caller then reported "No completed
  // sprints found for analysis" — a confident assertion of ABSENCE built from a swallowed read
  // failure. An empty store and an unreadable one are different facts and now stay different.
  if (!sprintsResult.success || !sprintsResult.data) {
    return {
      sprints: [],
      error: `${sprintsResult.error?.code ?? 'DB_ERROR'} — ${sprintsResult.error?.message ?? 'unknown'}`,
    };
  }

  const sprints = sprintsResult.data.map((row) => {
    const cycleTime = getAvgCycleTime(client, row.sprint_id);
    const learningsCount = getLearningsCount(client, row.sprint_id);
    const sessionsCount = getSessionsCount(client, row.sprint_id);
    const linkedSessionsCount = getLinkedSessionsCount(client, row.sprint_id);

    return {
      sprintId: row.sprint_id,
      title: row.title,
      status: row.status,
      totalMissions: row.total_missions,
      completedMissions: row.completed_missions,
      blockedMissions: row.blocked_missions,
      parkedMissions: row.parked_missions ?? 0,
      completionRate:
        row.total_missions > 0
          ? Math.round((row.completed_missions / row.total_missions) * 100)
          : 0,
      avgCycleTimeDays: cycleTime,
      decisionsCount: row.decisions_count,
      learningsCount,
      sessionsCount,
      linkedSessionsCount,
    };
  });

  return { sprints, error: null };
}

function getAvgCycleTime(client: CmosDatabaseClient, sprintId: string): number | null {
  const result = client.getOne<{ avg_days: number | null }>(
    `SELECT AVG(
       (julianday(completed_at) - julianday(started_at))
     ) AS avg_days
     FROM missions
     WHERE sprint_id = ?
       AND status = 'Completed'
       AND started_at IS NOT NULL
       AND completed_at IS NOT NULL`,
    [sprintId]
  );
  if (!result.success || !result.data || result.data.avg_days === null) return null;
  return Math.round(result.data.avg_days * 100) / 100;
}

function getLearningsCount(client: CmosDatabaseClient, sprintId: string): number {
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM learnings WHERE sprint_id = ?`,
    [sprintId]
  );
  return result.success && result.data ? result.data.count : 0;
}

function getSessionsCount(client: CmosDatabaseClient, sprintId: string): number {
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sessions WHERE sprint_id = ?`,
    [sprintId]
  );
  return result.success && result.data ? result.data.count : 0;
}

function getLinkedSessionsCount(client: CmosDatabaseClient, sprintId: string): number {
  // Check if session_missions table exists
  const tableCheck = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='session_missions'`
  );
  if (!tableCheck.success || !tableCheck.data) return 0;

  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(DISTINCT sm.session_id) AS count
     FROM session_missions sm
     JOIN sessions s ON s.id = sm.session_id
     WHERE s.sprint_id = ?`,
    [sprintId]
  );
  return result.success && result.data ? result.data.count : 0;
}

// ─── Aggregate Computation ───────────────────────────────────────────────────

function computeAggregates(sprints: SprintDataPoint[]): SprintAnalyticsResult['aggregates'] {
  const completedSprints = sprints.filter((s) => s.status === 'Completed');
  const totalMissions = sprints.reduce((sum, s) => sum + s.totalMissions, 0);
  const totalParked = sprints.reduce((sum, s) => sum + (s.parkedMissions ?? 0), 0);
  const totalCompleted = sprints.reduce((sum, s) => sum + s.completedMissions, 0);
  const totalDecisions = sprints.reduce((sum, s) => sum + s.decisionsCount, 0);
  const totalLearnings = sprints.reduce((sum, s) => sum + s.learningsCount, 0);
  const totalSessions = sprints.reduce((sum, s) => sum + s.sessionsCount, 0);
  const totalLinkedSessions = sprints.reduce((sum, s) => sum + s.linkedSessionsCount, 0);

  const cycleTimes = sprints
    .map((s) => s.avgCycleTimeDays)
    .filter((ct): ct is number => ct !== null);
  const avgCycleTimeDays =
    cycleTimes.length > 0
      ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 100) / 100
      : null;

  const avgVelocity =
    completedSprints.length > 0
      ? Math.round(
          (completedSprints.reduce((sum, s) => sum + s.completedMissions, 0) /
            completedSprints.length) *
            100
        ) / 100
      : 0;

  return {
    totalSprints: sprints.length,
    completedSprints: completedSprints.length,
    totalMissions,
    totalParked,
    totalCompleted,
    overallCompletionRate:
      totalMissions > 0 ? Math.round((totalCompleted / totalMissions) * 100) : 0,
    avgVelocity,
    avgCycleTimeDays,
    totalDecisions,
    totalLearnings,
    totalSessions,
    totalLinkedSessions,
  };
}

// ─── Trend Computation ───────────────────────────────────────────────────────

function computeTrends(sprints: SprintDataPoint[]): SprintAnalyticsResult['trends'] {
  if (sprints.length < 2) {
    return {
      velocity: { direction: 'stable', changePercent: 0 },
      completionRate: { direction: 'stable', changePercent: 0 },
      decisionsPerSprint: { direction: 'stable', changePercent: 0 },
      cycleTime: null,
    };
  }

  const velocityTrend = computeTrendDirection(sprints.map((s) => s.completedMissions));

  const completionRateTrend = computeTrendDirection(sprints.map((s) => s.completionRate));

  const decisionsTrend = computeTrendDirection(sprints.map((s) => s.decisionsCount));

  const cycleTimes = sprints
    .map((s) => s.avgCycleTimeDays)
    .filter((ct): ct is number => ct !== null);
  const cycleTimeTrend = cycleTimes.length >= 2 ? computeTrendDirection(cycleTimes) : null;

  return {
    velocity: velocityTrend,
    completionRate: completionRateTrend,
    decisionsPerSprint: decisionsTrend,
    cycleTime: cycleTimeTrend,
  };
}

/**
 * Compute trend direction by comparing the average of the first half
 * to the average of the second half of data points.
 */
function computeTrendDirection(values: number[]): TrendDirection {
  if (values.length < 2) {
    return { direction: 'stable', changePercent: 0 };
  }

  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  if (firstAvg === 0 && secondAvg === 0) {
    return { direction: 'stable', changePercent: 0 };
  }

  const changePercent =
    firstAvg === 0 ? 100 : Math.round(((secondAvg - firstAvg) / firstAvg) * 100);

  // Use a 10% threshold for meaningful change
  const direction: TrendDirection['direction'] =
    changePercent > 10 ? 'increasing' : changePercent < -10 ? 'decreasing' : 'stable';

  return { direction, changePercent };
}

// ─── Highlights ──────────────────────────────────────────────────────────────

function generateHighlights(
  sprints: SprintDataPoint[],
  aggregates: SprintAnalyticsResult['aggregates'],
  trends: SprintAnalyticsResult['trends']
): string[] {
  const highlights: string[] = [];

  // Velocity trend
  if (trends.velocity.direction === 'increasing') {
    highlights.push(
      `Velocity trending up: ${trends.velocity.changePercent > 0 ? '+' : ''}${trends.velocity.changePercent}% across recent sprints`
    );
  } else if (trends.velocity.direction === 'decreasing') {
    highlights.push(
      `Velocity trending down: ${trends.velocity.changePercent}% across recent sprints`
    );
  }

  // Average velocity
  highlights.push(
    `Average velocity: ${aggregates.avgVelocity} missions/sprint across ${aggregates.completedSprints} completed sprints`
  );

  // Completion rate
  highlights.push(
    `Overall completion rate: ${aggregates.overallCompletionRate}% (${aggregates.totalCompleted}/${aggregates.totalMissions} missions)`
  );

  // Decision volume trend
  if (trends.decisionsPerSprint.direction !== 'stable') {
    const label = trends.decisionsPerSprint.direction === 'increasing' ? 'growing' : 'declining';
    highlights.push(
      `Decision capture ${label}: ${trends.decisionsPerSprint.changePercent > 0 ? '+' : ''}${trends.decisionsPerSprint.changePercent}%`
    );
  }

  // Cycle time
  if (aggregates.avgCycleTimeDays !== null) {
    highlights.push(`Average mission cycle time: ${aggregates.avgCycleTimeDays} days`);
    if (trends.cycleTime?.direction === 'decreasing') {
      highlights.push(`Cycle time improving: ${trends.cycleTime.changePercent}%`);
    } else if (trends.cycleTime?.direction === 'increasing') {
      highlights.push(
        `Cycle time increasing: +${trends.cycleTime.changePercent}% — missions taking longer`
      );
    }
  }

  // Peak sprint
  if (sprints.length >= 3) {
    const peak = sprints.reduce((best, s) =>
      s.completedMissions > best.completedMissions ? s : best
    );
    highlights.push(
      `Peak velocity: ${peak.completedMissions} missions in ${peak.sprintId} (${peak.title})`
    );
  }

  return highlights;
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

export function formatSprintAnalyticsForLLM(result: CmosToolResult<SprintAnalyticsResult>): string {
  if (!result.success || !result.data) {
    return `Analytics failed: ${result.error?.message ?? 'Unknown error'}`;
  }

  const d = result.data;
  const lines: string[] = [];

  lines.push('**Cross-Sprint Analytics**');
  lines.push('');

  // s86-m05 — name the window BEFORE the numbers it explains. Every figure below describes
  // exactly these sprints, and a bounded call now says which ones rather than "recent".
  if (d.window.sprintCount > 0) {
    const bound =
      d.window.requestedLimit !== null
        ? `newest ${d.window.sprintCount} of the requested ${d.window.requestedLimit}`
        : `all ${d.window.sprintCount}`;
    lines.push(
      `**Window**: ${bound} — ${d.window.oldestSprintId} → ${d.window.newestSprintId} (oldest → newest)`
    );
    lines.push('');
  }

  // Aggregates
  lines.push('**Aggregates**');
  lines.push(
    `  Sprints: ${d.aggregates.totalSprints} (${d.aggregates.completedSprints} completed)`
  );
  lines.push(
    `  Missions: ${d.aggregates.totalCompleted}/${d.aggregates.totalMissions} completed (${d.aggregates.overallCompletionRate}%)` +
      (d.aggregates.totalParked > 0
        ? `, ${d.aggregates.totalParked} parked (Deferred/Dropped, outside the rate)`
        : '')
  );
  lines.push(`  Avg velocity: ${d.aggregates.avgVelocity} missions/sprint`);
  if (d.aggregates.avgCycleTimeDays !== null) {
    lines.push(`  Avg cycle time: ${d.aggregates.avgCycleTimeDays} days`);
  }
  lines.push(
    `  Decisions: ${d.aggregates.totalDecisions} | Learnings: ${d.aggregates.totalLearnings} | Sessions: ${d.aggregates.totalSessions}${d.aggregates.totalLinkedSessions > 0 ? ` (${d.aggregates.totalLinkedSessions} mission-linked)` : ''}`
  );

  // Trends
  lines.push('');
  lines.push('**Trends**');
  lines.push(`  Velocity: ${formatTrend(d.trends.velocity)}`);
  lines.push(`  Completion rate: ${formatTrend(d.trends.completionRate)}`);
  lines.push(`  Decisions/sprint: ${formatTrend(d.trends.decisionsPerSprint)}`);
  if (d.trends.cycleTime) {
    lines.push(`  Cycle time: ${formatTrend(d.trends.cycleTime)}`);
  }

  // Per-sprint table
  if (d.sprints.length > 0) {
    lines.push('');
    lines.push('**Per-Sprint Data**');
    lines.push('Sprint          | Missions | Done | Rate | Decisions | Sessions | Cycle');
    lines.push('----------------|----------|------|------|-----------|----------|------');
    for (const s of d.sprints) {
      const cycle = s.avgCycleTimeDays !== null ? `${s.avgCycleTimeDays}d` : '—';
      lines.push(
        `${s.sprintId.padEnd(16)}| ${String(s.totalMissions).padEnd(9)}| ${String(s.completedMissions).padEnd(5)}| ${String(s.completionRate + '%').padEnd(5)}| ${String(s.decisionsCount).padEnd(10)}| ${String(s.sessionsCount).padEnd(9)}| ${cycle}`
      );
    }
  }

  // Highlights
  if (d.highlights.length > 0) {
    lines.push('');
    lines.push('**Highlights**');
    for (const h of d.highlights) {
      lines.push(`  - ${h}`);
    }
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatTrend(trend: TrendDirection): string {
  const arrow =
    trend.direction === 'increasing' ? '↑' : trend.direction === 'decreasing' ? '↓' : '→';
  const sign = trend.changePercent > 0 ? '+' : '';
  return `${arrow} ${trend.direction} (${sign}${trend.changePercent}%)`;
}
