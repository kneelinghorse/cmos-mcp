import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../src/intelligence/cmos-detector';
import {
  ProjectRegistry,
  resolveProjectRootEnhanced,
  resolveProjectRootPath,
  ProjectResolutionError,
  type RegisteredProject,
} from '../../src/intelligence/project-registry';

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

describe('ProjectRegistry', () => {
  let workspace: string;
  let configDir: string;
  let registry: ProjectRegistry;

  beforeEach(async () => {
    workspace = await createTempWorkspace('project-registry-');
    configDir = await createTempWorkspace('config-');
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    registry = await ProjectRegistry.create({ configDir });
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('getInstance', () => {
    it('returns singleton instance', () => {
      ProjectRegistry.resetInstance();
      const instance1 = ProjectRegistry.getInstance({ configDir });
      const instance2 = ProjectRegistry.getInstance({ configDir });
      expect(instance1).toBe(instance2);
    });

    it('resetInstance clears singleton', () => {
      ProjectRegistry.resetInstance();
      const instance1 = ProjectRegistry.getInstance({ configDir });
      ProjectRegistry.resetInstance();
      const instance2 = ProjectRegistry.getInstance({ configDir });
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('create', () => {
    it('creates config directory if not exists', async () => {
      const newConfigDir = path.join(workspace, 'new-config');
      ProjectRegistry.resetInstance();
      await ProjectRegistry.create({ configDir: newConfigDir });
      const exists = await fs
        .access(newConfigDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('register', () => {
    it('registers a project with CMOS database', async () => {
      await ensureCmosDatabase(workspace);
      const result = await registry.register(workspace);

      expect(result.success).toBe(true);
      expect(result.project).toBeDefined();
      expect(result.project?.projectRoot).toBe(workspace);
      expect(result.wasAlreadyRegistered).toBe(false);
    });

    it('fails to register project without CMOS database', async () => {
      const result = await registry.register(workspace);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No CMOS database found');
    });

    it('updates existing registration', async () => {
      await ensureCmosDatabase(workspace);

      const first = await registry.register(workspace, { name: 'First Name' });
      expect(first.success).toBe(true);
      expect(first.project?.name).toBe('First Name');

      // Re-register with new name
      const second = await registry.register(workspace, { name: 'Second Name' });
      expect(second.success).toBe(true);
      expect(second.wasAlreadyRegistered).toBe(true);
      expect(second.project?.name).toBe('Second Name');

      // Verify only one project exists
      const projects = await registry.list();
      expect(projects).toHaveLength(1);
    });

    it('sets project as default when requested', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { setAsDefault: true });

      const defaultProject = await registry.getDefault();
      expect(defaultProject?.projectRoot).toBe(workspace);
    });

    it('preserves registeredAt on update', async () => {
      await ensureCmosDatabase(workspace);

      const first = await registry.register(workspace);
      const originalRegisteredAt = first.project?.registeredAt;

      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await registry.register(workspace, { name: 'Updated' });
      expect(second.project?.registeredAt).toBe(originalRegisteredAt);
    });

    it('stores metadata', async () => {
      await ensureCmosDatabase(workspace);
      const metadata = { version: '1.0', custom: 'data' };
      const result = await registry.register(workspace, { metadata });

      expect(result.project?.metadata).toEqual(metadata);
    });
  });

  describe('unregister', () => {
    it('removes registered project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      const result = await registry.unregister(workspace);
      expect(result.success).toBe(true);

      const projects = await registry.list();
      expect(projects).toHaveLength(0);
    });

    it('fails for non-existent project', async () => {
      const result = await registry.unregister('/nonexistent/path');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found in registry');
    });

    it('clears default when unregistering default project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { setAsDefault: true });

      const result = await registry.unregister(workspace);
      expect(result.success).toBe(true);
      expect(result.wasDefault).toBe(true);

      const defaultProject = await registry.getDefault();
      expect(defaultProject).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns empty array when no projects', async () => {
      const projects = await registry.list();
      expect(projects).toEqual([]);
    });

    it('returns all registered projects', async () => {
      const workspace2 = await createTempWorkspace('project-registry-2-');
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);

      await registry.register(workspace, { name: 'Project 1' });
      await registry.register(workspace2, { name: 'Project 2' });

      const projects = await registry.list();
      expect(projects).toHaveLength(2);
      expect(projects.map((p) => p.name).sort()).toEqual(['Project 1', 'Project 2']);

      await fs.rm(workspace2, { recursive: true, force: true });
    });
  });

  describe('getProject', () => {
    it('returns project by path', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'My Project' });

      const project = await registry.getProject(workspace);
      expect(project).toBeDefined();
      expect(project?.name).toBe('My Project');
    });

    it('returns undefined for non-existent project', async () => {
      const project = await registry.getProject('/nonexistent');
      expect(project).toBeUndefined();
    });

    it('resolves relative paths', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      // Use relative-like path that resolves to same location
      const resolved = path.resolve(workspace);
      const project = await registry.getProject(resolved);
      expect(project).toBeDefined();
    });
  });

  describe('getDefault / setDefault / clearDefault', () => {
    it('returns undefined when no default', async () => {
      const defaultProject = await registry.getDefault();
      expect(defaultProject).toBeUndefined();
    });

    it('sets and gets default project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Default Project' });

      const success = await registry.setDefault(workspace);
      expect(success).toBe(true);

      const defaultProject = await registry.getDefault();
      expect(defaultProject?.name).toBe('Default Project');
    });

    it('setDefault fails for unregistered project', async () => {
      const success = await registry.setDefault('/nonexistent');
      expect(success).toBe(false);
    });

    it('clearDefault removes default', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { setAsDefault: true });

      await registry.clearDefault();

      const defaultProject = await registry.getDefault();
      expect(defaultProject).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('returns active for valid project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      const validations = await registry.validate();
      expect(validations).toHaveLength(1);
      expect(validations[0].status).toBe('active');
      expect(validations[0].exists).toBe(true);
      expect(validations[0].hasCmosDatabase).toBe(true);
    });

    it('returns stale when CMOS database removed', async () => {
      const sqlitePath = await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      // Remove database
      await fs.unlink(sqlitePath);
      CmosDetector.resetInstance();

      const validations = await registry.validate();
      expect(validations).toHaveLength(1);
      expect(validations[0].status).toBe('stale');
      expect(validations[0].exists).toBe(true);
      expect(validations[0].hasCmosDatabase).toBe(false);
    });

    it('returns missing when directory removed', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      // Remove entire workspace
      await fs.rm(workspace, { recursive: true, force: true });

      const validations = await registry.validate();
      expect(validations).toHaveLength(1);
      expect(validations[0].status).toBe('missing');
      expect(validations[0].exists).toBe(false);
    });

    it('validates multiple projects', async () => {
      const workspace2 = await createTempWorkspace('project-registry-valid-');
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      await registry.register(workspace);
      await registry.register(workspace2);

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      const validations = await registry.validate();
      expect(validations).toHaveLength(2);

      const statuses = validations.map((v) => v.status);
      expect(statuses).toContain('active');
      expect(statuses).toContain('missing');
    });
  });

  describe('prune', () => {
    it('removes stale and missing projects', async () => {
      const workspace2 = await createTempWorkspace('project-registry-prune-');
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      await registry.register(workspace);
      await registry.register(workspace2);

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      const removed = await registry.prune();
      expect(removed).toBe(1);

      const projects = await registry.list();
      expect(projects).toHaveLength(1);
      expect(projects[0].projectRoot).toBe(workspace);
    });

    it('clears default when pruning default project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { setAsDefault: true });

      // Remove workspace
      await fs.rm(workspace, { recursive: true, force: true });

      await registry.prune();

      const defaultProject = await registry.getDefault();
      expect(defaultProject).toBeUndefined();
    });

    it('returns 0 when nothing to prune', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      const removed = await registry.prune();
      expect(removed).toBe(0);
    });
  });

  describe('touch', () => {
    it('updates lastAccessedAt', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      const before = await registry.getProject(workspace);
      const originalTime = before?.lastAccessedAt;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      await registry.touch(workspace);

      const after = await registry.getProject(workspace);
      expect(after?.lastAccessedAt).not.toBe(originalTime);
    });

    it('does nothing for non-existent project', async () => {
      // Should not throw
      await registry.touch('/nonexistent');
    });
  });

  describe('cache behavior', () => {
    it('clearCache forces reload from disk', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      // Modify registry file directly
      const registryPath = registry.path;
      const content = await fs.readFile(registryPath, 'utf-8');
      const data = JSON.parse(content);
      data.projects[workspace].name = 'Modified Externally';
      await fs.writeFile(registryPath, JSON.stringify(data));

      // Without clearing cache, should see old value
      const beforeClear = await registry.getProject(workspace);
      expect(beforeClear?.name).not.toBe('Modified Externally');

      // After clearing cache, should see new value
      registry.clearCache();
      const afterClear = await registry.getProject(workspace);
      expect(afterClear?.name).toBe('Modified Externally');
    });
  });

  describe('path property', () => {
    it('returns registry file path', () => {
      expect(registry.path).toContain('project-registry.json');
      expect(registry.path).toContain(configDir);
    });
  });

  describe('file permissions', () => {
    it('creates registry with restricted permissions', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace);

      const stats = await fs.stat(registry.path);
      // File should be readable/writable only by owner (0o600)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('CMOS_CONFIG_DIR env fallback', () => {
    const ENV_KEY = 'CMOS_CONFIG_DIR';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = savedEnv;
      }
    });

    it('uses CMOS_CONFIG_DIR when no explicit configDir is passed', async () => {
      const envDir = await createTempWorkspace('env-fallback-');
      process.env[ENV_KEY] = envDir;

      ProjectRegistry.resetInstance();
      const envRegistry = await ProjectRegistry.create();

      expect(envRegistry.path.startsWith(envDir)).toBe(true);

      await fs.rm(envDir, { recursive: true, force: true });
    });

    it('explicit configDir wins over env var', async () => {
      const envDir = await createTempWorkspace('env-loses-');
      process.env[ENV_KEY] = envDir;

      ProjectRegistry.resetInstance();
      const explicitRegistry = await ProjectRegistry.create({ configDir });

      expect(explicitRegistry.path.startsWith(configDir)).toBe(true);
      expect(explicitRegistry.path.startsWith(envDir)).toBe(false);

      await fs.rm(envDir, { recursive: true, force: true });
    });
  });

  describe('corrupted registry handling', () => {
    it('recovers from corrupted JSON', async () => {
      // Write corrupted JSON
      await fs.writeFile(path.join(configDir, 'project-registry.json'), 'not valid json');

      ProjectRegistry.resetInstance();
      const newRegistry = await ProjectRegistry.create({ configDir });

      // Should work fine with fresh registry
      await ensureCmosDatabase(workspace);
      const result = await newRegistry.register(workspace);
      expect(result.success).toBe(true);
    });

    it('recovers from invalid structure', async () => {
      // Write valid JSON but invalid structure
      await fs.writeFile(
        path.join(configDir, 'project-registry.json'),
        JSON.stringify({ invalid: 'structure' })
      );

      ProjectRegistry.resetInstance();
      const newRegistry = await ProjectRegistry.create({ configDir });

      await ensureCmosDatabase(workspace);
      const result = await newRegistry.register(workspace);
      expect(result.success).toBe(true);
    });
  });
});

describe('resolveProjectRootEnhanced', () => {
  let workspace: string;
  let configDir: string;
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    workspace = await createTempWorkspace('resolve-');
    configDir = await createTempWorkspace('config-resolve-');
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    process.env = { ...originalEnv };
    delete process.env['CMOS_PROJECT_ROOT'];
    await ProjectRegistry.create({ configDir });
  });

  afterEach(async () => {
    process.env = originalEnv;
    process.cwd = originalCwd;
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
    // only the env set and no cwd CMOS / no registry default, resolution fails.
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

  it('step 3: auto-registers discovered project', async () => {
    await ensureCmosDatabase(workspace);
    process.cwd = () => workspace;

    // Initialize registry with custom config dir
    await ProjectRegistry.create({ configDir });

    const result = await resolveProjectRootEnhanced(undefined, {
      autoRegister: true,
      silent: true,
    });
    expect(result.source).toBe('auto-discover');
    expect(result.autoRegistered).toBe(true);

    // Verify it was registered
    const registry = ProjectRegistry.getInstance({ configDir });
    const project = await registry.getProject(workspace);
    expect(project).toBeDefined();
  });

  it('step 4: falls back to registry default', async () => {
    // Set up a default project in registry
    const defaultWorkspace = await createTempWorkspace('default-');
    await ensureCmosDatabase(defaultWorkspace);

    const registry = await ProjectRegistry.create({ configDir });
    await registry.register(defaultWorkspace, { setAsDefault: true });

    // Point cwd to empty directory (no CMOS)
    process.cwd = () => workspace;

    const result = await resolveProjectRootEnhanced(undefined, { silent: true });
    expect(result.source).toBe('registry');
    expect(result.projectRoot).toBe(defaultWorkspace);

    await fs.rm(defaultWorkspace, { recursive: true, force: true });
  });

  it('step 5: throws error when no project found', async () => {
    // Point cwd to empty directory (no CMOS)
    process.cwd = () => workspace;

    // Empty registry
    await ProjectRegistry.create({ configDir });

    await expect(resolveProjectRootEnhanced(undefined, { silent: true })).rejects.toThrow(
      ProjectResolutionError
    );
  });

  it('error includes actionable suggestion', async () => {
    process.cwd = () => workspace;
    await ProjectRegistry.create({ configDir });

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
      expect(resolutionError.suggestion).toContain('cmos_project_register');
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

describe('resolveProjectRootPath', () => {
  let workspace: string;
  let configDir: string;
  const originalCwd = process.cwd;

  beforeEach(async () => {
    workspace = await createTempWorkspace('resolve-path-');
    configDir = await createTempWorkspace('config-resolve-path-');
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    await ProjectRegistry.create({ configDir });
  });

  afterEach(async () => {
    process.cwd = originalCwd;
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
