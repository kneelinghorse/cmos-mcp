// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m09 — close copies stop storing content, every recovery copy keeps it, and
// ABOUTME: cmos_db(prune_snapshots) reclaims old copies without deleting a row or a reference.

/**
 * Measured before the change, on the 24 registered stores: snapshot content was 367.6 MB of
 * 667.9 MB on disk (MB = 2^20 bytes), and the copies session and mission closes write after
 * persisting their context were 282.7 MB of it. Stage1 asked for a supported prune (msg 738cb21e) and found the trap a naive one
 * falls into: 23 of its snapshots are referenced (15 from master_context's archived sprint
 * summaries, 8 from decisions), and a keep rule built from age and sources alone would have
 * deleted all 23. The Stage1-shaped fixture below reproduces that shape.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { cmosContextCondense } from '../../../src/tools/cmos/cmos-context-condense';
import { cmosContextSnapshot } from '../../../src/tools/cmos/cmos-context-snapshot';
import { cmosContextUpdate } from '../../../src/tools/cmos/cmos-context-update';
import { cmosDb, formatDbForLLM } from '../../../src/tools/cmos/cmos-db';
import {
  readPruneInputs,
  readSnapshotReferences,
  readSnapshotRows,
  readSprintCloses,
  type CmosDbPruneSnapshotsResult,
} from '../../../src/tools/cmos/cmos-db-prune-snapshots';
import * as dbSnapshotModule from '../../../src/tools/cmos/cmos-db-snapshot';
import { cmosMissionTransition } from '../../../src/tools/cmos/cmos-mission-transition';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';
import { cmosSprint } from '../../../src/tools/cmos/cmos-sprint';
import {
  selectSnapshotsToPrune,
  type PruneConfig,
} from '../../../src/tools/cmos/context-snapshot-prune';
import { condenseContextForRetention } from '../../../src/tools/cmos/context-retention';
import {
  classifySnapshotSource,
  isAutomaticCopy,
  ONLY_COPY_SOURCE_SUFFIX,
  PRUNED_HASH_PREFIX,
  RETENTION_ARCHIVE_SOURCE_PREFIX,
  SNAPSHOT_INSERT_SITES,
  snapshotStorage,
} from '../../../src/tools/cmos/snapshot-content-policy';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();

let projectRoot: string;
let dbPath: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m09-'));
  dbPath = seedCmosDb(projectRoot, { projectName: 's92-m09 snapshot diet' });
  reidentifyCmosTestStore(projectRoot);
});

afterEach(() => {
  jest.restoreAllMocks();
  CmosDetector.resetInstance();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function withDb<T>(fn: (db: InstanceType<typeof Database>) => T, readonly = false): T {
  const db = new Database(dbPath, { readonly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface SnapshotDbRow {
  id: number;
  source: string | null;
  content: string;
  content_pruned_at: string | null;
}

function snapshotsWhere(sql: string, ...params: unknown[]): SnapshotDbRow[] {
  return withDb(
    (db) =>
      db
        .prepare(
          `SELECT id, source, content, content_pruned_at FROM context_snapshots WHERE ${sql} ORDER BY id`
        )
        .all(...params) as SnapshotDbRow[],
    true
  );
}

// ─── The published classification ────────────────────────────────────────────

describe('s92-m09 — every snapshot insert site is classified and consults the policy', () => {
  it('the predicate finds exactly the nine classified files', () => {
    // grep, not git grep: git grep skips untracked files, so a new file holding the literal would
    // pass unseen until it was committed (the s92-m09 critic's finding).
    const found = execFileSync('grep', ['-rln', 'INSERT INTO context_snapshots', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map((file) => path.basename(file))
      .sort();
    expect(found).toHaveLength(9);
    expect(found).toEqual(SNAPSHOT_INSERT_SITES.map((site) => site.file).sort());
  });

  it("each site's INSERT takes its content from the policy, with its declared kind", () => {
    for (const site of SNAPSHOT_INSERT_SITES) {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'src/tools/cmos', site.file), 'utf8');
      expect({
        file: site.file,
        consults: source.includes(`snapshotStorage('${site.kind}'`),
      }).toEqual({ file: site.file, consults: true });
      expect({ file: site.file, usesStorage: source.includes('storage.content') }).toEqual({
        file: site.file,
        usesStorage: true,
      });
    }
  });

  it('only a close persist copy goes content-less, and only when the live row was written', () => {
    for (const kind of ['milestone', 'explicit', 'pre-mutation', 'post-write'] as const) {
      expect(snapshotStorage(kind, 'X')).toMatchObject({ content: 'X', stored: true, columns: [] });
    }
    expect(snapshotStorage('close-persist', 'X')).toMatchObject({
      content: '',
      stored: false,
      columns: ['content_pruned_at'],
    });
    expect(snapshotStorage('close-persist', 'X', { liveCopyWritten: false })).toMatchObject({
      content: 'X',
      stored: true,
    });
    expect(snapshotStorage('close-persist', 'X', { canStamp: false })).toMatchObject({
      content: 'X',
      stored: true,
    });
  });

  it('classifies sources, including the legacy ones the measurement found', () => {
    expect(classifySnapshotSource('sprint_complete:sprint-3')).toBe('sprint-milestone');
    expect(classifySnapshotSource('session_complete:PS-1')).toBe('close-persist');
    // A mission close that closed its sprint: the context as the sprint closed.
    expect(classifySnapshotSource('mission_complete:s1-m1:sprint_complete')).toBe(
      'sprint-milestone'
    );
    expect(classifySnapshotSource(`session_complete:PS-1${ONLY_COPY_SOURCE_SUFFIX}`)).toBe(
      'only-copy'
    );
    expect(classifySnapshotSource('session_runtime')).toBe('legacy-close-persist');
    expect(classifySnapshotSource('mission_runtime')).toBe('legacy-close-persist');
    expect(classifySnapshotSource('session_start:auto_refresh')).toBe('post-write');
    expect(classifySnapshotSource('Context update: manual merge (master_context)')).toBe(
      'post-write'
    );
    expect(classifySnapshotSource('pre-migration: blob-schema-v2')).toBe('pre-mutation');
    expect(classifySnapshotSource('context_condense:aggressive')).toBe('pre-mutation');
    expect(classifySnapshotSource(`${RETENTION_ARCHIVE_SOURCE_PREFIX}session_complete:PS-1`)).toBe(
      'pre-mutation'
    );
    expect(classifySnapshotSource('Sprint 12 completed — sync foundation')).toBe(
      'explicit-or-unknown'
    );
    expect(isAutomaticCopy('explicit-or-unknown')).toBe(false);
    expect(isAutomaticCopy('sprint-milestone')).toBe(false);
    expect(isAutomaticCopy('only-copy')).toBe(false);
    expect(isAutomaticCopy('close-persist')).toBe(true);
  });

  it('a content-less row carries a pruned: hash, so no hash lookup can match it', () => {
    expect(snapshotStorage('close-persist', 'X', { contentHash: 'abc' }).contentHash).toBe(
      `${PRUNED_HASH_PREFIX}abc`
    );
    expect(snapshotStorage('explicit', 'X', { contentHash: 'abc' }).contentHash).toBe('abc');
  });
});

// ─── The write-time policy ──────────────────────────────────────────────────

async function openSessionWithContext(): Promise<string> {
  const started = await cmosSession({
    action: 'start',
    type: 'custom',
    title: 's92-m09 close copy',
    projectRoot,
  } as never);
  expect(started.success).toBe(true);
  const sessionId = (started.data as { sessionId: string }).sessionId;
  const captured = await cmosSession({
    action: 'capture',
    category: 'context',
    content: `s92-m09 context capture for ${sessionId}`,
    projectRoot,
  } as never);
  expect(captured.success).toBe(true);
  return sessionId;
}

describe('s92-m09 — close copies stop storing content', () => {
  it("a session close's persist copies are content-less and stamped, while the contexts hold the content", async () => {
    const sessionId = await openSessionWithContext();
    const completed = await cmosSession({
      action: 'complete',
      summary: 's92-m09 session close',
      projectRoot,
    } as never);
    expect(completed.success).toBe(true);

    const copies = snapshotsWhere('source = ?', `session_complete:${sessionId}`);
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.content).toBe('');
      expect(copy.content_pruned_at).not.toBeNull();
    }
    const master = withDb(
      (db) =>
        db.prepare(`SELECT content FROM contexts WHERE id = 'master_context'`).get() as {
          content: string;
        },
      true
    );
    expect(master.content).toContain(`s92-m09 context capture for ${sessionId}`);
  });

  it('POSITIVE CONTROL: when the context write fails, the copy is the only durable one and keeps its content', async () => {
    const sessionId = await openSessionWithContext();
    withDb((db) =>
      db.exec(`CREATE TRIGGER s92m09_fail_context_update BEFORE UPDATE ON contexts
               BEGIN SELECT RAISE(ABORT, 'forced: contexts UPDATE rejected'); END;`)
    );
    const completed = await cmosSession({
      action: 'complete',
      summary: 's92-m09 failed persist',
      projectRoot,
    } as never);
    expect(completed.success).toBe(true);

    const onlyCopies = snapshotsWhere(
      'source = ?',
      `session_complete:${sessionId}${ONLY_COPY_SOURCE_SUFFIX}`
    );
    expect(onlyCopies).toHaveLength(2);
    for (const copy of onlyCopies) {
      expect(copy.content.length).toBeGreaterThan(0);
      expect(copy.content_pruned_at).toBeNull();
    }
    expect(onlyCopies.some((copy) => copy.content.includes(sessionId))).toBe(true);

    // The only copy is never an automatic copy: a prune keeping nothing by count still keeps it.
    withDb((db) => db.exec('DROP TRIGGER s92m09_fail_context_update'));
    const pruned = await cmosDb({
      action: 'prune_snapshots',
      confirm: true,
      keepLast: 0,
      projectRoot,
    } as never);
    expect(pruned.success).toBe(true);
    for (const copy of snapshotsWhere('id IN (?, ?)', onlyCopies[0].id, onlyCopies[1].id)) {
      expect(copy.content.length).toBeGreaterThan(0);
    }
  });

  it('a session close leaves an unreadable context exactly as it found it', async () => {
    await openSessionWithContext();
    withDb((db) =>
      db.prepare(`UPDATE contexts SET content = '{not json' WHERE id = 'project_context'`).run()
    );
    const completed = await cmosSession({
      action: 'complete',
      summary: 's92-m09 unreadable context',
      projectRoot,
    } as never);
    expect(completed.success).toBe(true);
    const failures = (completed.data as { writeFailures?: Array<{ code: string; op: string }> })
      .writeFailures;
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CONTEXT_UNREADABLE',
          op: 'contexts.read(project_context)',
        }),
      ])
    );
    const project = withDb(
      (db) =>
        db.prepare(`SELECT content FROM contexts WHERE id = 'project_context'`).get() as {
          content: string;
        },
      true
    );
    expect(project.content).toBe('{not json');
  });

  it("a mission close's persist copy is content-less", async () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date) VALUES ('sprint-d', 'D', 'Active', ?)`
      ).run(iso(2));
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status) VALUES ('d-m1', 'sprint-d', 'Diet', 'In Progress')`
      ).run();
      // An identity field the close syncs into master_context, so the close has content to persist.
      db.prepare(
        `INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_description', 'diet probe')`
      ).run();
    });
    const done = await cmosMissionTransition({
      action: 'complete',
      missionId: 'd-m1',
      notes: 'done',
      projectRoot,
    });
    expect(done.success).toBe(true);
    const snapshotId = (done.data as { contextSnapshotId?: number | null }).contextSnapshotId;
    const copies = snapshotsWhere('source = ?', 'mission_complete:d-m1');
    // When the close changed master_context it wrote one copy, content-less; when nothing changed
    // it wrote none. Either way no close copy stores content.
    expect(copies.every((copy) => copy.content === '' && copy.content_pruned_at !== null)).toBe(
      true
    );
    if (snapshotId) expect(copies.map((c) => c.id)).toContain(snapshotId);
  });

  it('a sprint close milestone and an explicit snapshot keep their content', async () => {
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO sprints (id, title, status, start_date) VALUES ('sprint-m', 'M', 'Active', ?)`
        )
        .run(iso(5))
    );
    const closed = await cmosDb({ action: 'snapshot', projectRoot }); // a database backup, unrelated
    expect(closed.success).toBe(true);
    const sprint = await (
      await import('../../../src/tools/cmos/cmos-sprint')
    ).cmosSprint({ action: 'complete', sprintId: 'sprint-m', summary: 'm', projectRoot } as never);
    expect(sprint.success).toBe(true);
    const milestones = snapshotsWhere("source LIKE 'sprint_complete:%'");
    expect(milestones.length).toBeGreaterThan(0);
    for (const m of milestones) {
      expect(m.content.length).toBeGreaterThan(0);
      expect(m.content_pruned_at).toBeNull();
    }

    const explicit = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'Sprint M completed — a named save point',
      projectRoot,
    });
    expect(explicit.success).toBe(true);
    const [named] = snapshotsWhere('source = ?', 'Sprint M completed — a named save point');
    expect(named.content.length).toBeGreaterThan(0);
  });

  it('a retention archive keeps its content, carries its prefix, and is the id the summary names', async () => {
    withDb((db) => {
      const sprint = db.prepare(
        `INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, 'Completed', ?, ?)`
      );
      sprint.run('old-1', 'Old', iso(40), iso(30));
      sprint.run('new-1', 'New', iso(20), iso(10));
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, status) VALUES ('S-old', 'custom', 'old', 'old-1', ?, 'completed')`
      ).run(iso(35));
    });
    const opened = await CmosDatabaseClient.create({ dbPath });
    const client = opened.data!;
    try {
      const content: Record<string, unknown> = {
        recent_sessions: [{ id: 'S-old', summary: 'detail that the trim removes' }],
      };
      const result = condenseContextForRetention(client, 'master_context', content, {
        source: 'session_complete:PS-retention',
        policy: { keepDetailSprints: 1 },
      });
      expect(result.archiveSnapshotId).not.toBeNull();
      const [archive] = snapshotsWhere('id = ?', result.archiveSnapshotId);
      expect(archive.source).toBe(
        `${RETENTION_ARCHIVE_SOURCE_PREFIX}session_complete:PS-retention`
      );
      expect(archive.content).toContain('detail that the trim removes');
      expect(archive.content_pruned_at).toBeNull();
      const summaries = content['archived_sprint_summaries'] as Array<{ snapshot_id: number }>;
      expect(summaries.map((s) => s.snapshot_id)).toContain(result.archiveSnapshotId);
    } finally {
      client.close();
    }
  });

  it('DEDUP INVARIANT: a content-less copy is never a dedup hit; identical content stores fresh', async () => {
    const sessionId = await openSessionWithContext();
    await cmosSession({ action: 'complete', summary: 'dedup probe', projectRoot } as never);
    const [copy] = snapshotsWhere(
      "source = ? AND context_id = 'master_context'",
      `session_complete:${sessionId}`
    );
    expect(copy.content).toBe('');

    // The same master_context content, snapshotted explicitly, must store its own content.
    const explicit = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'dedup invariant',
      projectRoot,
    });
    expect(explicit.success).toBe(true);
    const data = explicit.data as { snapshotId: number; isNew: boolean };
    expect(data.isNew).toBe(true);
    expect(data.snapshotId).not.toBe(copy.id);
    const [fresh] = snapshotsWhere('id = ?', data.snapshotId);
    expect(fresh.content.length).toBeGreaterThan(0);
    const hashes = withDb(
      (db) =>
        db
          .prepare(`SELECT id, content_hash FROM context_snapshots WHERE id IN (?, ?)`)
          .all(copy.id, data.snapshotId) as Array<{ id: number; content_hash: string }>,
      true
    );
    // The same content: the copy's hash is the fresh row's, marked pruned.
    const byId = new Map(hashes.map((h) => [h.id, h.content_hash]));
    expect(byId.get(copy.id)).toBe(`${PRUNED_HASH_PREFIX}${byId.get(data.snapshotId)}`);
  });
});

// ─── The prune: a Stage1-shaped store ────────────────────────────────────────

const ARCHIVE_REFERENCED = Array.from({ length: 15 }, (_, i) => 100 + i * 7);
const DECISION_REFERENCED = Array.from({ length: 8 }, (_, i) => 300 + i * 11);
const BODY = (id: number): string => `{"snapshot":${id},"pad":"${'x'.repeat(400)}"}`;

/**
 * About 400 snapshots across both contexts, old enough to be outside every age rule, with Stage1's
 * reference shape: 15 ids in master_context.archived_sprint_summaries, 8 ids referenced by 50
 * decisions. Sources mix close copies, legacy runtime copies, milestones, named snapshots and
 * pre-mutation copies, some recent.
 */
function seedStage1Shape(): void {
  withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at,
         project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, 'p', ?, ?, ?, 'snapshot_taken', 1)`
    );
    for (let id = 1; id <= 400; id += 1) {
      const contextId = id % 3 === 0 ? 'project_context' : 'master_context';
      let source = id % 2 === 0 ? `session_complete:PS-${id}` : `mission_complete:m-${id}`;
      let daysAgo = 400 - id / 2; // 400 .. 200 days ago, all outside every age window
      if (id % 50 === 0) source = `sprint_complete:sprint-${id}`;
      if (id % 37 === 0) source = 'session_runtime';
      if (id % 41 === 0) source = `Sprint ${id} completed — named save point`;
      if (id === 13) source = 'context_condense:aggressive'; // an old recovery copy
      if (id === 398) {
        source = `${RETENTION_ARCHIVE_SOURCE_PREFIX}session_complete:PS-398`;
        daysAgo = 3; // a recent recovery copy
      }
      insert.run(
        id,
        contextId,
        source,
        `h${id}`,
        BODY(id),
        iso(daysAgo),
        `EVT${String(id).padStart(23, '0')}`,
        Date.now() - Math.round(daysAgo * DAY),
        id
      );
    }
    db.prepare(`UPDATE contexts SET content = ? WHERE id = 'master_context'`).run(
      JSON.stringify({
        archived_sprint_summaries: ARCHIVE_REFERENCED.map((id, i) => ({
          sprint_id: `sprint-${i}`,
          snapshot_id: id,
        })),
      })
    );
    const decision = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status, snapshot_id) VALUES (?, ?, 'active', ?)`
    );
    for (let i = 0; i < 50; i += 1) {
      decision.run(`decision ${i}`, iso(100), DECISION_REFERENCED[i % 8]);
    }
  });
}

async function prune(
  extra: Record<string, unknown> = {}
): Promise<{ data: CmosDbPruneSnapshotsResult; text: string; warnings: string[] }> {
  const result = await cmosDb({ action: 'prune_snapshots', projectRoot, ...extra } as never);
  expect(result.success).toBe(true);
  return {
    data: result.data as CmosDbPruneSnapshotsResult,
    text: formatDbForLLM('prune_snapshots', result),
    warnings: result.warnings ?? [],
  };
}

function fingerprint(): string {
  return withDb(
    (db) =>
      JSON.stringify(
        db
          .prepare(
            `SELECT id, context_id, source, content, content_hash, created_at, stable_event_id,
                    origin_seq, event_type FROM context_snapshots ORDER BY id`
          )
          .all()
      ),
    true
  );
}

describe('s92-m09 — cmos_db(action="prune_snapshots") on a Stage1-shaped store', () => {
  it('a dry run reports bytes per context, keeps all 23 referenced snapshots, and changes nothing', async () => {
    seedStage1Shape();
    const before = fingerprint();
    const { data, text } = await prune();
    expect(fingerprint()).toBe(before);
    expect(data.applied).toBe(false);
    expect(data.dbSnapshotId).toBeNull();
    expect(data.tombstoned).toBe(0);
    expect(data.references).toEqual({ decisions: 8, contexts: 15 });
    expect(data.prunable).toBeGreaterThan(200);
    for (const ctx of data.perContext) {
      expect(ctx.bytes).toBeGreaterThan(0);
      expect(ctx.prunableBytes).toBeGreaterThan(0);
    }
    expect(text).toContain('dry run');
    expect(text).toMatch(/master_context: \d+ rows, [\d.]+ KB/);
    expect(text).toContain('confirm=true');
  });

  it('applying empties only automatic copies outside every keep rule, and keeps every row and event', async () => {
    seedStage1Shape();
    const dry = (await prune()).data;
    const eventColumns = (): string =>
      withDb(
        (db) =>
          JSON.stringify(
            db
              .prepare(
                `SELECT id, stable_event_id, origin_seq, event_type, source, created_at
                   FROM context_snapshots ORDER BY id`
              )
              .all()
          ),
        true
      );
    const hashesBefore = new Map(
      withDb(
        (db) =>
          db.prepare('SELECT id, content_hash FROM context_snapshots').all() as Array<{
            id: number;
            content_hash: string;
          }>,
        true
      ).map((r) => [r.id, r.content_hash])
    );
    const contentBytes = (): number =>
      withDb(
        (db) =>
          (
            db
              .prepare(
                'SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS n FROM context_snapshots'
              )
              .get() as { n: number }
          ).n,
        true
      );
    const eventsBefore = eventColumns();
    const bytesBefore = contentBytes();

    const { data, text } = await prune({ confirm: true });
    expect(data.applied).toBe(true);
    expect(data.tombstoned).toBe(dry.prunable);
    // The answer reports what is left and what was emptied, counted from the store.
    expect(data.contentBytes).toBe(contentBytes());
    expect(data.bytesReclaimed).toBe(bytesBefore - contentBytes());
    expect(data.bytesReclaimed).toBe(dry.bytesReclaimable);
    expect(text).toContain(`${data.tombstoned} snapshot(s) emptied`);
    expect(data.dbSnapshotId).toMatch(/^snapshot-/);
    expect(
      fs.existsSync(
        path.join(projectRoot, 'cmos', 'db', 'snapshots', `${data.dbSnapshotId}.sqlite`)
      )
    ).toBe(true);
    expect(text).toContain(`Database snapshot taken first: ${data.dbSnapshotId}`);

    // Every row, id, source and event column survives. An emptied row's hash is its old hash marked
    // pruned:, so no dedup lookup (this server's or an older one's) can land on it; every other
    // hash is untouched.
    expect(eventColumns()).toBe(eventsBefore);
    for (const row of withDb(
      (db) =>
        db.prepare('SELECT id, content, content_hash FROM context_snapshots').all() as Array<{
          id: number;
          content: string;
          content_hash: string;
        }>,
      true
    )) {
      const expected =
        row.content === ''
          ? `${PRUNED_HASH_PREFIX}${hashesBefore.get(row.id)}`
          : hashesBefore.get(row.id);
      expect({ id: row.id, hash: row.content_hash }).toEqual({ id: row.id, hash: expected });
    }

    // All 23 referenced snapshots keep their content; every decision still points at its row.
    for (const id of [...ARCHIVE_REFERENCED, ...DECISION_REFERENCED]) {
      const [row] = snapshotsWhere('id = ?', id);
      expect({ id, content: row.content }).toEqual({ id, content: BODY(id) });
    }
    const pointers = withDb(
      (db) =>
        db
          .prepare('SELECT DISTINCT snapshot_id FROM strategic_decisions ORDER BY snapshot_id')
          .all() as Array<{ snapshot_id: number }>,
      true
    );
    expect(pointers.map((p) => p.snapshot_id)).toEqual(DECISION_REFERENCED);

    // Milestones, named snapshots and the recent recovery copy keep their content.
    for (const row of snapshotsWhere(
      "source LIKE 'sprint_complete:%' OR source LIKE 'Sprint % completed%' OR id = 398"
    )) {
      expect(row.content).toBe(BODY(row.id));
    }
    // The old pre-mutation copy and the legacy runtime copies outside the last-30 window are
    // reclaimable (the newest 30 per context are kept whatever their source).
    expect(snapshotsWhere('id = 13')[0].content).toBe('');
    const oldRuntime = snapshotsWhere("source = 'session_runtime' AND id < 300");
    expect(oldRuntime.length).toBeGreaterThan(0);
    expect(oldRuntime.every((r) => r.content === '')).toBe(true);

    // Idempotent: a second apply finds nothing left.
    const again = (await prune({ confirm: true })).data;
    expect(again.prunable).toBe(0);
    expect(again.tombstoned).toBe(0);
  });

  it("Stage1's own keep rule holds: keepIds, keepSince and keepSources", async () => {
    seedStage1Shape();
    withDb((db) =>
      db.prepare(`UPDATE context_snapshots SET created_at = ? WHERE id IN (210, 212)`).run(iso(10))
    );
    const { data } = await prune({
      confirm: true,
      keepIds: [205],
      keepSince: iso(30),
      keepSources: ['mission_complete:m-2*'],
      keepLast: 1,
    });
    expect(data.rules).toMatchObject({
      keepLast: 1,
      keepIds: [205],
      keepSources: ['mission_complete:m-2*'],
    });
    expect(snapshotsWhere('id = 205')[0].content).toBe(BODY(205));
    for (const id of [210, 212]) expect(snapshotsWhere('id = ?', id)[0].content).toBe(BODY(id));
    for (const row of snapshotsWhere("source LIKE 'mission_complete:m-2%'")) {
      expect(row.content).toBe(BODY(row.id));
    }
    expect(data.preserveReasons.keepIds + data.preserveReasons.keepSince).toBeGreaterThan(0);
    expect(data.preserveReasons.keepSources).toBeGreaterThan(0);
  });

  it('FAIL CLOSED: an unreadable context refuses the apply and changes nothing; the dry run warns', async () => {
    seedStage1Shape();
    withDb((db) =>
      db.prepare(`UPDATE contexts SET content = '{not json' WHERE id = 'project_context'`).run()
    );
    const before = fingerprint();

    const dry = await prune();
    expect(dry.warnings.join('\n')).toContain('contexts.project_context');

    const refused = await cmosDb({ action: 'prune_snapshots', confirm: true, projectRoot });
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain('No snapshot content was changed');
    expect(fingerprint()).toBe(before);
  });

  it('no backup, no prune: a failed database snapshot refuses the apply', async () => {
    seedStage1Shape();
    const before = fingerprint();
    jest.spyOn(dbSnapshotModule, 'cmosDbSnapshot').mockResolvedValue({
      success: false,
      error: { code: 'SNAPSHOT_CREATION_FAILED', message: 'disk full (forced)' },
    } as never);
    const refused = await cmosDb({ action: 'prune_snapshots', confirm: true, projectRoot });
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain('disk full (forced)');
    expect(fingerprint()).toBe(before);
  });

  it('rejects malformed keep rules by name', async () => {
    const bad = await cmosDb({
      action: 'prune_snapshots',
      keepSince: 'not a date',
      projectRoot,
    } as never);
    expect(bad.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'keepSince' });
  });
});

// ─── The critic's B2 and its neighbours ─────────────────────────────────────

/** The ids a default selection would empty right now, read the way the action reads them. */
async function prunableNow(config: Partial<PruneConfig> = {}): Promise<number[]> {
  const opened = await CmosDatabaseClient.create({ dbPath });
  const client = opened.data!;
  try {
    const read = readPruneInputs(client);
    if (!read.ok) throw new Error(read.message);
    return selectSnapshotsToPrune(read.inputs.rows, read.inputs.references, {
      keepPerContext: 30,
      days: 0,
      nowMs: Date.now(),
      sprintCloses: read.inputs.sprintCloses,
      ...config,
    }).prunableIds;
  } finally {
    client.close();
  }
}

async function updateMasterNotes(notes: string[]): Promise<number> {
  const updated = await cmosContextUpdate({
    mode: 'manual',
    contextType: 'master_context',
    arrayUpdates: { context_notes: notes },
    projectRoot,
  } as never);
  expect(updated.success).toBe(true);
  const id = (updated.data as { snapshotId: number | null }).snapshotId;
  expect(id).not.toBeNull();
  return id as number;
}

/** The store's own project id: rows written after the server has migrated the store need one. */
function storeProjectId(): string {
  return withDb(
    (db) =>
      (
        db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as {
          value: string;
        }
      ).value,
    true
  );
}

/** Content-bearing automatic copies newer than everything else: enough to fill any last-N. */
function seedLaterCopies(count: number): void {
  const projectId = storeProjectId();
  withDb((db) => {
    // The genesis columns too: a store the server has migrated requires them.
    const insert = db.prepare(
      `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at,
         project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
       VALUES ('master_context', ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot_taken', 1)`
    );
    for (let i = 1; i <= count; i += 1) {
      const at = Date.now() + i * 60_000;
      insert.run(
        `session_complete:PS-later-${i}`,
        `later-${i}`,
        BODY(9000 + i),
        new Date(at).toISOString(),
        projectId,
        `LATER${String(i).padStart(21, '0')}`,
        at,
        90_000 + i
      );
    }
  });
}

function hashOf(id: number): string {
  return withDb(
    (db) =>
      (
        db.prepare('SELECT content_hash FROM context_snapshots WHERE id = ?').get(id) as {
          content_hash: string;
        }
      ).content_hash,
    true
  );
}

describe('s92-m09 — a snapshot never stands on a row less protected than itself (critic B2)', () => {
  it('a named snapshot of content an update copy already holds gets its own row, and a prune keeps it', async () => {
    const updateCopy = await updateMasterNotes(['s92-m09 named-snapshot probe']);
    const named = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'Sprint 9 completed — a named save point',
      projectRoot,
    });
    expect(named.success).toBe(true);
    const data = named.data as { snapshotId: number; isNew: boolean };
    // Before the fix this returned isNew:false and the update copy's id, under the copy's source.
    expect(data.isNew).toBe(true);
    expect(data.snapshotId).not.toBe(updateCopy);
    expect(hashOf(data.snapshotId)).toBe(hashOf(updateCopy));
    expect(snapshotsWhere('id = ?', data.snapshotId)[0].source).toBe(
      'Sprint 9 completed — a named save point'
    );

    seedLaterCopies(31);
    await prune({ confirm: true });
    expect(snapshotsWhere('id = ?', data.snapshotId)[0].content.length).toBeGreaterThan(0);
    expect(snapshotsWhere('id = ?', updateCopy)[0].content).toBe('');
  });

  it('a condense backup of content an update copy already holds gets its own row, kept as a recovery copy', async () => {
    const notes = Array.from({ length: 30 }, (_, i) => `s92-m09 condense note ${i}`);
    const updateCopy = await updateMasterNotes(notes);
    const condensed = await cmosContextCondense({
      contextType: 'master_context',
      strategy: 'aggressive',
      projectRoot,
    } as never);
    expect(condensed.success).toBe(true);
    const backupId = (condensed.data as { snapshotId: number | null }).snapshotId as number;
    expect(backupId).not.toBeNull();
    expect(backupId).not.toBe(updateCopy);
    expect(hashOf(backupId)).toBe(hashOf(updateCopy));
    const [backup] = snapshotsWhere('id = ?', backupId);
    expect(backup.source).toBe('context_condense:aggressive');
    expect(backup.content).toContain('s92-m09 condense note 29');

    // A later write, then a prune keeping nothing by count: the backup survives as a recovery copy
    // younger than 30 days; the update copy beside it does not.
    await updateMasterNotes(['s92-m09 after the condense']);
    const { data } = await prune({ confirm: true, keepLast: 0 });
    expect(data.preserveReasons.recentRecoveryCopy).toBeGreaterThanOrEqual(1);
    expect(snapshotsWhere('id = ?', backupId)[0].content).toContain('s92-m09 condense note 29');
    expect(snapshotsWhere('id = ?', updateCopy)[0].content).toBe('');
  });

  it('a recovery copy never stands on an older recovery copy, whose 30 days started earlier', async () => {
    const notes = Array.from({ length: 30 }, (_, i) => `s92-m09 window note ${i}`);
    await updateMasterNotes(notes);
    // An identical backup from 25 days ago: a prune keeps it only 5 more days.
    const live = withDb(
      (db) =>
        (
          db.prepare(`SELECT content FROM contexts WHERE id = 'master_context'`).get() as {
            content: string;
          }
        ).content,
      true
    );
    const hash = crypto.createHash('sha256').update(live).digest('hex').substring(0, 16);
    const projectId = storeProjectId();
    const oldBackup = withDb((db) => {
      const at = Date.now() - 25 * DAY;
      return Number(
        db
          .prepare(
            `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at,
               project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
             VALUES ('master_context', 'context_condense:auto', ?, ?, ?, ?, 'OLDBACKUP0000000000000001', ?, 80000, 'snapshot_taken', 1)`
          )
          .run(hash, live, new Date(at).toISOString(), projectId, at).lastInsertRowid
      );
    });

    const condensed = await cmosContextCondense({
      contextType: 'master_context',
      strategy: 'aggressive',
      projectRoot,
    } as never);
    expect(condensed.success).toBe(true);
    const backupId = (condensed.data as { snapshotId: number | null }).snapshotId as number;
    // Before the fix this returned the 25-day-old row, so the backup for this condense would have
    // been prunable in five days instead of thirty.
    expect(backupId).not.toBe(oldBackup);
    expect(hashOf(backupId)).toBe(hash);
    expect(snapshotsWhere('id = ?', backupId)[0].content).toBe(live);
  });

  it('a sprint close stores its own milestone even when an update copy holds the same content', async () => {
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO sprints (id, title, status, start_date) VALUES ('sprint-ms', 'MS', 'Active', ?)`
        )
        .run(iso(3))
    );
    const updateCopy = await updateMasterNotes(['s92-m09 milestone probe']);
    const closed = await cmosSprint({
      action: 'complete',
      sprintId: 'sprint-ms',
      summary: 'milestone probe',
      projectRoot,
    } as never);
    expect(closed.success).toBe(true);
    const masterId = (closed.data as { contexts: { masterContext: { snapshotId: number } } })
      .contexts.masterContext.snapshotId;
    expect(masterId).not.toBe(updateCopy);
    expect(hashOf(masterId)).toBe(hashOf(updateCopy));
    const [milestone] = snapshotsWhere('id = ?', masterId);
    expect(milestone.source).toBe('sprint_complete:sprint-ms');
    expect(milestone.content.length).toBeGreaterThan(0);
  });

  it('refuses an explicit snapshot named like one of CMOS’s own automatic copies', async () => {
    for (const source of [
      'Context update: my save point',
      'session_complete:mine',
      'context_condense:mine',
      'session_start:mine',
    ]) {
      const refused = await cmosContextSnapshot({
        contextType: 'master_context',
        source,
        projectRoot,
      });
      expect({ source, success: refused.success }).toEqual({ source, success: false });
      expect(refused.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'source' });
    }
    const accepted = await cmosContextSnapshot({
      contextType: 'master_context',
      source: 'Before the schema rewrite',
      projectRoot,
    });
    expect(accepted.success).toBe(true);
  });
});

describe('s92-m09 — what the prune counts and keeps', () => {
  it('newest and keep-last count only rows that still hold content', async () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at, content_pruned_at)
         VALUES (?, 'master_context', ?, ?, ?, ?, ?)`
      );
      // Ten old copies with content, then forty newer close copies written content-less.
      for (let id = 1; id <= 10; id += 1) {
        insert.run(id, `session_complete:PS-${id}`, `h${id}`, BODY(id), iso(300 - id), null);
      }
      for (let id = 11; id <= 50; id += 1) {
        insert.run(id, `session_complete:PS-${id}`, `pruned:h${id}`, '', iso(100 - id), iso(1));
      }
    });
    const { data } = await prune({ keepLast: 5 });
    // Counting the empty rows, "the last 5" would be five empty rows and all ten would be prunable.
    expect(data.preserveReasons.newestPerContext).toBe(1);
    expect(data.preserveReasons.lastN).toBe(4);
    expect(data.prunable).toBe(5);

    await prune({ keepLast: 5, confirm: true });
    for (let id = 1; id <= 10; id += 1) {
      expect({ id, content: snapshotsWhere('id = ?', id)[0].content }).toEqual({
        id,
        content: id > 5 ? BODY(id) : '',
      });
    }
  });

  it('keeps the state each recorded sprint close landed on, when the close left no milestone row', async () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at)
         VALUES (?, 'master_context', ?, ?, ?, ?)`
      );
      // One automatic copy a day: id k was written 201-k days ago (id 1 at 200, id 100 at 101).
      for (let id = 1; id <= 100; id += 1) {
        insert.run(id, `session_complete:PS-${id}`, `h${id}`, BODY(id), iso(201 - id));
      }
      const event = db.prepare(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'sprint_complete', 'Completed', 'closed', '{}')`
      );
      const sprint = db.prepare(
        `INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, 'Completed', ?, ?)`
      );
      // sprint-a closed 150.5 days ago and stored no milestone: it landed on id 50.
      sprint.run('sprint-a', 'A', iso(160), iso(150.5));
      event.run(iso(150.5), 'sprint-a');
      // sprint-b has no recorded close; its end_date (120.5 days ago) anchors it, on id 80.
      sprint.run('sprint-b', 'B', iso(130), iso(120.5));
      // sprint-c stored its own milestone, so the copy before it (id 30) needs no keeping.
      event.run(iso(170.5), 'sprint-c');
      insert.run(1000, 'sprint_complete:sprint-c', 'hm', BODY(1000), iso(170.4));
      // sprint-d: nothing on disk says when it closed.
      sprint.run('sprint-d', 'D', iso(190), null);
      // sprint-e has no event, but its close stored a milestone in project_context 130.5 days ago:
      // that row, not its planned end_date, says when it closed, so master_context keeps id 70.
      sprint.run('sprint-e', 'E', iso(140), iso(10));
      db.prepare(
        `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at)
         VALUES (2000, 'project_context', 'sprint_complete:sprint-e', 'he', ?, ?)`
      ).run(BODY(2000), iso(130.5));
    });

    const { data, text } = await prune({ keepLast: 0 });
    expect(data.sprintCloses).toEqual({ recorded: 3, approximate: 1, unanchored: 1 });
    expect(data.preserveReasons.sprintCloseState).toBe(3);
    expect(text).toContain('state a sprint closed on 3');
    expect(text).toContain('Sprint closes: 3 recorded, 1 approximate');
    expect(text).toContain('1 completed sprint(s) have no close time on record');

    await prune({ keepLast: 0, confirm: true });
    for (const id of [50, 70, 80, 100, 1000, 2000]) {
      expect({ id, content: snapshotsWhere('id = ?', id)[0].content }).toEqual({
        id,
        content: BODY(id),
      });
    }
    for (const id of [30, 49, 51, 69, 71, 79, 81]) {
      expect({ id, content: snapshotsWhere('id = ?', id)[0].content }).toEqual({ id, content: '' });
    }
  });

  it('honours a reference stored as a string of digits', async () => {
    seedStage1Shape();
    expect(await prunableNow()).toContain(151);
    withDb((db) => {
      const row = db.prepare(`SELECT content FROM contexts WHERE id = 'master_context'`).get() as {
        content: string;
      };
      const content = JSON.parse(row.content) as {
        archived_sprint_summaries: Array<Record<string, unknown>>;
      };
      content.archived_sprint_summaries.push({ sprint_id: 'sprint-str', snapshot_id: '151' });
      db.prepare(`UPDATE contexts SET content = ? WHERE id = 'master_context'`).run(
        JSON.stringify(content)
      );
    });
    const { data } = await prune({ confirm: true });
    expect(data.references.contexts).toBe(16);
    expect(snapshotsWhere('id = 151')[0].content).toBe(BODY(151));
  });

  it('re-reads under the write lock: a reference added after the dry run holds, and a row the backup lacks is left alone', async () => {
    seedStage1Shape();
    expect(await prunableNow()).toContain(201);
    const dry = (await prune()).data;
    const realSnapshot = dbSnapshotModule.cmosDbSnapshot;
    jest.spyOn(dbSnapshotModule, 'cmosDbSnapshot').mockImplementation(async (params) => {
      const taken = await realSnapshot(params);
      // Another writer, between the backup and the prune's write lock.
      withDb((db) => {
        db.prepare(
          `INSERT INTO strategic_decisions (decision_text, created_at, status, snapshot_id)
           VALUES ('a late reference', ?, 'active', 201)`
        ).run(iso(0));
        db.prepare(
          `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at)
           VALUES (5000, 'master_context', 'session_complete:PS-late', 'h-late', ?, ?)`
        ).run(BODY(5000), iso(300));
      });
      return taken;
    });

    const { data, text } = await prune({ confirm: true });
    expect(snapshotsWhere('id = 201')[0].content).toBe(BODY(201));
    expect(snapshotsWhere('id = 5000')[0].content).toBe(BODY(5000));
    expect(data.tombstoned).toBe(dry.prunable - 1);
    // The locked selection chose row 5000 too; the answer's per-context lines count only what
    // was emptied.
    expect(data.prunable).toBe(dry.prunable);
    expect(data.perContext.reduce((sum, c) => sum + c.prunable, 0)).toBe(data.tombstoned);
    expect(data.perContext.reduce((sum, c) => sum + c.prunableBytes, 0)).toBe(data.bytesReclaimed);
    expect(text).toContain(`${data.tombstoned} snapshot(s) emptied`);
  });

  it('FAIL CLOSED: a column check that fails reads as unreadable, never as an absent column', () => {
    const failing = {
      getMany: () => ({
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: 'disk I/O error (forced)' },
      }),
    } as unknown as CmosDatabaseClient;
    expect(readSnapshotReferences(failing).unreadable).toEqual([
      'strategic_decisions columns (disk I/O error (forced))',
      'contexts columns (disk I/O error (forced))',
    ]);
    expect(readSprintCloses(failing).unreadable).toEqual([
      'session_events columns (disk I/O error (forced))',
      'sprints columns (disk I/O error (forced))',
    ]);
    expect(readSnapshotRows(failing).ok).toBe(false);
  });

  it('the sprint-close growth advisory counts content, names the prune, and clears once it has run', async () => {
    seedStage1Shape();
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO context_snapshots (id, context_id, source, content_hash, content, created_at)
         VALUES (?, 'master_context', ?, ?, ?, ?)`
      );
      for (let id = 401; id <= 550; id += 1) {
        insert.run(id, `session_complete:PS-${id}`, `h${id}`, BODY(id), iso(500 - id / 4));
      }
      const sprint = db.prepare(
        `INSERT INTO sprints (id, title, status, start_date) VALUES (?, ?, 'Active', ?)`
      );
      sprint.run('sprint-g1', 'G1', iso(10));
      sprint.run('sprint-g2', 'G2', iso(5));
    });
    const grown = (warnings: readonly string[] | undefined): string | undefined =>
      (warnings ?? []).find((w) => w.includes('context_snapshots has grown to'));

    const first = await cmosSprint({
      action: 'complete',
      sprintId: 'sprint-g1',
      summary: 'g1',
      projectRoot,
    } as never);
    expect(first.success).toBe(true);
    expect(grown(first.warnings)).toContain('cmos_db(action="prune_snapshots")');

    await prune({ confirm: true });
    const second = await cmosSprint({
      action: 'complete',
      sprintId: 'sprint-g2',
      summary: 'g2',
      projectRoot,
    } as never);
    expect(second.success).toBe(true);
    // Every row is still there; the advisory counts the ones that hold content.
    expect(grown(second.warnings)).toBeUndefined();
  });
});
