import { promises as fs } from 'fs';
import { join } from 'path';

import {
  MissionStateManager,
  MissionState,
  RSIPStopReason,
} from '../../src/intelligence/agentic-controller';

const createTempStatePath = async (): Promise<{ directory: string; statePath: string }> => {
  const workspaceTmp = join(process.cwd(), 'tmp');
  await fs.mkdir(workspaceTmp, { recursive: true });
  const directory = await fs.mkdtemp(join(workspaceTmp, 'mission-state-manager-'));
  return { directory, statePath: join(directory, 'agentic_state.json') };
};

describe('MissionStateManager normalization', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('normalizes persisted missions with defensive defaults for analytics metrics', async () => {
    const { directory, statePath } = await createTempStatePath();
    tempDirs.push(directory);

    const persisted = {
      version: 2,
      lastUpdated: '2025-11-04T05:00:00Z',
      workflow: {
        activeMission: 'B8.1',
        queue: ['B8.2', 'B8.3'],
        completed: ['B7.9'],
        paused: ['B8.4', 123],
      },
      missions: {
        'B8.2': {},
        'B8.1': {
          phase: 'execution',
          status: 'in_progress',
          activeSubMissions: [
            {
              id: 'B8.1.a',
              startedAt: '',
              parent: '',
              metadata: { stage: 1 },
              previousContext: {
                generatedAt: '2025-11-04T04:55:00Z',
                summary: {
                  originalMission: 'B8.1',
                  completedSteps: [],
                  summary: 'Baseline context',
                  tokenCount: 256,
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
              },
            },
            {
              id: '',
              startedAt: '2025-11-04T04:56:00Z',
            },
          ],
          history: [
            {
              ts: '2025-11-04T04:58:00Z',
              type: 'mission_started',
            },
          ],
          subMissions: [
            {
              missionId: 'B8.1.a',
              input: 'Collect requirements',
              output: 'Requirements captured',
              status: 'success',
              timestamp: '2025-11-04T05:02:00Z',
            },
          ],
          rsipMetrics: {
            runs: 2.8,
            totalIterations: -1,
            lastRun: {
              startedAt: '',
              completedAt: '',
              converged: 'true' as unknown as boolean,
              reason: 'unknown' as unknown as RSIPStopReason,
              iterations: [
                { index: 0, improvementScore: 0.42, summary: 'Initial' },
                { index: undefined as unknown as number, improvementScore: 0.51 },
              ],
            },
          },
          boomerangMetrics: {
            runs: 3.6,
            lastRun: {
              startedAt: '2025-11-04T05:05:00Z',
              completedAt: '2025-11-04T05:06:00Z',
              status: 'success',
              completedSteps: ['plan'],
              diagnostics: {
                attempts: {},
                checkpointPaths: [],
                retainedCheckpoints: 1,
              },
            },
          },
        } satisfies Partial<MissionState>,
      },
    };

    await fs.writeFile(statePath, JSON.stringify(persisted), 'utf-8');

    const manager = new MissionStateManager({
      statePath,
      clock: () => new Date('2025-11-04T06:15:00Z'),
    });

    const state = await manager.getState();
    expect(state.version).toBe(2);
    expect(state.workflow.activeMission).toBe('B8.1');
    expect(state.workflow.queue).toEqual(['B8.2', 'B8.3']);

    const mission = state.missions['B8.1'];
    expect(mission.phase).toBe('execution');
    expect(mission.status).toBe('in_progress');
    expect(mission.activeSubMissions).toHaveLength(1);
    expect(mission.activeSubMissions[0].id).toBe('B8.1.a');
    expect(mission.activeSubMissions[0].startedAt).toBe('2025-11-04T06:15:00.000Z');

    expect(mission.rsipMetrics).toMatchObject({
      runs: 2,
      totalIterations: 0,
    });
    expect(mission.rsipMetrics?.lastRun).toMatchObject({
      startedAt: '2025-11-04T06:15:00.000Z',
      completedAt: '2025-11-04T06:15:00.000Z',
      converged: false,
      reason: 'max_iterations',
    });
    expect(mission.rsipMetrics?.lastRun?.iterations).toEqual([
      { index: 1, improvementScore: 0.42, summary: 'Initial' },
      { index: 2, improvementScore: 0.51, summary: undefined },
    ]);

    expect(mission.boomerangMetrics).toMatchObject({
      runs: 3,
    });
    expect(mission.boomerangMetrics?.lastRun).toMatchObject({
      startedAt: '2025-11-04T05:05:00Z',
      status: 'success',
    });

    expect(state.missions['B8.2'].rsipMetrics).toBeUndefined();
    expect(state.missions['B8.2'].boomerangMetrics).toBeUndefined();
  });

  it('creates empty state when no file exists and persists updates atomically', async () => {
    const { directory, statePath } = await createTempStatePath();
    tempDirs.push(directory);

    const manager = new MissionStateManager({
      statePath,
      clock: () => new Date('2025-11-04T06:20:00Z'),
    });

    const initial = await manager.getState();
    expect(initial.missions).toEqual({});
    expect(initial.workflow.queue).toEqual([]);
    const stats = await fs.stat(statePath);
    expect(stats.isFile()).toBe(true);

    await manager.update((snapshot) => {
      snapshot.missions['B8.9'] = {
        missionId: 'B8.9',
        phase: 'execution',
        status: 'in_progress',
        activeSubMissions: [],
        history: [],
        subMissions: [],
        updatedAt: snapshot.lastUpdated,
      };
      snapshot.workflow.queue.push('B8.9');
    });

    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    expect(persisted.workflow.queue).toContain('B8.9');
    expect(Object.keys(persisted.missions)).toContain('B8.9');

    const cached = await manager.getMission('B8.9');
    expect(cached?.status).toBe('in_progress');
  });

  it('repairs empty state files by rewriting the default snapshot', async () => {
    const { directory, statePath } = await createTempStatePath();
    tempDirs.push(directory);

    await fs.writeFile(statePath, '   ', 'utf-8');

    const manager = new MissionStateManager({
      statePath,
      clock: () => new Date('2025-11-04T07:00:00Z'),
    });

    const state = await manager.getState();
    expect(state.missions).toEqual({});
    expect(state.workflow.queue).toEqual([]);

    const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    expect(persisted).toMatchObject({
      version: 1,
      workflow: {
        queue: [],
        completed: [],
        paused: [],
      },
    });
  });
});
