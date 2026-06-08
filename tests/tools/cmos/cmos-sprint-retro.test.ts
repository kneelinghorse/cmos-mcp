/**
 * cmos_sprint retro action tests
 *
 * Tests for auto-generated sprint retrospective reports.
 *
 * @module tests/tools/cmos/cmos-sprint-retro
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprint,
  formatSprintForLLM,
  CMOS_SPRINT_ACTIONS,
} from '../../../src/tools/cmos/cmos-sprint';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import type { SprintRetroResult } from '../../../src/tools/cmos/cmos-sprint-retro';

describe('cmos_sprint retro action', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprint-retro-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
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
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        category TEXT,
        status TEXT DEFAULT 'active',
        evidence TEXT,
        superseded_by INTEGER,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT
      );

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        sprint_id TEXT,
        session_id TEXT,
        mission_id TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT,
        title TEXT,
        status TEXT,
        sprint_id TEXT,
        summary TEXT,
        captures TEXT,
        next_steps TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Insert a sprint
    db.prepare(
      'INSERT INTO sprints (id, title, focus, status, start_date) VALUES (?, ?, ?, ?, ?)'
    ).run('sprint-35', 'Sync Verification', 'Verify sync pipeline', 'Completed', '2026-03-01');

    // Insert missions
    const insertMission = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertMission.run(
      's35-m01',
      'sprint-35',
      'Live Purge & Re-Backfill',
      'Completed',
      'Fixed sprint_added payload. 710 events pushed.',
      '2026-03-01T10:00:00Z',
      '2026-03-01T14:00:00Z'
    );
    insertMission.run(
      's35-m02',
      'sprint-35',
      'Orphan Detection Bugfix',
      'Completed',
      'Stale MCP server was root cause, no code change needed.',
      '2026-03-01T15:00:00Z',
      '2026-03-01T16:00:00Z'
    );
    insertMission.run(
      's35-m03',
      'sprint-35',
      'Decision Hygiene',
      'Completed',
      '41 active decisions → 7. 34 archived/superseded.',
      '2026-03-01T17:00:00Z',
      '2026-03-01T19:00:00Z'
    );
    insertMission.run(
      's35-m04',
      'sprint-35',
      'Sprint 36+ Roadmap',
      'Blocked',
      'Waiting on dashboard team input.',
      '2026-03-01T20:00:00Z',
      null
    );

    // Insert decisions
    const insertDecision = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, category, status)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertDecision.run(
      'Use event sourcing for audit trail',
      '2026-03-01T12:00:00Z',
      'sprint-35',
      'architectural',
      'active'
    );
    insertDecision.run(
      'Sprint 36 theme: Intelligence & DX',
      '2026-03-01T18:00:00Z',
      'sprint-35',
      null,
      'active'
    );
    insertDecision.run(
      'Decision hygiene complete',
      '2026-03-01T19:30:00Z',
      'sprint-35',
      'process',
      'archived'
    );

    // Insert learnings
    db.prepare(`INSERT INTO learnings (content, category, sprint_id) VALUES (?, ?, ?)`).run(
      'Stale MCP server causes phantom bugs',
      'technical',
      'sprint-35'
    );

    // Insert session
    db.prepare(
      `INSERT INTO sessions (id, type, title, status, sprint_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'sess-001',
      'planning',
      'Sprint 35 Planning',
      'completed',
      'sprint-35',
      '2026-03-01T09:00:00Z',
      '2026-03-01T09:30:00Z'
    );

    db.close();
    CmosDetector.getInstance().clearCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    CmosDetector.getInstance().clearCache();
  });

  it('includes retro in CMOS_SPRINT_ACTIONS', () => {
    expect(CMOS_SPRINT_ACTIONS).toContain('retro');
  });

  it('generates a retrospective with all data sections', async () => {
    const result = await cmosSprint({
      action: 'retro',
      sprintId: 'sprint-35',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintRetroResult;

    // Sprint metadata
    expect(data.sprint.id).toBe('sprint-35');
    expect(data.sprint.title).toBe('Sync Verification');
    expect(data.sprint.focus).toBe('Verify sync pipeline');

    // Missions
    expect(data.missions).toHaveLength(4);
    expect(data.missions[0].id).toBe('s35-m01');
    expect(data.missions[0].status).toBe('Completed');

    // Decisions
    expect(data.decisions).toHaveLength(3);

    // Learnings
    expect(data.learnings).toHaveLength(1);
    expect(data.learnings[0].content).toContain('phantom bugs');

    // KPIs
    expect(data.kpis.totalMissions).toBe(4);
    expect(data.kpis.completedMissions).toBe(3);
    expect(data.kpis.blockedMissions).toBe(1);
    expect(data.kpis.completionRate).toBe(75);
    expect(data.kpis.totalDecisions).toBe(3);
    expect(data.kpis.totalLearnings).toBe(1);
    expect(data.kpis.totalSessions).toBe(1);
    expect(data.kpis.avgCycleTimeDays).not.toBeNull();

    // Carry-forwards
    expect(data.carryForwards).toHaveLength(1);
    expect(data.carryForwards[0].type).toBe('blocked_mission');
    expect(data.carryForwards[0].missionId).toBe('s35-m04');

    // Commit summary
    expect(data.commitSummary).toContain('Sprint 35');
    expect(data.commitSummary).toContain('3/4');
    expect(data.commitSummary).toContain('s35-m01');
  });

  it('computes cycle time for completed missions', async () => {
    const result = await cmosSprint({
      action: 'retro',
      sprintId: 'sprint-35',
      projectRoot: tempDir,
    });

    const data = result.data as SprintRetroResult;
    const m01 = data.missions.find((m) => m.id === 's35-m01')!;
    // 4 hours = ~0.17 days
    expect(m01.cycleTimeDays).toBeGreaterThan(0);
    expect(m01.cycleTimeDays).toBeLessThan(1);
  });

  it('returns error for non-existent sprint', async () => {
    const result = await cmosSprint({
      action: 'retro',
      sprintId: 'sprint-999',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('not found');
  });

  it('returns error when sprintId is missing', async () => {
    const result = await cmosSprint({
      action: 'retro',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
  });

  it('formats retro output for LLM', async () => {
    const result = await cmosSprint({
      action: 'retro',
      sprintId: 'sprint-35',
      projectRoot: tempDir,
    });

    const formatted = formatSprintForLLM('retro', result);
    expect(formatted).toContain('Sprint Retrospective');
    expect(formatted).toContain('KPIs');
    expect(formatted).toContain('Missions');
    expect(formatted).toContain('Decisions');
    expect(formatted).toContain('Learnings');
    expect(formatted).toContain('Carry-Forwards');
    expect(formatted).toContain('Git Commit Summary');
    expect(formatted).toContain('75%');
  });

  it('handles sprint with no missions', async () => {
    const db = new Database(dbPath);
    db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)').run(
      'sprint-empty',
      'Empty Sprint',
      'Active'
    );
    db.close();
    CmosDetector.getInstance().clearCache();

    const result = await cmosSprint({
      action: 'retro',
      sprintId: 'sprint-empty',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintRetroResult;
    expect(data.missions).toHaveLength(0);
    expect(data.kpis.totalMissions).toBe(0);
    expect(data.kpis.completionRate).toBe(0);
    expect(data.commitSummary).toContain('0/0');
  });

  it('generates commit summary compatible with existing format', async () => {
    const result = await cmosSprint({
      action: 'retro',
      sprintId: 'sprint-35',
      projectRoot: tempDir,
    });

    const data = result.data as SprintRetroResult;
    const lines = data.commitSummary.split('\n');

    // First line: header
    expect(lines[0]).toMatch(/^Sprint \d+:.+— .+ \(\d+\/\d+\)$/);

    // Second line: table header
    expect(lines[1]).toContain('Mission');
    expect(lines[1]).toContain('Name');
    expect(lines[1]).toContain('Deliverables');

    // Mission rows follow
    expect(lines[2]).toContain('s35-m01');
  });
});
