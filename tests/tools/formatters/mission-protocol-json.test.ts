/**
 * Tests for Mission Protocol JSON Formatter
 *
 * Coverage:
 * - Basic formatting with minimal input
 * - ID generation strategies
 * - Name extraction edge cases
 * - Optional field handling
 * - Domain fields building
 * - Edge cases (empty, long, special chars)
 */

import {
  MissionProtocolJsonFormatter,
  formatMissionToJson,
  type JsonFormatterParams,
  type MissionProtocolJsonOutput,
} from '../../../src/tools/formatters/mission-protocol-json';
import type { GenericMission } from '../../../src/schemas/generic-mission';

/**
 * Helper to create valid GenericMission objects for testing
 */
function createTestMission(overrides: Partial<GenericMission> = {}): GenericMission {
  return {
    schemaType: 'Mission',
    schemaVersion: '2.0',
    missionId: 'test-001',
    objective: 'Test mission objective',
    successCriteria: ['Criteria 1'],
    deliverables: ['Deliverable 1'],
    context: {},
    domainFields: {},
    ...overrides,
  };
}

describe('MissionProtocolJsonFormatter', () => {
  let formatter: MissionProtocolJsonFormatter;

  beforeEach(() => {
    formatter = new MissionProtocolJsonFormatter();
  });

  describe('format() - basic functionality', () => {
    it('should format minimal mission with required fields', () => {
      const mission = createTestMission({
        objective: 'Design and implement user authentication',
      });

      const result = formatter.format(mission);

      expect(result.format_version).toBe('1.0');
      expect(result.source).toBe('mission-protocol');
      expect(result.mission.objective).toBe('Design and implement user authentication');
      expect(result.mission.name).toBe('Design and implement user authentication');
      expect(result.mission.suggested_id).toMatch(/^MP-\d{4}-\d{2}-\d{2}-\d{4}$/);
      expect(result.mission.domain_fields.schemaType).toBe('Mission');
      expect(result.mission.domain_fields.successCriteria).toEqual(['Criteria 1']);
    });

    it('should include all MP intelligence in domain_fields', () => {
      const mission = createTestMission({
        objective: 'Build API endpoint',
        successCriteria: ['Tests pass', 'Documentation complete'],
        deliverables: ['API endpoints', 'Tests'],
        context: {
          background: 'Part of larger system',
          dependencies: ['auth-service'],
          constraints: ['Use TypeScript', 'Follow REST conventions'],
        },
      });

      const result = formatter.format(mission);

      expect(result.mission.domain_fields.successCriteria).toEqual([
        'Tests pass',
        'Documentation complete',
      ]);
      expect(result.mission.domain_fields.deliverables).toEqual(['API endpoints', 'Tests']);
      expect(result.mission.domain_fields.context.dependencies).toEqual(['auth-service']);
      expect(result.mission.domain_fields.context.constraints).toEqual([
        'Use TypeScript',
        'Follow REST conventions',
      ]);
    });

    it('should include domainFields in domain_fields if present', () => {
      const mission = createTestMission({
        objective: 'Research vector databases',
        domainFields: {
          researchType: 'comparative_analysis',
          targetDatabases: ['Pinecone', 'Weaviate', 'Qdrant'],
        },
      });

      const result = formatter.format(mission);

      expect(result.mission.domain_fields.researchType).toBe('comparative_analysis');
      expect(result.mission.domain_fields.targetDatabases).toEqual([
        'Pinecone',
        'Weaviate',
        'Qdrant',
      ]);
    });
  });

  describe('generateSuggestedId()', () => {
    it('should use provided ID when given', () => {
      const mission = createTestMission();

      const result = formatter.format(mission, { missionId: 'B1.2' });

      expect(result.mission.suggested_id).toBe('B1.2');
    });

    it('should generate timestamp-based ID when not provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission);

      // Format: MP-YYYY-MM-DD-XXXX
      expect(result.mission.suggested_id).toMatch(/^MP-\d{4}-\d{2}-\d{2}-\d{4}$/);
    });

    it('should generate valid IDs for concurrent calls', () => {
      const mission = createTestMission();

      const result1 = formatter.format(mission);
      const result2 = formatter.format(mission);

      // Both should be valid
      expect(result1.mission.suggested_id).toMatch(/^MP-\d{4}-\d{2}-\d{2}-\d{4}$/);
      expect(result2.mission.suggested_id).toMatch(/^MP-\d{4}-\d{2}-\d{2}-\d{4}$/);
    });
  });

  describe('extractName()', () => {
    it('should extract first sentence as name', () => {
      const mission = createTestMission({
        objective: 'Design database schema. This will include user tables and auth.',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Design database schema');
    });

    it('should handle objectives without sentence terminators', () => {
      const mission = createTestMission({
        objective: 'Design database schema for user authentication',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Design database schema for user authentication');
    });

    it('should truncate long names to 80 characters', () => {
      const longObjective = 'A'.repeat(100);
      const mission = createTestMission({
        objective: longObjective,
      });

      const result = formatter.format(mission);

      expect(result.mission.name.length).toBe(80);
      expect(result.mission.name).toBe('A'.repeat(80));
    });

    it('should handle objectives with exclamation marks', () => {
      const mission = createTestMission({
        objective: 'Build amazing feature! Users will love it.',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Build amazing feature');
    });

    it('should handle objectives with question marks', () => {
      const mission = createTestMission({
        objective: "Should we use PostgreSQL? Let's research options.",
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Should we use PostgreSQL');
    });

    it('should handle empty objective gracefully', () => {
      const mission = createTestMission({
        objective: '',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Untitled Mission');
    });

    it('should trim whitespace from extracted name', () => {
      const mission = createTestMission({
        objective: '  Design schema  . More details here.',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Design schema');
    });
  });

  describe('optional fields handling', () => {
    it('should include sprint_id when provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission, { sprintId: 'Sprint 01' });

      expect(result.mission.sprint_id).toBe('Sprint 01');
    });

    it('should NOT include sprint_id when not provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission);

      expect(result.mission).not.toHaveProperty('sprint_id');
    });

    it('should include context when provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission, {
        context: 'This is critical for the authentication system',
      });

      expect(result.mission.context).toBe('This is critical for the authentication system');
    });

    it('should NOT include context when not provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission);

      expect(result.mission).not.toHaveProperty('context');
    });

    it('should include domain when provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission, { domain: 'backend' });

      expect(result.mission.domain).toBe('backend');
    });

    it('should NOT include domain when not provided', () => {
      const mission = createTestMission();

      const result = formatter.format(mission);

      expect(result.mission).not.toHaveProperty('domain');
    });

    it('should include all optional fields when all provided', () => {
      const mission = createTestMission({
        objective: 'Complete mission',
      });

      const params: JsonFormatterParams = {
        missionId: 'B1.1',
        sprintId: 'Sprint 02',
        context: 'Foundation work',
        domain: 'research',
      };

      const result = formatter.format(mission, params);

      expect(result.mission.suggested_id).toBe('B1.1');
      expect(result.mission.sprint_id).toBe('Sprint 02');
      expect(result.mission.context).toBe('Foundation work');
      expect(result.mission.domain).toBe('research');
    });
  });

  describe('edge cases', () => {
    it('should handle mission with minimal context', () => {
      const mission = createTestMission({
        context: {},
      });

      const result = formatter.format(mission);

      expect(result.mission.objective).toBe('Test mission objective');
      expect(result.mission.domain_fields.context).toEqual({});
    });

    it('should handle objectives with special characters', () => {
      const mission = createTestMission({
        objective: 'Design API: /users/{id}/profile & handle edge cases',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toBe('Design API: /users/{id}/profile & handle edge cases');
      expect(result.mission.objective).toBe('Design API: /users/{id}/profile & handle edge cases');
    });

    it('should handle objectives with Unicode characters', () => {
      const mission = createTestMission({
        objective: 'Implement 日本語 support for internationalization',
      });

      const result = formatter.format(mission);

      expect(result.mission.name).toContain('日本語');
    });

    it('should handle empty arrays in mission fields', () => {
      const mission = createTestMission({
        successCriteria: [],
        deliverables: [],
      });

      const result = formatter.format(mission);

      expect(Array.isArray(result.mission.domain_fields.successCriteria)).toBe(true);
      expect(result.mission.domain_fields.successCriteria).toHaveLength(0);
      expect(Array.isArray(result.mission.domain_fields.deliverables)).toBe(true);
      expect(result.mission.domain_fields.deliverables).toHaveLength(0);
    });
  });

  describe('formatMissionToJson() convenience function', () => {
    it('should return pretty-printed JSON string by default', () => {
      const mission = createTestMission();

      const jsonString = formatMissionToJson(mission);

      expect(typeof jsonString).toBe('string');
      expect(jsonString).toContain('format_version');
      expect(jsonString).toContain('\n'); // Pretty-printed

      // Should be valid JSON
      const parsed = JSON.parse(jsonString);
      expect(parsed.format_version).toBe('1.0');
    });

    it('should return compact JSON when pretty=false', () => {
      const mission = createTestMission();

      const jsonString = formatMissionToJson(mission, {}, false);

      expect(typeof jsonString).toBe('string');
      expect(jsonString).not.toContain('\n'); // Not pretty-printed

      // Should be valid JSON
      const parsed = JSON.parse(jsonString);
      expect(parsed.format_version).toBe('1.0');
    });

    it('should accept params and pass them through', () => {
      const mission = createTestMission();

      const jsonString = formatMissionToJson(mission, {
        missionId: 'TEST-01',
        sprintId: 'Sprint 99',
      });

      const parsed = JSON.parse(jsonString);
      expect(parsed.mission.suggested_id).toBe('TEST-01');
      expect(parsed.mission.sprint_id).toBe('Sprint 99');
    });
  });

  describe('contract compliance', () => {
    it('should always include format_version and source', () => {
      const mission = createTestMission();

      const result = formatter.format(mission);

      expect(result).toHaveProperty('format_version');
      expect(result).toHaveProperty('source');
      expect(result.format_version).toBe('1.0');
      expect(result.source).toBe('mission-protocol');
    });

    it('should always include required mission fields', () => {
      const mission = createTestMission();

      const result = formatter.format(mission);

      expect(result.mission).toHaveProperty('suggested_id');
      expect(result.mission).toHaveProperty('name');
      expect(result.mission).toHaveProperty('objective');
      expect(result.mission).toHaveProperty('domain_fields');
    });

    it('should match MissionProtocolJsonOutput type structure', () => {
      const mission = createTestMission({
        successCriteria: ['Criterion 1'],
        context: {
          constraints: ['Constraint 1'],
        },
      });

      const result: MissionProtocolJsonOutput = formatter.format(mission);

      // TypeScript should enforce this, but let's verify at runtime too
      expect(typeof result.format_version).toBe('string');
      expect(typeof result.source).toBe('string');
      expect(typeof result.mission).toBe('object');
      expect(typeof result.mission.suggested_id).toBe('string');
      expect(typeof result.mission.name).toBe('string');
      expect(typeof result.mission.objective).toBe('string');
      expect(typeof result.mission.domain_fields).toBe('object');
    });
  });
});
