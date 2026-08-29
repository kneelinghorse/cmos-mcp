// ABOUTME: s80-m01 — unit suites for the graph-native project-root resolver,
// ABOUTME: relocated from project-registry.test.ts and seeding the GRAPH default.

/**
 * Resolver unit tests (s80-m01).
 *
 * `resolveProjectRootEnhanced` / `resolveProjectRootPath` moved out of the JSON
 * `project-registry.ts` into `intelligence/project-resolution.ts` and now read/write
 * ONLY the {@link ProjectGraphRegistry}. These suites — carried over from
 * `project-registry.test.ts` — seed the GRAPH default (Step-4 fallback) instead of the
 * JSON default, and assert auto-register writes land in the graph.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  resolveProjectRootEnhanced,
  resolveProjectRootPath,
  ProjectResolutionError,
} from '../../src/intelligence/project-resolution';
import { seedCmosDb } from '../helpers/seedCmosDb';

async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function ensureCmosDatabase(workspace: string): Promise<string> {
  const dbPath = path.join(workspace, 'cmos', 'db');
  await fs.mkdir(dbPath, { recursive: true });
  const sqlitePath = path.join(dbPath, 'cmos.sqlite');
  await fs.writeFile(sqlitePath, 'pragma user_version = 1;\n');
  return sqlitePath;
}

describe('resolveProjectRootEnhanced (graph-native)', () => {
  let workspace: string;
  let configDir: string;
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    workspace = await createTempWorkspace('resolve-');
    configDir = await createTempWorkspace('config-resolve-');
    CmosDetector.resetInstance();
    // Reset the graph singleton so its one-time backfill (which reads the legacy
    // project-registry.json) binds to THIS test's configDir, not a stale one.
    ProjectGraphRegistry.resetInstance();
    process.env = { ...originalEnv };
    delete process.env['CMOS_PROJECT_ROOT'];
    await ProjectGraphRegistry.create({ configDir });
  });

  afterEach(async () => {
    process.env = originalEnv;
    process.cwd = originalCwd;
    ProjectGraphRegistry.resetInstance();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('step 1: uses explicit parameter first', async () => {
    const result = await resolveProjectRootEnhanced(workspace);
    expect(result.source).toBe('explicit');
    expect(result.projectRoot).toBe(workspace);
  });

  it('Sprint 53 m02: CMOS_PROJECT_ROOT env var is NOT consulted', async () => {
    // Env Step 2 was removed in Sprint 53 m02 — the env var is retained only
    // for .env bootstrap at src/index.ts:17, never at resolution time. With
    // only the env set and no cwd CMOS / no graph default, resolution fails.
    process.env['CMOS_PROJECT_ROOT'] = workspace;
    await ensureCmosDatabase(workspace);
    process.cwd = () => '/tmp/definitely-no-cmos-here-' + Date.now();
    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );
  });

  it('step 3: auto-discovers from cwd', async () => {
    await ensureCmosDatabase(workspace);
    process.cwd = () => workspace;

    const result = await resolveProjectRootEnhanced(undefined, {
      autoRegister: false,
      silent: true,
    });
    expect(result.source).toBe('auto-discover');
    expect(result.projectRoot).toBe(workspace);
  });

  it('step 3: auto-registers a discovered store that already records identity into the GRAPH', async () => {
    seedCmosDb(workspace, { projectId: 'resolver-id', projectName: 'resolver-project' });
    process.cwd = () => workspace;

    const result = await resolveProjectRootEnhanced(undefined, {
      autoRegister: true,
      silent: true,
    });
    expect(result.source).toBe('auto-discover');
    expect(result.autoRegistered).toBe(true);

    // Verify it landed in the graph registry (not a JSON file).
    const graph = ProjectGraphRegistry.getInstance({ configDir });
    expect(graph.getByStorePath(workspace)).toBe('resolver-id');
  });

  it('step 3: auto-discovery does not mint or register an identity-less store', async () => {
    const dbPath = seedCmosDb(workspace, { projectId: '', projectName: 'identityless' });
    process.cwd = () => workspace;

    const result = await resolveProjectRootEnhanced(undefined, {
      autoRegister: true,
      silent: true,
    });
    expect(result.source).toBe('auto-discover');
    expect(result.autoRegistered).toBeUndefined();

    const graph = ProjectGraphRegistry.getInstance({ configDir });
    expect(graph.getByStorePath(workspace)).toBeNull();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as
        | { value: string }
        | undefined;
      expect(row?.value ?? '').toBe('');
    } finally {
      db.close();
    }
  });

  it('step 4: falls back to the graph default project', async () => {
    // Seed a default project in the GRAPH registry.
    const defaultWorkspace = await createTempWorkspace('default-');
    await ensureCmosDatabase(defaultWorkspace);

    const graph = ProjectGraphRegistry.getInstance({ configDir });
    graph.registerStore(defaultWorkspace, { setAsDefault: true });

    // Point cwd to empty directory (no CMOS)
    process.cwd = () => workspace;

    const result = await resolveProjectRootEnhanced(undefined, { silent: true });
    expect(result.source).toBe('registry');
    expect(result.projectRoot).toBe(path.resolve(defaultWorkspace));

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 4: skips a stale graph default and throws', async () => {
    const defaultWorkspace = await createTempWorkspace('stale-default-');
    await ensureCmosDatabase(defaultWorkspace);

    const graph = ProjectGraphRegistry.getInstance({ configDir });
    graph.registerStore(defaultWorkspace, { setAsDefault: true });

    // Remove the store's CMOS so the default no longer detects.
    await fs.rm(path.join(defaultWorkspace, 'cmos'), { recursive: true, force: true });
    CmosDetector.resetInstance();
    process.cwd = () => workspace;

    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 5: throws error when no project found', async () => {
    // Point cwd to empty directory (no CMOS); graph has no default.
    process.cwd = () => workspace;

    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );
  });

  it('error includes actionable suggestion', async () => {
    process.cwd = () => workspace;

    try {
      await resolveProjectRootEnhanced(undefined, { silent: true });
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectResolutionError);
      const resolutionError = error as ProjectResolutionError;
      // Sprint 53 m02: the env-var hint was removed from the suggestion because
      // env is no longer a resolution option. Callers should pass projectRoot
      // explicitly or register a default project.
      expect(resolutionError.suggestion).toContain('projectRoot');
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(resolutionError.suggestion).toContain('cmos_project(action="register"');
      expect(resolutionError.suggestion).not.toContain('CMOS_PROJECT_ROOT');
    }
  });

  it('respects priority order', async () => {
    await ensureCmosDatabase(workspace);

    const explicitPath = '/explicit/path';
    process.env['CMOS_PROJECT_ROOT'] = '/env/path';
    process.cwd = () => workspace;

    // Explicit wins over env and cwd
    const result = await resolveProjectRootEnhanced(explicitPath);
    expect(result.source).toBe('explicit');
    expect(result.projectRoot).toBe(explicitPath);
  });
});

describe('resolveProjectRootPath (graph-native)', () => {
  let workspace: string;
  let configDir: string;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    workspace = await createTempWorkspace('resolve-path-');
    configDir = await createTempWorkspace('config-resolve-path-');
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    await ProjectGraphRegistry.create({ configDir });
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    ProjectGraphRegistry.resetInstance();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('returns string path', async () => {
    await ensureCmosDatabase(workspace);
    process.cwd = () => workspace;

    const result = await resolveProjectRootPath();
    expect(typeof result).toBe('string');
    expect(result).toBe(workspace);
  });

  it('throws on failure', async () => {
    process.cwd = () => workspace; // No CMOS here

    await expect(resolveProjectRootPath()).rejects.toThrow();
  });
});
