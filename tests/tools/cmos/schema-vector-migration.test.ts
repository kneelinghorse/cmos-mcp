// ABOUTME: Tests for ensureVectorStorage (Sprint 66 m02) — vec0 tables, last_embedded_hash columns, learnings_fts + missions_fts parity, idempotency, and trigger correctness.
// Verifies the migration matches the schema sketch in cmos/planning/adr/s66-vector-retrieval.md.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  ensureVectorStorage,
  VECTOR_STORAGE_SCHEMA_VERSION,
} from '../../../src/tools/cmos/schema-migrations';

const VECTOR_STORAGE_MARKER_KEY = 'vector_storage_columns';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-vec-migration-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO metadata (key, value) VALUES ('schema_version', '2.1');

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Queued'
    );
  `);
  db.close();
  return { tempDir, dbPath };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function readMetadata(client: CmosDatabaseClient, key: string): string | undefined {
  return client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]).data
    ?.value;
}

function writeMetadata(client: CmosDatabaseClient, key: string, value: string): void {
  expect(
    client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value])
      .success
  ).toBe(true);
}

function deleteMetadata(client: CmosDatabaseClient, key: string): void {
  expect(client.execute('DELETE FROM metadata WHERE key = ?', [key]).success).toBe(true);
}

/** Pack a 384-element Float32Array into a Buffer for sqlite-vec storage. */
function packEmbedding(values: number[]): Buffer {
  const arr = new Float32Array(384);
  for (let i = 0; i < Math.min(values.length, 384); i++) arr[i] = values[i];
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Build a 384-dim test vector where a chosen index is 1.0 and the rest 0.0. */
function unitVector(hotIndex: number): Buffer {
  const arr = new Float32Array(384);
  arr[hotIndex % 384] = 1;
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

// ─── ensureVectorStorage ─────────────────────────────────────────────────────

describe('ensureVectorStorage', () => {
  let tempDir: string;
  let dbPath: string;
  let client: CmosDatabaseClient;

  beforeEach(async () => {
    ({ tempDir, dbPath } = makeTempDb());
    const result = await CmosDatabaseClient.create({ dbPath });
    if (!result.success || !result.data) {
      throw new Error(`Failed to open client: ${result.error?.message}`);
    }
    client = result.data;
  });

  afterEach(() => {
    client.close();
    cleanup(tempDir);
  });

  describe('first run', () => {
    it('creates the three vec0 virtual tables', () => {
      ensureVectorStorage(client);

      for (const tbl of ['decisions_vec', 'learnings_vec', 'missions_vec']) {
        const row = client.getOne<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          [tbl]
        );
        expect(row.success).toBe(true);
        expect(row.data?.name).toBe(tbl);
      }
    });

    it('adds last_embedded_hash column to all three source tables', () => {
      ensureVectorStorage(client);

      for (const tbl of ['strategic_decisions', 'learnings', 'missions']) {
        const cols = client.getMany<{ name: string }>(`PRAGMA table_info('${tbl}')`, []);
        expect(cols.success).toBe(true);
        const colNames = (cols.data ?? []).map((c) => c.name);
        expect(colNames).toContain('last_embedded_hash');
      }
    });

    it('creates learnings_fts virtual table and triggers', () => {
      ensureVectorStorage(client);

      const fts = client.getOne<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='learnings_fts'",
        []
      );
      expect(fts.data?.name).toBe('learnings_fts');

      for (const trg of ['learnings_fts_insert', 'learnings_fts_delete', 'learnings_fts_update']) {
        const row = client.getOne<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",
          [trg]
        );
        expect(row.data?.name).toBe(trg);
      }
    });

    it('creates missions_fts virtual table and triggers', () => {
      ensureVectorStorage(client);

      const fts = client.getOne<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='missions_fts'",
        []
      );
      expect(fts.data?.name).toBe('missions_fts');

      for (const trg of ['missions_fts_insert', 'missions_fts_delete', 'missions_fts_update']) {
        const row = client.getOne<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",
          [trg]
        );
        expect(row.data?.name).toBe(trg);
      }
    });

    it('stamps its own 2.3 marker and raises the shared label to at least 2.3', () => {
      ensureVectorStorage(client);

      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
    });

    it('returns a MigrationResult listing created objects', () => {
      const result = ensureVectorStorage(client);

      expect(result.alreadyCurrent).toBe(false);
      expect(result.columnsAdded).toEqual(
        expect.arrayContaining([
          'decisions_vec (virtual table)',
          'learnings_vec (virtual table)',
          'missions_vec (virtual table)',
          'strategic_decisions.last_embedded_hash',
          'learnings.last_embedded_hash',
          'missions.last_embedded_hash',
          'learnings_fts (virtual table)',
          'missions_fts (virtual table)',
        ])
      );
      expect(result.indexesCreated).toEqual(
        expect.arrayContaining([
          'learnings_fts_insert',
          'learnings_fts_delete',
          'learnings_fts_update',
          'missions_fts_insert',
          'missions_fts_delete',
          'missions_fts_update',
        ])
      );
    });
  });

  describe('idempotency', () => {
    it('is a no-op on the second invocation', () => {
      const first = ensureVectorStorage(client);
      expect(first.alreadyCurrent).toBe(false);

      const second = ensureVectorStorage(client);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.columnsAdded).toEqual([]);
      expect(second.indexesCreated).toEqual([]);
    });

    it('does not double-stamp its completion marker on re-run', () => {
      ensureVectorStorage(client);
      ensureVectorStorage(client);

      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
    });

    it('does not downgrade a newer shared high-water label', () => {
      ensureVectorStorage(client);
      writeMetadata(client, 'schema_version', '2.4');

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: true,
        warnings: [],
      });
      expect(readMetadata(client, 'schema_version')).toBe('2.4');
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
    });

    it.each([
      {
        sourceTable: 'learnings',
        ftsTable: 'learnings_fts',
        insertSql:
          "INSERT INTO learnings (content, created_at) VALUES ('current marker repair sentinel', '2026-08-28T00:00:00Z')",
        matchTerm: 'sentinel',
      },
      {
        sourceTable: 'missions',
        ftsTable: 'missions_fts',
        insertSql:
          "INSERT INTO missions (id, name, status) VALUES ('s99-m99', 'current marker repair sentinel', 'Queued')",
        matchTerm: 'sentinel',
      },
    ])(
      'repairs an empty $ftsTable index even when the vector marker is current',
      ({ sourceTable, ftsTable, insertSql, matchTerm }) => {
        expect(ensureVectorStorage(client).warnings).toEqual([]);
        expect(client.raw(insertSql).success).toBe(true);
        expect(
          client.execute(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES(?)`, ['delete-all']).success
        ).toBe(true);
        writeMetadata(client, VECTOR_STORAGE_MARKER_KEY, VECTOR_STORAGE_SCHEMA_VERSION);
        expect(
          client.getOne<{ count: number }>(`SELECT COUNT(*) AS count FROM ${sourceTable}`, []).data
            ?.count
        ).toBe(1);
        expect(
          client.getOne<{ count: number }>(`SELECT COUNT(*) AS count FROM ${ftsTable}_docsize`, [])
            .data?.count
        ).toBe(0);

        expect(ensureVectorStorage(client)).toEqual({
          columnsAdded: [],
          indexesCreated: [],
          rowsUpdated: 1,
          alreadyCurrent: false,
          warnings: [],
        });
        expect(
          client.getMany(`SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?`, [matchTerm])
            .data
        ).toHaveLength(1);
        expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
        expect(ensureVectorStorage(client)).toEqual({
          columnsAdded: [],
          indexesCreated: [],
          rowsUpdated: 0,
          alreadyCurrent: true,
          warnings: [],
        });
      }
    );

    it('accepts benign IF NOT EXISTS, whitespace, and trailing-semicolon spelling differences', () => {
      expect(ensureVectorStorage(client).warnings).toEqual([]);
      expect(client.raw('DROP TABLE decisions_vec').success).toBe(true);
      expect(
        client.raw(`
          CREATE VIRTUAL TABLE IF NOT EXISTS decisions_vec
          USING vec0 (
            decision_id INTEGER PRIMARY KEY,
            embedding FLOAT[384]
          );
        `).success
      ).toBe(true);
      expect(client.raw('DROP TRIGGER learnings_fts_insert').success).toBe(true);
      expect(
        client.raw(`
          CREATE TRIGGER IF NOT EXISTS learnings_fts_insert
          AFTER INSERT ON learnings
          BEGIN
            INSERT INTO learnings_fts (rowid, content)
            VALUES (new.id, new.content);
          END;
        `).success
      ).toBe(true);

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: true,
        warnings: [],
      });
    });
  });

  describe('failed DDL disclosure', () => {
    it.each([
      ['table', 'CREATE TABLE decisions_vec (decision_id INTEGER PRIMARY KEY, embedding BLOB)'],
      ['view', 'CREATE VIEW decisions_vec AS SELECT 1 AS decision_id, zeroblob(1536) AS embedding'],
      ['index', 'CREATE INDEX decisions_vec ON strategic_decisions (id)'],
    ])(
      'rejects a same-named %s as a vec0 table without false creation claims',
      (objectType, collisionSql) => {
        const initial = ensureVectorStorage(client);
        expect(initial.warnings).toEqual([]);

        expect(client.raw('DROP TABLE decisions_vec').success).toBe(true);
        expect(client.raw(collisionSql).success).toBe(true);
        deleteMetadata(client, VECTOR_STORAGE_MARKER_KEY);

        const result = ensureVectorStorage(client);

        expect(result).toMatchObject({
          columnsAdded: [],
          indexesCreated: [],
          alreadyCurrent: false,
        });
        expect(result.warnings).toEqual([
          `CREATE VIRTUAL TABLE decisions_vec blocked: DB_SCHEMA_MISMATCH — Existing ${objectType} 'decisions_vec' is not a vec0 virtual table.`,
        ]);

        const object = client.getOne<{ type: string; sql: string }>(
          "SELECT type, sql FROM sqlite_master WHERE name = 'decisions_vec'",
          []
        );
        expect(object.data?.type).toBe(objectType);
        expect(object.data?.sql).not.toMatch(/CREATE\s+VIRTUAL\s+TABLE/i);
        expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
        expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      }
    );

    it('rejects a same-named vec0 table with the wrong key and dimensions', () => {
      expect(ensureVectorStorage(client).warnings).toEqual([]);
      expect(client.raw('DROP TABLE decisions_vec').success).toBe(true);
      expect(
        client.raw(`
          CREATE VIRTUAL TABLE decisions_vec USING vec0(
            other_id INTEGER PRIMARY KEY,
            embedding FLOAT[8]
          )
        `).success
      ).toBe(true);
      deleteMetadata(client, VECTOR_STORAGE_MARKER_KEY);

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: false,
        warnings: [
          "CREATE VIRTUAL TABLE decisions_vec blocked: DB_SCHEMA_MISMATCH — Existing vec0 virtual table 'decisions_vec' has a different definition; drop or rename it, then retry.",
        ],
      });
      expect(
        client.getOne<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE name = 'decisions_vec'",
          []
        ).data?.sql
      ).toContain('other_id INTEGER PRIMARY KEY');
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
    });

    it('rejects a same-named trigger with the wrong target behavior', () => {
      expect(ensureVectorStorage(client).warnings).toEqual([]);
      expect(client.raw('DROP TRIGGER learnings_fts_insert').success).toBe(true);
      expect(
        client.raw(`
          CREATE TRIGGER learnings_fts_insert AFTER INSERT ON learnings BEGIN
            SELECT 1;
          END
        `).success
      ).toBe(true);
      deleteMetadata(client, VECTOR_STORAGE_MARKER_KEY);

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: false,
        warnings: [
          "CREATE TRIGGER learnings_fts_insert blocked: DB_SCHEMA_MISMATCH — Existing trigger 'learnings_fts_insert' has a different definition; drop or rename it, then retry.",
        ],
      });
      expect(
        client.getOne<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE name = 'learnings_fts_insert'",
          []
        ).data?.sql
      ).toContain('SELECT 1');
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
    });

    it('does not stamp a partial store current until a missing source table is restored', () => {
      expect(client.raw('DROP TABLE strategic_decisions').success).toBe(true);

      const first = ensureVectorStorage(client);

      expect(first.alreadyCurrent).toBe(false);
      expect(first.warnings).toEqual([
        "ALTER TABLE strategic_decisions ADD COLUMN last_embedded_hash blocked: DB_SCHEMA_MISMATCH — Source table 'strategic_decisions' does not exist.",
      ]);
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);

      const stillPartial = ensureVectorStorage(client);
      expect(stillPartial.alreadyCurrent).toBe(false);
      expect(stillPartial.columnsAdded).toEqual([]);
      expect(stillPartial.indexesCreated).toEqual([]);
      expect(stillPartial.warnings).toEqual(first.warnings);
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);

      expect(
        client.raw(`
          CREATE TABLE strategic_decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            decision_text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
          )
        `).success
      ).toBe(true);

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: ['strategic_decisions.last_embedded_hash'],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: false,
        warnings: [],
      });
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: true,
        warnings: [],
      });
    });

    it('retries missing FTS triggers and rebuild after the source table is repaired', () => {
      expect(client.raw('DROP TABLE learnings').success).toBe(true);

      const first = ensureVectorStorage(client);

      expect(first.alreadyCurrent).toBe(false);
      expect(first.indexesCreated).toEqual([
        'missions_fts_insert',
        'missions_fts_delete',
        'missions_fts_update',
      ]);
      expect(first.warnings).toEqual([
        "CREATE TRIGGER learnings_fts_insert failed: DB_SCHEMA_MISMATCH — Table 'learnings' does not exist",
        "CREATE TRIGGER learnings_fts_delete failed: DB_SCHEMA_MISMATCH — Table 'learnings' does not exist",
        "CREATE TRIGGER learnings_fts_update failed: DB_SCHEMA_MISMATCH — Table 'learnings' does not exist",
        "learnings_fts rebuild failed: DB_SCHEMA_MISMATCH — Table 'learnings' does not exist",
      ]);
      expect(new Set(first.warnings).size).toBe(first.warnings?.length);
      expect(
        client.getOne<{ type: string }>(
          "SELECT type FROM sqlite_master WHERE name = 'learnings_fts'",
          []
        ).data?.type
      ).toBe('table');
      expect(
        client.getMany<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'learnings_fts_%' ORDER BY name",
          []
        ).data
      ).toEqual([]);
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);

      expect(
        client.raw(`
          CREATE TABLE learnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            category TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            last_embedded_hash TEXT
          );
          INSERT INTO learnings (content, created_at)
          VALUES ('rebuild me after repair', '2026-08-28T00:00:00Z');
        `).success
      ).toBe(true);

      const second = ensureVectorStorage(client);

      expect(second.alreadyCurrent).toBe(false);
      expect(second.warnings).toEqual([]);
      expect(second.columnsAdded).toEqual([]);
      expect(second.indexesCreated).toEqual([
        'learnings_fts_insert',
        'learnings_fts_delete',
        'learnings_fts_update',
      ]);
      expect(second.rowsUpdated).toBe(1);
      expect(
        client.getMany<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'learnings_fts_%' ORDER BY name",
          []
        ).data
      ).toEqual([
        { name: 'learnings_fts_delete' },
        { name: 'learnings_fts_insert' },
        { name: 'learnings_fts_update' },
      ]);
      expect(
        client.getMany<{ rowid: number }>(
          "SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'rebuild'",
          []
        ).data
      ).toHaveLength(1);
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);

      expect(ensureVectorStorage(client)).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: true,
        warnings: [],
      });
    });

    it('retries a failed vector marker write after all storage objects already exist', () => {
      expect(
        client.raw(`
          CREATE TRIGGER block_vector_storage_marker BEFORE INSERT ON metadata
          WHEN NEW.key = '${VECTOR_STORAGE_MARKER_KEY}'
          BEGIN
            SELECT RAISE(FAIL, 'vector storage marker blocked');
          END;
        `).success
      ).toBe(true);

      const first = ensureVectorStorage(client);

      expect(first.alreadyCurrent).toBe(false);
      expect(first.columnsAdded).toEqual([
        'decisions_vec (virtual table)',
        'learnings_vec (virtual table)',
        'missions_vec (virtual table)',
        'strategic_decisions.last_embedded_hash',
        'learnings.last_embedded_hash',
        'missions.last_embedded_hash',
        'learnings_fts (virtual table)',
        'missions_fts (virtual table)',
      ]);
      expect(first.indexesCreated).toEqual([
        'learnings_fts_insert',
        'learnings_fts_delete',
        'learnings_fts_update',
        'missions_fts_insert',
        'missions_fts_delete',
        'missions_fts_update',
      ]);
      expect(first.warnings).toEqual([
        "metadata.vector_storage_columns marker = '2.3' failed: DB_QUERY_FAILED — Query failed: vector storage marker blocked",
      ]);
      expect(
        client.getMany<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('decisions_vec', 'learnings_vec', 'missions_vec', 'learnings_fts', 'missions_fts')
           ORDER BY name`,
          []
        ).data
      ).toEqual([
        { name: 'decisions_vec' },
        { name: 'learnings_fts' },
        { name: 'learnings_vec' },
        { name: 'missions_fts' },
        { name: 'missions_vec' },
      ]);
      expect(
        client.getOne<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'trigger'
             AND (name LIKE 'learnings_fts_%' OR name LIKE 'missions_fts_%')`,
          []
        ).data?.count
      ).toBe(6);
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBeUndefined();
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);

      expect(client.raw('DROP TRIGGER block_vector_storage_marker').success).toBe(true);
      const second = ensureVectorStorage(client);

      expect(second).toEqual({
        columnsAdded: [],
        indexesCreated: [],
        rowsUpdated: 0,
        alreadyCurrent: false,
        warnings: [],
      });
      expect(readMetadata(client, VECTOR_STORAGE_MARKER_KEY)).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(readMetadata(client, 'schema_version')).toBe(VECTOR_STORAGE_SCHEMA_VERSION);
      expect(ensureVectorStorage(client).alreadyCurrent).toBe(true);
    });

    it('surfaces a failed vec0 raw CREATE without throwing or claiming the table', async () => {
      expect(ensureVectorStorage(client).warnings).toEqual([]);
      expect(client.raw('DROP TABLE decisions_vec').success).toBe(true);

      client.close();
      const opened = await CmosDatabaseClient.create({ dbPath, readonly: true });
      expect(opened.success).toBe(true);
      expect(opened.data).toBeDefined();
      client = opened.data!;

      const result = ensureVectorStorage(client);

      expect(result.alreadyCurrent).toBe(false);
      expect(result.columnsAdded).toEqual([]);
      expect(result.indexesCreated).toEqual([]);
      expect(result.warnings).toEqual([
        'CREATE VIRTUAL TABLE decisions_vec failed: DB_CONNECTION_FAILED — Database is opened in read-only mode',
      ]);
    });
  });

  describe('learnings_fts triggers', () => {
    beforeEach(() => {
      ensureVectorStorage(client);
    });

    it('insert trigger propagates new rows into the FTS index', () => {
      const insert = client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
        'Always validate sanitizer output before persisting',
        new Date().toISOString(),
      ]);
      expect(insert.success).toBe(true);

      const fts = client.getMany<{ rowid: number; content: string }>(
        `SELECT rowid, content FROM learnings_fts WHERE learnings_fts MATCH 'sanitizer'`,
        []
      );
      expect(fts.success).toBe(true);
      expect(fts.data?.length).toBe(1);
      expect(fts.data?.[0].content).toContain('sanitizer');
    });

    it('update trigger refreshes the FTS index', () => {
      client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
        'Original content keyword aardvark',
        new Date().toISOString(),
      ]);

      // Confirm initial state finds aardvark
      const before = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'aardvark'`,
        []
      );
      expect(before.data?.length).toBe(1);

      // Update content to remove the keyword
      client.execute(`UPDATE learnings SET content = ? WHERE id = 1`, [
        'New content keyword zebra',
      ]);

      const afterOld = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'aardvark'`,
        []
      );
      expect(afterOld.data?.length).toBe(0);

      const afterNew = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'zebra'`,
        []
      );
      expect(afterNew.data?.length).toBe(1);
    });

    it('delete trigger removes rows from the FTS index', () => {
      client.execute(`INSERT INTO learnings (content, created_at) VALUES (?, ?)`, [
        'Disposable learning content widget',
        new Date().toISOString(),
      ]);
      client.execute(`DELETE FROM learnings WHERE id = 1`, []);

      const fts = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'widget'`,
        []
      );
      expect(fts.data?.length).toBe(0);
    });
  });

  describe('missions_fts triggers', () => {
    beforeEach(() => {
      ensureVectorStorage(client);
    });

    it('insert trigger indexes name + objective + notes', () => {
      client.execute(`INSERT INTO missions (id, name, objective, notes) VALUES (?, ?, ?, ?)`, [
        's99-m01',
        'Synaptic restructuring mission',
        'Reorganize neural pathways',
        'Memo about diagrams',
      ]);

      // Each indexed column should be searchable
      const byName = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM missions_fts WHERE missions_fts MATCH 'synaptic'`,
        []
      );
      const byObjective = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM missions_fts WHERE missions_fts MATCH 'neural'`,
        []
      );
      const byNotes = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM missions_fts WHERE missions_fts MATCH 'diagrams'`,
        []
      );

      expect(byName.data?.length).toBe(1);
      expect(byObjective.data?.length).toBe(1);
      expect(byNotes.data?.length).toBe(1);
    });

    it('insert trigger handles NULL objective/notes via COALESCE', () => {
      const insert = client.execute(
        `INSERT INTO missions (id, name, objective, notes) VALUES (?, ?, NULL, NULL)`,
        ['s99-m02', 'Bare mission with null fields']
      );
      expect(insert.success).toBe(true);

      const fts = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM missions_fts WHERE missions_fts MATCH 'bare'`,
        []
      );
      expect(fts.data?.length).toBe(1);
    });

    it('update trigger reflects changes to indexed columns', () => {
      client.execute(`INSERT INTO missions (id, name, objective, notes) VALUES (?, ?, ?, ?)`, [
        's99-m03',
        'Initial title',
        'Initial objective',
        null,
      ]);

      client.execute(`UPDATE missions SET name = ? WHERE id = ?`, [
        'Renamed mission about platypus',
        's99-m03',
      ]);

      const fts = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM missions_fts WHERE missions_fts MATCH 'platypus'`,
        []
      );
      expect(fts.data?.length).toBe(1);
    });

    it('delete trigger removes the row from the FTS index', () => {
      client.execute(`INSERT INTO missions (id, name) VALUES (?, ?)`, [
        's99-m04',
        'Mission slated for deletion uniqueword',
      ]);
      client.execute(`DELETE FROM missions WHERE id = ?`, ['s99-m04']);

      const fts = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM missions_fts WHERE missions_fts MATCH 'uniqueword'`,
        []
      );
      expect(fts.data?.length).toBe(0);
    });
  });

  describe('vec0 vector storage', () => {
    beforeEach(() => {
      ensureVectorStorage(client);
    });

    it('accepts a 384-dim embedding insert and returns it via MATCH', () => {
      // Seed a decision row to bind to
      const insert = client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
        ['Test decision for vector lookup', new Date().toISOString()]
      );
      // sqlite-vec INTEGER PRIMARY KEY columns reject JS Number binds — pass BigInt.
      // m03's write-path pipeline must apply the same coercion.
      const decisionId = BigInt(insert.data?.lastInsertRowid ?? 0);
      expect(Number(decisionId)).toBeGreaterThan(0);

      const storeVec = client.execute(
        `INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`,
        [decisionId, unitVector(0)]
      );
      expect(storeVec.success).toBe(true);

      // KNN query with a vector close to the stored one
      const results = client.getMany<{ decision_id: number; distance: number }>(
        `SELECT decision_id, distance FROM decisions_vec
         WHERE embedding MATCH ? AND k = 5
         ORDER BY distance`,
        [unitVector(0)]
      );
      expect(results.success).toBe(true);
      expect(results.data?.length).toBe(1);
      expect(results.data?.[0].decision_id).toBe(Number(decisionId));
      // Distance to itself should be ~0 (allow tiny numerical noise)
      expect(results.data?.[0].distance).toBeLessThan(0.001);
    });

    it('returns nearest neighbours in distance order', () => {
      // Three decisions, three orthogonal unit vectors
      const ids: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        const ins = client.execute(
          `INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)`,
          [`Decision ${i}`, new Date().toISOString()]
        );
        ids.push(BigInt(ins.data?.lastInsertRowid ?? 0));
      }
      client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
        ids[0],
        unitVector(0),
      ]);
      client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
        ids[1],
        unitVector(10),
      ]);
      client.execute(`INSERT INTO decisions_vec(decision_id, embedding) VALUES (?, ?)`, [
        ids[2],
        unitVector(200),
      ]);

      // Query closest to vector 0
      const results = client.getMany<{ decision_id: number; distance: number }>(
        `SELECT decision_id, distance FROM decisions_vec
         WHERE embedding MATCH ? AND k = 3
         ORDER BY distance`,
        [unitVector(0)]
      );
      expect(results.success).toBe(true);
      expect(results.data?.length).toBe(3);
      // The first result must be the exact-match row (index 0)
      expect(results.data?.[0].decision_id).toBe(Number(ids[0]));
    });

    it('supports TEXT primary keys on missions_vec', () => {
      client.execute(`INSERT INTO missions (id, name) VALUES (?, ?)`, [
        's99-m99',
        'String-id mission',
      ]);
      const storeVec = client.execute(
        `INSERT INTO missions_vec(mission_id, embedding) VALUES (?, ?)`,
        ['s99-m99', packEmbedding([0.1, 0.2, 0.3])]
      );
      expect(storeVec.success).toBe(true);

      const back = client.getMany<{ mission_id: string }>(
        `SELECT mission_id FROM missions_vec WHERE embedding MATCH ? AND k = 1`,
        [packEmbedding([0.1, 0.2, 0.3])]
      );
      expect(back.success).toBe(true);
      expect(back.data?.length).toBe(1);
      expect(back.data?.[0].mission_id).toBe('s99-m99');
    });
  });

  describe('FTS5 rebuild on first run', () => {
    it('backfills learnings_fts from rows that pre-exist the migration', async () => {
      // Insert into learnings BEFORE running the migration
      const seedDb = new Database(dbPath);
      seedDb.exec(`
        INSERT INTO learnings (content, created_at)
        VALUES ('Pre-existing keyword pomelo', '${new Date().toISOString()}');
      `);
      seedDb.close();

      // Re-open client (the previous handle has its own connection)
      client.close();
      const reopened = await CmosDatabaseClient.create({ dbPath });
      client = reopened.data!;

      ensureVectorStorage(client);

      const fts = client.getMany<{ rowid: number }>(
        `SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'pomelo'`,
        []
      );
      expect(fts.data?.length).toBe(1);
    });
  });
});
