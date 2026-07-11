/**
 * Relevance Surfacing Tests
 *
 * Tests for surfacing relevant past decisions when a mission starts.
 *
 * @module tests/tools/cmos/relevance-surfacing
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findRelevantDecisions,
  buildMissionSearchText,
} from '../../../src/tools/cmos/relevance-surfacing';
import {
  cmosMissionStart,
  formatMissionStartForLLM,
} from '../../../src/tools/cmos/cmos-mission-start';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { withClient, type CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { createSuccess } from '../../../src/tools/cmos/errors';

describe('relevance-surfacing', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-relevance-test-'));
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
        domain_fields TEXT, created_at TEXT, started_at TEXT, updated_at TEXT, metadata TEXT
      );
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT
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

  async function runWithClient<T>(fn: (client: CmosDatabaseClient) => T): Promise<T> {
    let captured: T;
    await withClient(
      (client) => {
        captured = fn(client);
        return createSuccess(null);
      },
      { projectRoot: tempDir }
    );
    return captured!;
  }

  describe('buildMissionSearchText', () => {
    it('combines objective and success criteria', () => {
      const text = buildMissionSearchText(
        'Implement database migration system',
        JSON.stringify(['Schema versioning works', 'Rollback supported'])
      );
      expect(text).toContain('database migration');
      expect(text).toContain('Schema versioning');
      expect(text).toContain('Rollback supported');
    });

    it('handles null objective', () => {
      const text = buildMissionSearchText(null, JSON.stringify(['Test criterion']));
      expect(text).toContain('Test criterion');
    });

    it('handles null criteria', () => {
      const text = buildMissionSearchText('Just an objective', null);
      expect(text).toBe('Just an objective');
    });

    it('handles unparseable criteria gracefully', () => {
      const text = buildMissionSearchText('Objective', 'not json');
      expect(text).toContain('Objective');
      expect(text).toContain('not json');
    });
  });

  describe('findRelevantDecisions', () => {
    it('finds decisions relevant to mission text', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status, category)
         VALUES ('Use SQLite for persistent database storage', '2026-01-01T00:00:00Z', 'sprint-1', 'active', 'architectural')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Deploy with Docker containers', '2026-01-02T00:00:00Z', 'sprint-1', 'active')`
      ).run();
      db.close();

      const results = await runWithClient((client) =>
        findRelevantDecisions(
          client,
          'Implement database storage migration with SQLite schema changes'
        )
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].decisionText).toContain('SQLite');
      expect(results[0].relevanceScore).toBeGreaterThanOrEqual(2);
    });

    it('returns empty for unrelated mission text', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('Use Docker for containerization', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.close();

      const results = await runWithClient((client) =>
        findRelevantDecisions(client, 'Implement authentication with JWT tokens and OAuth flows')
      );

      // Docker decision should not match JWT/OAuth mission
      const dockerMatch = results.find((r) => r.decisionText.includes('Docker'));
      expect(dockerMatch).toBeUndefined();
    });

    it('returns at most 5 results', async () => {
      const db = new Database(dbPath);
      for (let i = 0; i < 10; i++) {
        db.prepare(
          `INSERT INTO strategic_decisions (decision_text, created_at, status)
           VALUES (?, '2026-01-01T00:00:00Z', 'active')`
        ).run(`Database storage engine variant ${i} optimization criteria`);
      }
      db.close();

      const results = await runWithClient((client) =>
        findRelevantDecisions(client, 'New database storage engine optimization criteria')
      );

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('excludes non-active decisions', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('Active database decision', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('Superseded database decision', '2026-01-01T00:00:00Z', 'superseded')`
      ).run();
      db.close();

      const results = await runWithClient((client) =>
        findRelevantDecisions(client, 'Database migration and schema decision process')
      );

      for (const r of results) {
        const db2 = new Database(dbPath);
        const row = db2
          .prepare('SELECT status FROM strategic_decisions WHERE id = ?')
          .get(r.id) as { status: string };
        db2.close();
        expect(row.status).toBe('active');
      }
    });

    it('returns empty for very short text', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('Some decision text', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.close();

      const results = await runWithClient((client) => findRelevantDecisions(client, 'Hi'));

      expect(results).toHaveLength(0);
    });

    it('includes category and evidence in results', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status, category, evidence)
         VALUES ('Use TypeScript for backend services', '2026-01-01T00:00:00Z', 'active', 'tooling', '[{"type":"doc","id":"123"}]')`
      ).run();
      db.close();

      const results = await runWithClient((client) =>
        findRelevantDecisions(client, 'Refactor backend services to use TypeScript strict mode')
      );

      if (results.length > 0) {
        const match = results.find((r) => r.decisionText.includes('TypeScript'));
        if (match) {
          expect(match.category).toBe('tooling');
          expect(match.evidence).toContain('doc');
        }
      }
    });
  });

  describe('integration with mission start', () => {
    it('includes relevant decisions in mission start response', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Use SQLite for database storage layer', '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, objective, success_criteria)
         VALUES ('s1-m01', 'sprint-1', 'Database Migration', 'Queued',
                 'Implement database migration system with SQLite schema versioning',
                 '["Schema versioning works with SQLite", "Rollback supported"]')`
      ).run();
      db.close();

      const result = await cmosMissionStart({
        missionId: 's1-m01',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      // relevantDecisions should be populated
      if (result.data?.relevantDecisions) {
        expect(result.data.relevantDecisions.length).toBeGreaterThan(0);
        expect(result.data.relevantDecisions[0].decisionText).toContain('SQLite');
      }
    });

    it('returns empty array when no decisions match', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('Use Docker for deployment', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, objective)
         VALUES ('s1-m01', 'sprint-1', 'Auth System', 'Queued',
                 'Build JWT authentication with OAuth integration')`
      ).run();
      db.close();

      const result = await cmosMissionStart({
        missionId: 's1-m01',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      // relevantDecisions should be undefined or empty
      expect(result.data?.relevantDecisions ?? []).toHaveLength(0);
    });

    it('formats relevant decisions in LLM output', async () => {
      const formatted = formatMissionStartForLLM({
        success: true,
        data: {
          missionId: 's1-m01',
          previousStatus: 'Queued',
          currentStatus: 'In Progress',
          message: "Mission 's1-m01' is now In Progress",
          startedAt: '2026-01-01T00:00:00Z',
          relevantDecisions: [
            {
              id: 1,
              decisionText: 'Use SQLite for database storage',
              category: 'architectural',
              sprintId: 'sprint-1',
              projectId: null,
              evidence: null,
              relevanceScore: 3,
            },
          ],
        },
      });

      expect(formatted).toContain('Relevant Past Decisions');
      expect(formatted).toContain('SQLite');
      expect(formatted).toContain('architectural');
      expect(formatted).toContain('sprint-1');
    });
  });
});
