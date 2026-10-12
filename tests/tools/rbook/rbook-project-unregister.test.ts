/**
 * rbook_project_unregister Tool Tests
 *
 * Tests for the MCP tool that unregisters Reasonbook projects.
 *
 * @module tests/tools/rbook/rbook-project-unregister
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { rbookProjectRegister } from '../../../src/tools/rbook/rbook-project-register';
import {
  rbookProjectUnregister,
  rbookProjectUnregisterToolDefinition,
  formatProjectUnregisterForLLM,
  type RbookProjectUnregisterParams,
} from '../../../src/tools/rbook/rbook-project-unregister';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';

async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function ensureRbookDatabase(workspace: string): Promise<string> {
  const dbPath = path.join(workspace, 'rbook', 'db');
  await fs.mkdir(dbPath, { recursive: true });
  const sqlitePath = path.join(dbPath, 'rbook.sqlite');
  const db = new Database(sqlitePath);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.close();
  return sqlitePath;
}

describe('rbook_project_unregister', () => {
  let workspace: string;
  let configDir: string;
  let graph: ProjectGraphRegistry;
  let prevConfigEnv: string | undefined;

  // Register through the graph-authoritative tool path (s79-m02). s80-m02: the
  // graph is the single discovery source (no derived JSON mirror).
  const register = async (opts: { name?: string; setAsDefault?: boolean } = {}) => {
    const result = await rbookProjectRegister({ projectRoot: workspace, ...opts });
    expect(result.success).toBe(true);
    return result;
  };

  beforeEach(async () => {
    workspace = await createTempWorkspace('rbook-project-unregister-');
    configDir = await createTempWorkspace('config-');
    // Point the graph registry at configDir.
    prevConfigEnv = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = configDir;
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    graph = await ProjectGraphRegistry.create({ configDir });
  });

  afterEach(async () => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = prevConfigEnv;
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('basic functionality', () => {
    it('should unregister a registered project', async () => {
      await ensureRbookDatabase(workspace);
      await register({ name: 'My Project' });

      const result = await rbookProjectUnregister({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.projectRoot).toBe(workspace);
      expect(result.data?.message).toContain('Unregistered');

      // Verify removed from the graph registry
      const projects = graph.list();
      expect(projects).toHaveLength(0);
    });

    it('should indicate if project was default', async () => {
      await ensureRbookDatabase(workspace);
      await register({ setAsDefault: true });

      const result = await rbookProjectUnregister({ projectRoot: workspace });

      expect(result.success).toBe(true);
      expect(result.data?.wasDefault).toBe(true);
    });

    it('should clear default when unregistering default project', async () => {
      await ensureRbookDatabase(workspace);
      await register({ setAsDefault: true });

      await rbookProjectUnregister({ projectRoot: workspace });

      const defaultProject = graph.getDefault();
      expect(defaultProject).toBeNull();
    });
  });

  describe('validation', () => {
    it('should fail for non-existent project', async () => {
      const result = await rbookProjectUnregister({ projectRoot: '/nonexistent/path' });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('not found');
      expect(result.error?.suggestion).toBeDefined();
    });

    it('should fail for missing projectRoot', async () => {
      const result = await rbookProjectUnregister({
        projectRoot: '',
      } as RbookProjectUnregisterParams);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('projectRoot');
    });

    it('should fail for whitespace-only projectRoot', async () => {
      const result = await rbookProjectUnregister({ projectRoot: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookProjectUnregisterToolDefinition.name).toBe('rbook_project_unregister');
    });

    it('should require projectRoot', () => {
      expect(rbookProjectUnregisterToolDefinition.inputSchema.required).toContain('projectRoot');
    });

    it('should have descriptive description', () => {
      expect(rbookProjectUnregisterToolDefinition.description).toContain('Remove');
      expect(rbookProjectUnregisterToolDefinition.description).toContain('registry');
    });
  });

  describe('formatProjectUnregisterForLLM', () => {
    it('should format success result', async () => {
      await ensureRbookDatabase(workspace);
      await register();

      const result = await rbookProjectUnregister({ projectRoot: workspace });
      const formatted = formatProjectUnregisterForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('unregistered');
      expect(formatted).toContain(workspace);
    });

    it('should note when default was cleared', async () => {
      await ensureRbookDatabase(workspace);
      await register({ setAsDefault: true });

      const result = await rbookProjectUnregister({ projectRoot: workspace });
      const formatted = formatProjectUnregisterForLLM(result);

      expect(formatted).toContain('default');
      expect(formatted).toContain('cleared');
    });

    it('should format error result', async () => {
      const result = await rbookProjectUnregister({ projectRoot: '/nonexistent' });
      const formatted = formatProjectUnregisterForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });
  });
});
