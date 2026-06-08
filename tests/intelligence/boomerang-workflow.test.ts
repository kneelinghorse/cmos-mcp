import { promises as fs } from 'fs';
import { join } from 'path';

import { BoomerangStep, BoomerangWorkflow } from '../../src/intelligence/boomerang-workflow';
import {
  TelemetryEvent,
  registerTelemetryHandler,
  setTelemetryLevel,
} from '../../src/intelligence/telemetry';
import { pathExists } from '../../src/utils/fs';

describe('BoomerangWorkflow', () => {
  const runtimeRoot = 'runtime/boomerang-test';
  let telemetryEvents: TelemetryEvent[] = [];

  beforeEach(() => {
    telemetryEvents = [];
    registerTelemetryHandler((event) => telemetryEvents.push(event));
    setTelemetryLevel('info');
  });

  afterEach(async () => {
    registerTelemetryHandler(null);
    setTelemetryLevel('warning');
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  it('validates mission identifiers and step definitions', () => {
    expect(
      () =>
        new BoomerangWorkflow({
          missionId: '',
          steps: [],
          runtimeRoot,
        })
    ).toThrow('missionId is required for BoomerangWorkflow');

    expect(
      () =>
        new BoomerangWorkflow({
          missionId: 'boomerang-missing-steps',
          steps: [],
          runtimeRoot,
        })
    ).toThrow('steps are required for BoomerangWorkflow');
  });

  it('executes sequential steps and cleans up checkpoints on success', async () => {
    const missionId = 'boomerang-success';
    const steps: BoomerangStep[] = [
      {
        id: 'plan',
        async run(payload) {
          const base = (payload as { seed?: number })?.seed ?? 0;
          return {
            status: 'success',
            output: { plan: ['step-a', 'step-b'], seed: base },
            diagnostic: 'Planning complete',
          };
        },
      },
      {
        id: 'implement',
        async run(payload) {
          const plan = (payload as { plan: string[] }).plan ?? [];
          return {
            status: 'success',
            output: { completed: plan.length },
            checkpoint: { lastStep: plan[plan.length - 1] },
          };
        },
      },
    ];

    const workflow = new BoomerangWorkflow({
      missionId,
      steps,
      runtimeRoot,
      telemetrySource: 'test::boomerang::success',
    });

    const result = await workflow.execute({ seed: 1 });

    expect(result.status).toBe('success');
    expect(result.completedSteps).toEqual(['plan', 'implement']);
    expect(result.diagnostics.retainedCheckpoints).toBe(0);

    const missionDir = join(runtimeRoot, missionId);
    expect(await pathExists(missionDir)).toBe(false);
    expect(telemetryEvents.find((event) => event.message === 'step_start')).toBeDefined();
    expect(telemetryEvents.find((event) => event.message === 'step_complete')).toBeDefined();
    expect(telemetryEvents.find((event) => event.message === 'checkpoint_write')).toBeDefined();
  });

  it('triggers fallback after exceeding retry limit and retains checkpoints', async () => {
    const missionId = 'boomerang-retry';
    let attempts = 0;

    const steps: BoomerangStep[] = [
      {
        id: 'retry-step',
        async run() {
          attempts += 1;
          return {
            status: 'retry',
            diagnostic: `attempt-${attempts}`,
          };
        },
      },
    ];

    const workflow = new BoomerangWorkflow({
      missionId,
      steps,
      runtimeRoot,
      telemetrySource: 'test::boomerang::retry',
      maxRetries: 2,
    });

    const result = await workflow.execute();

    expect(result.status).toBe('fallback');
    expect(result.failedStep).toBe('retry-step');
    expect(result.fallbackReason).toBe('retry_limit_exceeded');
    expect(result.diagnostics.retainedCheckpoints).toBeGreaterThan(0);

    const missionDir = join(runtimeRoot, missionId);
    expect(await pathExists(missionDir)).toBe(true);
    const files = await fs.readdir(missionDir);
    expect(files).toContain('step-1.json');
    expect(telemetryEvents.find((event) => event.message === 'fallback_triggered')).toBeDefined();
  });

  it('handles step failures and retained checkpoints with telemetry warnings', async () => {
    const missionId = 'boomerang-failure';
    const missionDir = join(runtimeRoot, missionId);
    await fs.mkdir(missionDir, { recursive: true });
    await fs.writeFile(join(missionDir, 'step-2.json'), '{not-json}');

    const steps: BoomerangStep[] = [
      {
        id: 'fail-step',
        async run() {
          throw new Error('broken step');
        },
      },
      {
        id: 'skip',
        async run() {
          return { status: 'success' };
        },
      },
    ];

    const workflow = new BoomerangWorkflow({
      missionId,
      steps,
      runtimeRoot,
      telemetrySource: 'test::boomerang::failure',
      maxRetries: 1,
    });

    const result = await workflow.execute();

    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('fail-step');
    expect(result.diagnostics.retainedCheckpoints).toBeGreaterThan(0);

    expect(
      telemetryEvents.find((event) => event.message === 'checkpoint_load_failed')
    ).toBeDefined();
    expect(telemetryEvents.find((event) => event.message === 'step_failed')).toBeDefined();
  });

  it('prunes expired checkpoint directories based on retention window', async () => {
    const expiredMission = join(runtimeRoot, 'expired-mission');
    const activeMission = join(runtimeRoot, 'active-mission');
    const fixedNow = new Date('2025-11-04T00:00:00Z');
    const dayMs = 24 * 60 * 60 * 1000;

    await fs.mkdir(expiredMission, { recursive: true });
    await fs.writeFile(join(expiredMission, 'step-1.json'), JSON.stringify({ status: 'failed' }));
    const tenDaysAgo = fixedNow.getTime() - 10 * dayMs;
    await fs.utimes(expiredMission, tenDaysAgo / 1000, tenDaysAgo / 1000);

    await fs.mkdir(activeMission, { recursive: true });
    await fs.writeFile(join(activeMission, 'step-1.json'), JSON.stringify({ status: 'retrying' }));
    await fs.utimes(activeMission, fixedNow.getTime() / 1000, fixedNow.getTime() / 1000);

    const { removed, scanned } = await BoomerangWorkflow.pruneExpired(
      runtimeRoot,
      3,
      () => fixedNow
    );

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(scanned).toBeGreaterThanOrEqual(1);
    expect(await pathExists(expiredMission)).toBe(false);
    expect(await pathExists(activeMission)).toBe(true);
  });

  it('reuses successful persisted checkpoints without rerunning steps', async () => {
    const missionId = 'boomerang-resume';
    const missionDir = join(runtimeRoot, missionId);
    await fs.mkdir(missionDir, { recursive: true });
    await fs.writeFile(
      join(missionDir, 'step-1.json'),
      JSON.stringify(
        {
          missionId,
          stepId: 'resume-me',
          stepIndex: 0,
          status: 'success',
          attempts: [
            {
              attempt: 1,
              status: 'success',
              startedAt: '2025-11-04T00:00:00Z',
              completedAt: '2025-11-04T00:01:00Z',
            },
          ],
          lastOutput: { cached: true },
          lastCheckpoint: { foo: 'bar' },
          lastUpdated: '2025-11-04T00:01:00Z',
        },
        null,
        2
      ),
      'utf-8'
    );

    let executed = 0;
    const steps: BoomerangStep[] = [
      {
        id: 'resume-me',
        async run() {
          executed += 1;
          return { status: 'success' };
        },
      },
      {
        id: 'continue',
        async run(payload) {
          return { status: 'success', output: { fromPayload: (payload as any)?.cached === true } };
        },
      },
    ];

    const workflow = new BoomerangWorkflow({
      missionId,
      steps,
      runtimeRoot,
      telemetrySource: 'test::boomerang::resume',
    });

    const result = await workflow.execute();

    expect(executed).toBe(0);
    expect(result.completedSteps).toEqual(['resume-me', 'continue']);
    expect(result.diagnostics.attempts['resume-me']).toBe(1);
    expect(result.lastOutput).toEqual({ fromPayload: true });
  });

  it('returns empty checkpoint state when directory is absent', async () => {
    const workflow = new BoomerangWorkflow({
      missionId: 'no-checkpoints',
      steps: [
        {
          id: 'only',
          async run() {
            return { status: 'success' };
          },
        },
      ],
      runtimeRoot,
    });

    const { checkpoints, existingPaths } = await (workflow as any).loadCheckpoints(
      join(runtimeRoot, 'no-checkpoints'),
      join(runtimeRoot, 'no-checkpoints')
    );

    expect(checkpoints.size).toBe(0);
    expect(existingPaths.size).toBe(0);
  });

  it('skips pruning when retention is disabled or the runtime root is missing', async () => {
    const disabled = await BoomerangWorkflow.pruneExpired(
      'runtime/boomerang-missing',
      0,
      () => new Date('2025-11-04T00:00:00Z')
    );
    expect(disabled).toEqual({ removed: 0, scanned: 0 });

    const missing = await BoomerangWorkflow.pruneExpired(
      'runtime/boomerang-missing',
      3,
      () => new Date('2025-11-04T00:00:00Z')
    );
    expect(missing).toEqual({ removed: 0, scanned: 0 });
  });
});
