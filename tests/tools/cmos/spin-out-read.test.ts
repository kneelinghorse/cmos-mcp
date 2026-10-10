// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Committed per-row ledgers hide only source rows and preserve historical addresses.
// ABOUTME: Read faults and malformed ledgers are loud; absent legacy metadata never triggers writes.
import Database from 'better-sqlite3';
import { prepareSpinOutRead, spinOutSqliteReader } from '../../../src/tools/cmos/spin-out-read';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
});
afterEach(() => db.close());
const pointer = {
  operationId: 'fork',
  sourceProjectId: 'source',
  sourceRoot: '/source',
  sourceId: 1,
  targetProjectId: 'target',
  targetRoot: '/target',
  targetId: 7,
};
function metadata() {
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
}
function put(key: string, value: unknown) {
  db.prepare('INSERT INTO metadata VALUES (?,?)').run(key, JSON.stringify(value));
}

it('sees absent metadata then a newly finalized source key on the same reader without writes', () => {
  const reader = spinOutSqliteReader(db);
  expect(prepareSpinOutRead(reader).predicate('decision', 'd.id')).toEqual({
    sql: '1=1',
    params: [],
  });
  expect(db.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
  metadata();
  put('spin_out_operation:pending', { state: 'reserved' });
  expect(prepareSpinOutRead(reader).hidden('decision', 1)).toBe(false);
  put('spin_out_row:decision:1', pointer);
  const before = db.prepare('SELECT total_changes() AS n').get();
  const read = prepareSpinOutRead(reader);
  expect(read.hidden('decision', 1)).toBe(true);
  expect(read.pointer('decision', 1)).toEqual(pointer);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});

it('excludes source IDs inside SQL before its limit while origins remain visible', () => {
  metadata();
  db.exec('CREATE TABLE rows(id INTEGER); INSERT INTO rows VALUES(1),(7),(8)');
  put('spin_out_row:decision:1', pointer);
  put('spin_out_origin:decision:7', { ...pointer, originalProjectId: 'foreign' });
  const read = prepareSpinOutRead(spinOutSqliteReader(db));
  const p = read.predicate('decision', 'r.id');
  expect(
    db.prepare(`SELECT id FROM rows r WHERE ${p.sql} ORDER BY id LIMIT 1`).all(...p.params)
  ).toEqual([{ id: 7 }]);
  expect(read.hidden('decision', 7)).toBe(false);
  expect(read.origin('decision', 7)).toMatchObject(pointer);
});

it('keeps colon-bearing mission IDs intact and rejects caller SQL expressions', () => {
  metadata();
  put('spin_out_row:mission:effort:one', {
    ...pointer,
    sourceId: 'effort:one',
    targetId: 'effort:one-1',
  });
  const read = prepareSpinOutRead(spinOutSqliteReader(db));
  expect(read.hidden('mission', 'effort:one')).toBe(true);
  expect(() => read.predicate('mission', 'id) OR 1=1 --')).toThrow('SPIN_OUT_READ_FAILED');
});

it.each([
  ['spin_out_row:decision:1', '{bad'],
  ['spin_out_row:decision:2', JSON.stringify(pointer)],
  ['spin_out_row:decision:1', JSON.stringify({ ...pointer, targetRoot: '' })],
  ['spin_out_row:decision:1', JSON.stringify({ ...pointer, targetId: '7' })],
  ['spin_out_row:unknown:1', JSON.stringify(pointer)],
  ['spin_out_origin:decision:1', JSON.stringify(pointer)],
])('refuses malformed or mismatched pointer %s', (key, text) => {
  metadata();
  db.prepare('INSERT INTO metadata VALUES (?,?)').run(key, text);
  expect(() => prepareSpinOutRead(spinOutSqliteReader(db))).toThrow('SPIN_OUT_READ_FAILED');
});

it('does not treat a failed ledger query as absent metadata', () => {
  metadata();
  const reader = spinOutSqliteReader(db);
  reader.getMany = () => ({
    success: false,
    error: { code: 'DB_QUERY_FAILED', message: 'locked' },
  });
  expect(() => prepareSpinOutRead(reader)).toThrow(/SPIN_OUT_READ_FAILED.*locked/);
});

it('rejects unqualified outer identifiers that a metadata column could capture', () => {
  metadata();
  const read = prepareSpinOutRead(spinOutSqliteReader(db));
  expect(() => read.predicate('mission', 'id')).toThrow('SPIN_OUT_READ_FAILED');
});
