// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Actual CLI children must converge after SIGKILL and fence competing SQLite writers.
// ABOUTME: Child-only SQLite barriers identify durable phases without production crash-test switches.
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import * as ts from 'typescript';
import { spawn, type ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';

const repo = path.resolve(__dirname, '../../..');
let dir: string;
let cli: string;
let preload: string;
let source: string;
let target: string;
let config: string;
let caseDir: string;
const children: ChildProcess[] = [];
const file = (root: string) => path.join(root, 'cmos/db/cmos.sqlite');
function rows(root: string, sql: string): unknown[] {
  const db = new Database(file(root));
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-out-process-'));
  const output = path.join(dir, 'package');
  fs.mkdirSync(output);
  const compile = (relative: string): void => {
    const source = path.join(repo, 'src', relative);
    if (fs.statSync(source).isDirectory())
      for (const name of fs.readdirSync(source)) compile(path.join(relative, name));
    else if (source.endsWith('.ts') && !source.endsWith('.d.ts')) {
      const dest = path.join(output, 'dist', relative.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(
        dest,
        ts.transpileModule(fs.readFileSync(source, 'utf8'), {
          fileName: source,
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
          },
        }).outputText
      );
    }
  };
  compile('');
  for (const name of ['node_modules', 'cmos-seed', 'plugins'])
    fs.symlinkSync(path.join(repo, name), path.join(output, name), 'dir');
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(output, 'package.json'));
  cli = path.join(output, 'dist/cli.js');
  preload = path.join(output, 'barrier.cjs');
  fs.writeFileSync(
    preload,
    `
const Database=require('better-sqlite3'), fs=require('fs'), path=require('path');
const source=process.env.SPIN_TEST_SOURCE,target=process.env.SPIN_TEST_TARGET,phase=process.env.SPIN_TEST_PHASE;
let held=false;
function barrier(db,where){
 if(held||!phase||where!==phase)return;
 held=true;fs.writeFileSync(process.env.SPIN_TEST_READY,JSON.stringify({pid:process.pid,where,store:db.name}));
 const deadline=Date.now()+20000;
 while(!fs.existsSync(process.env.SPIN_TEST_RELEASE)){if(Date.now()>deadline)throw Error('child barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
}
function ledgerPhase(db,wanted){try{return db.prepare("SELECT value FROM metadata WHERE key GLOB 'spin_out_operation:*'").all().some(r=>JSON.parse(r.value).phase===wanted);}catch{return false;}}
const exec=Database.prototype.exec;
Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='COMMIT'){
 if(path.resolve(this.name)===target&&ledgerPhase(this,'copied'))barrier(this,'target-committed');
 if(path.resolve(this.name)===source&&ledgerPhase(this,'marked'))barrier(this,'source-committed');
}return result;};
const prepare=Database.prototype.prepare;
Database.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(path.resolve(this.name)===source&&/UPDATE missions\\s+SET status/.test(sql)){
 const run=stmt.run;const db=this;stmt.run=function(...args){barrier(db,'target-verified');return run.apply(this,args);};
}return stmt;};
`
  );
}, 60000);
beforeEach(async () => {
  caseDir = fs.mkdtempSync(path.join(dir, 'case-'));
  source = path.join(caseDir, 'source');
  target = path.join(caseDir, 'target');
  config = path.join(caseDir, 'config');
  seedCmosDb(source, { projectId: 'source' });
  seedCmosDb(target, { projectId: 'target' });
  const db = new Database(file(source));
  db.prepare("INSERT INTO missions(id,name,status,created_at) VALUES('m1','Task','Queued',?)").run(
    new Date(Date.now() - 60000).toISOString()
  );
  db.close();
  ProjectGraphRegistry.resetInstance();
  const registry = await ProjectGraphRegistry.create({ configDir: config });
  registry.register({ project_id: 'source', store_path: source, name: 'Source' });
  ProjectGraphRegistry.resetInstance();
});
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
function start(
  phase?: string,
  to = target,
  extra: string[] = []
): {
  child: ChildProcess;
  done: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  ready: string;
  release: string;
} {
  const ready = path.join(caseDir, `ready-${children.length}`),
    release = path.join(caseDir, `release-${children.length}`);
  const child = spawn(
    process.execPath,
    [
      '--require',
      preload,
      '-e',
      `require(${JSON.stringify(cli)}).main(process.argv.slice(1))`,
      'spin-out',
      '--from',
      source,
      '--to',
      to,
      '--missions',
      'm1',
      '--apply',
      ...extra,
    ],
    {
      cwd: caseDir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CMOS_CONFIG_DIR: config,
        CMOS_CHECKPOINT_SYNC: 'off',
        SPIN_TEST_SOURCE: file(source),
        SPIN_TEST_TARGET: file(to),
        SPIN_TEST_PHASE: phase,
        SPIN_TEST_READY: ready,
        SPIN_TEST_RELEASE: release,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  let stdout = '',
    stderr = '';
  child.stdout!.on('data', (data) => (stdout += data));
  child.stderr!.on('data', (data) => (stderr += data));
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, ready, release };
}
async function ready(run: ReturnType<typeof start>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(run.ready)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null)
      throw new Error(JSON.stringify(await run.done));
    if (Date.now() > deadline) throw new Error('Barrier readiness timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(JSON.parse(fs.readFileSync(run.ready, 'utf8')).pid).toBe(run.child.pid);
}
function mutation(root: string, sql: string, timeout = 1000): void {
  const db = new Database(file(root), { timeout });
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
it.each(['target-committed', 'source-committed'])(
  'converges after killing the real CLI at %s',
  async (phase) => {
    const first = start(phase);
    await ready(first);
    expect(rows(target, "SELECT id FROM missions WHERE id='m1'")).toEqual([{ id: 'm1' }]);
    expect(rows(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([
      { status: phase === 'source-committed' ? 'Dropped' : 'Queued' },
    ]);
    first.child.kill('SIGKILL');
    expect((await first.done).signal).toBe('SIGKILL');
    const retry = await start().done;
    expect(retry.stderr).toBe('');
    expect(JSON.parse(retry.stdout).success).toBe(true);
    expect(retry.code).toBe(0);
    expect(rows(target, 'SELECT id FROM missions')).toHaveLength(1);
    expect(rows(source, "SELECT action FROM session_events WHERE action='drop'")).toHaveLength(1);
  },
  30000
);
it('detects a competing target writer in the commit/reacquire gap', async () => {
  const first = start('target-committed');
  await ready(first);
  mutation(target, "UPDATE missions SET name='Changed copy' WHERE id='m1'");
  fs.writeFileSync(first.release, 'continue');
  const result = await first.done;
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.message).toMatch(/changed/);
  expect(rows(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([{ status: 'Queued' }]);
}, 30000);
it('holds both write reservations after target verification through source commit', async () => {
  const first = start('target-verified');
  await ready(first);
  expect(() => mutation(target, "UPDATE missions SET name='competing'", 70)).toThrow(/locked/);
  expect(() => mutation(source, "UPDATE missions SET name='competing'", 70)).toThrow(/locked/);
  fs.writeFileSync(first.release, 'continue');
  const result = await first.done;
  expect(result.code).toBe(0);
  expect(rows(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([
    { status: 'Dropped' },
  ]);
}, 30000);
it('refuses a second process lock without source marks', async () => {
  const lock = spawn(
    process.execPath,
    [
      '-e',
      `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const d=new D(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.send('locked');process.on('message',()=>{d.exec('ROLLBACK');d.close();process.exit(0);});`,
      file(target),
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.push(lock);
  await new Promise<void>((resolve, reject) => {
    lock.once('message', () => resolve());
    lock.once('error', reject);
  });
  const result = await start().done;
  expect(result.code).toBe(1);
  expect(rows(source, "SELECT status FROM missions WHERE id='m1'")).toEqual([{ status: 'Queued' }]);
  lock.send('release');
  await new Promise<void>((resolve) => lock.once('close', () => resolve()));
}, 30000);
it('concurrent real CLI applies produce one copy per source row', async () => {
  const first = start('target-committed');
  await ready(first);
  const second = start();
  fs.writeFileSync(first.release, 'continue');
  const results = await Promise.all([first.done, second.done]);
  expect(results.some((r) => r.code === 0)).toBe(true);
  const retry = await start().done;
  expect(retry.code).toBe(0);
  expect(rows(target, 'SELECT id FROM missions')).toHaveLength(1);
  expect(rows(source, "SELECT action FROM session_events WHERE action='drop'")).toHaveLength(1);
}, 30000);
