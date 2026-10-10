// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preparation warnings must survive a later refusal in the same store or its destination.
// ABOUTME: Real SQLite copies exercise the CLI core while only migration readiness is fault-injected.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import * as migrations from '../../../src/tools/cmos/schema-migrations';
import { spinOut } from '../../../src/tools/cmos/spin-out';

let dir: string, source: string, target: string;
let previousConfig: string | undefined;
const dbPath = (root: string) => path.join(root, 'cmos/db/cmos.sqlite');
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'spin-out-warnings-'));
  source = path.join(dir, 'source');
  target = path.join(dir, 'target');
  previousConfig = process.env.CMOS_CONFIG_DIR;
  process.env.CMOS_CONFIG_DIR = path.join(dir, 'config');
  ProjectGraphRegistry.resetInstance();
  seedCmosDb(source, { projectId: 'source' });
  seedCmosDb(target, { projectId: 'target' });
  const registry = await ProjectGraphRegistry.create();
  registry.register({ project_id: 'source', store_path: source, name: 'Source' });
  const db = new Database(dbPath(source));
  db.prepare("INSERT INTO missions(id,name,status) VALUES('m1','One','Queued')").run();
  db.close();
});
afterEach(() => {
  jest.restoreAllMocks();
  ProjectGraphRegistry.resetInstance();
  if (previousConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = previousConfig;
  rmSync(dir, { recursive: true, force: true });
});

it.each(['source', 'target'] as const)(
  'preserves all collected warnings when %s shape readiness refuses before any copy',
  async (failingStore) => {
    const ensureShape = migrations.ensureDecisionShapeColumns;
    const visited: string[] = [];
    jest.spyOn(migrations, 'ensureDecisionShapeColumns').mockImplementation((client) => {
      const store = client.path === dbPath(source) ? 'source' : 'target';
      visited.push(store);
      return {
        ...ensureShape(client),
        ready: store !== failingStore,
        warnings: [`${store} migration diagnostic retained`],
      };
    });
    const result = await spinOut({ from: source, to: target, missionIds: ['m1'], apply: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Required decision shape migration failed');
    expect(visited).toEqual(failingStore === 'source' ? ['source'] : ['source', 'target']);
    expect(result.warnings).toEqual(
      expect.arrayContaining(visited.map((store) => `${store} migration diagnostic retained`))
    );
    for (const [root, expected] of [
      [source, [{ status: 'Queued' }]],
      [target, []],
    ] as const) {
      const db = new Database(dbPath(root));
      expect(db.prepare('SELECT status FROM missions').all()).toEqual(expected);
      expect(db.prepare("SELECT key FROM metadata WHERE key GLOB 'spin_out_row:*'").all()).toEqual(
        []
      );
      db.close();
    }
  }
);
