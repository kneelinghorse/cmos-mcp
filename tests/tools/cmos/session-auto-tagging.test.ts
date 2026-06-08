/**
 * Session Auto-Tagging Tests (s40-m01)
 *
 * Tests for:
 * 1. Auto-sprint detection on session start
 * 2. Session-mission association via captures
 * 3. Retro/analytics integration with session→mission linkage
 *
 * @module tests/tools/cmos/session-auto-tagging
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

import {
  cmosSessionStart,
  generateSessionId,
  type CmosSessionStartResult,
} from '../../../src/tools/cmos/cmos-session-start';

import {
  cmosSessionCapture,
  type CmosSessionCaptureResult,
} from '../../../src/tools/cmos/cmos-session-capture';

import { cmosSprintRetro, type SprintRetroResult } from '../../../src/tools/cmos/cmos-sprint-retro';

import {
  cmosSprintAnalytics,
  type SprintAnalyticsResult,
} from '../../../src/tools/cmos/cmos-sprint-analytics';

import { ensureSessionMissionsTable } from '../../../src/tools/cmos/schema-migrations';
import { CmosDatabaseClient, type QueryParams } from '../../../src/tools/cmos/client';

// ─── Test DB Setup ─────────────────────────────────────────────────────────

interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-autotag-test-'));
  const cmosDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDir, { recursive: true });
  const dbPath = path.join(cmosDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project');
    INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    INSERT INTO metadata (key, value) VALUES ('schema_version', '2.2');

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
      created_at TEXT,
      started_at TEXT,
      updated_at TEXT,
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
      agent TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT,
      captures TEXT DEFAULT '[]',
      next_steps TEXT,
      metadata TEXT
    );

    CREATE INDEX idx_sessions_type ON sessions (type);
    CREATE INDEX idx_sessions_status ON sessions (status);
    CREATE INDEX idx_sessions_started_at ON sessions (started_at DESC);

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

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL DEFAULT 'master_context',
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sprint_id TEXT,
      snapshot_id INTEGER,
      project_domain TEXT,
      session_id TEXT,
      mission_id TEXT,
      source_chunk_ids TEXT,
      category TEXT,
      superseded_by INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      evidence TEXT,
      content_hash TEXT
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sprint_id TEXT,
      session_id TEXT,
      mission_id TEXT,
      created_at TEXT NOT NULL,
      content_hash TEXT
    );

    CREATE TABLE session_missions (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'capture',
      PRIMARY KEY (session_id, mission_id)
    );
    CREATE INDEX idx_session_missions_mission ON session_missions (mission_id);

    -- Seed data
    INSERT INTO sprints (id, title, focus, status)
    VALUES
      ('sprint-10', 'Sprint 10', 'Old sprint', 'Completed'),
      ('sprint-11', 'Sprint 11', 'Active sprint', 'Active');

    INSERT INTO missions (id, sprint_id, name, status, completed_at, objective, started_at)
    VALUES
      ('s11-m01', 'sprint-11', 'Active Mission 1', 'In Progress', NULL, 'Mission 1 objective', '2024-01-10T10:00:00Z'),
      ('s11-m02', 'sprint-11', 'Active Mission 2', 'Queued', NULL, 'Mission 2 objective', NULL),
      ('s10-m01', 'sprint-10', 'Old Completed', 'Completed', '2024-01-05T10:00:00Z', 'Old mission', '2024-01-04T10:00:00Z');

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"Test"}}', '2024-01-10T12:00:00Z'),
      ('project_context', 'context/PROJECT_CONTEXT.json', '{"working_memory":{"next_steps":[]}}', '2024-01-10T12:00:00Z');

    -- FTS5 for decision supersession detection
    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
      decision_text,
      content='strategic_decisions',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
      INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
    END;
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
// Auto-Sprint Detection Tests
// ============================================================================

describe('Session Auto-Sprint Detection', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should auto-tag session with active sprint when no sprintId provided', async () => {
    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Auto-tagged session',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.sprintId).toBe('sprint-11');
    expect(result.data?.sprintAutoTagged).toBe(true);

    // Verify in DB
    const row = testDb.db
      .prepare('SELECT sprint_id FROM sessions WHERE id = ?')
      .get(result.data?.sessionId) as { sprint_id: string };
    expect(row.sprint_id).toBe('sprint-11');
  });

  it('should use explicit sprintId when provided (not auto-tag)', async () => {
    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Explicit sprint session',
      sprintId: 'sprint-10',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.sprintId).toBe('sprint-10');
    expect(result.data?.sprintAutoTagged).toBe(false);
  });

  it('should set sprintAutoTagged=false and sprintId=null when no active sprint exists', async () => {
    // Mark all sprints as completed
    testDb.db.exec(`UPDATE sprints SET status = 'Completed'`);

    const result = await cmosSessionStart({
      type: 'research',
      title: 'No active sprint session',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.sprintId).toBeNull();
    expect(result.data?.sprintAutoTagged).toBe(false);
  });

  it('should include auto-tag info in message', async () => {
    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Message check',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.message).toContain('auto-tagged to sprint-11');
  });

  it('should pick the latest active sprint when multiple exist', async () => {
    testDb.db.exec(`
      INSERT INTO sprints (id, title, focus, status)
      VALUES ('sprint-12', 'Sprint 12', 'Newer active', 'Active');
    `);

    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Latest sprint check',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    // Should pick sprint-12 (most recently inserted, same date)
    expect(result.data?.sprintId).toBe('sprint-12');
    expect(result.data?.sprintAutoTagged).toBe(true);
  });

  it('should pick the most recently started sprint, not the lexicographically greatest ID', async () => {
    // Regression: sprint IDs are strings — lexicographic ORDER BY id DESC is unreliable.
    // 'sprint-9' > 'sprint-43' lexicographically (because '9' > '4'),
    // but sprint-43 started later so it should be preferred.
    testDb.db.exec(`
      UPDATE sprints SET status = 'Completed';
      INSERT INTO sprints (id, title, focus, status, start_date)
      VALUES
        ('sprint-43', 'Sprint 43', 'Older by ID sort', 'Active', '2024-02-01'),
        ('sprint-9',  'Sprint 9',  'Newer by ID sort', 'Active', '2024-01-01');
    `);

    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Date-based sprint selection',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    // sprint-43 started 2024-02-01, which is more recent than sprint-9's 2024-01-01
    expect(result.data?.sprintId).toBe('sprint-43');
    expect(result.data?.sprintAutoTagged).toBe(true);
  });

  it('should store auto-tagged sprint in session event', async () => {
    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Event check',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    const event = testDb.db
      .prepare('SELECT next_hint FROM session_events WHERE mission = ?')
      .get(result.data?.sessionId) as { next_hint: string | null };
    expect(event.next_hint).toBe('sprint-11');
  });
});

// ============================================================================
// Session-Mission Association Tests
// ============================================================================

describe('Session-Mission Association via Captures', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  async function startSession(): Promise<string> {
    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Test Session',
      projectRoot: testDb.tempDir,
    });
    return result.data!.sessionId;
  }

  it('should create session_missions link when capture has missionId', async () => {
    const sessionId = await startSession();

    await cmosSessionCapture({
      category: 'decision',
      content: 'Decided to use approach A',
      missionId: 's11-m01',
      projectRoot: testDb.tempDir,
    });

    const link = testDb.db
      .prepare('SELECT * FROM session_missions WHERE session_id = ? AND mission_id = ?')
      .get(sessionId, 's11-m01') as
      | { session_id: string; mission_id: string; source: string }
      | undefined;

    expect(link).toBeDefined();
    expect(link!.source).toBe('capture');
  });

  it('should not duplicate session_missions link on multiple captures with same missionId', async () => {
    const sessionId = await startSession();

    await cmosSessionCapture({
      category: 'decision',
      content: 'First decision for mission',
      missionId: 's11-m01',
      projectRoot: testDb.tempDir,
    });

    await cmosSessionCapture({
      category: 'learning',
      content: 'Learned something for same mission',
      missionId: 's11-m01',
      projectRoot: testDb.tempDir,
    });

    const links = testDb.db
      .prepare('SELECT * FROM session_missions WHERE session_id = ? AND mission_id = ?')
      .all(sessionId, 's11-m01') as any[];

    expect(links).toHaveLength(1);
  });

  it('should create multiple links for different missions', async () => {
    const sessionId = await startSession();

    await cmosSessionCapture({
      category: 'decision',
      content: 'Decision for mission 1',
      missionId: 's11-m01',
      projectRoot: testDb.tempDir,
    });

    await cmosSessionCapture({
      category: 'context',
      content: 'Context for mission 2',
      missionId: 's11-m02',
      projectRoot: testDb.tempDir,
    });

    const links = testDb.db
      .prepare('SELECT mission_id FROM session_missions WHERE session_id = ? ORDER BY mission_id')
      .all(sessionId) as { mission_id: string }[];

    expect(links).toHaveLength(2);
    expect(links[0].mission_id).toBe('s11-m01');
    expect(links[1].mission_id).toBe('s11-m02');
  });

  it('should not create link when capture has no missionId', async () => {
    const sessionId = await startSession();

    await cmosSessionCapture({
      category: 'learning',
      content: 'General learning without mission',
      projectRoot: testDb.tempDir,
    });

    const links = testDb.db
      .prepare('SELECT * FROM session_missions WHERE session_id = ?')
      .all(sessionId) as any[];

    expect(links).toHaveLength(0);
  });
});

// ============================================================================
// Sprint Retro Integration Tests
// ============================================================================

describe('Sprint Retro Session-Mission Linkage', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should include sessions array in retro result', async () => {
    const result = await cmosSprintRetro({
      sprintId: 'sprint-11',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.sessions).toBeDefined();
    expect(Array.isArray(result.data?.sessions)).toBe(true);
  });

  it('should show linked missions for sessions with captures', async () => {
    // Create a session linked to sprint-11
    testDb.db.exec(`
      INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
      VALUES ('PS-test-001', 'planning', 'Test Planning', 'sprint-11', '2024-01-10T10:00:00Z', 'assistant', 'completed', '[]');

      INSERT INTO session_missions (session_id, mission_id, linked_at, source)
      VALUES ('PS-test-001', 's11-m01', '2024-01-10T10:30:00Z', 'capture');
    `);

    const result = await cmosSprintRetro({
      sprintId: 'sprint-11',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    const session = result.data?.sessions.find((s) => s.id === 'PS-test-001');
    expect(session).toBeDefined();
    expect(session!.linkedMissionIds).toContain('s11-m01');
  });

  it('should report linkedSessions count in KPIs', async () => {
    // Create 2 sessions: one linked, one not
    testDb.db.exec(`
      INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
      VALUES
        ('PS-test-linked', 'planning', 'Linked', 'sprint-11', '2024-01-10T10:00:00Z', 'assistant', 'completed', '[]'),
        ('PS-test-unlinked', 'review', 'Unlinked', 'sprint-11', '2024-01-11T10:00:00Z', 'assistant', 'completed', '[]');

      INSERT INTO session_missions (session_id, mission_id, linked_at, source)
      VALUES ('PS-test-linked', 's11-m01', '2024-01-10T10:30:00Z', 'capture');
    `);

    const result = await cmosSprintRetro({
      sprintId: 'sprint-11',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.kpis.totalSessions).toBe(2);
    expect(result.data?.kpis.linkedSessions).toBe(1);
  });

  it('should handle sprints with no sessions gracefully', async () => {
    const result = await cmosSprintRetro({
      sprintId: 'sprint-10',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.sessions).toEqual([]);
    expect(result.data?.kpis.totalSessions).toBe(0);
    expect(result.data?.kpis.linkedSessions).toBe(0);
  });
});

// ============================================================================
// Sprint Analytics Integration Tests
// ============================================================================

describe('Sprint Analytics Session-Mission Linkage', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();

    // Create sprint_summary view that analytics depends on
    testDb.db.exec(`
      CREATE VIEW IF NOT EXISTS sprint_summary AS
      SELECT
        s.id AS sprint_id,
        s.title,
        s.status,
        s.focus,
        s.start_date,
        s.end_date,
        COUNT(m.id) AS total_missions,
        COUNT(CASE WHEN m.status = 'Completed' THEN 1 END) AS completed_missions,
        COUNT(CASE WHEN m.status = 'Blocked' THEN 1 END) AS blocked_missions,
        COUNT(CASE WHEN m.status IN ('Current', 'In Progress') THEN 1 END) AS active_missions,
        (
          SELECT COUNT(DISTINCT sd.id)
          FROM strategic_decisions sd
          WHERE sd.sprint_id = s.id
        ) AS decisions_count
      FROM sprints s
      LEFT JOIN missions m ON m.sprint_id = s.id
      GROUP BY s.id, s.title, s.status, s.focus, s.start_date, s.end_date;
    `);
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should include linkedSessionsCount in sprint data points', async () => {
    // Add a linked session for sprint-10
    testDb.db.exec(`
      INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
      VALUES ('PS-analytics-001', 'planning', 'Analytics Test', 'sprint-10', '2024-01-04T10:00:00Z', 'assistant', 'completed', '[]');

      INSERT INTO session_missions (session_id, mission_id, linked_at, source)
      VALUES ('PS-analytics-001', 's10-m01', '2024-01-04T10:30:00Z', 'capture');
    `);

    const result = await cmosSprintAnalytics({
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    const sprint10 = result.data?.sprints.find((s) => s.sprintId === 'sprint-10');
    expect(sprint10).toBeDefined();
    expect(sprint10!.linkedSessionsCount).toBe(1);
  });

  it('should aggregate totalLinkedSessions across sprints', async () => {
    testDb.db.exec(`
      INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
      VALUES
        ('PS-a1', 'planning', 'S10 session', 'sprint-10', '2024-01-04T10:00:00Z', 'assistant', 'completed', '[]'),
        ('PS-a2', 'planning', 'S11 session', 'sprint-11', '2024-01-10T10:00:00Z', 'assistant', 'completed', '[]');

      INSERT INTO session_missions (session_id, mission_id, linked_at, source)
      VALUES
        ('PS-a1', 's10-m01', '2024-01-04T10:30:00Z', 'capture'),
        ('PS-a2', 's11-m01', '2024-01-10T10:30:00Z', 'capture');
    `);

    const result = await cmosSprintAnalytics({
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.aggregates.totalLinkedSessions).toBe(2);
  });

  it('should return 0 linkedSessionsCount when no session_missions table exists', async () => {
    // Drop the session_missions table
    testDb.db.exec('DROP TABLE IF EXISTS session_missions');

    const result = await cmosSprintAnalytics({
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    for (const sprint of result.data?.sprints ?? []) {
      expect(sprint.linkedSessionsCount).toBe(0);
    }
    expect(result.data?.aggregates.totalLinkedSessions).toBe(0);
  });
});

// ============================================================================
// Schema Migration Tests
// ============================================================================

describe('ensureSessionMissionsTable migration', () => {
  it('should be idempotent', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-migration-test-'));
    const cmosDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDir, { recursive: true });
    const dbPath = path.join(cmosDir, 'cmos.sqlite');
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('schema_version', '2.2');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, title TEXT, sprint_id TEXT, started_at TEXT, completed_at TEXT, agent TEXT, status TEXT, summary TEXT, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
    `);
    db.close();

    // Use CmosDatabaseClient.create to get a proper client
    CmosDetector.resetInstance();
    const clientResult = await CmosDatabaseClient.create({ dbPath });
    expect(clientResult.success).toBe(true);
    const client = clientResult.data!;

    try {
      // Call twice — should not throw
      const result1 = ensureSessionMissionsTable(client);
      const result2 = ensureSessionMissionsTable(client);

      expect(result1.columnsAdded).toContain('session_missions (table)');
      // Second call still returns success (CREATE TABLE IF NOT EXISTS)
      expect(result2.columnsAdded).toContain('session_missions (table)');

      // Table should exist and be writable
      const db2 = new Database(dbPath);
      db2.exec(
        `INSERT INTO sessions (id, type, title, started_at, status) VALUES ('s1', 'test', 'test', '2024-01-01', 'active')`
      );
      db2.exec(`INSERT INTO missions (id, name, status) VALUES ('m1', 'test', 'Queued')`);
      db2.exec(
        `INSERT INTO session_missions (session_id, mission_id, linked_at, source) VALUES ('s1', 'm1', '2024-01-01', 'capture')`
      );

      const row = db2.prepare('SELECT * FROM session_missions').get() as any;
      expect(row.session_id).toBe('s1');
      expect(row.mission_id).toBe('m1');
      db2.close();
    } finally {
      client.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Session ID Collision Resistance Tests (tc-m05)
// ============================================================================

describe('generateSessionId — unit', () => {
  const today = new Date().toISOString().split('T')[0];

  it('returns PS-<today>-001 when no sessions exist', () => {
    expect(generateSessionId([])).toBe(`PS-${today}-001`);
  });

  it('increments from the highest counter in the existing list', () => {
    expect(generateSessionId([`PS-${today}-001`, `PS-${today}-003`])).toBe(`PS-${today}-004`);
  });

  it('ignores IDs from other dates', () => {
    expect(generateSessionId([`PS-2000-01-01-099`])).toBe(`PS-${today}-001`);
  });

  it('handles a single high counter correctly', () => {
    expect(generateSessionId([`PS-${today}-050`])).toBe(`PS-${today}-051`);
  });
});

describe('Session ID collision resistance — integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
    jest.restoreAllMocks();
  });

  it('sessions.id has a UNIQUE constraint preventing duplicate IDs', () => {
    testDb.db.exec(`
      INSERT INTO sessions (id, type, title, started_at, agent, status, captures)
      VALUES ('dup-001', 'planning', 'First', '2024-01-01T00:00:00Z', 'test', 'completed', '[]')
    `);
    expect(() => {
      testDb.db.exec(`
        INSERT INTO sessions (id, type, title, started_at, agent, status, captures)
        VALUES ('dup-001', 'planning', 'Duplicate', '2024-01-01T00:00:00Z', 'test', 'completed', '[]')
      `);
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('retries with a fresh ID when INSERT is rejected due to a session ID collision', async () => {
    // Scenario: the ID generated from the SELECT snapshot is already claimed by the time
    // INSERT runs (e.g. DB restore or concurrent write between SELECT and INSERT).
    const today = new Date().toISOString().split('T')[0];
    const collisionId = `PS-${today}-001`;

    let sessionInsertCount = 0;
    const realExecute = CmosDatabaseClient.prototype.execute;

    jest.spyOn(CmosDatabaseClient.prototype, 'execute').mockImplementation(function (
      this: CmosDatabaseClient,
      sql: string,
      params?: QueryParams
    ) {
      if (
        sql.trimStart().toUpperCase().startsWith('INSERT INTO SESSIONS ') &&
        sessionInsertCount === 0
      ) {
        sessionInsertCount++;
        // Simulate: another process claimed collisionId between our SELECT and INSERT.
        // Insert it now so the retry re-query finds it and picks a fresh ID.
        // The first cmosSessionStart call already ran the firehose migration, so
        // sessions now requires the NOT NULL genesis columns — stamp them here as a
        // real concurrent writer would (via genesisColumns).
        testDb.db.exec(`
          INSERT INTO sessions (id, type, title, started_at, agent, status, captures,
            project_id, stable_event_id, occurred_at, origin_seq, event_type)
          VALUES ('${collisionId}', 'planning', 'Race winner', '2000-01-01T00:00:00Z', 'external', 'completed', '[]',
            'test-project', '01JRACEWINNER000000000000', 946684800000, 999, 'session_started')
        `);
        return {
          success: false as const,
          error: {
            code: 'INVALID_PARAMETER' as const,
            field: 'id',
            message: `Duplicate value for unique field 'sessions.id'`,
            suggestion: 'Use a unique value for this field.',
          },
        };
      }
      return realExecute.call(this, sql, params);
    });

    const result = await cmosSessionStart({
      type: 'planning',
      title: 'Retry test',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    // After re-querying, collisionId is found → next ID is 002
    expect(result.data?.sessionId).toBe(`PS-${today}-002`);
    expect(sessionInsertCount).toBe(1); // confirmed: first attempt triggered the retry
  });
});
