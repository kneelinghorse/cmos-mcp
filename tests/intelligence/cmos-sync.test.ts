import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { CmosSyncService } from '../../src/intelligence/cmos-sync';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { SQLiteClient } from '../../src/intelligence/sqlite-client';

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  session_id TEXT,
  source TEXT,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  agent TEXT,
  mission TEXT,
  action TEXT,
  status TEXT,
  summary TEXT,
  next_hint TEXT,
  raw_event TEXT NOT NULL
);
`;

async function createWorkspace(): Promise<string> {
  const base = path.join(process.cwd(), 'tmp', 'cmos-sync-tests');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'ws-'));
}

async function initializeDatabase(dbPath: string): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.close();
}

async function writeJson(filePath: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

describe('CmosSyncService', () => {
  afterEach(() => {
    CmosDetector.resetInstance();
  });

  test('returns unavailable when CMOS database is missing', async () => {
    const workspace = await createWorkspace();
    try {
      const detector = {
        detect: async () => ({
          projectRoot: workspace,
          cmosDirectory: path.join(workspace, 'cmos'),
          hasCmosDirectory: false,
          hasDatabase: false,
          checkedAt: new Date().toISOString(),
        }),
      } as unknown as CmosDetector;

      const service = new CmosSyncService({
        projectRoot: workspace,
        detector,
        contextTargets: [],
        sessionsPath: 'SESSIONS.jsonl',
      });

      const result = await service.syncAll();
      expect(result.status).toBe('unavailable');
      expect(result.warnings).toContain('cmos_database_unavailable');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('syncs context files into SQLite when direction is files_to_db', async () => {
    const workspace = await createWorkspace();
    const dbPath = path.join(workspace, 'cmos.sqlite');
    try {
      await initializeDatabase(dbPath);
      const projectContextPath = path.join(workspace, 'PROJECT_CONTEXT.json');
      await writeJson(projectContextPath, { working_memory: { session_count: 1 } });

      const service = new CmosSyncService({
        projectRoot: workspace,
        databasePath: dbPath,
        direction: 'files_to_db',
        contextTargets: [{ id: 'project_context', filePath: 'PROJECT_CONTEXT.json' }],
        sessionsPath: 'SESSIONS.jsonl',
      });

      const result = await service.syncAll({ includeSessionEvents: false });
      expect(result.contexts[0]).toMatchObject({ action: 'write_db', updated: true });

      const client = new SQLiteClient({ databasePath: dbPath });
      const record = client.getContext('project_context');
      client.dispose();
      expect(record?.content).toEqual({ working_memory: { session_count: 1 } });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('prefers newer database context during bidirectional sync', async () => {
    const workspace = await createWorkspace();
    const dbPath = path.join(workspace, 'cmos.sqlite');
    try {
      await initializeDatabase(dbPath);
      const projectContextPath = path.join(workspace, 'PROJECT_CONTEXT.json');
      await writeJson(projectContextPath, { stale: true });
      await fs.utimes(projectContextPath, new Date('2020-01-01'), new Date('2020-01-01'));

      const client = new SQLiteClient({ databasePath: dbPath });
      client.setContext('project_context', { fresh: true }, { snapshot: false });
      client.dispose();

      const service = new CmosSyncService({
        projectRoot: workspace,
        databasePath: dbPath,
        direction: 'bidirectional',
        contextTargets: [{ id: 'project_context', filePath: 'PROJECT_CONTEXT.json' }],
        sessionsPath: 'SESSIONS.jsonl',
      });

      await service.syncAll({ includeSessionEvents: false });
      const fileContents = JSON.parse(await fs.readFile(projectContextPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(fileContents).toEqual({ fresh: true });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('syncSessionEvents inserts new events and skips duplicates', async () => {
    const workspace = await createWorkspace();
    const dbPath = path.join(workspace, 'cmos.sqlite');
    try {
      await initializeDatabase(dbPath);
      const sessionsPath = path.join(workspace, 'SESSIONS.jsonl');
      await writeSessionsLog(sessionsPath, [
        {
          ts: '2025-11-08T18:00:00Z',
          agent: 'codex',
          mission: 's09-m06',
          action: 'start',
          status: 'in_progress',
          summary: 'Starting sync work',
        },
        {
          ts: '2025-11-08T19:00:00Z',
          agent: 'codex',
          mission: 's09-m06',
          action: 'complete',
          status: 'completed',
          summary: 'Finished sync work',
        },
      ]);

      const service = new CmosSyncService({
        projectRoot: workspace,
        databasePath: dbPath,
        contextTargets: [],
        sessionsPath: 'SESSIONS.jsonl',
      });

      const firstRun = await service.syncAll({ includeContexts: false });
      expect(firstRun.sessionEvents.inserted).toBe(2);

      const secondRun = await service.syncAll({ includeContexts: false });
      expect(secondRun.sessionEvents.inserted).toBe(0);

      const client = new SQLiteClient({ databasePath: dbPath });
      const events = client.getRecentSessionEvents(10);
      client.dispose();
      expect(events).toHaveLength(2);
      expect(events[0].mission).toBe('s09-m06');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

async function writeSessionsLog(
  sessionsPath: string,
  events: Array<{
    ts: string;
    agent: string;
    mission: string;
    action: string;
    status: string;
    summary: string;
  }>
): Promise<void> {
  await fs.mkdir(path.dirname(sessionsPath), { recursive: true });
  const lines = events.map((event) => JSON.stringify(event));
  await fs.writeFile(sessionsPath, `${lines.join('\n')}\n`, 'utf-8');
}
