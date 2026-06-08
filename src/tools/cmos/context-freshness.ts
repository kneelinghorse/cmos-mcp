/**
 * Shared context freshness and refresh helpers.
 *
 * Provides:
 * - master_context freshness calculations against latest completed activity
 * - actionable stale warnings
 * - master_context auto-refresh from completed missions/sprints since last update
 *
 * @module tools/cmos/context-freshness
 */

import * as crypto from 'crypto';
import type { CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Default staleness threshold for master_context drift.
 */
export const DEFAULT_CONTEXT_STALE_THRESHOLD_DAYS = 7;

/**
 * Calculated freshness for a context against completed mission/session activity.
 */
export interface ContextFreshness {
  contextId: string;
  contextUpdatedAt: string | null;
  latestMissionCompletionAt: string | null;
  latestSessionCompletionAt: string | null;
  latestActivityAt: string | null;
  lagDays: number | null;
  isStale: boolean;
  staleThresholdDays: number;
}

/**
 * Result of attempting to refresh master_context from recent completion activity.
 */
export interface MasterContextAutoRefreshResult {
  attempted: boolean;
  refreshed: boolean;
  missionsAdded: number;
  sprintsAdded: number;
  snapshotId: number | null;
  contextUpdatedAt: string | null;
  latestAggregatedActivityAt: string | null;
  warnings: string[];
}

interface ContextRow {
  source_path: string;
  content: string;
  updated_at: string | null;
}

interface CompletedMissionRow {
  id: string;
  name: string;
  objective: string | null;
  notes: string | null;
  sprint_id: string | null;
  completed_at: string;
}

interface CompletedSprintRow {
  id: string;
  title: string;
  focus: string | null;
  status: string | null;
  total_missions: number;
  completed_missions: number;
  last_completed_at: string;
}

interface MaxTimestampRow {
  ts: string | null;
}

/**
 * Calculate freshness of a context compared to latest completed mission/session activity.
 */
export function calculateContextFreshness(
  client: CmosDatabaseClient,
  options: {
    contextId?: string;
    staleThresholdDays?: number;
  } = {}
): { freshness: ContextFreshness; warnings: string[] } {
  const contextId = options.contextId ?? 'master_context';
  const staleThresholdDays = options.staleThresholdDays ?? DEFAULT_CONTEXT_STALE_THRESHOLD_DAYS;
  const warnings: string[] = [];

  const contextResult = client.getOne<{ updated_at: string | null }>(
    'SELECT updated_at FROM contexts WHERE id = ?',
    [contextId]
  );
  if (!contextResult.success) {
    warnings.push(
      `Unable to read ${contextId}.updated_at for freshness check: ${contextResult.error?.message ?? 'Unknown error'}.`
    );
  }
  const contextUpdatedAt = contextResult.success ? (contextResult.data?.updated_at ?? null) : null;

  const missionResult = client.getOne<MaxTimestampRow>(
    `SELECT MAX(completed_at) AS ts
       FROM missions
      WHERE completed_at IS NOT NULL`,
    []
  );
  if (!missionResult.success) {
    warnings.push(
      `Unable to read latest completed mission timestamp for freshness check: ${missionResult.error?.message ?? 'Unknown error'}.`
    );
  }
  const latestMissionCompletionAt = missionResult.success ? (missionResult.data?.ts ?? null) : null;

  const sessionResult = client.getOne<MaxTimestampRow>(
    `SELECT MAX(completed_at) AS ts
       FROM sessions
      WHERE completed_at IS NOT NULL`,
    []
  );
  if (!sessionResult.success) {
    warnings.push(
      `Unable to read latest completed session timestamp for freshness check: ${sessionResult.error?.message ?? 'Unknown error'}.`
    );
  }
  const latestSessionCompletionAt = sessionResult.success ? (sessionResult.data?.ts ?? null) : null;

  const latestActivityAt = maxIsoTimestamp(latestMissionCompletionAt, latestSessionCompletionAt);
  const lagDays = calculateLagDays(contextUpdatedAt, latestActivityAt);

  const freshness: ContextFreshness = {
    contextId,
    contextUpdatedAt,
    latestMissionCompletionAt,
    latestSessionCompletionAt,
    latestActivityAt,
    lagDays,
    isStale: lagDays !== null && lagDays > staleThresholdDays,
    staleThresholdDays,
  };

  return { freshness, warnings };
}

/**
 * Build an actionable warning when master_context is stale.
 */
export function buildContextStalenessWarning(freshness: ContextFreshness): string | null {
  if (!freshness.isStale) {
    return null;
  }

  const lagDays = freshness.lagDays !== null ? freshness.lagDays.toFixed(1) : 'unknown';
  const updatedAt = freshness.contextUpdatedAt ?? 'unknown';
  const latestAt = freshness.latestActivityAt ?? 'unknown';

  return (
    `${freshness.contextId} appears stale: updated_at=${updatedAt}, ` +
    `latest completed mission/session activity=${latestAt}, lag=${lagDays} days ` +
    `(threshold=${freshness.staleThresholdDays} days). ` +
    'Recommended action: run cmos_context_update(), or start a review session with ' +
    'cmos_session_start(type="review", title="Context refresh") and complete it.'
  );
}

/**
 * Refresh master_context with completed missions/sprints since its last update.
 *
 * This is a best-effort helper: failures are returned as warnings so callers can
 * continue non-critical workflows (for example, session start).
 */
export function refreshMasterContextFromRecentActivity(
  client: CmosDatabaseClient,
  options: {
    source?: string;
    now?: string;
    since?: string | null;
  } = {}
): MasterContextAutoRefreshResult {
  const warnings: string[] = [];
  const now = options.now ?? new Date().toISOString();
  const snapshotSource = options.source ?? 'session_start:auto_refresh';

  const contextResult = client.getOne<ContextRow>(
    'SELECT source_path, content, updated_at FROM contexts WHERE id = ?',
    ['master_context']
  );

  if (!contextResult.success) {
    return {
      attempted: true,
      refreshed: false,
      missionsAdded: 0,
      sprintsAdded: 0,
      snapshotId: null,
      contextUpdatedAt: null,
      latestAggregatedActivityAt: null,
      warnings: [
        `Auto-refresh skipped: failed to read master_context: ${contextResult.error?.message ?? 'Unknown error'}.`,
      ],
    };
  }

  const sourcePath = contextResult.data?.source_path ?? 'context/MASTER_CONTEXT.json';
  const cutoff = options.since ?? contextResult.data?.updated_at ?? null;

  let content: Record<string, unknown> = {};
  if (contextResult.data?.content) {
    try {
      content = JSON.parse(contextResult.data.content) as Record<string, unknown>;
    } catch {
      return {
        attempted: true,
        refreshed: false,
        missionsAdded: 0,
        sprintsAdded: 0,
        snapshotId: null,
        contextUpdatedAt: contextResult.data.updated_at,
        latestAggregatedActivityAt: null,
        warnings: [
          'Auto-refresh skipped: master_context content is invalid JSON. Repair context JSON before retrying.',
        ],
      };
    }
  }

  const completedMissions = ensureObjectArray(content, 'completed_missions');
  const completedSprints = ensureObjectArray(content, 'completed_sprints');

  const existingMissionIds = new Set<string>();
  for (const item of completedMissions) {
    const idValue = item['mission_id'];
    if (typeof idValue === 'string' && idValue.trim().length > 0) {
      existingMissionIds.add(idValue);
    }
  }

  const existingSprintIds = new Set<string>();
  for (const item of completedSprints) {
    const idValue = item['sprint_id'];
    if (typeof idValue === 'string' && idValue.trim().length > 0) {
      existingSprintIds.add(idValue);
    }
  }

  const missionQuery =
    `SELECT id, name, objective, notes, sprint_id, completed_at
       FROM missions
      WHERE status = 'Completed'
        AND completed_at IS NOT NULL` +
    (cutoff ? ' AND completed_at > ?' : '') +
    ' ORDER BY completed_at ASC';

  const missionResult = client.getMany<CompletedMissionRow>(
    missionQuery,
    cutoff ? [cutoff] : ([] as string[])
  );

  const missions = missionResult.success ? (missionResult.data ?? []) : [];
  if (!missionResult.success) {
    warnings.push(
      `Auto-refresh could not read completed missions: ${missionResult.error?.message ?? 'Unknown error'}.`
    );
  }

  let missionsAdded = 0;
  let latestAggregatedActivityAt: string | null = null;

  for (const mission of missions) {
    if (existingMissionIds.has(mission.id)) {
      continue;
    }

    completedMissions.push({
      mission_id: mission.id,
      mission_name: mission.name,
      objective: mission.objective,
      notes: mission.notes,
      completed_at: mission.completed_at,
      sprint_id: mission.sprint_id,
    });
    existingMissionIds.add(mission.id);
    missionsAdded += 1;
    latestAggregatedActivityAt = maxIsoTimestamp(latestAggregatedActivityAt, mission.completed_at);
  }

  const sprintQuery =
    `SELECT
       s.id,
       s.title,
       s.focus,
       s.status,
       COUNT(m.id) AS total_missions,
       SUM(CASE WHEN m.status = 'Completed' THEN 1 ELSE 0 END) AS completed_missions,
       MAX(m.completed_at) AS last_completed_at
     FROM sprints s
     JOIN missions m ON m.sprint_id = s.id
     GROUP BY s.id, s.title, s.focus, s.status
     HAVING COUNT(m.id) > 0
       AND SUM(CASE WHEN m.status != 'Completed' THEN 1 ELSE 0 END) = 0
       AND MAX(m.completed_at) IS NOT NULL` +
    (cutoff ? ' AND MAX(m.completed_at) > ?' : '') +
    ' ORDER BY MAX(m.completed_at) ASC';

  const sprintResult = client.getMany<CompletedSprintRow>(
    sprintQuery,
    cutoff ? [cutoff] : ([] as string[])
  );

  const sprints = sprintResult.success ? (sprintResult.data ?? []) : [];
  if (!sprintResult.success) {
    warnings.push(
      `Auto-refresh could not read completed sprints: ${sprintResult.error?.message ?? 'Unknown error'}.`
    );
  }

  let sprintsAdded = 0;
  for (const sprint of sprints) {
    if (existingSprintIds.has(sprint.id)) {
      continue;
    }

    completedSprints.push({
      sprint_id: sprint.id,
      title: sprint.title,
      focus: sprint.focus,
      status: sprint.status,
      total_missions: sprint.total_missions,
      completed_missions: sprint.completed_missions,
      completed_at: sprint.last_completed_at,
    });
    existingSprintIds.add(sprint.id);
    sprintsAdded += 1;
    latestAggregatedActivityAt = maxIsoTimestamp(
      latestAggregatedActivityAt,
      sprint.last_completed_at
    );
  }

  if (missionsAdded === 0 && sprintsAdded === 0) {
    return {
      attempted: true,
      refreshed: false,
      missionsAdded: 0,
      sprintsAdded: 0,
      snapshotId: null,
      contextUpdatedAt: contextResult.data?.updated_at ?? null,
      latestAggregatedActivityAt,
      warnings,
    };
  }

  const serialized = JSON.stringify(content);
  const persistResult = contextResult.data
    ? client.execute('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?', [
        serialized,
        now,
        'master_context',
      ])
    : client.execute(
        'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
        ['master_context', sourcePath, serialized, now]
      );

  if (!persistResult.success) {
    return {
      attempted: true,
      refreshed: false,
      missionsAdded: 0,
      sprintsAdded: 0,
      snapshotId: null,
      contextUpdatedAt: contextResult.data?.updated_at ?? null,
      latestAggregatedActivityAt,
      warnings: [
        ...warnings,
        `Auto-refresh found updates but failed to persist master_context: ${persistResult.error?.message ?? 'Unknown error'}.`,
      ],
    };
  }

  const snapshotId = createContextSnapshotWithDedup(
    client,
    'master_context',
    serialized,
    snapshotSource,
    now,
    warnings
  );

  return {
    attempted: true,
    refreshed: true,
    missionsAdded,
    sprintsAdded,
    snapshotId,
    contextUpdatedAt: now,
    latestAggregatedActivityAt,
    warnings,
  };
}

function ensureObjectArray(
  content: Record<string, unknown>,
  key: string
): Array<Record<string, unknown>> {
  const existing = content[key];
  if (!Array.isArray(existing)) {
    const created: Array<Record<string, unknown>> = [];
    content[key] = created;
    return created;
  }

  const normalized = existing.filter(isPlainObject);
  if (normalized.length !== existing.length) {
    content[key] = normalized;
  }
  return normalized as Array<Record<string, unknown>>;
}

function createContextSnapshotWithDedup(
  client: CmosDatabaseClient,
  contextId: string,
  content: string,
  source: string,
  now: string,
  warnings: string[]
): number | null {
  const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);

  const existingResult = client.getOne<{ id: number }>(
    'SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?',
    [contextId, hash]
  );

  if (existingResult.success && existingResult.data) {
    return existingResult.data.id;
  }

  if (!existingResult.success) {
    warnings.push(
      `Auto-refresh snapshot dedupe lookup failed: ${existingResult.error?.message ?? 'Unknown error'}.`
    );
    return null;
  }

  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextId, source, hash, content, now, ...g.values]
  );

  if (!insertResult.success) {
    warnings.push(
      `Auto-refresh updated master_context but failed to create snapshot: ${insertResult.error?.message ?? 'Unknown error'}.`
    );
    return null;
  }

  return Number(insertResult.data?.lastInsertRowid);
}

function calculateLagDays(
  contextUpdatedAt: string | null,
  latestActivityAt: string | null
): number | null {
  if (!contextUpdatedAt || !latestActivityAt) {
    return null;
  }

  const contextTs = Date.parse(contextUpdatedAt);
  const latestTs = Date.parse(latestActivityAt);
  if (!Number.isFinite(contextTs) || !Number.isFinite(latestTs)) {
    return null;
  }

  if (latestTs <= contextTs) {
    return 0;
  }

  return Math.round(((latestTs - contextTs) / MILLIS_PER_DAY) * 100) / 100;
}

function maxIsoTimestamp(...timestamps: Array<string | null | undefined>): string | null {
  let max: { value: string; parsed: number } | null = null;

  for (const ts of timestamps) {
    if (!ts) continue;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) continue;

    if (!max || parsed > max.parsed) {
      max = { value: ts, parsed };
    }
  }

  return max?.value ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
