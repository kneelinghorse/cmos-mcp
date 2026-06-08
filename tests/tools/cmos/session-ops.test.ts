/**
 * Session Operations Tools Tests
 *
 * Comprehensive tests for all session operation tools:
 * - cmos_session_start
 * - cmos_session_capture
 * - cmos_session_complete
 * - cmos_session_list
 *
 * Each tool has 8+ tests covering happy paths and error cases.
 *
 * @module tests/tools/cmos/session-ops
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

// Import tool implementations and types
import {
  cmosSessionStart,
  cmosSessionStartToolDefinition,
  formatSessionStartForLLM,
  VALID_SESSION_TYPES,
  type CmosSessionStartResult,
  type SessionType,
} from '../../../src/tools/cmos/cmos-session-start';

import {
  cmosSessionCapture,
  cmosSessionCaptureToolDefinition,
  formatSessionCaptureForLLM,
  VALID_CAPTURE_CATEGORIES,
  type CmosSessionCaptureResult,
  type CaptureCategory,
} from '../../../src/tools/cmos/cmos-session-capture';

import {
  cmosSessionComplete,
  cmosSessionCompleteToolDefinition,
  formatSessionCompleteForLLM,
  type CmosSessionCompleteResult,
} from '../../../src/tools/cmos/cmos-session-complete';

import {
  cmosSessionList,
  cmosSessionListToolDefinition,
  formatSessionListForLLM,
  VALID_SESSION_STATUSES,
  type CmosSessionListResult,
  type SessionStatus,
} from '../../../src/tools/cmos/cmos-session-list';

/**
 * Helper to create test database with sessions table and test data.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-session-test-'));
  // Create cmos/db directory structure for CmosDetector
  const cmosDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDir, { recursive: true });
  const dbPath = path.join(cmosDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  // Create schema
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

    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL,
      session_id TEXT,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
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

    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      agent TEXT,
      mission TEXT,
      action TEXT,
      status TEXT,
      summary TEXT,
      next_hint TEXT,
      raw_event TEXT NOT NULL
    );

    CREATE INDEX idx_sessions_type ON sessions (type);
    CREATE INDEX idx_sessions_status ON sessions (status);
    CREATE INDEX idx_sessions_sprint ON sessions (sprint_id);

    -- Seed sprint/mission/context data used by session_start auto-refresh
    INSERT INTO sprints (id, title, focus, status)
    VALUES ('sprint-12', 'Sprint 12', 'Session ops baseline', 'Current');

    INSERT INTO missions (id, sprint_id, name, status, completed_at, objective)
    VALUES
      ('s12-m01', 'sprint-12', 'Completed Mission', 'Completed', '2024-01-11T12:30:00Z', 'Completed baseline mission'),
      ('s12-m02', 'sprint-12', 'Current Mission', 'Current', NULL, 'Current mission');

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"Session Test Project"}}', '2024-01-12T12:00:00Z'),
      ('project_context', 'context/PROJECT_CONTEXT.json', '{"working_memory":{"next_steps":[]}}', '2024-01-12T12:00:00Z');

    -- Insert test sessions
    INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, agent, summary, status, captures, next_steps)
    VALUES
      ('PS-2024-01-10-001', 'planning', 'Sprint 12 Planning', 'sprint-12', '2024-01-10T10:00:00Z', '2024-01-10T12:00:00Z', 'assistant', 'Sprint planned successfully', 'completed', '[{"category":"decision","content":"Focus on performance"}]', '["Run benchmarks"]'),
      ('PS-2024-01-11-001', 'review', 'Weekly Review', NULL, '2024-01-11T10:00:00Z', '2024-01-11T11:00:00Z', 'assistant', 'Good progress made', 'completed', '[{"category":"learning","content":"Test coverage improved"}]', NULL),
      ('PS-2024-01-12-001', 'research', 'API Investigation', 'sprint-12', '2024-01-12T10:00:00Z', NULL, 'assistant', NULL, 'active', '[]', NULL);
  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

// ============================================================================
// cmos_session_start Tests
// ============================================================================

describe('cmos_session_start', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should start a new session when none is active', async () => {
      // Complete the existing active session first
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Test Planning Session',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.type).toBe('planning');
      expect(result.data?.title).toBe('Test Planning Session');
      expect(result.data?.sessionId).toMatch(/^PS-\d{4}-\d{2}-\d{2}-\d{3}$/);
    });

    it('should generate sequential session IDs for same day', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      // Start first session
      const result1 = await cmosSessionStart({
        type: 'planning',
        title: 'First',
        projectRoot: testDb.tempDir,
      });
      expect(result1.success).toBe(true);

      // Complete it
      testDb.db.exec(
        `UPDATE sessions SET status = 'completed' WHERE id = '${result1.data?.sessionId}'`
      );

      // Start second session
      const result2 = await cmosSessionStart({
        type: 'review',
        title: 'Second',
        projectRoot: testDb.tempDir,
      });
      expect(result2.success).toBe(true);

      // IDs should be sequential
      const id1 = result1.data?.sessionId ?? '';
      const id2 = result2.data?.sessionId ?? '';
      const counter1 = parseInt(id1.split('-').pop() ?? '0', 10);
      const counter2 = parseInt(id2.split('-').pop() ?? '0', 10);
      expect(counter2).toBe(counter1 + 1);
    });

    it('should set status to active', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'onboarding',
        title: 'New Agent Onboarding',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const row = testDb.db
        .prepare('SELECT status FROM sessions WHERE id = ?')
        .get(result.data?.sessionId) as { status: string };
      expect(row.status).toBe('active');
    });

    it('should associate sprint_id when provided', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Sprint Planning',
        sprintId: 'sprint-13',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sprintId).toBe('sprint-13');
      const row = testDb.db
        .prepare('SELECT sprint_id FROM sessions WHERE id = ?')
        .get(result.data?.sessionId) as { sprint_id: string };
      expect(row.sprint_id).toBe('sprint-13');
    });

    it('should use default agent when not provided', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'research',
        title: 'Research Session',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.agent).toBe('assistant');
    });

    it('should use custom agent when provided', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'check-in',
        title: 'Check-in',
        agent: 'opus',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.agent).toBe('opus');
    });

    it('should initialize captures as empty array', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Empty Session',
        projectRoot: testDb.tempDir,
      });

      const row = testDb.db
        .prepare('SELECT captures FROM sessions WHERE id = ?')
        .get(result.data?.sessionId) as { captures: string };
      expect(JSON.parse(row.captures)).toEqual([]);
    });

    it('should create session event record', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'review',
        title: 'Review Session',
        projectRoot: testDb.tempDir,
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ?')
        .get(result.data?.sessionId) as Record<string, unknown>;
      expect(event).toBeDefined();
      expect(event.action).toBe('start');
      expect(event.status).toBe('active');
    });

    it('should auto-refresh master_context by default from unaggregated completions', async () => {
      testDb.db.exec(`
        UPDATE sessions SET status = 'completed' WHERE status = 'active';
        UPDATE contexts SET updated_at = '2024-01-01T00:00:00Z' WHERE id = 'master_context';
        UPDATE missions SET completed_at = '2024-01-20T00:00:00Z' WHERE id = 's12-m01';
      `);

      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Auto-refresh check',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextAutoRefresh.enabled).toBe(true);
      expect(result.data?.contextAutoRefresh.refreshed).toBe(true);
      expect(result.data?.contextAutoRefresh.missionsAdded).toBeGreaterThanOrEqual(1);

      const masterRow = testDb.db
        .prepare('SELECT content, updated_at FROM contexts WHERE id = ?')
        .get('master_context') as { content: string; updated_at: string | null };
      const master = JSON.parse(masterRow.content) as {
        completed_missions?: Array<{ mission_id?: string }>;
      };
      const hasMission = (master.completed_missions ?? []).some(
        (entry) => entry.mission_id === 's12-m01'
      );
      expect(hasMission).toBe(true);
      expect(masterRow.updated_at).not.toBe('2024-01-01T00:00:00Z');
    });

    it('should allow disabling auto-refresh on session start', async () => {
      testDb.db.exec(`
        UPDATE sessions SET status = 'completed' WHERE status = 'active';
        UPDATE contexts SET updated_at = '2024-01-01T00:00:00Z' WHERE id = 'master_context';
        UPDATE missions SET completed_at = '2024-01-20T00:00:00Z' WHERE id = 's12-m01';
      `);

      const result = await cmosSessionStart({
        type: 'planning',
        title: 'No auto-refresh',
        autoRefreshMasterContext: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextAutoRefresh.enabled).toBe(false);
      expect(result.data?.contextAutoRefresh.refreshed).toBe(false);

      const masterRow = testDb.db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      const master = JSON.parse(masterRow.content) as {
        completed_missions?: Array<{ mission_id?: string }>;
      };
      const hasMission = (master.completed_missions ?? []).some(
        (entry) => entry.mission_id === 's12-m01'
      );
      expect(hasMission).toBe(false);
    });
  });

  describe('error cases', () => {
    it('should return SESSION_ALREADY_ACTIVE when session is active', async () => {
      // There's already an active session in test data
      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Another Session',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE);
      expect(result.error?.suggestion).toContain('cmos_session_complete');
    });

    it('should return MISSING_PARAMETER for empty title', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionStart({
        type: 'planning',
        title: '',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('title');
    });

    it('should return CMOS_NOT_DETECTED for invalid project root', async () => {
      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Test',
        projectRoot: '/nonexistent/path',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSessionStartToolDefinition.name).toBe('cmos_session_start');
    });

    it('should require type and title parameters', () => {
      expect(cmosSessionStartToolDefinition.inputSchema.required).toContain('type');
      expect(cmosSessionStartToolDefinition.inputSchema.required).toContain('title');
    });

    it('should have valid session types enum', () => {
      const props = cmosSessionStartToolDefinition.inputSchema.properties;
      expect(props.type.enum).toEqual(VALID_SESSION_TYPES);
    });
  });

  describe('formatSessionStartForLLM', () => {
    it('should format success with session details', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);
      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Test',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionStartForLLM(result);

      expect(formatted).toContain('🎬');
      expect(formatted).toContain('Session Started');
      expect(formatted).toContain('planning');
    });

    it('should format error with suggestion', async () => {
      const result = await cmosSessionStart({
        type: 'planning',
        title: 'Test',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionStartForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Suggestion');
    });
  });
});

// ============================================================================
// cmos_session_capture Tests
// ============================================================================

describe('cmos_session_capture', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should capture to active session when no sessionId provided', async () => {
      const result = await cmosSessionCapture({
        category: 'decision',
        content: 'Decided to use TypeScript',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBe('PS-2024-01-12-001');
      expect(result.data?.category).toBe('decision');
      expect(result.data?.content).toBe('Decided to use TypeScript');
    });

    it('should capture to specific session when sessionId provided', async () => {
      // Make the completed session active again for this test
      testDb.db.exec(`UPDATE sessions SET status = 'active' WHERE id = 'PS-2024-01-10-001'`);

      const result = await cmosSessionCapture({
        sessionId: 'PS-2024-01-10-001',
        category: 'learning',
        content: 'Learned about async patterns',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBe('PS-2024-01-10-001');
    });

    it('should increment capture count', async () => {
      // Capture multiple times
      await cmosSessionCapture({
        category: 'decision',
        content: 'Decision 1',
        projectRoot: testDb.tempDir,
      });

      const result2 = await cmosSessionCapture({
        category: 'learning',
        content: 'Learning 1',
        projectRoot: testDb.tempDir,
      });

      expect(result2.success).toBe(true);
      expect(result2.data?.captureCount).toBe(2);
    });

    it('should support all capture categories', async () => {
      for (const category of VALID_CAPTURE_CATEGORIES) {
        const result = await cmosSessionCapture({
          category,
          content: `Test ${category}`,
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.category).toBe(category);
      }
    });

    it('should store context when provided', async () => {
      const result = await cmosSessionCapture({
        category: 'decision',
        content: 'Use Redis',
        context: 'For caching layer performance',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT captures FROM sessions WHERE id = ?')
        .get('PS-2024-01-12-001') as { captures: string };
      const captures = JSON.parse(row.captures);
      const lastCapture = captures[captures.length - 1];
      expect(lastCapture.context).toBe('For caching layer performance');
    });

    it('should record timestamp for each capture', async () => {
      const before = new Date().toISOString();
      const result = await cmosSessionCapture({
        category: 'constraint',
        content: 'No external APIs',
        projectRoot: testDb.tempDir,
      });
      const after = new Date().toISOString();

      expect(result.success).toBe(true);
      const timestamp = result.data?.timestamp;
      expect(timestamp).toBeDefined();
      expect(timestamp !== undefined && timestamp >= before).toBe(true);
      expect(timestamp !== undefined && timestamp <= after).toBe(true);
    });

    it('should create session event for capture', async () => {
      await cmosSessionCapture({
        category: 'next-step',
        content: 'Run integration tests',
        projectRoot: testDb.tempDir,
      });

      const event = testDb.db
        .prepare(
          "SELECT * FROM session_events WHERE mission = 'PS-2024-01-12-001' AND action = 'capture'"
        )
        .get() as Record<string, unknown>;
      expect(event).toBeDefined();
      expect(event.summary).toContain('next-step');
    });

    it('should use custom agent when provided', async () => {
      const result = await cmosSessionCapture({
        category: 'context',
        content: 'Background info',
        agent: 'opus',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const event = testDb.db
        .prepare(
          "SELECT agent FROM session_events WHERE mission = 'PS-2024-01-12-001' AND action = 'capture' ORDER BY id DESC LIMIT 1"
        )
        .get() as { agent: string };
      expect(event.agent).toBe('opus');
    });
  });

  describe('error cases', () => {
    it('should return SESSION_NOT_ACTIVE when no active session', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionCapture({
        category: 'decision',
        content: 'Test',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_ACTIVE);
    });

    it('should return SESSION_NOT_FOUND for invalid sessionId', async () => {
      const result = await cmosSessionCapture({
        sessionId: 'nonexistent-session',
        category: 'decision',
        content: 'Test',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_FOUND);
    });

    it('should return SESSION_NOT_ACTIVE for completed session', async () => {
      const result = await cmosSessionCapture({
        sessionId: 'PS-2024-01-10-001', // This is completed
        category: 'decision',
        content: 'Test',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_ACTIVE);
    });

    it('should return MISSING_PARAMETER for empty content', async () => {
      const result = await cmosSessionCapture({
        category: 'decision',
        content: '',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSessionCaptureToolDefinition.name).toBe('cmos_session_capture');
    });

    it('should require category and content', () => {
      expect(cmosSessionCaptureToolDefinition.inputSchema.required).toContain('category');
      expect(cmosSessionCaptureToolDefinition.inputSchema.required).toContain('content');
    });

    it('should have valid capture categories enum', () => {
      const props = cmosSessionCaptureToolDefinition.inputSchema.properties;
      expect(props.category.enum).toEqual(VALID_CAPTURE_CATEGORIES);
    });
  });

  describe('formatSessionCaptureForLLM', () => {
    it('should format success with category icon', async () => {
      const result = await cmosSessionCapture({
        category: 'decision',
        content: 'Test decision',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionCaptureForLLM(result);

      expect(formatted).toContain('⚖️');
      expect(formatted).toContain('Decision Captured');
    });

    it('should show different icons for different categories', async () => {
      const icons: Record<CaptureCategory, string> = {
        decision: '⚖️',
        learning: '💡',
        constraint: '🚧',
        context: '📋',
        'next-step': '➡️',
      };

      for (const [category, icon] of Object.entries(icons)) {
        const result = await cmosSessionCapture({
          category: category as CaptureCategory,
          content: `Test ${category}`,
          projectRoot: testDb.tempDir,
        });
        const formatted = formatSessionCaptureForLLM(result);
        expect(formatted).toContain(icon);
      }
    });
  });
});

// ============================================================================
// cmos_session_complete Tests
// ============================================================================

describe('cmos_session_complete', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should complete active session', async () => {
      const result = await cmosSessionComplete({
        summary: 'Research completed successfully',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBe('PS-2024-01-12-001');
      expect(result.data?.summary).toBe('Research completed successfully');
    });

    it('should set status to completed', async () => {
      await cmosSessionComplete({
        summary: 'Done',
        projectRoot: testDb.tempDir,
      });

      const row = testDb.db
        .prepare('SELECT status FROM sessions WHERE id = ?')
        .get('PS-2024-01-12-001') as { status: string };
      expect(row.status).toBe('completed');
    });

    it('should record completed_at timestamp', async () => {
      const before = new Date().toISOString();
      const result = await cmosSessionComplete({
        summary: 'Completed',
        projectRoot: testDb.tempDir,
      });
      const after = new Date().toISOString();

      expect(result.success).toBe(true);
      const completedAt = result.data?.completedAt;
      expect(completedAt).toBeDefined();
      expect(completedAt !== undefined && completedAt >= before).toBe(true);
      expect(completedAt !== undefined && completedAt <= after).toBe(true);
    });

    it('should calculate duration in minutes', async () => {
      // The active session started at 2024-01-12T10:00:00Z
      const result = await cmosSessionComplete({
        summary: 'Done',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.durationMinutes).toBeGreaterThan(0);
    });

    it('should store next steps when provided', async () => {
      const result = await cmosSessionComplete({
        summary: 'Research done',
        nextSteps: ['Implement findings', 'Write tests'],
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.nextSteps).toEqual(['Implement findings', 'Write tests']);

      const row = testDb.db
        .prepare('SELECT next_steps FROM sessions WHERE id = ?')
        .get('PS-2024-01-12-001') as { next_steps: string };
      expect(JSON.parse(row.next_steps)).toEqual(['Implement findings', 'Write tests']);
    });

    it('should return capture count and breakdown', async () => {
      // Add some captures first
      await cmosSessionCapture({
        category: 'decision',
        content: 'Decision 1',
        projectRoot: testDb.tempDir,
      });
      await cmosSessionCapture({
        category: 'decision',
        content: 'Decision 2',
        projectRoot: testDb.tempDir,
      });
      await cmosSessionCapture({
        category: 'learning',
        content: 'Learning 1',
        projectRoot: testDb.tempDir,
      });

      const result = await cmosSessionComplete({
        summary: 'Done',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.captureCount).toBe(3);
      expect(result.data?.capturesByCategory.decision).toBe(2);
      expect(result.data?.capturesByCategory.learning).toBe(1);
    });

    it('should complete specific session when sessionId provided', async () => {
      // Make another session active
      testDb.db.exec(`UPDATE sessions SET status = 'active' WHERE id = 'PS-2024-01-10-001'`);

      const result = await cmosSessionComplete({
        sessionId: 'PS-2024-01-10-001',
        summary: 'Completed specific session',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBe('PS-2024-01-10-001');
    });

    it('should create session event for completion', async () => {
      await cmosSessionComplete({
        summary: 'Session summary',
        projectRoot: testDb.tempDir,
      });

      const event = testDb.db
        .prepare(
          "SELECT * FROM session_events WHERE mission = 'PS-2024-01-12-001' AND action = 'complete'"
        )
        .get() as Record<string, unknown>;
      expect(event).toBeDefined();
      expect(event.status).toBe('completed');
      expect(event.summary).toBe('Session summary');
    });
  });

  describe('error cases', () => {
    it('should return SESSION_NOT_ACTIVE when no active session', async () => {
      testDb.db.exec(`UPDATE sessions SET status = 'completed' WHERE status = 'active'`);

      const result = await cmosSessionComplete({
        summary: 'Done',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_ACTIVE);
    });

    it('should return SESSION_NOT_FOUND for invalid sessionId', async () => {
      const result = await cmosSessionComplete({
        sessionId: 'nonexistent',
        summary: 'Done',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_FOUND);
    });

    it('should return SESSION_NOT_ACTIVE for already completed session', async () => {
      const result = await cmosSessionComplete({
        sessionId: 'PS-2024-01-10-001', // Already completed
        summary: 'Done again',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_ACTIVE);
    });

    it('should return MISSING_PARAMETER for empty summary', async () => {
      const result = await cmosSessionComplete({
        summary: '',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSessionCompleteToolDefinition.name).toBe('cmos_session_complete');
    });

    it('should require summary parameter', () => {
      expect(cmosSessionCompleteToolDefinition.inputSchema.required).toContain('summary');
    });

    it('should not require sessionId (uses active session)', () => {
      expect(cmosSessionCompleteToolDefinition.inputSchema.required).not.toContain('sessionId');
    });
  });

  describe('formatSessionCompleteForLLM', () => {
    it('should format success with completion details', async () => {
      const result = await cmosSessionComplete({
        summary: 'All done',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionCompleteForLLM(result);

      expect(formatted).toContain('✅');
      expect(formatted).toContain('Session Completed');
      expect(formatted).toContain('Duration');
    });

    it('should show capture breakdown', async () => {
      await cmosSessionCapture({
        category: 'decision',
        content: 'D1',
        projectRoot: testDb.tempDir,
      });
      await cmosSessionCapture({
        category: 'learning',
        content: 'L1',
        projectRoot: testDb.tempDir,
      });

      const result = await cmosSessionComplete({
        summary: 'Done',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionCompleteForLLM(result);

      expect(formatted).toContain('Capture Breakdown');
      expect(formatted).toContain('decision');
      expect(formatted).toContain('learning');
    });
  });
});

// ============================================================================
// cmos_session_list Tests
// ============================================================================

describe('cmos_session_list', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should list all sessions when no filters', async () => {
      const result = await cmosSessionList({
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(3);
      expect(result.data?.totalCount).toBe(3);
    });

    it('should filter by status', async () => {
      const result = await cmosSessionList({
        status: 'completed',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(2);
      expect(result.data?.sessions.every((s) => s.status === 'completed')).toBe(true);
    });

    it('should filter by type', async () => {
      const result = await cmosSessionList({
        type: 'planning',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(1);
      expect(result.data?.sessions[0].type).toBe('planning');
    });

    it('should filter by sprintId', async () => {
      const result = await cmosSessionList({
        sprintId: 'sprint-12',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(2);
      expect(result.data?.sessions.every((s) => s.sprintId === 'sprint-12')).toBe(true);
    });

    it('should combine multiple filters', async () => {
      const result = await cmosSessionList({
        status: 'completed',
        sprintId: 'sprint-12',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(1);
      expect(result.data?.sessions[0].id).toBe('PS-2024-01-10-001');
    });

    it('should return sessions in descending order by start date', async () => {
      const result = await cmosSessionList({
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const dates = result.data?.sessions.map((s) => new Date(s.startedAt).getTime()) ?? [];
      for (let i = 0; i < dates.length - 1; i++) {
        expect(dates[i]).toBeGreaterThanOrEqual(dates[i + 1]);
      }
    });

    it('should paginate correctly', async () => {
      const result = await cmosSessionList({
        page: 1,
        pageSize: 2,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(2);
      expect(result.data?.page).toBe(1);
      expect(result.data?.pageSize).toBe(2);
      expect(result.data?.hasMore).toBe(true);
    });

    it('should return hasMore=false on last page', async () => {
      const result = await cmosSessionList({
        page: 2,
        pageSize: 2,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(1);
      expect(result.data?.hasMore).toBe(false);
    });

    it('should include capture count for each session', async () => {
      const result = await cmosSessionList({
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const planningSession = result.data?.sessions.find((s) => s.id === 'PS-2024-01-10-001');
      expect(planningSession?.captureCount).toBe(1);
    });

    it('should include summary for completed sessions', async () => {
      const result = await cmosSessionList({
        status: 'completed',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.every((s) => s.summary !== null)).toBe(true);
    });
  });

  describe('empty results', () => {
    it('should return empty array for no matches', async () => {
      const result = await cmosSessionList({
        sprintId: 'nonexistent-sprint',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessions.length).toBe(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosSessionListToolDefinition.name).toBe('cmos_session_list');
    });

    it('should not require any parameters', () => {
      // No required array means all parameters are optional
      const schema = cmosSessionListToolDefinition.inputSchema as Record<string, unknown>;
      expect(schema.required).toBeUndefined();
    });

    it('should have valid status enum', () => {
      const props = cmosSessionListToolDefinition.inputSchema.properties;
      expect(props.status.enum).toEqual(VALID_SESSION_STATUSES);
    });

    it('should have valid type enum', () => {
      const props = cmosSessionListToolDefinition.inputSchema.properties;
      expect(props.type.enum).toEqual(VALID_SESSION_TYPES);
    });

    it('should have page and pageSize limits', () => {
      const props = cmosSessionListToolDefinition.inputSchema.properties;
      expect(props.page.minimum).toBe(1);
      expect(props.pageSize.minimum).toBe(1);
      expect(props.pageSize.maximum).toBe(100);
    });
  });

  describe('formatSessionListForLLM', () => {
    it('should format sessions with status icons', async () => {
      const result = await cmosSessionList({
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionListForLLM(result);

      expect(formatted).toContain('📋');
      expect(formatted).toContain('Sessions');
      expect(formatted).toContain('✅'); // completed sessions
      expect(formatted).toContain('🟢'); // active session
    });

    it('should show filters when applied', async () => {
      const result = await cmosSessionList({
        status: 'completed',
        type: 'planning',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionListForLLM(result);

      expect(formatted).toContain('Filters');
      expect(formatted).toContain('status=completed');
      expect(formatted).toContain('type=planning');
    });

    it('should show pagination info when hasMore', async () => {
      const result = await cmosSessionList({
        pageSize: 2,
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionListForLLM(result);

      expect(formatted).toContain('page parameter');
    });

    it('should show empty message when no sessions', async () => {
      const result = await cmosSessionList({
        sprintId: 'nonexistent',
        projectRoot: testDb.tempDir,
      });
      const formatted = formatSessionListForLLM(result);

      expect(formatted).toContain('No sessions found');
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('session tools integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    // Clear existing sessions for clean integration tests
    testDb.db.exec(`DELETE FROM sessions`);
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should complete full session lifecycle: start -> capture -> complete -> list', async () => {
    // Start session
    const startResult = await cmosSessionStart({
      type: 'planning',
      title: 'Sprint 13 Planning',
      sprintId: 'sprint-13',
      projectRoot: testDb.tempDir,
    });
    expect(startResult.success).toBe(true);
    const sessionId = startResult.data?.sessionId;

    // Capture insights
    const capture1 = await cmosSessionCapture({
      category: 'decision',
      content: 'Focus on performance optimization',
      projectRoot: testDb.tempDir,
    });
    expect(capture1.success).toBe(true);

    const capture2 = await cmosSessionCapture({
      category: 'constraint',
      content: 'Must maintain backwards compatibility',
      projectRoot: testDb.tempDir,
    });
    expect(capture2.success).toBe(true);

    const capture3 = await cmosSessionCapture({
      category: 'next-step',
      content: 'Create benchmarks',
      projectRoot: testDb.tempDir,
    });
    expect(capture3.success).toBe(true);
    expect(capture3.data?.captureCount).toBe(3);

    // Complete session
    const completeResult = await cmosSessionComplete({
      summary: 'Sprint 13 planning complete. Focus on performance with backwards compat.',
      nextSteps: ['Setup benchmarks', 'Review API endpoints'],
      projectRoot: testDb.tempDir,
    });
    expect(completeResult.success).toBe(true);
    expect(completeResult.data?.captureCount).toBe(3);
    expect(completeResult.data?.capturesByCategory.decision).toBe(1);
    expect(completeResult.data?.capturesByCategory.constraint).toBe(1);
    expect(completeResult.data?.capturesByCategory['next-step']).toBe(1);

    // List sessions
    const listResult = await cmosSessionList({
      projectRoot: testDb.tempDir,
    });
    expect(listResult.success).toBe(true);
    expect(listResult.data?.sessions.length).toBe(1);

    const session = listResult.data?.sessions[0];
    expect(session?.id).toBe(sessionId);
    expect(session?.status).toBe('completed');
    expect(session?.captureCount).toBe(3);
  });

  it('should prevent starting second session while one is active', async () => {
    // Start first session
    const start1 = await cmosSessionStart({
      type: 'planning',
      title: 'First',
      projectRoot: testDb.tempDir,
    });
    expect(start1.success).toBe(true);

    // Try to start second
    const start2 = await cmosSessionStart({
      type: 'review',
      title: 'Second',
      projectRoot: testDb.tempDir,
    });
    expect(start2.success).toBe(false);
    expect(start2.error?.code).toBe(CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE);
  });

  it('should allow new session after completing previous', async () => {
    // Start and complete first session
    await cmosSessionStart({
      type: 'planning',
      title: 'First',
      projectRoot: testDb.tempDir,
    });
    await cmosSessionComplete({
      summary: 'Done',
      projectRoot: testDb.tempDir,
    });

    // Start second session
    const start2 = await cmosSessionStart({
      type: 'review',
      title: 'Second',
      projectRoot: testDb.tempDir,
    });
    expect(start2.success).toBe(true);
  });

  it('should track multiple sessions with different types', async () => {
    // Create several sessions
    for (const type of ['planning', 'review', 'research'] as const) {
      const start = await cmosSessionStart({
        type,
        title: `${type} session`,
        projectRoot: testDb.tempDir,
      });
      expect(start.success).toBe(true);

      await cmosSessionComplete({
        summary: `${type} complete`,
        projectRoot: testDb.tempDir,
      });
    }

    // List by type
    const planningList = await cmosSessionList({
      type: 'planning',
      projectRoot: testDb.tempDir,
    });
    expect(planningList.data?.totalCount).toBe(1);

    const allList = await cmosSessionList({
      projectRoot: testDb.tempDir,
    });
    expect(allList.data?.totalCount).toBe(3);
  });
});
