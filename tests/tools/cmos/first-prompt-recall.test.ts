// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real SQLite fixtures verify bounded first-prompt citation retrieval and origin boundaries.
// ABOUTME: Read-only snapshots and explicit failures prevent a hook from mutating stores or hiding errors.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recallFirstPrompt as productionRecall } from '../../../src/tools/cmos/first-prompt-recall';
import { captureToolCall } from '../../../src/tools/cmos/tool-call-context';

// These fixtures isolate graph/origin/schema behavior before the independently tested floor.
// first-prompt-floor.test.ts and the actual hook sweep enforce the published default.
const recallFirstPrompt = (
  db: string,
  query: string,
  options: Parameters<typeof productionRecall>[2] = {}
) => productionRecall(db, query, { minimumKeywordMatches: 0, ...options });

let root: string;
let dbPath: string;
let db: Database.Database;
let now: number;
const day = 86_400_000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-prompt-'));
  dbPath = path.join(root, 'cmos.sqlite');
  now = Date.now();
  db = new Database(dbPath);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('project_id','local-project');
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT,created_at TEXT,status TEXT,project_id TEXT,superseded_by INTEGER);
    CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text,content='strategic_decisions',content_rowid='id');`);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function row(
  id: number,
  text: string,
  age: number,
  status = 'active',
  projectId: string | null = null,
  successor: number | null = null
): void {
  db.prepare('INSERT INTO strategic_decisions VALUES(?,?,?,?,?,?)').run(
    id,
    text,
    new Date(now - age * day).toISOString(),
    status,
    projectId,
    successor
  );
}
function index(): void {
  db.exec("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')");
}

it('positively expands outgoing and incoming decisions from source text, without persisting queries or records', () => {
  row(1, 'Original material choice.', 30);
  row(10, 'Alchemy uses decision #1.', 10, 'active', 'local-project');
  row(20, 'Follow decision #10 for the prior choice.', 1);
  index();
  const before = fs.readFileSync(dbPath);
  const result = recallFirstPrompt(dbPath, 'alchemy', { nowMs: now });
  expect(result.available).toBe(true);
  expect(result.items.map((item) => item.id)).toEqual([10, 20, 1]);
  expect(result.items.find((item) => item.id === 1)?.via).toEqual([
    { seedId: 10, direction: 'out' },
  ]);
  expect(result.items.find((item) => item.id === 20)?.via).toEqual([
    { seedId: 10, direction: 'in' },
  ]);
  expect(result.localProjectId).toBe('local-project');
  expect(fs.readFileSync(dbPath)).toEqual(before);
  expect(fs.readdirSync(root)).toEqual(['cmos.sqlite']);
});

it('filters superseded and foreign origins before the keyword pool can be filled', () => {
  for (let id = 1; id <= 30; id++)
    row(id, 'Alchemy', 1, id < 16 ? 'superseded' : 'active', id < 16 ? null : 'foreign-project');
  row(40, 'Alchemy local material.', 20, 'archived', 'local-project');
  row(41, 'Alchemy legacy material.', 20, 'active', null);
  row(42, 'Alchemy successor pointer.', 1, 'active', null, 100);
  index();
  expect(
    recallFirstPrompt(dbPath, 'alchemy', { nowMs: now })
      .items.map((item) => item.id)
      .sort()
  ).toEqual([40, 41]);
});

it('filters invalid graph targets before the five-neighbor cap and never follows recursive edges', () => {
  row(1, 'Superseded.', 30, 'superseded');
  row(2, 'Foreign.', 30, 'active', 'foreign-project');
  row(3, 'Future.', 1);
  row(4, 'Fourth uses decision #9.', 30);
  row(5, 'Fifth.', 30);
  row(6, 'Sixth.', 30);
  row(7, 'Seventh.', 30);
  row(8, 'Eighth.', 30);
  row(9, 'Ninth.', 40);
  row(10, 'Alchemy uses decisions #1, #2, #3, #10, #4, #5, #6, #7, #8, #9.', 10);
  index();
  const result = recallFirstPrompt(dbPath, 'alchemy', { nowMs: now });
  expect(result.items.map((item) => item.id)).toEqual([10, 4, 5, 6, 7]);
  expect(result.items.every((item) => item.kind === 'decision' && item.text.length <= 300)).toBe(
    true
  );
});

it('fails explicitly for a missing index, required schema, query failure, or elapsed deadline', () => {
  expect(recallFirstPrompt(dbPath, 'alchemy', { deadlineAtMs: now - 1 })).toMatchObject({
    available: false,
    items: [],
    warnings: ['recall_deadline'],
  });
  db.exec('DROP TABLE decisions_fts');
  expect(recallFirstPrompt(dbPath, 'alchemy')).toMatchObject({
    available: false,
    items: [],
    warnings: ['recall_index_missing'],
  });
  db.exec('DROP TABLE strategic_decisions');
  expect(recallFirstPrompt(dbPath, 'alchemy')).toMatchObject({
    available: false,
    items: [],
    warnings: ['recall_schema_missing'],
  });
});

it('reports an available empty search separately and handles old stores without provenance columns', () => {
  row(1, 'No overlap.', 10);
  index();
  expect(recallFirstPrompt(dbPath, 'unrelated')).toMatchObject({
    available: true,
    items: [],
    warnings: [],
  });
  db.exec(
    'ALTER TABLE strategic_decisions DROP COLUMN project_id; ALTER TABLE strategic_decisions DROP COLUMN superseded_by;'
  );
  expect(recallFirstPrompt(dbPath, 'overlap').items[0]).toMatchObject({ id: 1, projectId: null });
});

it('uses the production 64-keyword arm rather than the old CLI 24-token cutoff', () => {
  row(1, 'Alchemy prior material.', 10);
  index();
  const query = [...Array.from({ length: 30 }, (_, i) => `unmatched${i}`), 'alchemy'].join(' ');
  expect(recallFirstPrompt(dbPath, query).items.map((item) => item.id)).toEqual([1]);
});

it('reports a malformed existing index as a query failure instead of an empty match', () => {
  db.exec('DROP TABLE decisions_fts; CREATE TABLE decisions_fts (decision_text TEXT)');
  expect(recallFirstPrompt(dbPath, 'alchemy')).toMatchObject({
    available: false,
    items: [],
    warnings: ['recall_query_failed'],
  });
});

it('abandons work that runs past the deadline after opening the store', () => {
  row(1, 'Alchemy.', 1);
  index();
  const clock = jest
    .spyOn(Date, 'now')
    .mockReturnValueOnce(now)
    .mockReturnValue(now + 1000);
  try {
    expect(
      recallFirstPrompt(dbPath, 'alchemy', { nowMs: now, deadlineAtMs: now + 500 })
    ).toMatchObject({
      available: false,
      items: [],
      warnings: ['recall_deadline'],
    });
  } finally {
    clock.mockRestore();
  }
});

it.each(['dashboard_slug', 'project_name'])(
  'uses the canonical %s fallback for legacy origin-stamped local rows',
  (key) => {
    db.prepare("DELETE FROM metadata WHERE key='project_id'").run();
    db.prepare('INSERT INTO metadata VALUES(?,?)').run(key, 'legacy-local');
    row(1, 'Alchemy.', 1, 'active', 'legacy-local');
    index();
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = recallFirstPrompt(dbPath, 'alchemy');
      expect(result).toMatchObject({ available: true, localProjectId: 'legacy-local' });
      expect(result.items.map((item) => item.id)).toEqual([1]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('NO RECORDED project identity'));
    } finally {
      stderr.mockRestore();
    }
  }
);

it('keeps the canonical unknown-project fallback disclosed on every read without writing metadata', async () => {
  db.exec('DELETE FROM metadata');
  row(1, 'Alchemy.', 1, 'active', 'unknown-project');
  index();
  const before = fs.readFileSync(dbPath);
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    for (let i = 0; i < 2; i++) {
      const receipt = await captureToolCall('read', async () =>
        recallFirstPrompt(dbPath, 'alchemy')
      );
      expect(receipt.value.items.map((item) => item.id)).toEqual([1]);
      expect(receipt.projectIdentityDisclosures).toHaveLength(1);
    }
    expect(fs.readFileSync(dbPath)).toEqual(before);
  } finally {
    stderr.mockRestore();
  }
});

it.each(['missing', 'malformed'])(
  'does not disguise a %s metadata query as a legitimate missing-identity fallback',
  (mode) => {
    row(1, 'Alchemy.', 1);
    index();
    db.exec('DROP TABLE metadata');
    if (mode === 'malformed') db.exec('CREATE TABLE metadata (key TEXT)');
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(recallFirstPrompt(dbPath, 'alchemy')).toMatchObject({
        available: false,
        items: [],
        warnings: ['recall_query_failed'],
      });
    } finally {
      stderr.mockRestore();
    }
  }
);
