/**
 * Computed Context View Tests
 *
 * Tests that cmos_context_view assembles master_context from structured
 * tables (strategic_decisions, learnings) instead of JSON blob.
 *
 * @module tests/tools/cmos/computed-context-view
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosContextView } from '../../../src/tools/cmos/cmos-context-view';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('computed context view', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-computed-ctx-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT,
        start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER
      );
      CREATE TABLE missions (
        id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL,
        completed_at TEXT, notes TEXT, objective TEXT, context TEXT,
        success_criteria TEXT, deliverables TEXT, reference_docs TEXT,
        domain_fields TEXT, metadata TEXT
      );
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT
      );
      CREATE TABLE context_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL,
        session_id TEXT, source TEXT, content_hash TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT,
        agent TEXT, status TEXT NOT NULL DEFAULT 'active',
        summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT
      );
      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent TEXT, mission TEXT,
        action TEXT, status TEXT, summary TEXT, next_hint TEXT, raw_event TEXT NOT NULL
      );
      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT,
        snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT,
        source_chunk_ids TEXT, category TEXT, superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active', evidence TEXT
      );
      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
        category TEXT, status TEXT NOT NULL DEFAULT 'active',
        sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test');
      INSERT INTO sprints (id, title, status) VALUES ('sprint-1', 'Sprint 1', 'Active');
    `);
    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('populates decisions from strategic_decisions table, not JSON blob', async () => {
    const db = new Database(dbPath);
    // Insert decisions into structured table
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
       VALUES ('Use TypeScript everywhere', '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
       VALUES ('Deploy with Docker', '2026-01-02T00:00:00Z', 'sprint-1', 'active')`
    ).run();
    // Insert master_context with OLD decisions in JSON blob
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', ?, '2026-01-01')`
    ).run(
      JSON.stringify({
        decisions_made: ['Old blob decision that should NOT appear'],
        constraints: ['Must use HTTPS'],
      })
    );
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.aggregated.decisions).toContain('Use TypeScript everywhere');
    expect(result.data?.aggregated.decisions).toContain('Deploy with Docker');
    // Should NOT include the old blob decision
    expect(result.data?.aggregated.decisions).not.toContain(
      'Old blob decision that should NOT appear'
    );
  });

  it('returns empty decisions when strategic_decisions table is empty (no blob fallback — Sprint 51)', async () => {
    // decisions_made is no longer stored in the blob. When the strategic_decisions table
    // is empty, aggregated.decisions should be [] — not falling back to blob content.
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', ?, '2026-01-01')`
    ).run(
      JSON.stringify({
        decisions_made: ['Stale blob decision — should not appear'],
        constraints: [],
      })
    );
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.aggregated.decisions).toEqual([]);
  });

  it('populates learnings from learnings table, not JSON blob', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO learnings (content, created_at, sprint_id, status)
       VALUES ('TypeScript is great', '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', ?, '2026-01-01')`
    ).run(
      JSON.stringify({
        learnings: ['Old blob learning'],
      })
    );
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.aggregated.learnings).toContain('TypeScript is great');
    expect(result.data?.aggregated.learnings).not.toContain('Old blob learning');
  });

  it('keeps constraints from JSON blob (no dedicated table)', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', ?, '2026-01-01')`
    ).run(
      JSON.stringify({
        constraints: ['Must use HTTPS', 'No vendor lock-in'],
      })
    );
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.aggregated.constraints).toEqual(['Must use HTTPS', 'No vendor lock-in']);
  });

  it('excludes non-active decisions from aggregated view', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status)
       VALUES ('Active decision', '2026-01-01T00:00:00Z', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status)
       VALUES ('Superseded decision', '2026-01-01T00:00:00Z', 'superseded')`
    ).run();
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status)
       VALUES ('Stale decision', '2026-01-01T00:00:00Z', 'stale')`
    ).run();
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-01-01')`
    ).run();
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.aggregated.decisions).toEqual(['Active decision']);
  });

  it('includes healthMetrics in response', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status)
       VALUES ('Active one', '2026-01-01T00:00:00Z', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status)
       VALUES ('Stale one', '2026-01-01T00:00:00Z', 'stale')`
    ).run();
    db.prepare(
      `INSERT INTO learnings (content, created_at, status)
       VALUES ('Active learning', '2026-01-01T00:00:00Z', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-01-01')`
    ).run();
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    const metrics = result.data?.healthMetrics;
    expect(metrics).toBeDefined();
    expect(metrics?.activeDecisionCount).toBe(1);
    expect(metrics?.activeLearningCount).toBe(1);
    expect(metrics?.staleDecisionCount).toBe(1);
    expect(metrics?.recentSprintCount).toBe(1);
  });

  it('includes healthMetrics in compact mode', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-01-01')`
    ).run();
    db.close();

    const result = await cmosContextView({ compact: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.healthMetrics).toBeDefined();
    expect(result.data?.mode).toBe('compact');
  });

  it('includes healthMetrics in sizeOnly mode', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-01-01')`
    ).run();
    db.close();

    const result = await cmosContextView({ sizeOnly: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.healthMetrics).toBeDefined();
    expect(result.data?.mode).toBe('sizeOnly');
  });

  it('output shape is backward compatible', async () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status)
       VALUES ('Test decision', '2026-01-01T00:00:00Z', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('master_context', 'context/MASTER_CONTEXT.json', ?, '2026-01-01')`
    ).run(JSON.stringify({ constraints: ['No vendor lock-in'] }));
    db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES ('project_context', 'context/PROJECT_CONTEXT.json', ?, '2026-01-01')`
    ).run(
      JSON.stringify({
        active_mission: 's26-m04',
        session_count: 3,
        working_memory: { next_steps: ['Fix tests'] },
      })
    );
    db.close();

    const result = await cmosContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    const agg = result.data!.aggregated;

    // All standard aggregated fields present
    expect(agg).toHaveProperty('activeMission');
    expect(agg).toHaveProperty('sessionCount');
    expect(agg).toHaveProperty('decisions');
    expect(agg).toHaveProperty('constraints');
    expect(agg).toHaveProperty('learnings');
    expect(agg).toHaveProperty('nextSteps');

    // Values are correct
    expect(agg.activeMission).toBe('s26-m04');
    expect(agg.sessionCount).toBe(3);
    expect(agg.decisions).toContain('Test decision');
    expect(agg.constraints).toContain('No vendor lock-in');
    expect(agg.nextSteps).toContain('Fix tests');

    // Standard top-level fields present
    expect(result.data).toHaveProperty('masterContext');
    expect(result.data).toHaveProperty('projectContext');
    expect(result.data).toHaveProperty('contextSizes');
    expect(result.data).toHaveProperty('staleness');
    expect(result.data).toHaveProperty('contextCount');
    expect(result.data).toHaveProperty('mode');
  });
});
