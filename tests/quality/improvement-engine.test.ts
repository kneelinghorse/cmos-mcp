import { describe, expect, test } from '@jest/globals';
import { ImprovementEngine } from '../../src/quality/improvement-engine';

const metric = (name: string, rawValue: number, details: any = {}) => ({
  name,
  rawValue,
  normalizedScore: rawValue,
  weight: 1,
  details,
});

describe('ImprovementEngine', () => {
  test('generates suggestions across dimensions', () => {
    const engine = new ImprovementEngine();

    const clarityScore = {
      score: 0.4,
      weight: 0.35,
      metrics: [
        metric('Syntactic Validity', 0),
        metric('Syntactic Validity', 1),
        metric('Mission Cyclomatic Complexity', 25, { riskLevel: 'High', decisionPoints: 12 }),
        metric('Mission Cyclomatic Complexity', 15, {}),
        metric('Mission Cyclomatic Complexity', 5, {}),
        metric('Flesch-Kincaid Grade Level', 16.4, {}),
        metric('Flesch-Kincaid Grade Level', 7.5, {}),
        metric('Flesch-Kincaid Grade Level', 11, {}),
        metric('Lexical Density', 45, { percentage: '45%' }),
        metric('Lexical Density', 60, { percentage: '60%' }),
        metric('Referential Ambiguity', 0.6, {}),
        metric('Referential Ambiguity', 0.95, {}),
        metric('Lexical Ambiguity', 0.4, { ambiguousWordCount: 6 }),
        metric('Lexical Ambiguity', 0.4, { ambiguousWordCount: 2 }),
      ],
    };

    const completenessScore = {
      score: 0.5,
      weight: 0.35,
      metrics: [
        metric('Structural Completeness', 0.5, { missing: ['context', 'deliverables'] }),
        metric('Structural Completeness', 0.2),
        metric('Structural Completeness', 1, { missing: [] }),
        metric('Information Density', 0.6, {
          objectiveWords: 5,
          contextWords: 20,
          successCriteriaCount: 1,
        }),
        metric('Information Density', 0.8, {
          objectiveWords: 15,
          contextWords: 60,
          successCriteriaCount: 4,
        }),
        metric('Information Breadth', 0.4, {}),
        metric('Information Breadth', 0.8, {}),
        metric('Semantic Coverage', 0.65, {}),
        metric('Semantic Coverage', 0.95, {}),
      ],
    };

    const aiReadinessScore = {
      score: 0.4,
      weight: 0.3,
      metrics: [
        metric('Instruction Specificity', 0.5, {
          hasExplicitGoal: false,
          hasFormatSpec: false,
          hasConstraints: false,
          hasSuccessCriteria: false,
        }),
        metric('Instruction Specificity', 0.9, {
          hasExplicitGoal: true,
          hasFormatSpec: true,
          hasConstraints: true,
          hasSuccessCriteria: true,
        }),
        metric('Linting Score', 0.8, {
          vaguePhrasesCount: 6,
          vaguePhrasesFound: ['maybe', 'sort of'],
          emptyFieldsCount: 2,
        }),
        metric('Linting Score', 0.8, {
          vaguePhrasesCount: 0,
          emptyFieldsCount: 0,
        }),
      ],
    };

    const mission = {
      objective: 'Improve mission quality scoring',
      context: 'Testing improvement engine',
      successCriteria: ['Add unit tests', 'Reach coverage targets'],
      deliverables: ['Quality report'],
      domainFields: {},
    } as any;

    const suggestions = engine.generateSuggestions(
      clarityScore as any,
      completenessScore as any,
      aiReadinessScore as any,
      mission
    );
    expect(suggestions.length).toBeGreaterThan(0);

    const categories = suggestions.reduce<Record<string, number>>((map, suggestion) => {
      map[suggestion.category] = (map[suggestion.category] || 0) + 1;
      return map;
    }, {});

    expect(categories.Structure).toBeDefined();
    expect(categories.Clarity).toBeDefined();
    expect(categories.Completeness).toBeDefined();
    expect(categories['AI-Readiness']).toBeDefined();
  });

  test('structural completeness rule tolerates missing details payload', () => {
    const engine = new ImprovementEngine();
    const suggestions = (engine as any).evaluateMetric(
      'Structural Completeness',
      { rawValue: 0.4, details: undefined },
      {} as any
    );

    expect(suggestions[0].message).toContain('Mission is missing required fields');
  });

  test('information density rule skips issues when details exceed thresholds', () => {
    const engine = new ImprovementEngine();
    const suggestions = (engine as any).evaluateMetric(
      'Information Density',
      {
        rawValue: 0.65,
        details: {
          objectiveWords: 20,
          contextWords: 80,
          successCriteriaCount: 5,
        },
      },
      {} as any
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].message).not.toContain('objective is too brief');
    expect(suggestions[0].message).not.toContain('context lacks detail');
    expect(suggestions[0].message).not.toContain('insufficient success criteria');
  });
});
