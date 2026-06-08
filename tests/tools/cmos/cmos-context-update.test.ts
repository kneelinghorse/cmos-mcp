/**
 * cmos_context_update Tool Tests
 *
 * Tests for the context update/aggregation tool.
 *
 * @module tests/tools/cmos/cmos-context-update
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosContextUpdate,
  cmosContextUpdateToolDefinition,
  formatContextUpdateForLLM,
  type CmosContextUpdateResult,
  type CmosContextUpdateParams,
} from '../../../src/tools/cmos/cmos-context-update';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { withClient } from '../../../src/tools/cmos/client';

describe('cmos_context_update', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-context-update-test-'));
    // Create proper CMOS directory structure
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
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
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Insert initial master_context
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project":{"name":"Test Project"},"decisions_made":[],"learnings":[],"constraints":[]}',
        '2024-01-01T00:00:00Z'
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

  describe('empty sessions', () => {
    it('should return no updates when no completed sessions', async () => {
      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(0);
      expect(result.data?.totalItemsAdded).toBe(0);
      expect(result.data?.contextUpdated).toBe(false);
      expect(result.data?.message).toContain('No completed sessions');
    });

    it('should return no updates when sessions have no captures', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES ('s1', 'build', 'Empty Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed', '[]');
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(1);
      expect(result.data?.totalItemsAdded).toBe(0);
      expect(result.data?.contextUpdated).toBe(false);
    });
  });

  describe('session aggregation', () => {
    it('does not write decisions to blob (Sprint 51 blob reduction)', async () => {
      // Decisions are now table-driven (strategic_decisions), not blob-backed.
      // cmos_context_update aggregate mode only processes constraints for the blob.
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Decision Session',
          '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"decision","content":"Use TypeScript for all tools"},{"category":"decision","content":"Follow REST conventions"}]'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.decisionsAdded).toBe(0);
      // No constraints in session → blob unchanged
      expect(result.data?.contextUpdated).toBe(false);
    });

    it('does not write learnings to blob (Sprint 51 blob reduction)', async () => {
      // Learnings are now table-driven (learnings table), not blob-backed.
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Learning Session',
          '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"learning","content":"SQLite is fast for local queries"},{"category":"learning","content":"JSON parsing is expensive"}]'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.learningsAdded).toBe(0);
      expect(result.data?.contextUpdated).toBe(false);
    });

    it('should aggregate constraints from completed sessions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Constraint Session',
          '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"constraint","content":"Must support Node 18+"},{"category":"constraint","content":"No external dependencies"}]'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.constraintsAdded).toBe(2);
      expect(result.data?.contextUpdated).toBe(true);
    });

    it('should aggregate constraints from multiple sessions (decisions/learnings skipped)', async () => {
      // Only constraints go to blob; decisions and learnings are table-driven.
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES
          ('s1', 'build', 'Session 1', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
           '[{"category":"decision","content":"Decision 1"},{"category":"learning","content":"Learning 1"}]'),
          ('s2', 'build', 'Session 2', '2024-01-03T10:00:00Z', '2024-01-03T11:00:00Z', 'completed',
           '[{"category":"decision","content":"Decision 2"},{"category":"constraint","content":"Constraint 1"}]');
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(2);
      expect(result.data?.decisionsAdded).toBe(0);
      expect(result.data?.learningsAdded).toBe(0);
      expect(result.data?.constraintsAdded).toBe(1);
      expect(result.data?.totalItemsAdded).toBe(1);
    });
  });

  describe('since parameter', () => {
    it('should only process sessions after specified timestamp', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES
          ('s1', 'build', 'Old Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
           '[{"category":"constraint","content":"Old constraint"}]'),
          ('s2', 'build', 'New Session', '2024-01-05T10:00:00Z', '2024-01-05T11:00:00Z', 'completed',
           '[{"category":"constraint","content":"New constraint"}]');
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath, { since: '2024-01-04T00:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(1);
      expect(result.data?.constraintsAdded).toBe(1);
    });

    it('should use master_context updated_at as default since timestamp', async () => {
      const db = new Database(dbPath);
      // Update master_context to have a recent updated_at
      db.exec(`
        UPDATE contexts SET updated_at = '2024-01-03T00:00:00Z' WHERE id = 'master_context';

        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES
          ('s1', 'build', 'Old Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
           '[{"category":"constraint","content":"Old constraint"}]'),
          ('s2', 'build', 'New Session', '2024-01-05T10:00:00Z', '2024-01-05T11:00:00Z', 'completed',
           '[{"category":"constraint","content":"New constraint"}]');
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(1);
      expect(result.data?.constraintsAdded).toBe(1);
    });
  });

  describe('manual mode updates', () => {
    it('should add array entries to master_context in manual mode (constraints and context_notes only)', async () => {
      // decisions_made and learnings removed from arrayUpdates (Sprint 51 blob reduction).
      const result = await cmosContextUpdateWithDb(dbPath, {
        mode: 'manual',
        arrayUpdates: {
          constraints: ['Manual constraint'],
          context_notes: ['Manual note'],
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.mode).toBe('manual');
      expect(result.data?.contextType).toBe('master_context');
      expect(result.data?.decisionsAdded).toBe(0);
      expect(result.data?.learningsAdded).toBe(0);
      expect(result.data?.constraintsAdded).toBe(1);
      expect(result.data?.snapshotId).toBeDefined();

      const verifyDb = new Database(dbPath);
      const context = verifyDb
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      verifyDb.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.constraints).toContain('Manual constraint');
      expect(parsed.context_notes).toContain('Manual note');
    });

    it('should update arbitrary nested fields in master_context', async () => {
      const result = await cmosContextUpdateWithDb(dbPath, {
        mode: 'manual',
        fieldUpdates: [
          { path: 'project.name', value: 'Updated Project Name' },
          { path: 'project.status', value: 'active' },
          { path: 'technical_foundation.stack', value: ['TypeScript', 'SQLite'] },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextUpdated).toBe(true);
      expect(result.data?.fieldsUpdated).toEqual(
        expect.arrayContaining(['project.name', 'project.status', 'technical_foundation.stack'])
      );

      const verifyDb = new Database(dbPath);
      const context = verifyDb
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      verifyDb.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.project.name).toBe('Updated Project Name');
      expect(parsed.project.status).toBe('active');
      expect(parsed.technical_foundation.stack).toEqual(['TypeScript', 'SQLite']);
    });

    it('should update nested fields in project_context', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES (
          'project_context',
          'context/PROJECT_CONTEXT.json',
          '{"active_mission":"s17-m02","context_health":{"stale_threshold_hours":24}}',
          '2024-01-01T00:00:00Z'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath, {
        mode: 'manual',
        contextType: 'project_context',
        fieldUpdates: [
          { path: 'active_mission', value: 's17-m03' },
          { path: 'context_health.stale_threshold_hours', value: 12 },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextType).toBe('project_context');
      expect(result.data?.snapshotId).toBeDefined();

      const verifyDb = new Database(dbPath);
      const context = verifyDb
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('project_context') as { content: string };
      verifyDb.close();

      const parsed = JSON.parse(context.content);
      expect(parsed.active_mission).toBe('s17-m03');
      expect(parsed.context_health.stale_threshold_hours).toBe(12);
    });

    it('should reject manual mode with no updates', async () => {
      const result = await cmosContextUpdateWithDb(dbPath, { mode: 'manual' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('requires arrayUpdates and/or fieldUpdates');
    });

    it('should reject invalid nested paths in manual mode', async () => {
      const result = await cmosContextUpdateWithDb(dbPath, {
        mode: 'manual',
        fieldUpdates: [{ path: '__proto__.polluted', value: 'bad' }],
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('Unsafe field path');
    });
  });

  describe('snapshot creation', () => {
    it('should create snapshot after update', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Session 1', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"constraint","content":"Test constraint"}]'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.snapshotId).toBeDefined();
      expect(result.data?.snapshotId).toBeGreaterThan(0);

      // Verify snapshot was created
      const verifyDb = new Database(dbPath);
      const snapshot = verifyDb
        .prepare('SELECT * FROM context_snapshots WHERE id = ?')
        .get(result.data?.snapshotId) as { source: string; context_id: string };
      verifyDb.close();

      expect(snapshot.context_id).toBe('master_context');
      expect(snapshot.source).toContain('aggregated');
    });
  });

  describe('idempotency', () => {
    it('should not add duplicate constraints on second run', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Session 1', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"constraint","content":"Test constraint"}]'
        );
      `);
      db.close();

      // First run
      const result1 = await cmosContextUpdateWithDb(dbPath);
      expect(result1.success).toBe(true);
      expect(result1.data?.constraintsAdded).toBe(1);

      CmosDetector.resetInstance();

      // Second run - should not add duplicates
      const result2 = await cmosContextUpdateWithDb(dbPath, { since: '2024-01-01T00:00:00Z' });
      expect(result2.success).toBe(true);
      // Session still processed, but constraint already exists so not re-added
      expect(result2.data?.sessionsProcessed).toBe(1);

      // Verify context only has one constraint
      const verifyDb = new Database(dbPath);
      const context = verifyDb
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      verifyDb.close();

      const parsed = JSON.parse(context.content);
      const constraintCount = (parsed.constraints as string[]).filter(
        (c: string) => c === 'Test constraint'
      ).length;
      expect(constraintCount).toBe(1);
    });
  });

  describe('condensation and retention', () => {
    it('archives older completed sprint detail and preserves strategic arrays', async () => {
      const previousRetention = process.env.CMOS_CONTEXT_RETENTION_SPRINTS;
      const previousTargetSize = process.env.CMOS_CONTEXT_TARGET_SIZE_KB;
      process.env.CMOS_CONTEXT_RETENTION_SPRINTS = '1';
      process.env.CMOS_CONTEXT_TARGET_SIZE_KB = '30';

      try {
        const db = new Database(dbPath);
        db.exec(`
          INSERT INTO sprints (id, title, status, start_date, end_date) VALUES
            ('sprint-old', 'Old Sprint', 'Completed', '2024-01-01', '2024-01-07'),
            ('sprint-new', 'New Sprint', 'Completed', '2024-01-08', '2024-01-14');
        `);

        const insertSession = db.prepare(
          `INSERT INTO sessions (id, type, title, started_at, completed_at, status, sprint_id, captures)
           VALUES (?, 'review', 'Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed', ?, '[]')`
        );

        const oldRecentSessions: Array<Record<string, unknown>> = [];
        const newRecentSessions: Array<Record<string, unknown>> = [];
        const oldResumeNotes: string[] = [];

        for (let i = 0; i < 60; i += 1) {
          const sessionId = `old-${i}`;
          insertSession.run(sessionId, 'sprint-old');
          oldRecentSessions.push({
            id: sessionId,
            sprint_id: 'sprint-old',
            summary: `Old sprint detail ${'x'.repeat(600)}`,
            completed_at: '2024-01-02T11:00:00Z',
          });
          oldResumeNotes.push(`${sessionId}: ${'y'.repeat(200)}`);
        }

        for (let i = 0; i < 8; i += 1) {
          const sessionId = `new-${i}`;
          insertSession.run(sessionId, 'sprint-new');
          newRecentSessions.push({
            id: sessionId,
            sprint_id: 'sprint-new',
            summary: `New sprint detail ${'z'.repeat(80)}`,
            completed_at: '2024-01-09T11:00:00Z',
          });
        }

        const seededMaster = {
          project: { name: 'Retention Test' },
          decisions_made: ['Keep strategic decision'],
          learnings: ['Keep strategic learning'],
          constraints: ['Keep strategic constraint'],
          recent_sessions: [...oldRecentSessions, ...newRecentSessions],
          next_session_context: {
            when_we_resume: oldResumeNotes,
          },
          context_health: {
            size_limit_kb: 100,
            warning_threshold_percent: 75,
          },
        };

        db.prepare("UPDATE contexts SET content = ? WHERE id = 'master_context'").run(
          JSON.stringify(seededMaster)
        );
        db.close();

        const result = await cmosContextUpdateWithDb(dbPath, {
          mode: 'manual',
          fieldUpdates: [{ path: 'project.status', value: 'active' }],
        });

        expect(result.success).toBe(true);
        expect(result.data?.archivedSprintIds).toContain('sprint-old');
        expect(result.data?.archiveSnapshotId).not.toBeNull();
        expect(result.data?.contextSizeKb).toBeLessThan(30);

        const verifyDb = new Database(dbPath);
        const contextRow = verifyDb
          .prepare("SELECT content FROM contexts WHERE id = 'master_context'")
          .get() as { content: string };
        const archiveSnapshot = verifyDb
          .prepare('SELECT id, source FROM context_snapshots WHERE id = ?')
          .get(result.data?.archiveSnapshotId) as { id: number; source: string } | undefined;
        verifyDb.close();

        const parsed = JSON.parse(contextRow.content);
        expect(parsed.decisions_made).toContain('Keep strategic decision');
        expect(parsed.learnings).toContain('Keep strategic learning');
        expect(
          parsed.recent_sessions.every(
            (entry: { sprint_id?: string }) => entry.sprint_id !== 'sprint-old'
          )
        ).toBe(true);
        expect(parsed.archived_sprint_summaries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sprint_id: 'sprint-old',
            }),
          ])
        );
        expect(archiveSnapshot).toBeDefined();
        expect(archiveSnapshot?.source).toContain('context_update:manual:master_context');
      } finally {
        if (previousRetention === undefined) {
          delete process.env.CMOS_CONTEXT_RETENTION_SPRINTS;
        } else {
          process.env.CMOS_CONTEXT_RETENTION_SPRINTS = previousRetention;
        }

        if (previousTargetSize === undefined) {
          delete process.env.CMOS_CONTEXT_TARGET_SIZE_KB;
        } else {
          process.env.CMOS_CONTEXT_TARGET_SIZE_KB = previousTargetSize;
        }
      }
    });
  });

  describe('edge cases', () => {
    it('should handle malformed captures JSON gracefully', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES
          ('s1', 'build', 'Bad Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed', 'not valid json'),
          ('s2', 'build', 'Good Session', '2024-01-03T10:00:00Z', '2024-01-03T11:00:00Z', 'completed',
           '[{"category":"constraint","content":"Valid constraint"}]');
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(2);
      expect(result.data?.constraintsAdded).toBe(1); // Only from good session
    });

    it('should handle null captures gracefully', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES ('s1', 'build', 'Null Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed', NULL);
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(1);
      expect(result.data?.totalItemsAdded).toBe(0);
    });

    it('should skip non-completed sessions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES
          ('s1', 'build', 'Active Session', '2024-01-02T10:00:00Z', NULL, 'active',
           '[{"category":"constraint","content":"Active constraint"}]'),
          ('s2', 'build', 'Completed Session', '2024-01-03T10:00:00Z', '2024-01-03T11:00:00Z', 'completed',
           '[{"category":"constraint","content":"Completed constraint"}]');
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionsProcessed).toBe(1);
      expect(result.data?.constraintsAdded).toBe(1);
    });

    it('should ignore non-blob categories (decisions, learnings, context, next-step)', async () => {
      // Only constraints go to blob. decisions/learnings are table-driven; context/next-step go elsewhere.
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Mixed Session', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"decision","content":"A decision"},{"category":"context","content":"Some context"},{"category":"next-step","content":"Next step"}]'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.decisionsAdded).toBe(0);
      expect(result.data?.learningsAdded).toBe(0);
      expect(result.data?.constraintsAdded).toBe(0);
      expect(result.data?.totalItemsAdded).toBe(0);
    });

    it('should create master_context if it does not exist', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM contexts WHERE id = 'master_context';

        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures)
        VALUES (
          's1', 'build', 'Session 1', '2024-01-02T10:00:00Z', '2024-01-02T11:00:00Z', 'completed',
          '[{"category":"constraint","content":"Test constraint"}]'
        );
      `);
      db.close();

      const result = await cmosContextUpdateWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.contextUpdated).toBe(true);

      // Verify context was created
      const verifyDb = new Database(dbPath);
      const context = verifyDb
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string } | undefined;
      verifyDb.close();

      expect(context).toBeDefined();
      const parsed = JSON.parse(context!.content);
      expect(parsed.constraints).toContain('Test constraint');
    });
  });

  describe('error handling', () => {
    it('should return error when CMOS not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cmos-'));

      try {
        CmosDetector.resetInstance();
        const result = await cmosContextUpdate({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosContextUpdateToolDefinition.name).toBe('cmos_context_update');
    });

    it('should have description', () => {
      expect(cmosContextUpdateToolDefinition.description).toBeTruthy();
      expect(cmosContextUpdateToolDefinition.description.toLowerCase()).toContain('aggregate');
    });

    it('should have valid input schema', () => {
      expect(cmosContextUpdateToolDefinition.inputSchema.type).toBe('object');
    });
  });

  describe('formatContextUpdateForLLM', () => {
    it('should format success result with updates', () => {
      const result: CmosToolResult<CmosContextUpdateResult> = {
        success: true,
        data: {
          sessionsProcessed: 2,
          decisionsAdded: 3,
          learningsAdded: 2,
          constraintsAdded: 1,
          totalItemsAdded: 6,
          snapshotId: 42,
          lastSessionTimestamp: '2024-01-15T10:00:00Z',
          contextUpdated: true,
          message: 'Test message',
        },
      };

      const formatted = formatContextUpdateForLLM(result);

      expect(formatted).toContain('Context Updated');
      expect(formatted).toContain('Sessions processed');
      expect(formatted).toContain('Decisions: 3');
      expect(formatted).toContain('Learnings: 2');
      expect(formatted).toContain('Constraints: 1');
      expect(formatted).toContain('Snapshot');
      expect(formatted).toContain('#42');
    });

    it('should format result with no updates', () => {
      const result: CmosToolResult<CmosContextUpdateResult> = {
        success: true,
        data: {
          sessionsProcessed: 0,
          decisionsAdded: 0,
          learningsAdded: 0,
          constraintsAdded: 0,
          totalItemsAdded: 0,
          snapshotId: null,
          lastSessionTimestamp: null,
          contextUpdated: false,
          message: 'No completed sessions found',
        },
      };

      const formatted = formatContextUpdateForLLM(result);

      expect(formatted).toContain('Context Update');
      expect(formatted).toContain('No completed sessions');
    });

    it('should format error result', () => {
      const result: CmosToolResult<CmosContextUpdateResult> = {
        success: false,
        error: {
          code: 'TEST_ERROR',
          message: 'Test error message',
          suggestion: 'Test suggestion',
        },
      };

      const formatted = formatContextUpdateForLLM(result);

      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Test error message');
      expect(formatted).toContain('Test suggestion');
    });
  });
});

/**
 * Helper to run cmosContextUpdate with explicit database path.
 * Assumes dbPath is already in proper cmos/db/ structure.
 */
async function cmosContextUpdateWithDb(
  dbPath: string,
  params: Partial<CmosContextUpdateParams> = {}
): Promise<CmosToolResult<CmosContextUpdateResult>> {
  // dbPath should be in structure: tempDir/cmos/db/cmos.sqlite
  // So project root is 3 levels up from the file
  const dbDir = path.dirname(dbPath);
  const cmosDir = path.dirname(dbDir);
  const projectRoot = path.dirname(cmosDir);

  CmosDetector.resetInstance();

  return cmosContextUpdate({ ...params, projectRoot });
}
