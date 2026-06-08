// ABOUTME: Sprint 61 m03 — evergreen flag for institutional learnings.
// ABOUTME: Verifies lazy migration on read paths, staleness exclusion, two-way toggle, and FTS5 trigger preservation.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  detectAndFlagStaleness,
  getStaleCounts,
  DEFAULT_STALENESS_THRESHOLD,
} from '../../../src/tools/cmos/staleness-detection';
import {
  ensureLearningsTable,
  ensureDecisionsFts5,
} from '../../../src/tools/cmos/schema-migrations';
import { cmosLearningsList } from '../../../src/tools/cmos/cmos-learnings-list';
import { cmosLearningsUpdate } from '../../../src/tools/cmos/cmos-learnings-update';

/**
 * Make a temp DB WITHOUT the evergreen column on the learnings table — simulates
 * a pre-Sprint 61 m03 schema. Read paths must self-heal via ensureLearningsTable.
 */
function makeUnmigratedDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-evergreen-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT
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

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sprint_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.close();
  return { tempDir, dbPath };
}

async function openClient(dbPath: string): Promise<CmosDatabaseClient> {
  const r = await CmosDatabaseClient.create({ dbPath });
  if (!r.success || !r.data) throw new Error('open failed');
  return r.data;
}

function cleanup(tempDir: string, client?: CmosDatabaseClient): void {
  if (client) client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function hasColumn(dbPath: string, table: string, column: string): boolean {
  const db = new Database(dbPath);
  try {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } finally {
    db.close();
  }
}

function readEvergreen(dbPath: string, learningId: number): number | null {
  const db = new Database(dbPath);
  try {
    const row = db.prepare(`SELECT evergreen FROM learnings WHERE id = ?`).get(learningId) as
      | { evergreen: number | null }
      | undefined;
    return row?.evergreen ?? null;
  } finally {
    db.close();
  }
}

describe('ensureLearningsTable — evergreen lazy migration', () => {
  it('adds the evergreen column to a pre-existing learnings table (idempotent)', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);

      const first = ensureLearningsTable(client);
      expect(first.columnsAdded).toContain('learnings.evergreen');
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);

      // Re-running is a no-op — column already there.
      const second = ensureLearningsTable(client);
      expect(second.columnsAdded).not.toContain('learnings.evergreen');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('creates the table with evergreen included on a fresh DB', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-evergreen-fresh-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.close();

    const client = await openClient(dbPath);
    try {
      ensureLearningsTable(client);
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('cmos_learnings(action="list") triggers the migration on an un-migrated DB without erroring', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      // Seed a row before the column exists — verifies that lazy migration
      // back-fills the existing row's `evergreen` value to the DEFAULT 0.
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, status, sprint_id, created_at) VALUES (?, 'active', 'sprint-1', '2026-01-01T00:00:00Z')`
      ).run('Pre-migration learning');
      db.close();

      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);

      const result = await cmosLearningsList({ projectRoot: tempDir });
      expect(result.success).toBe(true);

      // Migration should have fired during list.
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);
      expect(result.data?.learnings).toHaveLength(1);
      expect(result.data?.learnings[0].evergreen).toBe(false);
    } finally {
      cleanup(tempDir);
    }
  });
});

describe('staleness query gates on evergreen = 0', () => {
  it('flagStaleLearnings does NOT flag rows where evergreen = 1', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      // Seed sprints (threshold + 5).
      const totalSprints = DEFAULT_STALENESS_THRESHOLD + 5;
      const db = new Database(dbPath);
      for (let i = 1; i <= totalSprints; i++) {
        db.prepare(`INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)`).run(
          `sprint-${i}`,
          `Sprint ${i}`,
          i === totalSprints ? 'Active' : 'Completed'
        );
      }
      const oldCreated = new Date(Date.now() - 365 * 86400_000).toISOString();
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, 'sprint-2', 'active')`
      ).run('Evergreen institutional rule', oldCreated);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, 'sprint-2', 'active')`
      ).run('Old non-evergreen learning', oldCreated);
      db.close();

      // Apply the migration + flag the first learning as evergreen.
      ensureLearningsTable(client);
      client.execute(`UPDATE learnings SET evergreen = 1 WHERE id = 1`, []);

      const result = detectAndFlagStaleness(client);
      // Only the non-evergreen one should be flagged.
      expect(result.learningsFlagged).toBe(1);

      const db2 = new Database(dbPath);
      const rows = db2.prepare('SELECT id, status FROM learnings ORDER BY id').all() as Array<{
        id: number;
        status: string;
      }>;
      db2.close();
      expect(rows).toEqual([
        { id: 1, status: 'active' }, // evergreen — exempt
        { id: 2, status: 'stale' }, // not evergreen — flagged
      ]);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('getStaleCounts excludes evergreen rows from the count', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      ensureLearningsTable(client);
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status, evergreen) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'stale', 1)`
      ).run('Was-stale, now flagged evergreen');
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status, evergreen) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'stale', 0)`
      ).run('Genuinely stale');
      db.close();

      const counts = getStaleCounts(client);
      expect(counts.staleLearnings).toBe(1); // evergreen one excluded
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('detectAndFlagStaleness on an un-migrated DB succeeds (read-path self-heal)', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      // Seed minimal data; do NOT call ensureLearningsTable manually.
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sprints (id, title, status) VALUES ('sprint-1', 'S1', 'Active')`
      ).run();
      db.close();

      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);

      // Should not throw `no such column: evergreen` — the staleness path
      // calls ensureLearningsTable to self-heal before reading the column.
      expect(() => detectAndFlagStaleness(client)).not.toThrow();

      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('cmos_learnings(action="update", evergreen=true|false) two-way toggle', () => {
  it('persists evergreen=true and back to false', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run('Cursor advance-only rule');
      db.close();

      const setTrue = await cmosLearningsUpdate({
        learningId: 1,
        evergreen: true,
        projectRoot: tempDir,
      });
      expect(setTrue.success).toBe(true);
      expect(setTrue.data?.previousEvergreen).toBe(false);
      expect(setTrue.data?.newEvergreen).toBe(true);
      expect(readEvergreen(dbPath, 1)).toBe(1);

      const setFalse = await cmosLearningsUpdate({
        learningId: 1,
        evergreen: false,
        projectRoot: tempDir,
      });
      expect(setFalse.success).toBe(true);
      expect(setFalse.data?.previousEvergreen).toBe(true);
      expect(setFalse.data?.newEvergreen).toBe(false);
      expect(readEvergreen(dbPath, 1)).toBe(0);
    } finally {
      cleanup(tempDir);
    }
  });

  it('combines status + evergreen in a single update', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'stale')`
      ).run('Stale rule that is actually evergreen');
      db.close();

      const result = await cmosLearningsUpdate({
        learningId: 1,
        status: 'active',
        evergreen: true,
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('stale');
      expect(result.data?.newStatus).toBe('active');
      expect(result.data?.newEvergreen).toBe(true);
    } finally {
      cleanup(tempDir);
    }
  });

  it('returns MISSING_PARAMETER when neither status nor evergreen is supplied', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run('No-op update');
      db.close();

      const result = await cmosLearningsUpdate({ learningId: 1, projectRoot: tempDir });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAMETER');
    } finally {
      cleanup(tempDir);
    }
  });

  it('a redundant evergreen=true call still bumps last_reviewed_at (tacit review)', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run('Already-evergreen rule');
      db.close();

      // First call: flip to evergreen.
      await cmosLearningsUpdate({ learningId: 1, evergreen: true, projectRoot: tempDir });
      // Second call: redundant evergreen=true with no status change.
      const noOp = await cmosLearningsUpdate({
        learningId: 1,
        evergreen: true,
        projectRoot: tempDir,
      });
      expect(noOp.success).toBe(true);
      expect(noOp.data?.message).toBe('No changes needed');

      const db2 = new Database(dbPath);
      const row = db2
        .prepare(`SELECT last_reviewed_at, evergreen FROM learnings WHERE id = 1`)
        .get() as { last_reviewed_at: string | null; evergreen: number };
      db2.close();
      expect(row.last_reviewed_at).not.toBeNull();
      expect(row.evergreen).toBe(1);
    } finally {
      cleanup(tempDir);
    }
  });
});

describe('FTS5 triggers on strategic_decisions remain unaffected', () => {
  it('decisions_fts is still maintained after the learnings.evergreen migration', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      ensureDecisionsFts5(client);
      ensureLearningsTable(client);

      // Insert a decision; the FTS5 trigger should index it.
      client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Schema choice: snake_case for SQLite columns', '2026-01-01T00:00:00Z', 'sprint-1', 'active')`,
        []
      );

      const ftsHit = client.getOne<{ rowid: number }>(
        `SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'snake_case' LIMIT 1`,
        []
      );
      expect(ftsHit.success).toBe(true);
      expect(ftsHit.data?.rowid).toBeGreaterThan(0);
    } finally {
      cleanup(tempDir, client);
    }
  });
});
