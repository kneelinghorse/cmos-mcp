/**
 * cmos_session_complete Tool Tests
 *
 * Tests for session completion with context aggregation.
 * Verifies that captures flow into master_context and project_context
 * matching the Python SessionRuntime behavior.
 *
 * @module tests/tools/cmos/cmos-session-complete
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSessionComplete,
  cmosSessionCompleteToolDefinition,
  formatSessionCompleteForLLM,
  type CmosSessionCompleteResult,
} from '../../../src/tools/cmos/cmos-session-complete';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

const SCHEMA = `
  CREATE TABLE sprints (
    id TEXT PRIMARY KEY,
    title TEXT,
    focus TEXT,
    status TEXT,
    start_date TEXT,
    end_date TEXT
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
    author_session_id TEXT REFERENCES sessions(id),
    source_chunk_ids TEXT
  );

  CREATE TABLE missions (
    id TEXT PRIMARY KEY,
    sprint_id TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    completed_at TEXT,
    notes TEXT,
    objective TEXT
  );
`;

/**
 * Helper to call cmosSessionComplete with explicit database path.
 */
async function completeWithDb(
  dbPath: string,
  params: {
    sessionId?: string;
    summary: string;
    nextSteps?: string[];
    agent?: string;
  }
): Promise<{
  success: boolean;
  data?: CmosSessionCompleteResult;
  error?: { code: string; message: string };
}> {
  const { withClient } = await import('../../../src/tools/cmos/client');
  const {
    createSuccess,
    createError,
    CMOS_ERROR_CODES: codes,
  } = await import('../../../src/tools/cmos/errors');

  // Use the actual cmosSessionComplete by setting up proper detection
  // Instead, directly call the function with projectRoot override
  return cmosSessionComplete({
    ...params,
    projectRoot: path.dirname(path.dirname(dbPath)), // parent of db dir
  });
}

describe('cmos_session_complete', () => {
  let tempDir: string;
  let dbDir: string;
  let dbPath: string;
  let activeSessionId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-session-complete-test-'));
    // Create cmos/db structure so CmosDetector finds it
    dbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');
    activeSessionId = 'PS-2024-02-01-001';

    const db = new Database(dbPath);
    db.exec(SCHEMA);

    // Seed test data
    db.exec(`
      INSERT INTO sprints (id, title, status, focus)
      VALUES ('sprint-16', 'Sprint 16', 'Active', 'Critical fixes');

      INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
      VALUES (
        '${activeSessionId}',
        'planning',
        'Sprint Planning Session',
        'sprint-16',
        '2024-02-01T09:00:00Z',
        'active',
        '${JSON.stringify([
          {
            category: 'decision',
            content: 'Use PostgreSQL for ACID compliance',
            timestamp: '2024-02-01T09:10:00Z',
          },
          {
            category: 'decision',
            content: 'JWT for auth tokens',
            timestamp: '2024-02-01T09:15:00Z',
          },
          {
            category: 'learning',
            content: 'Redis pub/sub has lower latency than Kafka for our scale',
            timestamp: '2024-02-01T09:20:00Z',
          },
          {
            category: 'constraint',
            content: 'Must support PostgreSQL 14+',
            timestamp: '2024-02-01T09:25:00Z',
          },
          {
            category: 'context',
            content: 'Team prefers TypeScript over Go for services',
            timestamp: '2024-02-01T09:30:00Z',
          },
          {
            category: 'next-step',
            content: 'Set up PostgreSQL migration tooling',
            timestamp: '2024-02-01T09:35:00Z',
          },
        ]).replace(/'/g, "''")}'
      );

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '${JSON.stringify({
          decisions_made: ['Existing decision from last sprint'],
          learnings: [],
          constraints: ['Must deploy to AWS'],
          context_notes: [],
        }).replace(/'/g, "''")}',
        '2024-01-30T12:00:00Z'
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
            sessions_since_reset: 5,
            last_update: '2024-01-30T12:00:00Z',
            size_kb: 1.5,
          },
        }).replace(/'/g, "''")}',
        '2024-01-30T12:00:00Z'
      );

      INSERT INTO metadata (key, value)
      VALUES ('project_domain', 'cmos-mcp');
    `);
    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic completion', () => {
    it('should complete an active session and return result', async () => {
      const result = await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Planned Sprint 16 work',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBe(activeSessionId);
      expect(result.data?.type).toBe('planning');
      expect(result.data?.title).toBe('Sprint Planning Session');
      expect(result.data?.summary).toBe('Planned Sprint 16 work');
      expect(result.data?.captureCount).toBe(6);
      expect(result.data?.capturesByCategory).toEqual({
        decision: 2,
        learning: 1,
        constraint: 1,
        context: 1,
        'next-step': 1,
      });

      // Verify session is marked completed in DB
      const db = new Database(dbPath);
      const session = db
        .prepare('SELECT status, summary FROM sessions WHERE id = ?')
        .get(activeSessionId) as {
        status: string;
        summary: string;
      };
      db.close();
      expect(session.status).toBe('completed');
      expect(session.summary).toBe('Planned Sprint 16 work');
    });

    it('should return error for non-existent session', async () => {
      const result = await cmosSessionComplete({
        sessionId: 'nonexistent',
        summary: 'Test',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_FOUND);
    });

    it('should return error for missing summary', async () => {
      const result = await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: '',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('context aggregation', () => {
    it('should route captures to master_context arrays', async () => {
      const result = await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Aggregation test',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.aggregation.contextsUpdated).toBe(true);
      // decisions and learnings no longer routed to blob (Sprint 51 blob reduction).
      expect(result.data?.aggregation.capturesRouted).toEqual({
        decision: 2,
        learning: 1,
        constraint: 1,
        context: 1,
        'next-step': 1,
      });

      // Verify master_context was updated
      const db = new Database(dbPath);
      const ctx = db.prepare('SELECT content FROM contexts WHERE id = ?').get('master_context') as {
        content: string;
      };
      db.close();

      const master = JSON.parse(ctx.content);

      // decisions_made and learnings are no longer stored in the blob (Sprint 51).
      // They are queryable from strategic_decisions and learnings tables.

      // Constraints (deduped)
      expect(master.constraints).toHaveLength(2); // 1 existing + 1 new
      expect(master.constraints).toContain('Must deploy to AWS');
      expect(master.constraints).toContain('Must support PostgreSQL 14+');

      // Context notes
      expect(master.context_notes).toHaveLength(1);
      expect(master.context_notes[0]).toBe('Team prefers TypeScript over Go for services');

      // Next-step in when_we_resume
      expect(master.next_session_context.when_we_resume).toHaveLength(1);
      expect(master.next_session_context.when_we_resume[0]).toContain(
        'Set up PostgreSQL migration tooling'
      );
    });

    it('should record session history in project_context', async () => {
      await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Session history test',
        projectRoot: tempDir,
      });

      const db = new Database(dbPath);
      const ctx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('project_context') as {
        content: string;
      };
      db.close();

      const project = JSON.parse(ctx.content);
      const history = project.working_memory.session_history;

      expect(history).toHaveLength(1);
      expect(history[0].session).toBe(activeSessionId);
      expect(history[0].sprint_id).toBe('sprint-16');
      expect(history[0].session_type).toBe('planning');
      expect(history[0].action).toBe('complete');
      expect(history[0].summary).toBe('Session history test');
    });

    it('should append recent session to both contexts', async () => {
      await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Recent session test',
        projectRoot: tempDir,
      });

      const db = new Database(dbPath);
      const masterCtx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as {
        content: string;
      };
      const projectCtx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('project_context') as {
        content: string;
      };
      db.close();

      const master = JSON.parse(masterCtx.content);
      const project = JSON.parse(projectCtx.content);

      // Project: working_memory.recent_sessions
      const projectRecent = project.working_memory.recent_sessions;
      expect(projectRecent).toHaveLength(1);
      expect(projectRecent[0].id).toBe(activeSessionId);
      expect(projectRecent[0].sprint_id).toBe('sprint-16');
      expect(projectRecent[0].type).toBe('planning');
      expect(projectRecent[0].capture_count).toBe(6);

      // Master: recent_sessions no longer stored in blob (Sprint 51 blob reduction).
      // Sessions are queryable from the sessions table.
      expect(master.recent_sessions).toBeUndefined();
    });

    it('should record next steps in both contexts', async () => {
      await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Next steps test',
        nextSteps: ['Review PR #42', 'Deploy to staging'],
        projectRoot: tempDir,
      });

      const db = new Database(dbPath);
      const masterCtx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as {
        content: string;
      };
      const projectCtx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('project_context') as {
        content: string;
      };
      db.close();

      const master = JSON.parse(masterCtx.content);
      const project = JSON.parse(projectCtx.content);

      // Project: working_memory.next_steps
      expect(project.working_memory.next_steps).toContain(`${activeSessionId}: Review PR #42`);
      expect(project.working_memory.next_steps).toContain(`${activeSessionId}: Deploy to staging`);

      // Master: next_session_context.when_we_resume (should include both next-step capture and explicit nextSteps)
      const resume = master.next_session_context.when_we_resume;
      expect(resume).toContain(`${activeSessionId}: Set up PostgreSQL migration tooling`);
      expect(resume).toContain(`${activeSessionId}: Review PR #42`);
      expect(resume).toContain(`${activeSessionId}: Deploy to staging`);
    });

    it('should update context health metrics', async () => {
      await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Health metrics test',
        projectRoot: tempDir,
      });

      const db = new Database(dbPath);
      const projectCtx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('project_context') as {
        content: string;
      };
      const masterCtx = db
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as {
        content: string;
      };
      db.close();

      const project = JSON.parse(projectCtx.content);
      const master = JSON.parse(masterCtx.content);

      // Project context health
      expect(project.context_health.sessions_since_reset).toBe(6); // was 5
      expect(project.context_health.last_update).toBeDefined();
      expect(project.context_health.size_kb).toBeGreaterThan(0);
      expect(project.context_health.warning_threshold_percent).toBe(75);
      expect(project.context_health.retention_keep_sprints).toBe(3);

      // Master context health
      expect(master.context_health.sessions_since_reset).toBe(1); // new
      expect(master.context_health.last_update).toBeDefined();
      expect(master.context_health.warning_threshold_percent).toBe(75);
      expect(master.context_health.retention_keep_sprints).toBe(3);
    });

    it('should create snapshots for both contexts', async () => {
      const result = await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Snapshot test',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.aggregation.projectSnapshotId).not.toBeNull();
      expect(result.data?.aggregation.masterSnapshotId).not.toBeNull();

      // Verify snapshots in database
      const db = new Database(dbPath);
      const snapshots = db.prepare('SELECT * FROM context_snapshots').all() as Array<{
        context_id: string;
        session_id: string;
        source: string;
      }>;
      db.close();

      expect(snapshots.length).toBe(2);
      const contextIds = snapshots.map((s) => s.context_id).sort();
      expect(contextIds).toEqual(['master_context', 'project_context']);
      expect(snapshots[0].source).toContain(`session_complete:${activeSessionId}`);
    });

    it('should handle session with no captures gracefully', async () => {
      // Create a session with no captures
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES ('PS-EMPTY', 'review', 'Empty Review', 'sprint-16', '2024-02-01T10:00:00Z', 'active', '[]');
      `);
      db.close();

      const result = await cmosSessionComplete({
        sessionId: 'PS-EMPTY',
        summary: 'Empty session completed',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.aggregation.contextsUpdated).toBe(true);
      expect(result.data?.aggregation.capturesRouted).toEqual({});
    });

    it('should deduplicate constraints', async () => {
      // The initial master_context has 'Must deploy to AWS'
      // Add a capture with same constraint (different case)
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES (
          'PS-DEDUP',
          'review',
          'Dedup Test',
          'sprint-16',
          '2024-02-01T10:00:00Z',
          'active',
          '${JSON.stringify([
            {
              category: 'constraint',
              content: 'must deploy to aws',
              timestamp: '2024-02-01T10:05:00Z',
            },
            {
              category: 'constraint',
              content: 'New unique constraint',
              timestamp: '2024-02-01T10:10:00Z',
            },
          ]).replace(/'/g, "''")}'
        );
      `);
      db.close();

      await cmosSessionComplete({
        sessionId: 'PS-DEDUP',
        summary: 'Dedup test',
        projectRoot: tempDir,
      });

      const db2 = new Database(dbPath);
      const ctx = db2
        .prepare('SELECT content FROM contexts WHERE id = ?')
        .get('master_context') as {
        content: string;
      };
      db2.close();

      const master = JSON.parse(ctx.content);
      // Should have 2 constraints: original + new unique (deduped lowercase match skipped)
      expect(master.constraints).toHaveLength(2);
      expect(master.constraints).toContain('Must deploy to AWS');
      expect(master.constraints).toContain('New unique constraint');
    });
  });

  describe('tool definition', () => {
    it('should have correct name and required fields', () => {
      expect(cmosSessionCompleteToolDefinition.name).toBe('cmos_session_complete');
      expect(cmosSessionCompleteToolDefinition.inputSchema.required).toContain('summary');
    });
  });

  describe('formatSessionCompleteForLLM', () => {
    it('should format success result with aggregation info', () => {
      const result = {
        success: true as const,
        data: {
          sessionId: 'PS-001',
          type: 'planning',
          title: 'Test Session',
          summary: 'Test summary',
          completedAt: '2024-02-01T10:00:00Z',
          durationMinutes: 30,
          captureCount: 3,
          capturesByCategory: { decision: 2, learning: 1 } as Partial<Record<any, number>>,
          nextSteps: ['Do something next'],
          nextStepsExtracted: 1,
          decisionsExtracted: 0,
          constraintsExtracted: 0,
          aggregation: {
            capturesRouted: { decision: 2, learning: 1 },
            contextsUpdated: true,
            projectSnapshotId: 1,
            masterSnapshotId: 2,
          },
          message: 'Done',
        },
      };

      const formatted = formatSessionCompleteForLLM(result);
      expect(formatted).toContain('Session Completed');
      expect(formatted).toContain('PS-001');
      expect(formatted).toContain('Context Aggregation');
      expect(formatted).toContain('decision: 2 routed to master_context');
      expect(formatted).toContain('learning: 1 routed to master_context');
    });

    it('should format error result', () => {
      const result = {
        success: false as const,
        error: {
          code: 'SESSION_NOT_ACTIVE',
          message: 'No active session',
          suggestion: 'Start one first',
        },
      };

      const formatted = formatSessionCompleteForLLM(result);
      expect(formatted).toContain('Failed to complete session');
      expect(formatted).toContain('No active session');
      expect(formatted).toContain('Start one first');
    });
  });

  describe('sprint closeout guardrail', () => {
    it('warns when all sprint missions are completed', async () => {
      // Add all-completed missions and a fresh active session
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status, completed_at)
        VALUES
          ('m-01', 'sprint-16', 'Mission 1', 'Completed', '2024-02-01T10:00:00Z'),
          ('m-02', 'sprint-16', 'Mission 2', 'Completed', '2024-02-01T11:00:00Z');
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES ('closeout-sess-1', 'check-in', 'Closeout Test', 'sprint-16', '2024-02-01T12:00:00Z', 'active', '[]');
      `);
      db.close();

      CmosDetector.resetInstance();

      const result = await cmosSessionComplete({
        sessionId: 'closeout-sess-1',
        summary: 'Session done',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const warnings = (result as { warnings?: string[] }).warnings ?? [];
      expect(warnings.some((w: string) => w.includes('All sprint missions are complete'))).toBe(
        true
      );
    });

    it('does not warn when missions remain incomplete', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status)
        VALUES
          ('m-01', 'sprint-16', 'Mission 1', 'Completed'),
          ('m-02', 'sprint-16', 'Mission 2', 'In Progress');
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES ('closeout-sess-2', 'check-in', 'Closeout Test 2', 'sprint-16', '2024-02-01T12:00:00Z', 'active', '[]');
      `);
      db.close();

      CmosDetector.resetInstance();

      const result = await cmosSessionComplete({
        sessionId: 'closeout-sess-2',
        summary: 'Session done',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const warnings = (result as { warnings?: string[] }).warnings ?? [];
      expect(warnings.some((w: string) => w.includes('All sprint missions are complete'))).toBe(
        false
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sprint 55 m02: Persist decisions[] to strategic_decisions
  //
  // Bug: cmos_session(complete) accepted no decisions[] param at all, so
  // OODS-Foundry-MCP retros were losing entire decision corpora (sprint-90: 10
  // decisions passed, 0 persisted, cmos_decisions(list) only found 2 rows that
  // were later hand-backfilled). The capture path worked; only the session-
  // complete batch path was broken. Fix adds a decisions[] param that inserts
  // each trimmed entry into strategic_decisions, deduped by (text, author_session_id),
  // with sprint_id inherited from the session and project_domain from metadata.
  // FTS5 population is automatic via the decisions_fts_insert trigger.
  // ---------------------------------------------------------------------------
  describe('Sprint 55 m02: decisions[] persistence', () => {
    // Clean session with no decision-category captures, used to isolate the
    // decisions[] param behavior from the captures-array audit extraction.
    const cleanSessionId = 'PS-2024-02-01-002';
    function seedCleanSession() {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES (
          '${cleanSessionId}',
          'review',
          'Clean Session',
          'sprint-16',
          '2024-02-01T10:00:00Z',
          'active',
          '[]'
        );
      `);
      db.close();
    }

    it('inserts each decisions[] entry as a strategic_decisions row with sprint_id from the session', async () => {
      const result = await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'Closing sprint with decisions',
        decisions: ['Adopt connection pooling for PG clients', 'Cap message payloads at 50KB'],
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsExtracted).toBeGreaterThanOrEqual(2);

      const db = new Database(dbPath);
      const rows = db
        .prepare(
          `SELECT decision_text, sprint_id, project_domain, author_session_id AS session_id
             FROM strategic_decisions
            WHERE author_session_id = ?
            ORDER BY id ASC`
        )
        .all(activeSessionId) as Array<{
        decision_text: string;
        sprint_id: string | null;
        project_domain: string | null;
        session_id: string;
      }>;
      db.close();

      const texts = rows.map((r) => r.decision_text);
      expect(texts).toContain('Adopt connection pooling for PG clients');
      expect(texts).toContain('Cap message payloads at 50KB');
      const pooling = rows.find((r) => r.decision_text.startsWith('Adopt connection pooling'));
      expect(pooling?.sprint_id).toBe('sprint-16');
      expect(pooling?.project_domain).toBe('cmos-mcp');
      expect(pooling?.session_id).toBe(activeSessionId);
    });

    it('deduplicates decisions already present for the same session', async () => {
      seedCleanSession();
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, author_session_id)
         VALUES (?, ?, ?, ?)`
      ).run(
        'Adopt connection pooling for PG clients',
        '2024-02-01T08:00:00Z',
        'sprint-16',
        cleanSessionId
      );
      db.close();

      const result = await cmosSessionComplete({
        sessionId: cleanSessionId,
        summary: 'Closing sprint with a duplicate',
        decisions: [
          'Adopt connection pooling for PG clients', // duplicate — should dedup
          'Cap message payloads at 50KB', // new
        ],
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsExtracted).toBe(1); // only the new one

      const db2 = new Database(dbPath);
      const count = (
        db2
          .prepare(
            `SELECT COUNT(*) as c FROM strategic_decisions
              WHERE decision_text = ? AND author_session_id = ?`
          )
          .get('Adopt connection pooling for PG clients', cleanSessionId) as { c: number }
      ).c;
      db2.close();
      expect(count).toBe(1);
    });

    it('filters empty and whitespace-only decisions entries', async () => {
      seedCleanSession();
      const result = await cmosSessionComplete({
        sessionId: cleanSessionId,
        summary: 'Closing with malformed decisions',
        decisions: ['', '   ', 'Real decision', '  '],
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsExtracted).toBe(1);

      const db = new Database(dbPath);
      const rows = db
        .prepare(
          `SELECT decision_text FROM strategic_decisions WHERE author_session_id = ? ORDER BY id ASC`
        )
        .all(cleanSessionId) as Array<{ decision_text: string }>;
      db.close();
      expect(rows.map((r) => r.decision_text)).toEqual(['Real decision']);
    });

    it('omitting decisions[] on a session with no decision captures extracts nothing', async () => {
      seedCleanSession();
      const result = await cmosSessionComplete({
        sessionId: cleanSessionId,
        summary: 'Closing without decisions',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsExtracted).toBe(0);

      const db = new Database(dbPath);
      const count = (
        db
          .prepare(`SELECT COUNT(*) as c FROM strategic_decisions WHERE author_session_id = ?`)
          .get(cleanSessionId) as { c: number }
      ).c;
      db.close();
      expect(count).toBe(0);
    });

    it('also promotes decision-category captures from session.captures that were not already extracted', async () => {
      // Seed a session whose captures array contains a decision that never
      // went through cmos_session_capture. The session-complete path should
      // catch it via the captures-array audit pass.
      const seedDb = new Database(dbPath);
      seedDb.exec(`
        INSERT INTO sessions (id, type, title, sprint_id, started_at, status, captures)
        VALUES (
          'orphan-decision-session',
          'review',
          'Orphan decision',
          'sprint-16',
          '2024-02-10T09:00:00Z',
          'active',
          '${JSON.stringify([
            {
              category: 'decision',
              content: 'Orphan decision never extracted',
              timestamp: '2024-02-10T09:05:00Z',
            },
          ]).replace(/'/g, "''")}'
        );
      `);
      seedDb.close();

      const result = await cmosSessionComplete({
        sessionId: 'orphan-decision-session',
        summary: 'Closing session with orphan capture',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsExtracted).toBeGreaterThanOrEqual(1);

      const db = new Database(dbPath);
      const rows = db
        .prepare(
          `SELECT decision_text FROM strategic_decisions WHERE author_session_id = ? ORDER BY id ASC`
        )
        .all('orphan-decision-session') as Array<{ decision_text: string }>;
      db.close();
      expect(rows.map((r) => r.decision_text)).toContain('Orphan decision never extracted');
    });

    it('cmos_decisions(list, sprintId) returns rows inserted by session-complete', async () => {
      // End-to-end proof: complete with decisions[], then query via the public
      // cmos_decisions list surface and confirm the rows are visible.
      await cmosSessionComplete({
        sessionId: activeSessionId,
        summary: 'E2E decisions flow',
        decisions: ['E2E decision about caching', 'E2E decision about retries'],
        projectRoot: tempDir,
      });

      const { cmosDecisions } = await import('../../../src/tools/cmos/cmos-decisions');
      const listResult = await cmosDecisions({
        action: 'list',
        sprintId: 'sprint-16',
        projectRoot: tempDir,
      });

      expect(listResult.success).toBe(true);
      const listed = (listResult.data as { decisions: Array<{ decision: string }> }).decisions;
      const texts = listed.map((d) => d.decision);
      expect(texts).toContain('E2E decision about caching');
      expect(texts).toContain('E2E decision about retries');
    });
  });
});
