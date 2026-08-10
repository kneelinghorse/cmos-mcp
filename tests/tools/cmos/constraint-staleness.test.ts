/**
 * Constraint Staleness Detection Tests (Sprint 40, Mission 03)
 *
 * Tests:
 * 1. Constraint extraction on capture
 * 2. Constraint extraction on session completion
 * 3. Staleness scoring (expired, age-based, no-expiry penalty)
 * 4. Lifecycle handlers (list/review/archive)
 * 5. Stale constraint count for onboard
 * 6. Schema migration idempotency
 *
 * @module tests/tools/cmos/constraint-staleness
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosSessionCapture } from '../../../src/tools/cmos/cmos-session-capture';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import {
  cmosConstraints,
  formatConstraintsForLLM,
  getStaleConstraintCount,
} from '../../../src/tools/cmos/cmos-constraints';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  ensureConstraintsTable,
  ensureConstraintReviewTimestamp,
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

  CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    sprint_id TEXT,
    session_id TEXT REFERENCES sessions(id),
    mission_id TEXT,
    created_at TEXT NOT NULL,
    content_hash TEXT
  );
`;

interface TestDb {
  tempDir: string;
  dbPath: string;
  db: Database.Database;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-constraint-test-'));
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

describe('constraint staleness (s40-m03)', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  // ─── Extraction on Capture ──────────────────────────────────────────────

  describe('constraint extraction on capture', () => {
    it('should extract constraint to constraints table', async () => {
      // Create active session
      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
        VALUES ('PS-CAP-001', 'build', 'Test', 'sprint-40', '2026-03-13T09:00:00Z', 'active');
      `);

      const result = await cmosSessionCapture({
        sessionId: 'PS-CAP-001',
        category: 'constraint',
        content: 'Must support PostgreSQL 14+',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.constraintExtracted).toBe(true);

      // Verify in DB
      const rows = testDb.db
        .prepare('SELECT content, status, sprint_id, content_hash FROM constraints')
        .all() as Array<{
        content: string;
        status: string;
        sprint_id: string;
        content_hash: string;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe('Must support PostgreSQL 14+');
      expect(rows[0].status).toBe('active');
      expect(rows[0].sprint_id).toBe('sprint-40');
      expect(rows[0].content_hash).toBeTruthy();
    });

    it('should support expiresAt on constraint capture', async () => {
      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
        VALUES ('PS-CAP-002', 'build', 'Test', 'sprint-40', '2026-03-13T09:00:00Z', 'active');
      `);

      const result = await cmosSessionCapture({
        sessionId: 'PS-CAP-002',
        category: 'constraint',
        content: 'Merge freeze until Thursday',
        expiresAt: '2026-03-20T00:00:00Z',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.constraintExtracted).toBe(true);

      const row = testDb.db.prepare('SELECT expires_at FROM constraints LIMIT 1').get() as {
        expires_at: string | null;
      };
      expect(row.expires_at).toBe('2026-03-20T00:00:00Z');
    });

    it('should deduplicate active constraints with same content', async () => {
      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
        VALUES ('PS-CAP-003', 'build', 'Test', 'sprint-40', '2026-03-13T09:00:00Z', 'active');
      `);

      await cmosSessionCapture({
        sessionId: 'PS-CAP-003',
        category: 'constraint',
        content: 'Must use HTTPS',
        projectRoot: testDb.tempDir,
      });

      const result2 = await cmosSessionCapture({
        sessionId: 'PS-CAP-003',
        category: 'constraint',
        content: 'Must use HTTPS',
        projectRoot: testDb.tempDir,
      });

      expect(result2.data?.constraintExtracted).toBe(false);

      const count = testDb.db.prepare('SELECT COUNT(*) AS c FROM constraints').get() as {
        c: number;
      };
      expect(count.c).toBe(1);
    });
  });

  // ─── Extraction on Session Completion ──────────────────────────────────

  describe('constraint extraction on session complete', () => {
    it('should extract constraint captures into constraints table', async () => {
      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES (
          'PS-COMP-001', 'build', 'Test', 'sprint-40', '2026-03-13T09:00:00Z', 'active',
          '${JSON.stringify([
            {
              category: 'constraint',
              content: 'Max 100MB uploads',
              timestamp: '2026-03-13T09:10:00Z',
            },
            {
              category: 'constraint',
              content: 'No external API calls in tests',
              timestamp: '2026-03-13T09:15:00Z',
            },
            { category: 'decision', content: 'Use TypeScript', timestamp: '2026-03-13T09:20:00Z' },
          ]).replace(/'/g, "''")}'
        );
      `);

      const result = await cmosSessionComplete({
        sessionId: 'PS-COMP-001',
        summary: 'Constraint extraction test',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.constraintsExtracted).toBe(2);

      const rows = testDb.db.prepare('SELECT content FROM constraints ORDER BY id').all() as Array<{
        content: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].content).toBe('Max 100MB uploads');
      expect(rows[1].content).toBe('No external API calls in tests');
    });

    it('should respect expiresAt on constraint captures during completion', async () => {
      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES (
          'PS-COMP-002', 'build', 'Test', 'sprint-40', '2026-03-13T09:00:00Z', 'active',
          '${JSON.stringify([
            {
              category: 'constraint',
              content: 'Deploy freeze until release',
              expiresAt: '2026-03-25T00:00:00Z',
              timestamp: '2026-03-13T09:10:00Z',
            },
          ]).replace(/'/g, "''")}'
        );
      `);

      const result = await cmosSessionComplete({
        sessionId: 'PS-COMP-002',
        summary: 'Expiry test',
        projectRoot: testDb.tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.constraintsExtracted).toBe(1);

      const row = testDb.db.prepare('SELECT expires_at FROM constraints LIMIT 1').get() as {
        expires_at: string | null;
      };
      expect(row.expires_at).toBe('2026-03-25T00:00:00Z');
    });
  });

  // ─── Lifecycle Handlers ────────────────────────────────────────────────

  describe('lifecycle handlers', () => {
    async function seedConstraints(db: Database.Database): Promise<void> {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      if (!clientResult.success || !clientResult.data) throw new Error('Failed to create client');
      ensureConstraintsTable(clientResult.data);
      clientResult.data.close();

      // Seed sessions referenced by constraints
      db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
        VALUES
          ('PS-S1', 'build', 'Session 1', 'sprint-40', '2026-03-13T09:00:00Z', 'completed'),
          ('PS-S2', 'build', 'Session 2', 'sprint-38', '2026-02-01T09:00:00Z', 'completed');
      `);

      const now = new Date().toISOString();
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago
      const expiredDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ago
      db.exec(`
        INSERT INTO constraints (content, status, session_id, sprint_id, created_at, expires_at, content_hash)
        VALUES
          ('Must support PG 14+', 'active', 'PS-S1', 'sprint-40', '${now}', NULL, '${computeContentHash('Must support PG 14+', 'constraint')}'),
          ('Deploy freeze until release', 'active', 'PS-S1', 'sprint-40', '${now}', '${expiredDate}', '${computeContentHash('Deploy freeze until release', 'constraint')}'),
          ('Old constraint no expiry', 'active', 'PS-S2', 'sprint-38', '${old}', NULL, '${computeContentHash('Old constraint no expiry', 'constraint')}'),
          ('Already archived', 'archived', 'PS-S2', 'sprint-38', '${old}', NULL, '${computeContentHash('Already archived', 'constraint')}');
      `);
    }

    describe('list', () => {
      it('should list active constraints by default', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'list',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.items).toHaveLength(3);
        expect(result.data?.items?.every((i) => i.status === 'active')).toBe(true);
      });

      it('should filter by archived status', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'list',
          constraintStatus: 'archived',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.items).toHaveLength(1);
        expect(result.data?.items?.[0].content).toBe('Already archived');
      });
    });

    describe('review', () => {
      it('should flag expired constraints with score 100', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'review',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        const expired = result.data?.reviewItems?.find(
          (i) => i.content === 'Deploy freeze until release'
        );
        expect(expired).toBeDefined();
        expect(expired?.stalenessScore).toBe(100);
        expect(expired?.reason).toBe('expired');
      });

      it('should flag old constraints without expiry', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'review',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        const old = result.data?.reviewItems?.find((i) => i.content === 'Old constraint no expiry');
        expect(old).toBeDefined();
        expect(old?.stalenessScore).toBeGreaterThanOrEqual(50);
        expect(old?.reason).toBe('stale_no_expiry');
      });

      it('should not flag fresh constraints', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'review',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        const fresh = result.data?.reviewItems?.find((i) => i.content === 'Must support PG 14+');
        // Fresh constraint with no expiry but created today should have low score
        // Score = ageScore (0, created today) + noExpiryBonus (20) = 20, which is < 50
        expect(fresh).toBeUndefined();
      });

      it('should respect custom staleness threshold', async () => {
        await seedConstraints(testDb.db);

        // Very short threshold should flag more items
        const result = await cmosConstraints({
          constraintAction: 'review',
          stalenessThresholdDays: 1,
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        // With threshold of 1 day, even the fresh constraint with no expiry
        // should get a high score since it has the 20-point no-expiry bonus
        // But it was created "today" so ageScore is still ~0
        // Score = 0 + 20 = 20, still < 50
        // Only expired + old should be flagged
        expect(result.data?.reviewItems?.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('archive', () => {
      it('should archive specific constraints by ID', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'archive',
          constraintIds: [1, 3],
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(2);

        const row1 = testDb.db
          .prepare('SELECT status, archived_at FROM constraints WHERE id = 1')
          .get() as { status: string; archived_at: string | null };
        expect(row1.status).toBe('archived');
        expect(row1.archived_at).toBeTruthy();
      });

      it('should archive all expired when no IDs provided', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'archive',
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(1); // Only the expired one

        const expired = testDb.db
          .prepare("SELECT status FROM constraints WHERE content = 'Deploy freeze until release'")
          .get() as { status: string };
        expect(expired.status).toBe('archived');
      });

      it('should not re-archive already-archived constraints', async () => {
        await seedConstraints(testDb.db);

        const result = await cmosConstraints({
          constraintAction: 'archive',
          constraintIds: [4], // Already archived
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(true);
        expect(result.data?.affected).toBe(0);
      });
    });

    describe('invalid action', () => {
      it('should return error for invalid constraint action', async () => {
        const result = await cmosConstraints({
          constraintAction: 'invalid' as any,
          projectRoot: testDb.tempDir,
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_ACTION');
      });
    });
  });

  // ─── Stale Constraint Count (Onboard) ──────────────────────────────────

  describe('getStaleConstraintCount', () => {
    it('should return 0 when no constraints table exists', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;

      const count = getStaleConstraintCount(client);
      expect(count).toBe(0);

      client.close();
    });

    it('should count expired + old-without-expiry constraints', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;
      ensureConstraintsTable(client);
      client.close();

      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, started_at, status)
        VALUES ('PS-T1', 'build', 'Test', '2026-03-13T09:00:00Z', 'completed');
      `);

      const old = '2025-01-01T00:00:00Z';
      // Use a truly-recent timestamp so "Fresh one" stays under the 30-day staleness threshold
      const recentNow = new Date().toISOString();
      // Use a past expires_at that will always be expired
      const expiredAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      testDb.db.exec(`
        INSERT INTO constraints (content, status, created_at, session_id, expires_at, content_hash)
        VALUES
          ('Expired one', 'active', '${recentNow}', 'PS-T1', '${expiredAt}', 'h1'),
          ('Old no expiry', 'active', '${old}', 'PS-T1', NULL, 'h2'),
          ('Fresh one', 'active', '${recentNow}', 'PS-T1', NULL, 'h3'),
          ('Archived', 'archived', '${old}', 'PS-T1', NULL, 'h4');
      `);

      const clientResult2 = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client2 = clientResult2.data!;

      const count = getStaleConstraintCount(client2);
      // Expired: 1, Old without expiry: 1, Fresh: not counted, Archived: not counted
      expect(count).toBe(2);

      client2.close();
    });

    it('does not write on the read path — un-migrated store keeps no last_reviewed_at column (s82-m01)', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;
      ensureConstraintsTable(client); // creates the table WITHOUT last_reviewed_at (base schema)

      const before = (
        testDb.db.prepare('PRAGMA table_info(constraints)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(before).not.toContain('last_reviewed_at');

      // getStaleConstraintCount degrades to created_at anchoring and must NOT add the column.
      getStaleConstraintCount(client);
      client.close();

      const after = (
        testDb.db.prepare('PRAGMA table_info(constraints)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(after).not.toContain('last_reviewed_at');
    });
  });

  // ─── Reaffirm (s82-m01) ────────────────────────────────────────────────

  describe('reaffirm (s82-m01)', () => {
    async function seedOne(db: Database.Database, ageDays: number): Promise<void> {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      if (!clientResult.success || !clientResult.data) throw new Error('Failed to create client');
      ensureConstraintsTable(clientResult.data);
      clientResult.data.close();
      const created = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
      db.exec(`
        INSERT INTO constraints (content, status, sprint_id, created_at, expires_at, content_hash)
        VALUES ('cmos_review payload <=4KB', 'active', 'sprint-40', '${created}', NULL,
                '${computeContentHash('cmos_review payload <=4KB', 'constraint')}');
      `);
    }

    it('drops a stale constraint below the surfacing floor (review score <50 + banner count)', async () => {
      // A 90-day-old no-expiry constraint scores 100 (80 age + 20 no-expiry) — the
      // constraint #2 (cmos_review <=4KB) situation the mission targets.
      await seedOne(testDb.db, 90);

      // Before: flagged in review + counted in the onboard banner.
      const c1 = (await CmosDatabaseClient.create({ dbPath: testDb.dbPath })).data!;
      expect(getStaleConstraintCount(c1)).toBe(1);
      c1.close();

      let review = await cmosConstraints({
        constraintAction: 'review',
        projectRoot: testDb.tempDir,
      });
      const flagged = review.data?.reviewItems?.find((i) => i.content.startsWith('cmos_review'));
      expect(flagged).toBeDefined();
      expect(flagged?.stalenessScore).toBeGreaterThanOrEqual(50);

      // Reaffirm it.
      const r = await cmosConstraints({
        constraintAction: 'reaffirm',
        constraintId: 1,
        projectRoot: testDb.tempDir,
      });
      expect(r.success).toBe(true);
      expect(r.data?.constraintAction).toBe('reaffirm');
      expect(r.data?.constraintId).toBe(1);
      expect(r.data?.reaffirmedAt).toBeTruthy();

      // Positive-fire: last_reviewed_at actually bumped in the store.
      const row = testDb.db
        .prepare('SELECT last_reviewed_at FROM constraints WHERE id = 1')
        .get() as { last_reviewed_at: string | null };
      expect(row.last_reviewed_at).toBeTruthy();

      // After: score anchored on last_reviewed_at (now) → below 50 → no longer flagged
      // in review nor counted by the banner.
      review = await cmosConstraints({ constraintAction: 'review', projectRoot: testDb.tempDir });
      expect(
        review.data?.reviewItems?.find((i) => i.content.startsWith('cmos_review'))
      ).toBeUndefined();

      const c2 = (await CmosDatabaseClient.create({ dbPath: testDb.dbPath })).data!;
      expect(getStaleConstraintCount(c2)).toBe(0);
      c2.close();
    });

    it('routes reaffirm through cmos_context(constraints) and passes constraintId', async () => {
      await seedOne(testDb.db, 90);

      const r = await cmosContext({
        action: 'constraints',
        constraintAction: 'reaffirm',
        constraintId: 1,
        projectRoot: testDb.tempDir,
      });
      expect(r.success).toBe(true);
      expect((r.data as { constraintAction?: string }).constraintAction).toBe('reaffirm');
      expect((r.data as { constraintId?: number }).constraintId).toBe(1);

      const row = testDb.db
        .prepare('SELECT last_reviewed_at FROM constraints WHERE id = 1')
        .get() as { last_reviewed_at: string | null };
      expect(row.last_reviewed_at).toBeTruthy();
    });

    // ─── s84-m05: evergreen flag (constraint #2 durable exclusion) ──────────
    it('evergreen=true durably drops the constraint off review + banner (constraint #2 case)', async () => {
      // A 90-day-old no-expiry constraint scores 100 — the constraint #2 (cmos_review ≤4KB) case.
      await seedOne(testDb.db, 90);

      // Before: flagged in review + counted.
      let review = await cmosConstraints({
        constraintAction: 'review',
        projectRoot: testDb.tempDir,
      });
      expect(
        review.data?.reviewItems?.find((i) => i.content.startsWith('cmos_review'))
      ).toBeDefined();

      // Reaffirm WITH evergreen=true via the cmos_context surface (exercises the plumbing).
      const r = await cmosContext({
        action: 'constraints',
        constraintAction: 'reaffirm',
        constraintId: 1,
        evergreen: true,
        projectRoot: testDb.tempDir,
      });
      expect(r.success).toBe(true);

      // Positive-fire: the evergreen column landed AND is set to 1 in the store.
      const cols = (
        testDb.db.prepare(`PRAGMA table_info('constraints')`).all() as { name: string }[]
      ).map((c) => c.name);
      expect(cols).toContain('evergreen');
      const row = testDb.db.prepare('SELECT evergreen FROM constraints WHERE id = 1').get() as {
        evergreen: number;
      };
      expect(row.evergreen).toBe(1);

      // After: excluded from review AND the onboard/cmos_review banner count — DURABLY (evergreen
      // does not age out like a reaffirm-only reset would). list still shows it, flagged evergreen.
      review = await cmosConstraints({ constraintAction: 'review', projectRoot: testDb.tempDir });
      expect(
        review.data?.reviewItems?.find((i) => i.content.startsWith('cmos_review'))
      ).toBeUndefined();

      const c = (await CmosDatabaseClient.create({ dbPath: testDb.dbPath })).data!;
      expect(getStaleConstraintCount(c)).toBe(0);
      c.close();

      const list = await cmosConstraints({ constraintAction: 'list', projectRoot: testDb.tempDir });
      const listed = list.data?.items?.find((i) => i.content.startsWith('cmos_review'));
      expect(listed?.evergreen).toBe(true);
    });

    it('requires constraintId', async () => {
      const r = await cmosConstraints({
        constraintAction: 'reaffirm',
        projectRoot: testDb.tempDir,
      });
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe('MISSING_PARAMETER');
    });

    it('errors on a nonexistent constraint', async () => {
      await seedOne(testDb.db, 90);
      const r = await cmosConstraints({
        constraintAction: 'reaffirm',
        constraintId: 9999,
        projectRoot: testDb.tempDir,
      });
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe('MISSION_NOT_FOUND');
      expect(r.error?.message).toContain('not found');
    });

    it('adds last_reviewed_at idempotently (ensureConstraintReviewTimestamp)', async () => {
      const client = (await CmosDatabaseClient.create({ dbPath: testDb.dbPath })).data!;
      ensureConstraintsTable(client);

      const first = ensureConstraintReviewTimestamp(client);
      expect(first.columnsAdded).toContain('constraints.last_reviewed_at');

      const second = ensureConstraintReviewTimestamp(client);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.columnsAdded).toHaveLength(0);
      client.close();

      const cols = (
        testDb.db.prepare('PRAGMA table_info(constraints)').all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain('last_reviewed_at');
    });
  });

  // ─── LLM Formatter ────────────────────────────────────────────────────

  describe('formatConstraintsForLLM', () => {
    it('should format list result', () => {
      const result = {
        success: true as const,
        data: {
          constraintAction: 'list',
          items: [
            {
              id: 1,
              content: 'Must support PG 14+',
              status: 'active' as const,
              sessionId: 'PS-001',
              sprintId: 'sprint-40',
              createdAt: '2026-03-13T10:00:00Z',
              expiresAt: null,
              archivedAt: null,
              lastReviewedAt: null,
              evergreen: false,
            },
          ],
          affected: 1,
          message: 'Found 1 constraint(s)',
        },
      };

      const formatted = formatConstraintsForLLM(result);
      expect(formatted).toContain('Constraints (1)');
      expect(formatted).toContain('#1');
      expect(formatted).toContain('Must support PG 14+');
    });

    it('should format review result with scores', () => {
      const result = {
        success: true as const,
        data: {
          constraintAction: 'review',
          reviewItems: [
            {
              id: 2,
              content: 'Deploy freeze',
              status: 'active' as const,
              sessionId: 'PS-001',
              sprintId: 'sprint-40',
              createdAt: '2026-03-13T10:00:00Z',
              expiresAt: '2026-03-10T00:00:00Z',
              archivedAt: null,
              lastReviewedAt: null,
              evergreen: false,
              stalenessScore: 100,
              reason: 'expired' as const,
            },
          ],
          affected: 1,
          message: '1 constraint(s) flagged',
        },
      };

      const formatted = formatConstraintsForLLM(result);
      expect(formatted).toContain('Constraint Review (1 flagged)');
      expect(formatted).toContain('[score: 100]');
      expect(formatted).toContain('(expired)');
      expect(formatted).toContain('Deploy freeze');
    });

    it('should format error result', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Invalid constraint action',
        },
      };

      const formatted = formatConstraintsForLLM(result);
      expect(formatted).toContain('Failed to manage constraints');
    });
  });

  // ─── Schema Migration ─────────────────────────────────────────────────

  describe('schema migration', () => {
    it('should create constraints table idempotently', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;

      ensureConstraintsTable(client);
      ensureConstraintsTable(client); // second call is no-op

      const table = testDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='constraints'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe('constraints');

      client.close();
    });

    it('should have correct columns', async () => {
      const clientResult = await CmosDatabaseClient.create({ dbPath: testDb.dbPath });
      const client = clientResult.data!;
      ensureConstraintsTable(client);
      client.close();

      const columns = testDb.db.prepare('PRAGMA table_info(constraints)').all() as Array<{
        name: string;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain('id');
      expect(names).toContain('content');
      expect(names).toContain('status');
      expect(names).toContain('session_id');
      expect(names).toContain('sprint_id');
      expect(names).toContain('created_at');
      expect(names).toContain('expires_at');
      expect(names).toContain('archived_at');
      expect(names).toContain('content_hash');
    });
  });
});
