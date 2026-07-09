/**
 * cmos_project_unregister Tool Tests
 *
 * Tests for the MCP tool that unregisters CMOS projects.
 *
 * @module tests/tools/cmos/cmos-project-unregister
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { cmosProjectRegister } from '../../../src/tools/cmos/cmos-project-register';
import {
  cmosProjectUnregister,
  cmosProjectUnregisterToolDefinition,
  formatProjectUnregisterForLLM,
  type CmosProjectUnregisterParams,
} from '../../../src/tools/cmos/cmos-project-unregister';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';

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

describe('cmos_project_unregister', () => {
  let workspace: string;
  let configDir: string;
  let graph: ProjectGraphRegistry;
  let prevConfigEnv: string | undefined;

  // Register through the graph-authoritative tool path (s79-m02). s80-m02: the
  // graph is the single discovery source (no derived JSON mirror).
  const register = (opts: { name?: string; setAsDefault?: boolean } = {}) =>
    cmosProjectRegister({ projectRoot: workspace, ...opts });

  beforeEach(async () => {
    workspace = await createTempWorkspace('cmos-project-unregister-');
    configDir = await createTempWorkspace('config-');
    // Point the graph registry at configDir.
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    graph = await ProjectGraphRegistry.create({ configDir });
  });

  afterEach(async () => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('basic functionality', () => {
    it('should unregister a registered project', async () => {
      await ensureCmosDatabase(workspace);
      await register({ name: 'My Project' });

      const result = await cmosProjectUnregister({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.projectRoot).toBe(workspace);
      expect(result.data?.message).toContain('Unregistered');

      // Verify removed from the graph registry
      const projects = graph.list();
      expect(projects).toHaveLength(0);
    });

    it('should indicate if project was default', async () => {
      await ensureCmosDatabase(workspace);
      await register({ setAsDefault: true });

      const result = await cmosProjectUnregister({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.wasDefault).toBe(true);
    });

    it('should clear default when unregistering default project', async () => {
      await ensureCmosDatabase(workspace);
      await register({ setAsDefault: true });

      await cmosProjectUnregister({ projectRoot: workspace });

      const defaultProject = graph.getDefault();
      expect(defaultProject).toBeNull();
    });
  });

  describe('validation', () => {
    it('should fail for non-existent project', async () => {
      const result = await cmosProjectUnregister({ projectRoot: '/nonexistent/path' });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('not found');
      expect(result.error?.suggestion).toBeDefined();
    });

    it('should fail for missing projectRoot', async () => {
      const result = await cmosProjectUnregister({
        projectRoot: '',
      } as CmosProjectUnregisterParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('projectRoot');
    });

    it('should fail for whitespace-only projectRoot', async () => {
      const result = await cmosProjectUnregister({ projectRoot: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosProjectUnregisterToolDefinition.name).toBe('cmos_project_unregister');
    });

    it('should require projectRoot', () => {
      expect(cmosProjectUnregisterToolDefinition.inputSchema.required).toContain('projectRoot');
    });

    it('should have descriptive description', () => {
      expect(cmosProjectUnregisterToolDefinition.description).toContain('Remove');
      expect(cmosProjectUnregisterToolDefinition.description).toContain('registry');
    });
  });

  describe('formatProjectUnregisterForLLM', () => {
    it('should format success result', async () => {
      await ensureCmosDatabase(workspace);
      await register();

      const result = await cmosProjectUnregister({ projectRoot: workspace });
      const formatted = formatProjectUnregisterForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('unregistered');
      expect(formatted).toContain(workspace);
    });

    it('should note when default was cleared', async () => {
      await ensureCmosDatabase(workspace);
      await register({ setAsDefault: true });

      const result = await cmosProjectUnregister({ projectRoot: workspace });
      const formatted = formatProjectUnregisterForLLM(result);

      expect(formatted).toContain('default');
      expect(formatted).toContain('cleared');
    });

    it('should format error result', async () => {
      const result = await cmosProjectUnregister({ projectRoot: '/nonexistent' });
      const formatted = formatProjectUnregisterForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });
  });
});
