/**
 * cmos_project_validate Tool Tests
 *
 * Tests for the MCP tool that validates registered CMOS projects.
 *
 * @module tests/tools/cmos/cmos-project-validate
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import {
  cmosProjectValidate,
  cmosProjectValidateToolDefinition,
  formatProjectValidateForLLM,
} from '../../../src/tools/cmos/cmos-project-validate';

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

describe('cmos_project_validate', () => {
  let workspace: string;
  let workspace2: string;
  let configDir: string;
  let graph: ProjectGraphRegistry;
  let prevConfigEnv: string | undefined;

  beforeEach(async () => {
    workspace = await createTempWorkspace('cmos-project-validate-');
    workspace2 = await createTempWorkspace('cmos-project-validate-2-');
    configDir = await createTempWorkspace('config-');
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    // s79-m03 — cmos_project validate reads/prunes the graph registry.
    graph = await ProjectGraphRegistry.create({ configDir });
  });

  afterEach(async () => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace2, { recursive: true, force: true }).catch(() => {});
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('basic functionality', () => {
    it('should return empty validation when no projects', async () => {
      const result = await cmosProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations).toHaveLength(0);
      expect(result.data?.summary.total).toBe(0);
    });

    it('should validate active project', async () => {
      await ensureCmosDatabase(workspace);
      graph.registerStore(workspace, { name: 'Active Project' });

      const result = await cmosProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations).toHaveLength(1);
      expect(result.data?.validations[0].status).toBe('active');
      expect(result.data?.summary.active).toBe(1);
    });

    it('should detect stale project (database removed)', async () => {
      const sqlitePath = await ensureCmosDatabase(workspace);
      graph.registerStore(workspace, { name: 'Stale Project' });

      // Remove database
      await fs.unlink(sqlitePath);
      CmosDetector.resetInstance();

      const result = await cmosProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations[0].status).toBe('stale');
      expect(result.data?.summary.stale).toBe(1);
    });

    it('should detect missing project (directory removed)', async () => {
      await ensureCmosDatabase(workspace);
      graph.registerStore(workspace, { name: 'Missing Project' });

      // Remove entire workspace
      await fs.rm(workspace, { recursive: true, force: true });

      const result = await cmosProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations[0].status).toBe('missing');
      expect(result.data?.summary.missing).toBe(1);
    });

    it('should validate multiple projects with different statuses', async () => {
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Will be Missing' });

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      const result = await cmosProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations).toHaveLength(2);
      expect(result.data?.summary.active).toBe(1);
      expect(result.data?.summary.missing).toBe(1);
    });
  });

  describe('prune option', () => {
    it('should prune invalid entries when prune=true', async () => {
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Will be Missing' });

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      await cmosProjectValidate({ prune: true });

      // Verify pruned
      const projects = graph.list();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('Active');
    });

    it('should not prune when prune=false', async () => {
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Will be Missing' });

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      await cmosProjectValidate({ prune: false });

      // Verify not pruned
      const projects = graph.list();
      expect(projects).toHaveLength(2);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosProjectValidateToolDefinition.name).toBe('cmos_project_validate');
    });

    it('should have optional prune parameter', () => {
      const props = cmosProjectValidateToolDefinition.inputSchema.properties;
      expect(props.prune).toBeDefined();
    });

    it('should have descriptive description', () => {
      expect(cmosProjectValidateToolDefinition.description).toContain('Validate');
      expect(cmosProjectValidateToolDefinition.description).toContain('CMOS');
    });
  });

  describe('formatProjectValidateForLLM', () => {
    it('should format empty validation', async () => {
      const result = await cmosProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('No projects to validate');
      expect(formatted).toContain('cmos_project_register');
    });

    it('should format all-active validation with checkmark', async () => {
      await ensureCmosDatabase(workspace);
      graph.registerStore(workspace, { name: 'Active' });

      const result = await cmosProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('Validation Complete');
      expect(formatted).toContain('Active: 1');
    });

    it('should show warning icon for mixed results', async () => {
      await ensureCmosDatabase(workspace);
      await ensureCmosDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Missing' });

      await fs.rm(workspace2, { recursive: true, force: true });

      const result = await cmosProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('⚠️');
      expect(formatted).toContain('Active: 1');
      expect(formatted).toContain('Missing: 1');
    });

    it('should show prune tip when there are invalid projects', async () => {
      await ensureCmosDatabase(workspace);
      graph.registerStore(workspace, { name: 'Missing' });
      await fs.rm(workspace, { recursive: true, force: true });

      const result = await cmosProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('prune=true');
    });

    it('should group projects by status', async () => {
      await ensureCmosDatabase(workspace);
      graph.registerStore(workspace, { name: 'Active Project' });

      const result = await cmosProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('Active Projects:');
      expect(formatted).toContain('Active Project');
    });
  });
});
