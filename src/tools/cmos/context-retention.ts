/**
 * Shared context size and condensation helpers for CMOS context tools.
 *
 * Provides:
 * - Context size metrics with configurable limits/warning thresholds
 * - Retention policy parsing from environment
 * - Sprint-aware archival of old context detail into snapshot-backed summaries
 *
 * @module tools/cmos/context-retention
 */

import * as crypto from 'crypto';
import type { CmosDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';

const DEFAULT_SIZE_LIMIT_KB = 100;
const DEFAULT_WARNING_THRESHOLD_PERCENT = 75;
const DEFAULT_TARGET_SIZE_KB = 30;
const DEFAULT_KEEP_DETAIL_SPRINTS = 3;

export interface ContextRetentionPolicy {
  keepDetailSprints: number;
  warningThresholdPercent: number;
  sizeLimitKb: number;
  targetSizeKb: number;
}

export interface ContextSizeMetrics {
  sizeBytes: number;
  sizeKb: number;
  limitKb: number;
  warningThresholdPercent: number;
  usagePercent: number;
  nearLimit: boolean;
}

export interface ContextCondensationResult {
  changed: boolean;
  archivedSprintIds: string[];
  archivedCounts: {
    sessionHistory: number;
    recentSessions: number;
    nextSteps: number;
    total: number;
  };
  archiveSnapshotId: number | null;
  sizeBefore: ContextSizeMetrics;
  sizeAfter: ContextSizeMetrics;
  notes: string[];
}

interface SessionRow {
  id: string;
  sprint_id: string | null;
}

interface SprintRow {
  id: string;
}

interface ArchiveCounters {
  sessionHistory: number;
  recentSessions: number;
  nextSteps: number;
}

export function getContextRetentionPolicy(): ContextRetentionPolicy {
  return {
    keepDetailSprints: parsePositiveInt(
      process.env.CMOS_CONTEXT_RETENTION_SPRINTS,
      DEFAULT_KEEP_DETAIL_SPRINTS
    ),
    warningThresholdPercent: clampPercent(
      parsePositiveInt(
        process.env.CMOS_CONTEXT_WARNING_THRESHOLD_PERCENT,
        DEFAULT_WARNING_THRESHOLD_PERCENT
      )
    ),
    sizeLimitKb: parsePositiveInt(process.env.CMOS_CONTEXT_SIZE_LIMIT_KB, DEFAULT_SIZE_LIMIT_KB),
    targetSizeKb: parsePositiveInt(process.env.CMOS_CONTEXT_TARGET_SIZE_KB, DEFAULT_TARGET_SIZE_KB),
  };
}

export function calculateContextSizeMetrics(
  content: Record<string, unknown> | string,
  options?: { limitKb?: number; warningThresholdPercent?: number }
): ContextSizeMetrics {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content ?? {});
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  const sizeKb = round(sizeBytes / 1024);
  const limitKb = Math.max(1, options?.limitKb ?? DEFAULT_SIZE_LIMIT_KB);
  const warningThresholdPercent = clampPercent(
    options?.warningThresholdPercent ?? DEFAULT_WARNING_THRESHOLD_PERCENT
  );
  const usagePercent = round((sizeKb / limitKb) * 100);

  return {
    sizeBytes,
    sizeKb,
    limitKb,
    warningThresholdPercent,
    usagePercent,
    nearLimit: usagePercent >= warningThresholdPercent,
  };
}

export function buildContextSizeWarning(
  contextLabel: string,
  metrics: ContextSizeMetrics
): string | null {
  if (!metrics.nearLimit) {
    return null;
  }

  return `${contextLabel} is using ${metrics.usagePercent.toFixed(1)}% of configured limit (${metrics.sizeKb.toFixed(2)}KB / ${metrics.limitKb.toFixed(2)}KB). Consider running cmos_context_update() to condense context detail.`;
}

export function resolveContextSizeSettings(
  content: Record<string, unknown>,
  defaults?: Partial<ContextRetentionPolicy>
): { limitKb: number; warningThresholdPercent: number } {
  const policy = getContextRetentionPolicy();
  const contextHealth = isPlainObject(content['context_health'])
    ? (content['context_health'] as Record<string, unknown>)
    : {};

  const limitKb = normalizePositiveNumber(
    contextHealth['size_limit_kb'],
    defaults?.sizeLimitKb ?? policy.sizeLimitKb
  );
  const warningThresholdPercent = clampPercent(
    normalizePositiveNumber(
      contextHealth['warning_threshold_percent'],
      defaults?.warningThresholdPercent ?? policy.warningThresholdPercent
    )
  );

  return { limitKb, warningThresholdPercent };
}

/**
 * Condense sprint detail older than retention policy and preserve the original
 * full detail in a context snapshot before archival changes are written.
 */
export function condenseContextForRetention(
  client: CmosDatabaseClient,
  contextId: 'master_context' | 'project_context',
  content: Record<string, unknown>,
  options?: {
    source?: string;
    policy?: Partial<ContextRetentionPolicy>;
  }
): ContextCondensationResult {
  const basePolicy = getContextRetentionPolicy();
  const policy: ContextRetentionPolicy = {
    keepDetailSprints: Math.max(
      1,
      options?.policy?.keepDetailSprints ?? basePolicy.keepDetailSprints
    ),
    warningThresholdPercent:
      options?.policy?.warningThresholdPercent ?? basePolicy.warningThresholdPercent,
    sizeLimitKb: options?.policy?.sizeLimitKb ?? basePolicy.sizeLimitKb,
    targetSizeKb: options?.policy?.targetSizeKb ?? basePolicy.targetSizeKb,
  };

  const settings = resolveContextSizeSettings(content, policy);
  const sizeBefore = calculateContextSizeMetrics(content, settings);
  const originalContent = JSON.stringify(content);
  const notes: string[] = [];

  const completedSprintIds = getCompletedSprintIds(client);
  if (completedSprintIds.length <= policy.keepDetailSprints) {
    const trimmed = trimToTargetSize(content, contextId, policy.targetSizeKb);
    notes.push(...trimmed.notes);
    const sizeAfterNoArchive = calculateContextSizeMetrics(content, settings);
    return {
      changed: trimmed.changed,
      archivedSprintIds: [],
      archivedCounts: { sessionHistory: 0, recentSessions: 0, nextSteps: 0, total: 0 },
      archiveSnapshotId: null,
      sizeBefore,
      sizeAfter: sizeAfterNoArchive,
      notes,
    };
  }

  const archivedSprintIds = completedSprintIds.slice(policy.keepDetailSprints);
  const archiveSet = new Set(archivedSprintIds);

  const sessionIds = collectSessionIds(content, contextId);
  const sessionSprintMap = loadSessionSprintMap(client, sessionIds);
  const removedCounters = removeArchivedDetail(
    content,
    contextId,
    archiveSet,
    sessionSprintMap,
    notes
  );

  let archiveSnapshotId: number | null = null;
  if (removedCounters.total > 0) {
    archiveSnapshotId = createSnapshot(
      client,
      contextId,
      originalContent,
      options?.source ?? `context_condense:${contextId}`
    );
    appendArchivedSummaries(content, archivedSprintIds, removedCounters.bySprint, {
      snapshotId: archiveSnapshotId,
      keepDetailSprints: policy.keepDetailSprints,
    });
  }

  const trimmed = trimToTargetSize(content, contextId, policy.targetSizeKb);
  notes.push(...trimmed.notes);
  const changed = removedCounters.total > 0 || trimmed.changed;
  const sizeAfter = calculateContextSizeMetrics(content, settings);

  if (sizeAfter.sizeKb > policy.targetSizeKb) {
    notes.push(
      `${contextId} remains above target size (${sizeAfter.sizeKb.toFixed(2)}KB > ${policy.targetSizeKb.toFixed(2)}KB) after condensation.`
    );
  }

  return {
    changed,
    archivedSprintIds: removedCounters.total > 0 ? archivedSprintIds : [],
    archivedCounts: {
      sessionHistory: removedCounters.sessionHistory,
      recentSessions: removedCounters.recentSessions,
      nextSteps: removedCounters.nextSteps,
      total: removedCounters.total,
    },
    archiveSnapshotId,
    sizeBefore,
    sizeAfter,
    notes,
  };
}

function getCompletedSprintIds(client: CmosDatabaseClient): string[] {
  const result = client.getMany<SprintRow>(
    `SELECT id
       FROM sprints
      WHERE status = 'Completed'
      ORDER BY COALESCE(end_date, start_date, '') DESC, rowid DESC`,
    []
  );

  if (!result.success || !result.data) {
    return [];
  }

  return result.data.map((row) => row.id).filter(Boolean);
}

function collectSessionIds(
  content: Record<string, unknown>,
  contextId: 'master_context' | 'project_context'
): string[] {
  const sessionIds = new Set<string>();

  const addId = (candidate: unknown): void => {
    if (typeof candidate !== 'string') {
      return;
    }
    const cleaned = candidate.trim();
    if (cleaned.length > 0) {
      sessionIds.add(cleaned);
    }
  };

  if (contextId === 'project_context') {
    const working = ensureObject(content, 'working_memory');

    for (const entry of ensureArray(working, 'session_history')) {
      if (isPlainObject(entry)) {
        addId(entry['session']);
        addId(entry['session_id']);
      }
    }

    for (const entry of ensureArray(working, 'recent_sessions')) {
      if (isPlainObject(entry)) {
        addId(entry['id']);
        addId(entry['session']);
        addId(entry['session_id']);
      }
    }

    for (const step of ensureArray(working, 'next_steps')) {
      addId(extractSessionId(step));
    }
  } else {
    for (const entry of ensureArray(content, 'recent_sessions')) {
      if (isPlainObject(entry)) {
        addId(entry['id']);
        addId(entry['session']);
        addId(entry['session_id']);
      }
    }

    const nextSession = ensureObject(content, 'next_session_context');
    for (const step of ensureArray(nextSession, 'when_we_resume')) {
      addId(extractSessionId(step));
    }
  }

  return Array.from(sessionIds);
}

function loadSessionSprintMap(
  client: CmosDatabaseClient,
  sessionIds: string[]
): Map<string, string | null> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  const placeholders = sessionIds.map(() => '?').join(', ');
  const result = client.getMany<SessionRow>(
    `SELECT id, sprint_id FROM sessions WHERE id IN (${placeholders})`,
    sessionIds
  );

  if (!result.success || !result.data) {
    return new Map();
  }

  const map = new Map<string, string | null>();
  for (const row of result.data) {
    map.set(row.id, row.sprint_id);
  }
  return map;
}

function removeArchivedDetail(
  content: Record<string, unknown>,
  contextId: 'master_context' | 'project_context',
  archiveSet: Set<string>,
  sessionSprintMap: Map<string, string | null>,
  notes: string[]
): {
  sessionHistory: number;
  recentSessions: number;
  nextSteps: number;
  total: number;
  bySprint: Record<string, ArchiveCounters>;
} {
  const bySprint: Record<string, ArchiveCounters> = {};
  let sessionHistory = 0;
  let recentSessions = 0;
  let nextSteps = 0;

  const track = (sprintId: string, key: keyof ArchiveCounters): void => {
    if (!bySprint[sprintId]) {
      bySprint[sprintId] = { sessionHistory: 0, recentSessions: 0, nextSteps: 0 };
    }
    bySprint[sprintId][key] += 1;
  };

  const getSprintIdForEntry = (entry: unknown): string | null => {
    if (!isPlainObject(entry)) {
      return null;
    }

    const explicitSprint = asString(entry['sprint_id']);
    if (explicitSprint) {
      return explicitSprint;
    }

    const sessionId =
      asString(entry['session']) || asString(entry['session_id']) || asString(entry['id']);
    if (!sessionId) {
      return null;
    }
    return sessionSprintMap.get(sessionId) ?? null;
  };

  const shouldArchiveStep = (entry: unknown): string | null => {
    const sessionId = extractSessionId(entry);
    if (!sessionId) {
      return null;
    }
    return sessionSprintMap.get(sessionId) ?? null;
  };

  if (contextId === 'project_context') {
    const working = isPlainObject(content['working_memory'])
      ? (content['working_memory'] as Record<string, unknown>)
      : null;

    const sessionHistoryList = working ? readArray(working, 'session_history') : null;
    if (working && sessionHistoryList) {
      working['session_history'] = sessionHistoryList.filter((entry) => {
        const sprintId = getSprintIdForEntry(entry);
        if (!sprintId || !archiveSet.has(sprintId)) {
          return true;
        }
        sessionHistory += 1;
        track(sprintId, 'sessionHistory');
        return false;
      });
    }

    const recentSessionsList = working ? readArray(working, 'recent_sessions') : null;
    if (working && recentSessionsList) {
      working['recent_sessions'] = recentSessionsList.filter((entry) => {
        const sprintId = getSprintIdForEntry(entry);
        if (!sprintId || !archiveSet.has(sprintId)) {
          return true;
        }
        recentSessions += 1;
        track(sprintId, 'recentSessions');
        return false;
      });
    }

    const nextStepsList = working ? readArray(working, 'next_steps') : null;
    if (working && nextStepsList) {
      working['next_steps'] = nextStepsList.filter((entry) => {
        const sprintId = shouldArchiveStep(entry);
        if (!sprintId || !archiveSet.has(sprintId)) {
          return true;
        }
        nextSteps += 1;
        track(sprintId, 'nextSteps');
        return false;
      });
    }
  } else {
    const recentSessionsList = readArray(content, 'recent_sessions');
    if (recentSessionsList) {
      content['recent_sessions'] = recentSessionsList.filter((entry) => {
        const sprintId = getSprintIdForEntry(entry);
        if (!sprintId || !archiveSet.has(sprintId)) {
          return true;
        }
        recentSessions += 1;
        track(sprintId, 'recentSessions');
        return false;
      });
    }

    const nextSession = isPlainObject(content['next_session_context'])
      ? (content['next_session_context'] as Record<string, unknown>)
      : null;
    const resumeList = nextSession ? readArray(nextSession, 'when_we_resume') : null;
    if (nextSession && resumeList) {
      nextSession['when_we_resume'] = resumeList.filter((entry) => {
        const sprintId = shouldArchiveStep(entry);
        if (!sprintId || !archiveSet.has(sprintId)) {
          return true;
        }
        nextSteps += 1;
        track(sprintId, 'nextSteps');
        return false;
      });
    }
  }

  const total = sessionHistory + recentSessions + nextSteps;
  if (total > 0) {
    notes.push(
      `Archived ${total} detail item(s) from completed sprints (${sessionHistory} history, ${recentSessions} recent sessions, ${nextSteps} next steps).`
    );
  }

  return { sessionHistory, recentSessions, nextSteps, total, bySprint };
}

function appendArchivedSummaries(
  content: Record<string, unknown>,
  archivedSprintIds: string[],
  countersBySprint: Record<string, ArchiveCounters>,
  options: { snapshotId: number | null; keepDetailSprints: number }
): void {
  const summaries = ensureArray(content, 'archived_sprint_summaries');
  const now = new Date().toISOString();

  for (const sprintId of archivedSprintIds) {
    const counters = countersBySprint[sprintId];
    if (!counters) {
      continue;
    }

    const existing = summaries.find(
      (entry) => isPlainObject(entry) && asString(entry['sprint_id']) === sprintId
    ) as Record<string, unknown> | undefined;

    if (existing) {
      const detail = ensureObject(existing, 'detail_counts');
      detail['session_history'] =
        Number(detail['session_history'] ?? 0) + Number(counters.sessionHistory ?? 0);
      detail['recent_sessions'] =
        Number(detail['recent_sessions'] ?? 0) + Number(counters.recentSessions ?? 0);
      detail['next_steps'] = Number(detail['next_steps'] ?? 0) + Number(counters.nextSteps ?? 0);
      detail['total'] =
        Number(detail['session_history']) +
        Number(detail['recent_sessions']) +
        Number(detail['next_steps']);
      existing['archived_at'] = now;
      existing['keep_detail_sprints'] = options.keepDetailSprints;
      if (options.snapshotId !== null) {
        existing['snapshot_id'] = options.snapshotId;
      }
      continue;
    }

    summaries.push({
      sprint_id: sprintId,
      archived_at: now,
      keep_detail_sprints: options.keepDetailSprints,
      snapshot_id: options.snapshotId,
      detail_counts: {
        session_history: counters.sessionHistory,
        recent_sessions: counters.recentSessions,
        next_steps: counters.nextSteps,
        total: counters.sessionHistory + counters.recentSessions + counters.nextSteps,
      },
      summary:
        'Detailed session history for this completed sprint was condensed and preserved in context snapshots.',
    });
  }

  if (summaries.length > 100) {
    summaries.splice(0, summaries.length - 100);
  }
}

function trimToTargetSize(
  content: Record<string, unknown>,
  contextId: 'master_context' | 'project_context',
  targetSizeKb: number
): { changed: boolean; notes: string[] } {
  const notes: string[] = [];
  const rules =
    contextId === 'project_context'
      ? [
          { path: ['working_memory', 'session_history'], limit: 50, label: 'session_history' },
          { path: ['working_memory', 'recent_sessions'], limit: 25, label: 'recent_sessions' },
          { path: ['working_memory', 'next_steps'], limit: 25, label: 'next_steps' },
          { path: ['working_memory', 'session_history'], limit: 25, label: 'session_history' },
          { path: ['working_memory', 'recent_sessions'], limit: 10, label: 'recent_sessions' },
          { path: ['working_memory', 'next_steps'], limit: 10, label: 'next_steps' },
        ]
      : [
          { path: ['recent_sessions'], limit: 20, label: 'recent_sessions' },
          { path: ['next_session_context', 'when_we_resume'], limit: 25, label: 'when_we_resume' },
          { path: ['context_notes'], limit: 40, label: 'context_notes' },
          { path: ['recent_sessions'], limit: 10, label: 'recent_sessions' },
          { path: ['next_session_context', 'when_we_resume'], limit: 15, label: 'when_we_resume' },
        ];

  let changed = false;
  for (const rule of rules) {
    const currentSize = calculateContextSizeMetrics(content, {
      limitKb: DEFAULT_SIZE_LIMIT_KB,
      warningThresholdPercent: DEFAULT_WARNING_THRESHOLD_PERCENT,
    });
    if (currentSize.sizeKb <= targetSizeKb) {
      break;
    }

    const array = getArrayByPath(content, rule.path);
    if (!array || array.length <= rule.limit) {
      continue;
    }

    const removed = array.length - rule.limit;
    array.splice(0, removed);
    changed = true;
    notes.push(`Trimmed ${removed} item(s) from ${rule.label} to reduce context size.`);
  }

  return { changed, notes };
}

function getArrayByPath(root: Record<string, unknown>, path: string[]): unknown[] | null {
  let cursor: unknown = root;

  for (const segment of path) {
    if (!isPlainObject(cursor)) {
      return null;
    }
    cursor = cursor[segment];
  }

  if (!Array.isArray(cursor)) {
    return null;
  }

  return cursor;
}

function extractSessionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const separatorIndex = trimmed.indexOf(':');
  const candidate = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
  return candidate || null;
}

function createSnapshot(
  client: CmosDatabaseClient,
  contextId: string,
  content: string,
  source: string
): number | null {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const now = new Date().toISOString();

  const existing = client.getOne<{ id: number }>(
    'SELECT id FROM context_snapshots WHERE context_id = ? AND content_hash = ?',
    [contextId, contentHash]
  );
  if (existing.success && existing.data) {
    return existing.data.id;
  }

  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${g.columns.join(', ')})
     VALUES (?, ?, ?, ?, ?, ${g.placeholders})`,
    [contextId, source, contentHash, content, now, ...g.values]
  );

  if (!insertResult.success) {
    return null;
  }

  return Number(insertResult.data?.lastInsertRowid);
}

function ensureArray(obj: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(obj[key])) {
    obj[key] = [];
  }
  return obj[key] as unknown[];
}

function readArray(obj: Record<string, unknown>, key: string): unknown[] | null {
  return Array.isArray(obj[key]) ? (obj[key] as unknown[]) : null;
}

function ensureObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isPlainObject(obj[key])) {
    obj[key] = {};
  }
  return obj[key] as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_WARNING_THRESHOLD_PERCENT;
  }
  return Math.min(100, Math.max(1, value));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
