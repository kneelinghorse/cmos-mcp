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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SprintDataPoint {
  sprintId: string;
  title: string;
  status: string | null;
  totalMissions: number;
  completedMissions: number;
  blockedMissions: number;
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
      const sprints = getSprintDataPoints(client, params.limit);

      if (sprints.length === 0) {
        return createSuccess<SprintAnalyticsResult>({
          sprints: [],
          aggregates: {
            totalSprints: 0,
            completedSprints: 0,
            totalMissions: 0,
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
          highlights: ['No completed sprints found for analysis.'],
        });
      }

      const aggregates = computeAggregates(sprints);
      const trends = computeTrends(sprints);
      const highlights = generateHighlights(sprints, aggregates, trends);

      return createSuccess<SprintAnalyticsResult>({
        sprints,
        aggregates,
        trends,
        highlights,
      });
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
  decisions_count: number;
}

function getSprintDataPoints(client: CmosDatabaseClient, limit?: number): SprintDataPoint[] {
  // Get sprints with mission counts from the sprint_summary view
  const limitClause = limit ? `LIMIT ${Math.floor(limit)}` : '';
  const sprintsResult = client.getMany<SprintSummaryRow>(
    `SELECT sprint_id, title, status, total_missions, completed_missions, blocked_missions, decisions_count
     FROM sprint_summary
     WHERE status IN ('Completed', 'Active')
     ORDER BY sprint_id ASC
     ${limitClause}`
  );

  if (!sprintsResult.success || !sprintsResult.data) return [];

  return sprintsResult.data.map((row) => {
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

  // Aggregates
  lines.push('**Aggregates**');
  lines.push(
    `  Sprints: ${d.aggregates.totalSprints} (${d.aggregates.completedSprints} completed)`
  );
  lines.push(
    `  Missions: ${d.aggregates.totalCompleted}/${d.aggregates.totalMissions} completed (${d.aggregates.overallCompletionRate}%)`
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

  return lines.join('\n');
}

function formatTrend(trend: TrendDirection): string {
  const arrow =
    trend.direction === 'increasing' ? '↑' : trend.direction === 'decreasing' ? '↓' : '→';
  const sign = trend.changePercent > 0 ? '+' : '';
  return `${arrow} ${trend.direction} (${sign}${trend.changePercent}%)`;
}
