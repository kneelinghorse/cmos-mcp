/**
 * project_type Metadata Tests
 *
 * Tests for project_type support in metadata, cmos_project update action,
 * and cmos_agent_onboard payload.
 *
 * @module tests/tools/cmos/cmos-project-type
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
import { getProjectType } from '../../../src/tools/cmos/cmos-agent-onboard';
import { cmosProject } from '../../../src/tools/cmos/cmos-project';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

jest.mock('../../../src/server-health', () => ({
  getServerHealth: () => ({
    uptimeSeconds: 120,
    startedAt: '2026-03-14T00:00:00.000Z',
    memoryUsageMb: 64,
    startupBuild: null,
    currentBuild: null,
    codeIsCurrent: true,
    stalenessMessage: null,
    pid: 12345,
    nodeVersion: 'v24.6.0',
  }),
  getServerProjectRoot: () => null,
  initServerHealth: jest.fn(),
}));

describe('project_type metadata', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-project-type-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT
      );

      INSERT INTO metadata (key, value) VALUES ('project_name', 'TestProject');
      INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project-id');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project":{"name":"TestProject","description":"Test project","status":"active"}}',
        '2026-03-14T00:00:00Z'
      );
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('getProjectType', () => {
    it('should return "build" by default when project_type is not set', async () => {
      // Use withClient pattern indirectly through onboard
      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.project.projectType).toBe('build');
    });

    it('should return explicit value when project_type is set', async () => {
      const db = new Database(dbPath);
      db.exec(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_type', 'general')`);
      db.close();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.project.projectType).toBe('general');
    });

    it('should return "build" for empty or whitespace-only values', async () => {
      const db = new Database(dbPath);
      db.exec(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_type', '  ')`);
      db.close();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.project.projectType).toBe('build');
    });
  });

  describe('cmos_project update action', () => {
    it('should set project_type to "general"', async () => {
      const result = await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'general',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ updated: { project_type: 'general' } });

      // Verify in DB
      const db = new Database(dbPath);
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('project_type') as
        | { value: string }
        | undefined;
      expect(row?.value).toBe('general');
      db.close();
    });

    it('should set project_type to "managed"', async () => {
      const result = await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'managed',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ updated: { project_type: 'managed' } });
    });

    it('should set project_type to "build"', async () => {
      const result = await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'build',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ updated: { project_type: 'build' } });
    });

    it('should reject invalid project_type values', async () => {
      const result = await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'invalid' as 'general',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PARAMETER');
    });

    it('should overwrite existing project_type', async () => {
      await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'general',
      });

      const result = await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'managed',
      });

      expect(result.success).toBe(true);

      const db = new Database(dbPath);
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('project_type') as
        | { value: string }
        | undefined;
      expect(row?.value).toBe('managed');
      db.close();
    });
  });

  describe('onboard payload includes projectType', () => {
    it('should include projectType in project identity', async () => {
      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.project).toHaveProperty('projectType');
      expect(result.data?.project.projectType).toBe('build');
    });

    it('should reflect updated project_type in onboard', async () => {
      await cmosProject({
        action: 'update',
        projectRoot: tempDir,
        projectType: 'general',
      });

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.project.projectType).toBe('general');
    });
  });
});
