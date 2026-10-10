// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercise the public spin-out operation against historical schema and a copied real store.
// ABOUTME: Legacy active sprints are preserved and every mutation is confined to temporary projects.
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { spinOut } from '../../../src/tools/cmos/spin-out';

let root: string, source: string, target: string, previousConfig: string | undefined;
const dbPath = (project: string) => path.join(project, 'cmos/db/cmos.sqlite');
const ago = (offset: number) => new Date(Date.now() - offset).toISOString();
function withDb<T>(project: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath(project));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function image(project: string): Promise<string> {
  const copy = path.join(root, `witness-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new Database(dbPath(project), { readonly: true, fileMustExist: true });
  try {
    await db.backup(copy);
  } finally {
    db.close();
  }
  return createHash('sha256').update(fs.readFileSync(copy)).digest('hex');
}
function legacy(project: string, projectId: string): void {
  seedCmosDb(project, { projectId });
  withDb(project, (db) => {
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE decisions_fts; DROP TABLE strategic_decisions; DROP TABLE learnings;
      DROP TABLE next_steps; DROP TABLE missions; DROP TABLE record_links;
      CREATE TABLE missions(id TEXT PRIMARY KEY,sprint_id TEXT,name TEXT NOT NULL,status TEXT NOT NULL,
        completed_at TEXT,notes TEXT,objective TEXT,context TEXT,success_criteria TEXT,deliverables TEXT,
        reference_docs TEXT,domain_fields TEXT,metadata TEXT,created_at TEXT,started_at TEXT,updated_at TEXT);
      CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,created_at TEXT NOT NULL,sprint_id TEXT,snapshot_id INTEGER,
        project_domain TEXT,session_id TEXT,category TEXT,superseded_by INTEGER,status TEXT DEFAULT 'active',
        evidence TEXT,source_chunk_ids TEXT,content_hash TEXT);
      CREATE TABLE learnings(id INTEGER PRIMARY KEY,content TEXT NOT NULL,category TEXT,status TEXT DEFAULT 'active',
        sprint_id TEXT,session_id TEXT,created_at TEXT NOT NULL,content_hash TEXT);
      CREATE TABLE next_steps(id INTEGER PRIMARY KEY,content TEXT NOT NULL,status TEXT DEFAULT 'pending',
        session_id TEXT,sprint_id TEXT,created_at TEXT NOT NULL,resolved_at TEXT,carried_to_sprint TEXT,content_hash TEXT);`);
    for (const id of ['old-a', 'old-b', 'old-c'])
      db.prepare("INSERT INTO sprints(id,title,status) VALUES(?,?,'Active')").run(id, id);
  });
}
async function registerSource(projectId: string): Promise<void> {
  await ProjectGraphRegistry.create();
  ProjectGraphRegistry.getInstance().register({
    project_id: projectId,
    store_path: source,
    name: 'Temporary source',
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-out-legacy-'));
  source = path.join(root, 'source');
  target = path.join(root, 'target');
  previousConfig = process.env.CMOS_CONFIG_DIR;
  process.env.CMOS_CONFIG_DIR = path.join(root, 'config');
  ProjectGraphRegistry.resetInstance();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  if (previousConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = previousConfig;
  fs.rmSync(root, { recursive: true, force: true });
});
async function oldProjects(): Promise<void> {
  legacy(source, 'old-source');
  legacy(target, 'old-target');
  withDb(source, (db) => {
    db.prepare(
      "INSERT INTO missions(id,sprint_id,name,status,created_at) VALUES('m1','old-a','Selected','Queued',?)"
    ).run(ago(5000));
    db.prepare(
      "INSERT INTO missions(id,sprint_id,name,status,created_at,completed_at) VALUES('m2','old-b','Completed','Completed',?,?)"
    ).run(ago(5000), ago(1000));
    db.exec("INSERT INTO mission_dependencies VALUES('m1','m2','Blocks')");
    db.prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at,session_id) VALUES(1,'Earlier local choice',?,'session-old')"
    ).run(ago(30000));
    db.prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at) VALUES(2,'Decision #1',?)"
    ).run(ago(20000));
    db.prepare(
      "INSERT INTO learnings(id,content,created_at,session_id) VALUES(3,'Decision #1',?,'session-old')"
    ).run(ago(10000));
    db.prepare(
      "INSERT INTO next_steps(id,content,created_at,session_id) VALUES(4,'Learning #3',?,'session-old')"
    ).run(ago(5000));
  });
  withDb(target, (db) => {
    db.exec(
      "INSERT INTO missions(id,name,status) VALUES('m1','Unrelated','Queued'),('m1-1','Unrelated suffix','Queued')"
    );
    db.prepare(
      "INSERT INTO strategic_decisions(id,decision_text,created_at) VALUES(1,'Unrelated decision',?)"
    ).run(ago(60000));
    db.prepare("INSERT INTO learnings(id,content,created_at) VALUES(3,'Unrelated learning',?)").run(
      ago(60000)
    );
    db.prepare("INSERT INTO next_steps(id,content,created_at) VALUES(4,'Unrelated task',?)").run(
      ago(60000)
    );
  });
  await registerSource('old-source');
}
const selection = () => ({
  from: source,
  to: target,
  missionIds: ['m1', 'm2'],
  decisionIds: [1, 2],
  learningIds: [3],
  nextStepIds: [4],
});
it('previews old session aliases and absent mission links without any migration or sprint selection side effect', async () => {
  await oldProjects();
  const before = await Promise.all([image(source), image(target)]);
  const result = await spinOut(selection());
  expect(result.error).toBeUndefined();
  expect(result.data).toMatchObject({
    applied: false,
    counts: { mission: 2, decision: 2, learning: 1, 'next-step': 1 },
  });
  expect(await Promise.all([image(source), image(target)])).toEqual(before);
  for (const project of [source, target]) {
    expect(
      withDb(project, (db) =>
        db.prepare("SELECT COUNT(*) AS n FROM sprints WHERE status='Active'").get()
      )
    ).toEqual({ n: 3 });
    const columns = withDb(project, (db) =>
      db.prepare('PRAGMA table_info(strategic_decisions)').all()
    ) as { name: string }[];
    expect(columns.some((column) => column.name === 'session_id')).toBe(true);
    expect(
      columns.some((column) => column.name === 'mission_id' || column.name === 'stable_event_id')
    ).toBe(false);
  }
});
it('applies to two historical stores, preserves all three active sprints and remaps every collision', async () => {
  await oldProjects();
  const result = await spinOut({ ...selection(), apply: true });
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.data?.backups).toHaveLength(2);
  expect(
    withDb(target, (db) =>
      db
        .prepare(
          "SELECT id,sprint_id,project_id FROM missions WHERE id IN ('m1-2','m2') ORDER BY id"
        )
        .all()
    )
  ).toEqual([
    { id: 'm1-2', sprint_id: null, project_id: 'old-target' },
    { id: 'm2', sprint_id: null, project_id: 'old-target' },
  ]);
  expect(
    withDb(target, (db) => db.prepare('SELECT from_id,to_id FROM mission_dependencies').all())
  ).toEqual([{ from_id: 'm1-2', to_id: 'm2' }]);
  expect(
    withDb(source, (db) => db.prepare('SELECT id,status FROM missions ORDER BY id').all())
  ).toEqual([
    { id: 'm1', status: 'Dropped' },
    { id: 'm2', status: 'Completed' },
  ]);
  for (const project of [source, target]) {
    expect(
      withDb(project, (db) =>
        db.prepare("SELECT COUNT(*) AS n FROM sprints WHERE status='Active'").get()
      )
    ).toEqual({ n: 3 });
    expect(withDb(project, (db) => db.prepare('PRAGMA integrity_check').get())).toEqual({
      integrity_check: 'ok',
    });
  }
  expect(
    withDb(target, (db) =>
      db.prepare('SELECT * FROM record_links ORDER BY from_kind,from_id').all()
    )
  ).toEqual([
    { from_kind: 'decision', from_id: 3, to_kind: 'decision', to_id: 2, resolution: 'typed' },
    { from_kind: 'learning', from_id: 4, to_kind: 'decision', to_id: 2, resolution: 'typed' },
  ]);
  const rows = withDb(target, (db) =>
    db
      .prepare(
        'SELECT author_session_id,stable_event_id FROM strategic_decisions WHERE id IN (2,3)'
      )
      .all()
  ) as { author_session_id: string | null; stable_event_id: string }[];
  expect(
    rows.every((row) => row.author_session_id === null && typeof row.stable_event_id === 'string')
  ).toBe(true);
  expect((await spinOut({ ...selection(), apply: true })).data?.unchanged).toBe(true);
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The actual store is private; full spin-out runs on a consistent temporary SQLite backup only.',
  paths: { source: 'cmos/db/cmos.sqlite' },
});
PRIVATE.describe('private public-entry positive fire', () => {
  it('copies a real completed mission and its linked records, preserving original source text and historical access', async () => {
    fs.mkdirSync(path.dirname(dbPath(source)), { recursive: true });
    const original = new Database(PRIVATE.paths.source, { readonly: true, fileMustExist: true });
    try {
      await original.backup(dbPath(source));
    } finally {
      original.close();
    }
    seedCmosDb(target, { projectId: 'actual-copy-target' });
    const projectId = withDb(source, (db) =>
      db.prepare("SELECT value FROM metadata WHERE key='project_id'").get()
    ) as { value: string };
    await registerSource(projectId.value);
    const mission = withDb(source, (db) =>
      db
        .prepare(
          "SELECT m.id FROM missions m WHERE m.status='Completed' AND EXISTS(SELECT 1 FROM strategic_decisions d WHERE d.mission_id=m.id) ORDER BY m.created_at DESC,m.id DESC LIMIT 1"
        )
        .get()
    ) as { id: string } | undefined;
    expect(mission).toBeDefined();
    if (!mission)
      throw new Error('Real-store completed mission positive fire has no eligible input');
    const beforeText = withDb(source, (db) =>
      db
        .prepare('SELECT id,decision_text FROM strategic_decisions WHERE mission_id=? ORDER BY id')
        .all(mission.id)
    );
    const before = await Promise.all([image(source), image(target)]);
    const args = { from: source, to: target, missionIds: [mission.id] };
    const preview = await spinOut(args);
    expect(preview.error).toBeUndefined();
    expect(preview.data?.counts.decision).toBeGreaterThan(0);
    expect(await Promise.all([image(source), image(target)])).toEqual(before);
    const applied = await spinOut({ ...args, apply: true });
    expect(applied.error).toBeUndefined();
    expect(applied.success).toBe(true);
    expect(
      withDb(source, (db) =>
        db
          .prepare(
            'SELECT id,decision_text FROM strategic_decisions WHERE mission_id=? ORDER BY id'
          )
          .all(mission.id)
      )
    ).toEqual(beforeText);
    expect(
      withDb(source, (db) => db.prepare('SELECT status FROM missions WHERE id=?').get(mission.id))
    ).toEqual({ status: 'Completed' });
    expect(
      withDb(target, (db) => db.prepare('SELECT COUNT(*) AS n FROM strategic_decisions').get())
    ).toEqual({ n: preview.data!.counts.decision });
    expect(
      withDb(source, (db) =>
        db
          .prepare('SELECT value FROM metadata WHERE key=?')
          .get(`spin_out_row:mission:${mission.id}`)
      )
    ).toBeDefined();
    expect(withDb(target, (db) => db.prepare('PRAGMA integrity_check').get())).toEqual({
      integrity_check: 'ok',
    });
  });
});
