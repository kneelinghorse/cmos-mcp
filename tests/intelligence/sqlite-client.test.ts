import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

import {
  MissionUpdateInput,
  SQLiteClient,
  SQLiteClientError,
  SQLiteClientOptions,
  SQLiteConnectionPool,
} from '../../src/intelligence/sqlite-client';

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  sprint_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT,
  notes TEXT,
  metadata TEXT
);
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

interface ClientTestContext {
  readonly client: SQLiteClient;
  readonly pool: SQLiteConnectionPool;
  readonly workspace: string;
  readonly dbPath: string;
  cleanup(): Promise<void>;
}

async function initializeDatabaseFile(): Promise<{ workspace: string; dbPath: string }> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-client-'));
  const dbPath = path.join(workspace, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.close();
  return { workspace, dbPath };
}

async function createClient(
  overrides: Partial<SQLiteClientOptions> = {}
): Promise<ClientTestContext> {
  const { workspace, dbPath } = await initializeDatabaseFile();
  const pool = overrides.pool ?? new SQLiteConnectionPool();
  const client = new SQLiteClient({
    databasePath: dbPath,
    pool,
    ...overrides,
  });
  return {
    client,
    pool,
    workspace,
    dbPath,
    cleanup: async () => {
      client.dispose();
      if (!overrides.pool) {
        pool.drain();
      }
      await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

describe('SQLiteClient', () => {
  test('creates and retrieves missions', async () => {
    const context = await createClient();
    try {
      const created = context.client.createMission({
        id: 'T1',
        name: 'Test Mission',
        status: 'Current',
        metadata: { priority: 'high' },
      });

      expect(created).toMatchObject({
        id: 'T1',
        status: 'Current',
        metadata: { priority: 'high' },
      });

      const fetched = context.client.getMission('T1');
      expect(fetched).toEqual(created);
    } finally {
      await context.cleanup();
    }
  });

  test('lists missions with filters and excludes completed by default', async () => {
    const context = await createClient();
    try {
      context.client.createMission({ id: 'A1', name: 'Alpha', status: 'Current' });
      context.client.createMission({ id: 'A2', name: 'Beta', status: 'Completed' });
      context.client.createMission({ id: 'A3', name: 'Gamma', status: 'Blocked' });

      const active = context.client.listMissions();
      expect(active.map((mission) => mission.id)).toEqual(['A1', 'A3']);

      const allMissions = context.client.listMissions({ includeCompleted: true });
      expect(allMissions.map((mission) => mission.id)).toEqual(['A1', 'A2', 'A3']);

      const completed = context.client.listMissions({ status: 'Completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe('A2');

      const searched = context.client.listMissions({ includeCompleted: true, search: 'Bet' });
      expect(searched).toHaveLength(1);
      expect(searched[0].id).toBe('A2');

      const limited = context.client.listMissions({ includeCompleted: true, limit: 2 });
      expect(limited).toHaveLength(2);

      expect(() => context.client.listMissions({ includeCompleted: true, limit: 0 })).toThrow(
        SQLiteClientError
      );
    } finally {
      await context.cleanup();
    }
  });

  test('updates and deletes missions with metadata handling', async () => {
    const context = await createClient();
    try {
      context.client.createMission({
        id: 'B1',
        name: 'Backlog Mission',
        status: 'Queued',
        metadata: { scope: 'db' },
      });

      const updated = context.client.updateMission('B1', {
        status: 'In Progress',
        notes: 'Started work',
        metadata: { scope: 'db', owner: 'codex' },
      });

      expect(updated.status).toBe('In Progress');
      expect(updated.notes).toBe('Started work');
      expect(updated.metadata).toEqual({ scope: 'db', owner: 'codex' });

      const cleared = context.client.updateMission('B1', { metadata: null });
      expect(cleared.metadata).toBeNull();

      expect(context.client.deleteMission('B1')).toBe(true);
      expect(context.client.getMission('B1')).toBeUndefined();
      expect(context.client.deleteMission('B1')).toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  test('logs session events and returns parsed payloads', async () => {
    const context = await createClient();
    try {
      context.client.createMission({ id: 'S1', name: 'Session Mission', status: 'Current' });

      const logged = context.client.logSessionEvent({
        mission: 'S1',
        action: 'start',
        status: 'ok',
        rawEvent: { decision: 'green' },
      });

      expect(logged.id).toBeGreaterThan(0);
      expect(logged.rawEvent).toEqual({ decision: 'green' });

      const events = context.client.getRecentSessionEvents(5);
      expect(events).toHaveLength(1);
      expect(events[0].mission).toBe('S1');
      expect(events[0].rawEvent).toEqual({ decision: 'green' });
    } finally {
      await context.cleanup();
    }
  });

  test('sets and retrieves contexts with snapshot handling', async () => {
    const context = await createClient();
    try {
      const payload = { working_memory: { agents_md_loaded: true } };
      const result = context.client.setContext('project_context', payload, {
        sourcePath: 'PROJECT_CONTEXT.json',
        sessionId: 's09-m06',
        snapshotSource: 'jest',
      });

      expect(result.id).toBe('project_context');
      expect(result.sourcePath).toBe('PROJECT_CONTEXT.json');
      expect(result.content).toEqual(payload);

      const updated = context.client.setContext(
        'project_context',
        { ...payload, version: 2 },
        { snapshot: false }
      );
      expect(updated.sourcePath).toBe('PROJECT_CONTEXT.json');
      expect(updated.content.version).toBe(2);

      const db = new Database(context.dbPath);
      const snapshotCount = db
        .prepare('SELECT COUNT(*) AS count FROM context_snapshots WHERE context_id = ?')
        .get('project_context') as { count: number };
      db.close();
      expect(snapshotCount.count).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  test('addContextSnapshot deduplicates identical payloads', async () => {
    const context = await createClient();
    try {
      const payload = { test: true };
      context.client.setContext('master_context', payload, { snapshot: false });

      const first = context.client.addContextSnapshot('master_context', payload, {
        source: 'sync-service',
      });
      const second = context.client.addContextSnapshot('master_context', { ...payload });

      expect(first).toBe(true);
      expect(second).toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  test('reuses pooled connections and releases them on dispose', async () => {
    const { workspace, dbPath } = await initializeDatabaseFile();
    const pool = new SQLiteConnectionPool();
    const clientA = new SQLiteClient({ databasePath: dbPath, pool });
    const clientB = new SQLiteClient({ databasePath: dbPath, pool });

    try {
      clientA.listMissions({ includeCompleted: true });
      clientB.listMissions({ includeCompleted: true });

      const snapshot = pool.snapshot();
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].refCount).toBe(2);

      clientA.dispose();
      expect(pool.snapshot()[0].refCount).toBe(1);

      clientB.dispose();
      expect(pool.size()).toBe(0);
    } finally {
      pool.drain();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('surface dependency errors when SQLite driver is missing', async () => {
    const { workspace, dbPath } = await initializeDatabaseFile();
    const pool = new SQLiteConnectionPool();
    const client = new SQLiteClient({
      databasePath: dbPath,
      pool,
      driverFactory: () => {
        throw new Error('missing driver');
      },
    });

    expect(() => client.listMissions({ includeCompleted: true })).toThrow(SQLiteClientError);

    client.dispose();
    pool.drain();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test('rejects unsupported mission statuses', async () => {
    const context = await createClient();
    try {
      expect(() =>
        context.client.createMission({
          id: 'ERR',
          name: 'Invalid',
          status: 'archived' as unknown as 'Queued',
        })
      ).toThrow(SQLiteClientError);
    } finally {
      await context.cleanup();
    }
  });

  test('updates sprint assignments, completion timestamps, and validates payloads', async () => {
    const context = await createClient();
    try {
      context.client.createMission({ id: 'U1', name: 'Updatable', status: 'Current' });

      const updated = context.client.updateMission('U1', {
        sprintId: 'Sprint-9',
        completedAt: '2024-10-05T00:00:00.000Z',
      });

      expect(updated.sprintId).toBe('Sprint-9');
      expect(updated.completedAt).toBe('2024-10-05T00:00:00.000Z');

      expect(() => context.client.updateMission('U1', {} as MissionUpdateInput)).toThrow(
        SQLiteClientError
      );
      expect(() => context.client.updateMission('missing', { name: 'nope' })).toThrow(
        SQLiteClientError
      );
    } finally {
      await context.cleanup();
    }
  });

  test('parses mission metadata defensively even when stored payload is invalid', async () => {
    const ctx = await createClient();
    try {
      const direct = new Database(ctx.dbPath);
      direct
        .prepare(
          'INSERT INTO missions (id, name, status, metadata) VALUES (@id, @name, @status, @metadata)'
        )
        .run({ id: 'RAW', name: 'Raw Mission', status: 'Current', metadata: '{not-json' });
      direct.close();

      const mission = ctx.client.getMission('RAW');
      expect(mission?.metadata).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  test('serializes session events for strings, empty payloads, and circular objects', async () => {
    const ctx = await createClient();
    try {
      ctx.client.logSessionEvent({ mission: 'S2', action: 'string-event', rawEvent: 'raw-text' });
      ctx.client.logSessionEvent({ mission: 'S2', action: 'empty-event' });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      ctx.client.logSessionEvent({ mission: 'S2', action: 'circular-event', rawEvent: circular });

      const events = ctx.client.getRecentSessionEvents(3);
      expect(events[0].rawEvent).toEqual({});
      expect(events[1].rawEvent).toEqual({});
      expect(events[2].rawEvent).toBe('raw-text');
    } finally {
      await ctx.cleanup();
    }
  });

  test('omits rawEvent property when the underlying column is empty', async () => {
    const ctx = await createClient();
    try {
      const direct = new Database(ctx.dbPath);
      direct
        .prepare('INSERT INTO session_events (ts, raw_event) VALUES (@ts, @raw_event)')
        .run({ ts: new Date().toISOString(), raw_event: '' });
      direct.close();

      const events = ctx.client.getRecentSessionEvents(1);
      expect(events[0].rawEvent).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });

  test('supports string constructors, shared pool reuse, and ensures disposal safety', async () => {
    const { workspace, dbPath } = await initializeDatabaseFile();
    const sharedPool = SQLiteConnectionPool.shared();
    sharedPool.drain();
    const client = new SQLiteClient(dbPath);

    try {
      client.listMissions({ includeCompleted: true });
      expect(sharedPool.snapshot()).toHaveLength(1);
      sharedPool.drain();
      expect(sharedPool.size()).toBe(0);
      client.dispose();
      expect(() => client.listMissions({ includeCompleted: true })).toThrow(SQLiteClientError);
    } finally {
      sharedPool.drain();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('creates directories when fileMustExist is false', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-client-new-'));
    const nestedDir = path.join(root, 'nested');
    const dbPath = path.join(nestedDir, 'fresh.sqlite');
    const client = new SQLiteClient({ databasePath: dbPath, fileMustExist: false });
    client.dispose();

    await expect(fs.stat(nestedDir)).resolves.toBeDefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('withTransaction wraps errors and propagates return values', async () => {
    const ctx = await createClient();
    try {
      const result = ctx.client.withTransaction(() => 'ok');
      expect(result).toBe('ok');

      expect(() =>
        ctx.client.withTransaction(() => {
          throw new Error('boom');
        })
      ).toThrow(SQLiteClientError);

      expect(() =>
        ctx.client.withTransaction(() => {
          throw new SQLiteClientError('bad', 'INVALID_OPERATION');
        })
      ).toThrow(SQLiteClientError);

      expect(() =>
        ctx.client.withTransaction(() => {
          throw 'boom';
        })
      ).toThrow(SQLiteClientError);
    } finally {
      await ctx.cleanup();
    }
  });

  test('validates custom timestamps when logging session events', async () => {
    const ctx = await createClient();
    try {
      ctx.client.logSessionEvent({
        mission: 'TS',
        action: 'date',
        ts: new Date('2024-01-01T00:00:00Z'),
      });
      ctx.client.logSessionEvent({
        mission: 'TS',
        action: 'string-date',
        ts: '2024-02-02T00:00:00Z',
      });
      expect(() =>
        ctx.client.logSessionEvent({ mission: 'TS', action: 'bad', ts: 'not-a-date' })
      ).toThrow(SQLiteClientError);
    } finally {
      await ctx.cleanup();
    }
  });

  test('connection pool gracefully releases missing entries', () => {
    const pool = new SQLiteConnectionPool();
    pool.release('/tmp/missing.sqlite', { readOnly: false, fileMustExist: true, timeoutMs: 1_000 });
  });

  test('wraps sqlite errors on duplicate mission inserts', async () => {
    const ctx = await createClient();
    try {
      ctx.client.createMission({ id: 'DUP', name: 'Dup', status: 'Current' });
      expect(() =>
        ctx.client.createMission({ id: 'DUP', name: 'Dup 2', status: 'Current' })
      ).toThrow(SQLiteClientError);
    } finally {
      await ctx.cleanup();
    }
  });

  test('throws when mission cannot be reloaded after creation', async () => {
    const ctx = await createClient();
    try {
      const spy = jest.spyOn(ctx.client, 'getMission').mockReturnValueOnce(undefined);
      expect(() =>
        ctx.client.createMission({ id: 'MISS', name: 'Missing', status: 'Current' })
      ).toThrow(SQLiteClientError);
      spy.mockRestore();
    } finally {
      await ctx.cleanup();
    }
  });

  test('throws when mission cannot be reloaded after updates', async () => {
    const ctx = await createClient();
    try {
      ctx.client.createMission({ id: 'UPD2', name: 'Mission', status: 'Current' });
      const spy = jest.spyOn(ctx.client, 'getMission').mockReturnValueOnce(undefined);
      expect(() => ctx.client.updateMission('UPD2', { name: 'Updated' })).toThrow(
        SQLiteClientError
      );
      spy.mockRestore();
    } finally {
      await ctx.cleanup();
    }
  });

  test('deleteMission surfaces sqlite execution errors', async () => {
    const ctx = await createClient();
    try {
      const spy = jest.spyOn(ctx.client as any, 'prepare').mockImplementation(() => {
        return {
          run() {
            throw new Error('prep failed');
          },
        } as unknown as Statement;
      });
      expect(() => ctx.client.deleteMission('ANY')).toThrow(SQLiteClientError);
      spy.mockRestore();
    } finally {
      await ctx.cleanup();
    }
  });

  test('logSessionEvent surfaces sqlite execution errors', async () => {
    const ctx = await createClient();
    try {
      const spy = jest.spyOn(ctx.client as any, 'prepare').mockImplementation(() => {
        return {
          run() {
            throw new Error('insert failed');
          },
        } as unknown as Statement;
      });
      expect(() => ctx.client.logSessionEvent({ mission: 'ERR', action: 'boom' })).toThrow(
        SQLiteClientError
      );
      spy.mockRestore();
    } finally {
      await ctx.cleanup();
    }
  });

  test('throws when fetching unknown session event ids', async () => {
    const ctx = await createClient();
    try {
      expect(() => (ctx.client as any).getSessionEventById(9_999)).toThrow(SQLiteClientError);
    } finally {
      await ctx.cleanup();
    }
  });

  test('requires a non-empty database path', () => {
    expect(() => new SQLiteClient({ databasePath: '   ' } as SQLiteClientOptions)).toThrow(
      SQLiteClientError
    );
  });
});
