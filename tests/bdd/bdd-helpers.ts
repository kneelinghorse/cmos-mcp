// ABOUTME: Shared setup helpers for BDD step definitions.
// ABOUTME: Creates a real project root structure that production tools can use via projectRoot param.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { CMOS_SCHEMA } from '../../src/tools/cmos/schema';

export interface BddTestInstance {
  projectRoot: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a minimal CMOS project structure at a temp directory.
 * The sqlite db lives at <projectRoot>/cmos/db/cmos.sqlite, matching
 * what the production client resolves when given a projectRoot.
 */
export async function createBddInstance(): Promise<BddTestInstance> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cmos-bdd-'));
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(CMOS_SCHEMA);
  db.close();

  CmosDetector.resetInstance();

  return {
    projectRoot,
    dbPath,
    cleanup: () => fs.rm(projectRoot, { recursive: true, force: true }),
  };
}

/** Insert a sprint directly into the test db. */
export function insertSprint(
  dbPath: string,
  opts: { id: string; title?: string; status?: string }
): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT OR IGNORE INTO sprints (id, title, status) VALUES (?, ?, ?)`).run(
    opts.id,
    opts.title ?? opts.id,
    opts.status ?? 'Active'
  );
  db.close();
}

/** Insert a mission directly into the test db. */
export function insertMission(
  dbPath: string,
  opts: {
    id: string;
    name: string;
    sprintId?: string | null;
    status: string;
    startedAt?: string | null;
    notes?: string | null;
    objective?: string | null;
  }
): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO missions (id, sprint_id, name, status, started_at, notes, objective)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.sprintId ?? null,
    opts.name,
    opts.status,
    opts.startedAt ?? null,
    opts.notes ?? null,
    opts.objective ?? null
  );
  db.close();
}

/** Insert a session directly into the test db. */
export function insertSession(
  dbPath: string,
  opts: { id: string; title: string; status: string; sprintId?: string | null }
): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status)
     VALUES (?, 'planning', ?, ?, datetime('now'), 'test-agent', ?)`
  ).run(opts.id, opts.title, opts.sprintId ?? null, opts.status);
  db.close();
}

/** Insert a strategic decision into the test db. */
export function insertDecision(
  dbPath: string,
  opts: { id?: string; decisionText: string; category?: string; evidence?: string }
): void {
  const db = new Database(dbPath);
  // Only insert if decisions table exists
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'`)
    .get();
  if (tableExists) {
    db.prepare(
      `INSERT INTO decisions (id, decision_text, category, evidence, created_at, status)
       VALUES (?, ?, ?, ?, datetime('now'), 'active')`
    ).run(
      opts.id ?? `dec-${Date.now()}`,
      opts.decisionText,
      opts.category ?? 'architecture',
      opts.evidence ?? null
    );
  }
  db.close();
}

/** Read a mission row directly from the db. */
export function readMission(dbPath: string, missionId: string): Record<string, unknown> | null {
  const db = new Database(dbPath);
  const row = db.prepare(`SELECT * FROM missions WHERE id = ?`).get(missionId) as
    | Record<string, unknown>
    | undefined;
  db.close();
  return row ?? null;
}

/** Read session_events rows for a given entity. */
export function readEvents(dbPath: string, opts?: { action?: string }): Record<string, unknown>[] {
  const db = new Database(dbPath);
  let rows: Record<string, unknown>[];
  if (opts?.action) {
    rows = db.prepare(`SELECT * FROM session_events WHERE action = ?`).all(opts.action) as Record<
      string,
      unknown
    >[];
  } else {
    rows = db.prepare(`SELECT * FROM session_events`).all() as Record<string, unknown>[];
  }
  db.close();
  return rows;
}
