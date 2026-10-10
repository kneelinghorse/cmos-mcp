// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Citation expansion remains one hop, same kind and bounded after eligibility checks.
// ABOUTME: Live SQLite rows exercise authoritative pointer changes and read-only failure reporting.

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { ensureRecordLinks } from '../../../src/tools/cmos/record-links';
import { citationNeighbors } from '../../../src/tools/cmos/citation-neighbors';
import { captureToolCall } from '../../../src/tools/cmos/tool-call-context';

let root: string, client: CmosDatabaseClient, now: number;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-citation-neighbors-'));
  now = Date.now();
  const dbPath = path.join(root, 'cmos/db/cmos.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('project_id','local');
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT,created_at TEXT,project_id TEXT,status TEXT,superseded_by INTEGER);
    CREATE TABLE learnings(id INTEGER PRIMARY KEY,content TEXT,created_at TEXT,project_id TEXT,status TEXT);`);
  db.close();
  const opened = await CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('fixture open');
  client = opened.data;
});
afterEach(() => {
  jest.restoreAllMocks();
  client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});
function row(
  id: number,
  text = 'Ordinary record.',
  age = 10,
  status: string | null = 'active',
  project: string | null = 'local',
  kind = 'decision'
) {
  const table = kind === 'decision' ? 'strategic_decisions' : 'learnings';
  const field = kind === 'decision' ? 'decision_text' : 'content';
  expect(
    client.execute(
      `INSERT INTO ${table}(id,${field},created_at,status,project_id) VALUES(?,?,?,?,?)`,
      [id, text, new Date(now - age * 1000).toISOString(), status, project]
    ).success
  ).toBe(true);
}
function build() {
  expect(ensureRecordLinks(client).ready).toBe(true);
}
const ids = (seeds: number[], options = {}) => [
  ...citationNeighbors(client, 'decision', seeds, options).neighbors.keys(),
];

function spunOut(kind: 'decision' | 'learning', id: number) {
  expect(
    client.execute('INSERT INTO metadata(key,value) VALUES(?,?)', [
      `spin_out_row:${kind}:${id}`,
      JSON.stringify({
        operationId: 'fork',
        sourceProjectId: 'local',
        sourceRoot: root,
        sourceId: id,
        targetProjectId: 'target',
        targetRoot: '/target',
        targetId: id + 1000,
      }),
    ]).success
  ).toBe(true);
}

it('excludes finalized source rows before seed and neighbor caps in both directions', () => {
  for (let id = 1; id <= 7; id++) {
    row(id, 'Target.', 20);
    row(id + 100, `d:${id}`, 1);
    if (id <= 5) spunOut('decision', id);
  }
  row(200, 'd:1 d:2 d:3 d:4 d:5 d:6 d:7', 1);
  build();
  expect(ids([1, 2, 3, 4, 5, 6])).toEqual([106, 200]);
  expect(ids([200])).toEqual([6, 7]);
  spunOut('decision', 106);
  expect(ids([6])).toEqual([200]);
});

it('does not traverse a hidden supersession source or endpoint', () => {
  row(1, 'Old.', 30, 'superseded');
  row(2, 'Current.', 20);
  row(3, 'd:1', 1);
  expect(client.execute('UPDATE strategic_decisions SET superseded_by=2 WHERE id=1').success).toBe(
    true
  );
  build();
  spunOut('decision', 1);
  expect(ids([1, 3])).toEqual([]);
});

it('retains hidden identities in bare citation collision checks', () => {
  row(1);
  row(1, 'Collision.', 10, 'active', 'local', 'learning');
  row(3, '#1', 1);
  spunOut('learning', 1);
  build();
  expect(ids([3])).toEqual([]);
});

it('collects outgoing then incoming same-kind neighbors without a second hop', () => {
  row(1);
  row(2, 'd:1', 5);
  row(3, 'd:2', 2);
  row(4, 'd:3', 1);
  row(10, 'd:2', 1, 'active', 'local', 'learning');
  build();
  const result = citationNeighbors(client, 'decision', [2]);
  expect([...result.neighbors.keys()]).toEqual([1, 3]);
  expect(result.bySeed.get(2)).toEqual([1, 3]);
  expect(result.neighbors.get(1)).toEqual({ rank: 1, via: [{ seedId: 2, direction: 'out' }] });
  expect(result.neighbors.get(3)).toEqual({ rank: 1, via: [{ seedId: 2, direction: 'in' }] });
});

it('filters origin and status before the five-neighbor cap', () => {
  for (let id = 1; id <= 12; id++)
    row(id, 'Target.', 20, id <= 3 ? 'archived' : 'active', id >= 4 && id <= 6 ? 'foreign' : null);
  row(20, Array.from({ length: 12 }, (_, i) => `d:${i + 1}`).join(' '), 1);
  build();
  expect(ids([20], { statusFilter: ['active'] })).toEqual([7, 8, 9, 10, 11]);
});

it('selects five eligible seeds before imposing the seed cap', () => {
  for (let id = 1; id <= 7; id++) {
    row(id);
    row(id + 100, `d:${id}`, 1, 'active', id === 1 ? 'foreign' : 'local');
  }
  build();
  expect(ids([101, 102, 103, 104, 105, 106, 107])).toEqual([2, 3, 4, 5, 6]);
});

it('maps outgoing and incoming stale endpoints through the current authoritative pointer', () => {
  row(1, 'Old target.', 30, 'superseded');
  row(2, 'Replacement.', 20);
  row(3, 'd:1', 10);
  row(4, 'Next replacement.', 15);
  expect(client.execute('UPDATE strategic_decisions SET superseded_by=2 WHERE id=1').success).toBe(
    true
  );
  build();
  expect(ids([3])).toEqual([2]);
  expect(ids([2])).toEqual([3]);
  expect(client.execute('UPDATE strategic_decisions SET superseded_by=4 WHERE id=1').success).toBe(
    true
  );
  expect(ids([3])).toEqual([4]);
  expect(ids([2])).toEqual([]);
  expect(ids([4])).toEqual([3]);
});

it('uses a superseded seed current row instead of replaying obsolete source text', () => {
  row(1);
  row(2);
  row(3, 'd:1', 5, 'superseded');
  row(4, 'd:2', 1);
  expect(client.execute('UPDATE strategic_decisions SET superseded_by=4 WHERE id=3').success).toBe(
    true
  );
  build();
  expect(ids([3])).toEqual([2]);
  expect(ids([1])).toEqual([]);
});

it('omits pointerless superseded, missing, foreign and cyclic endpoints even with an unrestricted status option', () => {
  row(1, 'No pointer.', 40, 'superseded');
  row(2, 'Missing pointer.', 30, 'superseded');
  row(3, 'Cycle.', 30, 'superseded');
  row(4, 'Cycle.', 30, 'superseded');
  row(5, 'Foreign pointer.', 30);
  row(6, 'Foreign replacement.', 20, 'active', 'foreign');
  row(9, 'd:1 d:2 d:3 d:5', 1);
  expect(
    client.raw(
      'UPDATE strategic_decisions SET superseded_by=99 WHERE id=2; UPDATE strategic_decisions SET superseded_by=4 WHERE id=3; UPDATE strategic_decisions SET superseded_by=3 WHERE id=4; UPDATE strategic_decisions SET superseded_by=6 WHERE id=5;'
    ).success
  ).toBe(true);
  build();
  expect(ids([9], { statusFilter: [] })).toEqual([]);
});

it('rejects incoming archived sources before capping and honors NULL legacy origins/status', () => {
  row(1, 'Target.', 50, null, null);
  for (let id = 2; id <= 9; id++) row(id, 'd:1', 1, id < 4 ? 'archived' : 'active', null);
  build();
  expect(ids([1], { statusFilter: [] })).toEqual([2, 3, 4, 5, 6]);
  expect(ids([1], { statusFilter: ['active'] })).toEqual([]);
  expect(ids([4], { statusFilter: [] })).toContain(1);
});

it('reads typed fallback without writes, then sees newly materialized bare edges in the same process', () => {
  row(1);
  row(2, 'd:1', 1);
  row(3, '#1', 1);
  const before = client.getMany('SELECT name,sql FROM sqlite_master ORDER BY name').data;
  expect(ids([1])).toEqual([2]);
  expect(client.getMany('SELECT name,sql FROM sqlite_master ORDER BY name').data).toEqual(before);
  build();
  expect(ids([1])).toEqual([2, 3]);
});

it('reports broken graph reads through upkeep notes and console instead of claiming an empty graph', async () => {
  row(1);
  build();
  expect(
    client.raw('DROP TABLE record_links; CREATE TABLE record_links(broken TEXT)').success
  ).toBe(true);
  const warning = jest.spyOn(console, 'error').mockImplementation(() => {});
  const result = await captureToolCall('read', async () =>
    citationNeighbors(client, 'decision', [1])
  );
  expect(result.value.available).toBe(false);
  expect(result.value.warnings.join(' ')).toContain('RECORD_LINKS_READ_FAILED');
  expect(result.storeUpkeepNotes.join(' ')).toContain('RECORD_LINKS_READ_FAILED');
  expect(warning).toHaveBeenCalled();
});

it('does not traverse more than the documented32 supersession steps', () => {
  for (let id = 1; id <= 34; id++) row(id, 'Chain.', 40, id === 34 ? 'active' : 'superseded');
  for (let id = 1; id < 34; id++)
    expect(
      client.execute('UPDATE strategic_decisions SET superseded_by=? WHERE id=?', [id + 1, id])
        .success
    ).toBe(true);
  row(50, 'd:1', 1);
  build();
  expect(ids([50])).toEqual([]);
});
