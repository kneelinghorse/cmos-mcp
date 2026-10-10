// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Committed transfer visibility is observable across processes without writing during reads.
// ABOUTME: A disposable real-store copy proves the positive predicate and byte-preserving keyword lookup.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fork } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { keywordRelevant } from '../../../src/cli/commands';
import { prepareSpinOutRead, spinOutSqliteReader } from '../../../src/tools/cmos/spin-out-read';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';

const pointer = {
  operationId: 'fork',
  sourceProjectId: 'source',
  sourceRoot: '/source',
  sourceId: 1,
  targetProjectId: 'target',
  targetRoot: '/target',
  targetId: 1,
};
const hashes = (file: string) =>
  [file, `${file}-wal`].map((name) =>
    fs.existsSync(name) ? createHash('sha256').update(fs.readFileSync(name)).digest('hex') : null
  );

it('sees only committed source pointers while another process owns the write transaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-out-read-lock-')),
    file = path.join(dir, 'fixture.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
  const reader = spinOutSqliteReader(db),
    worker = path.join(dir, 'worker.cjs');
  fs.writeFileSync(
    worker,
    `const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new Database(process.argv[2]);db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO metadata VALUES(?,?)').run('spin_out_row:decision:1',process.argv[3]);process.send('pending');process.once('message',()=>{db.exec('COMMIT');db.close();process.exit(0)});`
  );
  const child = fork(worker, [file, JSON.stringify(pointer)], { silent: true });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', () => resolve());
    });
    expect(prepareSpinOutRead(reader).hidden('decision', 1)).toBe(false);
    child.send('commit');
    await exited;
    expect(prepareSpinOutRead(reader).hidden('decision', 1)).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PRIVATE = requiresPrivateEvidence({
  reason: 'Spin-out read positive fire uses a consistent disposable backup of the private store.',
  paths: { source: 'cmos/db/cmos.sqlite' },
});
PRIVATE.describe('real-store spin-out read positive fire', () => {
  it('hides only marked rows and leaves the copied main and WAL bytes unchanged during reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-out-read-real-')),
      file = path.join(dir, 'copy.sqlite');
    const source = new Database(PRIVATE.paths.source, { readonly: true, fileMustExist: true });
    try {
      await source.backup(file);
    } finally {
      source.close();
    }
    let held: Database.Database | undefined;
    try {
      const setup = new Database(file);
      const row = setup.prepare(
        "INSERT INTO strategic_decisions(decision_text,created_at,status,project_id,stable_event_id,occurred_at,origin_seq,event_type,schema_version) VALUES(?,?,'archived',?,?,?,(SELECT COALESCE(MAX(origin_seq),0)+1 FROM strategic_decisions),'decision_captured',1)"
      );
      const identity = (
        setup.prepare("SELECT value FROM metadata WHERE key='project_id'").get() as {
          value: string;
        }
      ).value;
      const ids = ['spinoutpositive cobaltcompass', 'spinoutpositive cobaltcompass eligible'].map(
        (text) =>
          Number(
            row.run(text, new Date().toISOString(), identity, randomUUID(), Date.now())
              .lastInsertRowid
          )
      );
      setup
        .prepare('INSERT INTO metadata(key,value) VALUES(?,?)')
        .run(`spin_out_row:decision:${ids[0]}`, JSON.stringify({ ...pointer, sourceId: ids[0] }));
      setup.close();
      // SQLite may create empty WAL/SHM sidecars during readonly setup. Establish and hold that
      // connection before both byte hashes; arbitrary later WAL content changes still fail.
      held = new Database(file, { readonly: true, fileMustExist: true });
      held.prepare('SELECT COUNT(*) FROM metadata').get();
      const before = hashes(file);
      expect(
        keywordRelevant(file, 'spinoutpositive cobaltcompass', 1).map((row) => row.id)
      ).toEqual([ids[1]]);
      expect(
        prepareSpinOutRead(spinOutSqliteReader(held)).pointer('decision', ids[0])?.targetRoot
      ).toBe('/target');
      expect(hashes(file)).toEqual(before);
    } finally {
      held?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
