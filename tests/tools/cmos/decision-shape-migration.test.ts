// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Decision shape upgrades are atomic, retryable and compatible with read-only recall.
// ABOUTME: Owned FTS definitions may evolve; unrelated SQLite objects and old record bytes survive.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import * as migrations from '../../../src/tools/cmos/schema-migrations';
import { captureToolCall } from '../../../src/tools/cmos/tool-call-context';

const fields = [
  'context_text',
  'alternatives',
  'consequences',
  'deciders',
  'approval_mode',
  'approval_draft',
  'approval_words',
];
type ShapeResult = migrations.MigrationResult & { ready: boolean };
const migrate = (client: CmosDatabaseClient): ShapeResult =>
  (
    migrations as unknown as { ensureDecisionShapeColumns: (c: CmosDatabaseClient) => ShapeResult }
  ).ensureDecisionShapeColumns(client);

let root: string;
let dbPath: string;
let client: CmosDatabaseClient;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-decision-shape-'));
  dbPath = path.join(root, 'cmos/db/cmos.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('project_id', 'decision-shape-test');
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY, decision_text TEXT NOT NULL, created_at TEXT,
      legacy_extra TEXT
    );
  `);
  db.prepare('INSERT INTO strategic_decisions VALUES (1, ?, ?, ?)').run(
    'Preserve this old headline byte for byte.',
    new Date(Date.now() - 86400000).toISOString(),
    'consumer-owned value'
  );
  db.close();
  const opened = await CmosDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('fixture open failed');
  client = opened.data;
  expect(migrations.ensureDecisionsFts5(client).warnings).toEqual([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function columns(): Array<{ name: string; type: string; notnull: number; dflt_value: unknown }> {
  return client.getMany<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
    'PRAGMA table_info(strategic_decisions)'
  ).data!;
}

function marker(): string | undefined {
  return client.getOne<{ value: string }>(
    "SELECT value FROM metadata WHERE key='decision_shape_columns'"
  ).data?.value;
}

function hits(word: string): number[] {
  const result = client.getMany<{ rowid: number }>(
    'SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?',
    [word]
  );
  expect(result.success).toBe(true);
  return result.data!.map((r) => r.rowid);
}

it('adds seven nullable fields and one marker while preserving existing record bytes and columns', () => {
  const before = client.getOne('SELECT * FROM strategic_decisions WHERE id=1').data;
  const result = migrate(client);
  expect(result).toMatchObject({ ready: true, alreadyCurrent: false, warnings: [] });
  expect(result.columnsAdded).toEqual(fields);
  expect(marker()).toBe('1');
  const after = client.getOne<Record<string, unknown>>(
    'SELECT * FROM strategic_decisions WHERE id=1'
  ).data!;
  expect(after).toMatchObject(before as object);
  for (const name of fields) {
    expect(after[name]).toBeNull();
    expect(columns().find((c) => c.name === name)).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });
  }
  expect(hits('headline')).toEqual([1]);
  expect(migrate(client)).toMatchObject({
    ready: true,
    alreadyCurrent: true,
    columnsAdded: [],
    warnings: [],
  });
});

it('indexes every rich field and keeps INSERT, rich-only UPDATE and DELETE in sync', () => {
  expect(migrate(client).ready).toBe(true);
  expect(
    client.execute(`INSERT INTO strategic_decisions
    (id,decision_text,context_text,alternatives,consequences,deciders)
    VALUES (2,'headline','contextquartz','["alternativeamber"]','consequencejade','["decideropal"]')`)
      .success
  ).toBe(true);
  for (const token of ['contextquartz', 'alternativeamber', 'consequencejade', 'decideropal'])
    expect(hits(token)).toEqual([2]);
  expect(
    client.execute("UPDATE strategic_decisions SET context_text='contextsilver' WHERE id=2").success
  ).toBe(true);
  expect(hits('contextquartz')).toEqual([]);
  expect(hits('contextsilver')).toEqual([2]);
  expect(client.execute('DELETE FROM strategic_decisions WHERE id=2').success).toBe(true);
  expect(hits('contextsilver')).toEqual([]);
  expect(
    client.raw("INSERT INTO decisions_fts(decisions_fts,rank) VALUES('integrity-check',1)").success
  ).toBe(true);
});

it('leaves old reads unmigrated, and accepts the rich index on subsequent read upkeep without downgrade', async () => {
  const old = client.getOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE name='decisions_fts'"
  ).data!.sql;
  await captureToolCall('read', async () => {
    expect(migrate(client)).toMatchObject({ ready: false, alreadyCurrent: false });
    expect(migrations.ensureDecisionsFts5(client).warnings).toEqual([]);
  });
  expect(marker()).toBeUndefined();
  expect(columns().map((c) => c.name)).not.toContain('context_text');
  expect(
    client.getOne<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='decisions_fts'").data!
      .sql
  ).toBe(old);
  expect(migrate(client).ready).toBe(true);
  const upgraded = client.getOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE name='decisions_fts'"
  ).data!.sql;
  await captureToolCall('read', async () => {
    expect(migrations.ensureDecisionsFts5(client)).toMatchObject({
      alreadyCurrent: true,
      warnings: [],
    });
  });
  expect(
    client.getOne<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='decisions_fts'").data!
      .sql
  ).toBe(upgraded);
});

it.each(['table', 'trigger'])(
  'preserves a foreign same-named %s and does not partially add columns',
  (kind) => {
    const sql =
      kind === 'table'
        ? 'DROP TABLE decisions_fts; CREATE TABLE decisions_fts (owner TEXT)'
        : 'DROP TRIGGER decisions_fts_insert; CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN SELECT 17; END';
    expect(client.raw(sql).success).toBe(true);
    const before = client.getMany('SELECT name,type,sql FROM sqlite_master ORDER BY name').data;
    const result = migrate(client);
    expect(result.ready).toBe(false);
    expect(result.warnings?.join(' ')).toMatch(/different|unrecognized|foreign|not.*fts5/i);
    expect(marker()).toBeUndefined();
    expect(client.getMany('SELECT name,type,sql FROM sqlite_master ORDER BY name').data).toEqual(
      before
    );
  }
);

it.each(['column', 'trigger', 'rebuild', 'marker'])(
  'rolls back %s failure and retries without a stale success marker',
  (failure) => {
    const originalRaw = client.raw.bind(client);
    const originalExecute = client.execute.bind(client);
    const refused = {
      success: false as const,
      error: { code: 'INJECTED', message: `injected ${failure}` },
    };
    const raw = jest
      .spyOn(client, 'raw')
      .mockImplementation((sql) =>
        (failure === 'column' && /ADD COLUMN consequences/.test(sql)) ||
        (failure === 'trigger' && /CREATE TRIGGER decisions_fts_update/.test(sql)) ||
        (failure === 'rebuild' && /VALUES\s*\('rebuild'\)/.test(sql))
          ? refused
          : originalRaw(sql)
      );
    const execute = jest
      .spyOn(client, 'execute')
      .mockImplementation((sql, params) =>
        (failure === 'marker' &&
          /INSERT.*metadata/s.test(sql) &&
          (sql.includes('decision_shape_columns') ||
            (Array.isArray(params) && params.includes('decision_shape_columns')))) ||
        (failure === 'column' && /ADD COLUMN consequences/.test(sql)) ||
        (failure === 'rebuild' && /VALUES\s*\('rebuild'\)/.test(sql))
          ? refused
          : originalExecute(sql, params)
      );
    const result = migrate(client);
    expect(result).toMatchObject({
      ready: false,
      alreadyCurrent: false,
      columnsAdded: [],
      indexesCreated: [],
      rowsUpdated: 0,
    });
    expect(result.warnings?.join(' ')).toContain(`injected ${failure}`);
    expect(marker()).toBeUndefined();
    expect(columns().map((c) => c.name)).not.toContain('context_text');
    expect(hits('headline')).toEqual([1]);
    raw.mockRestore();
    execute.mockRestore();
    expect(migrate(client).ready).toBe(true);
  }
);

it('reports a schema-read failure without stamping success', () => {
  const original = client.getMany.bind(client);
  jest
    .spyOn(client, 'getMany')
    .mockImplementation((sql, params) =>
      /PRAGMA table_info/.test(sql)
        ? { success: false, error: { code: 'INJECTED', message: 'unreadable columns' } }
        : original(sql, params)
    );
  expect(migrate(client)).toMatchObject({ ready: false });
  expect(marker()).toBeUndefined();
});

it('does not negative-cache an absent source table and succeeds after it is created', () => {
  expect(client.raw('DROP TABLE strategic_decisions; DROP TABLE decisions_fts').success).toBe(true);
  expect(migrate(client)).toMatchObject({ ready: false, alreadyCurrent: false });
  expect(marker()).toBeUndefined();
  expect(
    client.raw(
      'CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY, decision_text TEXT NOT NULL)'
    ).success
  ).toBe(true);
  expect(migrate(client).ready).toBe(true);
  expect(marker()).toBe('1');
});

it('does not downgrade a newer marker or trust a forged success marker', () => {
  expect(client.execute("INSERT INTO metadata VALUES ('decision_shape_columns','2')").success).toBe(
    true
  );
  expect(migrate(client)).toMatchObject({ ready: false, alreadyCurrent: false });
  expect(marker()).toBe('2');
  expect(columns().map((c) => c.name)).not.toContain('context_text');
  expect(
    client.execute("UPDATE metadata SET value='1' WHERE key='decision_shape_columns'").success
  ).toBe(true);
  expect(migrate(client)).toMatchObject({ ready: false, alreadyCurrent: false });
  expect(columns().map((c) => c.name)).not.toContain('context_text');
});

it('cannot roll back a caller transaction when migration was mistakenly called inside it', () => {
  expect(client.raw('BEGIN IMMEDIATE').success).toBe(true);
  expect(client.execute("INSERT INTO metadata VALUES ('caller-write','preserve')").success).toBe(
    true
  );
  expect(migrate(client)).toMatchObject({ ready: false });
  expect(
    client.getOne<{ value: string }>("SELECT value FROM metadata WHERE key='caller-write'").data
      ?.value
  ).toBe('preserve');
  expect(client.raw('ROLLBACK').success).toBe(true);
  expect(marker()).toBeUndefined();
});

it('does not count the migration itself as a caller record write', async () => {
  const { currentWrittenStores } = await import('../../../src/tools/cmos/tool-call-context');
  await captureToolCall('write', async () => {
    expect(migrate(client).ready).toBe(true);
    expect(currentWrittenStores()).toEqual([]);
  });
});

it('surfaces a failed FTS definition probe instead of guessing an index version', () => {
  const unreadable = {
    success: false as const,
    error: { code: 'INJECTED', message: 'definition unreadable' },
  };
  jest.spyOn(client, 'getOne').mockReturnValueOnce(unreadable);
  const result = migrations.ensureDecisionsFts5(client);
  expect(result.alreadyCurrent).toBe(false);
  expect(result.warnings?.join(' ')).toContain('definition unreadable');
});

it('honors the review role even outside MCP dispatch', () => {
  const prior = process.env.CMOS_AGENT_ROLE;
  process.env.CMOS_AGENT_ROLE = 'review';
  try {
    expect(migrate(client)).toMatchObject({ ready: false });
    expect(marker()).toBeUndefined();
    expect(columns().map((c) => c.name)).not.toContain('context_text');
  } finally {
    if (prior === undefined) delete process.env.CMOS_AGENT_ROLE;
    else process.env.CMOS_AGENT_ROLE = prior;
  }
});

it('rejects a nullable existing field whose default would invent omitted values', () => {
  expect(
    client.raw("ALTER TABLE strategic_decisions ADD COLUMN context_text TEXT DEFAULT 'invented'")
      .success
  ).toBe(true);
  expect(migrate(client)).toMatchObject({ ready: false });
  expect(marker()).toBeUndefined();
  expect(columns().map((column) => column.name)).not.toContain('alternatives');
});
