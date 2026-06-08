import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

import {
  runRSIPLoop,
  RSIPIterationContext,
  RSIPLoopSummary,
} from '../../src/intelligence/rsip-loop';
import {
  registerTelemetryHandler,
  setTelemetryLevel,
  TelemetryEvent,
} from '../../src/intelligence/telemetry';

describe('runRSIPLoop', () => {
  let telemetryEvents: TelemetryEvent[];

  beforeEach(() => {
    telemetryEvents = [];
    setTelemetryLevel('info');
    registerTelemetryHandler((event) => {
      telemetryEvents.push(event);
    });
  });

  afterEach(() => {
    registerTelemetryHandler(null);
    setTelemetryLevel('warning');
  });

  it('respects disabled toggle and invokes finalize once', async () => {
    const finalize = jest.fn(async (_summary: RSIPLoopSummary<{ unused: boolean }>) => undefined);
    const iterate = jest.fn(async () => ({
      state: { unused: true },
      improvementScore: 1,
    }));

    const summary = await runRSIPLoop(
      { iterate, finalize },
      {
        enabled: false,
        telemetrySource: 'rsip-test',
        clock: () => new Date('2025-11-04T00:00:00Z'),
      }
    );

    expect(summary.converged).toBe(false);
    expect(summary.reason).toBe('disabled');
    expect(summary.iterations).toHaveLength(0);
    expect(iterate).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);

    const disabledEvent = telemetryEvents.find(
      (event) => event.message === 'RSIP loop disabled via configuration toggle'
    );
    expect(disabledEvent).toBeDefined();
  });

  it('converges after consecutive below-threshold iterations', async () => {
    const improvements = [0.4, 0.03, 0.02, 0.9];
    const iterate = jest.fn(async (context: RSIPIterationContext<{ total: number }>) => ({
      state: { total: (context.state?.total ?? 0) + 1 },
      improvementScore: improvements[context.iteration - 1] ?? 0,
      summary: `iteration-${context.iteration}`,
    }));

    const summary = await runRSIPLoop<{ total: number }>(
      { iterate },
      {
        maxIterations: 5,
        minIterations: 2,
        convergenceThreshold: 0.05,
        stagnationLimit: 2,
        telemetrySource: 'rsip-test',
        clock: () => new Date('2025-11-04T00:10:00Z'),
      }
    );

    expect(summary.converged).toBe(true);
    expect(summary.reason).toBe('converged');
    expect(summary.iterations).toHaveLength(3);
    expect(iterate).toHaveBeenCalledTimes(3);

    const completionEvent = telemetryEvents.find(
      (event) => event.message === 'RSIP loop completed'
    );
    expect(completionEvent?.context).toMatchObject({
      iterations: 3,
      converged: true,
      reason: 'converged',
    });
  });

  it('records error reason and telemetry when iteration throws', async () => {
    const iterate = jest.fn(async () => {
      throw new Error('iteration failed');
    });

    const summary = await runRSIPLoop<Record<string, never>>(
      { iterate },
      {
        maxIterations: 3,
        telemetrySource: 'rsip-test',
        clock: () => new Date('2025-11-04T00:20:00Z'),
      }
    );

    expect(summary.converged).toBe(false);
    expect(summary.reason).toBe('error');
    expect(summary.error?.message).toBe('iteration failed');
    expect(summary.iterations).toHaveLength(0);

    const errorEvent = telemetryEvents.find((event) => event.message === 'RSIP loop failed');
    expect(errorEvent?.level).toBe('error');
  });

  it('emits regression warnings and honors explicit convergence flags', async () => {
    const iterate = jest.fn(async (context: RSIPIterationContext<{ total: number }>) => {
      if (context.iteration === 1) {
        return { state: { total: 1 }, improvementScore: -0.2, summary: 'regressed' };
      }
      return { state: { total: 2 }, improvementScore: 0.01, summary: 'done', converged: true };
    });

    const summary = await runRSIPLoop(
      { iterate },
      {
        maxIterations: 3,
        minIterations: 1,
        telemetrySource: 'rsip-test',
        clock: () => new Date('2025-11-04T00:30:00Z'),
      }
    );

    expect(summary.converged).toBe(true);
    expect(summary.reason).toBe('converged');
    expect(iterate).toHaveBeenCalledTimes(2);

    const regressionEvent = telemetryEvents.find(
      (event) => event.message === 'RSIP iteration regressed'
    );
    expect(regressionEvent).toBeDefined();
  });
});
