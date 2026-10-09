// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Later recall is readonly keyword retrieval of three unseen local decisions with a relevance floor.
// ABOUTME: Real SQLite fixtures exercise the filtering before caps, skip policy, legacy schemas and deadlines.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recallLaterPrompt, skipLaterPrompt } from '../../src/cli/later-prompt-recall';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
const evidence = requiresPrivateEvidence({
  reason: 'Later recall positive-fire uses the private store schema and real decision population.',
  paths: { store: 'cmos/db/cmos.sqlite' },
});
let tmp: string;
let file: string;
let db: Database.Database;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-later-recall-'));
  file = path.join(tmp, 'cmos.sqlite');
  db = new Database(file);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('project_id','local');
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT,created_at TEXT,status TEXT,project_id TEXT,superseded_by INTEGER);
    CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text,content='strategic_decisions',content_rowid='id');`);
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
function row(
  id: number,
  text: string,
  status: string | null = 'active',
  origin: string | null = 'local',
  successor: number | null = null
) {
  db.prepare('INSERT INTO strategic_decisions VALUES(?,?,?,?,?,?)').run(
    id,
    text,
    new Date().toISOString(),
    status,
    origin,
    successor
  );
}
function index() {
  db.exec("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')");
}
it('filters seen and foreign/superseded decisions before selecting three keyword-only results', () => {
  for (let id = 1; id <= 30; id++)
    row(
      id,
      'Transactional database safety safety safety',
      'active',
      id <= 10 ? 'foreign' : 'local'
    );
  row(40, 'Transactional database safety legacy', null, null);
  row(41, 'Transactional database safety two', 'archived');
  row(42, 'Transactional database safety three');
  row(43, 'Transactional database safety superseded', 'superseded');
  row(44, 'Transactional database safety pointer', 'active', 'local', 42);
  row(45, 'Database alone is a weak one keyword match');
  row(47, 'Database safety is a weak two keyword match');
  row(46, 'Unrelated citation target, see decision #42');
  index();
  const before = fs.readFileSync(file);
  const result = recallLaterPrompt(
    file,
    'Please explain our transactional database safety choices again',
    Array.from({ length: 30 }, (_, i) => `d:${i + 1}`)
  );
  expect(result.available).toBe(true);
  expect(result.items.map((item) => item.id).sort()).toEqual([40, 41, 42]);
  expect(
    result.items.every((item) => item.retrievalSource === 'keyword' && item.via.length === 0)
  ).toBe(true);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readdirSync(tmp)).toEqual(['cmos.sqlite']);
});
it('rejects weak one and two keyword matches below the calibrated floor of three', () => {
  row(1, 'Database');
  row(2, 'Database safety');
  row(3, 'Transactional database safety');
  index();
  expect(
    recallLaterPrompt(file, 'Transactional database safety', []).items.map((item) => item.id)
  ).toEqual([3]);
});
it('distinguishes a deadline or absent index from a valid empty result', () => {
  index();
  expect(recallLaterPrompt(file, 'database safety', []).available).toBe(true);
  expect(
    recallLaterPrompt(file, 'database safety', [], { deadlineAtMs: Date.now() - 1 })
  ).toMatchObject({ available: false, warnings: ['recall_deadline'] });
  db.exec('DROP TABLE decisions_fts');
  expect(recallLaterPrompt(file, 'database safety', []).available).toBe(false);
});
it('skips only later short, slash or acknowledgment prompts, without hashing their text', () => {
  for (const text of [
    'approved',
    'yes please proceed with that agreed plan',
    '/compact keep the important project decisions here',
    '   ',
    'What is this?',
  ])
    expect(skipLaterPrompt(text)).toBe(true);
  for (const query of [
    'Explain why database safety uses explicit transactional receipts',
    'Yes, but explain why database safety uses explicit transactional receipts',
    'Okay, explain why database safety uses explicit transactional receipts',
  ])
    expect(skipLaterPrompt(query)).toBe(false);
});
evidence.describe('real store schema', () => {
  it('positively fires against a readonly copy of the real project schema', () => {
    db.close();
    fs.copyFileSync(evidence.paths.store, file);
    db = new Database(file);
    const source = db
      .prepare(
        "SELECT decision_text FROM strategic_decisions WHERE status <> 'superseded' AND superseded_by IS NULL AND length(decision_text)>100 LIMIT 1"
      )
      .get() as { decision_text: string };
    const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const result = recallLaterPrompt(file, source.decision_text, []);
    expect(result.available).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(3);
    expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(before);
  });
});

it('reports a cross-process lock as unavailable, then positively fires after release without changing the store', async () => {
  row(1, 'Transactional database safety');
  index();
  const before = fs.readFileSync(file);
  const locker = spawn(
    process.execPath,
    [
      '-e',
      `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('held\\n');
    process.stdin.resume();
    process.stdin.on('end', () => { db.exec('ROLLBACK'); db.close(); });
  `,
      file,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const closed = new Promise<void>((resolve, reject) => {
    locker.once('error', reject);
    locker.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`locker exited ${code}`))
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      locker.stdout!.once('data', () => resolve());
      locker.once('error', reject);
      locker.once('exit', (code) => reject(new Error(`locker exited before ready: ${code}`)));
    });
    expect(recallLaterPrompt(file, 'Transactional database safety', [])).toMatchObject({
      available: false,
      warnings: ['recall_query_failed'],
      items: [],
    });
  } finally {
    locker.stdin!.end();
    await closed;
  }
  expect(
    recallLaterPrompt(file, 'Transactional database safety', []).items.map((item) => item.id)
  ).toEqual([1]);
  expect(fs.readFileSync(file)).toEqual(before);
});

it('rechecks an absent index and activates after it is created in the same process', () => {
  row(1, 'Transactional database safety');
  db.exec('DROP TABLE decisions_fts');
  const beforeMissing = fs.readFileSync(file);
  expect(recallLaterPrompt(file, 'Transactional database safety', [])).toMatchObject({
    available: false,
    warnings: ['recall_index_missing'],
  });
  expect(fs.readFileSync(file)).toEqual(beforeMissing);
  db.exec(
    "CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text,content='strategic_decisions',content_rowid='id')"
  );
  index();
  const beforeReady = fs.readFileSync(file);
  expect(
    recallLaterPrompt(file, 'Transactional database safety', []).items.map((item) => item.id)
  ).toEqual([1]);
  expect(fs.readFileSync(file)).toEqual(beforeReady);
});

it('reads a legacy decision schema without optional status, origin, timestamp or successor columns', () => {
  db.exec(`DROP TABLE decisions_fts; DROP TABLE strategic_decisions;
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY, decision_text TEXT);
    INSERT INTO strategic_decisions VALUES(1,'Transactional database safety');
    CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text,content='strategic_decisions',content_rowid='id');`);
  index();
  const before = fs.readFileSync(file);
  expect(recallLaterPrompt(file, 'Transactional database safety', [])).toMatchObject({
    available: true,
    items: [{ id: 1, projectId: null, status: 'active', retrievalSource: 'keyword' }],
  });
  expect(fs.readFileSync(file)).toEqual(before);
  expect(db.pragma('table_info(strategic_decisions)')).toHaveLength(2);
});
