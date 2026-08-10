import { describe, expect, test, afterEach, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  selectSnapshotsToPrune,
  resolveKeepN,
  isSprintCompleteSource,
  DEFAULT_SNAPSHOT_PRUNE_KEEP,
  type SnapshotRow,
} from '../../../src/tools/cmos/context-snapshot-prune';

// ─── PURE selection logic ────────────────────────────────────────────────────

function row(over: Partial<SnapshotRow> & { id: number }): SnapshotRow {
  return {
    contextId: 'master_context',
    source: 'session_complete:X',
    createdAt: '2026-01-01T00:00:00.000Z',
    contentLength: 100,
    contentPrunedAt: null,
    ...over,
  };
}

describe('selectSnapshotsToPrune (pure)', () => {
  test('keeps the last-N per context, prunes the rest', () => {
    const rows = [
      row({ id: 1, createdAt: '2026-01-01T00:00:00Z' }),
      row({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
      row({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
    ];
    const sel = selectSnapshotsToPrune(rows, new Set(), { keepPerContext: 1, days: 0, nowMs: 0 });
    // Newest (id 3) preserved; 1 & 2 prunable.
    expect(sel.preserveIds).toContain(3);
    expect(sel.prunableIds.sort()).toEqual([1, 2]);
    expect(sel.bytesReclaimable).toBe(200);
  });

  test('preserves FK-referenced, sprint_complete, and newest-per-context (union)', () => {
    const rows = [
      row({ id: 1, createdAt: '2026-01-01T00:00:00Z' }), // prunable
      row({ id: 2, createdAt: '2026-01-02T00:00:00Z', source: 'sprint_complete:sprint-1' }), // milestone
      row({ id: 3, createdAt: '2026-01-03T00:00:00Z' }), // FK-referenced
      row({ id: 4, createdAt: '2026-01-04T00:00:00Z' }), // newest
    ];
    const sel = selectSnapshotsToPrune(rows, new Set([3]), {
      keepPerContext: 1,
      days: 0,
      nowMs: 0,
    });
    expect(sel.prunableIds).toEqual([1]);
    expect(new Set(sel.preserveIds)).toEqual(new Set([2, 3, 4]));
    expect(sel.preserveReasons.sprintComplete).toBe(1);
    expect(sel.preserveReasons.fkReferenced).toBe(1);
    expect(sel.preserveReasons.newestPerContext + sel.preserveReasons.lastN).toBeGreaterThanOrEqual(
      1
    );
  });

  test('days>0 preserves rows within the window; days=0 disables age preservation', () => {
    const nowMs = Date.parse('2026-02-01T00:00:00Z');
    const rows = [
      row({ id: 1, createdAt: '2026-01-01T00:00:00Z' }), // 31d old → prunable
      row({ id: 2, createdAt: '2026-01-28T00:00:00Z' }), // 4d old, NOT newest → within-days only
      row({ id: 3, createdAt: '2026-01-30T00:00:00Z' }), // 2d old, newest → lastN
    ];
    const withDays = selectSnapshotsToPrune(rows, new Set(), { keepPerContext: 1, days: 7, nowMs });
    // id 2 (4d, not newest) preserved SOLELY by within-days; id 1 (31d) prunable.
    expect(withDays.prunableIds).toEqual([1]);
    expect(withDays.preserveReasons.withinDays).toBe(1);
    const noDays = selectSnapshotsToPrune(rows, new Set(), { keepPerContext: 1, days: 0, nowMs });
    // Without days, only newest (id 3) preserved by keep=1 → id 1 AND id 2 prunable.
    expect(noDays.prunableIds.sort()).toEqual([1, 2]);
  });

  test('never re-counts an already-tombstoned or empty row as prunable', () => {
    const rows = [
      row({ id: 1, contentPrunedAt: '2026-01-01T00:00:00Z', contentLength: 0 }),
      row({ id: 2, contentLength: 0 }),
      row({ id: 3, createdAt: '2026-01-03T00:00:00Z' }),
    ];
    const sel = selectSnapshotsToPrune(rows, new Set(), { keepPerContext: 1, days: 0, nowMs: 0 });
    // id 3 newest (preserved); 1 already-pruned, 2 empty → neither prunable.
    expect(sel.prunableIds).toEqual([]);
    expect(sel.bytesReclaimable).toBe(0);
  });

  test('isSprintCompleteSource: only the pure sprint_complete prefix (NOT mission_complete)', () => {
    expect(isSprintCompleteSource('sprint_complete:sprint-33')).toBe(true);
    expect(isSprintCompleteSource('mission_complete:s50-m04:sprint_complete')).toBe(false);
    expect(isSprintCompleteSource('session_complete:PS-1')).toBe(false);
    expect(isSprintCompleteSource(null)).toBe(false);
  });

  test('resolveKeepN: flag > env > default', () => {
    expect(resolveKeepN(5, '99')).toBe(5);
    expect(resolveKeepN(undefined, '99')).toBe(99);
    expect(resolveKeepN(undefined, undefined)).toBe(DEFAULT_SNAPSHOT_PRUNE_KEEP);
    expect(resolveKeepN(undefined, 'garbage')).toBe(DEFAULT_SNAPSHOT_PRUNE_KEEP);
    expect(resolveKeepN(-1, undefined)).toBe(DEFAULT_SNAPSHOT_PRUNE_KEEP);
  });
});

// ─── Real-store positive-fire (Process Hardening #4) ─────────────────────────

const GENESIS_COLS =
  'project_id TEXT, stable_event_id TEXT, occurred_at INTEGER, origin_seq INTEGER, event_type TEXT, schema_version INTEGER DEFAULT 1, author_user_id TEXT';

/** Seed a store whose context_snapshots table LACKS content_pruned_at (so the migration
 *  must land it), with rows across two contexts + one FK-referenced by a decision. */
function seedStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-snap-prune-'));
  fs.mkdirSync(path.join(dir, 'cmos', 'db'), { recursive: true });
  const db = new Database(path.join(dir, 'cmos', 'db', 'cmos.sqlite'));
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value) VALUES ('project_id', 'local-proj'), ('project_name', 'Local');
    CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
    INSERT INTO contexts (id, source_path, content, updated_at) VALUES
      ('master_context', 'ctx', 'MASTER_BODY', '2026-01-01'),
      ('project_context', 'ctx', 'PROJECT_BODY', '2026-01-01');
    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT, source TEXT,
      content_hash TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, ${GENESIS_COLS},
      FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
    );
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_text TEXT NOT NULL, created_at TEXT NOT NULL,
      snapshot_id INTEGER, ${GENESIS_COLS}
    );
  `);
  const ins = db.prepare(
    `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at, project_id, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, 'local-proj', 'snapshot_taken', 1)`
  );
  ins.run(1, 'master_context', 'session_complete:A', 'h1', 'AAAA', '2026-01-01T00:00:00Z');
  ins.run(2, 'master_context', 'sprint_complete:sprint-1', 'h2', 'BBBB', '2026-01-02T00:00:00Z');
  ins.run(3, 'master_context', 'mission_complete:Y', 'h3', 'CCCC', '2026-01-03T00:00:00Z');
  ins.run(4, 'master_context', 'session_complete:Z', 'h4', 'DDDD', '2026-01-04T00:00:00Z');
  ins.run(5, 'project_context', 'session_complete:W', 'h5', 'EEEE', '2026-01-06T00:00:00Z');
  ins.run(6, 'project_context', 'session_complete:V', 'h6', 'FFFF', '2026-01-05T00:00:00Z');
  // A decision FK-references snapshot 3 → its content must be preserved.
  db.prepare(
    `INSERT INTO strategic_decisions (decision_text, created_at, snapshot_id, project_id, event_type)
     VALUES ('d', '2026-01-03T00:00:00Z', 3, 'local-proj', 'decision_captured')`
  ).run();
  db.close();
  return dir;
}

function openReadonly(dir: string): InstanceType<typeof Database> {
  return new Database(path.join(dir, 'cmos', 'db', 'cmos.sqlite'), { readonly: true });
}

async function runPrune(dir: string, extra: string[]): Promise<void> {
  const { pruneContextSnapshots } = await import('../../../scripts/prune-context-snapshots');
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedErr = console.error;
  process.argv = ['node', 'prune', `--projectRoot=${dir}`, ...extra];
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await pruneContextSnapshots();
    expect(code).toBe(0);
  } finally {
    process.argv = savedArgv;
    console.log = savedLog;
    console.error = savedErr;
  }
}

describe('prune-context-snapshots (real store)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    jest.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test('dry-run (default) writes NOTHING — no tombstones AND no schema change', async () => {
    const dir = seedStore();
    dirs.push(dir);
    await runPrune(dir, ['--keep=1']);
    const db = openReadonly(dir);
    const emptied = db
      .prepare(`SELECT COUNT(*) AS c FROM context_snapshots WHERE content = ''`)
      .get() as { c: number };
    // Dry-run is strictly read-only: no content emptied AND the migration column not added.
    const cols = (
      db.prepare(`PRAGMA table_info('context_snapshots')`).all() as { name: string }[]
    ).map((c) => c.name);
    db.close();
    expect(emptied.c).toBe(0);
    expect(cols).not.toContain('content_pruned_at');
  });

  test('--apply landed the migration column AND tombstoned only the prunable rows', async () => {
    const dir = seedStore();
    dirs.push(dir);
    await runPrune(dir, ['--apply', '--keep=1']);

    const db = openReadonly(dir);
    // Migration landed the column (exercised before the read filters).
    const cols = (
      db.prepare(`PRAGMA table_info('context_snapshots')`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('content_pruned_at');

    const byId = new Map(
      (
        db
          .prepare(
            `SELECT id, content, content_pruned_at, snapshot_id_ref FROM
             (SELECT cs.id, cs.content, cs.content_pruned_at,
                     (SELECT COUNT(*) FROM strategic_decisions sd WHERE sd.snapshot_id = cs.id) AS snapshot_id_ref
              FROM context_snapshots cs)`
          )
          .all() as {
          id: number;
          content: string;
          content_pruned_at: string | null;
          snapshot_id_ref: number;
        }[]
      ).map((r) => [r.id, r])
    );

    // Preserved with content intact: sprint_complete(2), FK(3), newest master(4), newest project(5).
    for (const id of [2, 3, 4, 5]) {
      expect(byId.get(id)!.content).not.toBe('');
      expect(byId.get(id)!.content_pruned_at).toBeNull();
    }
    // Prunable tombstoned: oldest master(1) + older project(6).
    for (const id of [1, 6]) {
      expect(byId.get(id)!.content).toBe('');
      expect(byId.get(id)!.content_pruned_at).not.toBeNull();
    }
    // Row count unchanged (content-tombstone, not delete).
    const count = db.prepare(`SELECT COUNT(*) AS c FROM context_snapshots`).get() as { c: number };
    expect(count.c).toBe(6);
    // FK integrity: the decision still points at snapshot 3 (never nulled).
    const fk = db.prepare(`SELECT snapshot_id FROM strategic_decisions`).get() as {
      snapshot_id: number;
    };
    expect(fk.snapshot_id).toBe(3);
    db.close();
  });

  test('FK read carve-out: a store with NO strategic_decisions table prunes with a legitimate empty FK set', async () => {
    // Structural absence (no decisions table) = no FK refs can exist → the guarded FK read
    // proceeds with an empty set (does NOT abort). Only a real read failure on a ref-bearing
    // store aborts (the fail-closed guard). Here the prune must still tombstone prunable rows.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-snap-nofk-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'cmos', 'db'), { recursive: true });
    const db = new Database(path.join(dir, 'cmos', 'db', 'cmos.sqlite'));
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'p');
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      INSERT INTO contexts (id, source_path, content, updated_at) VALUES ('master_context', 'c', 'B', '2026-01-01');
      CREATE TABLE context_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL,
        session_id TEXT, source TEXT, content_hash TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    const ins = db.prepare(
      `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at) VALUES (?,?,?,?,?,?)`
    );
    ins.run(1, 'master_context', 's', 'h1', 'OLD', '2026-01-01T00:00:00Z');
    ins.run(2, 'master_context', 's', 'h2', 'NEW', '2026-01-02T00:00:00Z');
    db.close();

    await runPrune(dir, ['--apply', '--keep=1']);
    const r = openReadonly(dir);
    const rows = r.prepare(`SELECT id, content FROM context_snapshots ORDER BY id`).all() as {
      id: number;
      content: string;
    }[];
    r.close();
    expect(rows.find((x) => x.id === 2)!.content).toBe('NEW'); // newest kept
    expect(rows.find((x) => x.id === 1)!.content).toBe(''); // oldest tombstoned
  });

  test('DEDUP-SAFETY (Rev4): identical content re-persists FRESH, not deduped onto the tombstone', async () => {
    const dir = seedStore();
    dirs.push(dir);
    const { cmosContextSnapshot } = await import('../../../src/tools/cmos/cmos-context-snapshot');

    // Snapshot master_context ('MASTER_BODY') → creates a content-bearing row.
    const first = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'test:1',
      projectRoot: dir,
    });
    expect(first.success).toBe(true);
    const firstId = (first.data as { snapshotId: number }).snapshotId;

    // Tombstone THAT row directly (simulating a prior prune).
    const dbw = new Database(path.join(dir, 'cmos', 'db', 'cmos.sqlite'));
    dbw.prepare(`ALTER TABLE context_snapshots ADD COLUMN content_pruned_at TEXT`).run();
    dbw
      .prepare(`UPDATE context_snapshots SET content = '', content_pruned_at = ? WHERE id = ?`)
      .run('2026-02-01T00:00:00Z', firstId);
    dbw.close();

    // Snapshot the SAME content again → must NOT dedup onto the emptied row; must insert fresh.
    const second = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'test:2',
      projectRoot: dir,
    });
    expect(second.success).toBe(true);
    const secondData = second.data as { snapshotId: number; isNew: boolean };
    expect(secondData.isNew).toBe(true);
    expect(secondData.snapshotId).not.toBe(firstId);

    const db = openReadonly(dir);
    const same = db
      .prepare(
        `SELECT content_hash, content, content_pruned_at FROM context_snapshots WHERE content_hash =
           (SELECT content_hash FROM context_snapshots WHERE id = ?)`
      )
      .all(firstId) as {
      content_hash: string;
      content: string;
      content_pruned_at: string | null;
    }[];
    db.close();
    // Two rows share the hash: the tombstoned one (empty) and a fresh content-bearing one.
    expect(same.length).toBe(2);
    expect(same.some((r) => r.content_pruned_at != null && r.content === '')).toBe(true);
    expect(same.some((r) => r.content_pruned_at == null && r.content.length > 0)).toBe(true);
  });

  test('content_pruned_at + its tombstone value SURVIVE the firehose 12-step rebuild (migration-order)', async () => {
    // Fresh-seed shape: content_pruned_at present + event_type still NULLABLE (no firehose
    // marker) → the next genesis write triggers the 12-step rebuild. It must preserve the
    // column AND the tombstone value (rebuild derives DDL from the live table + copies all cols).
    const dir = seedStore();
    dirs.push(dir);
    const dbw = new Database(path.join(dir, 'cmos', 'db', 'cmos.sqlite'));
    dbw.prepare(`ALTER TABLE context_snapshots ADD COLUMN content_pruned_at TEXT`).run();
    dbw
      .prepare(`UPDATE context_snapshots SET content = '', content_pruned_at = ? WHERE id = 1`)
      .run('2026-02-01T00:00:00Z');
    dbw.close();

    // A snapshot write drives genesisColumns → ensureFirehoseEventColumns → the rebuild.
    const { cmosContextSnapshot } = await import('../../../src/tools/cmos/cmos-context-snapshot');
    const res = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'rebuild:1',
      projectRoot: dir,
    });
    expect(res.success).toBe(true);

    const db = openReadonly(dir);
    const cols = (
      db.prepare(`PRAGMA table_info('context_snapshots')`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('content_pruned_at'); // survived the rebuild
    const r1 = db
      .prepare(`SELECT content, content_pruned_at FROM context_snapshots WHERE id = 1`)
      .get() as {
      content: string;
      content_pruned_at: string | null;
    };
    db.close();
    expect(r1.content_pruned_at).toBe('2026-02-01T00:00:00Z'); // value preserved
    expect(r1.content).toBe('');
  });

  test('cmos_context(history) flags a tombstoned row as contentPruned', async () => {
    const dir = seedStore();
    dirs.push(dir);
    await runPrune(dir, ['--apply', '--keep=1']);
    const { cmosContextHistory } = await import('../../../src/tools/cmos/cmos-context-history');
    const res = await cmosContextHistory({ projectRoot: dir, pageSize: 100 });
    expect(res.success).toBe(true);
    const snaps = res.data!.snapshots;
    const pruned = snaps
      .filter((s) => s.contentPruned)
      .map((s) => s.id)
      .sort();
    expect(pruned).toEqual([1, 6]);
    // Intact rows are not flagged.
    expect(snaps.find((s) => s.id === 3)!.contentPruned).toBe(false);
  });
});
