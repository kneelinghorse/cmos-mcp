// ABOUTME: Tests for cmos_project sweep action — cross-instance open item aggregation.
// ABOUTME: Follows TDD: all tests written before implementation exists.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { cmosProjectSweep, type SweepParams } from '../../../src/tools/cmos/cmos-project-sweep';
import { getTestSchema } from './fixtures/test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Creates a minimal CMOS instance directory at <root>/cmos/db/cmos.sqlite.
 * Returns the absolute project root path and the sqlite path.
 */
async function makeInstance(
  rootDir: string,
  name: string
): Promise<{ projectRoot: string; dbPath: string }> {
  const projectRoot = path.join(rootDir, name);
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(getTestSchema());
  db.close();
  return { projectRoot, dbPath };
}

function insertMission(
  dbPath: string,
  opts: { id: string; name: string; status: string; sprint_id?: string | null }
): void {
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)`).run(
    opts.id,
    opts.sprint_id ?? null,
    opts.name,
    opts.status
  );
  db.close();
}

function insertSession(
  dbPath: string,
  opts: { id: string; title: string; status: string; sprint_id?: string | null }
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status)
     VALUES (?, 'build', ?, ?, datetime('now'), 'test-agent', ?)`
  ).run(opts.id, opts.title, opts.sprint_id ?? null, opts.status);
  db.close();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('cmos_project sweep', () => {
  let rootDir: string;
  let configDir: string;
  let graph: ProjectGraphRegistry;
  let prevConfigEnv: string | undefined;

  beforeEach(async () => {
    rootDir = await makeTempDir('cmos-sweep-root-');
    configDir = await makeTempDir('cmos-sweep-cfg-');
    prevConfigEnv = process.env.CMOS_CONFIG_DIR;
    process.env.CMOS_CONFIG_DIR = configDir;
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    // s79-m02 — the graph is the write-authoritative discovery store sweep reads.
    graph = await ProjectGraphRegistry.create({ configDir });
  });

  afterEach(async () => {
    ProjectGraphRegistry.resetInstance();
    if (prevConfigEnv === undefined) delete process.env.CMOS_CONFIG_DIR;
    else process.env.CMOS_CONFIG_DIR = prevConfigEnv;
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  // --- Happy path ---

  it('returns open missions from all registered instances, excludes Completed', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    const b = await makeInstance(rootDir, 'code-deety');

    insertMission(a.dbPath, { id: 'm-ip', name: 'Active work', status: 'In Progress' });
    insertMission(a.dbPath, { id: 'm-q', name: 'Waiting', status: 'Queued' });
    insertMission(a.dbPath, { id: 'm-done', name: 'Finished', status: 'Completed' });
    insertMission(b.dbPath, { id: 'm-bl', name: 'Blocked task', status: 'Blocked' });

    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });
    graph.registerStore(b.projectRoot, { name: 'code-deety' });

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    const items = result.data!.items;
    expect(items).toHaveLength(3);
    const statuses = items.map((i) => i.status);
    expect(statuses).toContain('In Progress');
    expect(statuses).toContain('Queued');
    expect(statuses).toContain('Blocked');
    expect(statuses).not.toContain('Completed');
  });

  it('each item has the required envelope fields', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertMission(a.dbPath, { id: 'm-1', name: 'Test mission', status: 'Queued', sprint_id: null });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    const item = result.data!.items[0]!;
    expect(item).toMatchObject({
      instance_id: expect.any(String),
      path: a.projectRoot,
      item_type: 'mission',
      id: 'm-1',
      summary: 'Test mission',
      status: 'Queued',
      sprint_id: null,
    });
  });

  it('includes active sessions, excludes completed sessions', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertSession(a.dbPath, { id: 'sess-active', title: 'Morning planning', status: 'active' });
    insertSession(a.dbPath, { id: 'sess-done', title: 'Old session', status: 'completed' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    const items = result.data!.items;
    const sessionItems = items.filter((i) => i.item_type === 'session');
    expect(sessionItems).toHaveLength(1);
    expect(sessionItems[0]!.id).toBe('sess-active');
    expect(sessionItems[0]!.summary).toBe('Morning planning');
    expect(items.some((i) => i.id === 'sess-done')).toBe(false);
  });

  it('groups results by instance_id', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    const b = await makeInstance(rootDir, 'cmos-mcp');
    insertMission(a.dbPath, { id: 'a-1', name: 'A mission', status: 'In Progress' });
    insertMission(b.dbPath, { id: 'b-1', name: 'B mission', status: 'Queued' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });
    graph.registerStore(b.projectRoot, { name: 'cmos-mcp' });

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    const groups = result.data!.groups;
    const groupIds = groups.map((g) => g.instance_id);
    expect(groupIds).toContain('vault-minerva');
    expect(groupIds).toContain('cmos-mcp');
    const aGroup = groups.find((g) => g.instance_id === 'vault-minerva')!;
    const bGroup = groups.find((g) => g.instance_id === 'cmos-mcp')!;
    expect(aGroup.items.every((i) => i.instance_id === 'vault-minerva')).toBe(true);
    expect(bGroup.items.every((i) => i.instance_id === 'cmos-mcp')).toBe(true);
  });

  it('returns empty result when instance has no open items', async () => {
    const a = await makeInstance(rootDir, 'code-deety');
    insertMission(a.dbPath, { id: 'm-done', name: 'Done', status: 'Completed' });
    graph.registerStore(a.projectRoot, { name: 'code-deety' });

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    expect(result.data!.items).toHaveLength(0);
  });

  // --- Filtering ---

  it('filters by instance name', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    const b = await makeInstance(rootDir, 'code-deety');
    insertMission(a.dbPath, { id: 'a-1', name: 'A', status: 'Queued' });
    insertMission(b.dbPath, { id: 'b-1', name: 'B', status: 'Queued' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });
    graph.registerStore(b.projectRoot, { name: 'code-deety' });

    const result = await cmosProjectSweep({ instances: ['vault-minerva'] }, graph);

    expect(result.success).toBe(true);
    const items = result.data!.items;
    expect(items.every((i) => i.instance_id === 'vault-minerva')).toBe(true);
    expect(items.some((i) => i.instance_id === 'code-deety')).toBe(false);
  });

  it('filters by status', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertMission(a.dbPath, { id: 'm-ip', name: 'In Progress', status: 'In Progress' });
    insertMission(a.dbPath, { id: 'm-q', name: 'Queued', status: 'Queued' });
    insertMission(a.dbPath, { id: 'm-bl', name: 'Blocked', status: 'Blocked' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    const result = await cmosProjectSweep({ statusFilter: ['Blocked'] }, graph);

    expect(result.success).toBe(true);
    const items = result.data!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('Blocked');
  });

  it('filters to missions only', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertMission(a.dbPath, { id: 'm-1', name: 'A mission', status: 'Queued' });
    insertSession(a.dbPath, { id: 's-1', title: 'A session', status: 'active' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    const result = await cmosProjectSweep({ itemType: 'mission' }, graph);

    expect(result.success).toBe(true);
    expect(result.data!.items.every((i) => i.item_type === 'mission')).toBe(true);
    expect(result.data!.items.some((i) => i.item_type === 'session')).toBe(false);
  });

  it('filters to sessions only', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertMission(a.dbPath, { id: 'm-1', name: 'A mission', status: 'Queued' });
    insertSession(a.dbPath, { id: 's-1', title: 'A session', status: 'active' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    const result = await cmosProjectSweep({ itemType: 'session' }, graph);

    expect(result.success).toBe(true);
    expect(result.data!.items.every((i) => i.item_type === 'session')).toBe(true);
    expect(result.data!.items.some((i) => i.item_type === 'mission')).toBe(false);
  });

  // --- Ordering ---

  it('sorts Blocked before In Progress before Current before Queued within a group', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertMission(a.dbPath, { id: 'm-q', name: 'Queued', status: 'Queued' });
    insertMission(a.dbPath, { id: 'm-ip', name: 'In Progress', status: 'In Progress' });
    insertMission(a.dbPath, { id: 'm-bl', name: 'Blocked', status: 'Blocked' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    const group = result.data!.groups.find((g) => g.instance_id === 'vault-minerva')!;
    const statuses = group.items.map((i) => i.status);
    expect(statuses[0]).toBe('Blocked');
    expect(statuses[1]).toBe('In Progress');
    expect(statuses[2]).toBe('Queued');
  });

  // --- Resilience ---

  it('skips inaccessible instance with a warning, returns reachable items', async () => {
    const a = await makeInstance(rootDir, 'vault-minerva');
    insertMission(a.dbPath, { id: 'm-1', name: 'Good mission', status: 'Queued' });
    graph.registerStore(a.projectRoot, { name: 'vault-minerva' });

    // Create a valid instance, register it, then delete the sqlite file
    const b = await makeInstance(rootDir, 'missing-project');
    graph.registerStore(b.projectRoot, { name: 'missing-project' });
    await fs.rm(b.dbPath);

    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    expect(result.data!.items.some((i) => i.instance_id === 'vault-minerva')).toBe(true);
    expect(result.data!.warnings.some((w) => w.includes('missing-project'))).toBe(true);
    expect(result.data!.items.some((i) => i.instance_id === 'missing-project')).toBe(false);
  });

  it('returns empty result when registry is empty', async () => {
    // No projects registered
    const result = await cmosProjectSweep({}, graph);

    expect(result.success).toBe(true);
    expect(result.data!.items).toHaveLength(0);
    expect(result.data!.warnings).toHaveLength(0);
  });

  // --- Read-only contract ---

  it('does not modify foreign instance database', async () => {
    const a = await makeInstance(rootDir, 'code-deety');
    insertMission(a.dbPath, { id: 'm-1', name: 'Remote mission', status: 'Queued' });
    graph.registerStore(a.projectRoot, { name: 'code-deety' });

    const statBefore = await fs.stat(a.dbPath);
    await cmosProjectSweep({}, graph);
    const statAfter = await fs.stat(a.dbPath);

    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});
