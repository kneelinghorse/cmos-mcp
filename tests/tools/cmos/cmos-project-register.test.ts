/**
 * cmos_project_register Tool Tests
 *
 * Tests for the MCP tool that registers CMOS projects.
 *
 * @module tests/tools/cmos/cmos-project-register
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../../src/intelligence/project-registry';
import {
  cmosProjectRegister,
  cmosProjectRegisterToolDefinition,
  formatProjectRegisterForLLM,
  type CmosProjectRegisterParams,
} from '../../../src/tools/cmos/cmos-project-register';
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

describe('cmos_project_register', () => {
  let workspace: string;
  let configDir: string;

  beforeEach(async () => {
    workspace = await createTempWorkspace('cmos-project-register-');
    configDir = await createTempWorkspace('config-');
    CmosDetector.resetInstance();
    ProjectRegistry.resetInstance();
    // Initialize with test config dir
    await ProjectRegistry.create({ configDir });
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('basic functionality', () => {
    it('should register a project with CMOS database', async () => {
      await ensureCmosDatabase(workspace);
      const result = await cmosProjectRegister({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.projectRoot).toBe(workspace);
      expect(result.data?.wasAlreadyRegistered).toBe(false);
      expect(result.data?.message).toContain('Registered');
    });

    it('should use provided name', async () => {
      await ensureCmosDatabase(workspace);
      const result = await cmosProjectRegister({
        projectRoot: workspace,
        name: 'My Project',
      });

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('My Project');
    });

    it('should set project as default when requested', async () => {
      await ensureCmosDatabase(workspace);
      const result = await cmosProjectRegister({
        projectRoot: workspace,
        setAsDefault: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.isDefault).toBe(true);
    });

    it('should indicate when project was already registered', async () => {
      await ensureCmosDatabase(workspace);

      // First registration
      await cmosProjectRegister({ projectRoot: workspace });

      // Second registration
      const result = await cmosProjectRegister({
        projectRoot: workspace,
        name: 'Updated Name',
      });

      expect(result.success).toBe(true);
      expect(result.data?.wasAlreadyRegistered).toBe(true);
      expect(result.data?.message).toContain('Updated');
    });
  });

  describe('validation', () => {
    it('should fail for project without CMOS database', async () => {
      const result = await cmosProjectRegister({ projectRoot: workspace });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CMOS_NOT_DETECTED');
      expect(result.error?.suggestion).toBeDefined();
    });

    it('should fail for missing projectRoot', async () => {
      const result = await cmosProjectRegister({
        projectRoot: '',
      } as CmosProjectRegisterParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('projectRoot');
    });

    it('should fail for whitespace-only projectRoot', async () => {
      const result = await cmosProjectRegister({ projectRoot: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('stale cache bypass', () => {
    it('should register successfully even when detector has a stale negative cache entry', async () => {
      // Prime the cache with a negative result before the DB exists
      const detector = CmosDetector.getInstance();
      await detector.detect(workspace); // hasDatabase: false — now cached

      // Create the DB after the negative result is cached
      await ensureCmosDatabase(workspace);

      // Register should bypass the cache (forceRefresh: true) and succeed
      const result = await cmosProjectRegister({ projectRoot: workspace });
      expect(result.success).toBe(true);
      expect(result.data?.projectRoot).toBe(workspace);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosProjectRegisterToolDefinition.name).toBe('cmos_project_register');
    });

    it('should require projectRoot', () => {
      expect(cmosProjectRegisterToolDefinition.inputSchema.required).toContain('projectRoot');
    });

    it('should have optional name and setAsDefault', () => {
      const props = cmosProjectRegisterToolDefinition.inputSchema.properties;
      expect(props.name).toBeDefined();
      expect(props.setAsDefault).toBeDefined();
    });

    it('should have descriptive description', () => {
      expect(cmosProjectRegisterToolDefinition.description).toContain('Register');
      expect(cmosProjectRegisterToolDefinition.description).toContain('CMOS');
    });
  });

  describe('formatProjectRegisterForLLM', () => {
    it('should format success result', async () => {
      await ensureCmosDatabase(workspace);
      const result = await cmosProjectRegister({ projectRoot: workspace });
      const formatted = formatProjectRegisterForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('registered');
      expect(formatted).toContain(workspace);
    });

    it('should format updated result differently', async () => {
      await ensureCmosDatabase(workspace);
      await cmosProjectRegister({ projectRoot: workspace });
      const result = await cmosProjectRegister({ projectRoot: workspace });
      const formatted = formatProjectRegisterForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('updated');
    });

    it('should format error result', async () => {
      const result = await cmosProjectRegister({ projectRoot: workspace });
      const formatted = formatProjectRegisterForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });

    it('should show default status', async () => {
      await ensureCmosDatabase(workspace);
      const result = await cmosProjectRegister({
        projectRoot: workspace,
        setAsDefault: true,
      });
      const formatted = formatProjectRegisterForLLM(result);

      expect(formatted).toContain('Default: Yes');
    });
  });
});
