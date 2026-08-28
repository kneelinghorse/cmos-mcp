// SPDX-License-Identifier: Apache-2.0
// ABOUTME: OC-1 — a repair that rewrites 217 rows of a store it does not own must be proven on a
// ABOUTME: fixture first, including the ways it is required to REFUSE.

/**
 * OC-1 (sprint 87) — THE REPAIR'S OWN GUARDS ARE THE PART WORTH TESTING.
 *
 * The UPDATE is three lines and hard to get wrong. What is easy to get wrong is a repair that
 * reports success having done nothing, or that restamps rows to a second sentinel, or that
 * snapshots with a `cp` and loses the WAL. Each of those is a surface asserting something that is
 * not so — the class this sprint exists to close — so each has an arm here.
 *
 * Every precondition below is ESTABLISHED, never inherited (#547): the fixture writes its own
 * sentinel rows, its own identity, and its own WAL state.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  applyPlan,
  buildPlan,
  snapshotStore,
  storeDbPath,
} from '../../scripts/repair-unknown-project';

let root: string;

/** A store carrying `n` sentinel rows across two tables plus one correctly-stamped row. */
function seedStore(opts: { identity: string | null; sentinel?: string }): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-oc1-'));
  const dbDir = path.join(root, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'cmos.sqlite'));
  const sentinel = opts.sentinel ?? 'unknown-project';
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE sprints (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE learnings (id INTEGER PRIMARY KEY, project_id TEXT);
  `);
  if (opts.identity !== null) {
    db.prepare("INSERT INTO metadata (key, value) VALUES ('project_id', ?)").run(opts.identity);
  }
  const m = db.prepare('INSERT INTO missions (id, project_id) VALUES (?, ?)');
  m.run('m1', sentinel);
  m.run('m2', sentinel);
  m.run('m3', 'already-correct'); // negative control: must NOT be touched
  db.prepare('INSERT INTO sprints (id, project_id) VALUES (?, ?)').run('s1', sentinel);
  db.close();
}

function projectIdsOf(table: string): string[] {
  const db = new Database(storeDbPath(root), { readonly: true });
  try {
    return (
      db.prepare(`SELECT project_id FROM ${table} ORDER BY rowid`).all() as Array<{
        project_id: string;
      }>
    ).map((r) => r.project_id);
  } finally {
    db.close();
  }
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('OC-1 repair — restamping the sentinel', () => {
  it('counts the sentinel rows per table and resolves the identity from the store itself', () => {
    seedStore({ identity: 'derekn.com' });
    const plan = buildPlan(root);
    expect(plan.targetProjectId).toBe('derekn.com');
    expect(plan.total).toBe(3);
    expect(plan.counts).toEqual([
      { table: 'missions', rows: 2 },
      { table: 'sprints', rows: 1 },
    ]);
    // A table with no sentinel row is absent from the plan, not present with rows: 0 — the plan
    // is what will be written, and listing a table it will not touch overstates it.
    expect(plan.counts.some((c) => c.table === 'learnings')).toBe(false);
  });

  it('BUILDING THE PLAN DOES NOT WRITE — the dry run exists to be looked at', () => {
    seedStore({ identity: 'derekn.com' });
    const before = projectIdsOf('missions');
    buildPlan(root);
    expect(projectIdsOf('missions')).toEqual(before);
  });

  it('applies the plan and leaves a correctly-stamped row alone', () => {
    seedStore({ identity: 'derekn.com' });
    const changed = applyPlan(buildPlan(root));
    expect(changed).toEqual([
      { table: 'missions', rows: 2 },
      { table: 'sprints', rows: 1 },
    ]);
    // 'already-correct' is the negative control. A predicate of `project_id != target` would
    // rewrite it too and the row counts alone would not show it.
    expect(projectIdsOf('missions')).toEqual(['derekn.com', 'derekn.com', 'already-correct']);
  });

  it('treats the EMPTY STRING as a sentinel too — both spellings of "no identity" exist', () => {
    seedStore({ identity: 'derekn.com', sentinel: '' });
    expect(buildPlan(root).total).toBe(3);
    applyPlan(buildPlan(root));
    expect(projectIdsOf('sprints')).toEqual(['derekn.com']);
  });

  it('REFUSES a store whose own identity is missing, rather than inventing one', () => {
    seedStore({ identity: null });
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildPlan(root)).toThrow('exited');
      expect(err.mock.calls.flat().join(' ')).toMatch(/records no usable project identity/);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
    // And nothing was written on the way to refusing.
    expect(projectIdsOf('missions')).toEqual([
      'unknown-project',
      'unknown-project',
      'already-correct',
    ]);
  });

  it('REFUSES to restamp rows to a second sentinel — a no-op reported as a repair', () => {
    seedStore({ identity: 'unknown-project' });
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildPlan(root)).toThrow('exited');
      expect(err.mock.calls.flat().join(' ')).toMatch(/would report a repair that did not happen/);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });

  it('SNAPSHOTS THROUGH THE WAL — a file copy would silently drop uncommitted-to-main rows', async () => {
    seedStore({ identity: 'derekn.com' });
    const dbPath = storeDbPath(root);
    // Put a row in the WAL sidecar and leave it there: this is exactly the state in which `cp`
    // produces a short, openable, wrong copy.
    const live = new Database(dbPath);
    live.pragma('journal_mode = WAL');
    live
      .prepare('INSERT INTO missions (id, project_id) VALUES (?, ?)')
      .run('m4', 'unknown-project');
    // NOT closed before snapshotting — the sidecar is live.
    const snap = await snapshotStore(dbPath, '2026-08-28T00:00:00.000Z');
    live.close();

    expect(fs.existsSync(snap)).toBe(true);
    const copy = new Database(snap, { readonly: true });
    try {
      const { c } = copy.prepare('SELECT COUNT(*) AS c FROM missions').get() as { c: number };
      expect(c).toBe(4); // 3 seeded + the WAL-resident row
    } finally {
      copy.close();
    }
  });

  it('the snapshot is taken BEFORE the write, so it holds the pre-repair values', async () => {
    seedStore({ identity: 'derekn.com' });
    const snap = await snapshotStore(storeDbPath(root), '2026-08-28T00:00:01.000Z');
    applyPlan(buildPlan(root));

    const copy = new Database(snap, { readonly: true });
    try {
      const ids = (
        copy.prepare('SELECT project_id FROM missions ORDER BY rowid').all() as Array<{
          project_id: string;
        }>
      ).map((r) => r.project_id);
      // The undo handle is only an undo handle if it still holds what was overwritten.
      expect(ids).toEqual(['unknown-project', 'unknown-project', 'already-correct']);
    } finally {
      copy.close();
    }
    expect(projectIdsOf('missions')).toEqual(['derekn.com', 'derekn.com', 'already-correct']);
  });
});
