import { describe, expect, it } from '@jest/globals';
import { __test__ } from '../../src/intelligence/agentic-controller';

const { normalizeRSIPMetrics, normalizeBoomerangMetrics } = __test__;

describe('Mission state normalization helpers', () => {
  const fallbackTimestamp = '2025-11-05T00:00:00Z';

  it('returns undefined when RSIP metrics are missing', () => {
    expect(normalizeRSIPMetrics(undefined, fallbackTimestamp)).toBeUndefined();
  });

  it('normalizes malformed RSIP metrics with defensive defaults', () => {
    const normalized = normalizeRSIPMetrics(
      {
        runs: -3,
        totalIterations: Number.NaN,
        lastRun: {
          startedAt: '',
          completedAt: '',
          converged: 'yes' as unknown as boolean,
          reason: 'unexpected' as unknown as any,
          iterations: [
            { index: 0 as unknown as number, improvementScore: -1, summary: '' },
            { improvementScore: 0.1 } as any,
          ],
        },
      },
      fallbackTimestamp
    );

    expect(normalized?.runs).toBe(0);
    expect(normalized?.totalIterations).toBe(0);
    expect(normalized?.lastRun?.startedAt).toBe(fallbackTimestamp);
    expect(normalized?.lastRun?.completedAt).toBe(fallbackTimestamp);
    expect(normalized?.lastRun?.converged).toBe(false);
    expect(normalized?.lastRun?.reason).toBe('max_iterations');
    expect(normalized?.lastRun?.iterations).toEqual([
      { index: 1, improvementScore: -1, summary: '' },
      { index: 2, improvementScore: 0.1, summary: undefined },
    ]);
  });

  it('preserves explicit RSIP error reason when provided', () => {
    const normalized = normalizeRSIPMetrics(
      {
        runs: 2,
        totalIterations: 3,
        lastRun: {
          startedAt: '2025-11-01T00:00:00Z',
          completedAt: '2025-11-01T00:10:00Z',
          converged: true,
          reason: 'error',
          iterations: [],
        },
      },
      fallbackTimestamp
    );

    expect(normalized?.runs).toBe(2);
    expect(normalized?.totalIterations).toBe(3);
    expect(normalized?.lastRun?.reason).toBe('error');
    expect(normalized?.lastRun?.startedAt).toBe('2025-11-01T00:00:00Z');
    expect(normalized?.lastRun?.completedAt).toBe('2025-11-01T00:10:00Z');
  });

  it('sanitizes boomerang metrics and clones last run payload', () => {
    const normalized = normalizeBoomerangMetrics({
      runs: -1,
      lastRun: {
        startedAt: '2025-11-01T00:00:00Z',
        completedAt: '2025-11-01T00:05:00Z',
        status: 'success',
        completedSteps: ['plan'],
        diagnostics: {
          attempts: {},
          checkpointPaths: [],
          retainedCheckpoints: 1,
        },
      },
    });

    expect(normalized?.runs).toBe(0);
    expect(normalized?.lastRun?.status).toBe('success');
    expect(normalized?.lastRun?.completedSteps).toEqual(['plan']);
  });
});
