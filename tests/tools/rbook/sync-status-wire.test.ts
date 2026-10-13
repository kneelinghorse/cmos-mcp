// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real SQLite and HTTP fixtures preserve the dashboard's existing PG table-name boundary.
// ABOUTME: Empty or unknown comparisons must never certify synchronization after a product rename.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import {
  formatReconciliationForLLM,
  rbookDbReconcile,
} from '../../../src/tools/rbook/rbook-db-backfill';
import { seedRbookDb } from '../../helpers/seedRbookDb';

// Wire names are the live dashboard contract, independent of the public rbook_* tool names.
const ENTITIES = [
  ['cmos_sprints', 'sprints', 1],
  ['cmos_missions', 'missions', 2],
  ['cmos_sessions', 'sessions', 3],
  ['cmos_decisions', 'strategic_decisions', 4],
  ['cmos_learnings', 'learnings', 5],
  ['cmos_mission_dependencies', 'mission_dependencies', 1],
] as const;
const EXCLUDED = [
  'cmos_projects',
  'cmos_project_metadata',
  'cmos_contexts',
  'cmos_sync_log',
] as const;
type TableCount = { table: string; count: number };
let root: string;
let dbPath: string;
let server: http.Server;
let tables: TableCount[];
let failScopedStatus: boolean;
let requests: Array<{ url: string; method: string; authorization: string }>;
const envKeys = ['RBOOK_', LEGACY.envPrefix].flatMap((prefix) =>
  ['CONFIG_DIR', 'DASHBOARD_URL', 'DASHBOARD_API_KEY', 'DASHBOARD_USER', 'DASHBOARD_PASSWORD'].map(
    (name) => prefix + name
  )
);
let previous: Record<string, string | undefined>;

function excludedRows(): TableCount[] {
  return EXCLUDED.map((table) => ({ table, count: 100 }));
}
function noComparisons(kind: string): TableCount[] {
  if (kind === 'empty') return [];
  if (kind === 'excluded-only') return excludedRows();
  return ['rbook_sprints', 'rbook_missions', 'constructor', 'toString'].map((table) => ({
    table,
    count: 0,
  }));
}
function addRows(): void {
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO sprints(id,title,status) VALUES (?,?,?)').run('s1', 'One', 'Active');
    for (let i = 0; i < 2; i++)
      db.prepare('INSERT INTO missions(id,sprint_id,name,status) VALUES (?,?,?,?)').run(
        `m${i}`,
        's1',
        `Mission ${i}`,
        'Queued'
      );
    for (let i = 0; i < 3; i++)
      db.prepare('INSERT INTO sessions(id,type,title,started_at,status) VALUES (?,?,?,?,?)').run(
        `session-${i}`,
        'custom',
        `Session ${i}`,
        now,
        'active'
      );
    for (let i = 0; i < 4; i++)
      db.prepare('INSERT INTO strategic_decisions(decision_text,created_at) VALUES (?,?)').run(
        `Decision ${i}`,
        now
      );
    for (let i = 0; i < 5; i++)
      db.prepare('INSERT INTO learnings(content,created_at) VALUES (?,?)').run(
        `Learning ${i}`,
        now
      );
    db.prepare('INSERT INTO mission_dependencies(from_id,to_id,type) VALUES (?,?,?)').run(
      'm0',
      'm1',
      'Blocks'
    );
    for (const [, table, count] of ENTITIES)
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sync-wire-'));
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  const credentials = await CredentialStore.create({ configDir: process.env.RBOOK_CONFIG_DIR });
  await credentials.upsertUserScopedKey('fixture-key', {
    key: 'cmk_loopback_sync_wire',
    label: 'isolated test',
    issuedAt: new Date().toISOString(),
    lastUsedAt: '',
  });
  dbPath = seedRbookDb(root, {
    projectId: 'wire-test-id',
    projectName: 'Wire Test',
    tier: 'build',
  });
  tables = [];
  failScopedStatus = false;
  requests = [];
  server = http.createServer((req, res) => {
    requests.push({
      url: req.url ?? '',
      method: req.method ?? '',
      authorization: req.headers.authorization ?? '',
    });
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (
      url.pathname === '/api/sync/status' &&
      !(failScopedStatus && url.searchParams.has('projectSlug'))
    ) {
      res.end(
        JSON.stringify({
          success: true,
          data: {
            tables,
            totalMirrorRows: tables.reduce((sum, row) => sum + row.count, 0),
            totalSyncLogEntries: 7,
            unprocessedSyncLogEntries: 0,
            failedSyncLogEntries: 2,
            lastSyncAt: null,
            oldestUnprocessedAt: null,
            projectCount: 1,
          },
        })
      );
    } else if (url.pathname === '/api/messages') {
      res.end(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }));
    } else {
      // Project-state is deliberately unavailable so onboarding must inspect real status labels.
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Unavailable in fixture' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  CredentialStore.resetInstance();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe.each(['project-scoped', 'global fallback'])('%s reconciliation wire contract', (scope) => {
  beforeEach(() => {
    failScopedStatus = scope === 'global fallback';
  });

  it('compares all six actual entities and excludes the other four live status labels', async () => {
    addRows();
    tables = [
      ...ENTITIES.map(([table, , count]) => ({ table, count: count + 1 })),
      ...excludedRows(),
    ];
    const result = await rbookDbReconcile({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      allMatch: false,
      totalSqlite: 16,
      totalPg: 22,
      projectScoped: !failScopedStatus,
      projectSlug: failScopedStatus ? null : 'wire-test',
      syncLogEntries: 7,
      failedEntries: 2,
      tables: ENTITIES.map(([, table, count]) => ({
        table,
        sqliteCount: count,
        pgCount: count + 1,
        match: false,
        delta: -1,
      })),
    });
    expect(result.data?.tables).toHaveLength(6);
    expect(requests.map((request) => request.url)).toEqual(
      failScopedStatus
        ? ['/api/sync/status?projectSlug=wire-test', '/api/sync/status']
        : ['/api/sync/status?projectSlug=wire-test']
    );
    expect(
      requests.every(
        (request) =>
          request.method === 'GET' && request.authorization === 'Bearer cmk_loopback_sync_wire'
      )
    ).toBe(true);
  });

  it.each(['empty', 'unknown-only', 'excluded-only'])(
    'refuses %s evidence instead of certifying an empty comparison',
    async (kind) => {
      tables = noComparisons(kind);
      const result = await rbookDbReconcile({ projectRoot: root });
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({
        code: 'DASHBOARD_ERROR',
        message: expect.stringMatching(/no recognized entity table counts/i),
        suggestion: expect.stringMatching(/sync.status.*retry/i),
      });
      expect(formatReconciliationForLLM(result)).not.toContain('ALL MATCH');
    }
  );

  it('accepts six recognized zero-count entities as an actual comparison', async () => {
    tables = [...ENTITIES.map(([table]) => ({ table, count: 0 })), ...excludedRows()];
    const result = await rbookDbReconcile({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ allMatch: true, totalSqlite: 0, totalPg: 0 });
    expect(result.data?.tables).toHaveLength(6);
  });
});

describe('onboarding status fallback wire contract', () => {
  it('reports all six live-label mismatches after the project-state endpoint fails', async () => {
    addRows();
    tables = [
      ...ENTITIES.map(([table, , count]) => ({ table, count: count + 1 })),
      ...excludedRows(),
    ];
    const result = await rbookAgentOnboard({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data?.syncHealth).toMatchObject({
      allMatch: false,
      totalMismatches: 6,
      failedEntries: 2,
      mismatches: ENTITIES.map(([, table, count]) => ({
        table,
        sqliteCount: count,
        pgCount: count + 1,
        delta: -1,
      })),
    });
    expect(requests.some((request) => request.url === '/api/sync/projects/wire-test/state')).toBe(
      true
    );
    expect(
      requests.some((request) => request.url === '/api/sync/status?projectSlug=wire-test')
    ).toBe(true);
    expect(requests.some((request) => request.url === '/api/sync/status')).toBe(false);
  });

  it.each(['empty', 'unknown-only', 'excluded-only'])(
    'leaves sync health unavailable for %s evidence',
    async (kind) => {
      tables = noComparisons(kind);
      const result = await rbookAgentOnboard({ projectRoot: root });
      expect(result.success).toBe(true);
      expect(result.data?.syncHealth).toBeNull();
      expect(result.warnings).toContainEqual(
        expect.stringMatching(/Sync health unavailable:.*no recognized entity table counts/)
      );
    }
  );

  it('reports a match for six recognized zero-count entities', async () => {
    tables = [...ENTITIES.map(([table]) => ({ table, count: 0 })), ...excludedRows()];
    const result = await rbookAgentOnboard({ projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.data?.syncHealth).toMatchObject({
      allMatch: true,
      totalMismatches: 0,
      mismatches: [],
    });
    expect(result.warnings ?? []).not.toContainEqual(
      expect.stringMatching(/no recognized entity table counts/)
    );
  });
});
