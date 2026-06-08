// ABOUTME: Sprint 52 m03 — last_reviewed_at behavior. Verifies the schema migration,
// staleness exemption for recently-reviewed learnings, update-bump, and reaffirm flow.

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
import { ensureReviewTimestamps } from '../../../src/tools/cmos/schema-migrations';
import { cmosLearningsUpdate } from '../../../src/tools/cmos/cmos-learnings-update';
import { cmosLearningsReaffirm } from '../../../src/tools/cmos/cmos-learnings-reaffirm';

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-review-ts-test-'));
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

describe('ensureReviewTimestamps migration', () => {
  it('adds last_reviewed_at to learnings and strategic_decisions (idempotent)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const first = ensureReviewTimestamps(client);
      expect(first.columnsAdded).toEqual(
        expect.arrayContaining([
          'learnings.last_reviewed_at',
          'strategic_decisions.last_reviewed_at',
        ])
      );

      // Re-running is a no-op
      const second = ensureReviewTimestamps(client);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.columnsAdded).toEqual([]);

      // Column is actually there
      const db = new Database(dbPath);
      const learningCols = db.pragma('table_info(learnings)') as Array<{ name: string }>;
      const decisionCols = db.pragma('table_info(strategic_decisions)') as Array<{ name: string }>;
      db.close();
      expect(learningCols.some((c) => c.name === 'last_reviewed_at')).toBe(true);
      expect(decisionCols.some((c) => c.name === 'last_reviewed_at')).toBe(true);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('flagStaleLearnings respects last_reviewed_at', () => {
  it('does NOT re-flag a learning whose last_reviewed_at is recent', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      // (threshold + 5) sprints, last is active. Learning in sprint-2 is stale-eligible.
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
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('Evergreen learning', oldCreated, 'sprint-2');
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('Never-reviewed old learning', oldCreated, 'sprint-2');
      db.close();

      // Seed the column + set a recent last_reviewed_at on the first learning
      ensureReviewTimestamps(client);
      const nowIso = new Date().toISOString();
      client.execute(`UPDATE learnings SET last_reviewed_at = ? WHERE id = 1`, [nowIso]);

      const result = detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD });

      // Only the never-reviewed one should be flagged. The reaffirmed (id=1) stays active.
      expect(result.learningsFlagged).toBe(1);

      const db2 = new Database(dbPath);
      const rows = db2.prepare('SELECT id, status FROM learnings ORDER BY id').all() as Array<{
        id: number;
        status: string;
      }>;
      db2.close();
      expect(rows).toEqual([
        { id: 1, status: 'active' },
        { id: 2, status: 'stale' },
      ]);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('does NOT re-flag the same learning on a subsequent staleness run after archive', async () => {
    // Regression scenario from the reporter: count stuck at 11 after archiving 2.
    // With the review-timestamp fix, an archived learning is NOT reactivated as stale,
    // and no NEW sprint-id candidate flips 'active' → 'stale' if it has been touched.
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
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
      // 11 learnings in sprint-2 (old, stale-eligible), all active
      for (let i = 0; i < 11; i++) {
        db.prepare(
          `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
        ).run(`Learning ${i}`, oldCreated, 'sprint-2');
      }
      db.close();

      // First pass: all 11 flagged stale.
      const first = detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD });
      expect(first.learningsFlagged).toBe(11);
      expect(getStaleCounts(client).staleLearnings).toBe(11);

      // Operator archives 2 (this bumps last_reviewed_at via cmosLearningsUpdate).
      await cmosLearningsUpdate({ learningId: 1, status: 'archived', projectRoot: tempDir });
      await cmosLearningsUpdate({ learningId: 2, status: 'archived', projectRoot: tempDir });

      // Second pass: 2 archived, 9 stale — no re-flagging, no churn.
      const second = detectAndFlagStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD });
      expect(second.learningsFlagged).toBe(0);
      expect(getStaleCounts(client).staleLearnings).toBe(9);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('cmosLearningsUpdate bumps last_reviewed_at', () => {
  it('sets last_reviewed_at on status change', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('To archive', '2026-01-01T00:00:00Z', 'sprint-1');
      db.close();

      const before = client.getOne<{ last_reviewed_at: string | null }>(
        `SELECT last_reviewed_at FROM learnings WHERE id = 1`
      );
      // Column doesn't exist yet — update will run the migration
      expect(before.success).toBe(false);

      const result = await cmosLearningsUpdate({
        learningId: 1,
        status: 'archived',
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('active');
      expect(result.data?.newStatus).toBe('archived');

      const after = client.getOne<{ last_reviewed_at: string | null; status: string }>(
        `SELECT last_reviewed_at, status FROM learnings WHERE id = 1`
      );
      expect(after.success).toBe(true);
      expect(after.data?.status).toBe('archived');
      expect(after.data?.last_reviewed_at).not.toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('bumps last_reviewed_at even when status is unchanged (tacit review)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('Still active', '2026-01-01T00:00:00Z', 'sprint-1');
      db.close();

      const result = await cmosLearningsUpdate({
        learningId: 1,
        status: 'active', // same as current
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.message).toBe('No changes needed');

      const row = client.getOne<{ last_reviewed_at: string | null }>(
        `SELECT last_reviewed_at FROM learnings WHERE id = 1`
      );
      expect(row.data?.last_reviewed_at).not.toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('cmosLearningsReaffirm', () => {
  it('bumps last_reviewed_at without changing status', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'stale')`
      ).run('Evergreen', '2026-01-01T00:00:00Z', 'sprint-1');
      db.close();

      const result = await cmosLearningsReaffirm({ learningId: 1, projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('stale'); // unchanged
      expect(result.data?.reaffirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const row = client.getOne<{ last_reviewed_at: string | null; status: string }>(
        `SELECT last_reviewed_at, status FROM learnings WHERE id = 1`
      );
      expect(row.data?.last_reviewed_at).toBe(result.data?.reaffirmedAt);
      expect(row.data?.status).toBe('stale');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('returns MISSION_NOT_FOUND for unknown learning id', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const result = await cmosLearningsReaffirm({ learningId: 999, projectRoot: tempDir });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_NOT_FOUND');
    } finally {
      cleanup(tempDir);
    }
  });

  it('returns MISSING_PARAMETER when learningId is omitted', async () => {
    const result = await cmosLearningsReaffirm({} as { learningId: number });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });
});
