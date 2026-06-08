import { describe, expect, it } from '@jest/globals';
import { ImprovementEngine } from '../../src/quality/improvement-engine';

describe('ImprovementEngine edge cases', () => {
  it('falls back to defaults when metric details are malformed', () => {
    const engine = new ImprovementEngine();

    const suggestions = (engine as any).evaluateMetric(
      'Mission Cyclomatic Complexity',
      {
        rawValue: 25,
        details: { riskLevel: 99, decisionPoints: 'many' },
      },
      {} as any
    );

    expect(suggestions[0].message).toContain('Risk: unknown');
    expect(suggestions[0].message).toContain('decision points (unknown)');
  });

  it('handles lexical density and linting when supporting data is missing', () => {
    const engine = new ImprovementEngine();

    const lexicalDensity = (engine as any).evaluateMetric(
      'Lexical Density',
      { rawValue: 40, details: { percentage: 123 as unknown as string } },
      {} as any
    );
    expect(lexicalDensity[0].message).toContain('N/A');

    const linting = (engine as any).evaluateMetric(
      'Linting Score',
      {
        rawValue: 0.2,
        details: { vaguePhrasesCount: 7, vaguePhrasesFound: [123], emptyFieldsCount: 0 },
      },
      {} as any
    );
    expect(linting[0].message).toContain('vague phrases');
    expect(linting[0].message).toContain('n/a');

    const constraintGap = (engine as any).evaluateMetric(
      'Instruction Specificity',
      {
        rawValue: 0.6,
        details: {
          hasExplicitGoal: true,
          hasFormatSpec: true,
          hasConstraints: 'yes' as unknown as boolean,
          hasSuccessCriteria: true,
        },
      },
      {} as any
    );
    expect(constraintGap[0].message).toContain('Mission lacks explicit constraints');

    const emptyFields = (engine as any).evaluateMetric(
      'Linting Score',
      { rawValue: 0.9, details: { emptyFieldsCount: 0 } },
      {} as any
    );
    expect(emptyFields).toHaveLength(0);

    expect(engine.getRulesForMetric('unknown-metric')).toEqual([]);
  });
});
