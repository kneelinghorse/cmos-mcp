/**
 * cmos_project_list Tool Tests
 *
 * Tests for the MCP tool that lists registered CMOS projects.
 *
 * @module tests/tools/cmos/cmos-project-list
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../../src/intelligence/project-registry';
import {
  cmosProjectList,
  cmosProjectListToolDefinition,
  formatProjectListForLLM,
} from '../../../src/tools/cmos/cmos-project-list';

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

describe('cmos_project_list', () => {
  let workspace: string;
  let workspace2: string;
  let configDir: string;
  let registry: ProjectRegistry;

  beforeEach(async () => {
    workspace = await createTempWorkspace('cmos-project-list-');
    workspace2 = await createTempWorkspace('cmos-project-list-2-');
    configDir = await createTempWorkspace('config-');
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    registry = await ProjectRegistry.create({ configDir });
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(workspace2, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('basic functionality', () => {
    it('should return empty list when no projects registered', async () => {
      const result = await cmosProjectList({});

      expect(result.success).toBe(true);
      expect(result.data?.projects).toEqual([]);
      expect(result.data?.summary.total).toBe(0);
    });

    it('should list registered projects', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Project 1' });

      const result = await cmosProjectList({});

      expect(result.success).toBe(true);
      expect(result.data?.projects).toHaveLength(1);
      expect(result.data?.projects[0].name).toBe('Project 1');
      expect(result.data?.projects[0].projectRoot).toBe(workspace);
    });

    it('should list multiple projects', async () => {
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      await registry.register(workspace, { name: 'Project 1' });
      await registry.register(workspace2, { name: 'Project 2' });

      const result = await cmosProjectList({});

      expect(result.success).toBe(true);
      expect(result.data?.projects).toHaveLength(2);
      expect(result.data?.summary.total).toBe(2);
    });

    it('should indicate default project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Default Project', setAsDefault: true });

      const result = await cmosProjectList({});

      expect(result.success).toBe(true);
      const defaultProject = result.data?.projects.find((p) => p.isDefault);
      expect(defaultProject?.name).toBe('Default Project');
    });

    it('should return registry path', async () => {
      const result = await cmosProjectList({});

      expect(result.success).toBe(true);
      expect(result.data?.registryPath).toContain('project-registry.json');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosProjectListToolDefinition.name).toBe('cmos_project_list');
    });

    it('should have no required parameters', () => {
      // The schema has no 'required' field since all params are optional
      const schema = cmosProjectListToolDefinition.inputSchema as { required?: string[] };
      expect(schema.required).toBeUndefined();
    });

    it('should have descriptive description', () => {
      expect(cmosProjectListToolDefinition.description).toContain('List');
      expect(cmosProjectListToolDefinition.description).toContain('registered');
    });
  });

  describe('formatProjectListForLLM', () => {
    it('should format empty list', async () => {
      const result = await cmosProjectList({});
      const formatted = formatProjectListForLLM(result);

      expect(formatted).toContain('No projects registered');
      expect(formatted).toContain('cmos_project_register');
    });

    it('should format project list', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'My Project' });

      const result = await cmosProjectList({});
      const formatted = formatProjectListForLLM(result);

      expect(formatted).toContain('📋');
      expect(formatted).toContain('My Project');
      expect(formatted).toContain('(1)');
    });

    it('should indicate default project', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Default', setAsDefault: true });

      const result = await cmosProjectList({});
      const formatted = formatProjectListForLLM(result);

      expect(formatted).toContain('(default)');
    });

    it('should show project paths', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'My Project' });

      const result = await cmosProjectList({});
      const formatted = formatProjectListForLLM(result);

      expect(formatted).toContain(workspace);
    });
  });

  describe('liveness check', () => {
    it('should set dbExists true when database is present', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Live Project' });

      const result = await cmosProjectList({});

      expect(result.data?.projects[0].dbExists).toBe(true);
      expect(result.data?.missingCount).toBe(0);
    });

    it('should set dbExists false when database has been deleted', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Dead Project' });
      // Delete the DB after registration
      await fs.rm(path.join(workspace, 'cmos'), { recursive: true, force: true });

      const result = await cmosProjectList({});

      expect(result.data?.projects[0].dbExists).toBe(false);
      expect(result.data?.missingCount).toBe(1);
    });

    it('should report correct missingCount across mixed entries', async () => {
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      await registry.register(workspace, { name: 'Live' });
      await registry.register(workspace2, { name: 'Dead' });
      await fs.rm(path.join(workspace2, 'cmos'), { recursive: true, force: true });

      const result = await cmosProjectList({});

      expect(result.data?.missingCount).toBe(1);
      expect(result.data?.projects.find((p) => p.name === 'Live')?.dbExists).toBe(true);
      expect(result.data?.projects.find((p) => p.name === 'Dead')?.dbExists).toBe(false);
    });

    it('should flag [MISSING] in formatted output for dead entries', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Dead Project' });
      await fs.rm(path.join(workspace, 'cmos'), { recursive: true, force: true });

      const result = await cmosProjectList({});
      const formatted = formatProjectListForLLM(result);

      expect(formatted).toContain('[MISSING]');
      expect(formatted).toContain('prune');
    });

    it('should not show missing tip when all entries are live', async () => {
      await ensureCmosDatabase(workspace);
      await registry.register(workspace, { name: 'Live Project' });

      const result = await cmosProjectList({});
      const formatted = formatProjectListForLLM(result);

      expect(formatted).not.toContain('[MISSING]');
      expect(formatted).not.toContain('prune');
    });
  });
});
