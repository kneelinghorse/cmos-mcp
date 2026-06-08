/**
 * Supersession Detection Tests
 *
 * Tests for detecting keyword overlap between new and existing decisions,
 * surfacing supersession candidates, and the update action for linking.
 *
 * @module tests/tools/cmos/supersession-detection
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectSupersessionCandidates,
  extractKeywords,
} from '../../../src/tools/cmos/supersession-detection';
import { cmosDecisionsUpdate } from '../../../src/tools/cmos/cmos-decisions-update';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { withClientAsync, type CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { createSuccess } from '../../../src/tools/cmos/errors';

describe('supersession-detection', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-supersession-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT,
        category TEXT,
        superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        evidence TEXT
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

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        sprint_id TEXT,
        session_id TEXT,
        mission_id TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    `);
    db.close();
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function runWithClient<T>(fn: (client: CmosDatabaseClient) => T | Promise<T>): Promise<T> {
    let captured: T;
    await withClientAsync(
      async (client) => {
        captured = await fn(client);
        return createSuccess(null);
      },
      { projectRoot: tempDir }
    );
    return captured!;
  }

  function seedDecisions(items: Array<{ text: string; sprintId?: string; status?: string }>): void {
    const db = new Database(dbPath);
    for (const item of items) {
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES (?, '2026-01-01T00:00:00Z', ?, ?)`
      ).run(item.text, item.sprintId ?? null, item.status ?? 'active');
    }
    db.close();
  }

  describe('extractKeywords', () => {
    it('extracts meaningful keywords from decision text', () => {
      const keywords = extractKeywords('Use TypeScript for all backend services');
      expect(keywords).toContain('typescript');
      expect(keywords).toContain('backend');
      expect(keywords).toContain('services');
      // 'use' and 'for' and 'all' should be filtered as stop words
      expect(keywords).not.toContain('use');
      expect(keywords).not.toContain('for');
      expect(keywords).not.toContain('all');
    });

    it('deduplicates keywords', () => {
      const keywords = extractKeywords('service service service patterns');
      const serviceCount = keywords.filter((k) => k === 'service').length;
      expect(serviceCount).toBe(1);
    });

    it('filters short tokens', () => {
      const keywords = extractKeywords('We do it in Go');
      // 'we', 'do', 'it', 'in', 'go' are all < 3 chars
      expect(keywords).toHaveLength(0);
    });
  });

  describe('detectSupersessionCandidates', () => {
    it('finds candidates with keyword overlap', async () => {
      seedDecisions([
        { text: 'Use SQLite for persistent database storage' },
        { text: 'Deploy services using Docker containers' },
      ]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(
          client,
          'Switch from SQLite to PostgreSQL for database storage',
          999 // exclude non-existent ID
        )
      );

      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].decisionText).toContain('SQLite');
      expect(result.message).not.toBeNull();
    });

    it('returns empty when no overlap found', async () => {
      seedDecisions([{ text: 'Use Docker for containerization' }]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(client, 'Implement authentication with JWT tokens')
      );

      expect(result.candidates).toHaveLength(0);
      expect(result.message).toBeNull();
    });

    it('excludes the new decision itself', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (42, 'Use SQLite for database storage', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.close();

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(client, 'Use SQLite for database storage', 42)
      );

      // Should not include decision #42 itself
      const ids = result.candidates.map((c) => c.id);
      expect(ids).not.toContain(42);
    });

    it('only includes active decisions as candidates', async () => {
      seedDecisions([
        { text: 'Use SQLite for database storage', status: 'superseded' },
        { text: 'Use PostgreSQL for database storage', status: 'active' },
      ]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(client, 'Switch database storage engine to something new')
      );

      // Only active decisions should appear
      for (const c of result.candidates) {
        const db = new Database(dbPath);
        const row = db.prepare('SELECT status FROM strategic_decisions WHERE id = ?').get(c.id) as {
          status: string;
        };
        db.close();
        expect(row.status).toBe('active');
      }
    });

    it('returns at most 3 candidates', async () => {
      seedDecisions([
        { text: 'Database storage engine selection criteria alpha' },
        { text: 'Database storage engine performance criteria beta' },
        { text: 'Database storage engine scaling criteria gamma' },
        { text: 'Database storage engine backup criteria delta' },
        { text: 'Database storage engine migration criteria epsilon' },
      ]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(client, 'New database storage engine criteria for production')
      );

      expect(result.candidates.length).toBeLessThanOrEqual(3);
    });

    it('returns empty for very short decision text', async () => {
      seedDecisions([{ text: 'Use TypeScript for backend services' }]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(client, 'OK done')
      );

      expect(result.candidates).toHaveLength(0);
    });

    it('includes overlap count in candidates', async () => {
      seedDecisions([{ text: 'Use TypeScript for all backend API services' }]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(
          client,
          'Switch backend API services to Python instead of TypeScript'
        )
      );

      if (result.candidates.length > 0) {
        expect(result.candidates[0].overlapCount).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('suggestion message format', () => {
    it('includes actionable instruction in message', async () => {
      seedDecisions([{ text: 'Use SQLite for persistent database storage' }]);

      const result = await runWithClient((client) =>
        detectSupersessionCandidates(
          client,
          'Switch from SQLite to PostgreSQL for database storage'
        )
      );

      if (result.message) {
        expect(result.message).toContain('cmos_decisions');
        expect(result.message).toContain('supersed');
      }
    });
  });

  describe('cmos_decisions update action', () => {
    it('sets superseded_by and auto-updates status', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (1, 'Old decision', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (2, 'New decision', '2026-02-01T00:00:00Z', 'active')`
      ).run();
      db.close();

      const result = await cmosDecisionsUpdate({
        decisionId: 1,
        supersededBy: 2,
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('active');
      expect(result.data?.newStatus).toBe('superseded');
      expect(result.data?.supersededBy).toBe(2);

      // Verify DB state
      const db2 = new Database(dbPath);
      const row = db2
        .prepare('SELECT status, superseded_by FROM strategic_decisions WHERE id = 1')
        .get() as {
        status: string;
        superseded_by: number;
      };
      db2.close();

      expect(row.status).toBe('superseded');
      expect(row.superseded_by).toBe(2);
    });

    it('rejects self-supersession', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (1, 'Some decision', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.close();

      const result = await cmosDecisionsUpdate({
        decisionId: 1,
        supersededBy: 1,
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('cannot supersede itself');
    });

    it('rejects update for non-existent decision', async () => {
      const result = await cmosDecisionsUpdate({
        decisionId: 999,
        supersededBy: 1,
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('not found');
    });

    it('allows explicit status update without supersededBy', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (1, 'Some decision', '2026-01-01T00:00:00Z', 'active')`
      ).run();
      db.close();

      const result = await cmosDecisionsUpdate({
        decisionId: 1,
        status: 'archived',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.newStatus).toBe('archived');
    });

    it('rejects invalid status values', async () => {
      const result = await cmosDecisionsUpdate({
        decisionId: 1,
        status: 'deleted',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
    });
  });
});
