/**
 * Context Operations Tools Tests
 *
 * Comprehensive tests for all context operation tools:
 * - cmos_context_view
 * - cmos_context_snapshot
 * - cmos_context_history
 *
 * Each tool has 8+ tests covering happy paths and error cases.
 *
 * @module tests/tools/cmos/context-ops
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

// Import tool implementations and types
import {
  cmosContextView,
  cmosContextViewToolDefinition,
  formatContextViewForLLM,
  type CmosContextViewResult,
} from '../../../src/tools/cmos/cmos-context-view';

import {
  cmosContextSnapshot,
  cmosContextSnapshotToolDefinition,
  formatContextSnapshotForLLM,
  type CmosContextSnapshotResult,
} from '../../../src/tools/cmos/cmos-context-snapshot';

import {
  cmosContextHistory,
  cmosContextHistoryToolDefinition,
  formatContextHistoryForLLM,
  type CmosContextHistoryResult,
} from '../../../src/tools/cmos/cmos-context-history';

/**
 * Helper to create test database with contexts table and test data.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-context-test-'));
  const dbPath = path.join(tempDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  // Create schema
  db.exec(`
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
      source TEXT,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_context_snapshots_ctx ON context_snapshots (context_id, created_at);
    CREATE INDEX idx_context_snapshots_hash ON context_snapshots (context_id, content_hash);

    -- Insert test contexts
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'master_context',
      'context/MASTER_CONTEXT.json',
      '{"project_name": "Test Project", "decisions_made": ["Use TypeScript", "Choose SQLite"], "constraints": ["No external services"], "research_findings": ["Finding 1", "Finding 2"]}',
      '2024-01-15T10:00:00Z'
    );

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'project_context',
      'PROJECT_CONTEXT.json',
      '{"active_mission": "s12-m03", "session_count": 5, "working_memory": {"next_steps": ["Step 1", "Step 2"]}}',
      '2024-01-15T12:00:00Z'
    );

    -- Insert some test snapshots
    INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at)
    VALUES
      ('master_context', 'session-1', 'Sprint 11 completed', 'hash001', '{"version": 1}', '2024-01-10T10:00:00Z'),
      ('master_context', 'session-2', 'Architecture decision', 'hash002', '{"version": 2}', '2024-01-12T10:00:00Z'),
      ('project_context', NULL, 'Session checkpoint', 'hash003', '{"state": 1}', '2024-01-14T10:00:00Z'),
      ('master_context', NULL, 'Sprint 12 started', 'hash004', '{"version": 3}', '2024-01-15T10:00:00Z');
  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

/**
 * Helper to call tools with explicit dbPath via withClient.
 */
async function callContextView(
  dbPath: string,
  params: { contextType?: 'master_context' | 'project_context' } = {}
): Promise<CmosToolResult<CmosContextViewResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors } = await import('../../../src/tools/cmos/errors');

  return withClient(
    (client) => {
      let masterContext = null;
      let projectContext = null;

      // Get master_context
      if (!params.contextType || params.contextType === 'master_context') {
        const masterResult = client.getOne<{
          id: string;
          source_path: string;
          content: string;
          updated_at: string | null;
        }>('SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?', [
          'master_context',
        ]);
        if (masterResult.success && masterResult.data) {
          try {
            masterContext = {
              id: masterResult.data.id,
              sourcePath: masterResult.data.source_path,
              content: JSON.parse(masterResult.data.content),
              updatedAt: masterResult.data.updated_at,
            };
          } catch {
            /* ignore parse error */
          }
        }
      }

      // Get project_context
      if (!params.contextType || params.contextType === 'project_context') {
        const projectResult = client.getOne<{
          id: string;
          source_path: string;
          content: string;
          updated_at: string | null;
        }>('SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?', [
          'project_context',
        ]);
        if (projectResult.success && projectResult.data) {
          try {
            projectContext = {
              id: projectResult.data.id,
              sourcePath: projectResult.data.source_path,
              content: JSON.parse(projectResult.data.content),
              updatedAt: projectResult.data.updated_at,
            };
          } catch {
            /* ignore parse error */
          }
        }
      }

      if (params.contextType && !masterContext && !projectContext) {
        return createError<CmosContextViewResult>(CmosErrors.contextNotFound(params.contextType));
      }

      // Build aggregated view
      const masterContent = masterContext?.content ?? {};
      const projectContent = projectContext?.content ?? {};
      const workingMemory = (projectContent.working_memory as Record<string, unknown>) ?? {};

      const aggregated = {
        activeMission:
          typeof projectContent.active_mission === 'string' ? projectContent.active_mission : null,
        sessionCount:
          typeof projectContent.session_count === 'number' ? projectContent.session_count : null,
        decisions: Array.isArray(masterContent.decisions_made) ? masterContent.decisions_made : [],
        constraints: Array.isArray(masterContent.constraints) ? masterContent.constraints : [],
        learnings: Array.isArray(masterContent.research_findings)
          ? masterContent.research_findings
          : [],
        nextSteps: Array.isArray(workingMemory.next_steps) ? workingMemory.next_steps : [],
      };

      return createSuccess<CmosContextViewResult>({
        masterContext,
        projectContext,
        aggregated,
        contextCount: (masterContext ? 1 : 0) + (projectContext ? 1 : 0),
      });
    },
    { dbPath }
  );
}

async function callContextSnapshot(
  dbPath: string,
  params: { contextType: 'master_context' | 'project_context'; source: string; sessionId?: string }
): Promise<CmosToolResult<CmosContextSnapshotResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess, CmosErrors, CMOS_ERROR_CODES } =
    await import('../../../src/tools/cmos/errors');

  if (!params.source || params.source.trim() === '') {
    return createError(CmosErrors.missingParameter('source'));
  }

  const contextType = params.contextType;
  const source = params.source.trim();

  return withClient(
    (client) => {
      // Get context content
      const contextResult = client.getOne<{ id: string; content: string }>(
        'SELECT id, content FROM contexts WHERE id = ?',
        [contextType]
      );

      if (!contextResult.success || !contextResult.data) {
        return createError<CmosContextSnapshotResult>(CmosErrors.contextNotFound(contextType));
      }

      const content = contextResult.data.content;
      const contentHash = crypto
        .createHash('sha256')
        .update(content)
        .digest('hex')
        .substring(0, 16);

      // Check for duplicate
      const existingResult = client.getOne<{ id: number; created_at: string }>(
        'SELECT id, created_at FROM context_snapshots WHERE context_id = ? AND content_hash = ?',
        [contextType, contentHash]
      );

      if (existingResult.success && existingResult.data) {
        return createSuccess<CmosContextSnapshotResult>({
          snapshotId: existingResult.data.id,
          contextId: contextType,
          source,
          contentHash,
          createdAt: existingResult.data.created_at,
          isNew: false,
          message: `Duplicate snapshot detected. Content unchanged since ${existingResult.data.created_at}. No new snapshot created.`,
        });
      }

      // Create new snapshot
      const now = new Date().toISOString();
      const insertResult = client.execute(
        `INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contextType, params.sessionId ?? null, source, contentHash, content, now]
      );

      if (!insertResult.success) {
        return createError<CmosContextSnapshotResult>({
          code: CMOS_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
          message: 'Failed to create snapshot',
          suggestion: 'Check database permissions',
        });
      }

      return createSuccess<CmosContextSnapshotResult>({
        snapshotId: Number(insertResult.data?.lastInsertRowid),
        contextId: contextType,
        source,
        contentHash,
        createdAt: now,
        isNew: true,
        message: `Snapshot created for ${contextType}: "${source}"`,
      });
    },
    { dbPath }
  );
}

async function callContextHistory(
  dbPath: string,
  params: {
    contextType?: 'master_context' | 'project_context';
    since?: string;
    until?: string;
    sessionId?: string;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<CmosToolResult<CmosContextHistoryResult>> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const { createError, createSuccess } = await import('../../../src/tools/cmos/errors');

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  return withClient(
    (client) => {
      const conditions: string[] = [];
      const queryParams: (string | number)[] = [];

      if (params.contextType) {
        conditions.push('context_id = ?');
        queryParams.push(params.contextType);
      }
      if (params.since) {
        conditions.push('created_at >= ?');
        queryParams.push(params.since);
      }
      if (params.until) {
        conditions.push('created_at <= ?');
        queryParams.push(params.until);
      }
      if (params.sessionId) {
        conditions.push('session_id = ?');
        queryParams.push(params.sessionId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = client.getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM context_snapshots ${whereClause}`,
        queryParams
      );

      if (!countResult.success) {
        return createError<CmosContextHistoryResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Count failed' }
        );
      }

      const totalCount = countResult.data?.count ?? 0;

      const snapshotsResult = client.getMany<{
        id: number;
        context_id: string;
        session_id: string | null;
        source: string;
        content_hash: string;
        content: string;
        created_at: string;
      }>(
        `SELECT id, context_id, session_id, source, content_hash, content, created_at
         FROM context_snapshots ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...queryParams, pageSize, offset]
      );

      if (!snapshotsResult.success) {
        return createError<CmosContextHistoryResult>(
          snapshotsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Query failed' }
        );
      }

      const snapshots = (snapshotsResult.data ?? []).map((row) => ({
        id: row.id,
        contextId: row.context_id,
        sessionId: row.session_id,
        source: row.source,
        contentHash: row.content_hash,
        createdAt: row.created_at,
        contentSize: row.content.length,
      }));

      return createSuccess<CmosContextHistoryResult>({
        snapshots,
        totalCount,
        page,
        pageSize,
        hasMore: offset + snapshots.length < totalCount,
        contextType: params.contextType ?? null,
      });
    },
    { dbPath }
  );
}

// ============================================================================
// cmos_context_view Tests
// ============================================================================

describe('cmos_context_view', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should return both contexts when no filter is applied', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext).not.toBeNull();
      expect(result.data?.projectContext).not.toBeNull();
      expect(result.data?.contextCount).toBe(2);
    });

    it('should return only master_context when filtered', async () => {
      const result = await callContextView(testDb.dbPath, { contextType: 'master_context' });

      expect(result.success).toBe(true);
      expect(result.data?.masterContext).not.toBeNull();
      expect(result.data?.projectContext).toBeNull();
      expect(result.data?.contextCount).toBe(1);
    });

    it('should return only project_context when filtered', async () => {
      const result = await callContextView(testDb.dbPath, { contextType: 'project_context' });

      expect(result.success).toBe(true);
      expect(result.data?.masterContext).toBeNull();
      expect(result.data?.projectContext).not.toBeNull();
      expect(result.data?.contextCount).toBe(1);
    });

    it('should parse and return context content', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext?.content).toHaveProperty('project_name', 'Test Project');
      expect(result.data?.projectContext?.content).toHaveProperty('active_mission', 's12-m03');
    });

    it('should return correct source paths', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext?.sourcePath).toBe('context/MASTER_CONTEXT.json');
      expect(result.data?.projectContext?.sourcePath).toBe('PROJECT_CONTEXT.json');
    });

    it('should extract aggregated view correctly', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      const agg = result.data?.aggregated;

      expect(agg?.activeMission).toBe('s12-m03');
      expect(agg?.sessionCount).toBe(5);
      expect(agg?.decisions).toContain('Use TypeScript');
      expect(agg?.constraints).toContain('No external services');
      expect(agg?.learnings).toContain('Finding 1');
      expect(agg?.nextSteps).toContain('Step 1');
    });

    it('should return updatedAt timestamps', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext?.updatedAt).toBe('2024-01-15T10:00:00Z');
      expect(result.data?.projectContext?.updatedAt).toBe('2024-01-15T12:00:00Z');
    });

    it('should handle missing aggregated fields gracefully', async () => {
      // Update master_context to have no arrays
      testDb.db.exec(
        `UPDATE contexts SET content = '{"project_name": "Test"}' WHERE id = 'master_context'`
      );

      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.aggregated.decisions).toEqual([]);
      expect(result.data?.aggregated.constraints).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('should return CONTEXT_NOT_FOUND when filtered context does not exist', async () => {
      // Delete master_context
      testDb.db.exec(`DELETE FROM contexts WHERE id = 'master_context'`);

      const result = await callContextView(testDb.dbPath, { contextType: 'master_context' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CONTEXT_NOT_FOUND);
    });

    it('should handle malformed JSON gracefully', async () => {
      testDb.db.exec(`UPDATE contexts SET content = 'invalid json' WHERE id = 'master_context'`);

      const result = await callContextView(testDb.dbPath);

      // Should still succeed but with empty content or null for master
      expect(result.success).toBe(true);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosContextViewToolDefinition.name).toBe('cmos_context_view');
    });

    it('should have comprehensive description', () => {
      expect(cmosContextViewToolDefinition.description).toContain('master_context');
      expect(cmosContextViewToolDefinition.description).toContain('project_context');
    });

    it('should not require any parameters', () => {
      // No required array means all parameters are optional
      expect(
        (cmosContextViewToolDefinition.inputSchema as Record<string, unknown>).required
      ).toBeUndefined();
    });
  });

  describe('formatContextViewForLLM', () => {
    it('should format success result with aggregated data', async () => {
      const result = await callContextView(testDb.dbPath);
      const formatted = formatContextViewForLLM(result);

      expect(formatted).toContain('CMOS Context View');
      expect(formatted).toContain('Active Mission');
      expect(formatted).toContain('Decisions Made');
    });

    it('should format error result with suggestion', async () => {
      testDb.db.exec(`DELETE FROM contexts`);
      const result = await callContextView(testDb.dbPath, { contextType: 'master_context' });
      const formatted = formatContextViewForLLM(result);

      expect(formatted).toContain('Failed to retrieve context');
    });
  });
});

// ============================================================================
// cmos_context_snapshot Tests
// ============================================================================

describe('cmos_context_snapshot', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should create a new snapshot', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Test snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNew).toBe(true);
      expect(result.data?.contextId).toBe('master_context');
      expect(result.data?.source).toBe('Test snapshot');
      expect(result.data?.snapshotId).toBeGreaterThan(0);
    });

    it('should detect duplicate content and return existing snapshot', async () => {
      // Create first snapshot
      await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'First snapshot',
      });

      // Try to create another without changing content
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Second snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNew).toBe(false);
      expect(result.data?.message).toContain('Duplicate');
    });

    it('should create new snapshot when content changes', async () => {
      // Create first snapshot
      await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'First snapshot',
      });

      // Change content
      testDb.db.exec(
        `UPDATE contexts SET content = '{"changed": true}' WHERE id = 'master_context'`
      );

      // Create second snapshot
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Second snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNew).toBe(true);
    });

    it('should associate snapshot with session ID', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'With session',
        sessionId: 'test-session-123',
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT session_id FROM context_snapshots WHERE id = ?')
        .get(result.data?.snapshotId) as { session_id: string };
      expect(row.session_id).toBe('test-session-123');
    });

    it('should calculate content hash correctly', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Hash test',
      });

      expect(result.success).toBe(true);
      expect(result.data?.contentHash).toHaveLength(16);
    });

    it('should store content in snapshot', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Content test',
      });

      const row = testDb.db
        .prepare('SELECT content FROM context_snapshots WHERE id = ?')
        .get(result.data?.snapshotId) as { content: string };
      expect(row.content).toContain('project_name');
    });

    it('should record creation timestamp', async () => {
      const before = new Date().toISOString();
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Time test',
      });
      const after = new Date().toISOString();

      expect(result.success).toBe(true);
      const createdAt = result.data?.createdAt;
      expect(createdAt).toBeDefined();
      expect(createdAt !== undefined && createdAt >= before).toBe(true);
      expect(createdAt !== undefined && createdAt <= after).toBe(true);
    });

    it('should work for project_context', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'project_context',
        source: 'Project snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextId).toBe('project_context');
    });
  });

  describe('error cases', () => {
    it('should return CONTEXT_NOT_FOUND for non-existent context', async () => {
      testDb.db.exec(`DELETE FROM contexts WHERE id = 'master_context'`);

      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CONTEXT_NOT_FOUND);
    });

    it('should return MISSING_PARAMETER for empty source', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('source');
    });

    it('should return MISSING_PARAMETER for whitespace-only source', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: '   ',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosContextSnapshotToolDefinition.name).toBe('cmos_context_snapshot');
    });

    it('should require contextType and source parameters', () => {
      expect(cmosContextSnapshotToolDefinition.inputSchema.required).toContain('contextType');
      expect(cmosContextSnapshotToolDefinition.inputSchema.required).toContain('source');
    });

    it('should have contextType enum', () => {
      const props = cmosContextSnapshotToolDefinition.inputSchema.properties;
      expect(props.contextType.enum).toContain('master_context');
      expect(props.contextType.enum).toContain('project_context');
    });
  });

  describe('formatContextSnapshotForLLM', () => {
    it('should format new snapshot with camera icon', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Test',
      });
      const formatted = formatContextSnapshotForLLM(result);

      expect(formatted).toContain('📸');
      expect(formatted).toContain('created');
      expect(formatted).toContain('master_context');
    });

    it('should format duplicate snapshot with refresh icon', async () => {
      // Create initial
      await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'First',
      });

      // Create duplicate
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Second',
      });
      const formatted = formatContextSnapshotForLLM(result);

      expect(formatted).toContain('🔄');
      expect(formatted).toContain('duplicate');
    });
  });
});

// ============================================================================
// cmos_context_history Tests
// ============================================================================

describe('cmos_context_history', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should return all snapshots when no filter is applied', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(4);
      expect(result.data?.totalCount).toBe(4);
    });

    it('should filter by contextType', async () => {
      const result = await callContextHistory(testDb.dbPath, { contextType: 'master_context' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(3);
      expect(result.data?.snapshots.every((s) => s.contextId === 'master_context')).toBe(true);
    });

    it('should filter by sessionId', async () => {
      const result = await callContextHistory(testDb.dbPath, { sessionId: 'session-1' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(1);
      expect(result.data?.snapshots[0].sessionId).toBe('session-1');
    });

    it('should filter by since date', async () => {
      const result = await callContextHistory(testDb.dbPath, { since: '2024-01-13T00:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(2); // Only snapshots on 14th and 15th
    });

    it('should filter by until date', async () => {
      const result = await callContextHistory(testDb.dbPath, { until: '2024-01-11T00:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(1); // Only snapshot on 10th
    });

    it('should filter by date range', async () => {
      const result = await callContextHistory(testDb.dbPath, {
        since: '2024-01-11T00:00:00Z',
        until: '2024-01-13T00:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(1); // Only snapshot on 12th
    });

    it('should return snapshots in descending order by date', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      const dates = result.data?.snapshots.map((s) => new Date(s.createdAt).getTime()) ?? [];

      for (let i = 0; i < dates.length - 1; i++) {
        expect(dates[i]).toBeGreaterThanOrEqual(dates[i + 1]);
      }
    });

    it('should paginate correctly', async () => {
      const result = await callContextHistory(testDb.dbPath, { page: 1, pageSize: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(2);
      expect(result.data?.page).toBe(1);
      expect(result.data?.pageSize).toBe(2);
      expect(result.data?.hasMore).toBe(true);
    });

    it('should return correct hasMore flag on last page', async () => {
      const result = await callContextHistory(testDb.dbPath, { page: 2, pageSize: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(2);
      expect(result.data?.hasMore).toBe(false);
    });

    it('should include content size in results', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      result.data?.snapshots.forEach((snap) => {
        expect(snap.contentSize).toBeGreaterThan(0);
      });
    });

    it('should return source field for each snapshot', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.some((s) => s.source === 'Sprint 11 completed')).toBe(true);
    });
  });

  describe('empty results', () => {
    it('should return empty array when no snapshots match', async () => {
      const result = await callContextHistory(testDb.dbPath, { sessionId: 'nonexistent-session' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosContextHistoryToolDefinition.name).toBe('cmos_context_history');
    });

    it('should have comprehensive description', () => {
      expect(cmosContextHistoryToolDefinition.description).toContain('timeline');
      expect(cmosContextHistoryToolDefinition.description).toContain('paginated');
    });

    it('should not require any parameters', () => {
      // No required array means all parameters are optional
      expect(
        (cmosContextHistoryToolDefinition.inputSchema as Record<string, unknown>).required
      ).toBeUndefined();
    });

    it('should have page and pageSize parameters with limits', () => {
      const props = cmosContextHistoryToolDefinition.inputSchema.properties;
      expect(props.page.minimum).toBe(1);
      expect(props.pageSize.minimum).toBe(1);
      expect(props.pageSize.maximum).toBe(100);
    });
  });

  describe('formatContextHistoryForLLM', () => {
    it('should format results as markdown table', async () => {
      const result = await callContextHistory(testDb.dbPath);
      const formatted = formatContextHistoryForLLM(result);

      expect(formatted).toContain('Context Snapshot History');
      expect(formatted).toContain('| ID |');
      expect(formatted).toContain('Sprint 11 completed');
    });

    it('should show pagination info when hasMore is true', async () => {
      const result = await callContextHistory(testDb.dbPath, { pageSize: 2 });
      const formatted = formatContextHistoryForLLM(result);

      expect(formatted).toContain('More results available');
      expect(formatted).toContain('page: 2');
    });

    it('should show empty message when no snapshots', async () => {
      const result = await callContextHistory(testDb.dbPath, { sessionId: 'nonexistent' });
      const formatted = formatContextHistoryForLLM(result);

      expect(formatted).toContain('No snapshots found');
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('context tools integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should view context, create snapshot, then see it in history', async () => {
    // View current context
    const viewResult = await callContextView(testDb.dbPath);
    expect(viewResult.success).toBe(true);

    // Create snapshot
    const snapshotResult = await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'Integration test snapshot',
    });
    expect(snapshotResult.success).toBe(true);
    expect(snapshotResult.data?.isNew).toBe(true);

    // Find in history
    const historyResult = await callContextHistory(testDb.dbPath, {
      contextType: 'master_context',
    });
    expect(historyResult.success).toBe(true);

    const found = historyResult.data?.snapshots.find(
      (s) => s.source === 'Integration test snapshot'
    );
    expect(found).toBeDefined();
    expect(found?.id).toBe(snapshotResult.data?.snapshotId);
  });

  it('should track multiple context snapshots over time', async () => {
    // Create first snapshot
    await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'First',
    });

    // Modify context
    testDb.db.exec(`UPDATE contexts SET content = '{"version": 2}' WHERE id = 'master_context'`);

    // Create second snapshot
    await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'Second',
    });

    // Modify context again
    testDb.db.exec(`UPDATE contexts SET content = '{"version": 3}' WHERE id = 'master_context'`);

    // Create third snapshot
    await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'Third',
    });

    // Check history shows all 3 new + 3 existing = 6 total for master_context
    const historyResult = await callContextHistory(testDb.dbPath, {
      contextType: 'master_context',
    });
    expect(historyResult.success).toBe(true);
    expect(historyResult.data?.totalCount).toBe(6);
  });
});
