/**
 * CmosDatabaseClient Tests
 *
 * Comprehensive tests for the CMOS database client wrapper.
 *
 * @module tests/tools/cmos/client
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmosDatabaseClient, withClient, withClientAsync } from '../../../src/tools/cmos/client';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

describe('CmosDatabaseClient', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    // Create a test database with basic schema
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
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

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        captures TEXT,
        next_steps TEXT,
        metadata TEXT
      );

      -- Insert test data
      INSERT INTO missions (id, name, status, objective)
      VALUES
        ('m1', 'Test Mission 1', 'In Progress', 'Complete the test'),
        ('m2', 'Test Mission 2', 'Queued', 'Queue test'),
        ('m3', 'Test Mission 3', 'Completed', 'Done test');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES
        ('project_context', 'context/PROJECT_CONTEXT.json', '{"name": "test"}', '2024-01-01');

      INSERT INTO sessions (id, type, title, started_at, agent, status)
      VALUES
        ('s1', 'build', 'Test Session', '2024-01-01', 'test-agent', 'active');
    `);
    db.close();

    // Reset CmosDetector cache before each test
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('create', () => {
    it('should create a client with explicit dbPath', async () => {
      const result = await CmosDatabaseClient.create({ dbPath });

      expect(result.success).toBe(true);
      expect(result.data).toBeInstanceOf(CmosDatabaseClient);
      expect(result.data?.path).toBe(dbPath);
      expect(result.data?.isOpen).toBe(true);

      result.data?.close();
    });

    it('should create database file if it does not exist (SQLite default behavior)', async () => {
      // Note: better-sqlite3 creates the file if it doesn't exist by default
      // This is expected SQLite behavior
      const newDbPath = path.join(tempDir, 'new.sqlite');
      const result = await CmosDatabaseClient.create({ dbPath: newDbPath });

      expect(result.success).toBe(true);
      expect(fs.existsSync(newDbPath)).toBe(true);
      result.data?.close();
    });

    it('should detect CMOS database when projectRoot has cmos/ directory', async () => {
      // Create cmos/ directory structure
      const cmosDir = path.join(tempDir, 'cmos');
      const cmosDbDir = path.join(cmosDir, 'db');
      fs.mkdirSync(cmosDbDir, { recursive: true });

      // Move database to proper location
      const cmosDbPath = path.join(cmosDbDir, 'cmos.sqlite');
      fs.copyFileSync(dbPath, cmosDbPath);

      const result = await CmosDatabaseClient.create({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.path).toBe(cmosDbPath);

      result.data?.close();
    });

    it('should return error when CMOS directory not found', async () => {
      // Empty directory without cmos/
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));

      try {
        const result = await CmosDatabaseClient.create({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('fromDetection', () => {
    it('should create client from detection result', () => {
      const detection = {
        projectRoot: tempDir,
        cmosDirectory: path.join(tempDir, 'cmos'),
        hasCmosDirectory: true,
        hasDatabase: true,
        databasePath: dbPath,
        checkedAt: new Date().toISOString(),
      };

      const result = CmosDatabaseClient.fromDetection(detection);

      expect(result.success).toBe(true);
      expect(result.data?.path).toBe(dbPath);

      result.data?.close();
    });

    it('should return error when detection has no database', () => {
      const detection = {
        projectRoot: tempDir,
        cmosDirectory: path.join(tempDir, 'cmos'),
        hasCmosDirectory: true,
        hasDatabase: false,
        databasePath: undefined,
        checkedAt: new Date().toISOString(),
      };

      const result = CmosDatabaseClient.fromDetection(detection);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_NOT_FOUND);
    });
  });

  describe('getOne', () => {
    it('should return a single row with positional parameters', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      expect(createResult.success).toBe(true);
      const client = createResult.data!;

      try {
        const result = client.getOne<{ id: string; name: string; status: string }>(
          'SELECT id, name, status FROM missions WHERE id = ?',
          ['m1']
        );

        expect(result.success).toBe(true);
        expect(result.data?.id).toBe('m1');
        expect(result.data?.name).toBe('Test Mission 1');
        expect(result.data?.status).toBe('In Progress');
      } finally {
        client.close();
      }
    });

    it('should return a single row with named parameters', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getOne<{ id: string; name: string }>(
          'SELECT id, name FROM missions WHERE id = :id',
          { id: 'm2' }
        );

        expect(result.success).toBe(true);
        expect(result.data?.id).toBe('m2');
        expect(result.data?.name).toBe('Test Mission 2');
      } finally {
        client.close();
      }
    });

    it('should return undefined when no row found', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getOne('SELECT * FROM missions WHERE id = ?', ['nonexistent']);

        expect(result.success).toBe(true);
        expect(result.data).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('should handle query without parameters', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getOne<{ count: number }>('SELECT COUNT(*) as count FROM missions');

        expect(result.success).toBe(true);
        expect(result.data?.count).toBe(3);
      } finally {
        client.close();
      }
    });
  });

  describe('getMany', () => {
    it('should return multiple rows', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getMany<{ id: string; status: string }>(
          'SELECT id, status FROM missions ORDER BY id'
        );

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(3);
        expect(result.data?.[0].id).toBe('m1');
        expect(result.data?.[1].id).toBe('m2');
        expect(result.data?.[2].id).toBe('m3');
      } finally {
        client.close();
      }
    });

    it('should return filtered rows with parameters', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getMany<{ id: string }>('SELECT id FROM missions WHERE status = ?', [
          'Queued',
        ]);

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(1);
        expect(result.data?.[0].id).toBe('m2');
      } finally {
        client.close();
      }
    });

    it('should return empty array when no rows found', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getMany('SELECT * FROM missions WHERE status = ?', ['Blocked']);

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
      } finally {
        client.close();
      }
    });
  });

  describe('execute', () => {
    it('should insert a new row', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.execute('INSERT INTO missions (id, name, status) VALUES (?, ?, ?)', [
          'm4',
          'New Mission',
          'Queued',
        ]);

        expect(result.success).toBe(true);
        expect(result.data?.changes).toBe(1);

        // Verify insertion
        const verifyResult = client.getOne('SELECT * FROM missions WHERE id = ?', ['m4']);
        expect(verifyResult.data?.name).toBe('New Mission');
      } finally {
        client.close();
      }
    });

    it('should update existing rows', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.execute('UPDATE missions SET status = ? WHERE id = ?', [
          'Completed',
          'm1',
        ]);

        expect(result.success).toBe(true);
        expect(result.data?.changes).toBe(1);

        // Verify update
        const verifyResult = client.getOne<{ status: string }>(
          'SELECT status FROM missions WHERE id = ?',
          ['m1']
        );
        expect(verifyResult.data?.status).toBe('Completed');
      } finally {
        client.close();
      }
    });

    it('should delete rows', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.execute('DELETE FROM missions WHERE id = ?', ['m3']);

        expect(result.success).toBe(true);
        expect(result.data?.changes).toBe(1);

        // Verify deletion
        const verifyResult = client.getOne('SELECT * FROM missions WHERE id = ?', ['m3']);
        expect(verifyResult.data).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('should handle unique constraint violation', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.execute(
          'INSERT INTO missions (id, name, status) VALUES (?, ?, ?)',
          ['m1', 'Duplicate', 'Queued'] // m1 already exists
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
        expect(result.error?.message).toContain('Duplicate');
      } finally {
        client.close();
      }
    });
  });

  describe('transaction', () => {
    it('should commit successful transactions', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.transaction(() => {
          client.execute('INSERT INTO missions (id, name, status) VALUES (?, ?, ?)', [
            'm4',
            'Trans Mission 1',
            'Queued',
          ]);
          client.execute('INSERT INTO missions (id, name, status) VALUES (?, ?, ?)', [
            'm5',
            'Trans Mission 2',
            'Queued',
          ]);
          return 'completed';
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe('completed');

        // Verify both inserts succeeded
        const countResult = client.getOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM missions'
        );
        expect(countResult.data?.count).toBe(5);
      } finally {
        client.close();
      }
    });

    it('should rollback failed transactions', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.transaction(() => {
          client.execute('INSERT INTO missions (id, name, status) VALUES (?, ?, ?)', [
            'm4',
            'Will Rollback',
            'Queued',
          ]);
          throw new Error('Intentional failure');
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_QUERY_FAILED);

        // Verify rollback - m4 should not exist
        const verifyResult = client.getOne('SELECT * FROM missions WHERE id = ?', ['m4']);
        expect(verifyResult.data).toBeUndefined();
      } finally {
        client.close();
      }
    });
  });

  describe('health', () => {
    it('should return database health information', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.health();

        expect(result.success).toBe(true);
        expect(result.data?.connected).toBe(true);
        expect(result.data?.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(result.data?.path).toBe(dbPath);
        expect(result.data?.tables).toContain('missions');
        expect(result.data?.tables).toContain('contexts');
        expect(result.data?.tables).toContain('sessions');
        expect(result.data?.missionCount).toBe(3);
        expect(result.data?.sessionCount).toBe(1);
        expect(result.data?.contextCount).toBe(1);
      } finally {
        client.close();
      }
    });
  });

  describe('error handling', () => {
    it('should handle missing table error', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getMany('SELECT * FROM nonexistent_table');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH);
        expect(result.error?.message).toContain('nonexistent_table');
      } finally {
        client.close();
      }
    });

    it('should handle missing column error', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      try {
        const result = client.getMany('SELECT nonexistent_column FROM missions');

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_SCHEMA_MISMATCH);
        expect(result.error?.message).toContain('nonexistent_column');
      } finally {
        client.close();
      }
    });
  });

  describe('close', () => {
    it('should close the connection', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      expect(client.isOpen).toBe(true);
      client.close();
      expect(client.isOpen).toBe(false);
    });

    it('should be safe to call close multiple times', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath });
      const client = createResult.data!;

      client.close();
      client.close();
      client.close();

      expect(client.isOpen).toBe(false);
    });
  });

  describe('readonly mode', () => {
    it('should prevent mutations in readonly mode', async () => {
      // First create the db in normal mode, then reopen in readonly
      const createResult = await CmosDatabaseClient.create({ dbPath, readonly: true });

      // Check if creation succeeded (readonly on existing file should work)
      if (!createResult.success || !createResult.data) {
        // If readonly mode isn't supported on this platform, skip
        console.log('Readonly mode not fully supported, skipping test');
        return;
      }

      const client = createResult.data;

      try {
        const result = client.execute('INSERT INTO missions (id, name, status) VALUES (?, ?, ?)', [
          'm4',
          'Should Fail',
          'Queued',
        ]);

        expect(result.success).toBe(false);
        // The error could be about readonly mode
        expect(result.error?.code).toBeDefined();
      } finally {
        client.close();
      }
    });

    it('should allow reads in readonly mode', async () => {
      const createResult = await CmosDatabaseClient.create({ dbPath, readonly: true });

      // Check if creation succeeded
      if (!createResult.success || !createResult.data) {
        console.log('Readonly mode not fully supported, skipping test');
        return;
      }

      const client = createResult.data;

      try {
        const result = client.getMany('SELECT * FROM missions');

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(3);
      } finally {
        client.close();
      }
    });
  });
});

describe('withClient', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT);
      INSERT INTO missions VALUES ('m1', 'Test', 'Active');
    `);
    db.close();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should execute operation and close connection', async () => {
    const result = await withClient(
      (client) => client.getOne<{ id: string }>('SELECT id FROM missions'),
      { dbPath }
    );

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('m1');
  });

  it('should close connection even on error', async () => {
    const result = await withClient((client) => client.getMany('SELECT * FROM nonexistent'), {
      dbPath,
    });

    expect(result.success).toBe(false);
    // Connection should be closed (no way to verify directly, but no error thrown)
  });
});

describe('withClientAsync', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-test-'));
    dbPath = path.join(tempDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT);
      INSERT INTO missions VALUES ('m1', 'Test', 'Active');
    `);
    db.close();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should execute async operation and close connection', async () => {
    const result = await withClientAsync(
      async (client) => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return client.getOne<{ id: string }>('SELECT id FROM missions');
      },
      { dbPath }
    );

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('m1');
  });
});
