/**
 * rbook_project_validate Tool Tests
 *
 * Tests for the MCP tool that validates registered Reasonbook projects.
 *
 * @module tests/tools/rbook/rbook-project-validate
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import {
  rbookProjectValidate,
  rbookProjectValidateToolDefinition,
  formatProjectValidateForLLM,
} from '../../../src/tools/rbook/rbook-project-validate';

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

describe('rbook_project_validate', () => {
  let workspace: string;
  let workspace2: string;
  let configDir: string;
  let graph: ProjectGraphRegistry;
  let prevConfigEnv: string | undefined;

  beforeEach(async () => {
    workspace = await createTempWorkspace('rbook-project-validate-');
    workspace2 = await createTempWorkspace('rbook-project-validate-2-');
    configDir = await createTempWorkspace('config-');
    prevConfigEnv = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = configDir;
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    // s79-m03 — rbook_project validate reads/prunes the graph registry.
    // s92-m01: every Jest store lives under os.tmpdir(), which counts as EPHEMERAL; these cases are
    // about durable stores, so this registry declares no ephemeral locations.
    graph = await ProjectGraphRegistry.create({ configDir, ephemeralRoots: [] });
  });

  afterEach(async () => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = prevConfigEnv;
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspace2, { recursive: true, force: true }).catch(() => {});
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe('basic functionality', () => {
    it('should return empty validation when no projects', async () => {
      const result = await rbookProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations).toHaveLength(0);
      expect(result.data?.summary.total).toBe(0);
    });

    it('should validate active project', async () => {
      await ensureRbookDatabase(workspace);
      graph.registerStore(workspace, { name: 'Active Project' });

      const result = await rbookProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations).toHaveLength(1);
      expect(result.data?.validations[0].status).toBe('active');
      expect(result.data?.summary.active).toBe(1);
    });

    it('should detect stale project (database removed)', async () => {
      const sqlitePath = await ensureRbookDatabase(workspace);
      graph.registerStore(workspace, { name: 'Stale Project' });

      // Remove database
      await fs.unlink(sqlitePath);
      RbookDetector.resetInstance();

      const result = await rbookProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations[0].status).toBe('stale');
      expect(result.data?.summary.stale).toBe(1);
    });

    it('should detect missing project (directory removed)', async () => {
      await ensureRbookDatabase(workspace);
      graph.registerStore(workspace, { name: 'Missing Project' });

      // Remove entire workspace
      await fs.rm(workspace, { recursive: true, force: true });

      const result = await rbookProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations[0].status).toBe('missing');
      expect(result.data?.summary.missing).toBe(1);
    });

    it('should validate multiple projects with different statuses', async () => {
      await ensureRbookDatabase(workspace);
      await ensureRbookDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Will be Missing' });

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      const result = await rbookProjectValidate({});

      expect(result.success).toBe(true);
      expect(result.data?.validations).toHaveLength(2);
      expect(result.data?.summary.active).toBe(1);
      expect(result.data?.summary.missing).toBe(1);
    });
  });

  describe('ephemeral stores (s92-m01, feedback #41)', () => {
    async function ephemeralGraph(): Promise<ProjectGraphRegistry> {
      // The workspaces live under os.tmpdir(); declare that location ephemeral.
      ProjectGraphRegistry.resetInstance();
      return ProjectGraphRegistry.create({ configDir, ephemeralRoots: [os.tmpdir()] });
    }

    it('reports a live store under an ephemeral location as ephemeral, not active', async () => {
      await ensureRbookDatabase(workspace);
      const ephemeral = await ephemeralGraph();
      ephemeral.registerStore(workspace, { name: 'Scratch' });

      const result = await rbookProjectValidate({});

      expect(result.data?.validations[0]).toMatchObject({
        status: 'ephemeral',
        projectRoot: path.resolve(workspace),
      });
      expect(result.data?.summary).toMatchObject({ active: 0, ephemeral: 1 });
      expect(formatProjectValidateForLLM(result)).toContain('Ephemeral Projects');
    });

    it('prune archives an ephemeral row even though its store still exists', async () => {
      await ensureRbookDatabase(workspace);
      const ephemeral = await ephemeralGraph();
      ephemeral.registerStore(workspace, { name: 'Scratch' });

      await rbookProjectValidate({ prune: true });

      expect(ephemeral.list()).toHaveLength(0);
      // Archived, not deleted: the row is restorable and the store is untouched.
      expect(ephemeral.list({ includeArchived: true })).toHaveLength(1);
      await expect(fs.access(path.join(workspace, 'rbook', 'db', 'rbook.sqlite'))).resolves.toBe(
        undefined
      );
    });

    it('validate without prune leaves an ephemeral row registered', async () => {
      await ensureRbookDatabase(workspace);
      const ephemeral = await ephemeralGraph();
      ephemeral.registerStore(workspace, { name: 'Scratch' });

      await rbookProjectValidate({ prune: false });

      expect(ephemeral.list()).toHaveLength(1);
    });
  });

  describe('prune option', () => {
    it('should prune invalid entries when prune=true', async () => {
      await ensureRbookDatabase(workspace);
      await ensureRbookDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Will be Missing' });

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      await rbookProjectValidate({ prune: true });

      // Verify pruned
      const projects = graph.list();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('Active');
    });

    it('should not prune when prune=false', async () => {
      await ensureRbookDatabase(workspace);
      await ensureRbookDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Will be Missing' });

      // Remove one
      await fs.rm(workspace2, { recursive: true, force: true });

      await rbookProjectValidate({ prune: false });

      // Verify not pruned
      const projects = graph.list();
      expect(projects).toHaveLength(2);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookProjectValidateToolDefinition.name).toBe('rbook_project_validate');
    });

    it('should have optional prune parameter', () => {
      const props = rbookProjectValidateToolDefinition.inputSchema.properties;
      expect(props.prune).toBeDefined();
    });

    it('should have descriptive description', () => {
      expect(rbookProjectValidateToolDefinition.description).toContain('Validate');
      expect(rbookProjectValidateToolDefinition.description).toContain('Reasonbook');
    });
  });

  describe('formatProjectValidateForLLM', () => {
    it('should format empty validation', async () => {
      const result = await rbookProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('No projects to validate');
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(formatted).toContain('rbook_project(action="register")');
    });

    it('should format all-active validation with checkmark', async () => {
      await ensureRbookDatabase(workspace);
      graph.registerStore(workspace, { name: 'Active' });

      const result = await rbookProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('✓');
      expect(formatted).toContain('Validation Complete');
      expect(formatted).toContain('Active: 1');
    });

    it('should show warning icon for mixed results', async () => {
      await ensureRbookDatabase(workspace);
      await ensureRbookDatabase(workspace2);
      graph.registerStore(workspace, { name: 'Active' });
      graph.registerStore(workspace2, { name: 'Missing' });

      await fs.rm(workspace2, { recursive: true, force: true });

      const result = await rbookProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('⚠️');
      expect(formatted).toContain('Active: 1');
      expect(formatted).toContain('Missing: 1');
    });

    it('should show prune tip when there are invalid projects', async () => {
      await ensureRbookDatabase(workspace);
      graph.registerStore(workspace, { name: 'Missing' });
      await fs.rm(workspace, { recursive: true, force: true });

      const result = await rbookProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('prune=true');
    });

    it('should group projects by status', async () => {
      await ensureRbookDatabase(workspace);
      graph.registerStore(workspace, { name: 'Active Project' });

      const result = await rbookProjectValidate({});
      const formatted = formatProjectValidateForLLM(result);

      expect(formatted).toContain('Active Projects:');
      expect(formatted).toContain('Active Project');
    });
  });
});
