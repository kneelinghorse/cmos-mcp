/**
 * cmos_db_health Tool Tests
 *
 * Tests for the CMOS database health check tool.
 *
 * @module tests/tools/cmos/cmos-db-health
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosDbHealth,
  cmosDbHealthToolDefinition,
  formatHealthForLLM,
} from '../../../src/tools/cmos/cmos-db-health';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('cmosDbHealth', () => {
  let tempDir: string;
  let dbPath: string;
  let cmosDir: string;

  beforeEach(() => {
    // Create a temporary directory with proper CMOS structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-health-test-'));
    cmosDir = path.join(tempDir, 'cmos');
    const cmosDbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    // Create a test database with CMOS schema
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
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
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        captures TEXT,
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      -- Insert test data
      INSERT INTO missions (id, name, status, completed_at)
      VALUES
        ('m1', 'Test Mission 1', 'In Progress', NULL),
        ('m2', 'Test Mission 2', 'Current', NULL),
        ('m3', 'Test Mission 3', 'Completed', '2024-01-15T10:30:00Z');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES
        ('project_context', 'context/PROJECT_CONTEXT.json', '{"name": "test"}', '2024-01-20T15:00:00Z'),
        ('master_context', 'context/MASTER_CONTEXT.json', '{"version": "1.0"}', '2024-01-18T12:00:00Z');

      INSERT INTO sessions (id, type, title, started_at, completed_at, agent, status)
      VALUES
        ('s1', 'build', 'Build Session', '2024-01-10T09:00:00Z', '2024-01-10T17:00:00Z', 'test-agent', 'completed'),
        ('s2', 'review', 'Review Session', '2024-01-22T14:00:00Z', NULL, 'test-agent', 'active');
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

  describe('basic functionality', () => {
    it('should return successful health check for valid database', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.connected).toBe(true);
      expect(result.data?.path).toBe(dbPath);
    });

    it('should return correct table counts', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.missionCount).toBe(3);
      expect(result.data?.contextCount).toBe(2);
      expect(result.data?.sessionCount).toBe(2);
    });

    it('should return list of tables', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.tables).toContain('missions');
      expect(result.data?.tables).toContain('contexts');
      expect(result.data?.tables).toContain('sessions');
      expect(result.data?.tables).toContain('sprints');
    });

    it('should return SQLite version', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('last activity timestamps', () => {
    it('should return last mission activity from completed_at', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.lastMissionActivity).toBe('2024-01-15T10:30:00Z');
    });

    it('should return last session activity from completed_at', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      // Returns the latest completed_at timestamp first, falls back to started_at
      // s1 has completed_at '2024-01-10T17:00:00Z'
      expect(result.data?.lastSessionActivity).toBe('2024-01-10T17:00:00Z');
    });

    it('should return last context update', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.lastContextUpdate).toBe('2024-01-20T15:00:00Z');
    });

    it('should handle empty tables for activity timestamps', async () => {
      // Create new empty database
      const emptyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-empty-'));
      const emptyCmosDir = path.join(emptyTempDir, 'cmos');
      const emptyDbDir = path.join(emptyCmosDir, 'db');
      fs.mkdirSync(emptyDbDir, { recursive: true });
      const emptyDbPath = path.join(emptyDbDir, 'cmos.sqlite');

      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT, completed_at TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, title TEXT, started_at TEXT, completed_at TEXT, agent TEXT, status TEXT);
      `);
      db.close();

      try {
        CmosDetector.resetInstance();
        const result = await cmosDbHealth({ projectRoot: emptyTempDir });

        expect(result.success).toBe(true);
        expect(result.data?.lastMissionActivity).toBeNull();
        expect(result.data?.lastSessionActivity).toBeNull();
        expect(result.data?.lastContextUpdate).toBeNull();
      } finally {
        fs.rmSync(emptyTempDir, { recursive: true, force: true });
      }
    });
  });

  describe('file metadata', () => {
    it('should return file size in bytes', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.fileSizeBytes).toBeGreaterThan(0);
      expect(typeof result.data?.fileSizeBytes).toBe('number');
    });

    it('should detect WAL mode', async () => {
      const result = await cmosDbHealth({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      // WAL mode is enabled by the client
      expect(result.data?.walModeEnabled).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return actionable error when CMOS directory not found', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        CmosDetector.resetInstance();
        const result = await cmosDbHealth({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
        expect(result.error?.suggestion).toContain(
          `cmos_project(action="init", projectRoot=${JSON.stringify(emptyDir)})`
        );
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should return actionable error when database not found', async () => {
      // Create cmos directory but no database
      const noCmosDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-db-'));
      const cmosOnlyDir = path.join(noCmosDbDir, 'cmos');
      fs.mkdirSync(cmosOnlyDir, { recursive: true });

      try {
        CmosDetector.resetInstance();
        const result = await cmosDbHealth({ projectRoot: noCmosDbDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_NOT_FOUND);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(noCmosDbDir, { recursive: true, force: true });
      }
    });
  });

  describe('defaults', () => {
    it('should work without any parameters', async () => {
      // This test verifies the function handles empty params via cwd resolution.
      // Sprint 70 m01: pin process.cwd to an isolated tmpdir so the empty-params
      // path does NOT auto-discover the repo-root real dogfood store under Jest
      // (the real-store guard now refuses that open — decision #754). Preserves
      // the original intent: cmosDbHealth({}) resolves from cwd without crashing.
      const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-health-noparams-'));
      const originalCwd = process.cwd;
      process.cwd = () => isolatedCwd;
      try {
        const result = await cmosDbHealth({});
        // Result depends on registry fallback (tmpdir-only under Jest) — just verify no crash.
        expect(result).toBeDefined();
        expect(typeof result.success).toBe('boolean');
      } finally {
        process.cwd = originalCwd;
        fs.rmSync(isolatedCwd, { recursive: true, force: true });
      }
    });
  });
});

describe('formatHealthForLLM', () => {
  it('should format successful health check', () => {
    const result = {
      success: true,
      data: {
        connected: true,
        version: '3.45.0',
        path: '/path/to/cmos.sqlite',
        tables: ['missions', 'contexts', 'sessions'],
        missionCount: 5,
        sessionCount: 3,
        contextCount: 2,
        lastMissionActivity: '2024-01-15T10:30:00Z',
        lastSessionActivity: '2024-01-22T14:00:00Z',
        lastContextUpdate: '2024-01-20T15:00:00Z',
        fileSizeBytes: 102400,
        walModeEnabled: true,
      },
    };

    const formatted = formatHealthForLLM(result as any);

    expect(formatted).toContain('CMOS Database Health Check');
    expect(formatted).toContain('/path/to/cmos.sqlite');
    expect(formatted).toContain('3.45.0');
    expect(formatted).toContain('Missions: 5');
    expect(formatted).toContain('Sessions: 3');
    expect(formatted).toContain('Contexts: 2');
    expect(formatted).toContain('WAL Mode');
    expect(formatted).toContain('100.0 KB');
    expect(formatted).toContain('2024-01-15T10:30:00Z');
  });

  it('should format error result with suggestion', () => {
    const result = {
      success: false,
      error: {
        code: 'CMOS_NOT_DETECTED',
        message: 'CMOS directory not found',
        suggestion: 'Create a cmos/ directory with db/cmos.sqlite',
      },
    };

    const formatted = formatHealthForLLM(result as any);

    expect(formatted).toContain('Failed');
    expect(formatted).toContain('CMOS directory not found');
    expect(formatted).toContain('Create a cmos/');
  });

  it('should handle null activity timestamps', () => {
    const result = {
      success: true,
      data: {
        connected: true,
        version: '3.45.0',
        path: '/path/to/cmos.sqlite',
        tables: ['missions'],
        missionCount: 0,
        sessionCount: 0,
        contextCount: 0,
        lastMissionActivity: null,
        lastSessionActivity: null,
        lastContextUpdate: null,
        fileSizeBytes: 4096,
        walModeEnabled: false,
      },
    };

    const formatted = formatHealthForLLM(result as any);

    expect(formatted).toContain('No activity');
    expect(formatted).toContain('Never updated');
  });

  it('should handle null file size', () => {
    const result = {
      success: true,
      data: {
        connected: true,
        version: '3.45.0',
        path: '/path/to/cmos.sqlite',
        tables: ['missions'],
        missionCount: 0,
        sessionCount: 0,
        contextCount: 0,
        lastMissionActivity: null,
        lastSessionActivity: null,
        lastContextUpdate: null,
        fileSizeBytes: null,
        walModeEnabled: false,
      },
    };

    const formatted = formatHealthForLLM(result as any);

    // Should not crash, just not include file size line
    expect(formatted).not.toContain('File Size');
  });
});

describe('cmosDbHealthToolDefinition', () => {
  it('should have correct name', () => {
    expect(cmosDbHealthToolDefinition.name).toBe('cmos_db_health');
  });

  it('should have description mentioning health check', () => {
    expect(cmosDbHealthToolDefinition.description).toContain('health');
  });

  it('should have proper input schema', () => {
    expect(cmosDbHealthToolDefinition.inputSchema.type).toBe('object');
    expect(cmosDbHealthToolDefinition.inputSchema.properties).toBeDefined();
  });

  it('should have projectRoot as optional parameter', () => {
    const props = cmosDbHealthToolDefinition.inputSchema.properties as Record<string, any>;
    expect(props.projectRoot).toBeDefined();
    expect(props.projectRoot.type).toBe('string');
  });

  it('should not have additionalProperties', () => {
    expect(cmosDbHealthToolDefinition.inputSchema.additionalProperties).toBe(false);
  });
});
