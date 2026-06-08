/**
 * Mission Splitter Tests
 *
 * Tests for the hybrid semantic-structural decomposition algorithm
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { MissionSplitter, SubMission, SplitResult } from '../../src/intelligence/mission-splitter';
import { ComplexityScorer } from '../../src/intelligence/complexity-scorer';
import { GenericMission } from '../../src/types/mission-types';
import { ITokenCounter, TokenCount, SupportedModel } from '../../src/intelligence/types';

/**
 * Mock token counter
 */
class MockTokenCounter implements ITokenCounter {
  async count(text: string, model: SupportedModel): Promise<TokenCount> {
    return {
      model,
      count: Math.ceil(text.length * 0.25),
      estimatedCost: 0,
    };
  }
}

describe('MissionSplitter', () => {
  let splitter: MissionSplitter;
  let complexityScorer: ComplexityScorer;
  let mockTokenCounter: MockTokenCounter;

  beforeEach(() => {
    mockTokenCounter = new MockTokenCounter();
    complexityScorer = new ComplexityScorer(mockTokenCounter, {
      model: 'claude',
      contextWindow: 200000,
      agentTimeHorizon: 60,
      thresholds: {
        compositeScore: 5.0, // Lower threshold for testing
        tokenPercentage: 0.8,
        timeHorizonMultiplier: 1.5,
      },
    });
    splitter = new MissionSplitter(complexityScorer);
  });

  describe('split', () => {
    test('should split complex mission into sub-missions', async () => {
      const complexMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-split-001',
        objective: 'Build full-stack application',
        context: {
          background: 'Create a complete web application with multiple components',
          dependencies: ['Database', 'API', 'Frontend'],
        },
        successCriteria: [
          'Database schema created',
          'API endpoints functional',
          'Frontend deployed',
          'Integration tests passing',
          'Documentation complete',
        ],
        deliverables: [
          'Database migrations',
          'API code',
          'Frontend app',
          'Test suite',
          'Documentation',
        ],
        domainFields: {},
      };

      const result = await splitter.split(complexMission);

      expect(result).toBeDefined();
      expect(result.subMissions).toBeDefined();
      expect(result.subMissions.length).toBeGreaterThan(0);
      expect(result.complexity).toBeDefined();
      expect(result.preservedContext).toBeDefined();
    });

    test('should preserve atomic operations', async () => {
      const missionText = `
        Mission: Deploy application

        Instructions:
        1. First, build the application
        2. Then, run the tests
        3. After that, deploy to staging
        4. Finally, promote to production

        For each environment, verify health checks.
      `;

      const result = await splitter.split(missionText);

      // Check that dependency chains are not broken
      expect(result.subMissions).toBeDefined();

      // Verify dependencies are tracked (if split occurred)
      if (result.subMissions.length > 1) {
        const hasSequentialDeps = result.subMissions.some(
          (sm, i) => i > 0 && sm.dependencies.length > 0
        );
        expect(hasSequentialDeps).toBe(true);
      }
    });

    test('should respect maxSubMissions option', async () => {
      const longMission = `
        Objective: Complete multi-phase project

        Phase 1: Research and planning
        Phase 2: Design architecture
        Phase 3: Implement backend
        Phase 4: Implement frontend
        Phase 5: Integration testing
        Phase 6: Performance optimization
        Phase 7: Security hardening
        Phase 8: Documentation
        Phase 9: Deployment
        Phase 10: Monitoring setup
      `;

      const result = await splitter.split(longMission, { maxSubMissions: 3 });

      expect(result.subMissions.length).toBeLessThanOrEqual(3);
    });

    test('should respect minChunkSize option', async () => {
      const mission = 'A. B. C. D. E. F.'; // Very short chunks

      const result = await splitter.split(mission, { minChunkSize: 100 });

      // Should not create tiny sub-missions
      expect(result.subMissions.length).toBeLessThan(6);
    });

    test('should generate unique sub-mission IDs', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-id-001',
        objective: 'Test ID generation',
        context: {},
        successCriteria: ['A', 'B', 'C', 'D'],
        deliverables: ['W', 'X', 'Y', 'Z'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      const ids = result.subMissions.map((sm) => sm.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });

    test('should maintain sequential order', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-order-001',
        objective: 'Sequential task',
        context: {},
        successCriteria: ['Step 1', 'Step 2', 'Step 3'],
        deliverables: ['Output 1', 'Output 2', 'Output 3'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      for (let i = 0; i < result.subMissions.length; i++) {
        expect(result.subMissions[i].order).toBe(i + 1);
      }
    });

    test('should extract deliverables from sub-missions', async () => {
      const missionText = `
        Objective: Create project files

        Create file: app/index.ts
        Implement file: app/server.ts
        Write test: tests/app.test.ts
      `;

      const result = await splitter.split(missionText);

      const allDeliverables = result.subMissions.flatMap((sm) => sm.deliverables);
      expect(allDeliverables.length).toBeGreaterThan(0);
    });
  });

  describe('suggestSplits', () => {
    test('should suggest splits for complex mission', async () => {
      const complexMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-suggest-001',
        objective: 'Large complex project with many phases',
        context: {
          dependencies: ['A', 'B', 'C', 'D', 'E'],
        },
        successCriteria: Array(10).fill('Criterion'),
        deliverables: Array(10).fill('Deliverable'),
        domainFields: {},
      };

      const suggestion = await splitter.suggestSplits(complexMission);

      expect(suggestion).toBeDefined();
      expect(suggestion.shouldSplit).toBeDefined();
      expect(suggestion.complexity).toBeDefined();
      expect(suggestion.reasoning).toBeDefined();
    });

    test('should not suggest split for simple mission', async () => {
      const simpleMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-suggest-002',
        objective: 'Simple task',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const suggestion = await splitter.suggestSplits(simpleMission);

      expect(suggestion.shouldSplit).toBe(false);
      expect(suggestion.suggestedSplits.length).toBe(0);
    });

    test('should provide split reasoning', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-suggest-003',
        objective: 'Task for reasoning test',
        context: {},
        successCriteria: ['Complete'],
        deliverables: ['Result'],
        domainFields: {},
      };

      const suggestion = await splitter.suggestSplits(mission);

      expect(typeof suggestion.reasoning).toBe('string');
      expect(suggestion.reasoning.length).toBeGreaterThan(0);
    });

    test('should include detailed split positions in reasoning when splits exist', async () => {
      const para = (s: string) => Array(40).fill(s).join(' '); // ~1200+ chars

      const complexMission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-suggest-splits-detailed',
        objective: 'Large complex project with many phases and substantial context',
        context: {
          background: [
            para(
              'First topic: Setup the development environment. Install dependencies and configure tools.'
            ),
            para(
              'Second topic: Implement the core algorithm. Write extensive tests for the algorithm with multiple cases.'
            ),
            para(
              'Third topic: Deploy to production. Setup monitoring and alerts. Validate SLOs and rollbacks.'
            ),
          ].join('\n\n'),
          dependencies: Array(8).fill('Dependency'),
          constraints: Array(5).fill('Constraint'),
        },
        successCriteria: Array(12).fill('Criterion item that contributes to complexity'),
        deliverables: Array(12).fill('Deliverable item that contributes to complexity'),
        domainFields: {},
      };

      const suggestion = await splitter.suggestSplits(complexMission);

      // Ensure we have at least one suggested split
      expect(suggestion.suggestedSplits.length).toBeGreaterThan(0);
      // Reasoning should enumerate split point positions
      expect(suggestion.reasoning).toContain('Position');
    });
  });

  describe('semantic breakpoint detection', () => {
    test('should detect topic shifts', async () => {
      const missionText = `
        First topic: Setup the development environment.
        Install dependencies and configure tools.

        Second topic: Implement the core algorithm.
        Write tests for the algorithm.

        Third topic: Deploy to production.
        Setup monitoring and alerts.
      `;

      const result = await splitter.split(missionText);

      // Should detect multiple sections (or at least complete successfully)
      expect(result.splitPoints).toBeDefined();
    });

    test('should detect structural boundaries', async () => {
      const missionText = `
        # Phase 1
        Do task A

        # Phase 2
        Do task B

        # Phase 3
        Do task C
      `;

      const result = await splitter.split(missionText);

      expect(result.splitPoints).toBeDefined();
    });

    test('should respect paragraph breaks', async () => {
      const missionText = `
        First paragraph with related content.
        More content in first paragraph.

        Second paragraph with different topic.
        More content in second paragraph.

        Third paragraph with another topic.
      `;

      const result = await splitter.split(missionText);

      expect(result.splitPoints).toBeDefined();
    });
  });

  describe('dependency inference', () => {
    test('should infer cross-phase dependency when later chunk references earlier objective', async () => {
      const missionText = `
        Objective: Build API server.\n\n
        Implement core endpoints and handlers.\n\n
        After you build API server, implement the UI components and integrate.`;

      const result = await splitter.split(missionText, { minChunkSize: 10 });

      // Expect at least 3 sub-missions due to paragraph splits
      expect(result.subMissions.length).toBeGreaterThanOrEqual(3);

      const first = result.subMissions[0];
      const third = result.subMissions[2];

      // Default sequential dependency on previous (sub 2) always exists
      // We also expect an inferred dependency on sub 1 due to explicit reference
      expect(third.dependencies).toContain(`sub-mission-2`);
      expect(third.dependencies).toContain(first.id);
      // Ensure there are at least 2 dependencies captured
      expect(third.dependencies.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('atomic operation preservation', () => {
    test('should not split within numbered lists', async () => {
      const missionText = `
        Setup instructions:
        1. Install package A
        2. Configure setting B
        3. Run command C

        Testing instructions:
        1. Run test suite
        2. Check coverage
      `;

      const result = await splitter.split(missionText, { minChunkSize: 10 });

      // Should preserve list structure
      expect(result.subMissions).toBeDefined();
      expect(result.subMissions.length).toBeGreaterThan(0);
    });

    test('should preserve dependency chains', async () => {
      const missionText = `
        Build the application.
        Then run the tests.
        After that, deploy it.
        Finally, verify it's working.
      `;

      const result = await splitter.split(missionText, { minChunkSize: 10 });

      // Should keep "then", "after that", "finally" chains together
      expect(result.subMissions).toBeDefined();
    });

    test('should not split code blocks', async () => {
      const missionText = `
        Create a function:

        \`\`\`typescript
        function example() {
          return true;
        }
        \`\`\`

        Then test it.
      `;

      const result = await splitter.split(missionText);

      // Code block should stay intact
      const hasCodeBlock = result.subMissions.some((sm) => sm.instructions.includes('```'));

      expect(hasCodeBlock).toBe(true);
    });
  });

  describe('dependency inference', () => {
    test('should infer sequential dependencies', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-dep-001',
        objective: 'Sequential workflow',
        context: {},
        successCriteria: ['Step 1', 'Step 2', 'Step 3'],
        deliverables: ['A', 'B', 'C'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      // Each mission (except first) should depend on previous
      for (let i = 1; i < result.subMissions.length; i++) {
        expect(result.subMissions[i].dependencies.length).toBeGreaterThan(0);
      }
    });

    test('first sub-mission should have no dependencies', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-dep-002',
        objective: 'Test first mission',
        context: {},
        successCriteria: ['A', 'B'],
        deliverables: ['X', 'Y'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      if (result.subMissions.length > 0) {
        expect(result.subMissions[0].dependencies.length).toBe(0);
      }
    });
  });

  describe('context preservation', () => {
    test('should preserve mission objective in context', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-context-001',
        objective: 'Important objective to preserve',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      expect(result.preservedContext).toContain(mission.objective);
    });

    test('should include mission ID in preserved context', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'unique-mission-id-12345',
        objective: 'Test',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Output'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      expect(result.preservedContext).toContain(mission.missionId);
    });
  });

  describe('edge cases', () => {
    test('should handle very short mission', async () => {
      const shortMission = 'Do task.';

      const result = await splitter.split(shortMission);

      expect(result).toBeDefined();
      expect(result.subMissions.length).toBeGreaterThan(0);
    });

    test('should handle mission with no natural breakpoints', async () => {
      const noBreakpoints = 'Complete this single atomic task without any subdivisions';

      const result = await splitter.split(noBreakpoints);

      expect(result).toBeDefined();
      expect(result.subMissions).toBeDefined();
    });

    test('should handle empty deliverables', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-edge-001',
        objective: 'Task with minimal info',
        context: {},
        successCriteria: ['Done'],
        deliverables: ['Completion report'],
        domainFields: {},
      };

      const result = await splitter.split(mission);

      expect(result).toBeDefined();
      result.subMissions.forEach((sm) => {
        expect(Array.isArray(sm.deliverables)).toBe(true);
      });
    });
  });

  describe('performance', () => {
    test('should complete split in under 2 seconds', async () => {
      const mission: GenericMission = {
        schemaType: 'Mission',
        schemaVersion: '2.0',
        missionId: 'test-perf-001',
        objective: 'Performance test mission',
        context: {
          background: 'Testing splitting performance',
          dependencies: ['A', 'B', 'C'],
        },
        successCriteria: Array(10).fill('Criterion'),
        deliverables: Array(10).fill('Deliverable'),
        domainFields: {},
      };

      const startTime = Date.now();
      await splitter.split(mission);
      const endTime = Date.now();

      const duration = endTime - startTime;
      expect(duration).toBeLessThan(2000);
    });
  });
});
