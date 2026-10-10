// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Fault injection must never hide source work without its original verified destination.
// ABOUTME: Identity aliases, altered proof and ignored source writes remain explicit retry conflicts.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, renameSync, unlinkSync, linkSync } from 'fs';
import os from 'os';
import path from 'path';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { spinOut } from '../../../src/tools/cmos/spin-out';
let dir: string, source: string, target: string;
let previousConfig: string | undefined;
const file = (root: string) => path.join(root, 'cmos/db/cmos.sqlite');
function dbUse<T>(root: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file(root));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const mutate = (root: string, sql: string) => dbUse(root, (db) => db.exec(sql));
const rows = (root: string, sql: string) => dbUse(root, (db) => db.prepare(sql).all());
const run = () => spinOut({ from: source, to: target, missionIds: ['m1', 'm2'], apply: true });
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'spin-out-durability-'));
  source = path.join(dir, 'source');
  target = path.join(dir, 'target');
  previousConfig = process.env.CMOS_CONFIG_DIR;
  process.env.CMOS_CONFIG_DIR = path.join(dir, 'config');
  ProjectGraphRegistry.resetInstance();
  seedCmosDb(source, { projectId: 'source', owner: 'operator', slug: 'umbrella' });
  seedCmosDb(target, { projectId: 'target' });
  const registry = await ProjectGraphRegistry.create();
  registry.register({ project_id: 'source', store_path: source, name: 'Source' });
  const created = new Date(Date.now() - 60000).toISOString();
  dbUse(source, (db) => {
    db.prepare(
      "INSERT INTO missions(id,name,status,created_at) VALUES('m1','One','Queued',?),('m2','Two','Queued',?)"
    ).run(created, created);
    db.exec("INSERT INTO mission_dependencies(from_id,to_id,type) VALUES('m1','m2','Requires')");
    db.prepare(
      "INSERT INTO strategic_decisions(id,context_id,decision_text,mission_id,created_at) VALUES(1,'master_context','Earlier','m1',?)"
    ).run(created);
    db.prepare(
      "INSERT INTO learnings(id,content,mission_id,created_at) VALUES(2,'Decision #1 helps','m1',?)"
    ).run(new Date(Date.now() - 30000).toISOString());
    db.prepare(
      "INSERT INTO next_steps(id,content,mission_id,created_at) VALUES(3,'Later','m1',?)"
    ).run(created);
  });
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  if (previousConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = previousConfig;
  rmSync(dir, { recursive: true, force: true });
});
async function pending(): Promise<void> {
  mutate(
    source,
    "CREATE TRIGGER fail_source BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'pending test'); END"
  );
  expect((await run()).success).toBe(false);
  expect(rows(target, 'SELECT id FROM missions')).toHaveLength(2);
  mutate(source, 'DROP TRIGGER fail_source');
}
function originalSource(): void {
  expect(rows(source, 'SELECT status FROM missions ORDER BY id')).toEqual([
    { status: 'Queued' },
    { status: 'Queued' },
  ]);
  expect(rows(source, "SELECT action FROM session_events WHERE action='drop'")).toEqual([]);
  expect(rows(source, "SELECT key FROM metadata WHERE key GLOB 'spin_out_row:*'")).toEqual([]);
}
it.each([
  ['mission metadata', 'BEFORE UPDATE OF metadata ON missions'],
  ['decision archive', 'BEFORE UPDATE OF status ON strategic_decisions'],
  ['learning archive', 'BEFORE UPDATE OF status ON learnings'],
  ['next-step drop', 'BEFORE UPDATE OF status ON next_steps'],
  ['source pointer', "BEFORE INSERT ON metadata WHEN NEW.key GLOB 'spin_out_row:*'"],
  [
    'final operation',
    "BEFORE UPDATE OF value ON metadata WHEN NEW.key GLOB 'spin_out_operation:*' AND json_extract(NEW.value,'$.phase')='marked'",
  ],
] as const)(
  'rolls back every source write when %s is silently ignored, then resumes once',
  async (_name, trigger) => {
    mutate(source, `CREATE TRIGGER fail_source ${trigger} BEGIN SELECT RAISE(IGNORE); END`);
    const result = await run();
    expect(result.success).toBe(false);
    originalSource();
    expect(rows(target, 'SELECT id FROM missions')).toHaveLength(2);
    mutate(source, 'DROP TRIGGER fail_source');
    expect((await run()).success).toBe(true);
    expect(rows(target, 'SELECT id FROM missions')).toHaveLength(2);
  }
);
it.each(['source', 'target'])(
  'refuses replacement of the %s physical database on pending retry',
  async (side) => {
    await pending();
    const root = side === 'source' ? source : target;
    const replacement = path.join(dir, 'replacement.sqlite');
    const db = new Database(file(root), { readonly: true });
    try {
      await db.backup(replacement);
    } finally {
      db.close();
    }
    renameSync(replacement, file(root));
    expect((await run()).success).toBe(false);
    originalSource();
    expect(rows(target, 'SELECT id FROM missions')).toHaveLength(2);
  }
);
it('refuses different roots that alias the same database inode before copying', async () => {
  unlinkSync(file(target));
  linkSync(file(source), file(target));
  const result = await run();
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/different canonical.*physical/);
  originalSource();
});
it.each([
  ['missing canonical identity', "DELETE FROM metadata WHERE key='project_id'"],
  ['failed canonical query', 'ALTER TABLE metadata RENAME COLUMN value TO unavailable'],
] as const)('refuses %s before copying', async (_name, sql) => {
  mutate(target, sql);
  expect((await run()).success).toBe(false);
  expect(rows(target, 'SELECT id FROM missions')).toEqual([]);
  originalSource();
});
it('refuses a source registry entry that resolves to a different physical database', async () => {
  const registry = new Database(ProjectGraphRegistry.getInstance().path);
  try {
    registry.prepare("UPDATE projects SET store_path=? WHERE project_id='source'").run(target);
  } finally {
    registry.close();
  }
  expect((await run()).success).toBe(false);
  expect(rows(target, 'SELECT id FROM missions')).toEqual([]);
  originalSource();
});
it.each([
  ['dependency deletion', 'DELETE FROM mission_dependencies'],
  ['link deletion', 'DELETE FROM record_links'],
  [
    'extra dependency',
    "INSERT INTO mission_dependencies(from_id,to_id,type) VALUES('m2','m1','Blocks')",
  ],
] as const)('refuses committed target %s without recreating it', async (_name, sql) => {
  await pending();
  mutate(target, sql);
  const before = [
    rows(target, 'SELECT * FROM mission_dependencies'),
    rows(target, 'SELECT * FROM record_links'),
  ];
  expect((await run()).success).toBe(false);
  originalSource();
  expect([
    rows(target, 'SELECT * FROM mission_dependencies'),
    rows(target, 'SELECT * FROM record_links'),
  ]).toEqual(before);
});
it('does not count later linked records as part of a completed unchanged operation', async () => {
  const first = await run();
  expect(first.error).toBeUndefined();
  const fresh = new Date().toISOString();
  dbUse(source, (db) =>
    db
      .prepare(
        "INSERT INTO next_steps(content,mission_id,created_at,project_id,stable_event_id,occurred_at,origin_seq,event_type,schema_version) VALUES('new work','m1',?,'source','later-work',?,9999,'next_step_created',1)"
      )
      .run(fresh, Date.now())
  );
  const second = await run();
  expect(second.error).toBeUndefined();
  expect(second.data).toMatchObject({ unchanged: true, counts: first.data!.counts });
  const preview = await spinOut({
    from: source,
    to: target,
    missionIds: ['m1', 'm2'],
    apply: false,
  });
  expect(preview.data?.counts).toEqual(first.data!.counts);
  expect(rows(target, 'SELECT id FROM next_steps')).toHaveLength(1);
});
it('rejects a dependency trigger that deletes the copied edge before its proof is sealed', async () => {
  mutate(
    target,
    'CREATE TRIGGER delete_edge AFTER INSERT ON mission_dependencies BEGIN DELETE FROM mission_dependencies WHERE from_id=NEW.from_id AND to_id=NEW.to_id; END'
  );
  const result = await run();
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/dependency payload/);
  originalSource();
  expect(rows(target, 'SELECT id FROM missions')).toEqual([]);
});
it('uses the declared source owner/project address without inventing a target-local citation', async () => {
  const result = await run();
  expect(result.error).toBeUndefined();
  const evidence = rows(target, 'SELECT evidence FROM strategic_decisions') as {
    evidence: string;
  }[];
  expect(JSON.parse(evidence[0].evidence)).toContainEqual({
    type: 'cmos',
    id: 'cmos://operator/umbrella#decision-1',
  });
});

it('reports only affected sprints left entirely parked and resolves every provenance entry through the source graph', async () => {
  mutate(
    source,
    "INSERT INTO sprints(id,title,status) VALUES('parked','Parked','Active'),('open','Open','Active'); UPDATE missions SET sprint_id='parked'; INSERT INTO missions(id,name,status,sprint_id) VALUES('m3','Selected elsewhere','Queued','open'),('m4','Stays open','Queued','open')"
  );
  const args = { from: source, to: target, missionIds: ['m1', 'm2', 'm3'] };
  const preview = await spinOut(args);
  expect(preview.error).toBeUndefined();
  expect(preview.data).toMatchObject({
    parkedSprints: [
      { sprintId: 'parked', status: 'Active', missionCount: 2, parkedMissionCount: 2 },
    ],
  });
  const applied = await spinOut({ ...args, apply: true });
  expect(applied.error).toBeUndefined();
  expect(applied.data?.parkedSprints).toEqual(preview.data?.parkedSprints);
  const tables = {
    mission: 'missions',
    decision: 'strategic_decisions',
    learning: 'learnings',
    'next-step': 'next_steps',
  } as const;
  for (const origin of applied.data!.plan!.provenance) {
    const entry = ProjectGraphRegistry.getInstance().get(origin.sourceProjectId);
    expect(entry).toBeDefined();
    const db = new Database(file(entry!.store_path), { readonly: true });
    try {
      expect(
        db.prepare(`SELECT id FROM ${tables[origin.kind]} WHERE id=?`).get(origin.sourceId)
      ).toEqual({ id: origin.sourceId });
    } finally {
      db.close();
    }
  }
  expect(rows(source, 'SELECT status FROM sprints ORDER BY id')).toEqual([
    { status: 'Active' },
    { status: 'Active' },
  ]);
});
