/**
 * cmos_db_snapshot Tool Tests
 *
 * @module tests/tools/cmos/cmos-db-snapshot
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosDbSnapshot,
  cmosDbSnapshotToolDefinition,
  formatDbSnapshotForLLM,
} from '../../../src/tools/cmos/cmos-db-snapshot';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

function setupTestProject(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-db-snapshot-test-'));
  const cmosDbDir = path.join(tempDir, 'cmos', 'db');
  fs.mkdirSync(cmosDbDir, { recursive: true });
  const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

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

  CmosDetector.resetInstance();
  return { tempDir, dbPath };
}

describe('cmos_db_snapshot', () => {
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

  it('creates a timestamped database snapshot with metadata', async () => {
    const result = await cmosDbSnapshot({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('create');
    expect(result.data?.createdSnapshot).toBeDefined();
    expect(result.data?.createdSnapshot?.path).toContain(path.join('cmos', 'db', 'snapshots'));
    expect(fs.existsSync(result.data?.createdSnapshot?.path ?? '')).toBe(true);
    expect(result.data?.createdSnapshot?.sizeBytes).toBeGreaterThan(0);
    expect(result.data?.missionCount).toBe(2);
    expect(result.data?.sessionCount).toBe(1);
  });

  it('lists snapshots without creating a new one in listOnly mode', async () => {
    await cmosDbSnapshot({ projectRoot: tempDir });
    await cmosDbSnapshot({ projectRoot: tempDir });

    const result = await cmosDbSnapshot({ projectRoot: tempDir, listOnly: true });

    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe('list');
    expect(result.data?.createdSnapshot).toBeNull();
    expect(result.data?.snapshots.length).toBeGreaterThanOrEqual(2);
  });

  it('applies retention by pruning oldest snapshots first', async () => {
    await cmosDbSnapshot({ projectRoot: tempDir, maxSnapshots: 2 });
    await cmosDbSnapshot({ projectRoot: tempDir, maxSnapshots: 2 });
    const third = await cmosDbSnapshot({ projectRoot: tempDir, maxSnapshots: 2 });

    expect(third.success).toBe(true);
    expect(third.data?.snapshots.length).toBe(2);
    expect(third.data?.prunedSnapshotIds.length).toBe(1);

    const list = await cmosDbSnapshot({ projectRoot: tempDir, listOnly: true });
    expect(list.success).toBe(true);
    expect(list.data?.snapshots.length).toBe(2);

    for (const prunedId of third.data?.prunedSnapshotIds ?? []) {
      expect(list.data?.snapshots.some((snapshot) => snapshot.id === prunedId)).toBe(false);
    }
  });

  it('returns actionable error when CMOS project is not present', async () => {
    const noCmosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-db-snapshot-missing-'));

    try {
      CmosDetector.resetInstance();
      const result = await cmosDbSnapshot({ projectRoot: noCmosDir });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      expect(result.error?.suggestion).toBeDefined();
    } finally {
      fs.rmSync(noCmosDir, { recursive: true, force: true });
    }
  });

  it('uses cmos.sqlite from the active project', async () => {
    const result = await cmosDbSnapshot({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.snapshotDirectory).toBe(path.join(path.dirname(dbPath), 'snapshots'));
  });

  it('publishes MCP tool definition metadata', () => {
    expect(cmosDbSnapshotToolDefinition.name).toBe('cmos_db_snapshot');
    expect(cmosDbSnapshotToolDefinition.description).toContain('snapshot');
    expect(cmosDbSnapshotToolDefinition.inputSchema.type).toBe('object');
  });

  it('formats snapshot results for readable LLM output', async () => {
    const result = await cmosDbSnapshot({ projectRoot: tempDir });
    const formatted = formatDbSnapshotForLLM(result);

    expect(formatted).toContain('Database snapshot');
    expect(formatted).toContain('Snapshot ID');
  });
});
