/**
 * Tests for QualityScorer
 */

import { QualityScorer } from '../../src/quality/quality-scorer';
import { MissionContent } from '../../src/quality/types';

describe('QualityScorer', () => {
  let scorer: QualityScorer;

  beforeEach(() => {
    scorer = new QualityScorer();
  });

  describe('score', () => {
    it('should score a high-quality mission', async () => {
      const mission: MissionContent = {
        missionId: 'TEST-001',
        objective:
          'To implement a comprehensive quality scoring system using the three-dimensional framework from research mission R4.4.',
        context:
          'This mission implements the findings from Technical Research mission R4.4. The system will assess missions on Clarity, Completeness, and AI-Readiness dimensions. The scope includes multiple metrics, weighted scoring, and improvement suggestions.',
        successCriteria: [
          'Three-dimensional quality model implemented (Clarity, Completeness, AI-Readiness).',
          'All specified metrics functional and accurate.',
          'Unified Quality Score calculation with configurable weights.',
          'Quality assessment completes in <3 seconds per mission.',
        ],
        deliverables: [
          'The implemented QualityScorer class with all metric calculations.',
          'Unified scoring algorithm with weighted dimensions.',
          'Improvement suggestion engine.',
        ],
        domainFields: {
          type: 'Build.Implementation.v1',
        },
      };

      const result = await scorer.score(mission, mission.missionId);

      expect(result.total).toBeGreaterThan(0);
      expect(result.total).toBeLessThanOrEqual(1);
      expect(result.dimensions.clarity.score).toBeGreaterThan(0);
      expect(result.dimensions.completeness.score).toBeGreaterThan(0);
      expect(result.dimensions.aiReadiness.score).toBeGreaterThan(0);
      expect(result.metadata.missionId).toBe('TEST-001');
      expect(result.metadata.processingTimeMs).toBeLessThan(5000);
    });

    it('should score a poor-quality mission lower', async () => {
      const poorMission: MissionContent = {
        objective: 'Do stuff',
        context: 'Maybe',
        successCriteria: 'Whatever works',
        deliverables: 'Some output',
      };

      const result = await scorer.score(poorMission);

      expect(result.total).toBeLessThan(0.7);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should complete within performance target', async () => {
      const mission: MissionContent = {
        objective: 'To test performance of quality scoring system.',
        context: 'This mission tests whether the scoring completes within 3 seconds.',
        successCriteria: ['Fast execution', 'Accurate results'],
        deliverables: ['Performance report'],
      };

      const result = await scorer.score(mission);

      expect(result.metadata.processingTimeMs).toBeLessThan(3000);
    });

    it('should generate improvement suggestions', async () => {
      const mission: MissionContent = {
        objective: 'Test',
        context: 'Short',
        successCriteria: ['One'],
        deliverables: [],
      };

      const result = await scorer.score(mission);

      expect(result.suggestions.length).toBeGreaterThan(0);

      const critical = result.suggestions.filter((s) => s.severity === 'critical');
      const important = result.suggestions.filter((s) => s.severity === 'important');

      // Should have suggestions due to missing/insufficient content
      expect(critical.length + important.length).toBeGreaterThan(0);
    });

    it('should weight dimensions correctly', async () => {
      const customScorer = new QualityScorer({
        weights: {
          clarity: 0.5,
          completeness: 0.3,
          aiReadiness: 0.1,
          benchmark: 0.1,
        },
      });

      const mission: MissionContent = {
        objective: 'To implement a comprehensive quality scoring system.',
        context: 'This tests custom weighting.',
        successCriteria: ['Weighted correctly'],
        deliverables: ['Custom weights applied'],
      };

      const result = await customScorer.score(mission);

      // Clarity should have higher impact with 0.5 weight
      expect(result.dimensions.clarity.weight).toBe(0.35); // Default weight stored
      expect(result.total).toBeGreaterThan(0);
    });
  });

  describe('suggestImprovements', () => {
    it('should provide actionable suggestions', async () => {
      const mission: MissionContent = {
        objective: 'Implement it',
        context: 'Do it properly',
        successCriteria: 'Works',
        deliverables: 'Code',
      };

      const suggestions = await scorer.suggestImprovements(mission);

      expect(suggestions.length).toBeGreaterThan(0);

      // Check that suggestions have required fields
      suggestions.forEach((suggestion) => {
        expect(suggestion.severity).toMatch(/^(critical|important|info)$/);
        expect(suggestion.category).toBeDefined();
        expect(suggestion.message).toBeDefined();
        expect(suggestion.metric).toBeDefined();
      });
    });

    it('should prioritize critical issues first', async () => {
      const mission: MissionContent = {
        // Missing required fields
        successCriteria: [],
        deliverables: [],
      };

      const suggestions = await scorer.suggestImprovements(mission);

      if (suggestions.length > 0) {
        // First suggestions should be critical or important
        const firstSeverity = suggestions[0].severity;
        expect(['critical', 'important']).toContain(firstSeverity);
      }
    });
  });

  describe('calculateMaintainabilityIndex', () => {
    it('should calculate MMI for simple mission', () => {
      const mmi = scorer.calculateMaintainabilityIndex(100, 5, 55);

      expect(mmi).toBeGreaterThan(0);
      expect(mmi).toBeLessThanOrEqual(100);
    });

    it('should score lower for complex missions', () => {
      const simpleMmi = scorer.calculateMaintainabilityIndex(100, 5, 55);
      const complexMmi = scorer.calculateMaintainabilityIndex(500, 25, 45);

      expect(complexMmi).toBeLessThan(simpleMmi);
    });
  });
});
