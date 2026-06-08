import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  AgenticController,
  MissionContextSnapshot,
  MissionStateManager,
  MissionRSIPRunSnapshot,
} from '../../src/intelligence/agentic-controller';
import { AgenticObservability } from '../../src/intelligence/agentic-observability';
import { SubMissionResult } from '../../src/intelligence/context-propagator';
import { MissionHistoryEvent } from '../../src/intelligence/mission-history';
import {
  ContextPropagatorV3,
  ContextSummaryV3,
} from '../../src/intelligence/context-propagator-v3';
import { CmosSyncResult, CmosSyncService } from '../../src/intelligence/cmos-sync';
import {
  TelemetryEvent,
  registerTelemetryHandler,
  setTelemetryLevel,
} from '../../src/intelligence/telemetry';
import { pathExists } from '../../src/utils/fs';

const createTempEnvironment = async (): Promise<{
  baseDir: string;
  statePath: string;
  sessionsPath: string;
}> => {
  const workspaceTmp = join(process.cwd(), 'tmp');
  await fs.mkdir(workspaceTmp, { recursive: true });
  const baseDir = await fs.mkdtemp(join(workspaceTmp, 'agentic-controller-'));
  const statePath = join(baseDir, 'state.json');
  const sessionsPath = join(baseDir, 'sessions.jsonl');
  await fs.writeFile(sessionsPath, '', 'utf-8');
  return { baseDir, statePath, sessionsPath };
};

const removeTempDir = async (dir: string): Promise<void> => {
  await fs.rm(dir, { recursive: true, force: true });
};

const createPropagatorStub = () => {
  const propagateContext = jest.fn<
    Promise<ContextSummaryV3>,
    Parameters<ContextPropagatorV3['propagateContext']>
  >(async (originalMission, completedResults, currentSubMission) => ({
    originalMission,
    completedSteps: completedResults,
    summary: `Context for ${currentSubMission}`,
    tokenCount: 128,
    strategy: 'map-reduce',
    historyHighlights: [],
    retrievedChunks: [],
    retrievalStats: {
      totalChunks: completedResults.length,
      topK: 4,
      sparseWeight: 0.5,
      denseWeight: 0.5,
    },
  }));

  return {
    propagator: {
      propagateContext,
    } as unknown as ContextPropagatorV3,
    propagateContext,
  };
};

const writeSessions = async (
  sessionsPath: string,
  events: MissionHistoryEvent[]
): Promise<void> => {
  const lines = events.map((event) => JSON.stringify(event));
  await fs.writeFile(sessionsPath, `${lines.join('\n')}\n`, 'utf-8');
};

const buildSyncResult = (overrides: Partial<CmosSyncResult> = {}): CmosSyncResult => ({
  ok: true,
  status: 'completed',
  direction: 'bidirectional',
  frequency: 'manual',
  contexts: [],
  sessionEvents: {
    attempted: true,
    inserted: 1,
    skipped: 0,
    warnings: [],
  },
  warnings: [],
  errors: [],
  startedAt: '2025-11-08T00:00:00Z',
  finishedAt: '2025-11-08T00:00:01Z',
  durationMs: 1000,
  ...overrides,
});

describe('AgenticController', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
    tempDirs = [];
    registerTelemetryHandler(null);
    setTelemetryLevel('warning');
  });

  it('orchestrates multi-mission workflow routing', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:10:00Z'),
    });

    await controller.registerWorkflow(['B6.4', 'B6.5'], { resetQueue: true });

    let state = await controller.advanceWorkflow();
    expect(state.workflow.activeMission).toBe('B6.4');

    await controller.startMission('B6.4', {
      objective: 'Build agentic controller',
    });
    const activeMission = await controller.getMissionState('B6.4');
    expect(activeMission?.status).toBe('in_progress');
    expect(activeMission?.phase).toBe('execution');

    await controller.completeMission('B6.4', { summary: 'Controller delivered' });
    const completedMission = await controller.getMissionState('B6.4');
    expect(completedMission?.status).toBe('completed');
    expect(completedMission?.phase).toBe('completed');

    state = await controller.advanceWorkflow();
    expect(state.workflow.activeMission).toBe('B6.5');
    const promotedMission = await controller.getMissionState('B6.5');
    expect(promotedMission?.status).toBe('current');
  });

  it('records mission lifecycle events to the sessions log', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T18:00:00Z'),
    });

    await controller.startMission('s09-m08', {
      objective: 'Exercise session logging',
      summary: 'Kickoff optional sync tests',
      agent: 'codex',
    });

    await controller.completeMission('s09-m08', {
      summary: 'Session logging verified',
      agent: 'codex',
      nextHint: 's09-m09',
    });

    const logContent = await fs.readFile(sessionsPath, 'utf-8');
    const events = logContent
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MissionHistoryEvent);

    const startEvent = events.find(
      (event) => event.action === 'start' && event.mission === 's09-m08'
    );
    const completeEvent = events.find(
      (event) => event.action === 'complete' && event.mission === 's09-m08'
    );

    expect(startEvent).toMatchObject({
      agent: 'codex',
      summary: 'Kickoff optional sync tests',
      status: 'in_progress',
    });
    expect(completeEvent).toMatchObject({
      agent: 'codex',
      summary: 'Session logging verified',
      next_hint: 's09-m09',
      status: 'completed',
    });
  });

  it('runs CMOS sync after mission events when enabled', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const syncAll = jest.fn().mockResolvedValue(buildSyncResult());
    const syncService = { syncAll } as unknown as CmosSyncService;

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T18:05:00Z'),
      cmos: {
        projectRoot: baseDir,
        sync: {
          enabled: true,
          service: syncService,
          automation: {
            includeContexts: false,
            includeSessionEvents: true,
          },
        },
      },
    });

    await controller.startMission('s09-m10', { objective: 'Sync start test' });
    await controller.completeMission('s09-m10');

    expect(syncAll).toHaveBeenCalledTimes(2);
    expect(syncAll).toHaveBeenNthCalledWith(1, {
      direction: undefined,
      force: undefined,
      includeContexts: false,
      includeSessionEvents: true,
    });
  });

  it('emits telemetry when CMOS sync fails but continues mission execution', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const syncAll = jest.fn().mockRejectedValue(new Error('offline'));
    const syncService = { syncAll } as unknown as CmosSyncService;
    const telemetryEvents: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => telemetryEvents.push(event));
    setTelemetryLevel('info');

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T18:10:00Z'),
      cmos: {
        projectRoot: baseDir,
        sync: {
          enabled: true,
          service: syncService,
          telemetrySource: 'TestSyncTelemetry',
          automation: {
            includeContexts: false,
            includeSessionEvents: true,
          },
        },
      },
    });

    await controller.startMission('s09-m11', { objective: 'Sync failure resilience' });
    const mission = await controller.getMissionState('s09-m11');
    expect(mission?.status).toBe('in_progress');

    const warning = telemetryEvents.find(
      (event) => event.source === 'TestSyncTelemetry' && event.message === 'cmos_sync_failed'
    );
    expect(warning).toBeDefined();
  });

  describe('CMOS detection', () => {
    it('detects CMOS assets and logs telemetry when present', async () => {
      const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
      tempDirs.push(baseDir);

      const cmosDbDir = join(baseDir, 'cmos', 'db');
      await fs.mkdir(cmosDbDir, { recursive: true });
      const sqlitePath = join(cmosDbDir, 'cmos.sqlite');
      await fs.writeFile(sqlitePath, 'pragma user_version = 1;\n', 'utf-8');

      const telemetryEvents: TelemetryEvent[] = [];
      registerTelemetryHandler((event) => telemetryEvents.push(event));
      setTelemetryLevel('info');

      const { propagator } = createPropagatorStub();
      const controller = new AgenticController({
        statePath,
        sessionsPath,
        propagator,
        cmos: {
          projectRoot: baseDir,
          telemetrySource: 'TestCmosTelemetry',
        },
      });

      const detection = await controller.getCmosDetection();
      expect(detection?.hasCmosDirectory).toBe(true);
      expect(detection?.hasDatabase).toBe(true);
      expect(detection?.databasePath).toBe(sqlitePath);

      const telemetry = telemetryEvents.find(
        (event) => event.source === 'TestCmosTelemetry' && event.message === 'cmos_detection_status'
      );
      expect(telemetry).toBeDefined();
      expect(telemetry?.context).toMatchObject({
        hasCmosDirectory: true,
        hasDatabase: true,
        databasePath: sqlitePath,
      });
    });

    it('reports missing CMOS assets when directory is absent', async () => {
      const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
      tempDirs.push(baseDir);

      const telemetryEvents: TelemetryEvent[] = [];
      registerTelemetryHandler((event) => telemetryEvents.push(event));
      setTelemetryLevel('info');

      const { propagator } = createPropagatorStub();
      const controller = new AgenticController({
        statePath,
        sessionsPath,
        propagator,
        cmos: {
          projectRoot: baseDir,
          telemetrySource: 'MissingCmosTelemetry',
        },
      });

      const detection = await controller.getCmosDetection();
      expect(detection?.hasCmosDirectory).toBe(false);
      expect(detection?.hasDatabase).toBe(false);
      expect(detection?.databasePath).toBeUndefined();

      const telemetry = telemetryEvents.find(
        (event) =>
          event.source === 'MissingCmosTelemetry' && event.message === 'cmos_detection_status'
      );
      expect(telemetry).toBeDefined();
      expect(telemetry?.context).toMatchObject({
        hasCmosDirectory: false,
        hasDatabase: false,
      });
    });

    it('can disable CMOS detection entirely', async () => {
      const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
      tempDirs.push(baseDir);

      const telemetryEvents: TelemetryEvent[] = [];
      registerTelemetryHandler((event) => telemetryEvents.push(event));
      setTelemetryLevel('info');

      const { propagator } = createPropagatorStub();
      const controller = new AgenticController({
        statePath,
        sessionsPath,
        propagator,
        cmos: {
          enabled: false,
          telemetrySource: 'DisabledCmosTelemetry',
        },
      });

      const detection = await controller.getCmosDetection();
      expect(detection).toBeNull();
      const telemetry = telemetryEvents.find((event) => event.source === 'DisabledCmosTelemetry');
      expect(telemetry).toBeUndefined();
    });
  });

  it('appends workflow missions without reset and skips duplicates', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:11:00Z'),
    });

    await controller.registerWorkflow(['B6.4'], { resetQueue: true });
    await controller.registerWorkflow(['B6.4', 'B6.5', 'B6.6']);

    const state = await controller.getState();
    expect(state.workflow.queue).toEqual(['B6.4', 'B6.5', 'B6.6']);
    expect(state.missions['B6.5']).toBeDefined();
    expect(state.missions['B6.6']).toBeDefined();
  });

  it('does not advance workflow while active mission remains in progress', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-10-29T02:12:00Z') + tick++ * 60000),
    });

    await controller.registerWorkflow(['B6.4', 'B6.5'], { resetQueue: true });
    await controller.advanceWorkflow();
    await controller.startMission('B6.4');

    const nextState = await controller.advanceWorkflow();
    expect(nextState.workflow.activeMission).toBe('B6.4');
    expect(nextState.workflow.queue).toEqual(['B6.5']);
  });

  it('dedupes sub-mission results by default and respects overrides', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:13:00Z'),
    });

    await controller.startMission('B6.4');

    const result: SubMissionResult = {
      missionId: 'B6.4.a',
      input: 'Collect requirements',
      output: 'Requirements captured',
      status: 'success',
      timestamp: new Date('2025-10-29T02:13:30Z'),
    };

    await controller.recordSubMissionResult('B6.4', result);
    await controller.recordSubMissionResult('B6.4', result);

    let mission = await controller.getMissionState('B6.4');
    expect(mission?.subMissions).toHaveLength(1);

    await controller.recordSubMissionResult('B6.4', result, { dedupe: false });
    mission = await controller.getMissionState('B6.4');
    expect(mission?.subMissions).toHaveLength(2);
  });

  it('handles scoped sub-mission lifecycle with propagation', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator, propagateContext } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-11-04T02:00:00Z') + tick++ * 60000),
    });

    await controller.startMission('B8.4', {
      objective: 'Deliver sub-agent delegation framework',
      currentSubMission: 'B8.4.root',
    });

    const begunState = await controller.beginSubMission('B8.4', 'B8.4.a', {
      objective: 'Design delegation orchestrator',
    });

    let mission = begunState.missions['B8.4'];
    expect(mission?.activeSubMissions).toHaveLength(1);
    expect(mission?.currentSubMission).toBe('B8.4.a');
    expect(mission?.activeSubMissions[0].parent).toBe('B8.4.root');

    const committedState = await controller.completeSubMission('B8.4', 'B8.4.a', {
      input: 'Draft delegation API',
      output: 'Delegation API ready',
      status: 'success',
      autoPropagate: true,
    });

    mission = committedState.missions['B8.4'];
    expect(mission?.activeSubMissions).toHaveLength(0);
    expect(mission?.subMissions).toHaveLength(1);
    expect(mission?.currentSubMission).toBe('B8.4.root');

    const committedEvent = mission?.history
      .filter((event) => event.type === 'sub_mission_committed')
      .pop();
    expect(committedEvent?.payload).toMatchObject({
      subMissionId: 'B8.4.a',
      status: 'success',
    });
    expect(propagateContext).toHaveBeenCalledTimes(1);
  });

  it('restores context when rolling back active sub-missions', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-11-04T02:10:00Z') + tick++ * 60000),
    });

    await controller.startMission('B8.4', {
      objective: 'Prepare rollback test',
      currentSubMission: 'B8.4.root',
    });

    const internals = controller as unknown as { stateManager: MissionStateManager };
    const baselineContext: MissionContextSnapshot = {
      generatedAt: '2025-11-04T01:59:00Z',
      summary: {
        originalMission: 'B8.4',
        completedSteps: [],
        summary: 'Baseline context',
        tokenCount: 64,
        strategy: 'map-reduce',
        historyHighlights: [],
        retrievedChunks: [],
        retrievalStats: {
          totalChunks: 0,
          topK: 0,
          sparseWeight: 0.5,
          denseWeight: 0.5,
        },
      },
    };

    await internals.stateManager.update((snapshot) => {
      const mission = snapshot.missions['B8.4'];
      /* istanbul ignore next -- defensive guard for test setup */
      if (!mission) {
        return;
      }
      mission.lastContext = baselineContext;
    });

    await controller.beginSubMission('B8.4', 'B8.4.a');

    await internals.stateManager.update((snapshot) => {
      const mission = snapshot.missions['B8.4'];
      /* istanbul ignore next -- defensive guard for test setup */
      if (!mission) {
        return;
      }
      mission.lastContext = {
        generatedAt: '2025-11-04T02:12:00Z',
        summary: {
          originalMission: 'B8.4',
          completedSteps: [],
          summary: 'Mutated context',
          tokenCount: 32,
          strategy: 'map-reduce',
          historyHighlights: [],
          retrievedChunks: [],
          retrievalStats: {
            totalChunks: 0,
            topK: 0,
            sparseWeight: 0.5,
            denseWeight: 0.5,
          },
        },
      };
    });

    const rolledBackState = await controller.rollbackSubMission('B8.4', 'B8.4.a', {
      reason: 'Rework required',
    });

    const mission = rolledBackState.missions['B8.4'];
    expect(mission?.activeSubMissions).toHaveLength(0);
    expect(mission?.currentSubMission).toBe('B8.4.root');
    expect(mission?.lastContext?.summary.summary).toBe('Baseline context');

    const rollbackEvent = mission?.history
      .filter((event) => event.type === 'sub_mission_rolled_back')
      .pop();
    expect(rollbackEvent?.payload).toMatchObject({
      subMissionId: 'B8.4.a',
      reason: 'Rework required',
    });
  });

  it('enforces delegation guardrail on max active sub-missions', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const telemetryEvents: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => telemetryEvents.push(event));
    setTelemetryLevel('info');

    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-04T02:40:00Z'),
      delegationGuardrails: {
        maxActiveSubMissions: 1,
        telemetrySource: 'delegation-test',
      },
    });

    await controller.startMission('B8.4', {
      objective: 'Guardrail test',
      currentSubMission: 'B8.4.root',
    });

    await controller.beginSubMission('B8.4', 'B8.4.a');

    await expect(controller.beginSubMission('B8.4', 'B8.4.b')).rejects.toThrow(
      /active sub-mission limit/i
    );

    const guardrailEvent = telemetryEvents.find(
      (event) => event.level === 'warning' && event.message === 'sub_mission_guardrail_triggered'
    );
    expect(guardrailEvent).toBeDefined();
    expect(guardrailEvent?.context).toMatchObject({
      missionId: 'B8.4',
      attemptedSubMission: 'B8.4.b',
      activeCount: 1,
      limit: 1,
    });
  });

  it('blocks mission completion when sub-missions remain active', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const telemetryEvents: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => telemetryEvents.push(event));
    setTelemetryLevel('info');

    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-04T04:05:00Z'),
      governanceTelemetrySource: 'governance-test',
    });

    await controller.startMission('B8.6', {
      objective: 'Governance guardrail verification',
    });
    await controller.beginSubMission('B8.6', 'B8.6.a');

    await expect(controller.completeMission('B8.6')).rejects.toThrow(/sub-missions remain active/i);

    const logPath = join(baseDir, 'agentic-events.jsonl');
    const raw = await fs.readFile(logPath, 'utf-8');
    const entries = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const qualityEntry = entries.find(
      (entry) => entry.category === 'quality_gate' && entry.type === 'mission_completion'
    );
    expect(qualityEntry).toBeDefined();
    expect(qualityEntry?.status).toBe('failed');
    expect(qualityEntry?.data?.activeSubMissions).toEqual(['B8.6.a']);

    const telemetry = telemetryEvents.find(
      (event) => event.message === 'mission_completion_blocked'
    );
    expect(telemetry).toBeDefined();
    expect(telemetry?.context).toMatchObject({
      missionId: 'B8.6',
      activeSubMissions: ['B8.6.a'],
    });
  });

  it('deduplicates completed and paused workflow entries across repeated operations', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-04T04:20:00Z'),
    });

    await controller.registerWorkflow(['B8.9'], { resetQueue: true });
    await controller.advanceWorkflow();
    await controller.startMission('B8.9');
    await controller.pauseMission('B8.9', { note: 'cooldown' });
    await controller.pauseMission('B8.9', { note: 'duplicate pause' });

    let state = await controller.getState();
    expect(state.workflow.paused).toEqual(['B8.9']);

    await controller.resumeMission('B8.9');
    state = await controller.getState();
    expect(state.workflow.paused).toEqual([]);
    expect(state.workflow.activeMission).toBe('B8.9');

    await controller.completeMission('B8.9');
    await controller.completeMission('B8.9');

    state = await controller.getState();
    expect(state.workflow.completed).toEqual(['B8.9']);
    expect(state.workflow.activeMission).toBeUndefined();
  });

  it('emits telemetry for sub-mission lifecycle events', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const telemetryEvents: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => telemetryEvents.push(event));
    setTelemetryLevel('info');

    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-04T02:45:00Z'),
      delegationGuardrails: {
        maxActiveSubMissions: 4,
        telemetrySource: 'delegation-test',
      },
    });

    await controller.startMission('B8.4', {
      objective: 'Telemetry test',
      currentSubMission: 'B8.4.root',
    });

    await controller.beginSubMission('B8.4', 'B8.4.a', {
      objective: 'Phase A',
    });
    await controller.completeSubMission('B8.4', 'B8.4.a', {
      input: 'task',
      output: 'done',
      status: 'success',
      autoPropagate: false,
    });

    await controller.beginSubMission('B8.4', 'B8.4.b');
    await controller.rollbackSubMission('B8.4', 'B8.4.b', {
      reason: 'Needs rework',
    });

    const messages = telemetryEvents.map((event) => event.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'sub_mission_started',
        'sub_mission_completed',
        'sub_mission_rolled_back',
      ])
    );

    const completionEvent = telemetryEvents.find(
      (event) => event.message === 'sub_mission_completed'
    );
    expect(completionEvent?.context).toMatchObject({
      missionId: 'B8.4',
      subMissionId: 'B8.4.a',
      status: 'success',
    });
  });

  it('runs boomerang workflow and records mission metrics', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-11-04T03:00:00Z') + tick++ * 60000),
      boomerang: {
        runtimeRoot: 'runtime/boomerang-controller-test',
        retentionDays: 5,
        maxRetries: 2,
      },
    });

    const steps = [
      {
        id: 'plan',
        async run() {
          return {
            status: 'success' as const,
            output: { summary: 'Step planned' },
          };
        },
      },
      {
        id: 'execute',
        async run(payload: unknown, context: { attempt: number }) {
          if (context.attempt === 1) {
            return {
              status: 'retry' as const,
              diagnostic: 'Re-run build',
            };
          }
          return {
            status: 'success' as const,
            output: { artifact: 'delivered', prior: payload },
          };
        },
      },
    ];

    try {
      const summary = await controller.runBoomerangWorkflow('B8.5', steps, {
        initialPayload: { mission: 'B8.5' },
        telemetrySource: 'test::boomerang::controller',
      });

      expect(summary.status).toBe('success');
      expect(summary.completedSteps).toEqual(['plan', 'execute']);
      expect(summary.diagnostics.retainedCheckpoints).toBe(0);

      const mission = await controller.getMissionState('B8.5');
      expect(mission?.boomerangMetrics?.runs).toBe(1);
      expect(mission?.boomerangMetrics?.lastRun?.status).toBe('success');
      expect(mission?.history.some((event) => event.type === 'boomerang_run_completed')).toBe(true);

      const missionDir = join('runtime/boomerang-controller-test', 'B8.5');
      expect(await pathExists(missionDir)).toBe(false);
    } finally {
      await fs.rm('runtime/boomerang-controller-test', { recursive: true, force: true });
    }
  });

  it('logs quality gates when boomerang workflow falls back', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-04T04:06:00Z'),
    });

    const steps = [
      {
        id: 'retry-step',
        async run() {
          return { status: 'retry' as const };
        },
      },
    ];

    const summary = await controller.runBoomerangWorkflow('B8.6', steps, {
      runtimeRoot: join(baseDir, 'boomerang'),
      maxRetries: 0,
      telemetrySource: 'boomerang::fallback',
    });

    expect(summary.status).toBe('fallback');

    const logPath = join(baseDir, 'agentic-events.jsonl');
    const raw = await fs.readFile(logPath, 'utf-8');
    const entries = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const workflowEntry = entries.find(
      (entry) => entry.category === 'workflow' && entry.type === 'boomerang_run_completed'
    );
    expect(workflowEntry).toMatchObject({
      missionId: 'B8.6',
      status: 'fallback',
    });

    const gateEntry = entries.find(
      (entry) => entry.category === 'quality_gate' && entry.type === 'boomerang_run_status'
    );
    expect(gateEntry).toMatchObject({
      status: 'failed',
      detail: 'Boomerang workflow fallback triggered.',
    });
    expect(gateEntry?.data?.failedStep).toBe('retry-step');
  });

  it('triggers context propagation on phase transitions', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const initialState = {
      version: 1,
      lastUpdated: '2025-10-29T02:21:00Z',
      missions: {},
      workflow: {
        activeMission: undefined,
        queue: [],
        completed: ['B6.4', null, 'B6.1'],
        paused: [],
      },
    };
    await fs.writeFile(statePath, JSON.stringify(initialState), 'utf-8');

    const { propagator, propagateContext } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-10-29T02:20:00Z') + tick++ * 60000),
    });

    await controller.startMission('B6.4', {
      objective: 'Test mission',
      currentSubMission: 'B6.4.a',
    });

    const subMission: SubMissionResult = {
      missionId: 'B6.4.a',
      input: 'Investigate state manager design',
      output: 'Proposed durable state manager',
      status: 'success',
      timestamp: new Date('2025-10-29T02:25:00Z'),
    };
    await controller.recordSubMissionResult('B6.4', subMission, { autoPropagate: true });

    await controller.updatePhase('B6.4', 'review', {
      currentSubMission: 'B6.4.a',
    });

    expect(propagateContext).toHaveBeenCalledTimes(2);
    const mission = await controller.getMissionState('B6.4');
    expect(mission?.lastContext?.summary.summary).toBe('Context for B6.4.a');
    const hasContextEvent = mission?.history.some((event) => event.type === 'context_propagated');
    expect(hasContextEvent).toBe(true);
  });

  it('builds dynamic queries with historical context', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-10-29T02:30:00Z') + tick++ * 60000),
    });

    const history: MissionHistoryEvent[] = [
      {
        ts: '2025-10-29T01:50:00Z',
        mission: 'B6.4',
        action: 'start',
        status: 'in_progress',
        summary: 'Initial agentic controller scaffolding',
      },
      {
        ts: '2025-10-29T02:05:00Z',
        mission: 'B6.4',
        action: 'complete',
        status: 'completed',
        summary: 'State manager baseline finished',
        next_hint: 'Focus on context propagation',
      },
    ];

    await writeSessions(sessionsPath, history);

    await controller.startMission('B6.4', {
      objective: 'Deliver agentic orchestration',
      currentSubMission: 'B6.4.b',
    });

    const subMission: SubMissionResult = {
      missionId: 'B6.4.b',
      input: 'Implement context propagation triggers',
      output: 'Event-driven propagation implemented',
      status: 'success',
      timestamp: new Date('2025-10-29T02:32:00Z'),
    };
    await controller.recordSubMissionResult('B6.4', subMission);
    await controller.updatePhase('B6.4', 'review', {
      currentSubMission: 'B6.4.b',
    });

    const query = await controller.buildDynamicQuery(
      'B6.4',
      'What remaining work is required for agentic handoff?'
    );

    expect(query).toContain('Mission B6.4 Agentic Query');
    expect(query).toContain('Latest Context Summary');
    expect(query).toContain('Initial agentic controller scaffolding');
    expect(query).toContain('What remaining work is required for agentic handoff?');

    const mission = await controller.getMissionState('B6.4');
    expect(mission?.lastDynamicQuery?.query).toBe(query);
    expect(mission?.lastDynamicQuery?.historyEvents?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('builds dynamic queries without context summary when disabled', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:35:00Z'),
    });

    await controller.startMission('B6.4', { objective: 'Supplemental context test' });
    const query = await controller.buildDynamicQuery('B6.4', 'Summarize state manager status', {
      includeContextSummary: false,
      supplementalContext: 'Prioritize persistence validation',
    });

    expect(query).toContain('Supplemental Context:');
    expect(query).not.toContain('Latest Context Summary');
    const mission = await controller.getMissionState('B6.4');
    expect(mission?.lastDynamicQuery?.query).toBe(query);
  });

  it('persists pause and resume state across controller instances', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    let tick = 0;
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-10-29T02:40:00Z') + tick++ * 60000),
    });

    await controller.startMission('B6.4', { objective: 'Persist state' });
    await controller.pauseMission('B6.4', { note: 'Awaiting review sign-off' });
    const secondPause = await controller.pauseMission('B6.4', { note: 'Double-check pause' });
    const pausedMission = secondPause.missions['B6.4'];
    expect(pausedMission?.status).toBe('paused');

    const pausedState = await controller.getMissionState('B6.4');
    expect(pausedState?.status).toBe('paused');

    const rehydratedController = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(Date.parse('2025-10-29T02:50:00Z') + tick++ * 60000),
    });

    await rehydratedController.resumeMission('B6.4');
    const redundantResume = await rehydratedController.resumeMission('B6.4');
    const redundantMission = redundantResume.missions['B6.4'];
    expect(redundantMission?.status).toBe('in_progress');
    const resumedMission = await rehydratedController.getMissionState('B6.4');
    expect(resumedMission?.status).toBe('in_progress');
    expect(resumedMission?.history.some((event) => event.type === 'mission_resumed')).toBe(true);

    const workflow = await rehydratedController.getState();
    expect(workflow.workflow.activeMission).toBe('B6.4');
  });

  it('emits workflow events to registered listeners', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:55:00Z'),
    });

    const workflowEvents: string[] = [];
    const listener = (event: { missionId: string }) => workflowEvents.push(event.missionId);

    controller.on('workflowAdvanced', listener);
    controller.once('phaseTransition', (event) =>
      workflowEvents.push(`${event.from}->${event.to}`)
    );

    await controller.registerWorkflow(['B6.4', 'B6.5'], { resetQueue: true });
    await controller.advanceWorkflow();
    await controller.startMission('B6.4', { phase: 'execution' });

    expect(workflowEvents).toContain('B6.4');
    expect(workflowEvents).toContain('planning->execution');

    controller.off('workflowAdvanced', listener);
    await controller.advanceWorkflow();
    expect(workflowEvents.filter((id) => id === 'B6.4')).toHaveLength(1);
  });

  it('ignores pause requests for unknown missions', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:56:00Z'),
    });

    const state = await controller.pauseMission('Z9.9');
    expect(Object.keys(state.missions)).toHaveLength(0);
  });

  it('clears completed active missions when advancing with persisted state', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const persistedState = {
      version: 1,
      lastUpdated: '2025-10-29T02:58:00Z',
      missions: {
        'B6.4': {
          missionId: 'B6.4',
          phase: 'execution',
          status: 'completed',
          updatedAt: '2025-10-29T02:57:00Z',
          completedAt: '2025-10-29T02:57:00Z',
          history: [],
          subMissions: [],
        },
      },
      workflow: {
        activeMission: 'B6.4',
        queue: ['B6.5'],
        completed: [],
        paused: [],
      },
    };

    await fs.writeFile(statePath, JSON.stringify(persistedState), 'utf-8');

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T02:59:00Z'),
    });

    const state = await controller.advanceWorkflow();
    expect(state.workflow.activeMission).toBe('B6.5');
    expect(state.workflow.completed).toContain('B6.4');
  });

  it('leaves workflow unchanged when no missions remain in the queue', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T03:00:00Z'),
    });

    const state = await controller.advanceWorkflow();
    expect(state.workflow.activeMission).toBeUndefined();
    expect(state.workflow.queue).toHaveLength(0);
  });

  it('resumes idle missions by transitioning to execution phase', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const persistedState = {
      version: 1,
      lastUpdated: '2025-10-29T03:06:00Z',
      missions: {
        'B6.4': {
          missionId: 'B6.4',
          phase: 'idle',
          status: 'paused',
          updatedAt: '2025-10-29T03:05:00Z',
          history: [],
          subMissions: [],
        },
      },
      workflow: {
        activeMission: undefined,
        queue: [],
        completed: [],
        paused: ['B6.4'],
      },
    };

    await fs.writeFile(statePath, JSON.stringify(persistedState), 'utf-8');

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T03:07:00Z'),
    });

    const state = await controller.resumeMission('B6.4');
    expect(state.workflow.activeMission).toBe('B6.4');
    const mission = await controller.getMissionState('B6.4');
    expect(mission?.phase).toBe('execution');
    expect(mission?.status).toBe('in_progress');
  });

  it('records RSIP loop runs and emits self-improvement events', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-04T01:00:00Z'),
    });

    const runEvents: Array<{ missionId: string; summary: MissionRSIPRunSnapshot }> = [];
    controller.on('selfImprovementRun', (payload) => {
      runEvents.push(payload);
    });

    const iterate = jest.fn(async (context) => ({
      state: { total: (context.state?.total ?? 0) + 1 },
      improvementScore: 0.2,
      summary: `iteration-${context.iteration}`,
      converged: true,
    }));

    const summary = await controller.runSelfImprovementLoop(
      'B8.3',
      { iterate },
      {
        maxIterations: 5,
        minIterations: 1,
        telemetrySource: 'rsip-test',
      }
    );

    expect(summary.converged).toBe(true);
    expect(summary.iterations).toHaveLength(1);
    expect(iterate).toHaveBeenCalledTimes(1);

    const mission = await controller.getMissionState('B8.3');
    expect(mission?.rsipMetrics?.runs).toBe(1);
    expect(mission?.rsipMetrics?.totalIterations).toBe(1);
    expect(mission?.rsipMetrics?.lastRun).toMatchObject({
      converged: true,
      reason: 'converged',
      iterations: [
        {
          index: 1,
          improvementScore: 0.2,
          summary: 'iteration-1',
        },
      ],
    });

    const history = mission?.history ?? [];
    const lastEvent = history[history.length - 1];
    expect(lastEvent?.type).toBe('self_improvement_run');
    expect(lastEvent?.payload).toMatchObject({
      iterations: 1,
      converged: true,
      reason: 'converged',
    });

    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]).toMatchObject({
      missionId: 'B8.3',
      summary: {
        iterations: [
          {
            index: 1,
            improvementScore: 0.2,
            summary: 'iteration-1',
          },
        ],
        converged: true,
        reason: 'converged',
      },
    });
  });

  it('ignores resume requests for missions with no state', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-10-29T03:08:00Z'),
    });

    const state = await controller.resumeMission('Z9.9');
    expect(Object.keys(state.missions)).toHaveLength(0);
  });

  it('enforces sub-mission guardrails and duplicate detection', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T00:10:00Z'),
      delegationGuardrails: { maxActiveSubMissions: 1 },
    });

    await controller.startMission('G1', { objective: 'Guardrail exercise' });
    await controller.beginSubMission('G1', 'sub-a');

    await expect(controller.beginSubMission('G1', 'sub-a')).rejects.toThrow(
      /already active for mission/
    );
    await expect(controller.beginSubMission('G1', 'sub-b')).rejects.toThrow(
      /active sub-mission limit/
    );
  });

  it('emits telemetry when completing or rolling back mismatched sub-missions', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const events: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => events.push(event));
    setTelemetryLevel('info');

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T00:12:00Z'),
    });

    await controller.startMission('M-mismatch', { objective: 'Telemetry coverage' });

    await expect(
      controller.completeSubMission('M-mismatch', 'missing', {
        input: 'payload',
        output: 'result',
        status: 'success',
        autoPropagate: false,
      })
    ).rejects.toThrow(/not active/);

    await expect(controller.rollbackSubMission('M-mismatch', 'missing')).rejects.toThrow(
      /not active/
    );

    expect(events.some((event) => event.message === 'sub_mission_mismatch')).toBe(true);
  });

  it('logs mission completion blockers when sub-missions remain active', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T00:14:00Z'),
    });

    await controller.startMission('G2', { objective: 'Completion blocker' });
    await controller.beginSubMission('G2', 'sub-a');

    await expect(
      controller.completeMission('G2', { summary: 'Attempt completion with active sub' })
    ).rejects.toThrow(/cannot be completed while sub-missions remain active/);

    const logPath = join(baseDir, 'agentic-events.jsonl');
    const logContent = await fs.readFile(logPath, 'utf-8');
    const entries = logContent
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(entries.some((entry) => entry.type === 'mission_completion_blocked')).toBe(true);
  });

  it('logs completion blockers when the state update detects lingering sub-missions', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T00:15:00Z'),
    });

    const baseMission = {
      missionId: 'G3',
      phase: 'execution',
      status: 'in_progress',
      updatedAt: '2025-11-08T00:10:00Z',
      history: [],
      subMissions: [],
      activeSubMissions: [],
    };

    const stateManager = (controller as any).stateManager as MissionStateManager;
    jest
      .spyOn(stateManager, 'getMission')
      .mockResolvedValueOnce(baseMission as any)
      .mockResolvedValueOnce({
        ...baseMission,
        activeSubMissions: [
          {
            id: 'sub-a',
            startedAt: '2025-11-08T00:11:00Z',
            parent: undefined,
          },
        ],
      } as any);
    jest.spyOn(stateManager, 'update').mockImplementation(async () => {
      throw new Error('Mission G3 cannot be completed while sub-missions remain active.');
    });

    await expect(controller.completeMission('G3', { summary: 'Force failure' })).rejects.toThrow(
      /sub-missions remain active/
    );

    const logPath = join(baseDir, 'agentic-events.jsonl');
    const logContent = await fs.readFile(logPath, 'utf-8');
    expect(logContent).toContain('mission_completion_blocked');
  });

  it('handles CMOS detection caching, failures, and disabled mode', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const detectionTs = '2025-11-08T00:15:00Z';
    const detector = {
      detect: jest.fn().mockResolvedValue({
        projectRoot: baseDir,
        cmosDirectory: baseDir,
        hasCmosDirectory: false,
        hasDatabase: false,
        databasePath: undefined,
        checkedAt: detectionTs,
      }),
    };

    const observability = new AgenticObservability({
      logPath: join(baseDir, 'obs.jsonl'),
      clock: () => new Date(detectionTs),
    });

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      observability,
      clock: () => new Date(detectionTs),
      cmos: {
        projectRoot: baseDir,
        detector: detector as any,
      },
    });

    const forced = await controller.getCmosDetection({ forceRefresh: true });
    expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(forced?.projectRoot).toBe(baseDir);

    const cached = await controller.getCmosDetection();
    expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(cached?.checkedAt).toBe(detectionTs);

    const freshDetector = {
      detect: jest.fn().mockResolvedValue({
        projectRoot: baseDir,
        cmosDirectory: baseDir,
        hasCmosDirectory: true,
        hasDatabase: true,
        databasePath: join(baseDir, 'cmos/db/cmos.sqlite'),
        checkedAt: detectionTs,
      }),
    };

    const freshController = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      observability,
      clock: () => new Date(detectionTs),
      cmos: {
        projectRoot: baseDir,
        detector: freshDetector as any,
      },
    });
    await freshController.getCmosDetection();
    expect(freshDetector.detect).toHaveBeenCalledTimes(1);

    freshDetector.detect.mockRejectedValueOnce(new Error('boom'));
    const failure = await (freshController as any).executeCmosDetection(true);
    expect(failure).toBeNull();

    const disabledController = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date(detectionTs),
      cmos: { enabled: false },
    });
    const disabledResult = await (disabledController as any).runCmosDetection(false);
    expect(disabledResult).toBeNull();
  });

  it('runs CMOS sync automation only when triggers and payloads are allowed', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const events: TelemetryEvent[] = [];
    registerTelemetryHandler((event) => events.push(event));
    setTelemetryLevel('info');

    const syncAll = jest.fn().mockResolvedValue({
      ok: false,
      direction: 'bidirectional',
      frequency: 'manual',
      contexts: [],
      sessionEvents: { attempted: true, inserted: 0, skipped: 1, warnings: [], errors: [] },
      warnings: ['slow-sync'],
      errors: ['timeout'],
      startedAt: '2025-11-08T00:20:00Z',
      finishedAt: '2025-11-08T00:20:01Z',
      durationMs: 1000,
    });

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T00:20:00Z'),
      cmos: {
        sync: {
          enabled: true,
          service: { syncAll } as unknown as CmosSyncService,
          automation: {
            triggers: ['mission_complete'],
            includeContexts: true,
            includeSessionEvents: true,
          },
        },
      },
    });

    await (controller as any).runCmosAutoSync('mission_complete');
    expect(syncAll).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.message === 'cmos_sync_partial')).toBe(true);

    const gatedSync = jest.fn();
    const gatingController = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
      clock: () => new Date('2025-11-08T00:21:00Z'),
      cmos: {
        sync: {
          enabled: true,
          service: { syncAll: gatedSync } as unknown as CmosSyncService,
          automation: {
            triggers: ['mission_complete'],
            includeContexts: false,
            includeSessionEvents: false,
          },
        },
      },
    });

    await (gatingController as any).runCmosAutoSync('mission_start');
    await (gatingController as any).runCmosAutoSync('mission_complete');
    expect(gatedSync).not.toHaveBeenCalled();
  });

  it('rejects boomerang workflows without steps', async () => {
    const { baseDir, statePath, sessionsPath } = await createTempEnvironment();
    tempDirs.push(baseDir);

    const { propagator } = createPropagatorStub();
    const controller = new AgenticController({
      statePath,
      sessionsPath,
      propagator,
    });

    await expect(controller.runBoomerangWorkflow('M-empty', [])).rejects.toThrow(
      'requires at least one step'
    );
  });
});

describe('MissionStateManager', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => removeTempDir(dir)));
    tempDirs = [];
  });

  it('returns default state when persisted file is empty', async () => {
    const baseDir = await fs.mkdtemp(join(tmpdir(), 'agentic-state-manager-'));
    tempDirs.push(baseDir);
    const statePath = join(baseDir, 'state.json');
    await fs.writeFile(statePath, '   ', 'utf-8');

    const manager = new MissionStateManager({
      statePath,
      clock: () => new Date('2025-10-29T03:00:00Z'),
    });

    const state = await manager.getState();
    expect(state.workflow.queue).toHaveLength(0);
    expect(Object.keys(state.missions)).toHaveLength(0);
  });

  it('throws when persisted file contains invalid json', async () => {
    const baseDir = await fs.mkdtemp(join(tmpdir(), 'agentic-state-manager-'));
    tempDirs.push(baseDir);
    const statePath = join(baseDir, 'state.json');
    await fs.writeFile(statePath, '{invalid json', 'utf-8');

    const manager = new MissionStateManager({ statePath });
    await expect(manager.getState()).rejects.toThrow();
  });

  it('normalizes persisted mission metadata and tags', async () => {
    const baseDir = await fs.mkdtemp(join(tmpdir(), 'agentic-state-manager-'));
    tempDirs.push(baseDir);
    const statePath = join(baseDir, 'state.json');

    const persisted = {
      version: 1,
      lastUpdated: '2025-10-29T03:05:00Z',
      missions: {
        'B6.4': {
          missionId: 'B6.4',
          phase: 'execution',
          status: 'current',
          updatedAt: '2025-10-29T03:04:00Z',
          tags: ['priority:high'],
          history: [{ ts: '2025-10-29T03:03:00Z', type: 'test_event' }],
          subMissions: [],
          metadata: { reviewer: 'codex' },
        },
      },
      workflow: {
        activeMission: 'B6.4',
        queue: [],
        completed: [],
        paused: [],
      },
    };

    await fs.writeFile(statePath, JSON.stringify(persisted), 'utf-8');

    const manager = new MissionStateManager({ statePath });
    const state = await manager.getState();

    expect(state.missions['B6.4'].tags).toEqual(['priority:high']);
    expect(state.missions['B6.4'].history).toHaveLength(1);
    expect(state.workflow.activeMission).toBe('B6.4');
  });
});
