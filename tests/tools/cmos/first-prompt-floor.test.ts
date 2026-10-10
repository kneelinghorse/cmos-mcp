// SPDX-License-Identifier: Apache-2.0
// ABOUTME: First-prompt floors filter the existing candidate union before the final cap.
// ABOUTME: Rejected rows refill only within that bounded union; citation seed selection is unchanged.

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recallFirstPrompt } from '../../../src/tools/cmos/first-prompt-recall';

let root: string, dbPath: string, db: Database.Database;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-prompt-floor-'));
  dbPath = path.join(root, 'cmos.sqlite');
  db = new Database(dbPath);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('project_id','local');
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT,created_at TEXT,status TEXT,project_id TEXT,superseded_by INTEGER);
    CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text,content='strategic_decisions',content_rowid='id');`);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const add = (id: number, text: string) =>
  db
    .prepare('INSERT INTO strategic_decisions VALUES(?,?,?,?,?,?)')
    .run(id, text, new Date(Date.now() - 86400000).toISOString(), 'active', 'local', null);
const rebuild = () => db.exec("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')");

it('refills rejected top-five results from the original keyword pool before taking five', () => {
  for (let id = 1; id <= 5; id++) add(id, 'Alchemy.');
  add(6, `Alchemy protocol ${'copper '.repeat(150)}`);
  // Make protocol common so the long two-keyword row really lies below the top five.
  for (let id = 100; id < 200; id++) add(id, 'Protocol.');
  rebuild();
  const before = recallFirstPrompt(dbPath, 'alchemy protocol', {
    minimumKeywordMatches: 0,
  }).items.map((row) => row.id);
  expect(before).not.toContain(6);
  expect(
    recallFirstPrompt(dbPath, 'alchemy protocol', { minimumKeywordMatches: 2 }).items.map(
      (row) => row.id
    )
  ).toEqual([6]);
});

it('does not fetch beyond the original twenty-five keyword candidates after rejecting them', () => {
  for (let id = 1; id <= 25; id++) add(id, 'Alchemy.');
  add(26, `Alchemy protocol ${'copper '.repeat(1000)}`);
  for (let id = 100; id < 200; id++) add(id, 'Protocol.');
  rebuild();
  const match = '"alchemy" OR "protocol"';
  const original = db
    .prepare(
      'SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ? ORDER BY rank,rowid LIMIT 25'
    )
    .all(match) as { rowid: number }[];
  expect(original.map((row) => row.rowid)).not.toContain(26);
  expect(recallFirstPrompt(dbPath, 'alchemy protocol', { minimumKeywordMatches: 2 }).items).toEqual(
    []
  );
});

it('counts distinct whole query keywords and never claims relevance from substrings', () => {
  add(1, 'Alchemy protocols');
  add(2, 'Alchemy protocol');
  rebuild();
  expect(
    recallFirstPrompt(dbPath, 'alchemy protocol protocol', {
      minimumKeywordMatches: 2,
    }).items.map((row) => row.id)
  ).toEqual([2]);
});

it('ships the measured two-keyword default through the public recall entrypoint', () => {
  add(1, 'Alchemy.');
  add(2, 'Alchemy protocol.');
  rebuild();
  expect(recallFirstPrompt(dbPath, 'alchemy protocol').items.map((row) => row.id)).toEqual([2]);
});
