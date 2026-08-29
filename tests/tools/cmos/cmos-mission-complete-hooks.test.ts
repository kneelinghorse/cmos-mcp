/**
 * cmos_mission_complete lifecycle hook tests
 *
 * Verifies master_context aggregation on mission and sprint completion.
 *
 * @module tests/tools/cmos/cmos-mission-complete-hooks
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosMissionComplete } from '../../../src/tools/cmos/cmos-mission-complete';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

interface HookTestDb {
  tempDir: string;
  dbPath: string;
}

function createHookTestDb(): HookTestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-mission-complete-hooks-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

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
      created_at TEXT NOT NULL
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

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
      source_chunk_ids TEXT
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

    INSERT INTO metadata (key, value) VALUES
      ('project_name', 'CMOS-MCP'),
      ('project_description', 'Mission management MCP server'),
      ('project_status', 'active_development'),
      ('project_domain', 'cmos-mcp'),
      ('tracelab_project_id', '33f15bbb-c194-4645-82e8-fa768618e04f');

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'master_context',
      'context/MASTER_CONTEXT.json',
      '{"project_identity":{"name":"Old Name"},"decisions_made":["existing decision"],"learnings":["existing learning"],"constraints":[]}',
      '2026-01-01T00:00:00Z'
    );

    INSERT INTO sprints (id, title, focus, status) VALUES
      ('sprint-a', 'Sprint A', 'General delivery', 'In Progress'),
      ('sprint-b', 'Sprint B', 'Single mission sprint', 'In Progress');

    INSERT INTO missions (id, sprint_id, name, status, objective) VALUES
      ('m-a1', 'sprint-a', 'Sprint A Mission 1', 'In Progress', 'Deliver feature A1'),
      ('m-a2', 'sprint-a', 'Sprint A Mission 2', 'Queued', 'Deliver feature A2'),
      ('m-b1', 'sprint-b', 'Sprint B Mission 1', 'In Progress', 'Deliver feature B1');
  `);
  db.close();

  CmosDetector.resetInstance();
  return { tempDir, dbPath };
}

function readMasterContext(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT content FROM contexts WHERE id = ?').get('master_context') as {
    content: string;
  };
  db.close();
  return JSON.parse(row.content);
}

function countSnapshots(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare('SELECT COUNT(*) as count FROM context_snapshots WHERE context_id = ?')
    .get('master_context') as { count: number };
  db.close();
  return row.count;
}

describe('cmos_mission_complete lifecycle hooks', () => {
  let testDb: HookTestDb;

  beforeEach(() => {
    testDb = createHookTestDb();
  });

  afterEach(() => {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  });

  it('adds mission summary to master_context and creates snapshot on completion', async () => {
    const beforeSnapshots = countSnapshots(testDb.dbPath);

    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      notes: 'Implemented and verified',
    });

    expect(result.success).toBe(true);
    expect(result.data?.contextAggregated).toBe(true);
    expect(result.data?.sprintSummaryAdded).toBe(false);
    expect(result.data?.contextSnapshotId).toBeDefined();

    const masterContext = readMasterContext(testDb.dbPath);
    // completed_missions no longer stored in blob (Sprint 51 blob reduction — queryable from missions table).
    expect(masterContext.completed_missions).toBeUndefined();

    // Identity sync from metadata should update project_identity.
    const identity = masterContext.project_identity as Record<string, unknown>;
    expect(identity.name).toBe('CMOS-MCP');
    expect(identity.description).toBe('Mission management MCP server');
    expect(identity.status).toBe('active_development');

    const afterSnapshots = countSnapshots(testDb.dbPath);
    expect(afterSnapshots).toBeGreaterThan(beforeSnapshots);
  });

  it('creates strategic_decisions when decisions param is provided', async () => {
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      notes: 'Implemented feature A1',
      decisions: ['Use TypeScript for all new tools', 'Follow CmosToolResult pattern'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.decisionCount).toBe(2);
    expect(result.data?.sprintDecisionCount).toBe(2);

    // Verify decisions were inserted
    const db = new Database(testDb.dbPath);
    const decisions = db
      .prepare('SELECT decision_text, sprint_id, mission_id FROM strategic_decisions ORDER BY id')
      .all() as Array<{
      decision_text: string;
      sprint_id: string | null;
      mission_id: string | null;
    }>;
    db.close();

    expect(decisions).toHaveLength(2);
    expect(decisions[0].decision_text).toBe('Use TypeScript for all new tools');
    expect(decisions[0].sprint_id).toBe('sprint-a');
    expect(decisions[0].mission_id).toBe('m-a1');
    expect(decisions[1].decision_text).toBe('Follow CmosToolResult pattern');
  });

  it('adds warning when decisions param is omitted', async () => {
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      notes: 'No decisions captured',
    });

    expect(result.success).toBe(true);
    expect(result.data?.decisionCount).toBe(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('No decisions captured'))).toBe(true);
  });

  it('adds warning when decisions param is empty array', async () => {
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      decisions: [],
    });

    expect(result.success).toBe(true);
    expect(result.data?.decisionCount).toBe(0);
    expect(result.warnings!.some((w) => w.includes('No decisions captured'))).toBe(true);
  });

  it('returns sprintDecisionCount across missions', async () => {
    // Complete m-a1 with decisions
    await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      decisions: ['Decision from first mission'],
    });

    CmosDetector.resetInstance();

    // Complete m-a2 (need to transition to In Progress first)
    const db = new Database(testDb.dbPath);
    db.prepare("UPDATE missions SET status = 'In Progress' WHERE id = 'm-a2'").run();
    db.close();

    CmosDetector.resetInstance();

    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a2',
      decisions: ['Decision from second mission'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.decisionCount).toBe(1);
    expect(result.data?.sprintDecisionCount).toBe(2);
  });

  it('adds warning when mission completes with 0 learnings', async () => {
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      notes: 'Done but no learnings',
      decisions: ['A decision'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.learningCount).toBe(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('No learnings captured for this mission'))).toBe(
      true
    );
  });

  it('does not warn about learnings when mission has 1+ learnings', async () => {
    // Insert a learning for mission m-a1
    const db = new Database(testDb.dbPath);
    db.prepare(
      `INSERT INTO learnings (content, category, sprint_id, mission_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('Learned something useful', 'technical', 'sprint-a', 'm-a1', new Date().toISOString());
    db.close();

    CmosDetector.resetInstance();

    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      notes: 'Done with learnings',
      decisions: ['A decision'],
    });

    expect(result.success).toBe(true);
    expect(result.data?.learningCount).toBe(1);
    // Should NOT have the learning warning
    const learningWarnings = (result.warnings ?? []).filter((w) =>
      w.includes('No learnings captured for this mission')
    );
    expect(learningWarnings).toHaveLength(0);
  });

  it('adds sprint summary when last mission in sprint is completed', async () => {
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-b1',
      notes: 'Completed final sprint-b mission',
    });

    expect(result.success).toBe(true);
    expect(result.data?.contextAggregated).toBe(true);
    // sprintSummaryAdded is always false — completed_sprints no longer stored in blob (Sprint 51).
    expect(result.data?.sprintSummaryAdded).toBe(false);

    const masterContext = readMasterContext(testDb.dbPath);
    // completed_sprints no longer stored in blob (Sprint 51 blob reduction — queryable from sprints table).
    expect(masterContext.completed_sprints).toBeUndefined();
  });

  it('warns to close sprint when completing the last mission', async () => {
    // m-b1 is the only mission in sprint-b
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-b1',
      notes: 'Last mission done',
      decisions: ['Final decision'],
    });

    expect(result.success).toBe(true);
    const sprintCloseoutWarnings = (result.warnings ?? []).filter((w) =>
      w.includes('last mission in sprint-b')
    );
    expect(sprintCloseoutWarnings).toHaveLength(1);
    expect(sprintCloseoutWarnings[0]).toContain('cmos_sprint(action="complete")');
  });

  it('does not warn to close a sprint that is already completed', async () => {
    const db = new Database(testDb.dbPath);
    db.exec(`
      INSERT INTO sprints (id, title, focus, status)
      VALUES ('sprint-completed', 'Completed Sprint', 'Already closed', 'Completed');
      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES (
        'm-completed-sprint',
        'sprint-completed',
        'Final mission in completed sprint',
        'In Progress',
        'Finish work without reopening sprint closeout'
      );
    `);
    db.close();

    CmosDetector.resetInstance();

    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-completed-sprint',
      notes: 'Final work completed after sprint close',
      decisions: ['Preserve completed sprint status'],
    });

    expect(result.success).toBe(true);
    const sprintCloseoutWarnings = (result.warnings ?? []).filter((warning) =>
      warning.includes('cmos_sprint(action="complete")')
    );
    expect(sprintCloseoutWarnings).toHaveLength(0);
  });

  it('does not warn about sprint closeout when other missions remain', async () => {
    // m-a1 is one of two missions in sprint-a
    const result = await cmosMissionComplete({
      projectRoot: testDb.tempDir,
      missionId: 'm-a1',
      notes: 'First mission done',
      decisions: ['A decision'],
    });

    expect(result.success).toBe(true);
    const sprintCloseoutWarnings = (result.warnings ?? []).filter((w) =>
      w.includes('last mission in')
    );
    expect(sprintCloseoutWarnings).toHaveLength(0);
  });
});
