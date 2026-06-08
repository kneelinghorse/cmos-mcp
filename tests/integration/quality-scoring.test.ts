/**
 * Integration tests for quality scoring system
 * Tests against real Phase 2 mission examples
 */

import { promises as fs } from 'fs';
import { QualityScorer } from '../../src/quality/quality-scorer';
import { scoreQuality } from '../../src/tools/score-quality';
import * as path from 'path';

describe('Quality Scoring Integration', () => {
  let scorer: QualityScorer;

  beforeEach(() => {
    scorer = new QualityScorer();
  });

  describe('scoreQuality tool', () => {
    it('should score current mission file', async () => {
      const missionFile = path.resolve(__dirname, '../../../missions/current.yaml');

      try {
        await fs.access(missionFile);
      } catch {
        console.warn('Skipping test: current.yaml not found');
        return;
      }

      const result = await scoreQuality({ missionFile, verbose: true });

      expect(result.success).toBe(true);
      expect(result.score).toBeDefined();
      expect(result.summary).toBeDefined();

      if (result.score) {
        console.log('\n=== Current Mission Quality ===');
        console.log(result.summary);
      }
    });

    it('should provide detailed metrics in verbose mode', async () => {
      const missionFile = path.resolve(__dirname, '../../../missions/current.yaml');

      try {
        await fs.access(missionFile);
      } catch {
        console.warn('Skipping test: current.yaml not found');
        return;
      }

      const result = await scoreQuality({ missionFile, verbose: true });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Detailed Metrics');
      expect(result.summary).toContain('Clarity Metrics');
      expect(result.summary).toContain('Completeness Metrics');
      expect(result.summary).toContain('AI-Readiness Metrics');
    });

    it('should handle non-existent file gracefully', async () => {
      const result = await scoreQuality({
        missionFile: '/path/to/nonexistent/mission.yaml',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('real mission quality benchmarks', () => {
    it('should score research mission template', async () => {
      const mission = {
        missionId: 'R-TEST-001',
        objective:
          'To research and define a comprehensive framework for scoring mission quality, including metrics for clarity, completeness, and AI-readiness.',
        context:
          'This mission investigates methods for quantitatively assessing mission quality. The goal is to provide actionable feedback to improve mission effectiveness. The findings will inform the quality scoring engine in Phase 4.',
        successCriteria: [
          'All research questions in the domainFields are answered.',
          'The buildImplications section is populated with clear, actionable recommendations.',
          'All key findings are supported by cited sources in the evidenceCollection.',
          'Contradictions or areas of uncertainty are explicitly documented.',
        ],
        deliverables: [
          'This completed and validated mission file.',
          'A structured buildImplications object ready for use in a build mission.',
        ],
        domainFields: {
          type: 'Build.TechnicalResearch.v1',
          researchQuestions: [
            'What metrics effectively measure mission clarity for AI consumption?',
            'How can we quantify mission completeness and coverage?',
          ],
        },
      };

      const result = await scorer.score(mission, mission.missionId);

      expect(result.total).toBeGreaterThan(0.6); // Should be decent quality
      expect(result.dimensions.completeness.score).toBeGreaterThan(0.7);
      expect(result.metadata.processingTimeMs).toBeLessThan(3000);
    });

    it('should score implementation mission template', async () => {
      const mission = {
        missionId: 'B-TEST-001',
        objective:
          'To implement the comprehensive quality scoring system using the three-dimensional framework from research mission R4.4.',
        context:
          'This mission implements the findings from Technical Research mission R4.4. The system will assess missions on Clarity, Completeness, and AI-Readiness dimensions. The scope includes multiple metrics, weighted scoring, and improvement suggestions.',
        successCriteria: [
          'Three-dimensional quality model implemented (Clarity, Completeness, AI-Readiness).',
          'All specified metrics functional and accurate.',
          'Unified Quality Score calculation with configurable weights.',
          'Quality assessment completes in <3 seconds per mission.',
          'The get_mission_quality_score MCP tool is functional.',
          'Actionable improvement suggestions generated.',
        ],
        deliverables: [
          'The implemented QualityScorer class with all metric calculations.',
          'Unified scoring algorithm with weighted dimensions.',
          'Improvement suggestion engine.',
          'The get_mission_quality_score MCP tool.',
          'Benchmarking against successful mission patterns.',
        ],
        domainFields: {
          type: 'Build.Implementation.v1',
          researchFoundation: [
            {
              finding: 'Use three-dimensional model: Clarity, Completeness, AI-Readiness.',
              sourceMission: 'R4.4_Mission_Quality_metrics',
            },
          ],
        },
      };

      const result = await scorer.score(mission, mission.missionId);

      expect(result.total).toBeGreaterThan(0.7); // High quality expected
      expect(result.dimensions.clarity.score).toBeGreaterThan(0.6);
      expect(result.dimensions.completeness.score).toBeGreaterThan(0.7);
      expect(result.dimensions.aiReadiness.score).toBeGreaterThan(0.7);

      // Should have few critical suggestions
      const critical = result.suggestions.filter((s) => s.severity === 'critical');
      expect(critical.length).toBe(0);
    });

    it('should identify issues in poor quality mission', async () => {
      const poorMission = {
        objective: 'Fix bugs',
        context: 'There are some bugs. Fix them if possible.',
        successCriteria: 'No bugs',
        deliverables: 'Fixed code',
      };

      const result = await scorer.score(poorMission);

      expect(result.total).toBeLessThan(0.65);
      expect(result.suggestions.length).toBeGreaterThan(3);

      // Should flag multiple issues
      const suggestions = result.suggestions;
      const categories = new Set(suggestions.map((s) => s.category));

      expect(categories.size).toBeGreaterThan(1); // Multiple categories
    });
  });

  describe('performance benchmarks', () => {
    it('should score small mission in <1 second', async () => {
      const mission = {
        objective: 'To test performance.',
        context: 'Simple mission for performance testing.',
        successCriteria: ['Fast', 'Accurate'],
        deliverables: ['Result'],
      };

      const start = Date.now();
      const result = await scorer.score(mission);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
      expect(result.metadata.processingTimeMs).toBeLessThan(1000);
    });

    it('should score complex mission in <3 seconds', async () => {
      const complexMission = {
        objective: 'To implement a highly complex system with multiple interdependent components.',
        context: `This mission requires implementation of a sophisticated architecture.
          The system must handle multiple edge cases and provide comprehensive error handling.
          Integration with existing systems is required. Performance optimization is critical.
          The implementation should follow best practices and design patterns.`,
        successCriteria: [
          'All components implemented according to specification.',
          'Comprehensive test coverage achieved (>90%).',
          'Performance benchmarks met (<100ms response time).',
          'Integration tests passing.',
          'Documentation complete and accurate.',
          'Code review approved by senior engineers.',
          'Security audit passed.',
          'Accessibility standards met.',
        ],
        deliverables: [
          'Complete implementation with all components.',
          'Comprehensive test suite.',
          'Performance benchmarks and optimization report.',
          'Integration documentation.',
          'API documentation.',
          'Deployment guide.',
        ],
        domainFields: {
          type: 'Build.Implementation.v1',
          constraints: [
            'Must maintain backward compatibility.',
            'No breaking changes to public API.',
            'Memory footprint under 100MB.',
          ],
        },
      };

      const start = Date.now();
      const result = await scorer.score(complexMission);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(3000);
      expect(result.metadata.processingTimeMs).toBeLessThan(3000);
    });
  });

  describe('suggestion quality', () => {
    it('should provide actionable feedback', async () => {
      const mission = {
        objective: 'Implement it properly.',
        context: 'Do the thing.',
        successCriteria: 'Works',
        deliverables: 'Code',
      };

      const result = await scorer.score(mission);

      expect(result.suggestions.length).toBeGreaterThan(0);

      // All suggestions should have actionable messages
      result.suggestions.forEach((suggestion) => {
        expect(suggestion.message.length).toBeGreaterThan(20);
        expect(suggestion.message).not.toMatch(/^undefined/);
        expect(suggestion.category).toBeDefined();
      });
    });

    it('should categorize suggestions appropriately', async () => {
      const mission = {
        objective: 'Test',
        context: 'T',
        successCriteria: [],
        deliverables: [],
      };

      const result = await scorer.score(mission);
      const suggestions = result.suggestions;

      // Group by severity
      const bySeverity = {
        critical: suggestions.filter((s) => s.severity === 'critical'),
        important: suggestions.filter((s) => s.severity === 'important'),
        info: suggestions.filter((s) => s.severity === 'info'),
      };

      // Critical issues should be present for missing fields
      expect(bySeverity.critical.length + bySeverity.important.length).toBeGreaterThan(0);
    });
  });
});
