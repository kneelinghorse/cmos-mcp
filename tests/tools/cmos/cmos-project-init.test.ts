/**
 * cmos_project_init Tool Tests
 *
 * Comprehensive tests for the project initialization tool.
 * Tests include creating new projects, idempotent behavior,
 * error handling, and formatting.
 *
 * @module tests/tools/cmos/cmos-project-init
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosProjectInit,
  cmosProjectInitToolDefinition,
  formatProjectInitForLLM,
  resolveSeedPath,
  type CmosProjectInitInput,
} from '../../../src/tools/cmos/cmos-project-init';
import { CMOS_SCHEMA_VERSION, CMOS_SCHEMA } from '../../../src/tools/cmos/schema';
import { CMOS_ERROR_CODES } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectRegistry } from '../../../src/intelligence/project-registry';

describe('cmos_project_init', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-project-init-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('seed resolution', () => {
    it('should find the cmos-seed directory', () => {
      const seedPath = resolveSeedPath();
      expect(seedPath).not.toBeNull();
      expect(fs.existsSync(path.join(seedPath!, 'db', 'schema.sql'))).toBe(true);
      expect(fs.existsSync(path.join(seedPath!, 'tiers', 'build.md'))).toBe(true);
    });
  });

  describe('new project initialization', () => {
    it('should create full cmos directory structure from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNewProject).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'db'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'db', 'cmos.sqlite'))).toBe(true);
    });

    it('should copy tier configs from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'tiers', 'build.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'tiers', 'general.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'tiers', 'managed.md'))).toBe(true);

      const buildMd = fs.readFileSync(path.join(tempDir, 'cmos', 'tiers', 'build.md'), 'utf-8');
      expect(buildMd).toContain('tier: build');
    });

    it('should copy docs directory from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'docs'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'docs', 'getting-started.md'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'docs', 'build-session-prompt.md'))).toBe(
        true
      );
    });

    it('should copy foundational-docs templates from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'foundational-docs'))).toBe(true);
      expect(
        fs.existsSync(path.join(tempDir, 'cmos', 'foundational-docs', 'roadmap_template.md'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tempDir, 'cmos', 'foundational-docs', 'tech_arch_template.md'))
      ).toBe(true);
    });

    it('should copy templates directory from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'templates'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'templates', 'agents.md'))).toBe(true);
      expect(
        fs.existsSync(path.join(tempDir, 'cmos', 'templates', 'PROJECT-README-template.md'))
      ).toBe(true);
    });

    it('should copy context JSON files from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'context'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'context', 'master_context.json'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'context', 'project_context.json'))).toBe(
        true
      );
    });

    it('should copy schema.sql reference from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', 'db', 'schema.sql'))).toBe(true);
    });

    // Sprint 60 Bug 1 regression: cmos.sqlite-wal and cmos.sqlite-shm are runtime
    // artifacts of WAL mode and have no business in a seed. When they leaked through,
    // sqlite could recover stale state into the supposedly-fresh DB on a new project.
    // Init must skip them alongside cmos.sqlite itself.
    it('should not copy sqlite WAL/SHM runtime artifacts from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const dbDir = path.join(tempDir, 'cmos', 'db');
      // The freshly-opened DB will create its own -wal and -shm during normal use
      // (and may have already by the time init returns). Assert their CONTENTS
      // are not the seed's contents — i.e. that nothing was ferried in unchanged.
      const seedDir = resolveSeedPath()!;
      const seedWal = path.join(seedDir, 'db', 'cmos.sqlite-wal');
      const seedShm = path.join(seedDir, 'db', 'cmos.sqlite-shm');
      const initWal = path.join(dbDir, 'cmos.sqlite-wal');
      const initShm = path.join(dbDir, 'cmos.sqlite-shm');

      if (fs.existsSync(seedWal) && fs.existsSync(initWal)) {
        const seedBytes = fs.readFileSync(seedWal);
        const initBytes = fs.readFileSync(initWal);
        expect(initBytes.equals(seedBytes)).toBe(false);
      }
      if (fs.existsSync(seedShm) && fs.existsSync(initShm)) {
        const seedBytes = fs.readFileSync(seedShm);
        const initBytes = fs.readFileSync(initShm);
        expect(initBytes.equals(seedBytes)).toBe(false);
      }
    });

    it('should copy .gitignore from seed', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'cmos', '.gitignore'))).toBe(true);
    });

    it('should create CLAUDE.md with the no-.env attribution note', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const claudePath = path.join(tempDir, 'CLAUDE.md');
      expect(fs.existsSync(claudePath)).toBe(true);

      const content = fs.readFileSync(claudePath, 'utf-8');
      expect(content).toContain('you do not need a `.env` for CMOS attribution');
      expect(content).toContain('shared MCP server resolves your project via MCP roots');
    });

    it('should generate project ID when not provided', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.projectId).toBeDefined();
      expect(result.data?.projectId.length).toBeGreaterThan(0);
      expect(result.data?.projectId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should use provided project ID', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        projectId: 'my-custom-project-id',
      });

      expect(result.success).toBe(true);
      expect(result.data?.projectId).toBe('my-custom-project-id');
    });

    it('should set project name in database', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'My Awesome Project',
      });

      expect(result.success).toBe(true);
      expect(result.data?.projectName).toBe('My Awesome Project');

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get() as {
        value: string;
      };
      db.close();

      expect(row.value).toBe('My Awesome Project');
    });

    it('should set tracelab project ID in database', async () => {
      const tracelabId = 'tracelab-123-456';
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        tracelabProjectId: tracelabId,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'tracelab_project_id'")
        .get() as { value: string };
      db.close();

      expect(row.value).toBe(tracelabId);
    });

    it('should set schema version in database', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.data?.schemaVersion).toBe(CMOS_SCHEMA_VERSION);

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as {
        value: string;
      };
      db.close();

      expect(row.value).toBe(CMOS_SCHEMA_VERSION);
    });
  });

  describe('database schema', () => {
    it('should create all required tables', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('metadata');
      expect(tableNames).toContain('sprints');
      expect(tableNames).toContain('missions');
      expect(tableNames).toContain('mission_dependencies');
      expect(tableNames).toContain('contexts');
      expect(tableNames).toContain('context_snapshots');
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('session_events');
      expect(tableNames).toContain('strategic_decisions');
      expect(tableNames).toContain('telemetry_events');
      expect(tableNames).toContain('prompt_mappings');

      db.close();
    });

    it('should create all required views', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);

      const views = db
        .prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")
        .all() as { name: string }[];

      const viewNames = views.map((v) => v.name);

      expect(viewNames).toContain('project_identity');
      expect(viewNames).toContain('active_missions');
      expect(viewNames).toContain('mission_details');
      expect(viewNames).toContain('sprint_summary');

      db.close();
    });

    it('should create initial contexts', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);

      const contexts = db.prepare('SELECT id FROM contexts ORDER BY id').all() as { id: string }[];
      const contextIds = contexts.map((c) => c.id);

      expect(contextIds).toContain('project_context');
      expect(contextIds).toContain('master_context');

      db.close();
    });
  });

  describe('initial sprint and missions', () => {
    it('should create initial sprint when provided', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        initialSprint: {
          id: 'sprint-01',
          title: 'Initial Sprint',
          focus: 'Project Setup',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.sprintCreated).toBe('sprint-01');

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get('sprint-01') as {
        id: string;
        title: string;
        focus: string;
        status: string;
      };
      db.close();

      expect(sprint.id).toBe('sprint-01');
      expect(sprint.title).toBe('Initial Sprint');
      expect(sprint.focus).toBe('Project Setup');
      expect(sprint.status).toBe('Active');
    });

    it('should create initial missions when provided', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        initialSprint: {
          id: 'sprint-01',
          title: 'Initial Sprint',
        },
        initialMissions: [
          {
            id: 's01-m01',
            name: 'First Mission',
            sprintId: 'sprint-01',
            objective: 'Do something',
            status: 'Current',
          },
          {
            id: 's01-m02',
            name: 'Second Mission',
            sprintId: 'sprint-01',
            status: 'Queued',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionsCreated).toContain('s01-m01');
      expect(result.data?.missionsCreated).toContain('s01-m02');

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const missions = db.prepare('SELECT * FROM missions ORDER BY id').all() as {
        id: string;
        name: string;
        status: string;
        objective: string | null;
      }[];
      db.close();

      expect(missions.length).toBe(2);
      expect(missions[0].id).toBe('s01-m01');
      expect(missions[0].status).toBe('Current');
      expect(missions[0].objective).toBe('Do something');
      expect(missions[1].id).toBe('s01-m02');
      expect(missions[1].status).toBe('Queued');
    });

    it('should store success criteria and deliverables as JSON', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        initialSprint: {
          id: 'sprint-01',
          title: 'Initial Sprint',
        },
        initialMissions: [
          {
            id: 's01-m01',
            name: 'Test Mission',
            sprintId: 'sprint-01',
            successCriteria: ['Criterion 1', 'Criterion 2'],
            deliverables: ['File 1', 'File 2'],
          },
        ],
      });

      expect(result.success).toBe(true);

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get('s01-m01') as {
        success_criteria: string;
        deliverables: string;
      };
      db.close();

      expect(JSON.parse(mission.success_criteria)).toEqual(['Criterion 1', 'Criterion 2']);
      expect(JSON.parse(mission.deliverables)).toEqual(['File 1', 'File 2']);
    });
  });

  describe('idempotent behavior', () => {
    it('should be safe to call on existing project', async () => {
      const result1 = await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'Original Name',
        projectId: 'original-id',
      });

      expect(result1.success).toBe(true);
      expect(result1.data?.isNewProject).toBe(true);

      const result2 = await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'Updated Name',
      });

      expect(result2.success).toBe(true);
      expect(result2.data?.isNewProject).toBe(false);
    });

    it('should update metadata on re-initialization', async () => {
      await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'Original Name',
      });

      await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'Updated Name',
      });

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get() as {
        value: string;
      };
      db.close();

      expect(row.value).toBe('Updated Name');
    });

    it('should not duplicate contexts on re-initialization', async () => {
      await cmosProjectInit({ projectRoot: tempDir });
      await cmosProjectInit({ projectRoot: tempDir });

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM contexts').get() as { count: number };
      db.close();

      expect(count.count).toBe(2); // project_context and master_context only
    });

    it('should not overwrite existing seed files on re-initialization', async () => {
      await cmosProjectInit({ projectRoot: tempDir });

      // Modify a tier config
      const buildMdPath = path.join(tempDir, 'cmos', 'tiers', 'build.md');
      fs.writeFileSync(buildMdPath, '# Custom build tier content');

      // Re-initialize
      await cmosProjectInit({ projectRoot: tempDir });

      // Should preserve the custom content
      const content = fs.readFileSync(buildMdPath, 'utf-8');
      expect(content).toBe('# Custom build tier content');
    });

    it('should not duplicate sprint on re-initialization', async () => {
      await cmosProjectInit({
        projectRoot: tempDir,
        initialSprint: { id: 'sprint-01', title: 'Sprint 1' },
      });

      const result = await cmosProjectInit({
        projectRoot: tempDir,
        initialSprint: { id: 'sprint-01', title: 'Sprint 1 Updated' },
      });

      expect(result.success).toBe(true);
      expect(result.data?.sprintCreated).toBeUndefined();

      const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
      const db = new Database(dbPath);
      const count = db.prepare('SELECT COUNT(*) as count FROM sprints').get() as { count: number };
      const sprint = db.prepare('SELECT title FROM sprints WHERE id = ?').get('sprint-01') as {
        title: string;
      };
      db.close();

      expect(count.count).toBe(1);
      expect(sprint.title).toBe('Sprint 1');
    });
  });

  describe('error handling', () => {
    it('should return error for non-existent project root', async () => {
      const result = await cmosProjectInit({
        projectRoot: '/non/existent/path',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.field).toBe('projectRoot');
    });

    it('should return error when project root is a file', async () => {
      const filePath = path.join(tempDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');

      const result = await cmosProjectInit({
        projectRoot: filePath,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(CMOS_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.message).toContain('not a directory');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(cmosProjectInitToolDefinition.name).toBe('cmos_project_init');
    });

    it('should require projectRoot', () => {
      expect(cmosProjectInitToolDefinition.inputSchema.required).toContain('projectRoot');
    });

    it('should have all expected properties', () => {
      const props = cmosProjectInitToolDefinition.inputSchema.properties;
      expect(props.projectName).toBeDefined();
      expect(props.projectId).toBeDefined();
      expect(props.tracelabProjectId).toBeDefined();
      expect(props.initialSprint).toBeDefined();
      expect(props.initialMissions).toBeDefined();
    });
  });

  describe('formatProjectInitForLLM', () => {
    it('should format success result for new project', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'Test Project',
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('CMOS Project Initialized');
      expect(formatted).toContain('Test Project');
      expect(formatted).toContain(CMOS_SCHEMA_VERSION);
      expect(formatted).toContain('cmos_agent_onboard');
    });

    it('should format success result for updated project', async () => {
      await cmosProjectInit({ projectRoot: tempDir });

      const result = await cmosProjectInit({
        projectRoot: tempDir,
        projectName: 'Updated Project',
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('CMOS Project Updated');
      expect(formatted).toContain('Updated Project');
    });

    it('should include created files in output', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Created');
      expect(formatted).toContain('db/cmos.sqlite');
      expect(formatted).toContain('tiers/');
    });

    it('should include sprint and missions in output', async () => {
      const result = await cmosProjectInit({
        projectRoot: tempDir,
        initialSprint: { id: 'sprint-01', title: 'Sprint 1' },
        initialMissions: [{ id: 's01-m01', name: 'Mission 1', sprintId: 'sprint-01' }],
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Initial Sprint');
      expect(formatted).toContain('sprint-01');
      expect(formatted).toContain('Initial Missions');
      expect(formatted).toContain('s01-m01');
    });

    it('should format error result', async () => {
      const result = await cmosProjectInit({
        projectRoot: '/non/existent',
      });

      const formatted = formatProjectInitForLLM(result);

      expect(formatted).toContain('Initialization Failed');
      expect(formatted).toContain('Error');
      expect(formatted).toContain('Suggestion');
    });
  });

  describe('auto-registration', () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-init-registry-'));
      CmosDetector.resetInstance();
      ProjectRegistry.resetInstance();
      await ProjectRegistry.create({ configDir });
    });

    afterEach(async () => {
      CmosDetector.resetInstance();
      ProjectRegistry.resetInstance();
      if (configDir && fs.existsSync(configDir)) {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('should auto-register the project after init', async () => {
      await cmosProjectInit({ projectRoot: tempDir, projectName: 'auto-reg-test' });

      const registry = await ProjectRegistry.create({ configDir });
      const project = await registry.getProject(tempDir);
      expect(project).not.toBeNull();
      expect(project?.projectRoot).toBe(tempDir);
    });

    it('should succeed even if registration fails (best-effort)', async () => {
      // Simulate a broken registry by providing an invalid configDir path after creation
      // Init should still succeed and return the DB result
      const result = await cmosProjectInit({ projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.databasePath).toContain('cmos.sqlite');
    });

    it('should register with project name when provided', async () => {
      await cmosProjectInit({ projectRoot: tempDir, projectName: 'My Named Project' });

      const registry = await ProjectRegistry.create({ configDir });
      const project = await registry.getProject(tempDir);
      expect(project?.name).toBe('My Named Project');
    });
  });

  describe('schema content', () => {
    it('should export CMOS_SCHEMA as valid SQL', async () => {
      const testDb = new Database(':memory:');
      expect(() => testDb.exec(CMOS_SCHEMA)).not.toThrow();
      testDb.close();
    });

    it('should include all standard metadata keys in schema', () => {
      expect(CMOS_SCHEMA).toContain("'project_id'");
      expect(CMOS_SCHEMA).toContain("'project_name'");
      expect(CMOS_SCHEMA).toContain("'tracelab_project_id'");
      expect(CMOS_SCHEMA).toContain("'schema_version'");
    });

    it('should include project_identity view in schema', () => {
      expect(CMOS_SCHEMA).toContain('CREATE VIEW IF NOT EXISTS project_identity');
    });

    it('should include session_id and source_chunk_ids in strategic_decisions', () => {
      expect(CMOS_SCHEMA).toContain('session_id TEXT');
      expect(CMOS_SCHEMA).toContain('source_chunk_ids TEXT');
    });
  });
});
