// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Spin-out must retain the source until a verified target copy is durably protected.
// ABOUTME: Real SQLite fixtures exercise identities, audit rollback, collisions and resumable copies.
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { spinOut } from '../../../src/tools/cmos/spin-out';

let dir: string;
let source: string;
let target: string;
let previousConfig: string | undefined;
const dbPath = (root: string) => path.join(root, 'cmos/db/cmos.sqlite');
function query(root: string, sql: string): unknown[] {
  const db = new Database(dbPath(root));
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
function write(root: string, sql: string): void {
  const db = new Database(dbPath(root));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'spin-out-'));
  previousConfig = process.env.CMOS_CONFIG_DIR;
  process.env.CMOS_CONFIG_DIR = path.join(dir, 'config');
  ProjectGraphRegistry.resetInstance();
  source = path.join(dir, 'source');
  target = path.join(dir, 'target');
  seedCmosDb(source, { projectId: 'source' });
  seedCmosDb(target, { projectId: 'target' });
  await ProjectGraphRegistry.create();
  ProjectGraphRegistry.getInstance().register({
    project_id: 'source',
    store_path: source,
    name: 'Source',
  });
  const db = new Database(dbPath(source));
  const created = new Date(Date.now() - 60000).toISOString();
  db.prepare("INSERT INTO missions(id,name,status,created_at) VALUES('m1','One','Queued',?)").run(
    created
  );
  db.prepare(
    "INSERT INTO strategic_decisions(id,context_id,decision_text,mission_id,created_at) VALUES(1,'master_context','Earlier choice','m1',?)"
  ).run(created);
  db.prepare(
    "INSERT INTO learnings(id,content,mission_id,created_at) VALUES(2,'Decision #1 helped','m1',?)"
  ).run(new Date(Date.now() - 30000).toISOString());
  db.prepare(
    "INSERT INTO next_steps(id,content,mission_id,created_at) VALUES(3,'Follow up','m1',?)"
  ).run(created);
  db.close();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  if (previousConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = previousConfig;
  rmSync(dir, { recursive: true, force: true });
});
const run = (apply = true) => spinOut({ from: source, to: target, missionIds: ['m1'], apply });

it('previews explicit roots without migrating, registering or changing either SQLite byte image', async () => {
  const before = [source, target].map((root) => readFileSync(dbPath(root)));
  const result = await run(false);
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ success: true });
  expect(result.data).toMatchObject({
    applied: false,
    counts: { mission: 1, decision: 1, learning: 1, 'next-step': 1 },
  });
  expect([source, target].map((root) => readFileSync(dbPath(root)))).toEqual(before);
});
it('copies the union once, remaps collisions, stamps fresh identity, and preserves source pointers', async () => {
  write(
    target,
    "INSERT INTO missions(id,name,status) VALUES('m1','Existing','Queued'); INSERT INTO strategic_decisions(id,context_id,decision_text,created_at) VALUES(1,'master_context','Unrelated',datetime('now'))"
  );
  const result = await run();
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ success: true });
  expect(query(target, "SELECT id,sprint_id,project_id FROM missions WHERE id='m1-1'")).toEqual([
    { id: 'm1-1', sprint_id: null, project_id: 'target' },
  ]);
  expect(
    query(target, 'SELECT id,mission_id,project_id FROM strategic_decisions WHERE id=2')
  ).toEqual([{ id: 2, mission_id: 'm1-1', project_id: 'target' }]);
  expect(query(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([
    { status: 'Dropped' },
  ]);
  expect(query(source, "SELECT action FROM session_events WHERE mission='m1'")).toEqual([
    { action: 'drop' },
  ]);
  expect(query(source, "SELECT key FROM metadata WHERE key LIKE 'spin_out_row:%'")).toHaveLength(4);
  const before = [source, target].map((root) => query(root, 'SELECT * FROM metadata ORDER BY key'));
  expect((await run()).data).toMatchObject({ unchanged: true });
  expect(
    [source, target].map((root) => query(root, 'SELECT * FROM metadata ORDER BY key'))
  ).toEqual(before);
});
it.each(['Current', 'In Progress', 'InProgress', 'unknown'])(
  'refuses %s before any copy',
  async (status) => {
    const db = new Database(dbPath(source));
    db.prepare('UPDATE missions SET status=?').run(status);
    db.close();
    expect((await run()).success).toBe(false);
    expect(query(target, 'SELECT id FROM missions')).toEqual([]);
  }
);
it('refuses aliases, equal canonical identities and missing graph identity without copying', async () => {
  expect(
    (await spinOut({ from: source, to: source, missionIds: ['m1'], apply: true })).success
  ).toBe(false);
  write(target, "UPDATE metadata SET value='source' WHERE key='project_id'");
  expect((await run()).success).toBe(false);
  write(target, "UPDATE metadata SET value='target' WHERE key='project_id'");
  ProjectGraphRegistry.getInstance().unregister('source');
  expect((await run()).success).toBe(false);
  expect(query(target, 'SELECT id FROM missions')).toEqual([]);
});
it('keeps every source record intact when the mandatory drop audit fails, then finishes without recopying', async () => {
  write(
    source,
    "CREATE TRIGGER deny_drop BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'denied'); END"
  );
  expect((await run()).success).toBe(false);
  expect(query(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([
    { status: 'Queued' },
  ]);
  expect(query(source, "SELECT key FROM metadata WHERE key LIKE 'spin_out_row:%'")).toEqual([]);
  expect(query(target, 'SELECT id FROM missions')).toHaveLength(1);
  write(source, 'DROP TRIGGER deny_drop');
  const completed = await run();
  expect(completed.error).toBeUndefined();
  expect(completed.success).toBe(true);
  expect(query(target, 'SELECT id FROM missions')).toHaveLength(1);
});
it('reports a missing target identity gate during preview and initializes only on apply', async () => {
  target = path.join(dir, 'new');
  mkdirSync(target);
  const preview = await run(false);
  expect(preview.success).toBe(true);
  expect(preview.data?.identityGate).toBe('target initialization required');
  const completed = await run();
  expect(completed.error).toBeUndefined();
  expect(completed.success).toBe(true);
  expect(query(target, 'SELECT id FROM missions')).toEqual([{ id: 'm1' }]);
});

it('routes CLI explicit roots before ambient context and keeps default preview read-only', async () => {
  const { runCli } = await import('../../../src/cli');
  const output: string[] = [];
  const errors: string[] = [];
  const before = [source, target].map((root) => readFileSync(dbPath(root)));
  const code = await runCli(['spin-out', '--from', source, '--to', target, '--missions', 'm1'], {
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/definitely/unrelated' },
    readStdin: async () => '',
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
  });
  expect({ code, errors }).toEqual({ code: 0, errors: [] });
  expect(JSON.parse(output.join(''))).toMatchObject({
    success: true,
    data: { applied: false, sourceRoot: source, targetRoot: target },
  });
  expect([source, target].map((root) => readFileSync(dbPath(root)))).toEqual(before);
});

it.each([
  ['source content', 'source', "UPDATE strategic_decisions SET decision_text='changed' WHERE id=1"],
  [
    'source selection',
    'source',
    "INSERT INTO next_steps(content,mission_id,created_at,project_id,stable_event_id,occurred_at,origin_seq,event_type,schema_version) VALUES('newly linked','m1',datetime('now'),'source','new-id',1,99999,'next_step_created',1)",
  ],
  ['target content', 'target', "UPDATE strategic_decisions SET decision_text='changed'"],
  ['target deletion', 'target', 'DELETE FROM strategic_decisions'],
  [
    'target ledger',
    'target',
    "UPDATE metadata SET value=json_set(value,'$.phase','changed') WHERE key GLOB 'spin_out_operation:*'",
  ],
  [
    'target missing proof and rows',
    'target',
    "DELETE FROM metadata WHERE key GLOB 'spin_out_operation:*'; DELETE FROM record_links; DELETE FROM strategic_decisions; DELETE FROM learnings; DELETE FROM next_steps; DELETE FROM missions",
  ],
  ['target rekey', 'target', "UPDATE metadata SET value='changed' WHERE key='project_id'"],
] as const)(
  'refuses pending retry after %s changes without recopying or marking',
  async (_name, side, mutation) => {
    write(
      source,
      "CREATE TRIGGER deny_drop BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'denied'); END"
    );
    const first = await run();
    expect(first.success).toBe(false);
    expect(query(target, 'SELECT id FROM missions')).toHaveLength(1);
    write(source, 'DROP TRIGGER deny_drop');
    write(side === 'source' ? source : target, mutation);
    const before = [source, target].map((root) => [
      query(root, 'SELECT * FROM missions ORDER BY id'),
      query(root, 'SELECT * FROM strategic_decisions ORDER BY id'),
      query(root, 'SELECT * FROM metadata ORDER BY key'),
    ]);
    expect((await run()).success).toBe(false);
    expect(
      [source, target].map((root) => [
        query(root, 'SELECT * FROM missions ORDER BY id'),
        query(root, 'SELECT * FROM strategic_decisions ORDER BY id'),
        query(root, 'SELECT * FROM metadata ORDER BY key'),
      ])
    ).toEqual(before);
  }
);
it.each([
  [
    'rewrite copied status',
    "CREATE TRIGGER corrupt_copy AFTER INSERT ON strategic_decisions BEGIN UPDATE strategic_decisions SET status='archived' WHERE id=NEW.id; END",
  ],
  [
    'ignore copied links',
    'CREATE TRIGGER ignore_link BEFORE INSERT ON record_links BEGIN SELECT RAISE(IGNORE); END',
  ],
] as const)(
  'refuses target triggers that %s instead of certifying corrupted copies',
  async (_name, trigger) => {
    write(target, trigger);
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/payload|citation.*postcondition/i);
    expect(query(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([
      { status: 'Queued' },
    ]);
    expect(query(target, 'SELECT id FROM missions')).toEqual([]);
  }
);
it('refuses overlapping selectors even when the target or explicit record set differs', async () => {
  const first = await run();
  expect(first.error).toBeUndefined();
  const other = path.join(dir, 'other');
  seedCmosDb(other, { projectId: 'other' });
  expect(
    (await spinOut({ from: source, to: other, missionIds: ['m1'], decisionIds: [1], apply: true }))
      .success
  ).toBe(false);
  expect(query(other, 'SELECT id FROM missions')).toEqual([]);
});

it('does not finalize when a trigger silently restores a source record status', async () => {
  write(
    source,
    "CREATE TRIGGER undo_archive AFTER UPDATE OF status ON learnings BEGIN UPDATE learnings SET status='active' WHERE id=NEW.id; END"
  );
  const result = await run();
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/source.*postcondition/i);
  expect(query(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([
    { status: 'Queued' },
  ]);
  write(source, 'DROP TRIGGER undo_archive');
  expect((await run()).success).toBe(true);
  expect(query(target, 'SELECT id FROM missions')).toHaveLength(1);
});

it('does not borrow a foreign mission_id collision for implicit selection but permits explicit provenance-preserving selection', async () => {
  const db = new Database(dbPath(source));
  db.prepare(
    "INSERT INTO strategic_decisions(id,context_id,decision_text,mission_id,created_at,project_id) VALUES(2,'master_context','Foreign decision','m1',?,'foreign')"
  ).run(new Date(Date.now() - 10000).toISOString());
  db.close();
  const preview = await run(false);
  expect(preview.data?.counts.decision).toBe(1);
  const explicit = await spinOut({
    from: source,
    to: target,
    missionIds: ['m1'],
    decisionIds: [2],
    apply: false,
  });
  expect(explicit.data?.counts.decision).toBe(2);
  expect(
    explicit.data?.plan?.provenance.find((row) => row.kind === 'decision' && row.sourceId === 2)
      ?.originalProjectId
  ).toBe('foreign');
  expect((await run()).success).toBe(true);
  expect(query(source, 'SELECT status FROM strategic_decisions WHERE id=2')).toEqual([
    { status: 'active' },
  ]);
});
