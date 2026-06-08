/**
 * Schema Migrations Tests
 *
 * Tests for the strategic_decisions v2.1 schema evolution:
 * - Adding category, superseded_by, status, evidence columns
 * - Backward-compatible migration of existing databases
 * - Index creation
 * - Default status='active' for existing rows
 *
 * @module tests/tools/cmos/schema-migrations
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import {
  ensureStrategicDecisionsSchema,
  migrateStrategicDecisionsV21,
  ensureRenamedColumn,
  ensureColumnWithCheck,
  SchemaMigrationError,
  DECISION_CATEGORIES,
  DECISION_STATUSES,
} from '../../../src/tools/cmos/schema-migrations';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('schema-migrations', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-schema-migration-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createOldSchemaDb(): Database.Database {
    const db = new Database(dbPath);
    // Disable FK enforcement during test setup for simpler inserts
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('schema_version', '2.0');

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'ctx', '{}');

      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE context_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL,
        session_id TEXT,
        source TEXT,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        source_chunk_ids TEXT
      );

      CREATE INDEX idx_strategic_decisions_created ON strategic_decisions (created_at DESC);
      CREATE INDEX idx_strategic_decisions_sprint ON strategic_decisions (sprint_id);
      CREATE INDEX idx_strategic_decisions_domain ON strategic_decisions (project_domain);
      CREATE INDEX idx_strategic_decisions_session ON strategic_decisions (session_id);
    `);
    return db;
  }

  async function getClient(): Promise<CmosDatabaseClient> {
    const result = await CmosDatabaseClient.create({ dbPath });
    if (!result.success || !result.data) {
      throw new Error(`Failed to create client: ${result.error?.message}`);
    }
    return result.data;
  }

  describe('migrateStrategicDecisionsV21', () => {
    it('should add all new columns to an old schema database', async () => {
      const db = createOldSchemaDb();
      db.close();

      const client = await getClient();
      try {
        const result = migrateStrategicDecisionsV21(client);

        expect(result.columnsAdded).toContain('mission_id');
        expect(result.columnsAdded).toContain('category');
        expect(result.columnsAdded).toContain('superseded_by');
        expect(result.columnsAdded).toContain('status');
        expect(result.columnsAdded).toContain('evidence');
        expect(result.alreadyCurrent).toBe(false);
      } finally {
        client.close();
      }
    });

    it('should create indexes on status, category, and mission_id', async () => {
      const db = createOldSchemaDb();
      db.close();

      const client = await getClient();
      try {
        const result = migrateStrategicDecisionsV21(client);

        expect(result.indexesCreated).toContain('idx_strategic_decisions_status');
        expect(result.indexesCreated).toContain('idx_strategic_decisions_category');
        expect(result.indexesCreated).toContain('idx_strategic_decisions_mission');
      } finally {
        client.close();
      }
    });

    it('should set status=active on existing decisions', async () => {
      const db = createOldSchemaDb();
      db.exec(`
        INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, project_domain)
        VALUES ('Decision 1', '2024-01-01', 'sprint-1', 'general');
        INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, project_domain)
        VALUES ('Decision 2', '2024-01-02', 'sprint-1', 'general');
      `);
      db.close();

      const client = await getClient();
      try {
        const result = migrateStrategicDecisionsV21(client);

        // SQLite ALTER TABLE ADD COLUMN with DEFAULT applies the default
        // automatically, so the UPDATE WHERE NULL may find 0 rows.
        // The important thing is that all rows have status='active'.

        // Verify all rows have status='active'
        const rows = client.getMany<{ status: string }>(
          'SELECT status FROM strategic_decisions',
          []
        );
        expect(rows.success).toBe(true);
        expect(rows.data).toHaveLength(2);
        for (const row of rows.data!) {
          expect(row.status).toBe('active');
        }
      } finally {
        client.close();
      }
    });

    it('should be idempotent (safe to run multiple times)', async () => {
      const db = createOldSchemaDb();
      db.exec(`
        INSERT INTO strategic_decisions (decision_text, created_at, project_domain)
        VALUES ('Decision 1', '2024-01-01', 'general');
      `);
      db.close();

      const client = await getClient();
      try {
        const result1 = migrateStrategicDecisionsV21(client);
        expect(result1.columnsAdded.length).toBeGreaterThan(0);

        const result2 = migrateStrategicDecisionsV21(client);
        expect(result2.alreadyCurrent).toBe(true);
        expect(result2.columnsAdded).toHaveLength(0);
        expect(result2.rowsUpdated).toBe(0);
      } finally {
        client.close();
      }
    });

    it('should update schema version to 2.1', async () => {
      const db = createOldSchemaDb();
      db.close();

      const client = await getClient();
      try {
        migrateStrategicDecisionsV21(client);

        const versionRow = client.getOne<{ value: string }>(
          "SELECT value FROM metadata WHERE key = 'schema_version'",
          []
        );
        expect(versionRow.success).toBe(true);
        expect(versionRow.data?.value).toBe('2.1');
      } finally {
        client.close();
      }
    });

    it('should allow inserting decisions with new fields after migration', async () => {
      const db = createOldSchemaDb();
      db.close();

      const client = await getClient();
      try {
        migrateStrategicDecisionsV21(client);

        const insertResult = client.execute(
          `INSERT INTO strategic_decisions
           (decision_text, created_at, category, status, evidence)
           VALUES (?, ?, ?, ?, ?)`,
          [
            'Use FTS5 for search',
            '2024-02-01',
            'architectural',
            'active',
            JSON.stringify([{ type: 'collection', id: 'col-123' }]),
          ]
        );
        expect(insertResult.success).toBe(true);

        const row = client.getOne<{
          decision_text: string;
          category: string;
          status: string;
          evidence: string;
        }>(
          'SELECT decision_text, category, status, evidence FROM strategic_decisions WHERE id = ?',
          [insertResult.data!.lastInsertRowid]
        );
        expect(row.success).toBe(true);
        expect(row.data?.category).toBe('architectural');
        expect(row.data?.status).toBe('active');
        expect(JSON.parse(row.data!.evidence)).toEqual([{ type: 'collection', id: 'col-123' }]);
      } finally {
        client.close();
      }
    });

    it('should preserve existing data during migration', async () => {
      const db = createOldSchemaDb();
      db.exec(`
        INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, project_domain, session_id)
        VALUES ('Existing decision', '2024-01-01', 'sprint-1', 'general', 'session-1');
      `);
      db.close();

      const client = await getClient();
      try {
        migrateStrategicDecisionsV21(client);

        const row = client.getOne<{
          decision_text: string;
          sprint_id: string;
          project_domain: string;
          session_id: string;
          category: string | null;
          status: string;
        }>(
          'SELECT decision_text, sprint_id, project_domain, session_id, category, status FROM strategic_decisions WHERE id = 1',
          []
        );
        expect(row.success).toBe(true);
        expect(row.data?.decision_text).toBe('Existing decision');
        expect(row.data?.sprint_id).toBe('sprint-1');
        expect(row.data?.project_domain).toBe('general');
        expect(row.data?.session_id).toBe('session-1');
        expect(row.data?.category).toBeNull();
        expect(row.data?.status).toBe('active');
      } finally {
        client.close();
      }
    });
  });

  describe('ensureStrategicDecisionsSchema', () => {
    it('should be an alias for migrateStrategicDecisionsV21', async () => {
      const db = createOldSchemaDb();
      db.close();

      const client = await getClient();
      try {
        const result = ensureStrategicDecisionsSchema(client);
        expect(result.columnsAdded).toContain('category');
        expect(result.columnsAdded).toContain('status');
      } finally {
        client.close();
      }
    });
  });

  describe('ensureDecisionsFts5', () => {
    it('should create FTS5 virtual table and triggers', async () => {
      const db = createOldSchemaDb();
      db.close();

      const { ensureDecisionsFts5 } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        const result = ensureDecisionsFts5(client);
        expect(result.columnsAdded).toContain('decisions_fts (virtual table)');
        expect(result.indexesCreated).toContain('decisions_fts_insert');
        expect(result.indexesCreated).toContain('decisions_fts_delete');
        expect(result.indexesCreated).toContain('decisions_fts_update');
        expect(result.alreadyCurrent).toBe(false);
      } finally {
        client.close();
      }
    });

    it('should be idempotent', async () => {
      const db = createOldSchemaDb();
      db.close();

      const { ensureDecisionsFts5 } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        ensureDecisionsFts5(client);
        const result2 = ensureDecisionsFts5(client);
        expect(result2.alreadyCurrent).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should index existing decisions on rebuild', async () => {
      const db = createOldSchemaDb();
      db.exec(`
        INSERT INTO strategic_decisions (decision_text, created_at, project_domain)
        VALUES ('Use TypeScript for all tools', '2024-01-01', 'general');
        INSERT INTO strategic_decisions (decision_text, created_at, project_domain)
        VALUES ('SQLite is the best local database', '2024-01-02', 'general');
      `);
      db.close();

      const { ensureDecisionsFts5 } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        const result = ensureDecisionsFts5(client);
        expect(result.rowsUpdated).toBe(2);

        // Verify FTS5 search works
        const searchResult = client.getMany<{ rowid: number }>(
          "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'TypeScript'",
          []
        );
        expect(searchResult.success).toBe(true);
        expect(searchResult.data).toHaveLength(1);
      } finally {
        client.close();
      }
    });

    it('should auto-sync new inserts via trigger', async () => {
      const db = createOldSchemaDb();
      db.close();

      const { ensureDecisionsFts5 } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        ensureDecisionsFts5(client);

        // Insert a new decision
        client.execute(
          'INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)',
          ['Use FTS5 for full-text search', '2024-02-01']
        );

        // Search should find it
        const searchResult = client.getMany<{ rowid: number }>(
          "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'FTS5'",
          []
        );
        expect(searchResult.success).toBe(true);
        expect(searchResult.data).toHaveLength(1);
      } finally {
        client.close();
      }
    });
  });

  describe('constants', () => {
    it('should export valid decision categories', () => {
      expect(DECISION_CATEGORIES).toContain('architectural');
      expect(DECISION_CATEGORIES).toContain('process');
      expect(DECISION_CATEGORIES).toContain('tooling');
      expect(DECISION_CATEGORIES).toContain('design');
      expect(DECISION_CATEGORIES).toContain('business');
      expect(DECISION_CATEGORIES).toHaveLength(5);
    });

    it('should export valid decision statuses', () => {
      expect(DECISION_STATUSES).toContain('active');
      expect(DECISION_STATUSES).toContain('superseded');
      expect(DECISION_STATUSES).toContain('archived');
      expect(DECISION_STATUSES).toHaveLength(3);
    });
  });

  describe('ensureLearningsTable', () => {
    it('should create the learnings table', async () => {
      const db = createOldSchemaDb();
      db.close();

      const { ensureLearningsTable } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        const result = ensureLearningsTable(client);
        expect(result.columnsAdded).toContain('learnings (table)');
        expect(result.indexesCreated).toContain('idx_learnings_status');
        expect(result.indexesCreated).toContain('idx_learnings_sprint');
        expect(result.indexesCreated).toContain('idx_learnings_category');
      } finally {
        client.close();
      }
    });

    it('should allow inserting and querying learnings', async () => {
      const db = createOldSchemaDb();
      db.close();

      const { ensureLearningsTable } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        ensureLearningsTable(client);

        const insertResult = client.execute(
          `INSERT INTO learnings (content, category, status, created_at)
           VALUES (?, ?, ?, ?)`,
          ['SQLite FTS5 is fast for full-text search', 'technical', 'active', '2024-01-01']
        );
        expect(insertResult.success).toBe(true);

        const rows = client.getMany<{ content: string; category: string; status: string }>(
          "SELECT content, category, status FROM learnings WHERE status = 'active'",
          []
        );
        expect(rows.success).toBe(true);
        expect(rows.data).toHaveLength(1);
        expect(rows.data![0].content).toBe('SQLite FTS5 is fast for full-text search');
        expect(rows.data![0].category).toBe('technical');
        expect(rows.data![0].status).toBe('active');
      } finally {
        client.close();
      }
    });

    it('should be idempotent', async () => {
      const db = createOldSchemaDb();
      db.close();

      const { ensureLearningsTable } = await import('../../../src/tools/cmos/schema-migrations');

      const client = await getClient();
      try {
        ensureLearningsTable(client);
        // Should not throw on second call
        const result2 = ensureLearningsTable(client);
        expect(result2).toBeDefined();
      } finally {
        client.close();
      }
    });
  });

  describe('LEARNING_CATEGORIES', () => {
    it('should export valid learning categories', async () => {
      const { LEARNING_CATEGORIES } = await import('../../../src/tools/cmos/schema-migrations');
      expect(LEARNING_CATEGORIES).toContain('technical');
      expect(LEARNING_CATEGORIES).toContain('process');
      expect(LEARNING_CATEGORIES).toContain('agent-behavior');
      expect(LEARNING_CATEGORIES).toContain('tooling');
      expect(LEARNING_CATEGORIES).toHaveLength(4);
    });
  });

  describe('new fields in decision queries', () => {
    it('should return new fields from decisions list after migration', async () => {
      const db = createOldSchemaDb();
      db.close();

      const client = await getClient();
      try {
        migrateStrategicDecisionsV21(client);

        // Insert a decision with new fields
        client.execute(
          `INSERT INTO strategic_decisions
           (decision_text, created_at, category, status, evidence, project_domain)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            'Use action parameters',
            '2024-03-01',
            'architectural',
            'active',
            JSON.stringify([{ type: 'report', id: 'rpt-1' }]),
            'general',
          ]
        );

        // Use the decision memory loader to verify fields come through
        const { loadUnifiedDecisionRecords } =
          await import('../../../src/tools/cmos/decision-memory');
        const records = loadUnifiedDecisionRecords(client);

        expect(records).toHaveLength(1);
        expect(records[0].category).toBe('architectural');
        expect(records[0].status).toBe('active');
        expect(records[0].evidence).toBe(JSON.stringify([{ type: 'report', id: 'rpt-1' }]));
        expect(records[0].supersededBy).toBeNull();
      } finally {
        client.close();
      }
    });
  });

  // ── Sprint 69 m02 — snapshot-restore-safe rename + checked-column helpers ──
  describe('ensureRenamedColumn (Sprint 69 m02)', () => {
    function createRenameFixture(opts: { old: boolean; renamed: boolean }): void {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'decision_text TEXT NOT NULL'];
      if (opts.old) cols.push('session_id TEXT');
      if (opts.renamed) cols.push('author_session_id TEXT');
      db.exec(
        `CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n` +
          `CREATE TABLE strategic_decisions (${cols.join(', ')});`
      );
      db.close();
    }

    it('renames the column when old is present and new is absent', async () => {
      createRenameFixture({ old: true, renamed: false });
      const client = await getClient();
      try {
        const result = ensureRenamedColumn(
          client,
          'strategic_decisions',
          'session_id',
          'author_session_id'
        );
        expect(result.columnsAdded).toEqual(['author_session_id']);
        expect(result.alreadyCurrent).toBe(false);
        const cols = client.getMany<{ name: string }>(
          "PRAGMA table_info('strategic_decisions')",
          []
        );
        const names = cols.data!.map((c) => c.name);
        expect(names).toContain('author_session_id');
        expect(names).not.toContain('session_id');
      } finally {
        client.close();
      }
    });

    it('is a no-op when already renamed (old absent, new present)', async () => {
      createRenameFixture({ old: false, renamed: true });
      const client = await getClient();
      try {
        const result = ensureRenamedColumn(
          client,
          'strategic_decisions',
          'session_id',
          'author_session_id'
        );
        expect(result.alreadyCurrent).toBe(true);
        expect(result.columnsAdded).toEqual([]);
      } finally {
        client.close();
      }
    });

    it('adds the new column when neither exists and addColumnDef is given', async () => {
      createRenameFixture({ old: false, renamed: false });
      const client = await getClient();
      try {
        const result = ensureRenamedColumn(
          client,
          'strategic_decisions',
          'session_id',
          'author_session_id',
          'TEXT'
        );
        expect(result.columnsAdded).toEqual(['author_session_id']);
        const cols = client.getMany<{ name: string }>(
          "PRAGMA table_info('strategic_decisions')",
          []
        );
        expect(cols.data!.map((c) => c.name)).toContain('author_session_id');
      } finally {
        client.close();
      }
    });

    it('throws when neither exists and no addColumnDef is provided', async () => {
      createRenameFixture({ old: false, renamed: false });
      const client = await getClient();
      try {
        expect(() =>
          ensureRenamedColumn(client, 'strategic_decisions', 'session_id', 'author_session_id')
        ).toThrow(SchemaMigrationError);
      } finally {
        client.close();
      }
    });

    it('FAILS LOUDLY when BOTH old and new columns exist (snapshot over partial migration)', async () => {
      createRenameFixture({ old: true, renamed: true });
      const client = await getClient();
      try {
        expect(() =>
          ensureRenamedColumn(client, 'strategic_decisions', 'session_id', 'author_session_id')
        ).toThrow(/has BOTH "session_id" and "author_session_id"/);
      } finally {
        client.close();
      }
    });

    it('is idempotent across repeated calls', async () => {
      createRenameFixture({ old: true, renamed: false });
      const client = await getClient();
      try {
        const first = ensureRenamedColumn(
          client,
          'strategic_decisions',
          'session_id',
          'author_session_id'
        );
        expect(first.alreadyCurrent).toBe(false);
        const second = ensureRenamedColumn(
          client,
          'strategic_decisions',
          'session_id',
          'author_session_id'
        );
        expect(second.alreadyCurrent).toBe(true);
      } finally {
        client.close();
      }
    });
  });

  describe('ensureColumnWithCheck (Sprint 69 m02)', () => {
    // Build a DB shaped like the real firehose tables: strategic_decisions +
    // learnings each with their FTS5 content table + triggers + extra indexes,
    // plus a parent/child pair to exercise FK + multi-index preservation.
    function createCheckFixture(): void {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        CREATE TABLE strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE INDEX idx_sd_status ON strategic_decisions (status);
        CREATE INDEX idx_sd_created ON strategic_decisions (created_at DESC);
        CREATE VIRTUAL TABLE decisions_fts USING fts5(
          decision_text, content='strategic_decisions', content_rowid='id'
        );
        CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
          INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
        END;
        CREATE TRIGGER decisions_fts_delete AFTER DELETE ON strategic_decisions BEGIN
          INSERT INTO decisions_fts(decisions_fts, rowid, decision_text) VALUES('delete', old.id, old.decision_text);
        END;
        CREATE TRIGGER decisions_fts_update AFTER UPDATE OF decision_text ON strategic_decisions BEGIN
          INSERT INTO decisions_fts(decisions_fts, rowid, decision_text) VALUES('delete', old.id, old.decision_text);
          INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
        END;

        CREATE TABLE learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE learnings_fts USING fts5(
          content, content='learnings', content_rowid='id'
        );
        CREATE TRIGGER learnings_fts_insert AFTER INSERT ON learnings BEGIN
          INSERT INTO learnings_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE missions (
          id TEXT PRIMARY KEY,
          sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
          name TEXT NOT NULL
        );
        CREATE INDEX idx_missions_sprint ON missions (sprint_id);

        INSERT INTO strategic_decisions (decision_text, created_at) VALUES
          ('Adopt TypeScript across all tools', '2024-01-01'),
          ('SQLite is the source of truth', '2024-01-02');
        INSERT INTO learnings (content, created_at) VALUES
          ('FTS5 triggers must survive table rebuilds', '2024-01-03');
        INSERT INTO sprints (id, title) VALUES ('sprint-1', 'First sprint');
        INSERT INTO missions (id, sprint_id, name) VALUES ('s1-m01', 'sprint-1', 'Do the thing');
      `);
      // Rebuild FTS indexes from the seeded rows.
      db.exec("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')");
      db.exec("INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild')");
      db.close();
    }

    it('adds NOT NULL + CHECK event_type, backfills, and preserves data', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        const result = ensureColumnWithCheck(
          client,
          'strategic_decisions',
          'event_type',
          'TEXT',
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
          "event_type IN ('decision_captured')"
        );
        expect(result.columnsAdded).toEqual(['event_type']);
        expect(result.rowsUpdated).toBe(2);

        // Data preserved, column backfilled.
        const rows = client.getMany<{ decision_text: string; event_type: string }>(
          'SELECT decision_text, event_type FROM strategic_decisions ORDER BY id',
          []
        );
        expect(rows.data).toHaveLength(2);
        expect(rows.data!.every((r) => r.event_type === 'decision_captured')).toBe(true);
        expect(rows.data![0].decision_text).toBe('Adopt TypeScript across all tools');

        // CHECK is recorded in the DDL.
        const ddl = client.getOne<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='strategic_decisions'",
          []
        );
        expect(ddl.data!.sql).toContain("CHECK (event_type IN ('decision_captured'))");
      } finally {
        client.close();
      }
    });

    it('enforces NOT NULL and CHECK on new inserts after the rebuild', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        ensureColumnWithCheck(
          client,
          'strategic_decisions',
          'event_type',
          'TEXT',
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
          "event_type IN ('decision_captured')"
        );
        // Valid insert succeeds.
        const ok = client.execute(
          "INSERT INTO strategic_decisions (decision_text, created_at, event_type) VALUES ('ok', '2024-02-01', 'decision_captured')",
          []
        );
        expect(ok.success).toBe(true);
        // CHECK violation (wrong verb) fails.
        const badValue = client.execute(
          "INSERT INTO strategic_decisions (decision_text, created_at, event_type) VALUES ('bad', '2024-02-02', 'mission_added')",
          []
        );
        expect(badValue.success).toBe(false);
        // NOT NULL violation (no DEFAULT) fails.
        const missing = client.execute(
          "INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('missing', '2024-02-03')",
          []
        );
        expect(missing.success).toBe(false);
      } finally {
        client.close();
      }
    });

    it('preserves BOTH decisions_fts AND learnings_fts through the rebuild', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        ensureColumnWithCheck(
          client,
          'strategic_decisions',
          'event_type',
          'TEXT',
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
          "event_type IN ('decision_captured')"
        );
        // decisions_fts (on the rebuilt table) still searches existing rows...
        const dHit = client.getMany<{ rowid: number }>(
          "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'TypeScript'",
          []
        );
        expect(dHit.data).toHaveLength(1);
        // ...and its triggers still fire for new rows.
        client.execute(
          "INSERT INTO strategic_decisions (decision_text, created_at, event_type) VALUES ('Postgres dashboard broker', '2024-02-04', 'decision_captured')",
          []
        );
        const dNew = client.getMany<{ rowid: number }>(
          "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'Postgres'",
          []
        );
        expect(dNew.data).toHaveLength(1);
        // learnings_fts (a sibling FTS on an untouched table) is unaffected.
        const lHit = client.getMany<{ rowid: number }>(
          "SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'rebuilds'",
          []
        );
        expect(lHit.data).toHaveLength(1);
      } finally {
        client.close();
      }
    });

    it("rebuilds the table's OWN FTS (learnings_fts) when learnings is the rebuilt table", async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        ensureColumnWithCheck(
          client,
          'learnings',
          'event_type',
          'TEXT',
          "UPDATE learnings SET event_type = 'learning_captured' WHERE event_type IS NULL",
          "event_type IN ('learning_captured')"
        );
        const hit = client.getMany<{ rowid: number }>(
          "SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'triggers'",
          []
        );
        expect(hit.data).toHaveLength(1);
      } finally {
        client.close();
      }
    });

    it('preserves all non-FTS indexes and foreign keys through the rebuild', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        ensureColumnWithCheck(
          client,
          'missions',
          'event_type',
          'TEXT',
          "UPDATE missions SET event_type = 'mission_added' WHERE event_type IS NULL",
          "event_type IN ('mission_added')"
        );
        // Index survives.
        const idx = client.getOne<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_missions_sprint'",
          []
        );
        expect(idx.data?.name).toBe('idx_missions_sprint');
        // FK still enforced: a bad sprint_id is rejected.
        const badFk = client.execute(
          "INSERT INTO missions (id, sprint_id, name, event_type) VALUES ('s1-m99', 'no-such-sprint', 'x', 'mission_added')",
          []
        );
        expect(badFk.success).toBe(false);
        // Data preserved.
        const row = client.getOne<{ name: string; sprint_id: string }>(
          "SELECT name, sprint_id FROM missions WHERE id='s1-m01'",
          []
        );
        expect(row.data?.name).toBe('Do the thing');
        expect(row.data?.sprint_id).toBe('sprint-1');
      } finally {
        client.close();
      }
    });

    it('FAILS at the verify step when backfill leaves NULLs (not at the rebuild)', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        // Backfill that matches NOTHING leaves both rows NULL → must fail at step 3.
        expect(() =>
          ensureColumnWithCheck(
            client,
            'strategic_decisions',
            'event_type',
            'TEXT',
            "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE 1 = 0",
            "event_type IN ('decision_captured')"
          )
        ).toThrow(/still have NULL "event_type" after backfill/);
        // The table must be untouched (no CHECK added, column nullable add only).
        const ddl = client.getOne<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='strategic_decisions'",
          []
        );
        expect(ddl.data!.sql).not.toContain('CHECK');
      } finally {
        client.close();
      }
    });

    it('rolls back the rebuild when a legacy row violates the CHECK', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        // Seed a non-null but INVALID value so step-3 NULL check passes but the
        // step-4 copy hits the CHECK and must roll the whole rebuild back.
        const seed = await getClient();
        seed.raw('ALTER TABLE strategic_decisions ADD COLUMN event_type TEXT');
        seed.execute("UPDATE strategic_decisions SET event_type = 'WRONG' WHERE id = 1", []);
        seed.execute(
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE id = 2",
          []
        );
        seed.close();

        expect(() =>
          ensureColumnWithCheck(
            client,
            'strategic_decisions',
            'event_type',
            'TEXT',
            "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
            "event_type IN ('decision_captured')"
          )
        ).toThrow(SchemaMigrationError);

        // Rolled back: original table intact, no leftover temp table, FK on.
        const tmp = client.getOne<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name='strategic_decisions__mig_tmp'",
          []
        );
        expect(tmp.data).toBeUndefined();
        const count = client.getOne<{ c: number }>(
          'SELECT COUNT(*) AS c FROM strategic_decisions',
          []
        );
        expect(count.data?.c).toBe(2);
        const fk = client.getOne<{ foreign_keys: number }>('PRAGMA foreign_keys', []);
        expect(fk.data?.foreign_keys).toBe(1);
      } finally {
        client.close();
      }
    });

    it('is idempotent: a second call is a no-op', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        const first = ensureColumnWithCheck(
          client,
          'strategic_decisions',
          'event_type',
          'TEXT',
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
          "event_type IN ('decision_captured')"
        );
        expect(first.alreadyCurrent).toBe(false);
        const second = ensureColumnWithCheck(
          client,
          'strategic_decisions',
          'event_type',
          'TEXT',
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
          "event_type IN ('decision_captured')"
        );
        expect(second.alreadyCurrent).toBe(true);
        expect(second.columnsAdded).toEqual([]);
      } finally {
        client.close();
      }
    });

    it('rebuilds a PARENT table referenced by a child FK without breaking referential integrity', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        // sprints is the parent of missions(sprint_id). Dropping/recreating a
        // referenced table is exactly what the foreign_keys=OFF window protects.
        ensureColumnWithCheck(
          client,
          'sprints',
          'event_type',
          'TEXT',
          "UPDATE sprints SET event_type = 'sprint_added' WHERE event_type IS NULL",
          "event_type IN ('sprint_added')"
        );
        // Parent rows preserved.
        const sprint = client.getOne<{ title: string; event_type: string }>(
          "SELECT title, event_type FROM sprints WHERE id='sprint-1'",
          []
        );
        expect(sprint.data?.title).toBe('First sprint');
        expect(sprint.data?.event_type).toBe('sprint_added');
        // Existing child still resolves its FK, and a bad FK is still rejected.
        const child = client.getOne<{ sprint_id: string }>(
          "SELECT sprint_id FROM missions WHERE id='s1-m01'",
          []
        );
        expect(child.data?.sprint_id).toBe('sprint-1');
        const badFk = client.execute(
          "INSERT INTO missions (id, sprint_id, name) VALUES ('s1-m98', 'ghost-sprint', 'x')",
          []
        );
        expect(badFk.success).toBe(false);
      } finally {
        client.close();
      }
    });

    it('does not corrupt cached prepared statements across the DROP/RENAME', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        // Warm the statement cache with queries against the pre-rebuild table.
        const before = client.getMany<{ id: number; decision_text: string }>(
          'SELECT id, decision_text FROM strategic_decisions ORDER BY id',
          []
        );
        expect(before.data).toHaveLength(2);
        client.getMany('SELECT * FROM strategic_decisions ORDER BY id', []);

        ensureColumnWithCheck(
          client,
          'strategic_decisions',
          'event_type',
          'TEXT',
          "UPDATE strategic_decisions SET event_type = 'decision_captured' WHERE event_type IS NULL",
          "event_type IN ('decision_captured')"
        );

        // Re-run the SAME (cached) SQL strings: prepare_v2 must recompile against
        // the rebuilt table and return correct data, never silently-wrong rows.
        const after = client.getMany<{ id: number; decision_text: string }>(
          'SELECT id, decision_text FROM strategic_decisions ORDER BY id',
          []
        );
        expect(after.data).toHaveLength(2);
        expect(after.data!.map((r) => r.decision_text)).toEqual(
          before.data!.map((r) => r.decision_text)
        );
        // The cached `SELECT *` now transparently includes the new column.
        const star = client.getMany<{ event_type: string }>(
          'SELECT * FROM strategic_decisions ORDER BY id',
          []
        );
        expect(star.data!.every((r) => r.event_type === 'decision_captured')).toBe(true);
      } finally {
        client.close();
      }
    });

    it('refuses to constrain a column that already carries modifiers (bare-column guard)', async () => {
      createCheckFixture();
      const client = await getClient();
      try {
        // status is `status TEXT NOT NULL DEFAULT 'active'` — not a bare column.
        expect(() =>
          ensureColumnWithCheck(
            client,
            'strategic_decisions',
            'status',
            'TEXT',
            "UPDATE strategic_decisions SET status = 'active' WHERE status IS NULL",
            "status IN ('active','superseded','archived')"
          )
        ).toThrow(/only applied to columns added bare/);
      } finally {
        client.close();
      }
    });
  });
});
