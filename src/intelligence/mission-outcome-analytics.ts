import path from 'path';
import { promises as fs } from 'fs';
import * as YAML from 'yaml';
import { SecureYAMLLoader } from '../loaders/yaml-loader';
import { pathExists } from '../utils/fs';

export type MissionStatus =
  | 'Queued'
  | 'Current'
  | 'In Progress'
  | 'Completed'
  | 'Blocked'
  | 'Deferred'
  | 'Unknown';

const STATUS_ALIASES = new Map<string, MissionStatus>([
  ['queued', 'Queued'],
  ['current', 'Current'],
  ['in progress', 'In Progress'],
  ['in_progress', 'In Progress'],
  ['in-progress', 'In Progress'],
  ['completed', 'Completed'],
  ['done', 'Completed'],
  ['blocked', 'Blocked'],
  ['deferred', 'Deferred'],
]);

const DEFAULT_THROUGHPUT_WINDOW_DAYS = 14;

interface AnalyzeMissionOutcomesOptions {
  readonly backlogFile: string;
  readonly sessionsFile: string;
  readonly now?: Date;
  readonly throughputWindowDays?: number;
}

interface RawMissionEvent {
  readonly ts?: string;
  readonly mission?: string;
  readonly action?: string;
  readonly status?: string;
  readonly agent?: string;
  readonly summary?: string;
  readonly next_hint?: string;
  readonly needs?: unknown;
  readonly [key: string]: unknown;
}

export interface MissionEventSummary {
  readonly ts: string;
  readonly mission: string;
  readonly action?: string;
  readonly status?: string;
  readonly agent?: string;
  readonly summary?: string;
}

interface MissionEvent extends MissionEventSummary {
  readonly timestamp?: Date;
}

interface NormalizedMission {
  readonly id: string;
  readonly name: string;
  readonly status: MissionStatus;
  readonly rawStatus: string;
  readonly sprintId: string;
  readonly sprintTitle?: string;
  readonly sprintStatus?: string;
  readonly backlogIndex: number;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly notes?: string;
}

interface NormalizedSprint {
  readonly sprintId: string;
  readonly title?: string;
  readonly status?: string;
  readonly missions: NormalizedMission[];
}

export interface MissionOutcome {
  readonly id: string;
  readonly name: string;
  readonly sprintId: string;
  readonly sprintTitle?: string;
  readonly sprintStatus?: string;
  readonly status: MissionStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cycleTimeMinutes?: number;
  readonly backlogNotes?: string;
  readonly agentsInvolved: readonly string[];
  readonly eventCounts: {
    readonly starts: number;
    readonly completes: number;
    readonly blocks: number;
  };
  readonly lastEvent?: MissionEventSummary;
}

export interface SprintOutcome {
  readonly sprintId: string;
  readonly title?: string;
  readonly status?: string;
  readonly totals: {
    readonly missions: number;
    readonly completed: number;
    readonly inProgress: number;
    readonly current: number;
    readonly queued: number;
    readonly blocked: number;
    readonly deferred: number;
  };
  readonly progressRatio: number;
  readonly missionIds: readonly string[];
  readonly firstStartedAt?: string;
  readonly lastCompletedAt?: string;
}

export interface MissionOutcomeAnalytics {
  readonly generatedAt: string;
  readonly totals: {
    readonly missions: number;
    readonly completed: number;
    readonly inProgress: number;
    readonly current: number;
    readonly queued: number;
    readonly blocked: number;
    readonly deferred: number;
    readonly active: number;
  };
  readonly cycleTimeMinutes: {
    readonly sampleSize: number;
    readonly average?: number;
    readonly median?: number;
    readonly p90?: number;
    readonly fastest?: number;
    readonly slowest?: number;
  };
  readonly throughput: {
    readonly windowDays: number;
    readonly completed: number;
    readonly perDay: number;
  };
  readonly sprints: readonly SprintOutcome[];
  readonly missions: readonly MissionOutcome[];
  readonly recentActivity: readonly MissionEventSummary[];
}

interface MissionEventBuckets {
  readonly eventsByMission: Map<string, MissionEvent[]>;
  readonly allEvents: MissionEvent[];
}

export async function analyzeMissionOutcomes(
  options: AnalyzeMissionOutcomesOptions
): Promise<MissionOutcomeAnalytics> {
  const now = options.now ?? new Date();
  const throughputWindowDays = options.throughputWindowDays ?? DEFAULT_THROUGHPUT_WINDOW_DAYS;
  const backlogPath = path.resolve(options.backlogFile);
  const sessionsPath = path.resolve(options.sessionsFile);

  const backlogDir = path.dirname(backlogPath);
  const loader = new SecureYAMLLoader({
    baseDir: backlogDir,
    maxFileSize: 5 * 1024 * 1024, // 5MB cap for backlog
    followSymlinks: true,
  });

  const backlog = await loadBacklog(loader, path.basename(backlogPath));
  const sprints = extractSprints(backlog);

  const missions = sprints.flatMap((sprint) => sprint.missions);
  const missionIds = new Set(missions.map((mission) => mission.id));

  const eventBuckets = await loadMissionEvents(sessionsPath, missionIds);

  const missionOutcomes = missions.map((mission) =>
    buildMissionOutcome(mission, eventBuckets.eventsByMission.get(mission.id) ?? [])
  );

  const totals = computeTotals(missionOutcomes);
  const cycleStats = computeCycleStats(missionOutcomes);
  const throughput = computeThroughput(
    eventBuckets.allEvents,
    missionIds,
    now,
    throughputWindowDays
  );
  const sprintOutcomes = sprints.map((sprint) => buildSprintOutcome(sprint, missionOutcomes));
  const recentActivity = buildRecentActivity(eventBuckets.allEvents, 10);

  return {
    generatedAt: now.toISOString(),
    totals,
    cycleTimeMinutes: cycleStats,
    throughput,
    sprints: sprintOutcomes,
    missions: missionOutcomes,
    recentActivity,
  };
}

function extractSprints(backlog: Record<string, unknown>): NormalizedSprint[] {
  const sprintsData = getNested(backlog, ['domainFields', 'sprints']);
  if (!Array.isArray(sprintsData)) {
    return [];
  }

  const normalized: NormalizedSprint[] = [];
  let backlogIndex = 0;

  for (const sprintData of sprintsData) {
    if (!sprintData || typeof sprintData !== 'object') {
      continue;
    }

    const sprintId = toStringSafe((sprintData as Record<string, unknown>).sprintId);
    if (!sprintId) {
      continue;
    }

    const missionsData = (sprintData as Record<string, unknown>).missions;
    if (!Array.isArray(missionsData)) {
      normalized.push({
        sprintId,
        title: toStringSafe((sprintData as Record<string, unknown>).title),
        status: toStringSafe((sprintData as Record<string, unknown>).status),
        missions: [],
      });
      continue;
    }

    const missions: NormalizedMission[] = [];

    for (const rawMission of missionsData) {
      if (!rawMission || typeof rawMission !== 'object') {
        continue;
      }

      const missionRecord = rawMission as Record<string, unknown>;
      const id = toStringSafe(missionRecord.id);
      const name = toStringSafe(missionRecord.name);

      if (!id || !name) {
        continue;
      }

      const rawStatus = toStringSafe(missionRecord.status) ?? 'Unknown';
      const status = normalizeStatus(rawStatus);
      const startedAt = parseTimestamp(missionRecord.started_at);
      const completedAt = parseTimestamp(missionRecord.completed_at);
      const notes = toStringSafe(missionRecord.notes);

      missions.push({
        id,
        name,
        status,
        rawStatus,
        sprintId,
        sprintTitle: toStringSafe((sprintData as Record<string, unknown>).title),
        sprintStatus: toStringSafe((sprintData as Record<string, unknown>).status),
        backlogIndex: backlogIndex++,
        startedAt,
        completedAt,
        notes: notes ?? undefined,
      });
    }

    normalized.push({
      sprintId,
      title: toStringSafe((sprintData as Record<string, unknown>).title),
      status: toStringSafe((sprintData as Record<string, unknown>).status),
      missions,
    });
  }

  return normalized;
}

async function loadMissionEvents(
  sessionsPath: string,
  missionIds: Set<string>
): Promise<MissionEventBuckets> {
  if (!(await pathExists(sessionsPath))) {
    return { eventsByMission: new Map(), allEvents: [] };
  }

  const rawContent = await fs.readFile(sessionsPath, 'utf-8');
  const lines = rawContent.split(/\r?\n/).filter((line) => line.trim().length > 0);

  const events: MissionEvent[] = [];
  const eventsByMission = new Map<string, MissionEvent[]>();

  for (const line of lines) {
    let parsed: RawMissionEvent;
    try {
      parsed = JSON.parse(line) as RawMissionEvent;
    } catch {
      continue;
    }

    const mission = toStringSafe(parsed.mission);
    if (!mission || !missionIds.has(mission)) {
      continue;
    }

    const timestamp = parseTimestamp(parsed.ts);
    const event: MissionEvent = {
      ts: timestamp ? timestamp.toISOString() : (parsed.ts ?? ''),
      mission,
      action: toStringSafe(parsed.action) ?? undefined,
      status: toStringSafe(parsed.status) ?? undefined,
      agent: toStringSafe(parsed.agent) ?? undefined,
      summary: toStringSafe(parsed.summary) ?? undefined,
      timestamp: timestamp ?? undefined,
    };

    if (!eventsByMission.has(mission)) {
      eventsByMission.set(mission, []);
    }
    eventsByMission.get(mission)!.push(event);
    events.push(event);
  }

  for (const missionEvents of eventsByMission.values()) {
    missionEvents.sort((a, b) => compareEvents(a, b));
  }

  events.sort((a, b) => compareEvents(a, b));

  return { eventsByMission, allEvents: events };
}

function buildMissionOutcome(mission: NormalizedMission, events: MissionEvent[]): MissionOutcome {
  const startEvents = events.filter((event) => event.action === 'start');
  const completeEvents = events.filter((event) => event.action === 'complete');
  const blockEvents = events.filter((event) => event.action === 'blocked');

  const firstStart = earliestTimestamp([
    ...startEvents,
    ...events.filter((e) => e.status === 'in_progress'),
  ]);
  const lastComplete = latestTimestamp(completeEvents);

  const startedAt = mission.startedAt ?? firstStart;
  const completedAt = mission.completedAt ?? lastComplete;

  const cycleTimeMinutes = calculateDurationMinutes(startedAt, completedAt);

  const agents = dedupe(
    events
      .map((event) => event.agent)
      .filter((agent): agent is string => typeof agent === 'string' && agent.length > 0)
  );

  const lastEvent = events[events.length - 1];

  return {
    id: mission.id,
    name: mission.name,
    sprintId: mission.sprintId,
    sprintTitle: mission.sprintTitle,
    sprintStatus: mission.sprintStatus,
    status: mission.status,
    startedAt: startedAt?.toISOString(),
    completedAt: completedAt?.toISOString(),
    cycleTimeMinutes,
    backlogNotes: mission.notes,
    agentsInvolved: agents,
    eventCounts: {
      starts: startEvents.length,
      completes: completeEvents.length,
      blocks: blockEvents.length,
    },
    lastEvent: lastEvent
      ? {
          ts: lastEvent.ts,
          mission: mission.id,
          action: lastEvent.action,
          status: lastEvent.status,
          agent: lastEvent.agent,
          summary: lastEvent.summary,
        }
      : undefined,
  };
}

function buildSprintOutcome(
  sprint: NormalizedSprint,
  missionOutcomes: MissionOutcome[]
): SprintOutcome {
  const sprintMissions = missionOutcomes.filter((mission) => mission.sprintId === sprint.sprintId);

  const totals = computeTotals(sprintMissions);
  const firstStarted = earliestTimestampString(
    sprintMissions.map((mission) => mission.startedAt).filter(Boolean) as string[]
  );
  const lastCompleted = latestTimestampString(
    sprintMissions.map((mission) => mission.completedAt).filter(Boolean) as string[]
  );

  const actionableCount =
    totals.missions -
    totals.deferred -
    sprintMissions.filter((mission) => mission.status === 'Unknown').length;
  const completedCount = sprintMissions.filter((mission) => mission.status === 'Completed').length;
  const progressRatio = actionableCount > 0 ? completedCount / actionableCount : 0;

  return {
    sprintId: sprint.sprintId,
    title: sprint.title,
    status: sprint.status,
    totals,
    progressRatio,
    missionIds: sprintMissions.map((mission) => mission.id),
    firstStartedAt: firstStarted ?? undefined,
    lastCompletedAt: lastCompleted ?? undefined,
  };
}

function buildRecentActivity(events: MissionEvent[], limit: number): MissionEventSummary[] {
  const recent = [...events]
    .sort((a, b) => compareEvents(b, a))
    .slice(0, limit)
    .map((event) => ({
      ts: event.ts,
      mission: event.mission,
      action: event.action,
      status: event.status,
      agent: event.agent,
      summary: event.summary,
    }));

  return recent;
}

function computeTotals(missions: MissionOutcome[]): MissionOutcomeAnalytics['totals'] {
  const totals = {
    missions: missions.length,
    completed: 0,
    inProgress: 0,
    current: 0,
    queued: 0,
    blocked: 0,
    deferred: 0,
    active: 0,
  };

  for (const mission of missions) {
    switch (mission.status) {
      case 'Completed':
        totals.completed += 1;
        break;
      case 'In Progress':
        totals.inProgress += 1;
        break;
      case 'Current':
        totals.current += 1;
        break;
      case 'Queued':
        totals.queued += 1;
        break;
      case 'Blocked':
        totals.blocked += 1;
        break;
      case 'Deferred':
        totals.deferred += 1;
        break;
      default:
        break;
    }
  }

  totals.active = totals.inProgress + totals.current + totals.blocked;

  return totals;
}

function computeCycleStats(
  missions: MissionOutcome[]
): MissionOutcomeAnalytics['cycleTimeMinutes'] {
  const durations = missions
    .map((mission) => mission.cycleTimeMinutes)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (durations.length === 0) {
    return {
      sampleSize: 0,
    };
  }

  durations.sort((a, b) => a - b);

  return {
    sampleSize: durations.length,
    average: Number(
      (durations.reduce((sum, current) => sum + current, 0) / durations.length).toFixed(2)
    ),
    median: Number(computePercentile(durations, 0.5).toFixed(2)),
    p90: Number(computePercentile(durations, 0.9).toFixed(2)),
    fastest: durations[0],
    slowest: durations[durations.length - 1],
  };
}

function computeThroughput(
  events: MissionEvent[],
  missionIds: Set<string>,
  now: Date,
  windowDays: number
): MissionOutcomeAnalytics['throughput'] {
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const completions = events.filter((event) => {
    if (event.action !== 'complete' || !event.timestamp) {
      return false;
    }
    if (!missionIds.has(event.mission)) {
      return false;
    }
    return event.timestamp >= windowStart && event.timestamp <= now;
  });

  const completed = completions.length;
  const perDay = windowDays > 0 ? Number((completed / windowDays).toFixed(2)) : 0;

  return {
    windowDays,
    completed,
    perDay,
  };
}

function normalizeStatus(status: string): MissionStatus {
  const normalized = status.trim().toLowerCase();
  if (STATUS_ALIASES.has(normalized)) {
    return STATUS_ALIASES.get(normalized)!;
  }
  return 'Unknown';
}

function toStringSafe(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const candidates = new Set<string>();
  candidates.add(value);

  const trimmed = value.trim();
  candidates.add(trimmed);
  candidates.add(trimmed.replace(/N\+/gi, '+'));
  candidates.add(trimmed.replace(/\s+/g, ''));
  if (trimmed.endsWith('+0000')) {
    candidates.add(trimmed.replace(/\+0000$/, 'Z'));
  }
  candidates.add(trimmed.replace(/([0-9])([A-Za-z])\+/, '$1+'));

  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return undefined;
}

function getNested(
  source: Record<string, unknown>,
  pathSegments: readonly (string | number)[]
): unknown {
  let current: unknown = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
        return undefined;
      }
      current = current[segment];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function compareEvents(a: MissionEvent, b: MissionEvent): number {
  const aTime = a.timestamp?.getTime();
  const bTime = b.timestamp?.getTime();

  if (typeof aTime === 'number' && typeof bTime === 'number') {
    return aTime - bTime;
  }

  if (typeof aTime === 'number') {
    return -1;
  }

  if (typeof bTime === 'number') {
    return 1;
  }

  return 0;
}

function earliestTimestamp(events: MissionEvent[]): Date | undefined {
  const sorted = events
    .map((event) => event.timestamp)
    .filter((timestamp): timestamp is Date => Boolean(timestamp))
    .sort((a, b) => a.getTime() - b.getTime());

  return sorted[0];
}

function latestTimestamp(events: MissionEvent[]): Date | undefined {
  const sorted = events
    .map((event) => event.timestamp)
    .filter((timestamp): timestamp is Date => Boolean(timestamp))
    .sort((a, b) => b.getTime() - a.getTime());

  return sorted[0];
}

function earliestTimestampString(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) {
    return undefined;
  }
  const sorted = [...timestamps].sort();
  return sorted[0];
}

function latestTimestampString(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) {
    return undefined;
  }
  const sorted = [...timestamps].sort();
  return sorted[sorted.length - 1];
}

function calculateDurationMinutes(start?: Date, end?: Date): number | undefined {
  if (!start || !end) {
    return undefined;
  }

  const durationMs = end.getTime() - start.getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }

  return Number((durationMs / (1000 * 60)).toFixed(2));
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export type { AnalyzeMissionOutcomesOptions };

async function loadBacklog(
  loader: SecureYAMLLoader,
  backlogFileName: string
): Promise<Record<string, unknown>> {
  const sanitizedPath = loader.sanitizePath(backlogFileName);
  const content = await fs.readFile(sanitizedPath, 'utf-8');

  const documents = YAML.parseAllDocuments(content, {
    uniqueKeys: false,
    merge: true,
  });

  if (documents.length === 0) {
    throw new Error('Backlog file is empty.');
  }

  const lastDocument = documents[documents.length - 1]?.toJS();

  if (!lastDocument || typeof lastDocument !== 'object') {
    throw new Error('Backlog file does not contain a mission document.');
  }

  assertNoFunctions(lastDocument);

  return lastDocument as Record<string, unknown>;
}

function assertNoFunctions(obj: unknown, currentPath = 'root'): void {
  if (typeof obj === 'function') {
    throw new Error(`Function detected in YAML at ${currentPath}`);
  }

  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      assertNoFunctions(value, `${currentPath}.${key}`);
    }
  }
}
