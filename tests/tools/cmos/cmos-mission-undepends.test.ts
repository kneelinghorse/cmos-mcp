/**
 * cmos_mission_undepends Tool Tests
 *
 * Tests for removing mission dependencies and the dependency_removed sync emit.
 *
 * @module tests/tools/cmos/cmos-mission-undepends
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosMissionUndepends,
  formatMissionUndependsForLLM,
  type MissionUndependsResult,
} from '../../../src/tools/cmos/cmos-mission-undepends';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

describe('cmos_mission_undepends', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-undepends-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;

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

      CREATE TABLE mission_dependencies (
        from_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id)
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
        value TEXT
      );
      INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');

      INSERT INTO sprints (id, title, status) VALUES ('sprint-01', 'Sprint 1', 'In Progress');

      INSERT INTO missions (id, sprint_id, name, status)
      VALUES
        ('m-01', 'sprint-01', 'Mission 1', 'Queued'),
        ('m-02', 'sprint-01', 'Mission 2', 'Queued'),
        ('m-03', 'sprint-01', 'Mission 3', 'Queued');

      INSERT INTO mission_dependencies (from_id, to_id, type)
      VALUES ('m-01', 'm-02', 'Blocks');
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Core Removal ──────────────────────────────────────────────────────────

  it('should remove an existing dependency', async () => {
    const result = await cmosMissionUndepends({
      fromId: 'm-01',
      toId: 'm-02',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.fromId).toBe('m-01');
    expect(result.data?.toId).toBe('m-02');
    expect(result.data?.removedAt).toBeDefined();
    expect(result.data?.message).toContain('blocks');

    // Verify it's actually gone from DB
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT * FROM mission_dependencies WHERE from_id = ? AND to_id = ?')
      .get('m-01', 'm-02');
    db.close();
    expect(row).toBeUndefined();
  });

  it('should log a session event on removal', async () => {
    await cmosMissionUndepends({
      fromId: 'm-01',
      toId: 'm-02',
      projectRoot: tempDir,
    });

    const db = new Database(dbPath, { readonly: true });
    const event = db
      .prepare("SELECT * FROM session_events WHERE status = 'dependency_removed'")
      .get() as any;
    db.close();

    expect(event).toBeDefined();
    expect(event.summary).toContain('Removed');
    expect(event.summary).toContain('m-01');
    expect(event.summary).toContain('m-02');
  });

  // ─── Error Cases ──────────────────────────────────────────────────────────

  it('should return error when dependency does not exist', async () => {
    const result = await cmosMissionUndepends({
      fromId: 'm-02',
      toId: 'm-03',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('No dependency found');
  });

  it('should return error when fromId is empty', async () => {
    const result = await cmosMissionUndepends({
      fromId: '',
      toId: 'm-02',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('fromId');
  });

  it('should return error when toId is empty', async () => {
    const result = await cmosMissionUndepends({
      fromId: 'm-01',
      toId: '',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('toId');
  });

  // ─── Formatter ────────────────────────────────────────────────────────────

  describe('formatMissionUndependsForLLM', () => {
    it('should format success result', () => {
      const result: CmosToolResult<MissionUndependsResult> = {
        success: true,
        data: {
          fromId: 'm-01',
          toId: 'm-02',
          removedAt: '2026-03-10T00:00:00Z',
          message: 'Dependency removed: m-01 no longer blocks m-02',
        },
      };
      const formatted = formatMissionUndependsForLLM(result);
      expect(formatted).toContain('Dependency removed');
      expect(formatted).toContain('m-01');
      expect(formatted).toContain('m-02');
    });

    it('should format error result', () => {
      const result: CmosToolResult<MissionUndependsResult> = {
        success: false,
        error: { code: 'INVALID_PARAMETER', message: 'No dependency found' },
      };
      const formatted = formatMissionUndependsForLLM(result);
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('No dependency found');
    });
  });
});
