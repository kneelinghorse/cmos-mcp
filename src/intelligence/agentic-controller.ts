import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

import { ContextPropagatorConfig, SubMissionResult } from './context-propagator';
import { CmosDetector, CmosDetectionOptions, CmosDetectionResult } from './cmos-detector';
import { ContextPropagatorV3, ContextSummaryV3 } from './context-propagator-v3';
import { MissionHistoryAnalyzer, MissionHistoryEvent } from './mission-history';
import { CmosSyncOptions, CmosSyncService, CmosSyncResult, SyncRequestOptions } from './cmos-sync';
import {
  RSIPLoopHandlers,
  RSIPLoopOptions,
  RSIPLoopSummary,
  RSIPStopReason,
  runRSIPLoop,
} from './rsip-loop';
import { emitTelemetryError, emitTelemetryInfo, emitTelemetryWarning } from './telemetry';
import {
  AgenticObservability,
  AgenticObservabilityOptions,
  AgenticQualityGateResult,
} from './agentic-observability';
import { BoomerangStep, BoomerangWorkflow, BoomerangWorkflowResult } from './boomerang-workflow';
import { ensureDir } from '../utils/fs';
import { resolveWorkspacePath } from '../utils/workspace-io';

export type MissionStatus =
  | 'queued'
  | 'current'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'paused';
export type MissionPhase = 'idle' | 'planning' | 'execution' | 'review' | 'blocked' | 'completed';

export interface AgenticMissionEvent {
  ts: string;
  type:
    | 'mission_started'
    | 'mission_completed'
    | 'mission_paused'
    | 'mission_resumed'
    | 'phase_transition'
    | 'context_propagated'
    | 'sub_mission_started'
    | 'sub_mission_committed'
    | 'sub_mission_rolled_back'
    | 'sub_mission_recorded'
    | 'query_built'
    | 'workflow_routed'
    | 'self_improvement_run'
    | 'boomerang_run_completed'
    | 'boomerang_fallback_triggered';
  payload?: Record<string, unknown>;
}

export interface CmosDetectionProvider {
  detect(projectRoot?: string, options?: CmosDetectionOptions): Promise<CmosDetectionResult>;
}

export type AgenticMissionSyncTrigger = 'mission_start' | 'mission_complete';

export interface AgenticCmosSyncAutomationOptions extends SyncRequestOptions {
  readonly triggers?: readonly AgenticMissionSyncTrigger[];
}

export interface AgenticCmosSyncOptions extends CmosSyncOptions {
  readonly telemetrySource?: string;
  readonly automation?: AgenticCmosSyncAutomationOptions;
  readonly service?: CmosSyncService;
}

export interface AgenticCmosIntegrationOptions {
  detector?: CmosDetectionProvider;
  enabled?: boolean;
  projectRoot?: string;
  detectionOptions?: CmosDetectionOptions;
  telemetrySource?: string;
  sync?: AgenticCmosSyncOptions;
}

export interface StoredSubMissionResult {
  missionId: string;
  input: string;
  output: string;
  status: 'success' | 'failed';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MissionContextSnapshot {
  generatedAt: string;
  summary: ContextSummaryV3;
}

export interface DynamicQuerySnapshot {
  generatedAt: string;
  query: string;
  baseQuery: string;
  historyEvents: MissionHistoryEvent[];
}

export interface MissionRSIPIterationSnapshot {
  index: number;
  improvementScore: number;
  summary?: string;
}

export interface MissionRSIPRunSnapshot {
  startedAt: string;
  completedAt: string;
  converged: boolean;
  reason: RSIPStopReason;
  iterations: MissionRSIPIterationSnapshot[];
}

export interface MissionRSIPMetrics {
  runs: number;
  totalIterations: number;
  lastRun?: MissionRSIPRunSnapshot;
}

export interface MissionBoomerangRunSummary {
  startedAt: string;
  completedAt: string;
  status: 'success' | 'failed' | 'fallback';
  completedSteps: string[];
  failedStep?: string;
  fallbackReason?: string;
  diagnostics: BoomerangWorkflowResult['diagnostics'];
  lastOutput?: unknown;
}

export interface MissionBoomerangMetrics {
  runs: number;
  lastRun?: MissionBoomerangRunSummary;
}

export interface ActiveSubMission {
  id: string;
  startedAt: string;
  parent?: string;
  objective?: string;
  metadata?: Record<string, unknown>;
  previousContext?: MissionContextSnapshot;
}

export interface MissionState {
  missionId: string;
  phase: MissionPhase;
  status: MissionStatus;
  objective?: string;
  currentSubMission?: string;
  activeSubMissions: ActiveSubMission[];
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  notes?: string;
  tags?: string[];
  lastContext?: MissionContextSnapshot;
  lastDynamicQuery?: DynamicQuerySnapshot;
  history: AgenticMissionEvent[];
  subMissions: StoredSubMissionResult[];
  metadata?: Record<string, unknown>;
  rsipMetrics?: MissionRSIPMetrics;
  boomerangMetrics?: MissionBoomerangMetrics;
}

export interface WorkflowState {
  activeMission?: string;
  queue: string[];
  completed: string[];
  paused: string[];
}

export interface AgenticStateSnapshot {
  version: number;
  lastUpdated: string;
  missions: Record<string, MissionState>;
  workflow: WorkflowState;
}

export interface MissionStateManagerOptions {
  statePath?: string;
  clock?: () => Date;
}

interface PersistedAgenticState {
  version?: number;
  lastUpdated?: string;
  missions?: Record<string, Partial<MissionState>>;
  workflow?: Partial<WorkflowState>;
}

const DEFAULT_STATE_PATH = 'agentic_state.json';
const DEFAULT_SESSIONS_PATH = 'SESSIONS.jsonl';
const DEFAULT_BOOMERANG_RUNTIME_ROOT = 'runtime/boomerang';
const DEFAULT_BOOMERANG_RETENTION_DAYS = 7;
const DEFAULT_BOOMERANG_MAX_RETRIES = 2;
const DEFAULT_OBSERVABILITY_LOG_FILE = 'agentic-events.jsonl';
const DEFAULT_GOVERNANCE_TELEMETRY_SOURCE = 'AgenticGovernance';
const DEFAULT_CMOS_TELEMETRY_SOURCE = 'AgenticCMOS';
const DEFAULT_CMOS_SYNC_TELEMETRY_SOURCE = 'AgenticCMOSSync';
const DEFAULT_CMOS_SYNC_TRIGGERS: readonly AgenticMissionSyncTrigger[] = [
  'mission_start',
  'mission_complete',
];

function createMissionState(missionId: string, now: string): MissionState {
  return {
    missionId,
    phase: 'idle',
    status: 'queued',
    activeSubMissions: [],
    updatedAt: now,
    history: [],
    subMissions: [],
  };
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureUnique(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

function removeValue(list: string[], value: string): string[] {
  return list.filter((item) => item !== value);
}

function normalizeRSIPMetrics(
  metrics: Partial<MissionRSIPMetrics> | undefined,
  fallbackTimestamp: string
): MissionRSIPMetrics | undefined {
  if (!metrics) {
    return undefined;
  }

  const safeRuns =
    typeof metrics.runs === 'number' && Number.isFinite(metrics.runs) && metrics.runs >= 0
      ? Math.floor(metrics.runs)
      : 0;
  const safeIterations =
    typeof metrics.totalIterations === 'number' &&
    Number.isFinite(metrics.totalIterations) &&
    metrics.totalIterations >= 0
      ? Math.floor(metrics.totalIterations)
      : 0;

  let lastRun: MissionRSIPRunSnapshot | undefined;
  if (metrics.lastRun) {
    const persisted = metrics.lastRun;
    const normalizeReason = (reason: unknown): RSIPStopReason => {
      if (reason === 'disabled' || reason === 'converged' || reason === 'max_iterations') {
        return reason;
      }
      if (reason === 'error') {
        return 'error';
      }
      return 'max_iterations';
    };

    const iterations: MissionRSIPIterationSnapshot[] = Array.isArray(persisted.iterations)
      ? persisted.iterations.map((entry, index) => ({
          index:
            typeof entry?.index === 'number' && Number.isFinite(entry.index)
              ? Math.max(1, Math.floor(entry.index))
              : index + 1,
          improvementScore:
            typeof entry?.improvementScore === 'number' ? entry.improvementScore : 0,
          summary: typeof entry?.summary === 'string' ? entry.summary : undefined,
        }))
      : [];

    lastRun = {
      startedAt:
        typeof persisted.startedAt === 'string' && persisted.startedAt.length > 0
          ? persisted.startedAt
          : fallbackTimestamp,
      completedAt:
        typeof persisted.completedAt === 'string' && persisted.completedAt.length > 0
          ? persisted.completedAt
          : fallbackTimestamp,
      converged: typeof persisted.converged === 'boolean' ? persisted.converged : false,
      reason: normalizeReason(persisted.reason),
      iterations,
    };
  }

  return {
    runs: safeRuns,
    totalIterations: safeIterations,
    lastRun,
  };
}

function normalizeBoomerangMetrics(
  metrics: Partial<MissionBoomerangMetrics> | undefined
): MissionBoomerangMetrics | undefined {
  if (!metrics) {
    return undefined;
  }

  const safeRuns =
    typeof metrics.runs === 'number' && Number.isFinite(metrics.runs) && metrics.runs >= 0
      ? Math.floor(metrics.runs)
      : 0;

  const lastRun = metrics.lastRun
    ? (cloneState(metrics.lastRun) as MissionBoomerangRunSummary)
    : undefined;

  return {
    runs: safeRuns,
    lastRun,
  };
}

export class MissionStateManager {
  private readonly statePath: string;
  private readonly clock: () => Date;
  private cachedState: AgenticStateSnapshot | null = null;

  constructor(options: MissionStateManagerOptions = {}) {
    this.statePath = options.statePath ?? DEFAULT_STATE_PATH;
    this.clock = options.clock ?? (() => new Date());
  }

  async getState(): Promise<AgenticStateSnapshot> {
    const state = await this.ensureState();
    return cloneState(state);
  }

  async getMission(missionId: string): Promise<MissionState | undefined> {
    const state = await this.ensureState();
    const mission = state.missions[missionId];
    return mission ? (cloneState(mission) as MissionState) : undefined;
  }

  async update(mutator: (state: AgenticStateSnapshot) => void): Promise<AgenticStateSnapshot> {
    const state = await this.ensureState();
    mutator(state);
    state.lastUpdated = this.nowIso();
    await this.persist(state);
    return cloneState(state);
  }

  private async ensureState(): Promise<AgenticStateSnapshot> {
    if (this.cachedState) {
      return this.cachedState;
    }

    this.cachedState = await this.loadFromDisk();
    return this.cachedState;
  }

  private async loadFromDisk(): Promise<AgenticStateSnapshot> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      if (raw.trim().length === 0) {
        const emptyState = this.createEmptyState();
        await this.persist(emptyState);
        return emptyState;
      }

      const parsed = JSON.parse(raw) as PersistedAgenticState;
      return this.normalize(parsed);
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err && err.code !== 'ENOENT') {
        throw error;
      }
      const emptyState = this.createEmptyState();
      await this.persist(emptyState);
      return emptyState;
    }
  }

  private normalize(state: PersistedAgenticState): AgenticStateSnapshot {
    const now = this.nowIso();

    const workflow: WorkflowState = {
      activeMission: state.workflow?.activeMission,
      queue: state.workflow?.queue ? [...state.workflow.queue] : [],
      completed: state.workflow?.completed ? [...state.workflow.completed] : [],
      paused: state.workflow?.paused ? [...state.workflow.paused] : [],
    };

    const missions: Record<string, MissionState> = {};
    for (const [missionId, mission] of Object.entries(state.missions ?? {})) {
      const rawActiveSubMissions = Array.isArray(
        (mission as { activeSubMissions?: ActiveSubMission[] }).activeSubMissions
      )
        ? ((mission as { activeSubMissions?: ActiveSubMission[] }).activeSubMissions ?? [])
        : [];

      const activeSubMissions: ActiveSubMission[] = [];
      for (const entry of rawActiveSubMissions) {
        if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
          continue;
        }

        activeSubMissions.push({
          id: entry.id,
          startedAt:
            typeof entry.startedAt === 'string' && entry.startedAt.length > 0
              ? entry.startedAt
              : now,
          parent:
            typeof entry.parent === 'string' && entry.parent.length > 0 ? entry.parent : undefined,
          objective:
            typeof entry.objective === 'string' && entry.objective.length > 0
              ? entry.objective
              : undefined,
          metadata: entry.metadata ? { ...entry.metadata } : undefined,
          previousContext: entry.previousContext
            ? cloneState(entry.previousContext as MissionContextSnapshot)
            : undefined,
        });
      }

      missions[missionId] = {
        missionId,
        phase: mission.phase ?? 'idle',
        status: mission.status ?? 'queued',
        objective: mission.objective,
        currentSubMission: mission.currentSubMission,
        activeSubMissions,
        startedAt: mission.startedAt,
        updatedAt: mission.updatedAt ?? now,
        completedAt: mission.completedAt,
        notes: mission.notes,
        tags: mission.tags ? [...mission.tags] : undefined,
        lastContext: mission.lastContext
          ? cloneState(mission.lastContext as MissionContextSnapshot)
          : undefined,
        lastDynamicQuery: mission.lastDynamicQuery as DynamicQuerySnapshot | undefined,
        history: Array.isArray(mission.history)
          ? (mission.history as AgenticMissionEvent[]).map((entry) => ({ ...entry }))
          : [],
        subMissions: Array.isArray(mission.subMissions)
          ? (mission.subMissions as StoredSubMissionResult[]).map((entry) => ({ ...entry }))
          : [],
        metadata: mission.metadata ? { ...mission.metadata } : undefined,
        rsipMetrics: normalizeRSIPMetrics(mission.rsipMetrics, now),
        boomerangMetrics: normalizeBoomerangMetrics(
          (mission as { boomerangMetrics?: MissionBoomerangMetrics }).boomerangMetrics
        ),
      };
    }

    return {
      version: state.version ?? 1,
      lastUpdated: state.lastUpdated ?? now,
      missions,
      workflow,
    };
  }

  private createEmptyState(): AgenticStateSnapshot {
    const now = this.nowIso();
    return {
      version: 1,
      lastUpdated: now,
      missions: {},
      workflow: {
        queue: [],
        completed: [],
        paused: [],
      },
    };
  }

  private async persist(state: AgenticStateSnapshot): Promise<void> {
    const directory = dirname(this.statePath);
    await fs.mkdir(directory, { recursive: true });

    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(state, null, 2);

    await fs.writeFile(tempPath, payload, 'utf-8');
    await fs.rename(tempPath, this.statePath);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

export const __test__ = {
  createMissionState,
  ensureUnique,
  removeValue,
  normalizeRSIPMetrics,
  normalizeBoomerangMetrics,
};

export type { RSIPStopReason };

export interface AgenticControllerOptions {
  statePath?: string;
  sessionsPath?: string;
  contextConfig?: ContextPropagatorConfig;
  propagator?: ContextPropagatorV3;
  historyAnalyzer?: MissionHistoryAnalyzer;
  clock?: () => Date;
  historyLimit?: number;
  autoPropagationPhases?: MissionPhase[];
  delegationGuardrails?: DelegationGuardrailOptions;
  boomerang?: BoomerangControllerOptions;
  observability?: AgenticObservability | AgenticObservabilityOptions;
  governanceTelemetrySource?: string;
  cmos?: AgenticCmosIntegrationOptions;
}

export interface WorkflowRegistrationOptions {
  resetQueue?: boolean;
}

export interface StartMissionOptions {
  objective?: string;
  currentSubMission?: string;
  notes?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  phase?: MissionPhase;
  summary?: string;
  agent?: string;
}

export interface CompleteMissionOptions {
  summary?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  agent?: string;
  nextHint?: string;
}

export interface PauseMissionOptions {
  note?: string;
}

export interface UpdatePhaseOptions {
  reason?: string;
  currentSubMission?: string;
  autoPropagate?: boolean;
}

export interface RecordSubMissionOptions {
  dedupe?: boolean;
  autoPropagate?: boolean;
}

export interface BeginSubMissionOptions {
  objective?: string;
  metadata?: Record<string, unknown>;
}

export interface CompleteSubMissionOptions {
  input: string;
  output: string;
  status: 'success' | 'failed';
  metadata?: Record<string, unknown>;
  timestamp?: Date;
  autoPropagate?: boolean;
}

export interface RollbackSubMissionOptions {
  reason?: string;
  restoreContext?: boolean;
}

export interface DynamicQueryOptions {
  includeContextSummary?: boolean;
  historyLimit?: number;
  supplementalContext?: string;
}

export interface PhaseTransitionEvent {
  missionId: string;
  from: MissionPhase;
  to: MissionPhase;
  ts: string;
  reason?: string;
}

export interface ContextUpdateEvent {
  missionId: string;
  context: MissionContextSnapshot;
}

export interface QueryReadyEvent {
  missionId: string;
  query: string;
  baseQuery: string;
  generatedAt: string;
}

export interface WorkflowAdvanceEvent {
  missionId: string;
  ts: string;
}

export interface MissionLifecycleEvent {
  missionId: string;
  ts: string;
  note?: string;
}

type AgenticEventMap = {
  stateChanged: AgenticStateSnapshot;
  phaseTransition: PhaseTransitionEvent;
  contextUpdated: ContextUpdateEvent;
  queryReady: QueryReadyEvent;
  workflowAdvanced: WorkflowAdvanceEvent;
  missionPaused: MissionLifecycleEvent;
  missionResumed: MissionLifecycleEvent;
  selfImprovementRun: {
    missionId: string;
    summary: MissionRSIPRunSnapshot;
  };
};

export interface DelegationGuardrailOptions {
  maxActiveSubMissions?: number;
  telemetrySource?: string;
}

export interface BoomerangControllerOptions {
  runtimeRoot?: string;
  retentionDays?: number;
  maxRetries?: number;
}

export interface RunBoomerangWorkflowOptions {
  initialPayload?: unknown;
  runtimeRoot?: string;
  retentionDays?: number;
  maxRetries?: number;
  telemetrySource?: string;
  clock?: () => Date;
}

export class AgenticController {
  private readonly stateManager: MissionStateManager;
  private readonly historyAnalyzer: MissionHistoryAnalyzer;
  private readonly propagator: ContextPropagatorV3;
  private readonly clock: () => Date;
  private readonly sessionsPath: string;
  private readonly boomerangRuntimeRoot: string;
  private readonly boomerangRetentionDays: number;
  private readonly boomerangMaxRetries: number;
  private readonly emitter = new EventEmitter();
  private readonly historyLimit: number;
  private readonly autoPropagationPhases: Set<MissionPhase>;
  private readonly maxActiveSubMissions: number | null;
  private readonly delegationTelemetrySource: string;
  private readonly observability: AgenticObservability;
  private readonly governanceTelemetrySource: string;
  private readonly cmosDetector?: CmosDetectionProvider;
  private readonly cmosIntegrationEnabled: boolean;
  private readonly cmosProjectRoot: string;
  private readonly cmosDetectionOptions?: CmosDetectionOptions;
  private readonly cmosTelemetrySource: string;
  private readonly cmosSyncTelemetrySource: string;
  private readonly cmosSyncService?: CmosSyncService;
  private readonly cmosSyncAutomation?: AgenticCmosSyncAutomationOptions;
  private cmosDetectionPromise: Promise<CmosDetectionResult | null> | null = null;
  private cmosDetectionResult: CmosDetectionResult | null = null;
  private static readonly DEFAULT_MAX_ACTIVE_SUBMISSIONS = 8;
  private static readonly DEFAULT_TELEMETRY_SOURCE = 'AgenticDelegation';

  constructor(options: AgenticControllerOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    const resolvedStatePath = options.statePath ?? DEFAULT_STATE_PATH;
    this.stateManager = new MissionStateManager({
      statePath: resolvedStatePath,
      clock: this.clock,
    });

    const sessionsPath = options.sessionsPath ?? DEFAULT_SESSIONS_PATH;
    this.sessionsPath = sessionsPath;
    this.historyAnalyzer =
      options.historyAnalyzer ??
      new MissionHistoryAnalyzer({
        sessionsPath,
      });

    this.propagator =
      options.propagator ??
      new ContextPropagatorV3(
        options.contextConfig ?? { maxContextTokens: 4096, strategy: 'map-reduce' },
        this.historyAnalyzer
      );

    this.historyLimit = options.historyLimit ?? 5;
    this.autoPropagationPhases = new Set(options.autoPropagationPhases ?? ['execution', 'review']);

    const guardrails = options.delegationGuardrails ?? {};
    const requestedLimit =
      typeof guardrails.maxActiveSubMissions === 'number' &&
      Number.isFinite(guardrails.maxActiveSubMissions)
        ? Math.floor(guardrails.maxActiveSubMissions)
        : NaN;
    this.maxActiveSubMissions =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : AgenticController.DEFAULT_MAX_ACTIVE_SUBMISSIONS;
    this.delegationTelemetrySource =
      guardrails.telemetrySource ?? AgenticController.DEFAULT_TELEMETRY_SOURCE;

    const boomerang = options.boomerang ?? {};
    const requestedRetries =
      typeof boomerang.maxRetries === 'number' && Number.isFinite(boomerang.maxRetries)
        ? Math.floor(boomerang.maxRetries)
        : NaN;
    this.boomerangRuntimeRoot = boomerang.runtimeRoot ?? DEFAULT_BOOMERANG_RUNTIME_ROOT;
    this.boomerangRetentionDays =
      typeof boomerang.retentionDays === 'number' && Number.isFinite(boomerang.retentionDays)
        ? boomerang.retentionDays
        : DEFAULT_BOOMERANG_RETENTION_DAYS;
    this.boomerangMaxRetries =
      Number.isFinite(requestedRetries) && requestedRetries >= 0
        ? requestedRetries
        : DEFAULT_BOOMERANG_MAX_RETRIES;

    const defaultObservabilityPath = join(
      dirname(resolvedStatePath),
      DEFAULT_OBSERVABILITY_LOG_FILE
    );
    const observabilityOption = options.observability;
    if (observabilityOption instanceof AgenticObservability) {
      this.observability = observabilityOption;
    } else {
      const observabilityOptions =
        observabilityOption && typeof observabilityOption === 'object'
          ? (observabilityOption as AgenticObservabilityOptions)
          : {};
      const logPath =
        observabilityOptions.logPath !== undefined
          ? observabilityOptions.logPath
          : defaultObservabilityPath;

      this.observability = new AgenticObservability({
        ...observabilityOptions,
        logPath,
        clock: observabilityOptions.clock ?? this.clock,
      });
    }

    this.governanceTelemetrySource =
      options.governanceTelemetrySource ?? DEFAULT_GOVERNANCE_TELEMETRY_SOURCE;

    const cmosOptions = options.cmos ?? {};
    this.cmosIntegrationEnabled = cmosOptions.enabled !== false;
    this.cmosProjectRoot = cmosOptions.projectRoot ?? process.cwd();
    this.cmosDetector = cmosOptions.detector;
    this.cmosDetectionOptions = cmosOptions.detectionOptions
      ? { ...cmosOptions.detectionOptions }
      : undefined;
    this.cmosTelemetrySource = cmosOptions.telemetrySource ?? DEFAULT_CMOS_TELEMETRY_SOURCE;
    const syncOptions = this.cmosIntegrationEnabled ? cmosOptions.sync : undefined;
    this.cmosSyncTelemetrySource =
      syncOptions?.telemetrySource ?? DEFAULT_CMOS_SYNC_TELEMETRY_SOURCE;

    if (this.cmosIntegrationEnabled && syncOptions && syncOptions.enabled === true) {
      const { service, automation, telemetrySource: _ignored, ...serviceOptions } = syncOptions;
      const resolvedOptions: CmosSyncOptions = {
        ...serviceOptions,
        projectRoot: serviceOptions.projectRoot ?? this.cmosProjectRoot,
        sessionsPath: serviceOptions.sessionsPath ?? sessionsPath,
        detector: serviceOptions.detector ?? CmosDetector.getInstance(),
      };
      this.cmosSyncService = service ?? new CmosSyncService(resolvedOptions);
      this.cmosSyncAutomation = this.normalizeSyncAutomationOptions(automation);
    }

    if (this.cmosIntegrationEnabled) {
      this.runCmosDetection(cmosOptions.detectionOptions?.forceRefresh === true);
    }
  }

  on<K extends keyof AgenticEventMap>(
    event: K,
    listener: (payload: AgenticEventMap[K]) => void
  ): this {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return this;
  }

  off<K extends keyof AgenticEventMap>(
    event: K,
    listener: (payload: AgenticEventMap[K]) => void
  ): this {
    this.emitter.off(event, listener as (payload: unknown) => void);
    return this;
  }

  once<K extends keyof AgenticEventMap>(
    event: K,
    listener: (payload: AgenticEventMap[K]) => void
  ): this {
    this.emitter.once(event, listener as (payload: unknown) => void);
    return this;
  }

  async getState(): Promise<AgenticStateSnapshot> {
    return this.stateManager.getState();
  }

  async getCmosDetection(options: CmosDetectionOptions = {}): Promise<CmosDetectionResult | null> {
    if (!this.cmosIntegrationEnabled) {
      return null;
    }

    if (options.forceRefresh) {
      return this.runCmosDetection(true);
    }

    if (this.cmosDetectionResult) {
      return this.cmosDetectionResult;
    }

    if (!this.cmosDetectionPromise) {
      return this.runCmosDetection(false);
    }

    return this.cmosDetectionPromise;
  }

  async getMissionState(missionId: string): Promise<MissionState | undefined> {
    return this.stateManager.getMission(missionId);
  }

  async registerWorkflow(
    missionIds: string[],
    options: WorkflowRegistrationOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const uniqueIds = Array.from(new Set(missionIds.filter(Boolean)));

    const state = await this.stateManager.update((snapshot) => {
      if (options.resetQueue) {
        snapshot.workflow.queue = [...uniqueIds];
      } else {
        for (const missionId of uniqueIds) {
          if (
            missionId !== snapshot.workflow.activeMission &&
            !snapshot.workflow.queue.includes(missionId)
          ) {
            snapshot.workflow.queue.push(missionId);
          }
        }
      }

      for (const missionId of uniqueIds) {
        if (!snapshot.missions[missionId]) {
          snapshot.missions[missionId] = createMissionState(missionId, now);
        }
      }
    });

    this.emit('stateChanged', state);
    return state;
  }

  async advanceWorkflow(): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const currentState = await this.stateManager.getState();
    const activeMissionId = currentState.workflow.activeMission;

    if (activeMissionId) {
      const activeMission = currentState.missions[activeMissionId];
      if (
        activeMission &&
        activeMission.status !== 'completed' &&
        activeMission.status !== 'blocked'
      ) {
        return currentState;
      }
    }

    const state = await this.stateManager.update((snapshot) => {
      const previousActive = snapshot.workflow.activeMission;
      if (previousActive) {
        snapshot.workflow.activeMission = undefined;
        snapshot.workflow.completed = ensureUnique(snapshot.workflow.completed, previousActive);
      }

      const nextMissionId = snapshot.workflow.queue.shift();
      if (!nextMissionId) {
        return;
      }

      const mission = snapshot.missions[nextMissionId] ?? createMissionState(nextMissionId, now);

      const priorPhase = mission.phase;
      if (mission.phase === 'idle') {
        mission.phase = 'planning';
      }
      if (mission.status === 'queued') {
        mission.status = 'current';
      }
      mission.updatedAt = now;
      mission.history.push(
        this.buildMissionEvent('workflow_routed', now, {
          from: priorPhase,
          to: mission.phase,
        })
      );

      snapshot.missions[nextMissionId] = mission;
      snapshot.workflow.activeMission = nextMissionId;
    });

    if (state.workflow.activeMission) {
      this.emit('workflowAdvanced', { missionId: state.workflow.activeMission, ts: now });
    }
    this.emit('stateChanged', state);
    return state;
  }

  async startMission(
    missionId: string,
    options: StartMissionOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const previous = await this.stateManager.getMission(missionId);
    const previousPhase = previous?.phase ?? 'idle';

    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId] ?? createMissionState(missionId, now);

      const fromPhase = mission.phase;
      const toPhase = options.phase ?? 'execution';
      const phaseChanged = fromPhase !== toPhase;

      mission.phase = toPhase;
      mission.status = 'in_progress';
      mission.objective = options.objective ?? mission.objective;
      mission.currentSubMission = options.currentSubMission ?? mission.currentSubMission;
      mission.notes = options.notes ?? mission.notes;
      mission.tags = options.tags ?? mission.tags;
      mission.metadata = options.metadata ?? mission.metadata;
      mission.startedAt = mission.startedAt ?? now;
      mission.updatedAt = now;

      mission.history.push(
        this.buildMissionEvent('mission_started', now, {
          currentSubMission: mission.currentSubMission,
        })
      );

      if (phaseChanged) {
        mission.history.push(
          this.buildMissionEvent('phase_transition', now, {
            from: fromPhase,
            to: toPhase,
            reason: 'mission_start',
          })
        );
      }

      snapshot.missions[missionId] = mission;
      snapshot.workflow.activeMission = missionId;
      snapshot.workflow.queue = removeValue(snapshot.workflow.queue, missionId);
      snapshot.workflow.paused = removeValue(snapshot.workflow.paused, missionId);
    });

    const currentPhase = state.missions[missionId]?.phase ?? previousPhase;
    if (currentPhase !== previousPhase) {
      this.emit('phaseTransition', {
        missionId,
        from: previousPhase,
        to: currentPhase,
        ts: now,
        reason: 'mission_start',
      });
    }

    this.emit('stateChanged', state);
    const missionState = state.missions[missionId];
    if (missionState) {
      await this.observability.recordEvent({
        missionId,
        category: 'mission',
        type: 'mission_started',
        status: missionState.status,
        data: {
          phase: missionState.phase,
          objective: missionState.objective,
          tags: missionState.tags,
          currentSubMission: missionState.currentSubMission,
        },
      });
    }
    await this.recordMissionSessionEvent('mission_start', {
      ts: now,
      mission: missionId,
      action: 'start',
      status: missionState?.status ?? 'in_progress',
      agent: options.agent,
      summary: options.summary ?? missionState?.objective,
    });
    return state;
  }

  async updatePhase(
    missionId: string,
    phase: MissionPhase,
    options: UpdatePhaseOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const previous = await this.stateManager.getMission(missionId);
    const previousPhase = previous?.phase ?? 'idle';

    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId] ?? createMissionState(missionId, now);
      const fromPhase = mission.phase;

      mission.phase = phase;
      mission.currentSubMission = options.currentSubMission ?? mission.currentSubMission;
      mission.updatedAt = now;

      if (fromPhase !== phase) {
        mission.history.push(
          this.buildMissionEvent('phase_transition', now, {
            from: fromPhase,
            to: phase,
            reason: options.reason,
          })
        );
      }

      snapshot.missions[missionId] = mission;
    });

    if (phase !== previousPhase) {
      this.emit('phaseTransition', {
        missionId,
        from: previousPhase,
        to: phase,
        ts: now,
        reason: options.reason,
      });
    }
    this.emit('stateChanged', state);

    if (phase !== previousPhase) {
      const missionState = state.missions[missionId];
      if (missionState) {
        await this.observability.recordEvent({
          missionId,
          category: 'mission',
          type: 'phase_transition',
          status: missionState.status,
          data: {
            from: previousPhase,
            to: missionState.phase,
            reason: options.reason,
          },
        });
      }
    }

    const shouldPropagate = options.autoPropagate ?? this.autoPropagationPhases.has(phase);
    if (shouldPropagate) {
      await this.triggerContextPropagation(missionId);
    }

    return state;
  }

  async beginSubMission(
    missionId: string,
    subMissionId: string,
    options: BeginSubMissionOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    let telemetryContext: Record<string, unknown> | undefined;
    const guardrailLimit = this.maxActiveSubMissions;

    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId] ?? createMissionState(missionId, now);

      const stack = mission.activeSubMissions ?? (mission.activeSubMissions = []);
      const alreadyActive = stack.some((entry) => entry.id === subMissionId);
      if (alreadyActive) {
        throw new Error(`Sub-mission ${subMissionId} is already active for mission ${missionId}`);
      }

      if (guardrailLimit !== null && stack.length >= guardrailLimit) {
        emitTelemetryWarning(this.delegationTelemetrySource, 'sub_mission_guardrail_triggered', {
          missionId,
          attemptedSubMission: subMissionId,
          activeCount: stack.length,
          limit: guardrailLimit,
        });
        throw new Error(
          `Cannot begin sub-mission ${subMissionId} for mission ${missionId}: active sub-mission limit (${guardrailLimit}) reached.`
        );
      }

      const parent = mission.currentSubMission;
      const contextSnapshot = mission.lastContext ? cloneState(mission.lastContext) : undefined;

      stack.push({
        id: subMissionId,
        startedAt: now,
        parent: parent ?? undefined,
        objective: options.objective,
        metadata: options.metadata ? { ...options.metadata } : undefined,
        previousContext: contextSnapshot,
      });

      mission.currentSubMission = subMissionId;
      mission.updatedAt = now;
      mission.history.push(
        this.buildMissionEvent('sub_mission_started', now, {
          subMissionId,
          parent,
        })
      );
      telemetryContext = {
        missionId,
        subMissionId,
        parent,
        activeCount: stack.length,
        guardrailLimit,
      };

      snapshot.missions[missionId] = mission;
    });

    this.emit('stateChanged', state);
    if (telemetryContext) {
      emitTelemetryInfo(this.delegationTelemetrySource, 'sub_mission_started', telemetryContext);
    }
    const missionState = state.missions[missionId];
    if (missionState) {
      await this.observability.recordEvent({
        missionId,
        category: 'sub_mission',
        type: 'sub_mission_started',
        status: missionState.status,
        data: {
          subMissionId,
          parent: telemetryContext?.parent,
          activeCount: missionState.activeSubMissions?.length ?? 0,
        },
      });
    }
    return state;
  }

  async recordSubMissionResult(
    missionId: string,
    result: SubMissionResult,
    options: RecordSubMissionOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const stored: StoredSubMissionResult = {
      missionId: result.missionId,
      input: result.input,
      output: result.output,
      status: result.status,
      timestamp: result.timestamp.toISOString(),
      metadata: result.metadata,
    };

    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId] ?? createMissionState(missionId, now);

      const shouldDedupe = options.dedupe !== false;
      if (shouldDedupe) {
        const exists = mission.subMissions.some(
          (entry) => entry.missionId === stored.missionId && entry.timestamp === stored.timestamp
        );
        if (!exists) {
          mission.subMissions.push(stored);
        }
      } else {
        mission.subMissions.push(stored);
      }

      mission.history.push(
        this.buildMissionEvent('sub_mission_recorded', now, {
          subMissionId: stored.missionId,
          status: stored.status,
        })
      );
      mission.updatedAt = now;

      snapshot.missions[missionId] = mission;
    });

    this.emit('stateChanged', state);

    if (options.autoPropagate) {
      await this.triggerContextPropagation(missionId);
    }

    return state;
  }

  async completeSubMission(
    missionId: string,
    subMissionId: string,
    options: CompleteSubMissionOptions
  ): Promise<AgenticStateSnapshot> {
    const timestampDate = options.timestamp ?? this.clock();
    const timestamp = timestampDate.toISOString();
    const autoPropagate = options.autoPropagate !== false;
    let completionContext: Record<string, unknown> | undefined;

    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId] ?? createMissionState(missionId, timestamp);

      const stack = mission.activeSubMissions ?? (mission.activeSubMissions = []);
      const active = stack[stack.length - 1];
      if (!active || active.id !== subMissionId) {
        emitTelemetryError(this.delegationTelemetrySource, 'sub_mission_mismatch', {
          missionId,
          subMissionId,
          activeSubMission: active?.id,
        });
        throw new Error(`Sub-mission ${subMissionId} is not active for mission ${missionId}`);
      }

      const stored: StoredSubMissionResult = {
        missionId: subMissionId,
        input: options.input,
        output: options.output,
        status: options.status,
        timestamp,
        metadata: options.metadata ? { ...options.metadata } : undefined,
      };

      mission.subMissions.push(stored);
      stack.pop();
      mission.currentSubMission = active.parent;
      mission.updatedAt = timestamp;
      mission.history.push(
        this.buildMissionEvent('sub_mission_recorded', timestamp, {
          subMissionId,
          status: options.status,
        })
      );
      mission.history.push(
        this.buildMissionEvent('sub_mission_committed', timestamp, {
          subMissionId,
          status: options.status,
        })
      );
      const startedMs = Date.parse(active.startedAt);
      const durationMs = Number.isNaN(startedMs)
        ? undefined
        : Math.max(0, Date.parse(timestamp) - startedMs);
      completionContext = {
        missionId,
        subMissionId,
        status: options.status,
        recordedAt: timestamp,
        durationMs,
        remainingActive: stack.length,
      };

      snapshot.missions[missionId] = mission;
    });

    this.emit('stateChanged', state);
    if (completionContext) {
      emitTelemetryInfo(this.delegationTelemetrySource, 'sub_mission_completed', completionContext);
    }

    const missionState = state.missions[missionId];
    if (missionState) {
      await this.observability.recordEvent({
        missionId,
        category: 'sub_mission',
        type: 'sub_mission_completed',
        status: options.status,
        data: {
          subMissionId,
          status: options.status,
          durationMs: completionContext?.durationMs,
          remainingActive: missionState.activeSubMissions?.length ?? 0,
        },
      });
    }

    if (autoPropagate) {
      await this.triggerContextPropagation(missionId);
      return this.stateManager.getState();
    }

    return state;
  }

  async rollbackSubMission(
    missionId: string,
    subMissionId: string,
    options: RollbackSubMissionOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const restoreContext = options.restoreContext !== false;
    let rollbackContext: Record<string, unknown> | undefined;

    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId] ?? createMissionState(missionId, now);

      const stack = mission.activeSubMissions ?? (mission.activeSubMissions = []);
      const active = stack[stack.length - 1];
      if (!active || active.id !== subMissionId) {
        emitTelemetryError(this.delegationTelemetrySource, 'sub_mission_mismatch', {
          missionId,
          subMissionId,
          activeSubMission: active?.id,
          phase: 'rollback',
        });
        throw new Error(`Sub-mission ${subMissionId} is not active for mission ${missionId}`);
      }

      stack.pop();
      mission.currentSubMission = active.parent;
      if (restoreContext && active.previousContext) {
        mission.lastContext = cloneState(active.previousContext);
      }
      mission.updatedAt = now;
      mission.history.push(
        this.buildMissionEvent('sub_mission_rolled_back', now, {
          subMissionId,
          reason: options.reason,
        })
      );
      rollbackContext = {
        missionId,
        subMissionId,
        reason: options.reason,
        restoredContext: restoreContext && Boolean(active.previousContext),
        remainingActive: stack.length,
      };

      snapshot.missions[missionId] = mission;
    });

    this.emit('stateChanged', state);
    if (rollbackContext) {
      emitTelemetryWarning(
        this.delegationTelemetrySource,
        'sub_mission_rolled_back',
        rollbackContext
      );
    }
    const missionState = state.missions[missionId];
    if (missionState) {
      await this.observability.recordEvent({
        missionId,
        category: 'sub_mission',
        type: 'sub_mission_rolled_back',
        status: missionState.status,
        data: {
          subMissionId,
          reason: options.reason,
          remainingActive: missionState.activeSubMissions?.length ?? 0,
        },
      });
    }
    return state;
  }

  async completeMission(
    missionId: string,
    options: CompleteMissionOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const now = this.nowIso();
    const previous = await this.stateManager.getMission(missionId);
    const previousPhase = previous?.phase ?? 'idle';
    const previousStatus = previous?.status ?? 'in_progress';
    const activeSubMissions = previous?.activeSubMissions ?? [];

    if (activeSubMissions.length > 0) {
      await this.logMissionCompletionBlocked(
        missionId,
        previousStatus,
        activeSubMissions.map((entry) => entry.id)
      );
      throw new Error(`Mission ${missionId} cannot be completed while sub-missions remain active.`);
    }

    let state: AgenticStateSnapshot;
    try {
      state = await this.stateManager.update((snapshot) => {
        const mission = snapshot.missions[missionId] ?? createMissionState(missionId, now);
        const fromPhase = mission.phase;

        const remainingActive = mission.activeSubMissions ?? [];
        if (remainingActive.length > 0) {
          throw new Error(
            `Mission ${missionId} cannot be completed while sub-missions remain active.`
          );
        }

        mission.phase = 'completed';
        mission.status = 'completed';
        mission.completedAt = now;
        mission.updatedAt = now;
        mission.notes = options.notes ?? mission.notes;
        mission.metadata = options.metadata ?? mission.metadata;
        mission.activeSubMissions = [];
        mission.currentSubMission = undefined;

        mission.history.push(
          this.buildMissionEvent('mission_completed', now, {
            summary: options.summary,
          })
        );

        if (fromPhase !== 'completed') {
          mission.history.push(
            this.buildMissionEvent('phase_transition', now, {
              from: fromPhase,
              to: 'completed',
              reason: 'mission_completed',
            })
          );
        }

        snapshot.missions[missionId] = mission;
        if (snapshot.workflow.activeMission === missionId) {
          snapshot.workflow.activeMission = undefined;
        }
        snapshot.workflow.completed = ensureUnique(snapshot.workflow.completed, missionId);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('sub-missions remain active')) {
        const latest = await this.stateManager.getMission(missionId);
        const latestIds = latest?.activeSubMissions?.map((entry) => entry.id) ?? [];
        if (latestIds.length > 0) {
          await this.logMissionCompletionBlocked(
            missionId,
            latest?.status ?? previousStatus,
            latestIds
          );
        }
      }
      throw error;
    }

    const currentPhase = state.missions[missionId]?.phase ?? previousPhase;
    if (currentPhase !== previousPhase) {
      this.emit('phaseTransition', {
        missionId,
        from: previousPhase,
        to: currentPhase,
        ts: now,
        reason: 'mission_completed',
      });
    }

    this.emit('stateChanged', state);
    const missionState = state.missions[missionId];
    if (missionState) {
      await this.observability.recordEvent({
        missionId,
        category: 'mission',
        type: 'mission_completed',
        status: missionState.status,
        data: {
          summary: options.summary,
        },
      });
      await this.observability.recordQualityGate({
        missionId,
        gate: 'mission_completion',
        status: 'passed',
        detail: 'Mission completed successfully.',
        data: {
          summary: options.summary,
        },
      });
    }
    await this.recordMissionSessionEvent('mission_complete', {
      ts: now,
      mission: missionId,
      action: 'complete',
      status: missionState?.status ?? 'completed',
      agent: options.agent,
      summary: options.summary,
      next_hint: options.nextHint,
    });
    return state;
  }

  async pauseMission(
    missionId: string,
    options: PauseMissionOptions = {}
  ): Promise<AgenticStateSnapshot> {
    const current = await this.stateManager.getMission(missionId);
    if (!current || current.status === 'paused') {
      return this.stateManager.getState();
    }

    const now = this.nowIso();
    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId];
      /* istanbul ignore if -- mission presence guaranteed by pre-check */
      if (!mission) {
        return;
      }

      mission.status = 'paused';
      mission.updatedAt = now;
      mission.history.push(
        this.buildMissionEvent('mission_paused', now, {
          note: options.note,
        })
      );

      snapshot.workflow.paused = ensureUnique(snapshot.workflow.paused, missionId);
      if (snapshot.workflow.activeMission === missionId) {
        snapshot.workflow.activeMission = undefined;
      }
    });

    this.emit('missionPaused', { missionId, ts: now, note: options.note });
    this.emit('stateChanged', state);
    return state;
  }

  async resumeMission(missionId: string): Promise<AgenticStateSnapshot> {
    const current = await this.stateManager.getMission(missionId);
    if (!current || current.status !== 'paused') {
      return this.stateManager.getState();
    }

    const now = this.nowIso();
    const state = await this.stateManager.update((snapshot) => {
      const mission = snapshot.missions[missionId];
      /* istanbul ignore if -- mission presence guaranteed by pre-check */
      if (!mission) {
        return;
      }

      mission.status = 'in_progress';
      if (mission.phase === 'idle') {
        mission.phase = 'execution';
      }
      mission.updatedAt = now;
      mission.history.push(this.buildMissionEvent('mission_resumed', now));

      snapshot.workflow.activeMission = missionId;
      snapshot.workflow.paused = removeValue(snapshot.workflow.paused, missionId);
    });

    this.emit('missionResumed', { missionId, ts: now });
    this.emit('stateChanged', state);
    return state;
  }

  private async logMissionCompletionBlocked(
    missionId: string,
    status: MissionStatus | undefined,
    activeSubMissions: readonly string[]
  ): Promise<void> {
    await this.observability.recordEvent({
      missionId,
      category: 'mission',
      type: 'mission_completion_blocked',
      status,
      data: {
        activeSubMissions: activeSubMissions.slice(),
      },
    });
    await this.observability.recordQualityGate({
      missionId,
      gate: 'mission_completion',
      status: 'failed',
      detail: 'Active sub-missions must be completed before mission completion.',
      data: {
        activeSubMissions: activeSubMissions.slice(),
      },
    });
    emitTelemetryError(this.governanceTelemetrySource, 'mission_completion_blocked', {
      missionId,
      activeSubMissions,
    });
  }

  async runBoomerangWorkflow(
    missionId: string,
    steps: readonly BoomerangStep[],
    options: RunBoomerangWorkflowOptions = {}
  ): Promise<BoomerangWorkflowResult> {
    if (!steps || steps.length === 0) {
      throw new Error('Boomerang workflow requires at least one step');
    }

    const workflow = new BoomerangWorkflow({
      missionId,
      steps,
      runtimeRoot: options.runtimeRoot ?? this.boomerangRuntimeRoot,
      retentionDays: options.retentionDays ?? this.boomerangRetentionDays,
      maxRetries: options.maxRetries ?? this.boomerangMaxRetries,
      telemetrySource: options.telemetrySource ?? `Boomerang:${missionId}`,
      clock: options.clock ?? this.clock,
    });

    const summary = await workflow.execute(options.initialPayload);
    const state = await this.stateManager.update((snapshot) => {
      const mission =
        snapshot.missions[missionId] ?? createMissionState(missionId, summary.startedAt);
      const previousRuns = mission.boomerangMetrics?.runs ?? 0;

      mission.boomerangMetrics = {
        runs: previousRuns + 1,
        lastRun: {
          startedAt: summary.startedAt,
          completedAt: summary.completedAt,
          status: summary.status,
          completedSteps: [...summary.completedSteps],
          failedStep: summary.failedStep,
          fallbackReason: summary.fallbackReason,
          diagnostics: { ...summary.diagnostics },
          lastOutput: summary.lastOutput,
        },
      };

      mission.history.push(
        this.buildMissionEvent('boomerang_run_completed', summary.completedAt, {
          status: summary.status,
          completedSteps: summary.completedSteps,
          failedStep: summary.failedStep,
          fallbackReason: summary.fallbackReason,
          retainedCheckpoints: summary.diagnostics.retainedCheckpoints,
        })
      );

      if (summary.status === 'fallback') {
        mission.history.push(
          this.buildMissionEvent('boomerang_fallback_triggered', summary.completedAt, {
            failedStep: summary.failedStep,
            fallbackReason: summary.fallbackReason,
            attempts: summary.diagnostics.attempts,
          })
        );
      }

      mission.updatedAt = summary.completedAt;
      snapshot.missions[missionId] = mission;
    });

    this.emit('stateChanged', state);
    await this.observability.recordEvent({
      missionId,
      category: 'workflow',
      type: 'boomerang_run_completed',
      status: summary.status,
      data: {
        completedSteps: summary.completedSteps,
        failedStep: summary.failedStep,
        fallbackReason: summary.fallbackReason,
        retainedCheckpoints: summary.diagnostics.retainedCheckpoints,
      },
    });

    const gateStatus: AgenticQualityGateResult['status'] =
      summary.status === 'success' ? 'passed' : 'failed';
    const gateDetail =
      summary.status === 'success'
        ? 'Boomerang workflow completed successfully.'
        : summary.status === 'fallback'
          ? 'Boomerang workflow fallback triggered.'
          : 'Boomerang workflow failed.';
    await this.observability.recordQualityGate({
      missionId,
      gate: 'boomerang_run_status',
      status: gateStatus,
      detail: gateDetail,
      data: {
        status: summary.status,
        failedStep: summary.failedStep,
        fallbackReason: summary.fallbackReason,
      },
    });
    return summary;
  }

  async runSelfImprovementLoop<TState>(
    missionId: string,
    handlers: RSIPLoopHandlers<TState>,
    options?: RSIPLoopOptions
  ): Promise<RSIPLoopSummary<TState>> {
    const mergedOptions: RSIPLoopOptions = {
      ...(options ?? {}),
      telemetrySource: options?.telemetrySource ?? `RSIP:${missionId}`,
      clock: options?.clock ?? this.clock,
    };

    const loopSummary = await runRSIPLoop(handlers, mergedOptions);
    const state = await this.stateManager.update((snapshot) => {
      const mission =
        snapshot.missions[missionId] ?? createMissionState(missionId, loopSummary.startedAt);
      const previous = mission.rsipMetrics ?? { runs: 0, totalIterations: 0 };

      mission.rsipMetrics = {
        runs: previous.runs + 1,
        totalIterations: previous.totalIterations + loopSummary.iterations.length,
        lastRun: {
          startedAt: loopSummary.startedAt,
          completedAt: loopSummary.completedAt,
          converged: loopSummary.converged,
          reason: loopSummary.reason,
          iterations: loopSummary.iterations.map((iteration, index) => ({
            index: index + 1,
            improvementScore: iteration.improvementScore,
            summary: iteration.summary,
          })),
        },
      };

      mission.history.push(
        this.buildMissionEvent('self_improvement_run', loopSummary.completedAt, {
          iterations: loopSummary.iterations.length,
          converged: loopSummary.converged,
          reason: loopSummary.reason,
        })
      );
      mission.updatedAt = loopSummary.completedAt;
      snapshot.missions[missionId] = mission;
    });

    const mission = state.missions[missionId];
    if (mission?.rsipMetrics?.lastRun) {
      this.emit('selfImprovementRun', { missionId, summary: mission.rsipMetrics.lastRun });
    }

    this.emit('stateChanged', state);
    await this.observability.recordEvent({
      missionId,
      category: 'workflow',
      type: 'self_improvement_run',
      status: loopSummary.converged ? 'converged' : (loopSummary.reason ?? 'stopped'),
      data: {
        iterations: loopSummary.iterations.length,
        converged: loopSummary.converged,
        reason: loopSummary.reason,
      },
    });
    await this.observability.recordQualityGate({
      missionId,
      gate: 'self_improvement_convergence',
      status: loopSummary.converged ? 'passed' : 'warning',
      detail: loopSummary.converged
        ? 'RSIP loop converged successfully.'
        : `RSIP loop ended without convergence (${loopSummary.reason ?? 'unknown'}).`,
      data: {
        iterations: loopSummary.iterations.length,
        converged: loopSummary.converged,
        reason: loopSummary.reason,
      },
    });
    return loopSummary;
  }

  async buildDynamicQuery(
    missionId: string,
    baseQuery: string,
    options: DynamicQueryOptions = {}
  ): Promise<string> {
    const historyLimit = options.historyLimit ?? this.historyLimit;
    const events = await this.historyAnalyzer.loadEvents();
    const relevantEvents = events
      .filter((event) => event.mission === missionId)
      .slice(-historyLimit);

    const state = await this.stateManager.getState();
    const mission = state.missions[missionId] ?? createMissionState(missionId, this.nowIso());
    const lines: string[] = [];

    lines.push(`Mission ${missionId} Agentic Query`);
    if (mission.objective) {
      lines.push(`Objective: ${mission.objective}`);
    }
    lines.push(`Status: ${mission.status}`);
    lines.push(`Phase: ${mission.phase}`);
    if (mission.currentSubMission) {
      lines.push(`Active Sub-Mission: ${mission.currentSubMission}`);
    }

    const includeSummary = options.includeContextSummary ?? true;
    if (includeSummary && mission.lastContext) {
      lines.push(`Latest Context Summary (${mission.lastContext.generatedAt}):`);
      lines.push(mission.lastContext.summary.summary);
    }

    if ((!includeSummary || !mission.lastContext) && options.supplementalContext) {
      lines.push('Supplemental Context:');
      lines.push(options.supplementalContext);
    }

    if (relevantEvents.length > 0) {
      lines.push('Recent Mission History:');
      for (const event of relevantEvents) {
        const parts: string[] = [`[${event.ts}]`, event.action.toUpperCase()];
        if (event.status) {
          parts.push(`(${event.status})`);
        }
        if (event.summary) {
          parts.push(`→ ${event.summary}`);
        }
        if (event.next_hint) {
          parts.push(`next: ${event.next_hint}`);
        }
        lines.push(parts.join(' '));
      }
    }

    lines.push('Primary Prompt:');
    lines.push(baseQuery.trim());

    const query = lines.join('\n');
    const generatedAt = this.nowIso();
    const snapshot: DynamicQuerySnapshot = {
      generatedAt,
      query,
      baseQuery,
      historyEvents: relevantEvents,
    };

    const updatedState = await this.stateManager.update((mutable) => {
      const target = mutable.missions[missionId] ?? createMissionState(missionId, generatedAt);
      target.lastDynamicQuery = snapshot;
      target.history.push(
        this.buildMissionEvent('query_built', generatedAt, {
          historyCount: relevantEvents.length,
        })
      );
      target.updatedAt = generatedAt;
      mutable.missions[missionId] = target;
    });

    this.emit('queryReady', { missionId, query, baseQuery, generatedAt });
    this.emit('stateChanged', updatedState);
    return query;
  }

  private async triggerContextPropagation(missionId: string): Promise<void> {
    const state = await this.stateManager.getState();
    const mission = state.missions[missionId];
    /* istanbul ignore if -- mission existence ensured before propagation */
    if (!mission) {
      return;
    }

    const completedResults: SubMissionResult[] = mission.subMissions.map((entry) => ({
      missionId: entry.missionId,
      input: entry.input,
      output: entry.output,
      status: entry.status,
      timestamp: new Date(entry.timestamp),
      metadata: entry.metadata,
    }));

    const relatedMissionIds = this.collectRelatedMissionIds(state, missionId);

    const summary = await this.propagator.propagateContext(
      mission.objective ?? missionId,
      completedResults,
      mission.currentSubMission ?? missionId,
      {
        includeHistory: true,
        relatedMissionIds,
      }
    );

    const generatedAt = this.nowIso();
    const contextSnapshot: MissionContextSnapshot = {
      generatedAt,
      summary,
    };

    const updatedState = await this.stateManager.update((mutable) => {
      const target = mutable.missions[missionId] ?? createMissionState(missionId, generatedAt);
      target.lastContext = contextSnapshot;
      target.history.push(
        this.buildMissionEvent('context_propagated', generatedAt, {
          strategy: summary.strategy,
          tokenCount: summary.tokenCount,
          retrievedChunks: summary.retrievedChunks.length,
        })
      );
      target.updatedAt = generatedAt;
      mutable.missions[missionId] = target;
    });

    this.emit('contextUpdated', { missionId, context: contextSnapshot });
    this.emit('stateChanged', updatedState);
  }

  private collectRelatedMissionIds(state: AgenticStateSnapshot, missionId: string): string[] {
    const related = [
      ...state.workflow.completed.slice(-3),
      ...state.workflow.queue.slice(0, 2),
    ].filter((id) => id && id !== missionId);

    return Array.from(new Set(related));
  }

  private normalizeSyncAutomationOptions(
    automation?: AgenticCmosSyncAutomationOptions
  ): AgenticCmosSyncAutomationOptions {
    const triggers =
      automation?.triggers && automation.triggers.length > 0
        ? Array.from(new Set(automation.triggers))
        : [...DEFAULT_CMOS_SYNC_TRIGGERS];

    return {
      includeContexts: automation?.includeContexts ?? false,
      includeSessionEvents: automation?.includeSessionEvents ?? true,
      direction: automation?.direction,
      force: automation?.force,
      triggers,
    };
  }

  private buildMissionEvent(
    type: AgenticMissionEvent['type'],
    ts: string,
    payload?: Record<string, unknown>
  ): AgenticMissionEvent {
    return {
      ts,
      type,
      payload,
    };
  }

  private async recordMissionSessionEvent(
    trigger: AgenticMissionSyncTrigger,
    event: MissionHistoryEvent
  ): Promise<void> {
    await this.appendSessionEvent(event);
    await this.runCmosAutoSync(trigger);
  }

  private async appendSessionEvent(event: MissionHistoryEvent): Promise<void> {
    const targetPath = await resolveWorkspacePath(this.sessionsPath, {
      allowRelative: true,
      baseDir: this.cmosProjectRoot,
    });
    await ensureDir(dirname(targetPath));
    await fs.appendFile(targetPath, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  private async runCmosAutoSync(trigger: AgenticMissionSyncTrigger): Promise<void> {
    if (!this.cmosSyncService || !this.cmosSyncAutomation) {
      return;
    }

    const triggers = this.cmosSyncAutomation.triggers ?? DEFAULT_CMOS_SYNC_TRIGGERS;
    if (triggers.length > 0 && !triggers.includes(trigger)) {
      return;
    }

    const includeContexts = this.cmosSyncAutomation.includeContexts ?? false;
    const includeSessionEvents = this.cmosSyncAutomation.includeSessionEvents ?? true;
    if (!includeContexts && !includeSessionEvents) {
      return;
    }

    const request: SyncRequestOptions = {
      direction: this.cmosSyncAutomation.direction,
      force: this.cmosSyncAutomation.force,
      includeContexts,
      includeSessionEvents,
    };

    try {
      const result = await this.cmosSyncService.syncAll(request);
      this.reportCmosSyncResult(trigger, result);
    } catch (error) {
      emitTelemetryWarning(this.cmosSyncTelemetrySource, 'cmos_sync_failed', {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reportCmosSyncResult(trigger: AgenticMissionSyncTrigger, result: CmosSyncResult): void {
    const context = {
      trigger,
      status: result.status,
      ok: result.ok,
      direction: result.direction,
      durationMs: result.durationMs,
      sessionEventsInserted: result.sessionEvents.inserted,
      sessionEventsSkipped: result.sessionEvents.skipped,
      warnings: result.warnings,
      errors: result.errors,
    };

    if (result.ok) {
      emitTelemetryInfo(this.cmosSyncTelemetrySource, 'cmos_sync_completed', context);
    } else {
      emitTelemetryWarning(this.cmosSyncTelemetrySource, 'cmos_sync_partial', context);
    }
  }

  private emit<K extends keyof AgenticEventMap>(event: K, payload: AgenticEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  private runCmosDetection(forceRefresh: boolean): Promise<CmosDetectionResult | null> {
    if (!this.cmosIntegrationEnabled) {
      return Promise.resolve(null);
    }

    const execution = this.executeCmosDetection(forceRefresh);
    const trackedPromise = execution.finally(() => {
      if (this.cmosDetectionPromise === trackedPromise) {
        this.cmosDetectionPromise = null;
      }
    });
    this.cmosDetectionPromise = trackedPromise;
    return trackedPromise;
  }

  private async executeCmosDetection(forceRefresh: boolean): Promise<CmosDetectionResult | null> {
    try {
      const detector = this.cmosDetector ?? CmosDetector.getInstance();
      const detectionOptions = this.buildCmosDetectionOptions(forceRefresh);
      const result = await detector.detect(this.cmosProjectRoot, detectionOptions);
      this.cmosDetectionResult = result;
      emitTelemetryInfo(this.cmosTelemetrySource, 'cmos_detection_status', {
        projectRoot: result.projectRoot,
        cmosDirectory: result.cmosDirectory,
        hasCmosDirectory: result.hasCmosDirectory,
        hasDatabase: result.hasDatabase,
        databasePath: result.databasePath,
        checkedAt: result.checkedAt,
      });
      return result;
    } catch (error) {
      this.cmosDetectionResult = null;
      emitTelemetryWarning(this.cmosTelemetrySource, 'cmos_detection_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildCmosDetectionOptions(forceRefresh: boolean): CmosDetectionOptions | undefined {
    const baseOptions = this.cmosDetectionOptions;
    if (forceRefresh || baseOptions?.forceRefresh) {
      return {
        ...(baseOptions ?? {}),
        forceRefresh: true,
      };
    }
    return baseOptions;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}
