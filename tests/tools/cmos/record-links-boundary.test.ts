// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves citation migration concurrency and positive fire using only temporary stores.
// ABOUTME: Real private evidence is copied read-only and honestly gated out of the public mirror.
import { fork } from 'child_process';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { ensureRecordLinks, readRecordLinks } from '../../../src/tools/cmos/record-links';
import { CMOS_SCHEMA } from '../../../src/tools/cmos/schema';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
const temporary: string[] = [];
function location(): { root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-links-boundary-'));
  temporary.push(root);
  const dbPath = path.join(root, 'cmos/db/cmos.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { root, dbPath };
}
async function open(dbPath: string): Promise<CmosDatabaseClient> {
  const result = await CmosDatabaseClient.create({ dbPath });
  if (!result.success || !result.data) throw new Error('copy open failed');
  return result.data;
}
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it.each(['runtime', 'seed'])(
  'the %s schema includes exactly the owned link definition',
  async (kind) => {
    const { dbPath } = location();
    const db = new Database(dbPath);
    try {
      db.exec(
        kind === 'runtime'
          ? CMOS_SCHEMA
          : fs.readFileSync(path.resolve('cmos-seed/db/schema.sql'), 'utf8')
      );
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='record_links'").get()).toEqual({
        name: 'record_links',
      });
    } finally {
      db.close();
    }
    const client = await open(dbPath);
    try {
      expect(ensureRecordLinks(client)).toMatchObject({ ready: true, warnings: [] });
    } finally {
      client.close();
    }
  }
);
it('two independent processes serialize the same migration and only one commits the upgrade', async () => {
  const { root, dbPath } = location();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT,created_at TEXT); CREATE TABLE learnings(id INTEGER PRIMARY KEY,content TEXT,created_at TEXT); INSERT INTO strategic_decisions VALUES(1,'old row',NULL)"
  );
  db.close();
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(
    worker,
    `
    const fs=require('fs'); const ts=require(process.argv[2]);
    require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,file);
    const {CmosDatabaseClient}=require(process.argv[3]+'/src/tools/cmos/client.ts');
    const {ensureRecordLinks}=require(process.argv[3]+'/src/tools/cmos/record-links.ts');
    (async()=>{
      const opened=await CmosDatabaseClient.create({dbPath:process.argv[4],timeout:5000});
      if(!opened.success) throw Error(JSON.stringify(opened.error));
      process.send({ready:true});
      process.once('message',()=>{
        const result=ensureRecordLinks(opened.data); opened.data.close();
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
  reason: 'The citation corpus is private; positive fire mutates only its temporary SQLite backup.',
  paths: { source: 'cmos/db/cmos.sqlite' },
});
PRIVATE.describe('private real-store citation positive fire', () => {
  it('backfills the actual local corpus without changing its record bytes', async () => {
    const { dbPath } = location();
    const source = new Database(PRIVATE.paths.source, { readonly: true, fileMustExist: true });
    try {
      await source.backup(dbPath);
    } finally {
      source.close();
    }
    const client = await open(dbPath);
    try {
      expect(client.raw('DROP TABLE IF EXISTS record_links').success).toBe(true);
      expect(client.execute("DELETE FROM metadata WHERE key='record_links_schema'").success).toBe(
        true
      );
      const before = client.getMany('SELECT * FROM strategic_decisions ORDER BY id').data;
      expect(ensureRecordLinks(client)).toMatchObject({ ready: true, warnings: [] });
      const graph = readRecordLinks(client);
      expect(graph.mode).toBe('persisted');
      expect(graph.warnings).toEqual([]);
      expect(graph.links.length).toBeGreaterThan(0);
      expect(
        graph.links.every((edge) => edge.from_kind === 'decision' || edge.from_kind === 'learning')
      ).toBe(true);
      expect(client.getMany('SELECT * FROM strategic_decisions ORDER BY id').data).toEqual(before);
      expect(client.getOne('PRAGMA integrity_check').data).toEqual({ integrity_check: 'ok' });
    } finally {
      client.close();
    }
  });
});

it('uses the explicit project root with environment unset and does not require registration', async () => {
  const { root, dbPath } = location();
  const db = new Database(dbPath);
  db.exec(CMOS_SCHEMA);
  db.close();
  const previous = process.env.CMOS_PROJECT_ROOT;
  delete process.env.CMOS_PROJECT_ROOT;
  let client: CmosDatabaseClient | undefined;
  try {
    const opened = await CmosDatabaseClient.create({ projectRoot: root, registerProject: false });
    expect(opened.success).toBe(true);
    client = opened.data;
    expect(client?.path).toBe(dbPath);
    expect(ensureRecordLinks(client!).ready).toBe(true);
  } finally {
    client?.close();
    if (previous === undefined) delete process.env.CMOS_PROJECT_ROOT;
    else process.env.CMOS_PROJECT_ROOT = previous;
  }
});
