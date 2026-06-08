// ABOUTME: End-to-end tests for the agentFeedback standing channel (Sprint 56 m03).
// ABOUTME: Covers writes from 3 surfaces + the cmos_feedback list/triage/resolve/archive review tool.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { cmosSessionStart } from '../../../src/tools/cmos/cmos-session-start';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import { cmosMissionTransition } from '../../../src/tools/cmos/cmos-mission-transition';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
import {
  cmosFeedback,
  type CmosFeedbackListResult,
  type CmosFeedbackMutationResult,
} from '../../../src/tools/cmos/cmos-feedback';

interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-feedback-'));
  const cmosDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDir, { recursive: true });
  const dbPath = path.join(cmosDir, 'cmos.sqlite');
  const db = new Database(dbPath);

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project');
    INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    INSERT INTO metadata (key, value) VALUES ('schema_version', '2.2');

    CREATE TABLE sprints (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT,
      start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL,
      completed_at TEXT, notes TEXT, objective TEXT, context TEXT,
      success_criteria TEXT, deliverables TEXT, reference_docs TEXT,
      domain_fields TEXT, created_at TEXT, started_at TEXT, updated_at TEXT, metadata TEXT
    );

    CREATE TABLE contexts (
      id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT
    );

    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT,
      source TEXT NOT NULL, content_hash TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT,
      started_at TEXT NOT NULL, completed_at TEXT, agent TEXT,
      status TEXT NOT NULL DEFAULT 'active', summary TEXT,
      captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT
    );

    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent TEXT, mission TEXT,
      action TEXT, status TEXT, summary TEXT, next_hint TEXT, raw_event TEXT NOT NULL
    );

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL DEFAULT 'master_context',
      decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT,
      snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT,
      source_chunk_ids TEXT, category TEXT, superseded_by INTEGER,
      status TEXT NOT NULL DEFAULT 'active', evidence TEXT, content_hash TEXT
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT,
      status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT,
      mission_id TEXT, created_at TEXT NOT NULL, content_hash TEXT
    );

    CREATE TABLE constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', session_id TEXT, sprint_id TEXT,
      created_at TEXT NOT NULL, expires_at TEXT, content_hash TEXT
    );

    CREATE TABLE next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, sprint_id TEXT,
      mission_id TEXT, created_at TEXT NOT NULL, updated_at TEXT,
      completed_at TEXT, content_hash TEXT
    );

    CREATE TABLE session_missions (
      session_id TEXT NOT NULL, mission_id TEXT NOT NULL, linked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'capture', PRIMARY KEY (session_id, mission_id)
    );

    INSERT INTO sprints (id, title, focus, status)
    VALUES ('sprint-56', 'Sprint 56', 'Agent UX', 'Active');

    INSERT INTO missions (id, sprint_id, name, status, objective, started_at)
    VALUES ('s56-seed', 'sprint-56', 'Seed mission', 'In Progress', 'A seeded mission', '2026-04-17T00:00:00Z');

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"Test"}}', '2024-01-10T12:00:00Z'),
      ('project_context', 'context/PROJECT_CONTEXT.json', '{"working_memory":{"next_steps":[]}}', '2024-01-10T12:00:00Z');

    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
      decision_text, content='strategic_decisions', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
      INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
    END;
  `);

  return { tempDir, dbPath, db };
}

function cleanup(t: TestDb): void {
  t.db.close();
  fs.rmSync(t.tempDir, { recursive: true, force: true });
}

describe('agentFeedback write paths', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    CmosDetector.resetInstance();
  });

  afterEach(() => cleanup(t));

  it('cmos_session_complete persists agentFeedback with session+sprint context', async () => {
    const start = await cmosSessionStart({
      type: 'planning',
      title: 'feedback session',
      sprintId: 'sprint-56',
      projectRoot: t.tempDir,
    });
    const sessionId = start.data!.sessionId;

    const result = await cmosSessionComplete({
      sessionId,
      summary: 'wrapping up',
      agentFeedback: 'The onboard payload was surprisingly slow on a polluted registry.',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.feedbackId).toBeGreaterThan(0);

    const row = t.db
      .prepare(
        'SELECT tool_name, session_id, sprint_id, status, body FROM agent_feedback WHERE id = ?'
      )
      .get(result.data!.feedbackId) as {
      tool_name: string;
      session_id: string;
      sprint_id: string;
      status: string;
      body: string;
    };
    expect(row.tool_name).toBe('cmos_session_complete');
    expect(row.session_id).toBe(sessionId);
    expect(row.sprint_id).toBe('sprint-56');
    expect(row.status).toBe('open');
    expect(row.body).toContain('polluted registry');
  });

  it('cmos_session_complete sanitizes XML artifacts in agentFeedback', async () => {
    const start = await cmosSessionStart({
      type: 'planning',
      title: 'dirty feedback',
      sprintId: 'sprint-56',
      projectRoot: t.tempDir,
    });
    const sessionId = start.data!.sessionId;

    const result = await cmosSessionComplete({
      sessionId,
      summary: 'ok',
      agentFeedback:
        'Found an edge case in cmos_context_update.</content>\n<parameter name="missionId">s56-m02',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('agentFeedback');

    const row = t.db
      .prepare('SELECT body FROM agent_feedback WHERE id = ?')
      .get(result.data!.feedbackId) as { body: string };
    expect(row.body).toBe('Found an edge case in cmos_context_update.');
    expect(row.body).not.toContain('<parameter');
  });

  it('cmos_mission_transition(complete) persists agentFeedback with mission+sprint context', async () => {
    const result = await cmosMissionTransition({
      action: 'complete',
      missionId: 's56-seed',
      notes: 'done',
      agentFeedback: 'Decision-supersession detection fired 3 false positives on this one.',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as { feedbackId?: number };
    expect(data.feedbackId).toBeGreaterThan(0);

    const row = t.db
      .prepare('SELECT tool_name, mission_id, sprint_id FROM agent_feedback WHERE id = ?')
      .get(data.feedbackId!) as { tool_name: string; mission_id: string; sprint_id: string };
    expect(row.tool_name).toBe('cmos_mission_transition');
    expect(row.mission_id).toBe('s56-seed');
    expect(row.sprint_id).toBe('sprint-56');
  });

  it('cmos_agent_onboard persists agentFeedback without requiring active session', async () => {
    const result = await cmosAgentOnboard({
      agentFeedback: 'Suggested actions rotated while I was reading them — confusing.',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    const fbId = (result.data as { feedbackId?: number }).feedbackId;
    expect(fbId).toBeGreaterThan(0);

    const row = t.db
      .prepare('SELECT tool_name, body FROM agent_feedback WHERE id = ?')
      .get(fbId!) as { tool_name: string; body: string };
    expect(row.tool_name).toBe('cmos_agent_onboard');
    expect(row.body).toContain('Suggested actions');
  });

  it('omits feedbackId and writes no row when agentFeedback is not provided', async () => {
    const start = await cmosSessionStart({
      type: 'planning',
      title: 'no feedback',
      sprintId: 'sprint-56',
      projectRoot: t.tempDir,
    });
    const sessionId = start.data!.sessionId;
    const result = await cmosSessionComplete({
      sessionId,
      summary: 'nothing to report',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.feedbackId).toBeUndefined();
    // agent_feedback table is lazily created by recordAgentFeedback; when
    // agentFeedback is unset, the table should not even exist yet.
    const tableRow = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_feedback'")
      .get();
    expect(tableRow).toBeUndefined();
  });

  it('omits feedbackId when agentFeedback is only whitespace', async () => {
    const result = await cmosAgentOnboard({
      agentFeedback: '   \n  ',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect((result.data as { feedbackId?: number }).feedbackId).toBeUndefined();
  });
});

describe('cmos_feedback(action=list|triage|resolve|archive)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = createTestDb();
    CmosDetector.resetInstance();
    // Seed 3 rows via the real write path from different tools.
    await cmosAgentOnboard({
      agentFeedback: 'alpha — onboard one',
      projectRoot: t.tempDir,
    });
    await cmosAgentOnboard({
      agentFeedback: 'bravo — onboard two',
      projectRoot: t.tempDir,
    });
    await cmosMissionTransition({
      action: 'complete',
      missionId: 's56-seed',
      notes: 'done',
      agentFeedback: 'charlie — from mission',
      projectRoot: t.tempDir,
    });
  });

  afterEach(() => cleanup(t));

  it('list defaults to status=open, newest-first, with countsByTool', async () => {
    const result = await cmosFeedback({ action: 'list', projectRoot: t.tempDir });
    expect(result.success).toBe(true);
    const data = result.data as CmosFeedbackListResult;
    expect(data.entries.length).toBe(3);
    expect(data.entries[0].body).toContain('charlie');
    expect(data.countsByTool).toEqual({
      cmos_agent_onboard: 2,
      cmos_mission_transition: 1,
    });
    expect(data.countsByStatus.open).toBe(3);
  });

  it('list filters by toolName', async () => {
    const result = await cmosFeedback({
      action: 'list',
      toolName: 'cmos_agent_onboard',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    const data = result.data as CmosFeedbackListResult;
    expect(data.entries.length).toBe(2);
    expect(data.entries.every((e) => e.toolName === 'cmos_agent_onboard')).toBe(true);
  });

  it('triage transitions open → triaged', async () => {
    const list = await cmosFeedback({ action: 'list', projectRoot: t.tempDir });
    const firstId = (list.data as CmosFeedbackListResult).entries[0].id;
    const triaged = await cmosFeedback({
      action: 'triage',
      feedbackId: firstId,
      projectRoot: t.tempDir,
    });
    expect(triaged.success).toBe(true);
    const m = triaged.data as CmosFeedbackMutationResult;
    expect(m.previousStatus).toBe('open');
    expect(m.currentStatus).toBe('triaged');

    const listOpen = await cmosFeedback({ action: 'list', projectRoot: t.tempDir });
    expect((listOpen.data as CmosFeedbackListResult).entries.length).toBe(2);
    const listTriaged = await cmosFeedback({
      action: 'list',
      status: 'triaged',
      projectRoot: t.tempDir,
    });
    expect((listTriaged.data as CmosFeedbackListResult).entries.length).toBe(1);
  });

  it('resolve stamps resolved_at + resolution_note', async () => {
    const list = await cmosFeedback({ action: 'list', projectRoot: t.tempDir });
    const firstId = (list.data as CmosFeedbackListResult).entries[0].id;
    const resolved = await cmosFeedback({
      action: 'resolve',
      feedbackId: firstId,
      resolutionNote: 'shipped in s57-m01',
      projectRoot: t.tempDir,
    });
    expect(resolved.success).toBe(true);
    const m = resolved.data as CmosFeedbackMutationResult;
    expect(m.currentStatus).toBe('resolved');
    expect(m.resolutionNote).toBe('shipped in s57-m01');

    const row = t.db
      .prepare('SELECT status, resolved_at, resolution_note FROM agent_feedback WHERE id = ?')
      .get(firstId) as { status: string; resolved_at: string; resolution_note: string };
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolution_note).toBe('shipped in s57-m01');
  });

  it('archive moves to archived status', async () => {
    const list = await cmosFeedback({ action: 'list', projectRoot: t.tempDir });
    const firstId = (list.data as CmosFeedbackListResult).entries[0].id;
    const archived = await cmosFeedback({
      action: 'archive',
      feedbackId: firstId,
      projectRoot: t.tempDir,
    });
    expect(archived.success).toBe(true);
    expect((archived.data as CmosFeedbackMutationResult).currentStatus).toBe('archived');
  });

  it('mutations require feedbackId', async () => {
    const result = await cmosFeedback({ action: 'triage', projectRoot: t.tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  it('mutations on an unknown feedbackId return FEEDBACK_NOT_FOUND', async () => {
    const result = await cmosFeedback({
      action: 'triage',
      feedbackId: 99999,
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FEEDBACK_NOT_FOUND');
  });
});
