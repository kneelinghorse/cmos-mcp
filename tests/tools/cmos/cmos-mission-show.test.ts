/**
 * cmos_mission_show Tool Tests
 *
 * Comprehensive tests for the mission show tool.
 *
 * @module tests/tools/cmos/cmos-mission-show
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosMissionShow,
  cmosMissionShowToolDefinition,
  formatMissionShowForLLM,
  type CmosMissionShowParams,
  type MissionShowResult,
} from '../../../src/tools/cmos/cmos-mission-show';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult, Mission } from '../../../src/tools/cmos/types';

describe('cmos_mission_show', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-mission-show-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    // Create a test database with comprehensive schema and data
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT
      );

      -- Insert test sprints
      INSERT INTO sprints (id, title, focus, status)
      VALUES
        ('sprint-11', 'Sprint 11 - Stability', 'Bug fixes and stability', 'Completed'),
        ('sprint-12', 'Sprint 12 - CMOS Tools', 'Implement CMOS MCP tools', 'In Progress');

      -- Insert comprehensive test missions
      INSERT INTO missions (id, sprint_id, name, status, objective, context, success_criteria, deliverables, reference_docs, domain_fields, notes, completed_at, metadata)
      VALUES
        (
          's12-m06',
          'sprint-12',
          'cmos_mission_show Tool',
          'Current',
          'Implement tool to show full mission details by ID',
          'Agents need to retrieve complete mission specifications',
          '["Accepts mission ID parameter", "Returns full mission spec", "Includes sprint context", "Returns MISSION_NOT_FOUND error if missing"]',
          '["src/tools/cmos/cmos-mission-show.ts", "tests/tools/cmos/cmos-mission-show.test.ts"]',
          '["cmos/planning/cmos-mcp-implementation-roadmap.md"]',
          '{"priority": "high", "complexity": "medium"}',
          'In active development',
          NULL,
          '{"estimatedHours": 2}'
        ),
        (
          's12-m05',
          'sprint-12',
          'cmos_mission_list Tool',
          'Completed',
          'Implement tool to list missions with filters',
          'Agents need to query available missions',
          '["Status filtering works", "Sprint filtering works", "Pagination works"]',
          '["src/tools/cmos/cmos-mission-list.ts"]',
          NULL,
          NULL,
          'Implemented with full test coverage',
          '2024-01-15T10:00:00Z',
          NULL
        ),
        (
          's11-m01',
          'sprint-11',
          'Bug Fix Mission',
          'Completed',
          'Fix critical bug in parser',
          NULL,
          '["Bug is fixed", "Tests pass"]',
          '["src/parser.ts"]',
          NULL,
          NULL,
          NULL,
          '2024-01-10T08:00:00Z',
          NULL
        ),
        (
          'standalone',
          NULL,
          'Standalone Mission',
          'Queued',
          'A mission without a sprint',
          'Testing standalone mission handling',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        ),
        (
          'blocked-m01',
          'sprint-12',
          'Blocked Mission',
          'Blocked',
          'This mission is blocked',
          'Waiting on external dependency',
          '["Dependency resolved"]',
          NULL,
          NULL,
          '{"blocker": "external-api", "blockedSince": "2024-01-14"}',
          'Blocked by external API availability',
          NULL,
          NULL
        );
    `);
    db.close();

    // Reset CmosDetector cache before each test
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic retrieval', () => {
    it('should retrieve a mission by ID with all fields', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.id).toBe('s12-m06');
      expect(result.data?.name).toBe('cmos_mission_show Tool');
      expect(result.data?.status).toBe('Current');
      expect(result.data?.objective).toBe('Implement tool to show full mission details by ID');
      expect(result.data?.context).toBe('Agents need to retrieve complete mission specifications');
    });

    it('should parse success_criteria JSON array', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.successCriteria).toEqual([
        'Accepts mission ID parameter',
        'Returns full mission spec',
        'Includes sprint context',
        'Returns MISSION_NOT_FOUND error if missing',
      ]);
    });

    it('should parse deliverables JSON array', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.deliverables).toEqual([
        'src/tools/cmos/cmos-mission-show.ts',
        'tests/tools/cmos/cmos-mission-show.test.ts',
      ]);
    });

    it('should parse reference_docs JSON array', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.referenceDocs).toEqual([
        'cmos/planning/cmos-mcp-implementation-roadmap.md',
      ]);
    });

    it('should parse domain_fields JSON object', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toEqual({
        priority: 'high',
        complexity: 'medium',
      });
    });

    it('should parse metadata JSON object', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.metadata).toEqual({
        estimatedHours: 2,
      });
    });

    it('should include notes', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.notes).toBe('In active development');
    });

    it('should include completedAt for completed missions', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m05' });

      expect(result.success).toBe(true);
      expect(result.data?.completedAt).toBe('2024-01-15T10:00:00Z');
    });
  });

  describe('sprint context', () => {
    it('should include sprint information when mission has sprint_id', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.sprint).toBeDefined();
      expect(result.data?.sprint?.id).toBe('sprint-12');
      expect(result.data?.sprint?.title).toBe('Sprint 12 - CMOS Tools');
      expect(result.data?.sprint?.focus).toBe('Implement CMOS MCP tools');
      expect(result.data?.sprint?.status).toBe('In Progress');
    });

    it('should return null sprint for standalone missions', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'standalone' });

      expect(result.success).toBe(true);
      expect(result.data?.sprint).toBeNull();
    });

    it('should include different sprint info for different sprints', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's11-m01' });

      expect(result.success).toBe(true);
      expect(result.data?.sprint?.id).toBe('sprint-11');
      expect(result.data?.sprint?.title).toBe('Sprint 11 - Stability');
      expect(result.data?.sprint?.focus).toBe('Bug fixes and stability');
    });
  });

  describe('null field handling', () => {
    it('should return null for null JSON fields', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'standalone' });

      expect(result.success).toBe(true);
      expect(result.data?.successCriteria).toBeNull();
      expect(result.data?.deliverables).toBeNull();
      expect(result.data?.referenceDocs).toBeNull();
      expect(result.data?.domainFields).toBeNull();
      expect(result.data?.metadata).toBeNull();
    });

    it('should handle mission with some null fields', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's11-m01' });

      expect(result.success).toBe(true);
      expect(result.data?.context).toBeNull();
      expect(result.data?.referenceDocs).toBeNull();
      expect(result.data?.notes).toBeNull();
      // But these should be present
      expect(result.data?.objective).toBe('Fix critical bug in parser');
      expect(result.data?.successCriteria).toEqual(['Bug is fixed', 'Tests pass']);
    });
  });

  describe('invalid JSON handling', () => {
    it('should return null for invalid JSON in success_criteria', async () => {
      // Insert mission with invalid JSON
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, success_criteria)
        VALUES ('bad-json', 'Bad JSON Mission', 'Queued', 'not valid json');
      `);
      db.close();

      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'bad-json' });

      expect(result.success).toBe(true);
      expect(result.data?.successCriteria).toBeNull();
    });

    it('should return null for invalid JSON in domain_fields', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, domain_fields)
        VALUES ('bad-domain', 'Bad Domain Mission', 'Queued', '{invalid}');
      `);
      db.close();

      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'bad-domain' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toBeNull();
    });

    it('should return null when JSON array is actually an object', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, success_criteria)
        VALUES ('object-in-array', 'Object in Array', 'Queued', '{"not": "an array"}');
      `);
      db.close();

      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'object-in-array' });

      expect(result.success).toBe(true);
      expect(result.data?.successCriteria).toBeNull();
    });

    it('should return null when JSON object is actually an array', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, domain_fields)
        VALUES ('array-in-object', 'Array in Object', 'Queued', '["not", "an", "object"]');
      `);
      db.close();

      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'array-in-object' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return MISSION_NOT_FOUND error for non-existent mission', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSION_NOT_FOUND);
      expect(result.error?.message).toContain('nonexistent');
      expect(result.error?.suggestion).toBeDefined();
      expect(result.error?.suggestion).toContain('cmos_mission_list');
    });

    it('should return MISSING_PARAMETER error for empty mission ID', async () => {
      const result = await cmosMissionShow({ missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER error for whitespace-only mission ID', async () => {
      const result = await cmosMissionShow({ missionId: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return CMOS_NOT_DETECTED when no CMOS directory found', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        const result = await cmosMissionShow({
          missionId: 's12-m06',
          projectRoot: emptyDir,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should return DB_SCHEMA_MISMATCH for database without missions table', async () => {
      const badDbPath = path.join(tempDir, 'bad.sqlite');
      const db = new Database(badDbPath);
      db.exec('CREATE TABLE other (id TEXT);');
      db.close();

      const result = await cmosMissionShowWithDb(badDbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH);
    });
  });

  describe('edge cases', () => {
    it('should trim mission ID whitespace', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: '  s12-m06  ' });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('s12-m06');
    });

    it('should handle missions with all statuses', async () => {
      // Test Current status
      const current = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      expect(current.data?.status).toBe('Current');

      // Test Completed status
      const completed = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m05' });
      expect(completed.data?.status).toBe('Completed');

      // Test Queued status
      const queued = await cmosMissionShowWithDb(dbPath, { missionId: 'standalone' });
      expect(queued.data?.status).toBe('Queued');

      // Test Blocked status
      const blocked = await cmosMissionShowWithDb(dbPath, { missionId: 'blocked-m01' });
      expect(blocked.data?.status).toBe('Blocked');
    });

    it('should handle blocked mission with domain_fields containing blocker info', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'blocked-m01' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toEqual({
        blocker: 'external-api',
        blockedSince: '2024-01-14',
      });
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosMissionShowToolDefinition.name).toBe('cmos_mission_show');
    });

    it('should have comprehensive description', () => {
      expect(cmosMissionShowToolDefinition.description).toBeTruthy();
      expect(cmosMissionShowToolDefinition.description).toContain('mission');
      expect(cmosMissionShowToolDefinition.description).toContain('details');
      expect(cmosMissionShowToolDefinition.description).toContain('objective');
    });

    it('should have valid input schema', () => {
      expect(cmosMissionShowToolDefinition.inputSchema.type).toBe('object');
      expect(cmosMissionShowToolDefinition.inputSchema.properties).toBeDefined();
      expect(cmosMissionShowToolDefinition.inputSchema.properties.missionId).toBeDefined();
      expect(cmosMissionShowToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('should mark missionId as required', () => {
      expect(cmosMissionShowToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('should have projectRoot as optional', () => {
      expect(cmosMissionShowToolDefinition.inputSchema.properties.projectRoot).toBeDefined();
      expect(cmosMissionShowToolDefinition.inputSchema.required).not.toContain('projectRoot');
    });
  });

  describe('formatMissionShowForLLM', () => {
    it('should format success result with all fields', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('# s12-m06');
      expect(formatted).toContain('cmos_mission_show Tool');
      expect(formatted).toContain('**Status**');
      expect(formatted).toContain('Current');
      expect(formatted).toContain('## Objective');
      expect(formatted).toContain('## Context');
      expect(formatted).toContain('## Success Criteria');
      expect(formatted).toContain('## Deliverables');
      expect(formatted).toContain('## Reference Docs');
    });

    it('should include sprint information', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('**Sprint**: sprint-12');
      expect(formatted).toContain('Sprint 12 - CMOS Tools');
      expect(formatted).toContain('**Focus**:');
    });

    it('should format success criteria as checklist', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('- [ ] Accepts mission ID parameter');
      expect(formatted).toContain('- [ ] Returns full mission spec');
    });

    it('should format deliverables as list', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('- src/tools/cmos/cmos-mission-show.ts');
    });

    it('should show completed timestamp', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m05' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('**Completed**:');
      expect(formatted).toContain('2024-01-15');
    });

    it('should format error result', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'nonexistent' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('Failed to retrieve mission');
      expect(formatted).toContain('not found');
      expect(formatted).toContain('Suggestion');
    });

    it('should use status icons', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      // Current status should have icon
      expect(formatted).toMatch(/[○◉◐✓⊘]/);
    });

    it('should omit sections for null fields', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 'standalone' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).not.toContain('## Success Criteria');
      expect(formatted).not.toContain('## Deliverables');
      expect(formatted).not.toContain('## Reference Docs');
      expect(formatted).not.toContain('**Sprint**:');
    });

    it('should include notes section when present', async () => {
      const result = await cmosMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('## Notes');
      expect(formatted).toContain('In active development');
    });
  });
});

/**
 * Helper to run cmosMissionShow with explicit database path.
 * Bypasses CMOS detection for unit testing.
 */
async function cmosMissionShowWithDb(
  dbPath: string,
  params: { missionId: string }
): Promise<CmosToolResult<MissionShowResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createSuccess, createError, CmosErrors } = await import('../../../src/tools/cmos/errors');

  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError<MissionShowResult>(CmosErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();

  return withClient(
    (client) => {
      // Query mission by ID
      const missionResult = client.getOne<Mission>(
        `
        SELECT
          id, sprint_id, name, status, completed_at, notes,
          objective, context, success_criteria, deliverables,
          reference_docs, domain_fields, metadata
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionShowResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionShowResult>(CmosErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;

      // Get sprint info if mission has a sprint_id
      interface SprintRow {
        id: string;
        title: string;
        focus: string | null;
        status: string | null;
      }

      let sprintInfo: MissionShowResult['sprint'] = null;
      if (mission.sprint_id) {
        const sprintResult = client.getOne<SprintRow>(
          `SELECT id, title, focus, status FROM sprints WHERE id = ?`,
          [mission.sprint_id]
        );

        if (sprintResult.success && sprintResult.data) {
          sprintInfo = {
            id: sprintResult.data.id,
            title: sprintResult.data.title,
            focus: sprintResult.data.focus,
            status: sprintResult.data.status,
          };
        }
      }

      // Parse and transform mission
      const result: MissionShowResult = {
        id: mission.id,
        name: mission.name,
        status: mission.status,
        objective: mission.objective,
        context: mission.context,
        successCriteria: parseJsonArray(mission.success_criteria),
        deliverables: parseJsonArray(mission.deliverables),
        referenceDocs: parseJsonArray(mission.reference_docs),
        domainFields: parseJsonObject(mission.domain_fields),
        notes: mission.notes,
        completedAt: mission.completed_at,
        createdAt: null,
        startedAt: null,
        updatedAt: null,
        metadata: parseJsonObject(mission.metadata),
        sprint: sprintInfo,
      };

      return createSuccess(result);
    },
    { dbPath }
  );
}

function parseJsonArray(jsonString: string | null): string[] | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(jsonString: string | null): Record<string, unknown> | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
