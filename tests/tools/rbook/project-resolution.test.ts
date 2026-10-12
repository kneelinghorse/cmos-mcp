/**
 * Integration tests for project resolution in RbookDatabaseClient
 *
 * Tests the 4-step resolution priority (Sprint 53 m02 removed env Step):
 * 1. Explicit dbPath
 * 2. Explicit projectRoot
 * 3. Auto-discover from cwd
 * 4. Registry fallback
 *
 * `RBOOK_PROJECT_ROOT` is no longer consulted at tool-dispatch time — it survives
 * only as the `.env` bootstrap hint at src/index.ts:17.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';

async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createRbookDatabase(workspace: string): Promise<string> {
  const dbDir = path.join(workspace, 'rbook', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');

  // Create a minimal but valid Reasonbook database
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'Queued'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS contexts (
      id INTEGER PRIMARY KEY,
      type TEXT,
      content TEXT
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO metadata (key, value) VALUES ('project_id', ?)").run(
    `test-${path.basename(workspace)}`
  );
  db.close();

  return dbPath;
}

describe('RbookDatabaseClient project resolution', () => {
  let workspace: string;
  let configDir: string;
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    workspace = await createTempWorkspace('client-resolution-');
    configDir = await createTempWorkspace('config-client-');
    RbookDetector.resetInstance();
    // The resolver's Step-4 fallback reads the GRAPH default (s80-m01), so tests
    // seed/isolate the graph. (s80-m02: the JSON ProjectRegistry is deleted.)
    ProjectGraphRegistry.resetInstance();
    process.env = { ...originalEnv };
    delete process.env['RBOOK_PROJECT_ROOT'];
  });

  afterEach(async () => {
    process.env = originalEnv;
    process.cwd = originalCwd;
    ProjectGraphRegistry.resetInstance();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('Resolution scenario 1: Explicit dbPath', () => {
    it('uses provided dbPath directly', async () => {
      const dbPath = await createRbookDatabase(workspace);

      const result = await RbookDatabaseClient.create({ dbPath });

      expect(result.success).toBe(true);
      expect(result.data?.path).toBe(dbPath);
      result.data?.close();
    });

    it('fails gracefully with invalid dbPath', async () => {
      // Sprint 70 m01: use a tmpdir-based path whose parent dir does not exist —
      // better-sqlite3 still fails to open it (graceful DB_CONNECTION_FAILED), but
      // it stays under os.tmpdir() so the real-store guard does not refuse it. A
      // non-tmpdir bad path (the old '/nonexistent/...') would now correctly throw
      // RealStoreGuardError under Jest. (decision #754)
      const result = await RbookDatabaseClient.create({
        dbPath: path.join(os.tmpdir(), 'rbook-invalid-nonexistent-dir-xyz', 'rbook.sqlite'),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.DB_CONNECTION_FAILED);
    });
  });

  describe('Resolution scenario 2: Explicit projectRoot', () => {
    it('detects Reasonbook from provided projectRoot', async () => {
      await createRbookDatabase(workspace);

      const result = await RbookDatabaseClient.create({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      result.data?.close();
    });

    it('fails with clear error when projectRoot has no Reasonbook', async () => {
      const emptyWorkspace = await createTempWorkspace('empty-');

      const result = await RbookDatabaseClient.create({ projectRoot: emptyWorkspace });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
      expect(result.error?.suggestion).toBeDefined();

      await fs.rm(emptyWorkspace, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 3 (removed): RBOOK_PROJECT_ROOT env var', () => {
    it('Sprint 53 m02: env var is NOT consulted, resolver falls through to cwd/registry', async () => {
      // Env var now only feeds .env bootstrap at src/index.ts:17. With only the
      // env set and no cwd Reasonbook / no graph default, resolution must fail.
      // Initialize an isolated graph registry so the real user's config entries
      // can't satisfy the fallback.
      await ProjectGraphRegistry.create({ configDir });
      await createRbookDatabase(workspace);
      process.env['RBOOK_PROJECT_ROOT'] = workspace;
      const emptyDir = await createTempWorkspace('empty-');
      process.cwd = () => emptyDir;

      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);

      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 4: Auto-discover from cwd', () => {
    it('discovers Reasonbook in current directory', async () => {
      await createRbookDatabase(workspace);
      process.cwd = () => workspace;

      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      result.data?.close();
    });

    it('auto-registers discovered project into the graph', async () => {
      await createRbookDatabase(workspace);
      process.cwd = () => workspace;

      // Initialize the graph registry (bound to the isolated configDir) first so
      // the resolver's auto-register writes here, not the shared config dir.
      const graph = await ProjectGraphRegistry.create({ configDir });

      await RbookDatabaseClient.create();

      // Verify it was registered in the graph.
      expect(graph.getByStorePath(workspace)).not.toBeNull();
    });
  });

  describe('Resolution scenario 5: Registry fallback', () => {
    it('uses default project from registry', async () => {
      const registeredWorkspace = await createTempWorkspace('registered-');
      await createRbookDatabase(registeredWorkspace);

      // Set up the GRAPH registry with a default project
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // s92-m01: a default serves only a CONTEXTLESS cwd (/, $HOME, the install root).
      process.cwd = () => '/';

      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(registeredWorkspace);
      result.data?.close();

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });

    it('never opens the default from a real working folder that is not a Reasonbook project', async () => {
      const registeredWorkspace = await createTempWorkspace('registered-real-folder-');
      await createRbookDatabase(registeredWorkspace);
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      process.cwd = () => workspace;
      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
      expect(result.error?.message).toContain(`No Reasonbook project in '${workspace}'`);

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });

    it('fails with actionable error when no fallback available', async () => {
      // Empty cwd, no env, empty graph registry
      process.cwd = () => workspace;
      await ProjectGraphRegistry.create({ configDir });

      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
      // Sprint 53 m02: suggestion references projectRoot / register — not env var.
      expect(result.error?.suggestion).toMatch(/projectRoot|rbook_project_register/);
      expect(result.error?.suggestion).not.toContain('RBOOK_PROJECT_ROOT');
    });
  });

  describe('Resolution scenario 6: Priority order', () => {
    it('explicit projectRoot beats env var', async () => {
      const envWorkspace = await createTempWorkspace('env-');
      await createRbookDatabase(workspace);
      await createRbookDatabase(envWorkspace);

      process.env['RBOOK_PROJECT_ROOT'] = envWorkspace;

      const result = await RbookDatabaseClient.create({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      expect(result.data?.path).not.toContain(envWorkspace);
      result.data?.close();

      await fs.rm(envWorkspace, { recursive: true, force: true });
    });

    it('Sprint 53 m02: cwd beats env var (env is ignored, cwd auto-discovers)', async () => {
      const cwdWorkspace = await createTempWorkspace('cwd-');
      await createRbookDatabase(workspace);
      await createRbookDatabase(cwdWorkspace);

      process.env['RBOOK_PROJECT_ROOT'] = workspace;
      process.cwd = () => cwdWorkspace;

      const result = await RbookDatabaseClient.create();

      // Env step was removed; cwd auto-discovery wins.
      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(cwdWorkspace);
      result.data?.close();

      await fs.rm(cwdWorkspace, { recursive: true, force: true });
    });

    it('auto-discover beats registry', async () => {
      const registeredWorkspace = await createTempWorkspace('registered-');
      await createRbookDatabase(workspace);
      await createRbookDatabase(registeredWorkspace);

      // Set up a graph default (which auto-discovery should beat)
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Point cwd to workspace with Reasonbook
      process.cwd = () => workspace;

      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      result.data?.close();

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 7: Stale registry entries', () => {
    it('skips stale default project and fails gracefully', async () => {
      const registeredWorkspace = await createTempWorkspace('stale-');
      await createRbookDatabase(registeredWorkspace);

      // Register and set as default in the GRAPH
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Remove the Reasonbook database (making it stale)
      await fs.rm(path.join(registeredWorkspace, 'rbook'), { recursive: true, force: true });
      RbookDetector.resetInstance();

      // Point cwd to non-Reasonbook directory
      process.cwd = () => workspace;

      const result = await RbookDatabaseClient.create();

      // Should fail because default is stale and no other option
      expect(result.success).toBe(false);

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 8: Multiple valid options', () => {
    it('correctly prioritizes when all options available', async () => {
      const dbPath = await createRbookDatabase(workspace);
      const envWorkspace = await createTempWorkspace('env-');
      const cwdWorkspace = await createTempWorkspace('cwd-');
      const registeredWorkspace = await createTempWorkspace('registered-');

      await createRbookDatabase(envWorkspace);
      await createRbookDatabase(cwdWorkspace);
      await createRbookDatabase(registeredWorkspace);

      process.env['RBOOK_PROJECT_ROOT'] = envWorkspace;
      process.cwd = () => cwdWorkspace;

      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Explicit dbPath should win
      const result = await RbookDatabaseClient.create({ dbPath });

      expect(result.success).toBe(true);
      expect(result.data?.path).toBe(dbPath);
      result.data?.close();

      await fs.rm(envWorkspace, { recursive: true, force: true });
      await fs.rm(cwdWorkspace, { recursive: true, force: true });
      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });
  });

  describe('Error message quality', () => {
    it('provides actionable suggestions in error messages', async () => {
      process.cwd = () => workspace;
      await ProjectGraphRegistry.create({ configDir });

      const result = await RbookDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.suggestion).toBeDefined();
      expect(result.error?.suggestion?.length).toBeGreaterThan(0);

      // Should mention at least one resolution option
      const suggestion = result.error?.suggestion || '';
      const mentionsOption =
        suggestion.includes('RBOOK_PROJECT_ROOT') ||
        suggestion.includes('projectRoot') ||
        suggestion.includes('rbook_project_register') ||
        suggestion.includes('rbook/db/rbook.sqlite');
      expect(mentionsOption).toBe(true);
    });
  });

  describe('Fan-out Scenario 9 (Sprint 55 m01): project-scope regression for sprint/mission reads', () => {
    it('rbook_sprint(list) with explicit projectRoot returns only that project’s sprints', async () => {
      const { rbookSprintList } = await import('../../../src/tools/rbook/rbook-sprint-list');
      const wsA = await createTempWorkspace('scope-sprintlist-a-');
      const wsB = await createTempWorkspace('scope-sprintlist-b-');
      await createRbookDatabase(wsA);
      await createRbookDatabase(wsB);

      // Seed distinct sprint rows per workspace. sprint_summary is a view over
      // missions + strategic_decisions on a real schema; for this test we stub
      // the minimal schema needed by rbookSprintList directly.
      const seedSprints = (db: string, rows: Array<{ id: string; title: string }>) => {
        const conn = new Database(db);
        conn.exec(`
          DROP TABLE IF EXISTS sprint_summary;
          CREATE TABLE sprint_summary (
            sprint_id TEXT PRIMARY KEY,
            title TEXT, status TEXT, focus TEXT,
            start_date TEXT, end_date TEXT,
            total_missions INTEGER DEFAULT 0,
            completed_missions INTEGER DEFAULT 0,
            blocked_missions INTEGER DEFAULT 0,
            active_missions INTEGER DEFAULT 0,
            -- s86-m08: sprint_summary gained parked_missions. This stub is a base TABLE, and
            -- ensureSprintSummaryView deliberately never rewrites a table it did not create,
            -- so the column is added here rather than by the migration.
            parked_missions INTEGER DEFAULT 0,
            decisions_count INTEGER DEFAULT 0
          );
        `);
        const stmt = conn.prepare('INSERT INTO sprint_summary (sprint_id, title) VALUES (?, ?)');
        for (const r of rows) stmt.run(r.id, r.title);
        conn.close();
      };
      seedSprints(path.join(wsA, 'rbook', 'db', 'rbook.sqlite'), [
        { id: 'sprint-a1', title: 'Workspace A Sprint 1' },
      ]);
      seedSprints(path.join(wsB, 'rbook', 'db', 'rbook.sqlite'), [
        { id: 'sprint-b1', title: 'Workspace B Sprint 1' },
        { id: 'sprint-b2', title: 'Workspace B Sprint 2' },
      ]);

      // Register both projects in an isolated graph registry, so the fallback
      // cannot leak cross-project data if the pin is wrong.
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(wsA);
      graph.registerStore(wsB);

      const resultA = await rbookSprintList({ projectRoot: wsA });
      expect(resultA.success).toBe(true);
      expect(resultA.data?.sprints.map((s) => s.id)).toEqual(['sprint-a1']);

      const resultB = await rbookSprintList({ projectRoot: wsB });
      expect(resultB.success).toBe(true);
      expect(resultB.data?.sprints.map((s) => s.id).sort()).toEqual(['sprint-b1', 'sprint-b2']);

      await fs.rm(wsA, { recursive: true, force: true });
      await fs.rm(wsB, { recursive: true, force: true });
    });
  });
});
