// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves decision migration concurrency and positive fire on a private store backup.
// ABOUTME: Child processes and every mutation use temporary roots; the source store opens read-only.

import { fork } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  ensureDecisionShapeColumns,
  ensureDecisionsFts5,
  ensureFirehoseEventColumns,
} from '../../../src/tools/cmos/schema-migrations';
import { CMOS_SCHEMA } from '../../../src/tools/cmos/schema';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';

const fields = [
  'context_text',
  'alternatives',
  'consequences',
  'deciders',
  'approval_mode',
  'approval_draft',
  'approval_words',
];
const temporary: string[] = [];
function location(): { root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-shape-boundary-'));
  temporary.push(root);
  const dbPath = path.join(root, 'cmos/db/cmos.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { root, dbPath };
}
async function open(dbPath: string): Promise<CmosDatabaseClient> {
  const opened = await CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('copy open failed');
  return opened.data;
}
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(['runtime', 'seed'])(
  'the %s schema starts with compatible nullable rich fields and an accepted index',
  async (kind) => {
    const { dbPath } = location();
    const db = new Database(dbPath);
    try {
      db.exec(
        kind === 'runtime'
          ? CMOS_SCHEMA
          : fs.readFileSync(path.resolve('cmos-seed/db/schema.sql'), 'utf8')
      );
      const columns = db.pragma('table_info(strategic_decisions)') as {
        name: string;
        notnull: number;
      }[];
      for (const field of fields) expect(columns.find((c) => c.name === field)?.notnull).toBe(0);
    } finally {
      db.close();
    }
    const client = await open(dbPath);
    try {
      expect(ensureDecisionsFts5(client).warnings).toEqual([]);
      expect(ensureDecisionShapeColumns(client)).toMatchObject({
        ready: true,
        columnsAdded: [],
        warnings: [],
      });
    } finally {
      client.close();
    }
  }
);

it('the existing firehose table rebuild preserves rich values and their FTS triggers', async () => {
  const { dbPath } = location();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('project_id','shape-rebuild-fixture');
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY, decision_text TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO strategic_decisions VALUES(1,?,?)').run(
    'Headline survives the older migration',
    new Date(Date.now() - 60_000).toISOString()
  );
  db.close();
  const client = await open(dbPath);
  try {
    expect(ensureDecisionShapeColumns(client)).toMatchObject({ ready: true, warnings: [] });
    const values = [
      'contextquartz',
      '["alternative"]',
      'consequence',
      '["operator"]',
      'autonomous',
      'draft',
      'approved',
    ];
    expect(
      client.execute(
        `UPDATE strategic_decisions SET ${fields.map((f) => `${f}=?`).join(',')} WHERE id=1`,
        values
      ).success
    ).toBe(true);
    const before = client.getOne(
      `SELECT id,decision_text,${fields.join(',')} FROM strategic_decisions`
    ).data;
    expect(ensureFirehoseEventColumns(client)).toMatchObject({
      alreadyCurrent: false,
      warnings: [],
    });
    expect(
      client.getOne(`SELECT id,decision_text,${fields.join(',')} FROM strategic_decisions`).data
    ).toEqual(before);
    const columns = client.getMany<{ name: string; notnull: number }>(
      'PRAGMA table_info(strategic_decisions)'
    ).data!;
    expect(columns.find((c) => c.name === 'event_type')?.notnull).toBe(1);
    expect(ensureDecisionShapeColumns(client)).toMatchObject({ ready: true, alreadyCurrent: true });
    expect(
      client.getMany("SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'contextquartz'")
        .data
    ).toEqual([{ rowid: 1 }]);
    expect(
      client.execute("UPDATE strategic_decisions SET context_text='afterrebuildquartz' WHERE id=1")
        .success
    ).toBe(true);
    expect(
      client.getMany(
        "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'afterrebuildquartz'"
      ).data
    ).toEqual([{ rowid: 1 }]);
    expect(
      client.getMany("SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'contextquartz'")
        .data
    ).toEqual([]);
    expect(
      client.raw("INSERT INTO decisions_fts(decisions_fts,rank) VALUES('integrity-check',1)")
        .success
    ).toBe(true);
  } finally {
    client.close();
  }
});

it('two independent processes serialize the same migration and only one commits the upgrade', async () => {
  const { root, dbPath } = location();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT); INSERT INTO strategic_decisions VALUES(1,'old row')"
  );
  db.close();
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(
    worker,
    `
    const fs=require('fs'); const ts=require(process.argv[2]);
    require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
    const {CmosDatabaseClient}=require(process.argv[3]+'/src/tools/cmos/client.ts');
    const {ensureDecisionShapeColumns}=require(process.argv[3]+'/src/tools/cmos/schema-migrations.ts');
    (async()=>{
      const opened=await CmosDatabaseClient.create({dbPath:process.argv[4],timeout:5000});
      if(!opened.success) throw Error(JSON.stringify(opened.error));
      process.send({ready:true});
      process.once('message',()=>{
        const result=ensureDecisionShapeColumns(opened.data); opened.data.close();
        process.send({result},()=>process.exit(result.ready?0:1));
      });
    })().catch(error=>{console.error(error);process.exit(1)});
  `
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CMOS_CONFIG_DIR: path.join(root, 'config'),
    CMOS_CHECKPOINT_SYNC: 'off',
  };
  delete childEnv.CMOS_PROJECT_ROOT;
  const children = [0, 1].map(() =>
    fork(worker, [require.resolve('typescript'), path.resolve('.'), dbPath], {
      silent: true,
      env: childEnv,
    })
  );
  const results: { ready: boolean; alreadyCurrent: boolean; warnings: string[] }[] = [];
  const ready = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`migration worker exited before ready: ${code}`))
        );
        child.on('message', (message) => {
          const value = message as { ready?: boolean; result?: (typeof results)[number] };
          if (value.ready) resolve();
          if (value.result) results.push(value.result);
        });
      })
  );
  const exits = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`migration worker ${code}: ${stderr}`))
        );
      })
  );
  const completed = Promise.all(exits);
  try {
    await Promise.race([Promise.all(ready), completed]);
    for (const child of children) child.send('go');
    await completed;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ready && r.warnings.length === 0)).toBe(true);
    expect(results.filter((r) => !r.alreadyCurrent)).toHaveLength(1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The real decision corpus is private; migration positive fire runs only on its temporary SQLite backup.',
  paths: { source: 'cmos/db/cmos.sqlite' },
});
PRIVATE.describe('private real-store decision shape positive fire', () => {
  it('upgrades a legacy copy, preserves its actual rows, and searches a new context-only token', async () => {
    const { dbPath } = location();
    const source = new Database(PRIVATE.paths.source, { readonly: true, fileMustExist: true });
    try {
      await source.backup(dbPath);
    } finally {
      source.close();
    }
    const client = await open(dbPath);
    try {
      // Future runs may copy an upgraded store. Reconstruct only the legacy shape IN THIS COPY.
      for (const name of ['decisions_fts_insert', 'decisions_fts_delete', 'decisions_fts_update'])
        expect(client.raw(`DROP TRIGGER IF EXISTS ${name}`).success).toBe(true);
      expect(client.raw('DROP TABLE IF EXISTS decisions_fts').success).toBe(true);
      const columns = client.getMany<{ name: string }>(
        'PRAGMA table_info(strategic_decisions)'
      ).data!;
      for (const field of fields)
        if (columns.some((c) => c.name === field))
          expect(client.raw(`ALTER TABLE strategic_decisions DROP COLUMN ${field}`).success).toBe(
            true
          );
      expect(
        client.execute("DELETE FROM metadata WHERE key='decision_shape_columns'").success
      ).toBe(true);
      expect(ensureDecisionsFts5(client).warnings).toEqual([]);
      const before = client.getMany<{ id: number; decision_text: string }>(
        'SELECT id,decision_text FROM strategic_decisions ORDER BY id'
      ).data!;
      expect(before.length).toBeGreaterThan(0);
      expect(ensureDecisionShapeColumns(client)).toMatchObject({ ready: true, warnings: [] });
      expect(
        client.getMany('SELECT id,decision_text FROM strategic_decisions ORDER BY id').data
      ).toEqual(before);
      const token = 'migrationshaperichquartz';
      expect(
        client.execute('UPDATE strategic_decisions SET context_text=? WHERE id=?', [
          token,
          before[0].id,
        ]).success
      ).toBe(true);
      expect(
        client.getMany('SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?', [token]).data
      ).toEqual([{ rowid: before[0].id }]);
      expect(
        client.getOne("SELECT value FROM metadata WHERE key='decision_shape_columns'").data
      ).toEqual({ value: '1' });
    } finally {
      client.close();
    }
  });
});
