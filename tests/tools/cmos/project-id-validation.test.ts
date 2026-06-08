/**
 * Project ID Validation Tests
 *
 * Tests for database self-protection via project_id in metadata.
 * When a database has project_id set, CMOS_PROJECT_ID env var MUST match.
 *
 * @module tests/tools/cmos/project-id-validation
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CmosDatabaseClient,
  withClientValidated,
  CMOS_PROJECT_ID_ENV,
  CMOS_PROJECT_ROOT_ENV,
  CMOS_ERROR_CODES,
} from '../../../src/tools/cmos';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../../src/intelligence/project-registry';

describe('Project ID Validation', () => {
  let tempDir: string;
  let dbPath: string;
  const originalEnv = process.env[CMOS_PROJECT_ID_ENV];
  const originalProjectRootEnv = process.env[CMOS_PROJECT_ROOT_ENV];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-project-id-test-'));
    const cmosDir = path.join(tempDir, 'cmos');
    const dbDir = path.join(cmosDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'cmos.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project-123');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    `);
    db.close();

    CmosDetector.resetInstance();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env[CMOS_PROJECT_ID_ENV] = originalEnv;
    } else {
      delete process.env[CMOS_PROJECT_ID_ENV];
    }

    if (originalProjectRootEnv !== undefined) {
      process.env[CMOS_PROJECT_ROOT_ENV] = originalProjectRootEnv;
    } else {
      delete process.env[CMOS_PROJECT_ROOT_ENV];
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    ProjectRegistry.resetInstance();
  });

  describe('CmosDatabaseClient.validateProjectId', () => {
    it('should pass when env var matches database project_id', async () => {
      process.env[CMOS_PROJECT_ID_ENV] = 'test-project-123';

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should fail when env var does not match database project_id', async () => {
      process.env[CMOS_PROJECT_ID_ENV] = 'wrong-project-id';

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.PROJECT_ID_MISMATCH);
        expect(result.error?.message).toContain('wrong-project-id');
        expect(result.error?.message).toContain('test-project-123');
      } finally {
        client.close();
      }
    });

    it('should fail when database has project_id but env var is not set (self-protection)', async () => {
      delete process.env[CMOS_PROJECT_ID_ENV];

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.PROJECT_ID_MISMATCH);
        expect(result.error?.message).toContain('requires project ID validation');
        expect(result.error?.suggestion).toContain('CMOS_PROJECT_ID="test-project-123"');
      } finally {
        client.close();
      }
    });

    it('should pass when database has empty project_id (no protection)', async () => {
      // Update database to have empty project_id
      const db = new Database(dbPath);
      db.exec("UPDATE metadata SET value = '' WHERE key = 'project_id'");
      db.close();

      delete process.env[CMOS_PROJECT_ID_ENV];

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should pass when database has no project_id row (backward compatible)', async () => {
      // Remove project_id from metadata
      const db = new Database(dbPath);
      db.exec("DELETE FROM metadata WHERE key = 'project_id'");
      db.close();

      delete process.env[CMOS_PROJECT_ID_ENV];

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        const result = client.validateProjectId();

        expect(result.success).toBe(true);
      } finally {
        client.close();
      }
    });

    it('should pass when metadata table does not exist (old database, backward compatible)', async () => {
      // Create database without metadata table
      const noMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-nometa-'));
      const noMetaCmosDir = path.join(noMetaDir, 'cmos');
      const noMetaDbDir = path.join(noMetaCmosDir, 'db');
      fs.mkdirSync(noMetaDbDir, { recursive: true });
      const noMetaDbPath = path.join(noMetaDbDir, 'cmos.sqlite');

      const db = new Database(noMetaDbPath);
      db.exec(`
        CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT);
      `);
      db.close();

      delete process.env[CMOS_PROJECT_ID_ENV];

      try {
        CmosDetector.resetInstance();
        const clientResult = await CmosDatabaseClient.create({ dbPath: noMetaDbPath });
        expect(clientResult.success).toBe(true);

        const client = clientResult.data!;
        try {
          const result = client.validateProjectId();

          expect(result.success).toBe(true);
        } finally {
          client.close();
        }
      } finally {
        fs.rmSync(noMetaDir, { recursive: true, force: true });
      }
    });
  });

  describe('withClientValidated', () => {
    // NOTE: Project ID validation has been removed from withClientValidated.
    // The explicit projectRoot requirement (no cwd fallback) now provides
    // protection against cross-project contamination without requiring
    // env var configuration. These tests verify the new behavior.

    it('should execute operation regardless of project_id (validation removed)', async () => {
      // Even with mismatched project_id, operation should succeed
      process.env[CMOS_PROJECT_ID_ENV] = 'wrong-project';

      let operationExecuted = false;

      const result = await withClientValidated(
        (client) => {
          operationExecuted = true;
          const missions = client.getMany('SELECT * FROM missions');
          return missions;
        },
        { projectRoot: tempDir }
      );

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
      expect(operationExecuted).toBe(true);
    });

    it('should execute operation when env var not set (validation removed)', async () => {
      delete process.env[CMOS_PROJECT_ID_ENV];

      let operationExecuted = false;

      const result = await withClientValidated(
        (client) => {
          operationExecuted = true;
          const missions = client.getMany('SELECT * FROM missions');
          return missions;
        },
        { projectRoot: tempDir }
      );

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
      expect(operationExecuted).toBe(true);
    });

    it('should allow manual validation via client.validateProjectId()', async () => {
      process.env[CMOS_PROJECT_ID_ENV] = 'wrong-project';

      const clientResult = await CmosDatabaseClient.create({ dbPath });
      expect(clientResult.success).toBe(true);

      const client = clientResult.data!;
      try {
        // Manual opt-in validation still available
        const validation = client.validateProjectId();

        // Should fail because project_id doesn't match
        expect(validation.success).toBe(false);
        expect(validation.error?.code).toBe(CMOS_ERROR_CODES.PROJECT_ID_MISMATCH);
      } finally {
        client.close();
      }
    });
  });

  describe('mutation tools integration', () => {
    // NOTE: Project ID validation has been removed from mutation tools.
    // Protection is now provided by requiring explicit projectRoot parameter
    // (no cwd fallback). These tests verify mutations work without env var.

    it('should allow mission mutation regardless of project_id (validation removed)', async () => {
      process.env[CMOS_PROJECT_ID_ENV] = 'wrong-project';

      // Add required tables and a mission
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, title TEXT, started_at TEXT, status TEXT);
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, status TEXT);
        INSERT INTO missions (id, name, status) VALUES ('m1', 'Test Mission', 'Queued');
      `);
      db.close();

      // Import a mutation tool
      const { cmosMissionStart } = await import('../../../src/tools/cmos/cmos-mission-start');

      CmosDetector.resetInstance();
      const result = await cmosMissionStart({ missionId: 'm1', projectRoot: tempDir });

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
    });

    it('should allow mission mutation when env var not set (validation removed)', async () => {
      delete process.env[CMOS_PROJECT_ID_ENV];

      // Add required tables and a mission
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT, content TEXT, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, title TEXT, started_at TEXT, status TEXT);
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, status TEXT);
        INSERT INTO missions (id, name, status) VALUES ('m1', 'Test Mission', 'Queued');
      `);
      db.close();

      // Import a mutation tool
      const { cmosMissionStart } = await import('../../../src/tools/cmos/cmos-mission-start');

      CmosDetector.resetInstance();
      const result = await cmosMissionStart({ missionId: 'm1', projectRoot: tempDir });

      // Should succeed - validation is no longer automatic
      expect(result.success).toBe(true);
    });

    it('should fail when projectRoot is not provided', async () => {
      const { cmosMissionStart } = await import('../../../src/tools/cmos/cmos-mission-start');
      const originalCwd = process.cwd;
      const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-no-root-'));
      const registryConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-registry-test-'));

      try {
        // Force resolution into a deterministic no-CMOS path.
        process.cwd = () => emptyWorkspace;
        delete process.env[CMOS_PROJECT_ROOT_ENV];
        CmosDetector.resetInstance();
        ProjectRegistry.resetInstance();
        await ProjectRegistry.create({ configDir: registryConfigDir });

        // Call without projectRoot - should fail with clear resolution guidance.
        const result = await cmosMissionStart({ missionId: 'm1' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
        expect(result.error?.message).toContain('No CMOS project found');
      } finally {
        process.cwd = originalCwd;
        ProjectRegistry.resetInstance();
        fs.rmSync(emptyWorkspace, { recursive: true, force: true });
        fs.rmSync(registryConfigDir, { recursive: true, force: true });
      }
    });
  });
});
