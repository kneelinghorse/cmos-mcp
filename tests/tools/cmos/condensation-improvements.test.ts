/**
 * Condensation Improvements Tests (Sprint 40, Mission 04)
 *
 * Tests the new condensation rules added to fill coverage gaps:
 * 1. context_notes limiting in aggressive mode
 * 2. learnings limiting in aggressive mode
 * 3. archived_sprint_summaries trimming
 * 4. constraints JSON cleanup (table-backed removal)
 * 5. Condensation headroom suggested action in onboard
 *
 * @module tests/tools/cmos/condensation-improvements
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosContextCondense,
  type CmosContextCondenseResult,
} from '../../../src/tools/cmos/cmos-context-condense';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

function createTestDb(masterContent: Record<string, unknown>): {
  tempDir: string;
  dbPath: string;
  db: Database.Database;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-condense-improve-'));
  const dbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
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
      created_at TEXT NOT NULL,
      FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_context_snapshots_ctx ON context_snapshots (context_id, created_at);
    CREATE INDEX idx_context_snapshots_hash ON context_snapshots (context_id, content_hash);

    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT,
      focus TEXT,
      status TEXT,
      start_date TEXT,
      end_date TEXT
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Queued',
      sprint_id TEXT REFERENCES sprints(id)
    );

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT INTO metadata (key, value) VALUES ('project_domain', 'test');
  `);

  // Seed sprints so condensation has sprint context
  db.exec(`
    INSERT INTO sprints (id, title, status, start_date)
    VALUES
      ('sprint-1', 'Sprint 1', 'Completed', '2025-01-01'),
      ('sprint-2', 'Sprint 2', 'Completed', '2025-02-01'),
      ('sprint-3', 'Sprint 3', 'Completed', '2025-03-01'),
      ('sprint-4', 'Sprint 4', 'Completed', '2025-04-01'),
      ('sprint-5', 'Sprint 5', 'Active', '2025-05-01');
  `);

  const contentStr = JSON.stringify(masterContent);
  db.exec(`
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES ('master_context', 'context/MASTER_CONTEXT.json', '${contentStr.replace(/'/g, "''")}', '2025-05-01T00:00:00Z');
  `);

  return { tempDir, dbPath, db };
}

function cleanup(testDb: { tempDir: string; db: Database.Database }): void {
  testDb.db.close();
  fs.rmSync(testDb.tempDir, { recursive: true, force: true });
}

describe('condensation improvements (s40-m04)', () => {
  afterEach(() => {
    CmosDetector.resetInstance();
  });

  describe('context_notes limiting', () => {
    it('should limit context_notes to 15 in aggressive mode', async () => {
      // Create 25 context notes
      const notes = Array.from(
        { length: 25 },
        (_, i) =>
          `Context note #${i + 1}: Some relevant information about the project state and requirements.`
      );

      const testDb = createTestDb({
        decisions_made: [],
        learnings: [],
        constraints: [],
        context_notes: notes,
        recent_sessions: [],
      });

      CmosDetector.resetInstance();

      const result = await cmosContextCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
        targetSizePercent: 1, // Very low target to force all rules to fire
        dryRun: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as CmosContextCondenseResult;

      // Verify context_notes was condensed
      const notesSection = data.sectionsCondensed.find((s) => s.section === 'context_notes');
      expect(notesSection).toBeDefined();
      expect(notesSection?.action).toContain('Limited to last 15');

      // Verify in DB
      const ctx = testDb.db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      const parsed = JSON.parse(ctx.content);
      expect(parsed.context_notes.length).toBeLessThanOrEqual(15);

      cleanup(testDb);
    });

    it('should not touch context_notes in auto mode', async () => {
      const notes = Array.from({ length: 25 }, (_, i) => `Note ${i}`);

      const testDb = createTestDb({
        decisions_made: [],
        learnings: [],
        constraints: [],
        context_notes: notes,
        recent_sessions: [],
      });

      CmosDetector.resetInstance();

      const result = await cmosContextCondense({
        contextType: 'master_context',
        strategy: 'auto',
        targetSizePercent: 1,
        dryRun: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as CmosContextCondenseResult;

      // context_notes should NOT be condensed in auto mode
      const notesSection = data.sectionsCondensed.find(
        (s) => s.section === 'context_notes' && s.action.includes('Limited to last')
      );
      expect(notesSection).toBeUndefined();

      cleanup(testDb);
    });
  });

  describe('learnings limiting', () => {
    it('learnings are no longer stored in the blob — condense ignores them (Sprint 51)', async () => {
      // learnings moved to learnings table in Sprint 51. Condense should not touch blob learnings.
      const learnings = Array.from({ length: 30 }, (_, i) => `Learning #${i + 1}`);

      const testDb = createTestDb({
        decisions_made: [],
        learnings,
        constraints: [],
        context_notes: [],
        recent_sessions: [],
      });

      CmosDetector.resetInstance();

      const result = await cmosContextCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
        targetSizePercent: 1,
        dryRun: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as CmosContextCondenseResult;

      // Condense should NOT have touched learnings
      const learningsSection = data.sectionsCondensed.find((s) => s.section === 'learnings');
      expect(learningsSection).toBeUndefined();

      const ctx = testDb.db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      const parsed = JSON.parse(ctx.content);
      expect(parsed.learnings.length).toBe(30); // Untouched

      cleanup(testDb);
    });
  });

  describe('archived_sprint_summaries trimming', () => {
    it('should limit archived_sprint_summaries to 5 in aggressive mode', async () => {
      const summaries = Array.from({ length: 10 }, (_, i) => ({
        sprint_id: `sprint-old-${i}`,
        archived_at: '2025-01-01T00:00:00Z',
        snapshot_id: i,
        detail_counts: { session_history: 5, recent_sessions: 3, next_steps: 2, total: 10 },
        summary: 'Archived sprint detail preserved in snapshot.',
      }));

      const testDb = createTestDb({
        decisions_made: [],
        learnings: [],
        constraints: [],
        context_notes: [],
        recent_sessions: [],
        archived_sprint_summaries: summaries,
      });

      CmosDetector.resetInstance();

      const result = await cmosContextCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
        targetSizePercent: 1,
        dryRun: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as CmosContextCondenseResult;

      const archiveSection = data.sectionsCondensed.find(
        (s) => s.section === 'archived_sprint_summaries'
      );
      expect(archiveSection).toBeDefined();

      const ctx = testDb.db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      const parsed = JSON.parse(ctx.content);
      expect(parsed.archived_sprint_summaries.length).toBeLessThanOrEqual(5);

      cleanup(testDb);
    });
  });

  describe('constraints JSON cleanup', () => {
    it('should clear constraints from JSON when backed by table', async () => {
      const testDb = createTestDb({
        decisions_made: [],
        learnings: [],
        constraints: [
          'Must support PostgreSQL 14+',
          'No external API calls in tests',
          'Deploy to AWS only',
        ],
        context_notes: [],
        recent_sessions: [],
      });

      // Create the constraints table and seed it
      testDb.db.exec(`
        CREATE TABLE IF NOT EXISTS constraints (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          session_id TEXT,
          sprint_id TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          archived_at TEXT,
          content_hash TEXT
        );

        INSERT INTO constraints (content, status, created_at, content_hash)
        VALUES
          ('Must support PostgreSQL 14+', 'active', '2025-05-01T00:00:00Z', 'h1'),
          ('No external API calls in tests', 'active', '2025-05-01T00:00:00Z', 'h2');
      `);

      CmosDetector.resetInstance();

      const result = await cmosContextCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
        targetSizePercent: 1,
        dryRun: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as CmosContextCondenseResult;

      const constraintSection = data.sectionsCondensed.find((s) => s.section === 'constraints');
      expect(constraintSection).toBeDefined();
      expect(constraintSection?.action).toContain('Cleared JSON constraints');
      expect(constraintSection?.action).toContain('backed by constraints table');

      // Verify JSON constraints are empty
      const ctx = testDb.db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as { content: string };
      const parsed = JSON.parse(ctx.content);
      expect(parsed.constraints).toEqual([]);

      // Verify table constraints are untouched
      const tableCount = testDb.db.prepare('SELECT COUNT(*) AS c FROM constraints').get() as {
        c: number;
      };
      expect(tableCount.c).toBe(2);

      cleanup(testDb);
    });

    it('should not clear constraints JSON when no table exists', async () => {
      const testDb = createTestDb({
        decisions_made: [],
        learnings: [],
        constraints: ['Must support PostgreSQL 14+'],
        context_notes: [],
        recent_sessions: [],
      });

      CmosDetector.resetInstance();

      const result = await cmosContextCondense({
        contextType: 'master_context',
        strategy: 'aggressive',
        targetSizePercent: 1,
        dryRun: false,
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as CmosContextCondenseResult;

      // No constraint cleanup should have happened
      const constraintSection = data.sectionsCondensed.find(
        (s) => s.section === 'constraints' && s.action.includes('Cleared')
      );
      expect(constraintSection).toBeUndefined();

      cleanup(testDb);
    });
  });
});
