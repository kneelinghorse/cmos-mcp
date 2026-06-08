import { describe, expect, it } from '@jest/globals';

import {
  MissionBoomerangMetrics,
  MissionRSIPMetrics,
  __test__,
} from '../../src/intelligence/agentic-controller';

const { ensureUnique, removeValue, normalizeRSIPMetrics, normalizeBoomerangMetrics } = __test__;

describe('AgenticController internal helpers', () => {
  it('deduplicates mission lists using ensureUnique', () => {
    const baseline = ['A', 'B'];
    expect(ensureUnique(baseline, 'C')).toEqual(['A', 'B', 'C']);
    expect(ensureUnique(baseline, 'B')).toBe(baseline);
  });

  it('removes entries with removeValue', () => {
    expect(removeValue(['A', 'B', 'C'], 'B')).toEqual(['A', 'C']);
    expect(removeValue(['A'], 'Z')).toEqual(['A']);
  });

  it('returns undefined for missing RSIP metrics', () => {
    expect(normalizeRSIPMetrics(undefined, '2025-11-05T00:00:00Z')).toBeUndefined();
  });

  it('normalizes RSIP metrics with defensive fallbacks', () => {
    const fallback = '2025-11-05T00:00:00Z';
    const result = normalizeRSIPMetrics(
      {
        runs: 3.7,
        totalIterations: 4.9,
        lastRun: {
          startedAt: '2025-11-04T20:00:00Z',
          completedAt: '',
          converged: 'yes',
          reason: 'disabled',
          iterations: [
            { index: 2.8, improvementScore: 0.45, summary: 'First pass' },
            { improvementScore: 0.5 },
          ],
        },
      } as unknown as Partial<MissionRSIPMetrics>,
      fallback
    );

    expect(result).toEqual({
      runs: 3,
      totalIterations: 4,
      lastRun: {
        startedAt: '2025-11-04T20:00:00Z',
        completedAt: fallback,
        converged: false,
        reason: 'disabled',
        iterations: [
          { index: 2, improvementScore: 0.45, summary: 'First pass' },
          { index: 2, improvementScore: 0.5, summary: undefined },
        ],
      },
    });
  });

  it('supports error and unknown RSIP stop reasons', () => {
    const fallback = '2025-11-05T01:00:00Z';

    const errorResult = normalizeRSIPMetrics(
      {
        runs: -1,
        totalIterations: -2,
        lastRun: {
          startedAt: '',
          completedAt: '',
          converged: true,
          reason: 'error',
          iterations: 'not-an-array',
        },
      } as unknown as Partial<MissionRSIPMetrics>,
      fallback
    );

    expect(errorResult).toEqual({
      runs: 0,
      totalIterations: 0,
      lastRun: {
        startedAt: fallback,
        completedAt: fallback,
        converged: true,
        reason: 'error',
        iterations: [],
      },
    });

    const defaultReason = normalizeRSIPMetrics(
      {
        runs: 1,
        totalIterations: 1,
        lastRun: {
          startedAt: '',
          completedAt: '',
          converged: false,
          reason: 'mystery',
          iterations: [],
        },
      } as unknown as Partial<MissionRSIPMetrics>,
      fallback
    );

    expect(defaultReason?.lastRun?.reason).toBe('max_iterations');
  });

  it('returns undefined for missing boomerang metrics and normalizes runs', () => {
    expect(normalizeBoomerangMetrics(undefined)).toBeUndefined();

    const metrics: Partial<MissionBoomerangMetrics> = {
      runs: 2.6,
      lastRun: {
        startedAt: '2025-11-04T22:00:00Z',
        completedAt: '2025-11-04T22:10:00Z',
        status: 'success',
        completedSteps: ['collect'],
        diagnostics: {
          attempts: {},
          checkpointPaths: [],
          retainedCheckpoints: 0,
        },
      },
    };

    const result = normalizeBoomerangMetrics(metrics);
    expect(result).toEqual({ runs: 2, lastRun: metrics.lastRun });

    // Mutate the result to verify defensive cloning for lastRun
    result?.lastRun?.completedSteps.push('process');
    expect(metrics.lastRun?.completedSteps).toEqual(['collect']);
  });
});
