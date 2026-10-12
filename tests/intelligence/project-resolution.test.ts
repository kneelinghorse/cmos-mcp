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

import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  resolveProjectRootEnhanced,
  resolveProjectRootPath,
  ProjectResolutionError,
} from '../../src/intelligence/project-resolution';
import { setServerProjectRoot } from '../../src/intelligence/resolution-policy';
import { seedRbookDb } from '../helpers/seedRbookDb';

async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function ensureRbookDatabase(workspace: string): Promise<string> {
  const dbPath = path.join(workspace, 'rbook', 'db');
  await fs.mkdir(dbPath, { recursive: true });
  const sqlitePath = path.join(dbPath, 'rbook.sqlite');
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
    RbookDetector.resetInstance();
    // Reset the graph singleton so its one-time backfill (which reads the legacy
    // project-registry.json) binds to THIS test's configDir, not a stale one.
    ProjectGraphRegistry.resetInstance();
    process.env = { ...originalEnv };
    delete process.env['RBOOK_PROJECT_ROOT'];
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

  it('Sprint 53 m02: RBOOK_PROJECT_ROOT env var is NOT consulted', async () => {
    // Env Step 2 was removed in Sprint 53 m02 — the env var is retained only
    // for .env bootstrap at src/index.ts:17, never at resolution time. With
    // only the env set and no cwd Reasonbook / no graph default, resolution fails.
    process.env['RBOOK_PROJECT_ROOT'] = workspace;
    await ensureRbookDatabase(workspace);
    process.cwd = () => '/tmp/definitely-no-rbook-here-' + Date.now();
    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );
  });

  it('step 3: auto-discovers from cwd', async () => {
    await ensureRbookDatabase(workspace);
    process.cwd = () => workspace;

    const result = await resolveProjectRootEnhanced(undefined, {
      autoRegister: false,
      silent: true,
    });
    expect(result.source).toBe('auto-discover');
    expect(result.projectRoot).toBe(workspace);
  });

  it('step 3: auto-registers a discovered store that already records identity into the GRAPH', async () => {
    seedRbookDb(workspace, { projectId: 'resolver-id', projectName: 'resolver-project' });
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
    const dbPath = seedRbookDb(workspace, { projectId: '', projectName: 'identityless' });
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

  it('step 4: a contextless cwd falls back to a CONFIRMED graph default', async () => {
    // s92-m01: a default only serves a contextless call (cwd of /, $HOME or the install root).
    const defaultWorkspace = await createTempWorkspace('default-');
    await ensureRbookDatabase(defaultWorkspace);

    const graph = ProjectGraphRegistry.getInstance({ configDir });
    graph.registerStore(defaultWorkspace, { setAsDefault: true });

    process.cwd = () => '/';

    const result = await resolveProjectRootEnhanced(undefined, { silent: true });
    expect(result.source).toBe('registry');
    expect(result.projectRoot).toBe(path.resolve(defaultWorkspace));

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 4: an unconfirmed (pre-3.2.0) default is never applied', async () => {
    const defaultWorkspace = await createTempWorkspace('unconfirmed-default-');
    await ensureRbookDatabase(defaultWorkspace);

    const graph = ProjectGraphRegistry.getInstance({ configDir });
    const entry = graph.registerStore(defaultWorkspace);
    graph.setDefault(entry.project_id); // written the pre-3.2.0 way: no confirmation

    process.cwd = () => '/';
    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 4: a real working folder never falls back to a default, even a confirmed one', async () => {
    const defaultWorkspace = await createTempWorkspace('confirmed-default-');
    await ensureRbookDatabase(defaultWorkspace);
    ProjectGraphRegistry.getInstance({ configDir }).registerStore(defaultWorkspace, {
      setAsDefault: true,
    });

    process.cwd = () => workspace; // a store-less working folder, not contextless
    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      `No Reasonbook project in '${workspace}'`
    );

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 4: a contextless cwd uses the server --project-root before the registry', async () => {
    const pinned = await createTempWorkspace('pinned-');
    await ensureRbookDatabase(pinned);
    setServerProjectRoot(pinned);
    try {
      process.cwd = () => '/';
      const result = await resolveProjectRootEnhanced(undefined, { silent: true });
      expect(result.source).toBe('server-project-root');
      expect(result.projectRoot).toBe(path.resolve(pinned));
    } finally {
      setServerProjectRoot(undefined);
      await fs.rm(pinned, { recursive: true, force: true });
    }
  });

  it('step 3: a cwd inside a project resolves to the enclosing store', async () => {
    await ensureRbookDatabase(workspace);
    const nested = path.join(workspace, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    process.cwd = () => nested;

    const result = await resolveProjectRootEnhanced(undefined, {
      autoRegister: false,
      silent: true,
    });
    expect(result.source).toBe('auto-discover');
    expect(result.projectRoot).toBe(workspace);
  });

  it('step 4: skips a stale graph default and throws', async () => {
    const defaultWorkspace = await createTempWorkspace('stale-default-');
    await ensureRbookDatabase(defaultWorkspace);

    const graph = ProjectGraphRegistry.getInstance({ configDir });
    graph.registerStore(defaultWorkspace, { setAsDefault: true });

    // Remove the store's Reasonbook so the default no longer detects.
    await fs.rm(path.join(defaultWorkspace, 'rbook'), { recursive: true, force: true });
    RbookDetector.resetInstance();
    process.cwd = () => '/';

    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 5: throws error when no project found', async () => {
    // Point cwd to empty directory (no Reasonbook); graph has no default.
    process.cwd = () => workspace;

    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );
  });

  it('error includes actionable suggestion', async () => {
    const suggestionFrom = async (cwd: string): Promise<string> => {
      process.cwd = () => cwd;
      try {
        await resolveProjectRootEnhanced(undefined, { silent: true });
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectResolutionError);
        return (error as ProjectResolutionError).suggestion;
      }
      throw new Error('Should have thrown');
    };

    // Sprint 53 m02: the env-var hint was removed because env is no longer a resolution option.
    const fromFolder = await suggestionFrom(workspace);
    expect(fromFolder).toContain('projectRoot');
    expect(fromFolder).toContain(
      `rbook_project(action="init", projectRoot=${JSON.stringify(workspace)})`
    );
    expect(fromFolder).not.toContain('RBOOK_PROJECT_ROOT');
    // s92-m01: a default cannot serve a real working folder, so none is offered there…
    expect(fromFolder).not.toContain('setAsDefault');

    // …while a contextless cwd is offered both default routes.
    const fromRoot = await suggestionFrom('/');
    expect(fromRoot).toContain('--project-root');
    expect(fromRoot).toContain('rbook_project(action="register"');
  });

  it('respects priority order', async () => {
    await ensureRbookDatabase(workspace);

    const explicitPath = '/explicit/path';
    process.env['RBOOK_PROJECT_ROOT'] = '/env/path';
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
    RbookDetector.resetInstance();
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
    await ensureRbookDatabase(workspace);
    process.cwd = () => workspace;

    const result = await resolveProjectRootPath();
    expect(typeof result).toBe('string');
    expect(result).toBe(workspace);
  });

  it('throws on failure', async () => {
    process.cwd = () => workspace; // No Reasonbook here

    await expect(resolveProjectRootPath()).rejects.toThrow();
  });
});
