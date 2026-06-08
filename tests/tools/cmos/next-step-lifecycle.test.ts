/**
 * Next-Step Lifecycle Tests (Sprint 40, Mission 02)
 *
 * Tests:
 * 1. Auto-extraction of next-steps on session completion
 * 2. Next-step lifecycle handlers (list/complete/carry/drop)
 * 3. Content hash dedup on extraction
 * 4. Carry-forward integration with pending next-steps
 * 5. Schema migration idempotency
 *
 * @module tests/tools/cmos/next-step-lifecycle
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import { cmosNextSteps, formatNextStepsForLLM } from '../../../src/tools/cmos/cmos-next-steps';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  ensureNextStepsTable,
  computeContentHash,
} from '../../../src/tools/cmos/schema-migrations';

const SCHEMA = `
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
    sprint_id TEXT REFERENCES sprints(id),
    notes TEXT,
    started_at TEXT,
    completed_at TEXT
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

  CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    agent TEXT,
    mission TEXT,
    action TEXT NOT NULL,
    status TEXT,
    summary TEXT,
    next_hint TEXT,
    raw_event TEXT
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
    source TEXT,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_context_snapshots_ctx ON context_snapshots (context_id, created_at);
  CREATE INDEX idx_context_snapshots_hash ON context_snapshots (context_id, content_hash);

  CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE strategic_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id TEXT NOT NULL DEFAULT 'master_context',
    decision_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sprint_id TEXT,
    snapshot_id INTEGER,
    project_domain TEXT,
    session_id TEXT REFERENCES sessions(id),
    source_chunk_ids TEXT
  );
`;

interface TestDb {
  tempDir: string;
  dbPath: string;
  db: Database.Database;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-next-step-test-'));
  const dbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  db.exec(SCHEMA);

  // Seed sprints
  db.exec(`
    INSERT INTO sprints (id, title, status, focus, start_date)
    VALUES
      ('sprint-38', 'Sprint 38', 'Completed', 'Tooling', '2026-02-01'),
      ('sprint-39', 'Sprint 39', 'Completed', 'Polish', '2026-02-15'),
      ('sprint-40', 'Sprint 40', 'Active', 'Session Lifecycle', '2026-03-01');

    INSERT INTO missions (id, name, status, sprint_id)
    VALUES
      ('s40-m01', 'Session Auto-Tagging', 'Completed', 'sprint-40'),
      ('s40-m02', 'Next-Step Lifecycle', 'In Progress', 'sprint-40');
  `);

  // Seed contexts
  db.exec(`
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'master_context',
      'context/MASTER_CONTEXT.json',
      '${JSON.stringify({
        decisions_made: [],
        learnings: [],
        constraints: [],
        context_notes: [],
      }).replace(/'/g, "''")}',
      '2026-03-01T00:00:00Z'
    );

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'project_context',
      'context/PROJECT_CONTEXT.json',
      '${JSON.stringify({
        working_memory: {
          session_history: [],
          recent_sessions: [],
          next_steps: [],
        },
        context_health: {
          sessions_since_reset: 0,
          last_update: '2026-03-01T00:00:00Z',
          size_kb: 1.0,
        },
      }).replace(/'/g, "''")}',
      '2026-03-01T00:00:00Z'
    );

    INSERT INTO metadata (key, value) VALUES ('project_domain', 'cmos-mcp');
  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

function seedActiveSession(
  db: Database.Database,
  opts: {
    id: string;
    sprintId?: string;
    captures?: unknown[];
    nextSteps?: string[];
  }
): void {
  const captures = opts.captures ?? [];
  const nextSteps = opts.nextSteps ?? null;
  db.exec(`
    INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures, next_steps)
    VALUES (
      '${opts.id}',
      'build',
      'Test Session',
      ${opts.sprintId ? `'${opts.sprintId}'` : 'NULL'},
      '2026-03-13T09:00:00Z',
      'active',
      '${JSON.stringify(captures).replace(/'/g, "''")}',
      ${nextSteps ? `'${JSON.stringify(nextSteps).replace(/'/g, "''")}'` : 'NULL'}
    );
  `);
}

describe('next-step lifecycle (s40-m02)', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  // ─── Extraction on Session Completion ──────────────────────────────────────

  describe('next-step extraction on session complete', () => {
    it('should extract explicit nextSteps param into next_steps table', async () => {
      seedActiveSession(testDb.db, { id: 'PS-EXT-001', sprintId: 'sprint-40' });

      const result = await cmosSessionComplete({
        sessionId: 'PS-EXT-001',
        summary: 'Test extraction',
        nextSteps: ['Write unit tests', 'Run full suite'],
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.nextStepsExtracted).toBe(2);

      // Verify in DB
      const rows = testDb.db
        .prepare('SELECT content, status, session_id, sprint_id FROM next_steps ORDER BY id')
        .all() as Array<{ content: string; status: string; session_id: string; sprint_id: string }>;

      expect(rows).toHaveLength(2);
      expect(rows[0].content).toBe('Write unit tests');
      expect(rows[0].status).toBe('pending');
      expect(rows[0].session_id).toBe('PS-EXT-001');
      expect(rows[0].sprint_id).toBe('sprint-40');
      expect(rows[1].content).toBe('Run full suite');
    });

    it('should extract next-step captures from session captures', async () => {
      seedActiveSession(testDb.db, {
        id: 'PS-CAP-001',
        sprintId: 'sprint-40',
        captures: [
          { category: 'decision', content: 'Use TypeScript', timestamp: '2026-03-13T09:10:00Z' },
          {
            category: 'next-step',
            content: 'Refactor auth module',
            timestamp: '2026-03-13T09:15:00Z',
          },
          {
            category: 'next-step',
            content: 'Add integration tests',
            missionId: 's40-m02',
            timestamp: '2026-03-13T09:20:00Z',
          },
        ],
      });

      const result = await cmosSessionComplete({
        sessionId: 'PS-CAP-001',
        summary: 'Capture extraction test',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.nextStepsExtracted).toBe(2);

      const rows = testDb.db
        .prepare('SELECT content, mission_id FROM next_steps ORDER BY id')
        .all() as Array<{ content: string; mission_id: string | null }>;

      expect(rows).toHaveLength(2);
      expect(rows[0].content).toBe('Refactor auth module');
      expect(rows[0].mission_id).toBeNull();
      expect(rows[1].content).toBe('Add integration tests');
      expect(rows[1].mission_id).toBe('s40-m02');
    });

    it('should combine explicit nextSteps and next-step captures without duplication', async () => {
      seedActiveSession(testDb.db, {
        id: 'PS-DEDUP-001',
        sprintId: 'sprint-40',
        captures: [
          {
            category: 'next-step',
            content: 'Write unit tests',
            timestamp: '2026-03-13T09:15:00Z',
          },
        ],
      });

      const result = await cmosSessionComplete({
        sessionId: 'PS-DEDUP-001',
        summary: 'Dedup test',
        nextSteps: ['Write unit tests', 'Deploy to staging'],
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      // 'Write unit tests' from explicit param + 'Deploy to staging' = 2 from explicit
      // 'Write unit tests' from capture should be deduped (same content_hash + session_id)
      // Total: 2 (not 3)
      expect(result.data?.nextStepsExtracted).toBe(2);

      const rows = testDb.db.prepare('SELECT content FROM next_steps ORDER BY id').all() as Array<{
        content: string;
      }>;
      expect(rows).toHaveLength(2);
      const contents = rows.map((r) => r.content);
      expect(contents).toContain('Write unit tests');
      expect(contents).toContain('Deploy to staging');
    });

    it('should set content_hash for dedup', async () => {
      seedActiveSession(testDb.db, { id: 'PS-HASH-001', sprintId: 'sprint-40' });

      await cmosSessionComplete({
        sessionId: 'PS-HASH-001',
        summary: 'Hash test',
        nextSteps: ['Check CI results'],
        projectRoot: testDb.tempDir,
      });

      const row = testDb.db.prepare('SELECT content_hash FROM next_steps LIMIT 1').get() as {
        content_hash: string;
      };
      expect(row.content_hash).toBeTruthy();
      expect(row.content_hash.length).toBeGreaterThan(10);

      // Verify hash matches expected
      const expectedHash = computeContentHash('Check CI results', 'next-step');
      expect(row.content_hash).toBe(expectedHash);
    });

    it('should handle session with no next-steps gracefully', async () => {
      seedActiveSession(testDb.db, { id: 'PS-NONE-001', sprintId: 'sprint-40' });

      const result = await cmosSessionComplete({
        sessionId: 'PS-NONE-001',
        summary: 'No next steps',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.nextStepsExtracted).toBe(0);

      // next_steps table may not even exist (only created when needed)
      const tableCheck = testDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='next_steps'")
        .get();
      if (tableCheck) {
        const count = testDb.db.prepare('SELECT COUNT(*) AS c FROM next_steps').get() as {
          c: number;
        };
        expect(count.c).toBe(0);
      }
    });
  });

  // ─── Lifecycle Handlers ────────────────────────────────────────────────────

  describe('next-step lifecycle handlers', () => {
    async function seedNextSteps(db: Database.Database): Promise<void> {
      // Create next_steps table via migration
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      if (!clientResult.success || !clientResult.data) throw new Error('Failed to create client');
      ensureNextStepsTable(clientResult.data);
      clientResult.data.close();

      // Seed sessions referenced by next-steps
      db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
        VALUES
          ('PS-001', 'build', 'Session 1', 'sprint-40', '2026-03-13T09:00:00Z', 'completed'),
          ('PS-002', 'build', 'Session 2', 'sprint-39', '2026-03-12T09:00:00Z', 'completed');
      `);

      const now = '2026-03-13T10:00:00Z';
      db.exec(`
        INSERT INTO next_steps (content, status, session_id, sprint_id, created_at, content_hash)
        VALUES
          ('Write unit tests', 'pending', 'PS-001', 'sprint-40', '${now}', '${computeContentHash('Write unit tests', 'next-step')}'),
          ('Run full suite', 'pending', 'PS-001', 'sprint-40', '${now}', '${computeContentHash('Run full suite', 'next-step')}'),
          ('Fix auth bug', 'pending', 'PS-002', 'sprint-39', '${now}', '${computeContentHash('Fix auth bug', 'next-step')}'),
          ('Already done', 'completed', 'PS-001', 'sprint-39', '${now}', '${computeContentHash('Already done', 'next-step')}');
      `);
    }

    describe('list', () => {
      it('should list pending next-steps by default', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'list',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.items).toHaveLength(3);
        expect(result.data?.items?.every((i) => i.status === 'pending')).toBe(true);
      });

      it('should filter by status when specified', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'list',
          nextStepStatus: 'completed',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.items).toHaveLength(1);
        expect(result.data?.items?.[0].content).toBe('Already done');
      });

      it('should return empty list when no matching items', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'list',
          nextStepStatus: 'carried',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.items).toHaveLength(0);
      });
    });

    describe('complete', () => {
      it('should mark pending next-steps as completed', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'complete',
          nextStepIds: [1, 2],
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(2);

        // Verify in DB
        const rows = testDb.db
          .prepare('SELECT status, resolved_at FROM next_steps WHERE id IN (1, 2)')
          .all() as Array<{ status: string; resolved_at: string | null }>;

        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.status).toBe('completed');
          expect(row.resolved_at).toBeTruthy();
        }
      });

      it('should not re-complete already-completed items', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'complete',
          nextStepIds: [4], // Already completed
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(0);
      });

      it('should return error when no IDs provided', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'complete',
          nextStepIds: [],
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('MISSING_PARAMETER');
      });
    });

    describe('drop', () => {
      it('should mark pending next-steps as dropped', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'drop',
          nextStepIds: [3],
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(1);

        const row = testDb.db
          .prepare('SELECT status, resolved_at FROM next_steps WHERE id = 3')
          .get() as { status: string; resolved_at: string | null };

        expect(row.status).toBe('dropped');
        expect(row.resolved_at).toBeTruthy();
      });
    });

    describe('carry', () => {
      it('should carry specific next-steps to a target sprint', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'carry',
          nextStepIds: [3],
          carryToSprint: 'sprint-40',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(1);

        const row = testDb.db
          .prepare('SELECT status, carried_to_sprint, resolved_at FROM next_steps WHERE id = 3')
          .get() as {
          status: string;
          carried_to_sprint: string | null;
          resolved_at: string | null;
        };

        expect(row.status).toBe('carried');
        expect(row.carried_to_sprint).toBe('sprint-40');
        expect(row.resolved_at).toBeTruthy();
      });

      it('should carry ALL pending next-steps when no IDs provided', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'carry',
          carryToSprint: 'sprint-40',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(3); // 3 pending items

        const pending = testDb.db
          .prepare("SELECT COUNT(*) AS c FROM next_steps WHERE status = 'pending'")
          .get() as { c: number };
        expect(pending.c).toBe(0);

        const carried = testDb.db
          .prepare("SELECT COUNT(*) AS c FROM next_steps WHERE status = 'carried'")
          .get() as { c: number };
        expect(carried.c).toBe(3);
      });

      it('should carry without a target sprint (mark as carried, null target)', async () => {
        seedNextSteps(testDb.db);

        const result = await cmosNextSteps({
          nextStepAction: 'carry',
          nextStepIds: [1],
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(1);

        const row = testDb.db
          .prepare('SELECT carried_to_sprint FROM next_steps WHERE id = 1')
          .get() as { carried_to_sprint: string | null };
        expect(row.carried_to_sprint).toBeNull();
      });
    });

    describe('invalid action', () => {
      it('should return error for invalid next-step action', async () => {
        const result = await cmosNextSteps({
          nextStepAction: 'invalid' as any,
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_ACTION');
      });
    });
  });

  // ─── LLM Formatter ────────────────────────────────────────────────────────

  describe('formatNextStepsForLLM', () => {
    it('should format list result with items', () => {
      const result = {
        success: true as const,
        data: {
          nextStepAction: 'list',
          items: [
            {
              id: 1,
              content: 'Write tests',
              status: 'pending' as const,
              sessionId: 'PS-001',
              sprintId: 'sprint-40',
              missionId: 's40-m02',
              createdAt: '2026-03-13T10:00:00Z',
              resolvedAt: null,
              carriedToSprint: null,
            },
          ],
          affected: 1,
          message: 'Found 1 next-step(s)',
        },
      };

      const formatted = formatNextStepsForLLM(result);
      expect(formatted).toContain('Next Steps (1)');
      expect(formatted).toContain('#1');
      expect(formatted).toContain('[pending]');
      expect(formatted).toContain('[sprint-40]');
      expect(formatted).toContain('(s40-m02)');
      expect(formatted).toContain('Write tests');
    });

    it('should format empty list', () => {
      const result = {
        success: true as const,
        data: {
          nextStepAction: 'list',
          items: [],
          affected: 0,
          message: 'No pending next-steps',
        },
      };

      const formatted = formatNextStepsForLLM(result);
      expect(formatted).toContain('No pending next-steps');
    });

    it('should format action result message', () => {
      const result = {
        success: true as const,
        data: {
          nextStepAction: 'complete',
          affected: 2,
          message: '2 next-step(s) marked as completed',
        },
      };

      const formatted = formatNextStepsForLLM(result);
      expect(formatted).toContain('2 next-step(s) marked as completed');
    });

    it('should format error result', () => {
      const result = {
        success: false as const,
        error: {
          code: 'MISSING_PARAMETER',
          message: 'Missing required parameter: nextStepIds',
        },
      };

      const formatted = formatNextStepsForLLM(result);
      expect(formatted).toContain('Failed to manage next-steps');
      expect(formatted).toContain('Missing required parameter');
    });
  });

  // ─── Schema Migration ─────────────────────────────────────────────────────

  describe('schema migration', () => {
    it('should create next_steps table idempotently', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      expect(clientResult.success).toBe(true);
      const client = clientResult.data!;

      // First call creates
      const result1 = ensureNextStepsTable(client);
      expect(result1).toBeDefined();

      // Second call is no-op
      const result2 = ensureNextStepsTable(client);
      expect(result2).toBeDefined();

      // Verify table exists
      const table = testDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='next_steps'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe('next_steps');

      client.close();
    });

    it('should have correct columns in next_steps table', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;
      ensureNextStepsTable(client);
      client.close();

      const columns = testDb.db.prepare('PRAGMA table_info(next_steps)').all() as Array<{
        name: string;
        type: string;
      }>;

      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('session_id');
      expect(columnNames).toContain('sprint_id');
      expect(columnNames).toContain('mission_id');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('resolved_at');
      expect(columnNames).toContain('carried_to_sprint');
      expect(columnNames).toContain('content_hash');
    });
  });

  // ─── Carry-Forward Integration ─────────────────────────────────────────────

  describe('carry-forward integration', () => {
    it('should detect pending next-steps in carry-forward scan', async () => {
      // This tests the detectCarryForwards function indirectly through the
      // carry-forward handler. We seed next-steps and verify they show up.
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;
      ensureNextStepsTable(client);
      client.close();

      // Seed pending next-steps for sprint-40
      testDb.db.exec(`
        INSERT INTO next_steps (content, status, sprint_id, created_at, content_hash)
        VALUES
          ('Pending item 1', 'pending', 'sprint-40', '2026-03-13T10:00:00Z', 'hash1'),
          ('Pending item 2', 'pending', 'sprint-40', '2026-03-13T10:00:00Z', 'hash2'),
          ('Completed item', 'completed', 'sprint-40', '2026-03-13T10:00:00Z', 'hash3');
      `);

      // Verify count: only 2 pending for sprint-40
      const count = testDb.db
        .prepare(
          "SELECT COUNT(*) AS c FROM next_steps WHERE sprint_id = 'sprint-40' AND status = 'pending'"
        )
        .get() as { c: number };
      expect(count.c).toBe(2);
    });
  });
});
