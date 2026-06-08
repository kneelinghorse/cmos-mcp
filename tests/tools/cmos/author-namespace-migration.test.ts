/**
 * Sprint 69 m04 — author_* namespace migration tests.
 *
 * Covers ensureAuthorNamespaceColumns against: a populated LEGACY store (the two
 * renamed tables carry session_id + FK ON DELETE SET NULL + decisions_fts/
 * learnings_fts + the legacy idx_strategic_decisions_session), a GREENFIELD store
 * (fresh CMOS_SCHEMA already ships author_session_id/author_user_id/user_id), the
 * idempotent + marker-recovery re-runs, and the snapshot-restore both-present
 * guard (fail loud). Asserts the rename preserves values + FK semantics, that the
 * FTS5 triggers survive, and that author_user_id lands nullable on all 8 firehose
 * tables (+ user_id on sessions).
 *
 * @module tests/tools/cmos/author-namespace-migration
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  ensureAuthorNamespaceColumns,
  ensureArchivalColumns,
  ensureLearningsTable,
  SchemaMigrationError,
  AUTHOR_NAMESPACE_SCHEMA_VERSION,
} from '../../../src/tools/cmos/schema-migrations';
import { FIREHOSE_TABLES } from '../../../src/types/event-types';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { createSeededCmosProject } from '../../helpers/seedCmosDb';

describe('ensureAuthorNamespaceColumns (Sprint 69 m04)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'author-ns-mig-test-'));
    const dbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a populated LEGACY store: the two renamed tables carry `session_id`
   * (FK → sessions ON DELETE SET NULL), the strategic_decisions self-FK, the
   * legacy idx_strategic_decisions_session, decisions_fts + learnings_fts, plus
   * the other firehose tables (without author_user_id) and a few rows.
   */
  function createLegacyDb(opts: { bothPresent?: boolean } = {}): void {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    // strategic_decisions carries author_session_id ALONGSIDE session_id only for
    // the snapshot-restore-over-partial-migration test (the both-present guard).
    const sdAuthorCol = opts.bothPresent ? 'author_session_id TEXT,' : '';
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'legacy-proj'), ('schema_version', '2.4');

      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'ctx', '{}');

      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT, start_date TEXT);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE context_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT, content_hash TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE);
      CREATE TABLE next_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, sprint_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', session_id TEXT, sprint_id TEXT, created_at TEXT NOT NULL);

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        ${sdAuthorCol}
        session_id TEXT,
        mission_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
        FOREIGN KEY (superseded_by) REFERENCES strategic_decisions(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_strategic_decisions_session ON strategic_decisions (session_id);
      CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text, content='strategic_decisions', content_rowid='id');
      CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
        INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
      END;

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );
      CREATE VIRTUAL TABLE learnings_fts USING fts5(content, content='learnings', content_rowid='id');
      CREATE TRIGGER learnings_fts_insert AFTER INSERT ON learnings BEGIN
        INSERT INTO learnings_fts(rowid, content) VALUES (new.id, new.content);
      END;

      INSERT INTO sessions (id, type, title, started_at) VALUES ('sess1', 'build', 'Build session', '2024-01-03');
      INSERT INTO strategic_decisions (decision_text, created_at, session_id) VALUES ('Adopt TypeScript everywhere', '2024-01-04', 'sess1'), ('SQLite is the source of truth', '2024-01-05', NULL);
      UPDATE strategic_decisions SET superseded_by = 1 WHERE id = 2;
      INSERT INTO learnings (content, category, session_id, created_at) VALUES ('FTS triggers must survive renames', 'technical', 'sess1', '2024-01-06');

      INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');
      INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild');
    `);
    db.close();
  }

  async function getClient(): Promise<CmosDatabaseClient> {
    const result = await CmosDatabaseClient.create({ dbPath });
    if (!result.success || !result.data) throw new Error(`client: ${result.error?.message}`);
    return result.data;
  }

  function columnNames(client: CmosDatabaseClient, table: string): string[] {
    return client
      .getMany<{ name: string }>(`PRAGMA table_info('${table}')`, [])
      .data!.map((c) => c.name);
  }

  function indexExists(client: CmosDatabaseClient, name: string): boolean {
    const r = client.getOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
      [name]
    );
    return r.success && !!r.data;
  }

  it('renames session_id → author_session_id on a populated LEGACY store, preserving values', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      const result = ensureAuthorNamespaceColumns(client);
      expect(result.alreadyCurrent).toBe(false);

      for (const table of ['strategic_decisions', 'learnings']) {
        const cols = columnNames(client, table);
        expect(cols).toContain('author_session_id');
        expect(cols).not.toContain('session_id');
      }

      // Values are preserved through the in-place RENAME COLUMN.
      const sd = client.getOne<{ author_session_id: string | null }>(
        'SELECT author_session_id FROM strategic_decisions WHERE id = 1',
        []
      ).data!;
      expect(sd.author_session_id).toBe('sess1');
      const learning = client.getOne<{ author_session_id: string | null }>(
        'SELECT author_session_id FROM learnings WHERE id = 1',
        []
      ).data!;
      expect(learning.author_session_id).toBe('sess1');
    } finally {
      client.close();
    }
  });

  it('renames the supporting index and lands idx_learnings_author_session net-new', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      expect(indexExists(client, 'idx_strategic_decisions_session')).toBe(true);
      ensureAuthorNamespaceColumns(client);
      expect(indexExists(client, 'idx_strategic_decisions_session')).toBe(false);
      expect(indexExists(client, 'idx_strategic_decisions_author_session')).toBe(true);
      expect(indexExists(client, 'idx_learnings_author_session')).toBe(true);
    } finally {
      client.close();
    }
  });

  it('adds author_user_id (nullable) to all 8 firehose tables + user_id on sessions', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      ensureAuthorNamespaceColumns(client);
      for (const table of FIREHOSE_TABLES) {
        const cols = client.getMany<{ name: string; notnull: number }>(
          `PRAGMA table_info('${table}')`,
          []
        ).data!;
        const authorCol = cols.find((c) => c.name === 'author_user_id');
        expect(authorCol).toBeDefined();
        expect(authorCol!.notnull).toBe(0); // nullable — identity binding is a later sprint
      }
      const sessionCols = client.getMany<{ name: string; notnull: number }>(
        "PRAGMA table_info('sessions')",
        []
      ).data!;
      const userId = sessionCols.find((c) => c.name === 'user_id');
      expect(userId).toBeDefined();
      expect(userId!.notnull).toBe(0);
    } finally {
      client.close();
    }
  });

  it('preserves the FK ON DELETE SET NULL semantics on the renamed author_session_id', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      ensureAuthorNamespaceColumns(client);

      // The FK clause now names author_session_id and still points at sessions(id).
      const fks = client.getMany<{ from: string; table: string; to: string; on_delete: string }>(
        'PRAGMA foreign_key_list(strategic_decisions)',
        []
      ).data!;
      const sessionFk = fks.find((f) => f.from === 'author_session_id');
      expect(sessionFk).toBeDefined();
      expect(sessionFk!.table).toBe('sessions');
      expect(sessionFk!.on_delete.toUpperCase()).toBe('SET NULL');

      // Deleting the referenced session nulls the child column (ON DELETE SET NULL).
      client.pragma('foreign_keys = ON');
      const del = client.execute("DELETE FROM sessions WHERE id = 'sess1'", []);
      expect(del.success).toBe(true);
      const orphaned = client.getOne<{ author_session_id: string | null }>(
        'SELECT author_session_id FROM strategic_decisions WHERE id = 1',
        []
      ).data!;
      expect(orphaned.author_session_id).toBeNull();
    } finally {
      client.close();
    }
  });

  it('keeps BOTH decisions_fts AND learnings_fts queryable + the self-FK after the rename', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      ensureAuthorNamespaceColumns(client);
      const dHit = client.getMany(
        "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'TypeScript'",
        []
      );
      expect(dHit.data).toHaveLength(1);
      const lHit = client.getMany(
        "SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'renames'",
        []
      );
      expect(lHit.data).toHaveLength(1);
      // The decisions self-FK is untouched by a column rename (no table rebuild).
      const selfFk = client.getMany<{ table: string }>(
        'PRAGMA foreign_key_list(strategic_decisions)',
        []
      ).data!;
      expect(selfFk.some((f) => f.table === 'strategic_decisions')).toBe(true);

      // The FTS insert trigger still fires after the rename (write-through proof).
      const g = client.execute(
        "INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Postgres mirror is canonical', '2024-02-01')",
        []
      );
      expect(g.success).toBe(true);
      const newHit = client.getMany(
        "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'Postgres'",
        []
      );
      expect(newHit.data).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it('is idempotent (marker fast-path) and recovers from a cleared marker', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      const first = ensureAuthorNamespaceColumns(client);
      expect(first.alreadyCurrent).toBe(false);
      const second = ensureAuthorNamespaceColumns(client);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.columnsAdded).toEqual([]);

      // Clear the completion marker → next run re-scans, finds everything already
      // migrated, and re-sets the marker without resurrecting session_id.
      client.execute("DELETE FROM metadata WHERE key='author_namespace_columns'", []);
      const third = ensureAuthorNamespaceColumns(client);
      expect(third.alreadyCurrent).toBe(true);
      expect(columnNames(client, 'strategic_decisions')).not.toContain('session_id');
      const marker = client.getOne<{ value: string }>(
        "SELECT value FROM metadata WHERE key='author_namespace_columns'",
        []
      );
      expect(marker.data?.value).toBe(AUTHOR_NAMESPACE_SCHEMA_VERSION);
    } finally {
      client.close();
    }
  });

  it('FAILS LOUDLY when a snapshot-restore left BOTH session_id and author_session_id', async () => {
    createLegacyDb({ bothPresent: true });
    const client = await getClient();
    try {
      const cols = columnNames(client, 'strategic_decisions');
      expect(cols).toContain('session_id');
      expect(cols).toContain('author_session_id');
      expect(() => ensureAuthorNamespaceColumns(client)).toThrow(SchemaMigrationError);
      expect(() => ensureAuthorNamespaceColumns(client)).toThrow(
        /has BOTH "session_id" and "author_session_id"/
      );
    } finally {
      client.close();
    }
  });

  it('is a no-op on a GREENFIELD store (fresh schema already ships the author_* namespace)', async () => {
    const project = await createSeededCmosProject({ projectName: 'green' }, 'author-ns-green-');
    try {
      const client = (await CmosDatabaseClient.create({ dbPath: project.dbPath })).data!;
      try {
        // Fresh schema.ts ships the renamed column + the author identity columns.
        for (const table of ['strategic_decisions', 'learnings']) {
          const cols = columnNames(client, table);
          expect(cols).toContain('author_session_id');
          expect(cols).not.toContain('session_id');
          expect(cols).toContain('author_user_id');
        }
        expect(columnNames(client, 'sessions')).toEqual(
          expect.arrayContaining(['author_user_id', 'user_id'])
        );
        expect(indexExists(client, 'idx_strategic_decisions_author_session')).toBe(true);
        expect(indexExists(client, 'idx_learnings_author_session')).toBe(true);

        // Nothing to migrate — the columns/indexes are already present.
        const result = ensureAuthorNamespaceColumns(client);
        expect(result.alreadyCurrent).toBe(true);
        expect(result.columnsAdded).toEqual([]);
      } finally {
        client.close();
      }
    } finally {
      await project.cleanup();
    }
  });

  it('ensureArchivalColumns is rename-aware: never resurrects session_id post-rename', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      ensureAuthorNamespaceColumns(client);
      // Post-rename, ensureArchivalColumns must NOT re-add session_id (which would
      // create the both-present state that the rename guard rejects).
      const res = ensureArchivalColumns(client);
      expect(res.alreadyCurrent).toBe(true);
      const cols = columnNames(client, 'strategic_decisions');
      expect(cols).not.toContain('session_id');
      expect(cols).toContain('author_session_id');
      // And a subsequent rename run stays a clean no-op (no both-present throw).
      expect(() => ensureAuthorNamespaceColumns(client)).not.toThrow();
    } finally {
      client.close();
    }
  });

  it('ensureLearningsTable creates the table canonical even after the marker was set with learnings absent', async () => {
    // Regression (workflow-found): the marker is set even when `learnings` is
    // absent at migration time (a store that recorded sessions/decisions but no
    // learnings). If ensureLearningsTable then created the table with the legacy
    // session_id, the marker-gated rename would never fire and the
    // author_session_id-hardcoded write path would crash on first learning capture.
    const db = new Database(dbPath);
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'no-learnings-proj');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, decision_text TEXT NOT NULL, created_at TEXT NOT NULL, session_id TEXT);
    `);
    db.close();

    const client = await getClient();
    try {
      // Migration runs while `learnings` does NOT exist → it sets the marker.
      ensureAuthorNamespaceColumns(client);
      const marker = client.getOne<{ value: string }>(
        "SELECT value FROM metadata WHERE key='author_namespace_columns'",
        []
      );
      expect(marker.data?.value).toBe(AUTHOR_NAMESPACE_SCHEMA_VERSION);

      // First learning capture creates the table — it MUST be canonical despite the
      // marker already being set (so the hardcoded author_session_id write works).
      ensureLearningsTable(client);
      const cols = columnNames(client, 'learnings');
      expect(cols).toContain('author_session_id');
      expect(cols).not.toContain('session_id');

      // The author_session_id-hardcoded write path (cmos_session_capture) must not crash.
      const ins = client.execute(
        "INSERT INTO learnings (content, status, author_session_id, created_at) VALUES ('x', 'active', 'sess1', '2024-01-01')",
        []
      );
      expect(ins.success).toBe(true);
      const dedup = client.getOne(
        'SELECT id FROM learnings WHERE content = ? AND author_session_id = ?',
        ['x', 'sess1']
      );
      expect(dedup.success).toBe(true);
      expect(indexExists(client, 'idx_learnings_author_session')).toBe(true);
    } finally {
      client.close();
    }
  });
});
