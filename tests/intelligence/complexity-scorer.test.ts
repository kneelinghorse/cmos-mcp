/**
 * Complexity Scorer Tests
 *
 * Tests for the Composite Complexity Score (CCS) calculation
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { ComplexityScorer, ComplexityAnalysis } from '../../src/intelligence/complexity-scorer';
import { GenericMission } from '../../src/types/mission-types';
import { ITokenCounter, TokenCount, SupportedModel } from '../../src/intelligence/types';

/**
 * Mock token counter for testing
 */
class MockTokenCounter implements ITokenCounter {
  private tokensPerChar = 0.25; // Approximate: 4 chars per token

  async count(text: string, model: SupportedModel): Promise<TokenCount> {
    return {
      model,
      count: Math.ceil(text.length * this.tokensPerChar),
      estimatedCost: 0,
    };
  }
}

describe('ComplexityScorer', () => {
  let scorer: ComplexityScorer;
  let mockTokenCounter: MockTokenCounter;

  beforeEach(() => {
    mockTokenCounter = new MockTokenCounter();
    scorer = new ComplexityScorer(mockTokenCounter, {
      model: 'claude',
      contextWindow: 200000,
      agentTimeHorizon: 60, // 60 minutes
    });
  });

  describe('calculateCCS', () => {
    test('should calculate CCS for simple mission', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-001',
        objective: 'Create a simple test file',
        context: {},
        successCriteria: ['File created', 'Tests pass'],
        deliverables: ['test.txt'],
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(mission);

      expect(analysis).toBeDefined();
      expect(analysis.compositeScore).toBeGreaterThanOrEqual(0);
      expect(analysis.compositeScore).toBeLessThanOrEqual(10);
      expect(analysis.components).toBeDefined();
      expect(analysis.shouldSplit).toBe(false);
    });

    test('should identify complex mission requiring split', async () => {
      // Create a large, complex mission
      const largeObjective =
        'Create a comprehensive full-stack application with authentication, database integration, API endpoints, frontend UI, testing suite, deployment pipeline, monitoring, and documentation';

      const complexMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-002',
        objective: largeObjective,
        context: {
          background:
            'This is a complex project requiring multiple technologies and integration points',
          dependencies: [
            'Database',
            'Auth Service',
            'API Gateway',
            'Frontend Framework',
            'CI/CD Pipeline',
          ],
          constraints: [
            'Must use microservices',
            'Must be cloud-native',
            'Must have high availability',
          ],
        },
        successCriteria: [
          'All microservices deployed',
          'Authentication working',
          'Database schema created',
          'API endpoints functional',
          'Frontend responsive',
          'Tests passing with >90% coverage',
          'CI/CD pipeline operational',
          'Monitoring dashboards configured',
          'Documentation complete',
          'Performance benchmarks met',
        ],
        deliverables: [
          'Auth service code',
          'Database migrations',
          'API implementation',
          'Frontend application',
          'Test suite',
          'Deployment scripts',
          'Monitoring config',
          'Documentation',
        ],
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(complexMission);

      expect(analysis.compositeScore).toBeGreaterThan(3);
      expect(analysis.shouldSplit).toBe(true);
      expect(analysis.reasons.length).toBeGreaterThan(0);
    });

    test('should calculate token score correctly', async () => {
      // Create mission that approaches context window limit
      const largeMission = 'objective: ' + 'x'.repeat(100000);

      const analysis = await scorer.calculateCCS(largeMission);

      expect(analysis.components.tokenScore).toBeGreaterThan(0);
    });

    test('should calculate structural score based on complexity indicators', async () => {
      const complexText = `
        Mission: Implement complex system

        Instructions:
        1. First, create the database schema
        2. Then, implement the API layer
        3. Next, build the frontend
        4. After that, add authentication
        5. Finally, deploy to production

        If tests fail, rollback deployment.
        For each microservice, implement health checks.
        While processing, monitor performance.
        When errors occur, log to centralized system.
      `;

      const analysis = await scorer.calculateCCS(complexText);

      expect(analysis.components.structuralScore).toBeGreaterThan(0);
    });

    test('should calculate time horizon score', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-003',
        objective: 'Complete long-running task',
        context: {},
        successCriteria: Array(20).fill('Criterion'),
        deliverables: Array(15).fill('Deliverable'),
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(mission);

      expect(analysis.components.timeHorizonScore).toBeDefined();
      expect(analysis.estimatedHumanHours).toBeGreaterThan(0);
    });

    test('should calculate computational complexity score', async () => {
      const complexText = `
        Objective: Optimize algorithm performance

        For each combination of parameters, test all permutations.
        Use nested loops to iterate through the data.
        Implement brute-force search for edge cases.
        Optimize exponential time complexity to linear.
        Refactor recursive functions for better performance.
      `;

      const analysis = await scorer.calculateCCS(complexText);

      expect(analysis.components.computationalScore).toBeGreaterThan(0);
    });

    test('should handle string input', async () => {
      const textMission = `
        Mission: Create a web application

        Requirements:
        1. Build backend API
        2. Create frontend UI
        3. Add database layer
        4. Implement authentication
        5. Deploy to cloud
      `;

      const analysis = await scorer.calculateCCS(textMission);

      expect(analysis).toBeDefined();
      expect(analysis.compositeScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('component scores', () => {
    test('should weight components correctly', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-004',
        objective: 'Test weighting',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(mission);

      // Verify composite score is weighted sum
      const { components } = analysis;

      // Default weights: token=0.35, structural=0.25, timeHorizon=0.30, computational=0.10
      const expectedScore =
        0.35 * components.tokenScore +
        0.25 * components.structuralScore +
        0.3 * components.timeHorizonScore +
        0.1 * components.computationalScore;

      expect(analysis.compositeScore).toBeCloseTo(expectedScore, 1);
    });

    test('all component scores should be in 0-10 range', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-005',
        objective: 'Test score ranges',
        context: {
          dependencies: Array(100).fill('Dependency'),
        },
        successCriteria: Array(50).fill('Criterion'),
        deliverables: Array(50).fill('Deliverable'),
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(mission);
      const { components } = analysis;

      expect(components.tokenScore).toBeGreaterThanOrEqual(0);
      expect(components.tokenScore).toBeLessThanOrEqual(10);

      expect(components.structuralScore).toBeGreaterThanOrEqual(0);
      expect(components.structuralScore).toBeLessThanOrEqual(10);

      expect(components.timeHorizonScore).toBeGreaterThanOrEqual(0);
      expect(components.timeHorizonScore).toBeLessThanOrEqual(10);

      expect(components.computationalScore).toBeGreaterThanOrEqual(0);
      expect(components.computationalScore).toBeLessThanOrEqual(10);
    });
  });

  describe('split evaluation', () => {
    test('should not recommend split for simple mission', async () => {
      const simpleMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-006',
        objective: 'Simple task',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(simpleMission);

      expect(analysis.shouldSplit).toBe(false);
      expect(analysis.compositeScore).toBeLessThan(8.0);
    });

    test('should recommend split when composite score exceeds threshold', async () => {
      // Use custom config with lower threshold for testing
      const testScorer = new ComplexityScorer(mockTokenCounter, {
        model: 'claude',
        contextWindow: 200000,
        agentTimeHorizon: 60,
        thresholds: {
          compositeScore: 3.0, // Low threshold for testing
          tokenPercentage: 0.8,
          timeHorizonMultiplier: 1.5,
        },
      });

      const complexMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-007',
        objective: 'Complex multi-phase project with many dependencies and deliverables',
        context: {
          dependencies: ['A', 'B', 'C', 'D', 'E'],
        },
        successCriteria: [
          'Phase 1 complete',
          'Phase 2 complete',
          'Phase 3 complete',
          'All tests passing',
          'Documentation done',
        ],
        deliverables: ['Code', 'Tests', 'Docs', 'Deployment', 'Monitoring'],
        domainFields: {},
      };

      const analysis = await testScorer.calculateCCS(complexMission);

      expect(analysis.shouldSplit).toBe(true);
    });

    test('should provide reasons when split is recommended', async () => {
      const testScorer = new ComplexityScorer(mockTokenCounter, {
        model: 'claude',
        contextWindow: 200000,
        agentTimeHorizon: 60,
        thresholds: {
          compositeScore: 2.0,
          tokenPercentage: 0.8,
          timeHorizonMultiplier: 1.5,
        },
      });

      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-008',
        objective: 'Task requiring split',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const analysis = await testScorer.calculateCCS(mission);

      if (analysis.shouldSplit) {
        expect(analysis.reasons.length).toBeGreaterThan(0);
        expect(Array.isArray(analysis.reasons)).toBe(true);
      }
    });
  });

  describe('edge cases', () => {
    test('should handle empty context', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-009',
        objective: 'Test',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(mission);

      expect(analysis).toBeDefined();
      expect(analysis.compositeScore).toBeGreaterThanOrEqual(0);
    });

    test('should handle mission with no dependencies', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-010',
        objective: 'Independent task',
        context: {
          dependencies: [],
        },
        successCriteria: ['Complete'],
        deliverables: ['Result'],
        domainFields: {},
      };

      const analysis = await scorer.calculateCCS(mission);

      expect(analysis).toBeDefined();
      expect(analysis.components.structuralScore).toBeGreaterThanOrEqual(0);
    });

    test('should handle very short mission text', async () => {
      const shortText = 'Do task';

      const analysis = await scorer.calculateCCS(shortText);

      expect(analysis).toBeDefined();
      expect(analysis.compositeScore).toBeGreaterThanOrEqual(0);
      expect(analysis.compositeScore).toBeLessThanOrEqual(10);
    });

    test('should estimate minimum human hours', async () => {
      const tinyMission = 'x';

      const analysis = await scorer.calculateCCS(tinyMission);

      expect(analysis.estimatedHumanHours).toBeGreaterThanOrEqual(0.5); // Minimum 30 min
    });
  });

  describe('performance', () => {
    test('should complete analysis in under 2 seconds', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-011',
        objective: 'Performance test',
        context: {
          background: 'Testing performance of complexity analysis',
          dependencies: Array(10).fill('Dep'),
        },
        successCriteria: Array(10).fill('Criterion'),
        deliverables: Array(10).fill('Deliverable'),
        domainFields: {},
      };

      const startTime = Date.now();
      await scorer.calculateCCS(mission);
      const endTime = Date.now();

      const duration = endTime - startTime;
      expect(duration).toBeLessThan(2000); // Less than 2 seconds
    });
  });
});
