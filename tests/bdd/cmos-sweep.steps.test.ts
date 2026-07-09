// ABOUTME: BDD step definitions for the cmos_project sweep feature spec.
// ABOUTME: Uses jest-cucumber to map Gherkin steps to production sweep calls and result assertions.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadFeature, defineFeature } from 'jest-cucumber';

import { cmosProjectSweep } from '../../src/tools/cmos/cmos-project-sweep';
import type { SweepResult } from '../../src/tools/cmos/cmos-project-sweep';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { CMOS_SCHEMA } from '../../src/tools/cmos/schema';
import type { CmosToolResult } from '../../src/tools/cmos/types';

const feature = loadFeature('behaviors/cmos-sweep.feature');

// ---------------------------------------------------------------------------
// Local setup helpers (not from bdd-helpers — sweep uses multi-instance setup)
// ---------------------------------------------------------------------------

async function makeInstance(
  rootDir: string,
  name: string
): Promise<{ projectRoot: string; dbPath: string }> {
  const projectRoot = path.join(rootDir, name);
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(CMOS_SCHEMA);
  db.close();
  return { projectRoot, dbPath };
}

function insertMission(
  dbPath: string,
  opts: { id: string; name: string; status: string; sprintId?: string | null }
): void {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)').run(
    opts.id,
    opts.sprintId ?? null,
    opts.name,
    opts.status
  );
  db.close();
}

function insertSession(dbPath: string, opts: { id: string; title: string; status: string }): void {
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status) VALUES (?, 'build', ?, null, datetime('now'), 'test-agent', ?)"
  ).run(opts.id, opts.title, opts.status);
  db.close();
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

defineFeature(feature, (test) => {
  let rootDir: string;
  let configDir: string;
  let graph: ProjectGraphRegistry;
  let prevConfigEnv: string | undefined;
  // Map from instance name to dbPath — populated by Given steps, consumed by Then steps
  const dbPaths: Record<string, string> = {};
  let result: CmosToolResult<SweepResult>;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-bdd-root-'));
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-bdd-cfg-'));
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    // Reset singletons so each test gets a clean registry (s79-m02: graph-backed).
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    graph = await ProjectGraphRegistry.create({ configDir });
    // Clear the name→dbPath map for this test
    for (const key of Object.keys(dbPaths)) {
      delete dbPaths[key];
    }
  });

  afterEach(async () => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Reusable step implementations (referenced by multiple scenarios)
  // ---------------------------------------------------------------------------

  /**
   * Registers an instance by name and stores its dbPath in the shared map.
   */
  async function registerInstance(name: string): Promise<string> {
    const { projectRoot, dbPath } = await makeInstance(rootDir, name);
    graph.registerStore(projectRoot, { name });
    dbPaths[name] = dbPath;
    return dbPath;
  }

  // ---------------------------------------------------------------------------
  // Scenario: Sweep returns open missions from all registered instances
  // ---------------------------------------------------------------------------

  test('Sweep returns open missions from all registered instances', ({
    given,
    and,
    when,
    then,
  }) => {
    given(/^the registry contains instances "vault-minerva" and "code-deety"$/, async () => {
      await registerInstance('vault-minerva');
      await registerInstance('code-deety');
    });

    and(/^"vault-minerva" has missions with statuses "In Progress", "Queued", "Completed"$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'In progress mission',
        status: 'In Progress',
      });
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m02',
        name: 'Queued mission',
        status: 'Queued',
      });
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m03',
        name: 'Completed mission',
        status: 'Completed',
      });
    });

    and(/^"code-deety" has a mission with status "Blocked"$/, () => {
      insertMission(dbPaths['code-deety']!, {
        id: 'cd-m01',
        name: 'Blocked mission',
        status: 'Blocked',
      });
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the result contains 3 items \(In Progress, Queued, Blocked\)$/, () => {
      expect(result.success).toBe(true);
      expect(result.data?.items).toHaveLength(3);
      const statuses = result.data!.items.map((i) => i.status);
      expect(statuses).toContain('In Progress');
      expect(statuses).toContain('Queued');
      expect(statuses).toContain('Blocked');
    });

    and(/^the Completed mission is not included$/, () => {
      const ids = result.data!.items.map((i) => i.id);
      expect(ids).not.toContain('vm-m03');
    });

    and(/^each item includes instance_id, path, item_type, id, summary, status, sprint_id$/, () => {
      for (const item of result.data!.items) {
        expect(item).toHaveProperty('instance_id');
        expect(item).toHaveProperty('path');
        expect(item).toHaveProperty('item_type');
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('summary');
        expect(item).toHaveProperty('status');
        expect(item).toHaveProperty('sprint_id');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep includes open sessions
  // ---------------------------------------------------------------------------

  test('Sweep includes open sessions', ({ given, and, when, then }) => {
    given(/^the registry contains instance "vault-minerva"$/, async () => {
      await registerInstance('vault-minerva');
    });

    and(/^"vault-minerva" has one active session with title "Morning planning"$/, () => {
      insertSession(dbPaths['vault-minerva']!, {
        id: 'vm-s01',
        title: 'Morning planning',
        status: 'active',
      });
    });

    and(/^"vault-minerva" has one completed session$/, () => {
      insertSession(dbPaths['vault-minerva']!, {
        id: 'vm-s02',
        title: 'Completed session',
        status: 'completed',
      });
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the result includes the active session with item_type "session"$/, () => {
      expect(result.success).toBe(true);
      const sessions = result.data!.items.filter((i) => i.item_type === 'session');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe('vm-s01');
      expect(sessions[0]!.summary).toBe('Morning planning');
      expect(sessions[0]!.item_type).toBe('session');
    });

    and(/^the completed session is not included$/, () => {
      const ids = result.data!.items.map((i) => i.id);
      expect(ids).not.toContain('vm-s02');
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep groups results by instance
  // ---------------------------------------------------------------------------

  test('Sweep groups results by instance', ({ given, and, when, then }) => {
    given(/^the registry contains instances "vault-minerva" and "cmos-mcp"$/, async () => {
      await registerInstance('vault-minerva');
      await registerInstance('cmos-mcp');
    });

    and(/^each instance has at least one open mission$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'Vault mission',
        status: 'Queued',
      });
      insertMission(dbPaths['cmos-mcp']!, {
        id: 'cm-m01',
        name: 'CMOS-MCP mission',
        status: 'Queued',
      });
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the response groups items under their respective instance_id$/, () => {
      expect(result.success).toBe(true);
      const groups = result.data!.groups;
      expect(groups.length).toBeGreaterThanOrEqual(2);
      for (const group of groups) {
        expect(group).toHaveProperty('instance_id');
        expect(group).toHaveProperty('items');
        for (const item of group.items) {
          expect(item.instance_id).toBe(group.instance_id);
        }
      }
    });

    and(/^vault-minerva items appear separately from cmos-mcp items$/, () => {
      const groups = result.data!.groups;
      const vmGroup = groups.find((g) => g.instance_id === 'vault-minerva');
      const cmGroup = groups.find((g) => g.instance_id === 'cmos-mcp');
      expect(vmGroup).toBeDefined();
      expect(cmGroup).toBeDefined();
      const vmIds = vmGroup!.items.map((i) => i.id);
      const cmIds = cmGroup!.items.map((i) => i.id);
      expect(vmIds).not.toEqual(expect.arrayContaining(cmIds));
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep with no open items returns empty result
  // ---------------------------------------------------------------------------

  test('Sweep with no open items returns empty result', ({ given, and, when, then }) => {
    given(/^the registry contains instance "code-deety"$/, async () => {
      await registerInstance('code-deety');
    });

    and(/^"code-deety" has no open missions and no active sessions$/, () => {
      // Fresh db — nothing to insert
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the result is an empty list$/, () => {
      expect(result.success).toBe(true);
      expect(result.data?.items).toHaveLength(0);
    });

    and(/^the response is successful \(not an error\)$/, () => {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep filtered by instance name
  // ---------------------------------------------------------------------------

  test('Sweep filtered by instance name', ({ given, and, when, then }) => {
    given(/^the registry contains instances "vault-minerva" and "code-deety"$/, async () => {
      await registerInstance('vault-minerva');
      await registerInstance('code-deety');
    });

    and(/^both instances have open missions$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'Vault mission',
        status: 'Queued',
      });
      insertMission(dbPaths['code-deety']!, {
        id: 'cd-m01',
        name: 'Deety mission',
        status: 'Queued',
      });
    });

    when(
      /^I call cmos_project with action "sweep" and instances \["vault-minerva"\]$/,
      async () => {
        result = await cmosProjectSweep({ instances: ['vault-minerva'] }, graph);
      }
    );

    then(/^only items from "vault-minerva" are returned$/, () => {
      expect(result.success).toBe(true);
      for (const item of result.data!.items) {
        expect(item.instance_id).toBe('vault-minerva');
      }
    });

    and(/^no items from "code-deety" appear in the result$/, () => {
      const instanceIds = result.data!.items.map((i) => i.instance_id);
      expect(instanceIds).not.toContain('code-deety');
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep filtered by status
  // ---------------------------------------------------------------------------

  test('Sweep filtered by status', ({ given, and, when, then }) => {
    given(/^the registry contains instance "vault-minerva"$/, async () => {
      await registerInstance('vault-minerva');
    });

    and(/^"vault-minerva" has missions with statuses "In Progress", "Queued", "Blocked"$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'In progress mission',
        status: 'In Progress',
      });
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m02',
        name: 'Queued mission',
        status: 'Queued',
      });
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m03',
        name: 'Blocked mission',
        status: 'Blocked',
      });
    });

    when(/^I call cmos_project with action "sweep" and statusFilter \["Blocked"\]$/, async () => {
      result = await cmosProjectSweep({ statusFilter: ['Blocked'] }, graph);
    });

    then(/^only the Blocked mission is returned$/, () => {
      expect(result.success).toBe(true);
      expect(result.data?.items).toHaveLength(1);
      expect(result.data!.items[0]!.status).toBe('Blocked');
      expect(result.data!.items[0]!.id).toBe('vm-m03');
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep filtered to missions only
  // ---------------------------------------------------------------------------

  test('Sweep filtered to missions only', ({ given, and, when, then }) => {
    given(/^the registry contains instance "vault-minerva"$/, async () => {
      await registerInstance('vault-minerva');
    });

    and(/^"vault-minerva" has one open mission and one active session$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'Open mission',
        status: 'Queued',
      });
      insertSession(dbPaths['vault-minerva']!, {
        id: 'vm-s01',
        title: 'Active session',
        status: 'active',
      });
    });

    when(/^I call cmos_project with action "sweep" and itemType "mission"$/, async () => {
      result = await cmosProjectSweep({ itemType: 'mission' }, graph);
    });

    then(/^only the mission is returned$/, () => {
      expect(result.success).toBe(true);
      expect(result.data?.items).toHaveLength(1);
      expect(result.data!.items[0]!.item_type).toBe('mission');
    });

    and(/^no sessions appear in the result$/, () => {
      const sessions = result.data!.items.filter((i) => i.item_type === 'session');
      expect(sessions).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep filtered to sessions only
  // ---------------------------------------------------------------------------

  test('Sweep filtered to sessions only', ({ given, and, when, then }) => {
    given(/^the registry contains instance "vault-minerva"$/, async () => {
      await registerInstance('vault-minerva');
    });

    and(/^"vault-minerva" has one open mission and one active session$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'Open mission',
        status: 'Queued',
      });
      insertSession(dbPaths['vault-minerva']!, {
        id: 'vm-s01',
        title: 'Active session',
        status: 'active',
      });
    });

    when(/^I call cmos_project with action "sweep" and itemType "session"$/, async () => {
      result = await cmosProjectSweep({ itemType: 'session' }, graph);
    });

    then(/^only the session is returned$/, () => {
      expect(result.success).toBe(true);
      expect(result.data?.items).toHaveLength(1);
      expect(result.data!.items[0]!.item_type).toBe('session');
    });

    and(/^no missions appear in the result$/, () => {
      const missions = result.data!.items.filter((i) => i.item_type === 'mission');
      expect(missions).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Blocked items appear before other statuses in sweep output
  // ---------------------------------------------------------------------------

  test('Blocked items appear before other statuses in sweep output', ({
    given,
    and,
    when,
    then,
  }) => {
    given(/^the registry contains instance "vault-minerva"$/, async () => {
      await registerInstance('vault-minerva');
    });

    and(/^"vault-minerva" has missions with statuses "Queued", "In Progress", "Blocked"$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'Queued mission',
        status: 'Queued',
      });
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m02',
        name: 'In progress mission',
        status: 'In Progress',
      });
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m03',
        name: 'Blocked mission',
        status: 'Blocked',
      });
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the Blocked mission appears first in the vault-minerva group$/, () => {
      expect(result.success).toBe(true);
      const vmGroup = result.data!.groups.find((g) => g.instance_id === 'vault-minerva');
      expect(vmGroup).toBeDefined();
      expect(vmGroup!.items[0]!.status).toBe('Blocked');
    });

    and(/^In Progress appears before Queued$/, () => {
      const vmGroup = result.data!.groups.find((g) => g.instance_id === 'vault-minerva')!;
      const statuses = vmGroup.items.map((i) => i.status);
      const inProgressIdx = statuses.indexOf('In Progress');
      const queuedIdx = statuses.indexOf('Queued');
      expect(inProgressIdx).toBeLessThan(queuedIdx);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Inaccessible instance is skipped with a warning
  // ---------------------------------------------------------------------------

  test('Inaccessible instance is skipped with a warning', ({ given, and, when, then }) => {
    given(/^the registry contains instances "vault-minerva" and "missing-project"$/, async () => {
      await registerInstance('vault-minerva');
      await registerInstance('missing-project');
    });

    and(/^"missing-project" has no cmos\/db\/cmos\.sqlite on disk$/, async () => {
      // Register it first (done above), then delete the sqlite file
      await fs.rm(dbPaths['missing-project']!);
    });

    and(/^"vault-minerva" has one open mission$/, () => {
      insertMission(dbPaths['vault-minerva']!, {
        id: 'vm-m01',
        name: 'Vault open mission',
        status: 'In Progress',
      });
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the result includes the vault-minerva mission$/, () => {
      expect(result.success).toBe(true);
      const ids = result.data!.items.map((i) => i.id);
      expect(ids).toContain('vm-m01');
    });

    and(/^the response includes a warnings list noting "missing-project" was unreachable$/, () => {
      expect(result.data!.warnings.length).toBeGreaterThanOrEqual(1);
      const warningText = result.data!.warnings.join(' ');
      expect(warningText).toMatch(/missing-project/);
    });

    and(/^no error is thrown$/, () => {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep with an empty registry returns empty result
  // ---------------------------------------------------------------------------

  test('Sweep with an empty registry returns empty result', ({ given, when, then, and }) => {
    given(/^the registry contains no registered instances$/, () => {
      // Fresh registry — nothing to register
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^the result is an empty list$/, () => {
      expect(result.success).toBe(true);
      expect(result.data?.items).toHaveLength(0);
    });

    and(/^the response is successful \(not an error\)$/, () => {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario: Sweep never writes to foreign instances
  // ---------------------------------------------------------------------------

  test('Sweep never writes to foreign instances', ({ given, and, when, then }) => {
    let codeDeetyMtimeBefore: number;

    given(/^the registry contains instances "vault-minerva" and "code-deety"$/, async () => {
      await registerInstance('vault-minerva');
      await registerInstance('code-deety');
    });

    and(/^"code-deety" has one open mission$/, async () => {
      insertMission(dbPaths['code-deety']!, {
        id: 'cd-m01',
        name: 'Deety open mission',
        status: 'Queued',
      });
      const stat = await fs.stat(dbPaths['code-deety']!);
      codeDeetyMtimeBefore = stat.mtimeMs;
    });

    when(/^I call cmos_project with action "sweep"$/, async () => {
      result = await cmosProjectSweep({}, graph);
    });

    then(/^no write operations are performed against "code-deety"$/, async () => {
      const stat = await fs.stat(dbPaths['code-deety']!);
      expect(stat.mtimeMs).toBe(codeDeetyMtimeBefore);
    });

    and(/^the "code-deety" database modified-at timestamp is unchanged$/, async () => {
      const stat = await fs.stat(dbPaths['code-deety']!);
      expect(stat.mtimeMs).toBe(codeDeetyMtimeBefore);
    });
  });
});
