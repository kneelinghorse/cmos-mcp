/**
 * cmos_sprint_complete Tool Tests
 *
 * Regression coverage for the sprint closeout automation flow.
 *
 * @module tests/tools/cmos/cmos-sprint-complete
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosSprintComplete,
  cmosSprintCompleteToolDefinition,
  formatSprintCompleteForLLM,
} from '../../../src/tools/cmos/cmos-sprint-complete';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import * as buildFreshnessModule from '../../../src/tools/cmos/build-freshness';
import * as serverHealth from '../../../src/server-health';
import type { BuildManifest } from '../../../src/server-health';

describe('cmos_sprint_complete', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprint-complete-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
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
        source TEXT,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
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
    `);

    db.prepare(
      `INSERT INTO sprints (id, title, focus, status, start_date)
       VALUES ('sprint-22', 'Sprint 22', 'Production hardening', 'Active', '2026-03-01')`
    ).run();

    db.prepare(`INSERT INTO metadata (key, value) VALUES ('project_name', 'CMOS MCP Test')`).run();

    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function getProjectRoot(): string {
    return tempDir;
  }

  function seedMissions(
    missions: Array<{ id: string; status: string; notes?: string | null }>
  ): void {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes)
       VALUES (?, 'sprint-22', ?, ?, ?)`
    );

    for (const mission of missions) {
      insert.run(mission.id, `Mission ${mission.id}`, mission.status, mission.notes ?? null);
    }

    db.close();
  }

  function seedContexts(
    masterContent: Record<string, unknown>,
    projectContent: Record<string, unknown>
  ): void {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES (?, ?, ?, '2026-03-06T00:00:00Z')`
    );

    insert.run('master_context', 'context/MASTER_CONTEXT.json', JSON.stringify(masterContent));
    insert.run('project_context', 'context/PROJECT_CONTEXT.json', JSON.stringify(projectContent));
    db.close();
  }

  function readContext(contextId: 'master_context' | 'project_context'): Record<string, unknown> {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT content FROM contexts WHERE id = ?').get(contextId) as {
      content: string;
    };
    db.close();
    return JSON.parse(row.content);
  }

  describe('happy path', () => {
    it('completes the sprint, snapshots contexts, and clears sprint-linked next steps', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Completed' },
      ]);
      seedContexts(
        {
          next_session_context: {
            when_we_resume: ['session-1: Wrap s22-m01 follow-up', 'Prepare sprint retro notes'],
          },
        },
        {
          working_memory: {
            next_steps: ['session-1: Finish s22-m02 docs', 'Keep lint clean'],
          },
          next_session_context: {
            when_we_resume: ['Close sprint-22 checklist', 'Investigate future telemetry work'],
          },
          next_steps: ['Archive sprint-22 notes', 'Draft sprint-23 kickoff'],
        }
      );

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Production hardening shipped',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.data?.contexts.masterContext.snapshotId).not.toBeNull();
      expect(result.data?.contexts.projectContext.snapshotId).not.toBeNull();
      expect(result.data?.contexts.masterContext.nextStepsCleared).toBe(1);
      expect(result.data?.contexts.projectContext.nextStepsCleared).toBe(3);

      const db = new Database(dbPath);
      const sprint = db
        .prepare('SELECT status, end_date FROM sprints WHERE id = ?')
        .get('sprint-22') as { status: string; end_date: string | null };
      const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as {
        count: number;
      };
      const eventCount = db
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE action = 'sprint_complete'")
        .get() as { count: number };
      db.close();

      expect(sprint.status).toBe('Completed');
      expect(sprint.end_date).toBeTruthy();
      expect(snapshotCount.count).toBe(2);
      expect(eventCount.count).toBe(1);

      expect(readContext('master_context')).toEqual({
        next_session_context: {
          when_we_resume: ['Prepare sprint retro notes'],
        },
      });
      expect(readContext('project_context')).toEqual({
        working_memory: {
          next_steps: ['Keep lint clean'],
        },
        next_session_context: {
          when_we_resume: ['Investigate future telemetry work'],
        },
        next_steps: ['Draft sprint-23 kickoff'],
      });
    });
  });

  describe('readiness validation', () => {
    it('returns warnings when blocked missions remain', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Blocked', notes: 'Waiting on upstream API' },
        { id: 's22-m03', status: 'Completed', notes: '[Skipped] No longer needed' },
      ]);
      seedContexts(
        { next_session_context: { when_we_resume: ['Revisit s22-m02 blocker'] } },
        { working_memory: { next_steps: ['Carry s22-m02 into sprint-23'] } }
      );

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with blocker carryover',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.readiness.blockedMissionIds).toEqual(['s22-m02']);
      expect(result.data?.readiness.skippedMissionIds).toEqual(['s22-m03']);
      expect(result.warnings).toContain(
        "Sprint 'sprint-22' closed with blocked missions: s22-m02."
      );
      expect(result.warnings).toContain(
        "Sprint 'sprint-22' includes skipped missions recorded in notes: s22-m03."
      );

      const context = readContext('project_context');
      expect(context).toEqual({
        working_memory: { next_steps: ['Carry s22-m02 into sprint-23'] },
      });
    });

    it('does not treat generic skip wording in notes as a skipped mission marker', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        {
          id: 's22-m02',
          status: 'Completed',
          notes: 'Implemented closeout flow and tests cover blocked/skipped readiness warnings.',
        },
      ]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed without skipped work',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.readiness.skippedMissionIds).toEqual([]);
      expect(result.warnings ?? []).not.toContain(
        "Sprint 'sprint-22' includes skipped missions recorded in notes: s22-m02."
      );
    });

    it('succeeds when only Dropped missions remain (Dropped is terminal)', async () => {
      // Regression test: sprint close was blocking on Dropped missions, forcing agents to
      // corrupt the audit trail by marking them Completed just to satisfy the gate.
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Dropped' },
      ]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with a dropped mission',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
    });

    it('succeeds when only Deferred missions remain (Deferred is terminal for close)', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Deferred' },
      ]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with a deferred mission',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
    });

    it('fails when queued or active missions remain', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Queued' },
      ]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Should not close',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SPRINT_NOT_READY);

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT status FROM sprints WHERE id = ?').get('sprint-22') as {
        status: string;
      };
      db.close();

      expect(sprint.status).toBe('Active');
    });

    it('fails when the sprint is already completed', async () => {
      const db = new Database(dbPath);
      db.prepare("UPDATE sprints SET status = 'Completed' WHERE id = 'sprint-22'").run();
      db.close();

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Already closed',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.SPRINT_ALREADY_COMPLETED);
    });
  });

  describe('condensation integration', () => {
    it('runs optional condensation and reports post-closeout sizes', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts(
        {
          recent_sessions: [
            {
              id: 'session-1',
              summary: 'A'.repeat(320),
            },
          ],
          next_session_context: {
            when_we_resume: ['Complete s22-m01 wrap-up'],
          },
        },
        {
          working_memory: {
            next_steps: ['Complete s22-m01 wrap-up'],
            recent_sessions: [
              {
                id: 'session-2',
                summary: 'B'.repeat(320),
              },
            ],
          },
        }
      );

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with condensation',
        condensation: 'conservative',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.contexts.masterContext.condensation?.strategy).toBe('conservative');
      expect(result.data?.contexts.projectContext.condensation?.strategy).toBe('conservative');
      expect(result.data?.contexts.masterContext.afterSize.sizeKb).toBeLessThanOrEqual(
        result.data!.contexts.masterContext.beforeSize.sizeKb
      );
      expect(result.data?.contexts.projectContext.afterSize.sizeKb).toBeLessThanOrEqual(
        result.data!.contexts.projectContext.beforeSize.sizeKb
      );
    });
  });

  describe('error and warning handling', () => {
    it('returns a parse error when a closeout context is invalid JSON', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);

      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-03-06T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('project_context', 'context/PROJECT_CONTEXT.json', ?, '2026-03-06T00:00:00Z')`
      ).run('{not-json');
      db.close();

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Invalid project context',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CONTEXT_PARSE_ERROR);
    });

    it('warns when sprint closeout event logging fails after commit', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const db = new Database(dbPath);
      db.exec('DROP TABLE session_events');
      db.close();

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Event logging warning',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Sprint closeout event logging failed.');
    });
  });

  describe('lifecycle triggers', () => {
    function seedDecisionsAndLearningsTables(): void {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS strategic_decisions (
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
          evidence TEXT
        );
        CREATE TABLE IF NOT EXISTS learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          sprint_id TEXT,
          session_id TEXT,
          mission_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.close();
    }

    function addMissionTimestamps(): void {
      const db = new Database(dbPath);
      // Add started_at and updated_at columns if not present
      try {
        db.exec('ALTER TABLE missions ADD COLUMN started_at TEXT');
      } catch {
        /* already exists */
      }
      try {
        db.exec('ALTER TABLE missions ADD COLUMN updated_at TEXT');
      } catch {
        /* already exists */
      }
      db.close();
    }

    it('archives sprint-scoped decisions and learnings on completion', async () => {
      seedDecisionsAndLearningsTables();
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Completed' },
      ]);
      seedContexts({}, {});

      const db = new Database(dbPath);
      // Decisions linked directly and via mission
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Use WAL mode for concurrency', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, mission_id, status)
         VALUES ('FTS5 for search', '2026-03-02T00:00:00Z', 's22-m01', 'active')`
      ).run();
      // Decision already superseded — should NOT be changed
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Old approach', '2026-03-01T00:00:00Z', 'sprint-22', 'superseded')`
      ).run();
      // Decision from a different sprint — should NOT be archived
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Sprint 23 decision', '2026-03-05T00:00:00Z', 'sprint-23', 'active')`
      ).run();
      // Learnings
      db.prepare(
        `INSERT INTO learnings (content, category, status, sprint_id, created_at)
         VALUES ('SQLite COALESCE pattern', 'technical', 'active', 'sprint-22', '2026-03-01T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO learnings (content, category, status, mission_id, created_at)
         VALUES ('Session capture flow', 'process', 'active', 's22-m02', '2026-03-02T00:00:00Z')`
      ).run();
      db.close();

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Lifecycle triggers test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.lifecycle.decisionsArchived).toBe(2);
      expect(result.data?.lifecycle.learningsArchived).toBe(2);

      // Verify DB state
      const db2 = new Database(dbPath);
      const activeDecisions = db2
        .prepare("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'active'")
        .get() as { count: number };
      const archivedDecisions = db2
        .prepare("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'archived'")
        .get() as { count: number };
      const supersededDecisions = db2
        .prepare("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'superseded'")
        .get() as { count: number };
      const activeLearnings = db2
        .prepare("SELECT COUNT(*) AS count FROM learnings WHERE status = 'active'")
        .get() as { count: number };
      db2.close();

      expect(activeDecisions.count).toBe(1); // sprint-23 decision only
      expect(archivedDecisions.count).toBe(2); // the two sprint-22 active ones
      expect(supersededDecisions.count).toBe(1); // unchanged
      expect(activeLearnings.count).toBe(0); // both archived
    });

    it('computes sprint summary KPIs', async () => {
      addMissionTimestamps();
      seedDecisionsAndLearningsTables();

      const db = new Database(dbPath);
      // Insert missions with timestamps for cycle time calculation
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, started_at, completed_at)
         VALUES ('s22-m01', 'sprint-22', 'Mission 1', 'Completed',
                 '2026-03-01T00:00:00Z', '2026-03-03T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, started_at, completed_at)
         VALUES ('s22-m02', 'sprint-22', 'Mission 2', 'Completed',
                 '2026-03-02T00:00:00Z', '2026-03-04T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, notes)
         VALUES ('s22-m03', 'sprint-22', 'Mission 3', 'Blocked', 'Waiting on API')`
      ).run();
      // Add decisions
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Decision 1', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Decision 2', '2026-03-02T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.close();
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'KPI test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      const kpis = result.data?.lifecycle.kpis;
      expect(kpis).toBeDefined();
      // 2 completed out of 3 total
      expect(kpis?.completionRate).toBeCloseTo(2 / 3, 1);
      // Each mission took 2 days
      expect(kpis?.avgCycleTimeDays).toBeCloseTo(2, 1);
      // 2 decisions linked to sprint
      expect(kpis?.decisionCount).toBe(2);
      expect(kpis?.blockedCount).toBe(1);
    });

    it('clears project_context working_memory session arrays on completion', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts(
        {},
        {
          working_memory: {
            session_history: [{ id: 'session-1', summary: 'Old session' }],
            recent_sessions: [{ id: 'session-2', summary: 'Recent' }],
            next_steps: ['Keep lint clean'],
          },
          current_sprint: 'sprint-22',
          active_mission: 's22-m01',
        }
      );

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Working memory test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);

      const context = readContext('project_context');
      const wm = context.working_memory as Record<string, unknown>;
      // Ephemeral arrays cleared
      expect(wm.session_history).toEqual([]);
      expect(wm.recent_sessions).toEqual([]);
      // next_steps preserved (cleared selectively by clearSprintLinkedNextSteps)
      expect(wm.next_steps).toEqual(['Keep lint clean']);
      // Sprint/mission references cleared
      expect(context.current_sprint).toBeNull();
      expect(context.active_mission).toBeNull();
    });

    it('creates a DB snapshot after sprint completion', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'DB snapshot test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.lifecycle.dbSnapshotId).toBeTruthy();

      // Verify snapshot file exists
      const snapshotDir = path.join(tempDir, 'cmos', 'db', 'snapshots');
      if (fs.existsSync(snapshotDir)) {
        const files = fs.readdirSync(snapshotDir);
        expect(files.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('succeeds even when decisions/learnings tables do not exist', async () => {
      // No strategic_decisions or learnings tables created
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'No decision tables',
        projectRoot: getProjectRoot(),
      });

      // Should succeed with warnings about archival failure
      expect(result.success).toBe(true);
      expect(result.data?.lifecycle.decisionsArchived).toBe(0);
      expect(result.data?.lifecycle.learningsArchived).toBe(0);
    });

    it('archives successfully on a pre-migration DB lacking the session-of-origin column (Sprint 52 m04 / s69-m04)', async () => {
      // Regression for reporter: "Column does not exist" on older DBs. Create
      // strategic_decisions and learnings WITHOUT the session-of-origin column; the
      // sprint-complete path must migrate the column in (s69-m04 names it
      // author_session_id) and then archive the scoped rows.
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sprint_id TEXT,
          mission_id TEXT,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE IF NOT EXISTS learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          sprint_id TEXT,
          mission_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Scoped decision', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO learnings (content, category, status, sprint_id, created_at)
         VALUES ('Scoped learning', 'technical', 'active', 'sprint-22', '2026-03-01T00:00:00Z')`
      ).run();
      db.close();

      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Pre-migration DB archival',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/partially failed/i)])
      );
      expect(result.data?.lifecycle.decisionsArchived).toBe(1);
      expect(result.data?.lifecycle.learningsArchived).toBe(1);

      // The session-of-origin column should be present after the migration ran.
      // s69-m04 renamed it author_session_id (and ensureArchivalColumns adds it
      // under the new name when neither name exists), so it must NOT resurrect the
      // legacy session_id.
      const db2 = new Database(dbPath);
      const decisionCols = db2.pragma('table_info(strategic_decisions)') as Array<{ name: string }>;
      const learningCols = db2.pragma('table_info(learnings)') as Array<{ name: string }>;
      db2.close();
      expect(decisionCols.some((c) => c.name === 'author_session_id')).toBe(true);
      expect(learningCols.some((c) => c.name === 'author_session_id')).toBe(true);
      expect(decisionCols.some((c) => c.name === 'session_id')).toBe(false);
      expect(learningCols.some((c) => c.name === 'session_id')).toBe(false);
    });

    it('formats lifecycle data in LLM output', async () => {
      seedDecisionsAndLearningsTables();
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Test decision', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.close();

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Format test',
        projectRoot: getProjectRoot(),
      });
      const formatted = formatSprintCompleteForLLM(result);

      expect(formatted).toContain('KPIs:');
      expect(formatted).toContain('Archived:');
      expect(formatted).toContain('DB snapshot:');
    });
  });

  describe('build-freshness ENFORCED gate (Sprint 70 m02)', () => {
    function writeSrcFile(relativePath: string, mtime?: Date): void {
      const fullPath = path.join(tempDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// ${relativePath}\n`);
      if (mtime) fs.utimesSync(fullPath, mtime, mtime);
    }

    function writeDistManifest(buildTime: Date): void {
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, '.build-manifest.json'),
        JSON.stringify({ buildHash: 'x', buildTime: buildTime.toISOString(), fileCount: 1 })
      );
    }

    function writeDistIndex(mtime: Date): void {
      // dist/index.js with NO manifest — exercises the manifest-absent / index-mtime
      // fallback path in checkBuildFreshness (reason 'src-newer-than-dist-index-mtime').
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      const indexPath = path.join(distDir, 'index.js');
      fs.writeFileSync(indexPath, 'module.exports = {};\n');
      fs.utimesSync(indexPath, mtime, mtime);
    }

    function countRows(table: string): number {
      const db = new Database(dbPath);
      try {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        return row.count;
      } finally {
        db.close();
      }
    }

    function readSprintStatus(): string {
      const db = new Database(dbPath);
      const row = db.prepare('SELECT status FROM sprints WHERE id = ?').get('sprint-22') as {
        status: string;
      };
      db.close();
      return row.status;
    }

    function fakeManifest(hash: string): BuildManifest {
      return { buildHash: hash, buildTime: '2026-05-01T00:00:00Z', fileCount: 1 };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // --- Fresh trees pass unaffected (criterion e) ---

    it('omits buildFreshness and completes when no src/ exists in the project root', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'No build artifacts',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness).toBeUndefined();
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/forceComplete|stale build/i)])
      );
    });

    it('completes when src/ is older than the build manifest (fresh tree)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeSrcFile('src/foo.ts', new Date(Date.now() - 60_000));
      writeDistManifest(new Date());

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Fresh dist',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness).toBeUndefined();
    });

    // --- Each blocking reason blocks with BUILD_STALE and zero mutation (criteria a, b) ---

    it('BLOCKS with BUILD_STALE when src/ is newer than dist/, with no DB mutation', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Stale dist must block',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.BUILD_STALE);
      // Message lists the offending file and the remediation.
      expect(result.error?.message).toContain(path.join('src', 'foo.ts'));
      expect(result.error?.suggestion).toMatch(/npm run build/);
      expect(result.error?.suggestion).toMatch(/forceComplete/);

      // Zero DB mutation: sprint stays Active, no snapshots, no events.
      expect(readSprintStatus()).toBe('Active');
      expect(countRows('context_snapshots')).toBe(0);
      expect(countRows('session_events')).toBe(0);
    });

    it('BLOCKS with BUILD_STALE and dist-missing reason when dist/ is absent', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeSrcFile('src/foo.ts');

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Missing dist must block',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.BUILD_STALE);
      expect(result.error?.message).toMatch(/dist-missing/);
      expect(readSprintStatus()).toBe('Active');
    });

    it('BLOCKS with BUILD_STALE on src-newer-than-dist-index-mtime (manifest absent, index.js older)', async () => {
      // The third blocking reason: no .build-manifest.json, but dist/index.js exists
      // with an older mtime than src/. Covered for detection in build-freshness.test.ts;
      // this asserts the e2e gate actually blocks on it (one test per blocking reason).
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistIndex(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Stale index.js fallback must block',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.BUILD_STALE);
      expect(result.error?.message).toMatch(/src-newer-than-dist-index-mtime/);
      expect(readSprintStatus()).toBe('Active');
      expect(countRows('context_snapshots')).toBe(0);
    });

    it('never opens a transaction on the blocked path (no BEGIN/COMMIT issued)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const executeSpy = jest.spyOn(CmosDatabaseClient.prototype, 'execute');

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Blocked path issues no transaction',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      const sqlCalls = executeSpy.mock.calls.map((c) => String(c[0]).toUpperCase());
      expect(sqlCalls.some((sql) => sql.includes('BEGIN'))).toBe(false);
      expect(sqlCalls.some((sql) => sql.includes('COMMIT'))).toBe(false);
    });

    // --- forceComplete escape hatch records the override (criterion c) ---

    it('completes with forceComplete:true over a stale tree, retaining the report and warning', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Forced over stale build',
        forceComplete: true,
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      // The override is NOT silent: the freshness report is retained and a warning is pushed.
      expect(result.data?.buildFreshness?.stale).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/forceComplete.*stale build/i)])
      );
      // And the completion actually happened.
      expect(readSprintStatus()).toBe('Completed');
    });

    // --- Server-health (codeIsCurrent) signal, gated on startupBuild presence (criterion d) ---

    it('BLOCKS when the running server is on stale code (startupBuild present, codeIsCurrent=false)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      jest.spyOn(serverHealth, 'getServerHealth').mockReturnValue({
        uptimeSeconds: 1,
        startedAt: '2026-05-01T00:00:00Z',
        memoryUsageMb: 1,
        startupBuild: fakeManifest('aaaaaaaaaaaa'),
        currentBuild: fakeManifest('bbbbbbbbbbbb'),
        codeIsCurrent: false,
        stalenessMessage:
          'Server is running stale code. Restart the MCP server to pick up changes.',
        pid: 1,
        nodeVersion: 'v20',
      });

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Server stale must block',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.BUILD_STALE);
      expect(result.error?.message).toMatch(/running stale code/i);
      expect(readSprintStatus()).toBe('Active');
    });

    it('does NOT block on a null-startupManifest health result (the Jest-default landmine)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      // codeIsCurrent=false but startupBuild=null — the normal test/default state
      // where a manifest exists on disk but the process captured none at startup.
      jest.spyOn(serverHealth, 'getServerHealth').mockReturnValue({
        uptimeSeconds: 1,
        startedAt: '2026-05-01T00:00:00Z',
        memoryUsageMb: 1,
        startupBuild: null,
        currentBuild: fakeManifest('bbbbbbbbbbbb'),
        codeIsCurrent: false,
        stalenessMessage: 'Server started before build manifest existed.',
        pid: 1,
        nodeVersion: 'v20',
      });

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Null startup manifest must not block',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
    });

    // --- Degenerate non-blocking cases are preserved (criterion f) ---

    it('does NOT block when the freshness probe throws (never-wedge contract)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      jest
        .spyOn(buildFreshnessModule, 'checkBuildFreshness')
        .mockRejectedValue(new Error('probe blew up'));

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Probe failure must not wedge',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
    });
  });

  describe('tool definition and formatting', () => {
    it('exposes the expected tool schema', () => {
      expect(cmosSprintCompleteToolDefinition.name).toBe('cmos_sprint_complete');
      expect(cmosSprintCompleteToolDefinition.inputSchema.required).toEqual(
        expect.arrayContaining(['sprintId', 'summary'])
      );
    });

    it('exposes forceComplete as a boolean on the tool schema (Sprint 70 m02)', () => {
      const props = cmosSprintCompleteToolDefinition.inputSchema.properties as Record<
        string,
        { type?: string }
      >;
      expect(props.forceComplete).toBeDefined();
      expect(props.forceComplete.type).toBe('boolean');
    });

    it('formats success results for LLMs', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await cmosSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Formatting check',
        projectRoot: getProjectRoot(),
      });
      const formatted = formatSprintCompleteForLLM(result);

      expect(formatted).toContain("Sprint 'sprint-22' completed");
      expect(formatted).toContain('Total context size');
    });
  });
});
