/**
 * Integration tests for project resolution in CmosDatabaseClient
 *
 * Tests the 4-step resolution priority (Sprint 53 m02 removed env Step):
 * 1. Explicit dbPath
 * 2. Explicit projectRoot
 * 3. Auto-discover from cwd
 * 4. Registry fallback
 *
 * `CMOS_PROJECT_ROOT` is no longer consulted at tool-dispatch time — it survives
 * only as the `.env` bootstrap hint at src/index.ts:17.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';

async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createCmosDatabase(workspace: string): Promise<string> {
  const dbDir = path.join(workspace, 'cmos', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');

  // Create a minimal but valid CMOS database
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
  `);
  db.close();

  return dbPath;
}

describe('CmosDatabaseClient project resolution', () => {
  let workspace: string;
  let configDir: string;
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    workspace = await createTempWorkspace('client-resolution-');
    configDir = await createTempWorkspace('config-client-');
    CmosDetector.resetInstance();
    // The resolver's Step-4 fallback reads the GRAPH default (s80-m01), so tests
    // seed/isolate the graph. (s80-m02: the JSON ProjectRegistry is deleted.)
    ProjectGraphRegistry.resetInstance();
    process.env = { ...originalEnv };
    delete process.env['CMOS_PROJECT_ROOT'];
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
      const dbPath = await createCmosDatabase(workspace);

      const result = await CmosDatabaseClient.create({ dbPath });

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
      const result = await CmosDatabaseClient.create({
        dbPath: path.join(os.tmpdir(), 'cmos-invalid-nonexistent-dir-xyz', 'cmos.sqlite'),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.DB_CONNECTION_FAILED);
    });
  });

  describe('Resolution scenario 2: Explicit projectRoot', () => {
    it('detects CMOS from provided projectRoot', async () => {
      await createCmosDatabase(workspace);

      const result = await CmosDatabaseClient.create({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      result.data?.close();
    });

    it('fails with clear error when projectRoot has no CMOS', async () => {
      const emptyWorkspace = await createTempWorkspace('empty-');

      const result = await CmosDatabaseClient.create({ projectRoot: emptyWorkspace });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      expect(result.error?.suggestion).toBeDefined();

      await fs.rm(emptyWorkspace, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 3 (removed): CMOS_PROJECT_ROOT env var', () => {
    it('Sprint 53 m02: env var is NOT consulted, resolver falls through to cwd/registry', async () => {
      // Env var now only feeds .env bootstrap at src/index.ts:17. With only the
      // env set and no cwd CMOS / no graph default, resolution must fail.
      // Initialize an isolated graph registry so the real user's config entries
      // can't satisfy the fallback.
      await ProjectGraphRegistry.create({ configDir });
      await createCmosDatabase(workspace);
      process.env['CMOS_PROJECT_ROOT'] = workspace;
      const emptyDir = await createTempWorkspace('empty-');
      process.cwd = () => emptyDir;

      const result = await CmosDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);

      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 4: Auto-discover from cwd', () => {
    it('discovers CMOS in current directory', async () => {
      await createCmosDatabase(workspace);
      process.cwd = () => workspace;

      const result = await CmosDatabaseClient.create();

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      result.data?.close();
    });

    it('auto-registers discovered project into the graph', async () => {
      await createCmosDatabase(workspace);
      process.cwd = () => workspace;

      // Initialize the graph registry (bound to the isolated configDir) first so
      // the resolver's auto-register writes here, not the shared config dir.
      const graph = await ProjectGraphRegistry.create({ configDir });

      await CmosDatabaseClient.create();

      // Verify it was registered in the graph.
      expect(graph.getByStorePath(workspace)).not.toBeNull();
    });
  });

  describe('Resolution scenario 5: Registry fallback', () => {
    it('uses default project from registry', async () => {
      const registeredWorkspace = await createTempWorkspace('registered-');
      await createCmosDatabase(registeredWorkspace);

      // Set up the GRAPH registry with a default project
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Point cwd to non-CMOS directory
      process.cwd = () => workspace;

      const result = await CmosDatabaseClient.create();

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(registeredWorkspace);
      result.data?.close();

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });

    it('fails with actionable error when no fallback available', async () => {
      // Empty cwd, no env, empty graph registry
      process.cwd = () => workspace;
      await ProjectGraphRegistry.create({ configDir });

      const result = await CmosDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.CMOS_NOT_DETECTED);
      // Sprint 53 m02: suggestion references projectRoot / register — not env var.
      expect(result.error?.suggestion).toMatch(/projectRoot|cmos_project_register/);
      expect(result.error?.suggestion).not.toContain('CMOS_PROJECT_ROOT');
    });
  });

  describe('Resolution scenario 6: Priority order', () => {
    it('explicit projectRoot beats env var', async () => {
      const envWorkspace = await createTempWorkspace('env-');
      await createCmosDatabase(workspace);
      await createCmosDatabase(envWorkspace);

      process.env['CMOS_PROJECT_ROOT'] = envWorkspace;

      const result = await CmosDatabaseClient.create({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      expect(result.data?.path).not.toContain(envWorkspace);
      result.data?.close();

      await fs.rm(envWorkspace, { recursive: true, force: true });
    });

    it('Sprint 53 m02: cwd beats env var (env is ignored, cwd auto-discovers)', async () => {
      const cwdWorkspace = await createTempWorkspace('cwd-');
      await createCmosDatabase(workspace);
      await createCmosDatabase(cwdWorkspace);

      process.env['CMOS_PROJECT_ROOT'] = workspace;
      process.cwd = () => cwdWorkspace;

      const result = await CmosDatabaseClient.create();

      // Env step was removed; cwd auto-discovery wins.
      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(cwdWorkspace);
      result.data?.close();

      await fs.rm(cwdWorkspace, { recursive: true, force: true });
    });

    it('auto-discover beats registry', async () => {
      const registeredWorkspace = await createTempWorkspace('registered-');
      await createCmosDatabase(workspace);
      await createCmosDatabase(registeredWorkspace);

      // Set up a graph default (which auto-discovery should beat)
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Point cwd to workspace with CMOS
      process.cwd = () => workspace;

      const result = await CmosDatabaseClient.create();

      expect(result.success).toBe(true);
      expect(result.data?.path).toContain(workspace);
      result.data?.close();

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 7: Stale registry entries', () => {
    it('skips stale default project and fails gracefully', async () => {
      const registeredWorkspace = await createTempWorkspace('stale-');
      await createCmosDatabase(registeredWorkspace);

      // Register and set as default in the GRAPH
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Remove the CMOS database (making it stale)
      await fs.rm(path.join(registeredWorkspace, 'cmos'), { recursive: true, force: true });
      CmosDetector.resetInstance();

      // Point cwd to non-CMOS directory
      process.cwd = () => workspace;

      const result = await CmosDatabaseClient.create();

      // Should fail because default is stale and no other option
      expect(result.success).toBe(false);

      await fs.rm(registeredWorkspace, { recursive: true, force: true });
    });
  });

  describe('Resolution scenario 8: Multiple valid options', () => {
    it('correctly prioritizes when all options available', async () => {
      const dbPath = await createCmosDatabase(workspace);
      const envWorkspace = await createTempWorkspace('env-');
      const cwdWorkspace = await createTempWorkspace('cwd-');
      const registeredWorkspace = await createTempWorkspace('registered-');

      await createCmosDatabase(envWorkspace);
      await createCmosDatabase(cwdWorkspace);
      await createCmosDatabase(registeredWorkspace);

      process.env['CMOS_PROJECT_ROOT'] = envWorkspace;
      process.cwd = () => cwdWorkspace;

      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(registeredWorkspace, { setAsDefault: true });

      // Explicit dbPath should win
      const result = await CmosDatabaseClient.create({ dbPath });

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

      const result = await CmosDatabaseClient.create();

      expect(result.success).toBe(false);
      expect(result.error?.suggestion).toBeDefined();
      expect(result.error?.suggestion?.length).toBeGreaterThan(0);

      // Should mention at least one resolution option
      const suggestion = result.error?.suggestion || '';
      const mentionsOption =
        suggestion.includes('CMOS_PROJECT_ROOT') ||
        suggestion.includes('projectRoot') ||
        suggestion.includes('cmos_project_register') ||
        suggestion.includes('cmos/db/cmos.sqlite');
      expect(mentionsOption).toBe(true);
    });
  });

  describe('Fan-out Scenario 9 (Sprint 55 m01): project-scope regression for sprint/mission reads', () => {
    it('cmos_sprint(list) with explicit projectRoot returns only that project’s sprints', async () => {
      const { cmosSprintList } = await import('../../../src/tools/cmos/cmos-sprint-list');
      const wsA = await createTempWorkspace('scope-sprintlist-a-');
      const wsB = await createTempWorkspace('scope-sprintlist-b-');
      await createCmosDatabase(wsA);
      await createCmosDatabase(wsB);

      // Seed distinct sprint rows per workspace. sprint_summary is a view over
      // missions + strategic_decisions on a real schema; for this test we stub
      // the minimal schema needed by cmosSprintList directly.
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
            decisions_count INTEGER DEFAULT 0
          );
        `);
        const stmt = conn.prepare('INSERT INTO sprint_summary (sprint_id, title) VALUES (?, ?)');
        for (const r of rows) stmt.run(r.id, r.title);
        conn.close();
      };
      seedSprints(path.join(wsA, 'cmos', 'db', 'cmos.sqlite'), [
        { id: 'sprint-a1', title: 'Workspace A Sprint 1' },
      ]);
      seedSprints(path.join(wsB, 'cmos', 'db', 'cmos.sqlite'), [
        { id: 'sprint-b1', title: 'Workspace B Sprint 1' },
        { id: 'sprint-b2', title: 'Workspace B Sprint 2' },
      ]);

      // Register both projects in an isolated graph registry, so the fallback
      // cannot leak cross-project data if the pin is wrong.
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(wsA);
      graph.registerStore(wsB);

      const resultA = await cmosSprintList({ projectRoot: wsA });
      expect(resultA.success).toBe(true);
      expect(resultA.data?.sprints.map((s) => s.id)).toEqual(['sprint-a1']);

      const resultB = await cmosSprintList({ projectRoot: wsB });
      expect(resultB.success).toBe(true);
      expect(resultB.data?.sprints.map((s) => s.id).sort()).toEqual(['sprint-b1', 'sprint-b2']);

      await fs.rm(wsA, { recursive: true, force: true });
      await fs.rm(wsB, { recursive: true, force: true });
    });
  });
});
