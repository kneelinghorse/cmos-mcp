import { describe, expect, test, jest } from '@jest/globals';
import { formatQualitySummary, getQualityGrade } from '../../src/tools/score-quality';
import type { QualityScore } from '../../src/quality/types';

const baseScore = (overrides: Partial<QualityScore>): QualityScore => ({
  total: 0.95,
  dimensions: {
    clarity: {
      score: 0.92,
      weight: 0.35,
      metrics: [
        {
          name: 'Readability',
          rawValue: 0.8,
          normalizedScore: 0.9,
          weight: 0.5,
        },
      ],
    },
    completeness: {
      score: 0.9,
      weight: 0.35,
      metrics: [
        {
          name: 'Coverage',
          rawValue: 0.75,
          normalizedScore: 0.88,
          weight: 0.5,
        },
      ],
    },
    aiReadiness: {
      score: 0.88,
      weight: 0.3,
      metrics: [
        {
          name: 'Instruction Specificity',
          rawValue: 0.7,
          normalizedScore: 0.86,
          weight: 0.5,
        },
      ],
    },
  },
  suggestions: [],
  metadata: {
    assessedAt: new Date().toISOString(),
    processingTimeMs: 420,
  },
  ...overrides,
});

describe('score-quality helpers', () => {
  test('formatQualitySummary reports no suggestions and non-verbose output', () => {
    const summary = formatQualitySummary(
      baseScore({
        suggestions: [],
        total: 0.95,
      }),
      false
    );

    expect(summary).toContain('Mission Quality Assessment');
    expect(summary).toContain('Overall Quality Score');
    expect(summary).toContain('No improvement suggestions');
    expect(summary).not.toContain('Detailed Metrics');
  });

  test('formatQualitySummary includes severity buckets and verbose metrics', () => {
    const summary = formatQualitySummary(
      baseScore({
        total: 0.72,
        suggestions: [
          {
            severity: 'critical',
            category: 'clarity',
            message: 'Fix objective',
            metric: 'objective',
          },
          {
            severity: 'important',
            category: 'completeness',
            message: 'Add success metrics',
            metric: 'success',
          },
          {
            severity: 'info',
            category: 'ai',
            message: 'Consider adding guardrails',
            metric: 'guardrails',
          },
        ],
      }),
      true
    );

    expect(summary).toContain('CRITICAL');
    expect(summary).toContain('IMPORTANT');
    expect(summary).toContain('INFO');
    expect(summary).toContain('Detailed Metrics');
    expect(summary).toContain('Clarity Metrics');
    expect(summary).toContain('Completeness Metrics');
    expect(summary).toContain('AI-Readiness Metrics');
  });

  test('getQualityGrade returns expected letter mapping', () => {
    expect(getQualityGrade(0.92)).toContain('A');
    expect(getQualityGrade(0.85)).toContain('B');
    expect(getQualityGrade(0.72)).toContain('C');
    expect(getQualityGrade(0.61)).toContain('D');
    expect(getQualityGrade(0.12)).toContain('F');
  });
});

describe('scoreQuality execution', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/loaders/yaml-loader');
    jest.dontMock('../../src/quality/quality-scorer');
  });

  test('returns quality summary when scoring succeeds', async () => {
    const mockScore = baseScore({
      suggestions: [
        {
          severity: 'info',
          category: 'clarity',
          message: 'Consider peer review',
          metric: 'clarity',
        },
      ],
    });

    jest.resetModules();
    const loadMock = jest.fn(async () => ({ missionId: 'M-42', objective: 'Upgrade platform' }));
    const scoreMock = jest.fn(async () => mockScore);

    jest.doMock('../../src/loaders/yaml-loader', () => ({
      SecureYAMLLoader: jest.fn(() => ({
        load: loadMock,
      })),
    }));

    jest.doMock('../../src/quality/quality-scorer', () => ({
      QualityScorer: jest.fn(() => ({
        score: scoreMock,
      })),
    }));

    const { scoreQuality } = await import('../../src/tools/score-quality');
    const result = await scoreQuality({ missionFile: '/tmp/m-42.yaml', verbose: true });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect((loadMock as jest.Mock).mock.calls[0][0]).toBe('m-42.yaml');
    expect(scoreMock).toHaveBeenCalledTimes(1);
    expect((scoreMock as jest.Mock).mock.calls[0][1]).toBe('M-42');
    expect(result.success).toBe(true);
    expect(result.summary).toContain('Mission Quality Assessment');
    expect(result.summary).toContain('INFO');
  });

  test('returns error payload when scoring fails', async () => {
    jest.resetModules();

    jest.doMock('../../src/loaders/yaml-loader', () => ({
      SecureYAMLLoader: jest.fn(() => ({
        load: jest.fn(async () => {
          throw new Error('failed to load mission');
        }),
      })),
    }));

    jest.doMock('../../src/quality/quality-scorer', () => ({
      QualityScorer: jest.fn(() => ({
        score: jest.fn(),
      })),
    }));

    const { scoreQuality } = await import('../../src/tools/score-quality');
    const result = await scoreQuality({ missionFile: '/tmp/missing.yaml' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed to load mission');
  });
});
