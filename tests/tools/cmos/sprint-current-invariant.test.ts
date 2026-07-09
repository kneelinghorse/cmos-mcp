// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m01 — drives the REAL cmosSprintAdd/cmosSprintUpdate handlers to prove
// the write-time single-current-sprint invariant (auto-demote + warn, atomic rollback).

/**
 * Single-current-sprint invariant tests (s77-m01).
 *
 * These exercise the REAL handlers (not a reimplementation) against a temp store
 * in the standard cmos/db/cmos.sqlite layout, so the genesis-stamping + migration
 * ordering + transaction rollback all run for real — the design doc's Verify.
 *
 * @module tests/tools/cmos/sprint-current-invariant
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosSprintAdd } from '../../../src/tools/cmos/cmos-sprint-add';
import { cmosSprintUpdate } from '../../../src/tools/cmos/cmos-sprint-update';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('single-current-sprint invariant (s77-m01)', () => {
  let tempDir: string;
  let dbPath: string;

  function projectRoot(): string {
    return tempDir;
  }

  function openDb(): InstanceType<typeof Database> {
    return new Database(dbPath);
  }

  function statusOf(id: string): string | undefined {
    const db = openDb();
    const row = db.prepare('SELECT status FROM sprints WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    db.close();
    return row?.status;
  }

  function allStatuses(): Record<string, string> {
    const db = openDb();
    const rows = db.prepare('SELECT id, status FROM sprints').all() as Array<{
      id: string;
      status: string;
    }>;
    db.close();
    return Object.fromEntries(rows.map((r) => [r.id, r.status]));
  }

  function activeCount(): number {
    return Object.values(allStatuses()).filter((s) => s === 'Active').length;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-current-sprint-inv-'));
    const dbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = openDb();
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

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_name', 'CMOS Invariant Test');
      INSERT INTO metadata (key, value) VALUES ('project_id', 'cmos-invariant-test');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('cmos_sprint add', () => {
    it('demotes the existing Active sprint to Planned when adding a default (Active) sprint', async () => {
      const first = await cmosSprintAdd({
        sprintId: 'sprint-a',
        title: 'Sprint A',
        projectRoot: projectRoot(),
      });
      expect(first.success).toBe(true);
      expect(statusOf('sprint-a')).toBe('Active');

      const second = await cmosSprintAdd({
        sprintId: 'sprint-b',
        title: 'Sprint B',
        projectRoot: projectRoot(),
      });
      expect(second.success).toBe(true);

      // Exactly one Active remains; the prior sprint is demoted to Planned.
      expect(activeCount()).toBe(1);
      expect(statusOf('sprint-a')).toBe('Planned');
      expect(statusOf('sprint-b')).toBe('Active');

      // The warning names the demoted sprint.
      expect(second.warnings).toBeDefined();
      const warning = (second.warnings ?? []).join(' ');
      expect(warning).toMatch(/[Dd]emoted 1 other open sprint/);
      expect(warning).toContain('sprint-a');
      expect(warning).toContain('Planned');
    });

    it('demotes an In Progress and a Current sprint (whole OPEN set), case-insensitively', async () => {
      // Seed two open sprints with different open statuses (incl. drifted case).
      const db = openDb();
      db.prepare(
        "INSERT INTO sprints (id, title, status) VALUES ('sprint-a', 'A', 'In Progress')"
      ).run();
      db.prepare(
        "INSERT INTO sprints (id, title, status) VALUES ('sprint-b', 'B', 'current')"
      ).run();
      db.close();

      const result = await cmosSprintAdd({
        sprintId: 'sprint-c',
        title: 'Sprint C',
        status: 'Active',
        projectRoot: projectRoot(),
      });
      expect(result.success).toBe(true);

      expect(statusOf('sprint-a')).toBe('Planned');
      expect(statusOf('sprint-b')).toBe('Planned');
      expect(statusOf('sprint-c')).toBe('Active');
      expect(activeCount()).toBe(1);

      const warning = (result.warnings ?? []).join(' ');
      expect(warning).toMatch(/[Dd]emoted 2 other open sprints/);
    });

    it('is warning-free when adding the sole Active sprint (nothing to demote)', async () => {
      const result = await cmosSprintAdd({
        sprintId: 'sprint-a',
        title: 'Sprint A',
        projectRoot: projectRoot(),
      });
      expect(result.success).toBe(true);
      expect(statusOf('sprint-a')).toBe('Active');
      expect(result.warnings ?? []).toHaveLength(0);
    });

    it('demotes nothing when adding a non-open (Planned) sprint alongside an Active one', async () => {
      const first = await cmosSprintAdd({
        sprintId: 'sprint-a',
        title: 'Sprint A',
        projectRoot: projectRoot(),
      });
      expect(first.success).toBe(true);

      const second = await cmosSprintAdd({
        sprintId: 'sprint-b',
        title: 'Sprint B',
        status: 'Planned',
        projectRoot: projectRoot(),
      });
      expect(second.success).toBe(true);

      // The Active sprint is untouched; the new one is Planned.
      expect(statusOf('sprint-a')).toBe('Active');
      expect(statusOf('sprint-b')).toBe('Planned');
      expect(activeCount()).toBe(1);
      expect(second.warnings ?? []).toHaveLength(0);
    });
  });

  describe('cmos_sprint update', () => {
    it('demotes other Active sprints when updating a sprint TO Active', async () => {
      await cmosSprintAdd({ sprintId: 'sprint-a', title: 'Sprint A', projectRoot: projectRoot() });
      await cmosSprintAdd({
        sprintId: 'sprint-b',
        title: 'Sprint B',
        status: 'Planned',
        projectRoot: projectRoot(),
      });
      expect(statusOf('sprint-a')).toBe('Active');
      expect(statusOf('sprint-b')).toBe('Planned');

      // Promote sprint-b to Active — sprint-a must be demoted in the same call.
      const result = await cmosSprintUpdate({
        sprintId: 'sprint-b',
        fields: { status: 'Active' },
        projectRoot: projectRoot(),
      });
      expect(result.success).toBe(true);
      expect(statusOf('sprint-b')).toBe('Active');
      expect(statusOf('sprint-a')).toBe('Planned');
      expect(activeCount()).toBe(1);

      const warning = (result.warnings ?? []).join(' ');
      expect(warning).toMatch(/[Dd]emoted 1 other open sprint/);
      expect(warning).toContain('sprint-a');
    });

    it('demotes nothing when updating a sprint to a non-open status (Completed)', async () => {
      await cmosSprintAdd({ sprintId: 'sprint-a', title: 'Sprint A', projectRoot: projectRoot() });
      await cmosSprintAdd({
        sprintId: 'sprint-b',
        title: 'Sprint B',
        status: 'Planned',
        projectRoot: projectRoot(),
      });

      const result = await cmosSprintUpdate({
        sprintId: 'sprint-a',
        fields: { status: 'Completed' },
        projectRoot: projectRoot(),
      });
      expect(result.success).toBe(true);
      expect(statusOf('sprint-a')).toBe('Completed');
      expect(statusOf('sprint-b')).toBe('Planned');
      expect(result.warnings ?? []).toHaveLength(0);
    });

    it('demotes nothing on a field-only update (no status change)', async () => {
      await cmosSprintAdd({ sprintId: 'sprint-a', title: 'Sprint A', projectRoot: projectRoot() });
      await cmosSprintAdd({
        sprintId: 'sprint-b',
        title: 'Sprint B',
        status: 'Planned',
        projectRoot: projectRoot(),
      });
      // sprint-a Active, sprint-b Planned. Editing sprint-b's focus must not touch sprint-a.
      const result = await cmosSprintUpdate({
        sprintId: 'sprint-b',
        fields: { focus: 'New focus' },
        projectRoot: projectRoot(),
      });
      expect(result.success).toBe(true);
      expect(statusOf('sprint-a')).toBe('Active');
      expect(statusOf('sprint-b')).toBe('Planned');
      expect(result.warnings ?? []).toHaveLength(0);
    });
  });

  describe('atomicity — the ordering hazard', () => {
    it('rolls back the demotion when the primary INSERT fails (NEITHER applied)', async () => {
      // First add migrates the store (genesis columns) and creates the Active sprint.
      const first = await cmosSprintAdd({
        sprintId: 'sprint-a',
        title: 'Sprint A',
        projectRoot: projectRoot(),
      });
      expect(first.success).toBe(true);
      expect(statusOf('sprint-a')).toBe('Active');

      // Poison the INSERT deterministically: a BEFORE INSERT trigger that ABORTs
      // for a specific id. Added AFTER migration so the 12-step rebuild (which
      // would drop triggers) is already done and marker-gated off.
      const db = openDb();
      db.exec(`
        CREATE TRIGGER poison_insert BEFORE INSERT ON sprints
        WHEN NEW.id = 'poison'
        BEGIN
          SELECT RAISE(ABORT, 'poisoned insert');
        END;
      `);
      db.close();

      const poisoned = await cmosSprintAdd({
        sprintId: 'poison',
        title: 'Poison',
        status: 'Active',
        projectRoot: projectRoot(),
      });
      expect(poisoned.success).toBe(false);

      // Rollback proof: sprint-a is STILL Active (demotion reverted) and the poison
      // row was never inserted.
      expect(statusOf('sprint-a')).toBe('Active');
      expect(statusOf('poison')).toBeUndefined();
      expect(activeCount()).toBe(1);
    });
  });
});
