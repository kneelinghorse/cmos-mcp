/**
 * Orphan Detection Tests
 *
 * Tests for detecting orphaned sprints (no missions),
 * orphaned missions (no sprint or stale In Progress),
 * and stale sessions (active >24h).
 *
 * @module tests/tools/cmos/orphan-detection
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectOrphans,
  buildOrphanWarnings,
  type OrphanDetectionResult,
} from '../../../src/tools/cmos/orphan-detection';
import { withClient, type CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { createSuccess } from '../../../src/tools/cmos/errors';

describe('orphan-detection', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-orphan-test-'));
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
        started_at TEXT,
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

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT DEFAULT 'active',
        captures TEXT DEFAULT '[]',
        summary TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
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

  // ─── Orphaned Sprints ──────────────────────────────────────────────────────

  describe('orphaned sprints', () => {
    it('should detect sprints with no missions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'Planned');
        INSERT INTO sprints (id, title, status) VALUES ('sprint-02', 'Sprint 2', 'In Progress');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', 'sprint-02', 'Mission 1', 'Queued');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(1);
      expect(result.orphanedSprints[0].id).toBe('sprint-01');
      expect(result.orphanedSprints[0].title).toBe('Sprint 1');
    });

    it('should not flag sprints that have missions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'In Progress');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', 'sprint-01', 'Mission 1', 'Queued');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(0);
    });

    it('should not flag Completed sprints with no missions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-done', 'Done Sprint', 'Completed');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(0);
    });

    it('should not flag Archived sprints with no missions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-arch', 'Archived Sprint', 'Archived');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(0);
    });

    it('should not flag Failed/Dropped/Reverted sprints with no missions (terminal-status regression)', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-failed', 'Failed Sprint', 'Failed');
        INSERT INTO sprints (id, title, status) VALUES ('sprint-dropped', 'Dropped Sprint', 'Dropped');
        INSERT INTO sprints (id, title, status) VALUES ('sprint-reverted', 'Reverted Sprint', 'Reverted');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(0);
    });

    it('should not flag terminal sprints with drifted-case status (lowercase "failed"/"completed")', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-lc1', 'lowercase failed', 'failed');
        INSERT INTO sprints (id, title, status) VALUES ('sprint-lc2', 'lowercase completed', 'completed');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(0);
    });

    it('should still flag a genuinely live (Planned) sprint with no missions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-live', 'Live Sprint', 'Planned');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(1);
      expect(result.orphanedSprints[0].id).toBe('sprint-live');
    });

    it('should return empty when no sprints exist', async () => {
      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedSprints).toHaveLength(0);
    });
  });

  // ─── Orphaned Missions ─────────────────────────────────────────────────────

  describe('orphaned missions (no sprint)', () => {
    it('should detect missions with null sprint_id', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', NULL, 'Orphan Mission', 'Queued');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.orphanedMissions).toHaveLength(1);
      expect(result.orphanedMissions[0].id).toBe('m01');
      expect(result.orphanedMissions[0].reason).toBe('no_sprint');
    });

    it('should detect missions with empty string sprint_id', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', '', 'Orphan Mission', 'In Progress');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const noSprint = result.orphanedMissions.filter((m) => m.reason === 'no_sprint');
      expect(noSprint).toHaveLength(1);
    });

    it('should not flag Completed missions without sprint', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', NULL, 'Done Mission', 'Completed');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const noSprint = result.orphanedMissions.filter((m) => m.reason === 'no_sprint');
      expect(noSprint).toHaveLength(0);
    });

    it('should not flag Dropped/Deferred missions without sprint (terminal-status regression)', async () => {
      // Dropped/Deferred are the bug: the old NOT IN ('Completed','Archived') list
      // omitted them, so a dropped/deferred mission with no sprint was wrongly
      // reported as a live orphan. ('Archived' is not a valid mission status — the
      // mission-terminal set is {Completed, Dropped, Deferred}.)
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-drop', NULL, 'Dropped Mission', 'Dropped');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-defer', NULL, 'Deferred Mission', 'Deferred');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const noSprint = result.orphanedMissions.filter((m) => m.reason === 'no_sprint');
      expect(noSprint).toHaveLength(0);
    });

    it('DOES flag a Failed mission without sprint — s87-m01 widened this predicate', async () => {
      // BEHAVIOUR CHANGE, asserted rather than accommodated. Until s87-m01 'Failed' was a member
      // of MISSION_TERMINAL_STATUSES, so this row was excluded here. #839 assigns 'Failed' to the
      // SPRINT domain and forbids exactly that copy, and 'Failed' is not a key of
      // VALID_STATE_TRANSITIONS — so the mission-terminal set was asserting a state the mission
      // state machine has no entry for. Removing it widens THIS predicate, and the widening gets
      // its own test so the change is visible rather than inferred from a deleted line.
      //
      // UNWITNESSED, not observed: zero 'Failed' mission rows exist in this repo's store
      // (Archived 1, Completed 363, Dropped 7, In Progress 1, Queued 7) or in the fleet
      // enumeration. It is reachable through the same unvalidated import/peer-merge paths that
      // put mission B1.1 at status 'Archived'.
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-fail', NULL, 'Failed Mission', 'Failed');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const noSprint = result.orphanedMissions.filter((m) => m.reason === 'no_sprint');
      expect(noSprint).toHaveLength(1);
      expect(noSprint[0].id).toBe('m-fail');
    });

    it('should not flag terminal missions with drifted-case status (lowercase "dropped")', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-lc', NULL, 'lowercase dropped', 'dropped');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const noSprint = result.orphanedMissions.filter((m) => m.reason === 'no_sprint');
      expect(noSprint).toHaveLength(0);
    });

    it('should still flag a genuinely live (Blocked) mission without sprint', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-live', NULL, 'Blocked Mission', 'Blocked');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const noSprint = result.orphanedMissions.filter((m) => m.reason === 'no_sprint');
      expect(noSprint).toHaveLength(1);
      expect(noSprint[0].id).toBe('m-live');
    });
  });

  describe('stale In Progress missions', () => {
    it('should detect In Progress missions older than threshold', async () => {
      const db = new Database(dbPath);
      // 10 days ago
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'In Progress');
        INSERT INTO missions (id, sprint_id, name, status, started_at)
        VALUES ('m01', 'sprint-01', 'Old Mission', 'In Progress', datetime('now', '-10 days'));
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const stale = result.orphanedMissions.filter((m) => m.reason === 'stale_in_progress');
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('m01');
    });

    it('should not flag recent In Progress missions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'In Progress');
        INSERT INTO missions (id, sprint_id, name, status, started_at)
        VALUES ('m01', 'sprint-01', 'Fresh Mission', 'In Progress', datetime('now', '-2 days'));
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      const stale = result.orphanedMissions.filter((m) => m.reason === 'stale_in_progress');
      expect(stale).toHaveLength(0);
    });

    it('should respect custom staleMissionDays threshold', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'In Progress');
        INSERT INTO missions (id, sprint_id, name, status, started_at)
        VALUES ('m01', 'sprint-01', 'Mission', 'In Progress', datetime('now', '-3 days'));
      `);
      db.close();

      // With default (7 days) — should not be stale
      const resultDefault = await runWithClient((client) => detectOrphans(client));
      expect(
        resultDefault.orphanedMissions.filter((m) => m.reason === 'stale_in_progress')
      ).toHaveLength(0);

      // With 2-day threshold — should be stale
      const resultCustom = await runWithClient((client) =>
        detectOrphans(client, { staleMissionDays: 2 })
      );
      expect(
        resultCustom.orphanedMissions.filter((m) => m.reason === 'stale_in_progress')
      ).toHaveLength(1);
    });
  });

  // ─── Stale Sessions ────────────────────────────────────────────────────────

  describe('stale sessions', () => {
    it('should detect active sessions older than threshold', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, status)
        VALUES ('sess-01', 'build', 'Old Build Session', datetime('now', '-48 hours'), 'active');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.staleSessions).toHaveLength(1);
      expect(result.staleSessions[0].id).toBe('sess-01');
      expect(result.staleSessions[0].hoursActive).toBeGreaterThan(24);
    });

    it('should not flag recent active sessions', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, status)
        VALUES ('sess-01', 'build', 'Recent Session', datetime('now', '-2 hours'), 'active');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.staleSessions).toHaveLength(0);
    });

    it('should not flag completed sessions regardless of age', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, completed_at, status)
        VALUES ('sess-01', 'build', 'Done Session', datetime('now', '-72 hours'), datetime('now', '-71 hours'), 'completed');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.staleSessions).toHaveLength(0);
    });

    it('should respect custom staleSessionHours threshold', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sessions (id, type, title, started_at, status)
        VALUES ('sess-01', 'build', 'Session', datetime('now', '-5 hours'), 'active');
      `);
      db.close();

      // Default 24h — should not be stale
      const resultDefault = await runWithClient((client) => detectOrphans(client));
      expect(resultDefault.staleSessions).toHaveLength(0);

      // Custom 4h — should be stale
      const resultCustom = await runWithClient((client) =>
        detectOrphans(client, { staleSessionHours: 4 })
      );
      expect(resultCustom.staleSessions).toHaveLength(1);
    });
  });

  // ─── Total Count ───────────────────────────────────────────────────────────

  describe('totalOrphans', () => {
    it('should sum all orphan types', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-empty', 'Empty Sprint', 'Planned');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-orphan', NULL, 'No Sprint', 'Queued');
        INSERT INTO sessions (id, type, title, started_at, status)
        VALUES ('sess-stale', 'build', 'Stale', datetime('now', '-48 hours'), 'active');
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.totalOrphans).toBe(3);
      expect(result.orphanedSprints).toHaveLength(1);
      expect(result.orphanedMissions).toHaveLength(1);
      expect(result.staleSessions).toHaveLength(1);
    });

    it('should return 0 when no orphans exist', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'In Progress');
        INSERT INTO missions (id, sprint_id, name, status, started_at)
        VALUES ('m01', 'sprint-01', 'Active Mission', 'In Progress', datetime('now', '-1 day'));
      `);
      db.close();

      const result = await runWithClient((client) => detectOrphans(client));
      expect(result.totalOrphans).toBe(0);
    });
  });

  // ─── Warning Builder ──────────────────────────────────────────────────────

  describe('buildOrphanWarnings', () => {
    it('should return empty array for no orphans', () => {
      const result: OrphanDetectionResult = {
        orphanedSprints: [],
        orphanedMissions: [],
        staleSessions: [],
        totalOrphans: 0,
      };
      expect(buildOrphanWarnings(result)).toEqual([]);
    });

    it('should build warning for orphaned sprints', () => {
      const result: OrphanDetectionResult = {
        orphanedSprints: [{ id: 'sprint-21', title: 'Old Sprint', status: 'Planned' }],
        orphanedMissions: [],
        staleSessions: [],
        totalOrphans: 1,
      };
      const warnings = buildOrphanWarnings(result);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('1 orphaned sprint');
      expect(warnings[0]).toContain('sprint-21');
    });

    it('should build warning for no-sprint missions', () => {
      const result: OrphanDetectionResult = {
        orphanedSprints: [],
        orphanedMissions: [
          {
            id: 'm01',
            name: 'Lost Mission',
            status: 'Queued',
            reason: 'no_sprint',
            startedAt: null,
          },
        ],
        staleSessions: [],
        totalOrphans: 1,
      };
      const warnings = buildOrphanWarnings(result);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('m01');
      expect(warnings[0]).toContain('no parent sprint');
    });

    it('should build warning for stale In Progress missions', () => {
      const result: OrphanDetectionResult = {
        orphanedSprints: [],
        orphanedMissions: [
          {
            id: 'm02',
            name: 'Stuck Mission',
            status: 'In Progress',
            reason: 'stale_in_progress',
            startedAt: '2026-02-01T00:00:00Z',
          },
        ],
        staleSessions: [],
        totalOrphans: 1,
      };
      const warnings = buildOrphanWarnings(result);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('m02');
      expect(warnings[0]).toContain('In Progress since');
    });

    it('should build warning for stale sessions', () => {
      const result: OrphanDetectionResult = {
        orphanedSprints: [],
        orphanedMissions: [],
        staleSessions: [
          {
            id: 'sess-01',
            type: 'build',
            title: 'Old Build',
            startedAt: '2026-03-08T00:00:00Z',
            hoursActive: 48,
          },
        ],
        totalOrphans: 1,
      };
      const warnings = buildOrphanWarnings(result);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('sess-01');
      expect(warnings[0]).toContain('48h');
    });

    it('should build multiple warnings for mixed orphan types', () => {
      const result: OrphanDetectionResult = {
        orphanedSprints: [{ id: 'sprint-21', title: 'Old Sprint', status: null }],
        orphanedMissions: [
          { id: 'm01', name: 'Lost', status: 'Queued', reason: 'no_sprint', startedAt: null },
        ],
        staleSessions: [
          {
            id: 'sess-01',
            type: 'build',
            title: 'Stale',
            startedAt: '2026-03-08T00:00:00Z',
            hoursActive: 36,
          },
        ],
        totalOrphans: 3,
      };
      const warnings = buildOrphanWarnings(result);
      expect(warnings).toHaveLength(3);
    });
  });
});
