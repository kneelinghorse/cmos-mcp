/**
 * rbook_db_restore Tool Tests
 *
 * @module tests/tools/rbook/rbook-db-restore
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rbookDbSnapshot } from '../../../src/tools/rbook/rbook-db-snapshot';
import {
  rbookDbRestore,
  rbookDbRestoreToolDefinition,
  formatDbRestoreForLLM,
} from '../../../src/tools/rbook/rbook-db-restore';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  ProjectGraphRegistry,
  readStoreIdentity,
} from '../../../src/intelligence/project-graph-registry';
import { captureToolCall } from '../../../src/tools/rbook/tool-call-context';

function setupTestProject(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-db-restore-test-'));
  const rbookDbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(rbookDbDir, { recursive: true });
  const dbPath = path.join(rbookDbDir, 'rbook.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      sprint_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      agent TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT INTO metadata (key, value)
    VALUES ('project_id', 'restore-${path.basename(tempDir)}');

    INSERT INTO missions (id, sprint_id, name, status)
    VALUES
      ('m1', 's1', 'Mission 1', 'Current'),
      ('m2', 's1', 'Mission 2', 'Queued');

    INSERT INTO sessions (id, type, title, started_at, agent, status)
    VALUES
      ('session-1', 'planning', 'Planning Session', '2026-01-01T10:00:00Z', 'assistant', 'active');

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('project_context', 'context/PROJECT_CONTEXT.json', '{}', '2026-01-01T12:00:00Z');
  `);
  db.close();

  RbookDetector.resetInstance();
  return { tempDir, dbPath };
}

function addMission(dbPath: string, missionId: string): void {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)').run(
    missionId,
    's1',
    `Mission ${missionId}`,
    'Queued'
  );
  db.close();
}

function countMissions(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT COUNT(*) as count FROM missions').get() as { count: number };
  db.close();
  return row.count;
}

function copySnapshot(dbPath: string, snapshotId: string): string {
  const snapshotDirectory = path.join(path.dirname(dbPath), 'snapshots');
  fs.mkdirSync(snapshotDirectory, { recursive: true });
  const snapshotPath = path.join(snapshotDirectory, `${snapshotId}.sqlite`);
  fs.copyFileSync(dbPath, snapshotPath);
  return snapshotPath;
}

describe('rbook_db_restore', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    const setup = setupTestProject();
    tempDir = setup.tempDir;
    dbPath = setup.dbPath;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores database state from a named snapshot', async () => {
    const snapshotResult = await rbookDbSnapshot({ projectRoot: tempDir });
    expect(snapshotResult.success).toBe(true);
    const snapshotId = snapshotResult.data?.createdSnapshot?.id;
    expect(snapshotId).toBeDefined();

    addMission(dbPath, 'm3');
    expect(countMissions(dbPath)).toBe(3);

    const restoreResult = await rbookDbRestore({
      projectRoot: tempDir,
      snapshotId: snapshotId!,
      confirm: true,
    });

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.data?.missionCount).toBe(2);
    expect(countMissions(dbPath)).toBe(2);
  });

  it('creates an automatic pre-restore backup before replacement', async () => {
    const snapshotResult = await rbookDbSnapshot({ projectRoot: tempDir });
    const snapshotId = snapshotResult.data?.createdSnapshot?.id;
    expect(snapshotId).toBeDefined();

    addMission(dbPath, 'm3');
    expect(countMissions(dbPath)).toBe(3);

    const restoreResult = await rbookDbRestore({
      projectRoot: tempDir,
      snapshotId: snapshotId!,
      confirm: true,
    });

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.data?.backupPath).toBeDefined();
    expect(fs.existsSync(restoreResult.data?.backupPath ?? '')).toBe(true);
    expect(countMissions(restoreResult.data?.backupPath ?? '')).toBe(3);
  });

  it('reconciles an identity-less legacy snapshot with the active store identity before registration', async () => {
    const originalIdentity = readStoreIdentity(tempDir)?.project_id;
    expect(originalIdentity).toBeDefined();
    const graphBefore = await ProjectGraphRegistry.create();
    expect(graphBefore.getByStorePath(tempDir)).toBeNull();
    const snapshotId = 'legacy-identityless-unregistered';
    const snapshotPath = copySnapshot(dbPath, snapshotId);

    const snapshot = new Database(snapshotPath);
    snapshot.prepare(`DELETE FROM metadata WHERE key = 'project_id'`).run();
    snapshot.close();

    const restoreResult = (
      await captureToolCall('write', () =>
        rbookDbRestore({ projectRoot: tempDir, snapshotId, confirm: true })
      )
    ).value;

    expect(restoreResult.success).toBe(true);
    const storedIdentity = readStoreIdentity(tempDir)?.project_id;
    const graph = await ProjectGraphRegistry.create();
    expect(storedIdentity).toBe(originalIdentity);
    expect(graph.getByStorePath(tempDir)).toBe(storedIdentity);
  });

  it('rolls back both database and identity contract when a snapshot claims another project id', async () => {
    const originalIdentity = readStoreIdentity(tempDir)?.project_id;
    const graphBefore = await ProjectGraphRegistry.create();
    expect(graphBefore.getByStorePath(tempDir)).toBeNull();
    const snapshotId = 'foreign-identity-unregistered';
    const snapshotPath = copySnapshot(dbPath, snapshotId);

    const snapshot = new Database(snapshotPath);
    snapshot
      .prepare(`UPDATE metadata SET value = 'foreign-snapshot-id' WHERE key = 'project_id'`)
      .run();
    snapshot.close();
    addMission(dbPath, 'must-survive-failed-restore');

    const restoreResult = (
      await captureToolCall('write', () =>
        rbookDbRestore({ projectRoot: tempDir, snapshotId, confirm: true })
      )
    ).value;

    expect(restoreResult.success).toBe(false);
    expect(restoreResult.error?.code).toBe(RBOOK_ERROR_CODES.SNAPSHOT_RESTORE_FAILED);
    expect(countMissions(dbPath)).toBe(3);
    const storedIdentity = readStoreIdentity(tempDir)?.project_id;
    const graph = await ProjectGraphRegistry.create();
    expect(storedIdentity).toBe(originalIdentity);
    expect(graph.getByStorePath(tempDir)).toBeNull();
  });

  it('returns SNAPSHOT_NOT_FOUND for missing snapshot IDs', async () => {
    const result = await rbookDbRestore({
      projectRoot: tempDir,
      snapshotId: 'snapshot-does-not-exist',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RBOOK_ERROR_CODES.SNAPSHOT_NOT_FOUND);
    // s85-m01: the suggestion must name the consolidated tool — rbook_db_snapshot no longer exists.
    expect(result.error?.suggestion).toContain('rbook_db(action="snapshot"');
  });

  it('rejects restore without explicit destructive confirmation', async () => {
    const result = await rbookDbRestore({
      projectRoot: tempDir,
      snapshotId: 'snapshot-anything',
      confirm: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
    expect(result.error?.field).toBe('confirm');
  });

  it('validates snapshot schema before restore', async () => {
    const snapshotsDir = path.join(tempDir, 'rbook', 'db', 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });

    const invalidSnapshotPath = path.join(snapshotsDir, 'snapshot-invalid.sqlite');
    const invalidDb = new Database(invalidSnapshotPath);
    invalidDb.exec(`
      CREATE TABLE random_table (
        id TEXT PRIMARY KEY
      );
    `);
    invalidDb.close();

    const result = await rbookDbRestore({
      projectRoot: tempDir,
      snapshotId: 'snapshot-invalid',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH);
    expect(result.error?.message).toContain('Missing tables');
  });

  it('publishes MCP tool definition metadata', () => {
    expect(rbookDbRestoreToolDefinition.name).toBe('rbook_db_restore');
    expect(rbookDbRestoreToolDefinition.description).toContain('Restore');
    expect(rbookDbRestoreToolDefinition.inputSchema.type).toBe('object');
  });

  it('formats restore results for readable LLM output', async () => {
    const snapshotResult = await rbookDbSnapshot({ projectRoot: tempDir });
    const snapshotId = snapshotResult.data?.createdSnapshot?.id;
    expect(snapshotId).toBeDefined();

    const restoreResult = await rbookDbRestore({
      projectRoot: tempDir,
      snapshotId: snapshotId!,
      confirm: true,
    });

    const formatted = formatDbRestoreForLLM(restoreResult);
    expect(formatted).toContain('Database restore complete');
    expect(formatted).toContain('Post-Restore Counts');
  });
});
