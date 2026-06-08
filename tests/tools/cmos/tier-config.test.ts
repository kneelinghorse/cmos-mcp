/**
 * Tier Config Tests
 *
 * Tests for tier config loading, parsing, field suppression,
 * and suggested action filtering.
 *
 * @module tests/tools/cmos/tier-config
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadTierConfig, type TierConfig } from '../../../src/tools/cmos/tier-config';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
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
  initServerHealth: jest.fn(),
}));

describe('tier-config', () => {
  describe('loadTierConfig', () => {
    it('should load build.md correctly', () => {
      const config = loadTierConfig('build');
      expect(config).not.toBeNull();
      expect(config!.tier).toBe('build');
      expect(config!.label).toBe('Build');
      expect(config!.toolsUse).toContain('cmos_mission');
      expect(config!.toolsUse).toContain('cmos_sprint');
      expect(config!.toolsSkip).toEqual([]);
      expect(config!.guide).toContain('structured engineering');
    });

    it('should load general.md correctly', () => {
      const config = loadTierConfig('general');
      expect(config).not.toBeNull();
      expect(config!.tier).toBe('general');
      expect(config!.label).toBe('General');
      expect(config!.toolsSkip).toContain('cmos_mission');
      expect(config!.toolsSkip).toContain('cmos_sprint');
      expect(config!.toolsSkip).toContain('cmos_db');
      expect(config!.onboardFieldsHide).toContain('currentSprint');
      expect(config!.onboardFieldsHide).toContain('pendingMissions');
      expect(config!.onboardFieldsHide).toContain('blockedMissions');
      expect(config!.guide).toContain('thinking partner');
    });

    it('should load managed.md correctly', () => {
      const config = loadTierConfig('managed');
      expect(config).not.toBeNull();
      expect(config!.tier).toBe('managed');
      expect(config!.label).toBe('Managed');
      expect(config!.toolsUse).toContain('cmos_mission');
      expect(config!.toolsSkip).toContain('cmos_sprint');
      expect(config!.onboardFieldsHide).toContain('currentSprint');
      expect(config!.onboardFieldsShow).toContain('pendingMissions');
    });

    it('should fall back to build.md for unknown tier', () => {
      const config = loadTierConfig('nonexistent');
      expect(config).not.toBeNull();
      expect(config!.tier).toBe('build');
    });

    it('should parse vocabulary with null values', () => {
      const config = loadTierConfig('general');
      expect(config).not.toBeNull();
      expect(config!.vocabulary.task).toBeNull();
      expect(config!.vocabulary.note).toBe('note');
    });

    it('should return null when tiers directory does not exist', () => {
      const config = loadTierConfig('build', '/nonexistent/path');
      expect(config).toBeNull();
    });
  });

  describe('onboard tier integration', () => {
    let tempDir: string;
    let dbPath: string;

    function setupDb(projectType?: string) {
      const cmosDbDir = path.join(tempDir, 'cmos', 'db');
      fs.mkdirSync(cmosDbDir, { recursive: true });
      dbPath = path.join(cmosDbDir, 'cmos.sqlite');

      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT,
          start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id),
          name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT,
          objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT,
          reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL,
          content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
          sprint_id TEXT REFERENCES sprints(id), started_at TEXT NOT NULL,
          completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active',
          summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT,
          context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);

        INSERT INTO metadata (key, value) VALUES ('project_name', 'TestProject');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'ctx', '{"project":{"name":"Test","status":"active"}}', '2026-03-14T00:00:00Z');

        INSERT INTO sprints (id, title, status, focus) VALUES ('s1', 'Sprint 1', 'Active', 'Test');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('s1-m01', 's1', 'Task A', 'Queued');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('s1-m02', 's1', 'Task B', 'Blocked');
      `);

      if (projectType) {
        db.exec(`INSERT INTO metadata (key, value) VALUES ('project_type', '${projectType}')`);
      }

      db.close();
    }

    function copyTierConfigs() {
      const srcTiersDir = path.resolve(__dirname, '../../../cmos/tiers');
      const destTiersDir = path.join(tempDir, 'cmos', 'tiers');
      fs.mkdirSync(destTiersDir, { recursive: true });
      for (const file of fs.readdirSync(srcTiersDir)) {
        fs.copyFileSync(path.join(srcTiersDir, file), path.join(destTiersDir, file));
      }
    }

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-tier-test-'));
      CmosDetector.resetInstance();
    });

    afterEach(() => {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should include tierConfig in build onboard (default)', async () => {
      setupDb();
      copyTierConfigs();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.tierConfig).not.toBeNull();
      expect(result.data?.tierConfig?.tier).toBe('build');
      expect(result.data?.tierConfig?.toolsSkip).toEqual([]);
    });

    it('should suppress sprint/missions for general tier', async () => {
      setupDb('general');
      copyTierConfigs();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint).toBeNull();
      expect(result.data?.pendingMissions).toEqual([]);
      expect(result.data?.blockedMissions).toEqual([]);
      expect(result.data?.tierConfig?.tier).toBe('general');
    });

    it('should suppress sprint but show missions for managed tier', async () => {
      setupDb('managed');
      copyTierConfigs();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint).toBeNull();
      // Managed shows pendingMissions
      expect(result.data?.pendingMissions.length).toBeGreaterThan(0);
      expect(result.data?.tierConfig?.tier).toBe('managed');
    });

    it('should show full payload for build tier', async () => {
      setupDb('build');
      copyTierConfigs();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint).not.toBeNull();
      expect(result.data?.pendingMissions.length).toBeGreaterThan(0);
      expect(result.data?.tierConfig?.tier).toBe('build');
    });

    it('should filter mission suggestions for general tier', async () => {
      setupDb('general');
      copyTierConfigs();

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);

      const commands = result.data?.suggestedActions.map((a) => a.command) ?? [];
      const hasMissionCmd = commands.some(
        (c) => c.includes('cmos_mission') && !c.includes('cmos_message')
      );
      expect(hasMissionCmd).toBe(false);
    });

    it('should gracefully handle missing tier config files', async () => {
      setupDb();
      // Don't copy tier configs — directory won't exist

      const result = await cmosAgentOnboard({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.tierConfig).toBeNull();
      // Should still work with full payload (no suppression)
      expect(result.data?.currentSprint).not.toBeNull();
    });
  });
});
