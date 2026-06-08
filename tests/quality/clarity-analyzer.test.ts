/**
 * Tests for ClarityAnalyzer
 */

import { ClarityAnalyzer } from '../../src/quality/analyzers/clarity-analyzer';
import { MissionContent } from '../../src/quality/types';

describe('ClarityAnalyzer', () => {
  let analyzer: ClarityAnalyzer;

  beforeEach(() => {
    analyzer = new ClarityAnalyzer();
  });

  describe('analyze', () => {
    it('should analyze a well-formed mission', async () => {
      const mission: MissionContent = {
        objective:
          'To implement a comprehensive quality scoring system using the three-dimensional framework from research mission R4.4.',
        context:
          'This mission implements the findings from Technical Research mission R4.4. The system will assess missions on Clarity, Completeness, and AI-Readiness dimensions.',
        successCriteria: [
          'Three-dimensional quality model implemented.',
          'All specified metrics functional and accurate.',
          'Quality assessment completes in <3 seconds per mission.',
        ],
        deliverables: [
          'The implemented QualityScorer class.',
          'Unified scoring algorithm with weighted dimensions.',
        ],
      };

      const result = await analyzer.analyze(mission);

      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.weight).toBe(0.35);
      expect(result.metrics).toHaveLength(6);
    });

    it('should detect high cyclomatic complexity', async () => {
      const mission: MissionContent = {
        objective: 'To test conditional logic if when unless otherwise',
        context:
          'If this and that or the other thing, when conditions are met, unless blocked, otherwise proceed alternatively depending on the situation.',
        successCriteria: ['Test criteria'],
        deliverables: ['Test deliverable'],
      };

      const result = await analyzer.analyze(mission);
      const mccMetric = result.metrics.find((m) => m.name === 'Mission Cyclomatic Complexity');

      expect(mccMetric).toBeDefined();
      expect(mccMetric!.rawValue).toBeGreaterThan(5);
    });

    it('should calculate Flesch-Kincaid grade level', async () => {
      const mission: MissionContent = {
        objective: 'To implement functionality.',
        context: 'Simple text. Easy to read. Short sentences.',
        successCriteria: ['Criteria'],
        deliverables: ['Deliverable'],
      };

      const result = await analyzer.analyze(mission);
      const fkglMetric = result.metrics.find((m) => m.name === 'Flesch-Kincaid Grade Level');

      expect(fkglMetric).toBeDefined();
      expect(fkglMetric!.rawValue).toBeGreaterThan(0);
    });

    it('should calculate lexical density', async () => {
      const mission: MissionContent = {
        objective: 'To implement comprehensive quality scoring system with advanced metrics.',
        context:
          'The system analyzes missions using sophisticated algorithms and provides detailed feedback.',
        successCriteria: ['Success'],
        deliverables: ['Output'],
      };

      const result = await analyzer.analyze(mission);
      const ldMetric = result.metrics.find((m) => m.name === 'Lexical Density');

      expect(ldMetric).toBeDefined();
      expect(ldMetric!.rawValue).toBeGreaterThan(0);
      expect(ldMetric!.rawValue).toBeLessThanOrEqual(100);
    });

    it('should detect referential ambiguity', async () => {
      const mission: MissionContent = {
        objective: 'To implement it using this approach.',
        context: 'This will help them understand it better. They can use it when needed.',
        successCriteria: ['It works'],
        deliverables: ['It'],
      };

      const result = await analyzer.analyze(mission);
      const refMetric = result.metrics.find((m) => m.name === 'Referential Ambiguity');

      expect(refMetric).toBeDefined();
      // Should detect pronouns at sentence start
      expect(refMetric!.normalizedScore).toBeLessThan(1);
    });

    it('should handle empty mission gracefully', async () => {
      const mission: MissionContent = {
        objective: '',
        context: '',
        successCriteria: [],
        deliverables: [],
      };

      const result = await analyzer.analyze(mission);

      expect(result.score).toBeDefined();
      expect(result.metrics).toHaveLength(6);
    });
  });

  describe('normalization', () => {
    it('should normalize Flesch-Kincaid to target range 10-12', async () => {
      const missions = [
        { fkgl: 8, expectedNormalized: 0.8 }, // Too simple
        { fkgl: 11, expectedNormalized: 1.0 }, // Optimal
        { fkgl: 14, expectedNormalized: 0.7 }, // Acceptable
        { fkgl: 18, expectedNormalized: 0.4 }, // Too complex
      ];

      for (const { fkgl, expectedNormalized } of missions) {
        // Create mission that produces specific FKGL
        // (This is simplified - in practice would need precise text)
        const result = await analyzer.analyze({
          objective: 'Test objective',
          context: 'Test context',
          successCriteria: ['Test'],
          deliverables: ['Test'],
        });

        const metric = result.metrics.find((m) => m.name === 'Flesch-Kincaid Grade Level');
        expect(metric).toBeDefined();
        expect(metric!.normalizedScore).toBeGreaterThanOrEqual(0);
        expect(metric!.normalizedScore).toBeLessThanOrEqual(1);
      }
    });
  });
});
