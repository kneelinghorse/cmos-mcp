/**
 * rbook_mission_show Tool Tests
 *
 * Comprehensive tests for the mission show tool.
 *
 * @module tests/tools/rbook/rbook-mission-show
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookMissionShow,
  rbookMissionShowToolDefinition,
  formatMissionShowForLLM,
  type RbookMissionShowParams,
  type MissionShowResult,
} from '../../../src/tools/rbook/rbook-mission-show';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

describe('rbook_mission_show', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-mission-show-test-'));
    dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

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
        ('sprint-12', 'Sprint 12 - Reasonbook Tools', 'Implement Reasonbook MCP tools', 'In Progress');

      -- Insert comprehensive test missions
      INSERT INTO missions (id, sprint_id, name, status, objective, context, success_criteria, deliverables, reference_docs, domain_fields, notes, completed_at, metadata)
      VALUES
        (
          's12-m06',
          'sprint-12',
          'rbook_mission_show Tool',
          'Current',
          'Implement tool to show full mission details by ID',
          'Agents need to retrieve complete mission specifications',
          '["Accepts mission ID parameter", "Returns full mission spec", "Includes sprint context", "Returns MISSION_NOT_FOUND error if missing"]',
          '["src/tools/rbook/rbook-mission-show.ts", "tests/tools/rbook/rbook-mission-show.test.ts"]',
          '["rbook/planning/rbook-implementation-roadmap.md"]',
          '{"priority": "high", "complexity": "medium"}',
          'In active development',
          NULL,
          '{"estimatedHours": 2}'
        ),
        (
          's12-m05',
          'sprint-12',
          'rbook_mission_list Tool',
          'Completed',
          'Implement tool to list missions with filters',
          'Agents need to query available missions',
          '["Status filtering works", "Sprint filtering works", "Pagination works"]',
          '["src/tools/rbook/rbook-mission-list.ts"]',
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

    // Reset RbookDetector cache before each test
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic retrieval', () => {
    it('should retrieve a mission by ID with all fields', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.id).toBe('s12-m06');
      expect(result.data?.name).toBe('rbook_mission_show Tool');
      expect(result.data?.status).toBe('Current');
      expect(result.data?.objective).toBe('Implement tool to show full mission details by ID');
      expect(result.data?.context).toBe('Agents need to retrieve complete mission specifications');
    });

    it('should parse success_criteria JSON array', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.successCriteria).toEqual([
        'Accepts mission ID parameter',
        'Returns full mission spec',
        'Includes sprint context',
        'Returns MISSION_NOT_FOUND error if missing',
      ]);
    });

    it('should parse deliverables JSON array', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.deliverables).toEqual([
        'src/tools/rbook/rbook-mission-show.ts',
        'tests/tools/rbook/rbook-mission-show.test.ts',
      ]);
    });

    it('should parse reference_docs JSON array', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.referenceDocs).toEqual([
        'rbook/planning/rbook-implementation-roadmap.md',
      ]);
    });

    it('should parse domain_fields JSON object', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toEqual({
        priority: 'high',
        complexity: 'medium',
      });
    });

    it('should parse metadata JSON object', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.metadata).toEqual({
        estimatedHours: 2,
      });
    });

    it('should include notes', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.notes).toBe('In active development');
    });

    it('should include completedAt for completed missions', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m05' });

      expect(result.success).toBe(true);
      expect(result.data?.completedAt).toBe('2024-01-15T10:00:00Z');
    });
  });

  describe('sprint context', () => {
    it('should include sprint information when mission has sprint_id', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(true);
      expect(result.data?.sprint).toBeDefined();
      expect(result.data?.sprint?.id).toBe('sprint-12');
      expect(result.data?.sprint?.title).toBe('Sprint 12 - Reasonbook Tools');
      expect(result.data?.sprint?.focus).toBe('Implement Reasonbook MCP tools');
      expect(result.data?.sprint?.status).toBe('In Progress');
    });

    it('should return null sprint for standalone missions', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'standalone' });

      expect(result.success).toBe(true);
      expect(result.data?.sprint).toBeNull();
    });

    it('should include different sprint info for different sprints', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's11-m01' });

      expect(result.success).toBe(true);
      expect(result.data?.sprint?.id).toBe('sprint-11');
      expect(result.data?.sprint?.title).toBe('Sprint 11 - Stability');
      expect(result.data?.sprint?.focus).toBe('Bug fixes and stability');
    });
  });

  describe('null field handling', () => {
    it('should return null for null JSON fields', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'standalone' });

      expect(result.success).toBe(true);
      expect(result.data?.successCriteria).toBeNull();
      expect(result.data?.deliverables).toBeNull();
      expect(result.data?.referenceDocs).toBeNull();
      expect(result.data?.domainFields).toBeNull();
      expect(result.data?.metadata).toBeNull();
    });

    it('should handle mission with some null fields', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's11-m01' });

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

      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'bad-json' });

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

      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'bad-domain' });

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

      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'object-in-array' });

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

      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'array-in-object' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return MISSION_NOT_FOUND error for non-existent mission', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_NOT_FOUND);
      expect(result.error?.message).toContain('nonexistent');
      expect(result.error?.suggestion).toBeDefined();
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('rbook_mission(action="list")');
    });

    it('should return MISSING_PARAMETER error for empty mission ID', async () => {
      const result = await rbookMissionShow({ missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER error for whitespace-only mission ID', async () => {
      const result = await rbookMissionShow({ missionId: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return RBOOK_NOT_DETECTED when no Reasonbook directory found', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookMissionShow({
          missionId: 's12-m06',
          projectRoot: emptyDir,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should return DB_SCHEMA_MISMATCH for database without missions table', async () => {
      const badDbPath = path.join(tempDir, 'bad', 'rbook', 'db', 'rbook.sqlite');
      fs.mkdirSync(path.dirname(badDbPath), { recursive: true });
      const db = new Database(badDbPath);
      db.exec('CREATE TABLE other (id TEXT);');
      db.close();

      const result = await rbookMissionShowWithDb(badDbPath, { missionId: 's12-m06' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH);
    });
  });

  describe('edge cases', () => {
    it('should trim mission ID whitespace', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: '  s12-m06  ' });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('s12-m06');
    });

    it('should handle missions with all statuses', async () => {
      // Test Current status
      const current = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      expect(current.data?.status).toBe('Current');

      // Test Completed status
      const completed = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m05' });
      expect(completed.data?.status).toBe('Completed');

      // Test Queued status
      const queued = await rbookMissionShowWithDb(dbPath, { missionId: 'standalone' });
      expect(queued.data?.status).toBe('Queued');

      // Test Blocked status
      const blocked = await rbookMissionShowWithDb(dbPath, { missionId: 'blocked-m01' });
      expect(blocked.data?.status).toBe('Blocked');
    });

    it('should handle blocked mission with domain_fields containing blocker info', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'blocked-m01' });

      expect(result.success).toBe(true);
      expect(result.data?.domainFields).toEqual({
        blocker: 'external-api',
        blockedSince: '2024-01-14',
      });
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionShowToolDefinition.name).toBe('rbook_mission_show');
    });

    it('should have comprehensive description', () => {
      expect(rbookMissionShowToolDefinition.description).toBeTruthy();
      expect(rbookMissionShowToolDefinition.description).toContain('mission');
      expect(rbookMissionShowToolDefinition.description).toContain('details');
      expect(rbookMissionShowToolDefinition.description).toContain('objective');
    });

    it('should have valid input schema', () => {
      expect(rbookMissionShowToolDefinition.inputSchema.type).toBe('object');
      expect(rbookMissionShowToolDefinition.inputSchema.properties).toBeDefined();
      expect(rbookMissionShowToolDefinition.inputSchema.properties.missionId).toBeDefined();
      expect(rbookMissionShowToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('should mark missionId as required', () => {
      expect(rbookMissionShowToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('should have projectRoot as optional', () => {
      expect(rbookMissionShowToolDefinition.inputSchema.properties.projectRoot).toBeDefined();
      expect(rbookMissionShowToolDefinition.inputSchema.required).not.toContain('projectRoot');
    });
  });

  describe('formatMissionShowForLLM', () => {
    it('should format success result with all fields', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('# s12-m06');
      expect(formatted).toContain('rbook_mission_show Tool');
      expect(formatted).toContain('**Status**');
      expect(formatted).toContain('Current');
      expect(formatted).toContain('## Objective');
      expect(formatted).toContain('## Context');
      expect(formatted).toContain('## Success Criteria');
      expect(formatted).toContain('## Deliverables');
      expect(formatted).toContain('## Reference Docs');
    });

    it('should include sprint information', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('**Sprint**: sprint-12');
      expect(formatted).toContain('Sprint 12 - Reasonbook Tools');
      expect(formatted).toContain('**Focus**:');
    });

    it('should format success criteria as checklist', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('- [ ] Accepts mission ID parameter');
      expect(formatted).toContain('- [ ] Returns full mission spec');
    });

    it('should format deliverables as list', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('- src/tools/rbook/rbook-mission-show.ts');
    });

    it('should show completed timestamp', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m05' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('**Completed**:');
      expect(formatted).toContain('2024-01-15');
    });

    it('should format error result', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'nonexistent' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('Failed to retrieve mission');
      expect(formatted).toContain('not found');
      expect(formatted).toContain('Suggestion');
    });

    it('should use status icons', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      // Current status should have icon
      expect(formatted).toMatch(/[○◉◐✓⊘]/);
    });

    it('should omit sections for null fields', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 'standalone' });
      const formatted = formatMissionShowForLLM(result);

      // s95-m09: the mission itself is shown, so an error text cannot pass for "sections omitted".
      expect(result.success).toBe(true);
      expect(formatted).toContain('standalone');
      expect(formatted).not.toContain('## Success Criteria');
      expect(formatted).not.toContain('## Deliverables');
      expect(formatted).not.toContain('## Reference Docs');
      expect(formatted).not.toContain('**Sprint**:');
    });

    it('should include notes section when present', async () => {
      const result = await rbookMissionShowWithDb(dbPath, { missionId: 's12-m06' });
      const formatted = formatMissionShowForLLM(result);

      expect(formatted).toContain('## Notes');
      expect(formatted).toContain('In active development');
    });
  });
});

/**
 * Helper to run the shipped rbookMissionShow against the fixture's store.
 * s95-m09: it used to hold its own copy of the handler (its SQL and JSON parsing), so these
 * cases tested that copy rather than shipped code. It now maps the store path
 * (<root>/rbook/db/rbook.sqlite) to its project root and calls the handler.
 */
async function rbookMissionShowWithDb(
  dbPath: string,
  params: { missionId: string }
): Promise<RbookToolResult<MissionShowResult>> {
  return rbookMissionShow({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
