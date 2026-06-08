/**
 * cmos_agent_onboard v2 Tests — projectIdentity + lastSession
 *
 * Tests the Context v2 Sprint 50 additions:
 * - projectIdentity field (Layer 0: full project identity)
 * - lastSession field (Layer 2: tier-aware session memory)
 *
 * @module tests/tools/cmos/cmos-agent-onboard-v2
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';

// ─── Test helpers ────────────────────────────────────────────────────────────

const MINIMAL_DB_SCHEMA = `
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

  CREATE TABLE strategic_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id TEXT NOT NULL DEFAULT 'master_context',
    decision_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sprint_id TEXT,
    snapshot_id INTEGER,
    project_domain TEXT
  );

  CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE next_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_session_id TEXT,
    source_sprint_id TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
`;

function makeTempCmosDir(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-onboard-v2-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(MINIMAL_DB_SCHEMA);

  // Minimal master_context for onboard
  db.exec(`
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'master_context',
      'cmos/context/MASTER_CONTEXT.json',
      '{"project":{"name":"Test Project","description":"A test CMOS project","status":"active_development"}}',
      datetime('now')
    )
  `);

  db.close();
  return { tempDir, dbPath };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ─── projectIdentity field ────────────────────────────────────────────────────

describe('cmos_agent_onboard v2 — projectIdentity field', () => {
  let tempDir: string;

  beforeEach(() => {
    ({ tempDir } = makeTempCmosDir());
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('includes projectIdentity in the onboard response', async () => {
    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.projectIdentity).toBeDefined();
  });

  it('projectIdentity has correct identity_contract_version', async () => {
    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.data?.projectIdentity?.identity_contract_version).toBe('v1');
  });

  it('projectIdentity has platform=aquex.ai', async () => {
    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.data?.projectIdentity?.platform).toBe('aquex.ai');
  });

  it('projectIdentity seeds project_name from master_context', async () => {
    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.data?.projectIdentity?.project_name).toBe('Test Project');
  });

  it('projectIdentity includes all required array fields', async () => {
    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    const pi = result.data?.projectIdentity;
    expect(Array.isArray(pi?.objectives)).toBe(true);
    expect(Array.isArray(pi?.related_projects)).toBe(true);
    expect(Array.isArray(pi?.foundational_docs)).toBe(true);
    expect(Array.isArray(pi?.tracelab_refs)).toBe(true);
  });

  it('calling onboard twice does not duplicate the project_identity row', async () => {
    await cmosAgentOnboard({ projectRoot: tempDir });
    await cmosAgentOnboard({ projectRoot: tempDir });

    const db = new Database(require('path').join(tempDir, 'cmos', 'db', 'cmos.sqlite'));
    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM contexts WHERE id = 'project_identity'")
      .get() as { cnt: number };
    db.close();

    expect(count.cnt).toBe(1);
  });
});

// ─── lastSession field ────────────────────────────────────────────────────────

describe('cmos_agent_onboard v2 — lastSession field (build tier)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ tempDir, dbPath } = makeTempCmosDir());
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('lastSession is null when no completed sessions exist', async () => {
    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.lastSession).toBeNull();
  });

  it('lastSession includes the most recent completed session', async () => {
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, completed_at, summary, captures)
      VALUES
        ('PS-001', 'planning', 'First Session', '2026-01-01T10:00:00Z', 'completed',
         '2026-01-01T12:00:00Z', 'We planned the sprint', '[]'),
        ('PS-002', 'review', 'Second Session', '2026-01-02T10:00:00Z', 'completed',
         '2026-01-02T12:00:00Z', 'We reviewed the sprint', '[]')
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.data?.lastSession?.id).toBe('PS-002');
    expect(result.data?.lastSession?.title).toBe('Second Session');
  });

  it('lastSession does not include active (incomplete) sessions', async () => {
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, captures)
      VALUES ('PS-active', 'planning', 'Active Session', '2026-01-01T10:00:00Z', 'active', '[]')
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.data?.lastSession).toBeNull();
  });

  it('lastSession.summary reflects the session summary field', async () => {
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, completed_at, summary, captures)
      VALUES ('PS-sum', 'check-in', 'Check-in', '2026-01-01T10:00:00Z', 'completed',
              '2026-01-01T11:00:00Z', 'Reviewed mission progress', '[]')
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    expect(result.data?.lastSession?.summary).toBe('Reviewed mission progress');
  });

  it('lastSession includes decisions from captures for build tier', async () => {
    const db = new Database(dbPath);
    const captures = JSON.stringify([
      { category: 'decision', content: 'Use FTS5 for retrieval' },
      { category: 'decision', content: 'IRetriever as abstraction' },
      { category: 'learning', content: 'FTS5 is fast' },
    ]);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, completed_at, captures)
      VALUES ('PS-dec', 'planning', 'Planning', '2026-01-01T10:00:00Z', 'completed',
              '2026-01-01T11:00:00Z', '${captures.replace(/'/g, "''")}')
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    const ls = result.data?.lastSession;
    expect(ls?.decisions).toEqual(['Use FTS5 for retrieval', 'IRetriever as abstraction']);
    expect(ls?.nextSteps).toEqual([]);
  });

  it('lastSession includes open items from next_steps table for build tier', async () => {
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, completed_at, captures)
      VALUES ('PS-ns', 'planning', 'Planning', '2026-01-01T10:00:00Z', 'completed',
              '2026-01-01T11:00:00Z', '[]');

      INSERT INTO next_steps (content, status, created_at)
      VALUES
        ('Write tests for FTS5Retriever', 'pending', '2026-01-01T10:00:00Z'),
        ('Update project identity doc', 'pending', '2026-01-01T10:00:00Z'),
        ('Deploy to staging', 'completed', '2026-01-01T10:00:00Z')
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    const openItems = result.data?.lastSession?.openItems ?? [];
    // Only pending items should be included
    expect(openItems.length).toBe(2);
    expect(openItems).not.toContain('Deploy to staging');
  });
});

describe('cmos_agent_onboard v2 — lastSession field (general tier)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ tempDir, dbPath } = makeTempCmosDir());

    // Set tier to general
    const db = new Database(dbPath);
    db.exec(`INSERT INTO metadata (key, value) VALUES ('project_type', 'general')`);
    db.close();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('general tier lastSession includes openItems but not decisions/nextSteps', async () => {
    const db = new Database(dbPath);
    const captures = JSON.stringify([
      { category: 'decision', content: 'Important decision' },
      { category: 'next-step', content: 'Next action' },
    ]);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, completed_at, captures)
      VALUES ('PS-gen', 'check-in', 'Check-in', '2026-01-01T10:00:00Z', 'completed',
              '2026-01-01T11:00:00Z', '${captures.replace(/'/g, "''")}');
      INSERT INTO next_steps (content, status, created_at)
      VALUES ('Open item', 'pending', '2026-01-01T10:00:00Z')
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    const ls = result.data?.lastSession;
    expect(ls?.openItems).toBeDefined();
    // General tier: no decisions or nextSteps fields
    expect(ls?.decisions).toBeUndefined();
    expect(ls?.nextSteps).toBeUndefined();
  });
});

describe('cmos_agent_onboard v2 — lastSession field (managed tier)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ tempDir, dbPath } = makeTempCmosDir());

    // Set tier to managed — need at least 1 mission to avoid sprintZeroReady
    const db = new Database(dbPath);
    db.exec(`
      INSERT INTO metadata (key, value) VALUES ('project_type', 'managed');
      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES ('master_context', 'ctx/MC.json',
        '{"project":{"name":"Managed Proj"},"project_brief":"PROJECT BRIEF: yes"}',
        datetime('now'))
      ON CONFLICT(id) DO UPDATE SET content=excluded.content;
    `);
    db.close();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('managed tier lastSession includes decisions and nextSteps but not openItems', async () => {
    const db = new Database(dbPath);
    const captures = JSON.stringify([
      { category: 'decision', content: 'Important managed decision' },
      { category: 'next-step', content: 'Next managed action' },
    ]);
    db.exec(`
      INSERT INTO sessions (id, type, title, started_at, status, completed_at, captures)
      VALUES ('PS-mgd', 'check-in', 'Check-in', '2026-01-01T10:00:00Z', 'completed',
              '2026-01-01T11:00:00Z', '${captures.replace(/'/g, "''")}');
    `);
    db.close();

    const result = await cmosAgentOnboard({ projectRoot: tempDir });
    const ls = result.data?.lastSession;
    expect(ls?.decisions).toEqual(['Important managed decision']);
    expect(ls?.nextSteps).toEqual(['Next managed action']);
    // Managed tier: no openItems field
    expect(ls?.openItems).toBeUndefined();
  });
});
