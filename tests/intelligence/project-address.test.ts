// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Addresses select exactly one registered store without repairing any scanned identity.
// ABOUTME: Incomplete discovery refuses instead of allowing a hidden duplicate to misdirect a write.

import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { createHash } from 'crypto';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readStoredProjectAddress,
  resolveRegisteredAddress,
} from '../../src/intelligence/project-address';
import { CmosDetector } from '../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { resolveSenderContext, SenderResolutionError } from '../../src/intelligence/sender-context';
import { cmosProjectInit } from '../../src/tools/cmos/cmos-project-init';
import { cmosProjectList, formatProjectListForLLM } from '../../src/tools/cmos/cmos-project-list';
import { classifySenderResolutionError } from '../../src/tools/cmos/sender-refusal';
import {
  captureToolCall,
  unwrapCapturedToolCallError,
} from '../../src/tools/cmos/tool-call-context';
import { seedCmosDb } from '../helpers/seedCmosDb';

const ADDRESS = 'cmos://operator/address-test';
let temp: string;
let graph: ProjectGraphRegistry;
let target: string;
let sibling: string;
const oldConfig = process.env.CMOS_CONFIG_DIR;
const oldBootstrapRoot = process.env.CMOS_PROJECT_ROOT;

beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-address-'));
  process.env.CMOS_CONFIG_DIR = path.join(temp, 'config');
  delete process.env.CMOS_PROJECT_ROOT;
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  graph = await ProjectGraphRegistry.create();
  target = add('target', ADDRESS);
  sibling = add('sibling', '');
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  CmosDetector.resetInstance();
  if (oldConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = oldConfig;
  if (oldBootstrapRoot === undefined) delete process.env.CMOS_PROJECT_ROOT;
  else process.env.CMOS_PROJECT_ROOT = oldBootstrapRoot;
  fs.rmSync(temp, { recursive: true, force: true });
});
function add(name: string, address: string): string {
  const root = path.join(temp, name);
  seedCmosDb(root, { projectName: name, cmosAddress: address });
  graph.register({ project_id: name, store_path: root, name });
  return root;
}
function dbPath(root: string) {
  return path.join(root, 'cmos/db/cmos.sqlite');
}
function alter(root: string, sql: string) {
  const db = new Database(dbPath(root));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
async function resolve(address = ADDRESS) {
  return (
    await captureToolCall('read', () =>
      resolveSenderContext({
        explicitProjectRoot: address,
        requireSenderIdentity: false,
        registryOverride: graph,
        cwdOverride: target,
      })
    )
  ).value;
}
async function refusal(address = ADDRESS) {
  try {
    await resolve(address);
  } catch (caught) {
    const error = unwrapCapturedToolCallError(caught);
    expect(error).toBeInstanceOf(SenderResolutionError);
    const result = await classifySenderResolutionError(error as SenderResolutionError);
    expect(result.suggestion).toContain('cmos_project(action="list")');
    expect(result.suggestion).toMatch(/projectRoot.*folder/);
    return result;
  }
  throw new Error('Expected address refusal');
}

it('resolves the exact stored address explicitly with CMOS_PROJECT_ROOT unset, leaving scanned bytes alone', async () => {
  const before = [target, sibling].map((root) => fs.readFileSync(dbPath(root)));
  expect(resolveRegisteredAddress(ADDRESS, graph)).toEqual({ projectRoot: target });
  expect([target, sibling].map((root) => fs.readFileSync(dbPath(root)))).toEqual(before);
  const result = await resolve();
  expect(result).toMatchObject({ projectRoot: target, source: 'explicit', cmosAddress: ADDRESS });
  expect(fs.readFileSync(dbPath(sibling))).toEqual(before[1]);
  expect(fs.existsSync(`${dbPath(sibling)}-wal`)).toBe(false);
});
it.each(['cmos://operator/absent', 'cmos://OPERATOR/address-test', `${ADDRESS}/`, 'local-only'])(
  'refuses %s rather than falling back to cwd or normalizing the name',
  async (address) => {
    expect((await refusal(address)).code).toBe('PROJECT_ADDRESS_UNRESOLVABLE');
  }
);
it('refuses duplicates even when one would otherwise be the first or default project', async () => {
  add('duplicate', ADDRESS);
  expect((await refusal()).message).toMatch(/2.*match/);
});
it('ignores archived registry rows', async () => {
  add('archived', ADDRESS);
  graph.archive('archived');
  expect((await resolve()).projectRoot).toBe(target);
});
it.each([
  'DROP TABLE contexts',
  "UPDATE contexts SET content = 'null' WHERE id = 'project_identity'",
  "UPDATE contexts SET content = 'not JSON' WHERE id = 'project_identity'",
  "UPDATE contexts SET content = '{\"cmos_address\":42}' WHERE id = 'project_identity'",
])('refuses an incomplete scan; never seeds or migrates (%s)', async (sql) => {
  alter(sibling, sql);
  const before = fs.readFileSync(dbPath(sibling));
  expect((await refusal()).message).toMatch(/unreadable|identity/i);
  expect(fs.readFileSync(dbPath(sibling))).toEqual(before);
});
it('a normally initialized registered project without an identity row cannot block another stored address', async () => {
  const fresh = path.join(temp, 'fresh-init');
  fs.mkdirSync(fresh);
  const initialized = await cmosProjectInit({
    projectRoot: fresh,
    projectName: 'Fresh local record',
  });
  expect(initialized.success).toBe(true);
  expect(graph.list().some((entry) => entry.store_path === fresh)).toBe(true);
  const countIdentityRows = () => {
    const db = new Database(dbPath(fresh), { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare("SELECT COUNT(*) AS count FROM contexts WHERE id = 'project_identity'")
        .get();
    } finally {
      db.close();
    }
  };
  // Init deliberately defers this row until a later write; this is healthy fresh-store state.
  expect(countIdentityRows()).toEqual({ count: 0 });
  const roots = [target, sibling, fresh];
  const snapshots = async (label: string) => {
    const states = [];
    for (const [index, root] of roots.entries()) {
      const db = new Database(dbPath(root), { readonly: true, fileMustExist: true });
      const snapshot = path.join(temp, `${label}-${index}.sqlite`);
      try {
        const journal = db.pragma('journal_mode', { simple: true });
        await db.backup(snapshot);
        states.push({
          journal,
          hash: createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex'),
        });
      } finally {
        db.close();
      }
    }
    return states;
  };
  // Init can already choose WAL; backups include committed WAL pages without changing its mode.
  const before = await snapshots('before');
  expect(readStoredProjectAddress(fresh)).toEqual({
    identity: { id: initialized.data!.projectId, address: null },
  });
  expect(resolveRegisteredAddress(ADDRESS, graph)).toEqual({ projectRoot: target });
  const listed = await cmosProjectList({});
  expect(listed.success).toBe(true);
  const item = listed.data?.projects.find((project) => project.projectRoot === fresh);
  expect(item).toMatchObject({ id: initialized.data!.projectId, address: null });
  expect(item?.identityError).toBeUndefined();
  expect(listed.warnings).toBeUndefined();
  expect(formatProjectListForLLM(listed)).toContain('local-only');
  expect(await snapshots('after')).toEqual(before);
  expect(countIdentityRows()).toEqual({ count: 0 });
});
it.each([
  "DELETE FROM metadata WHERE key = 'project_id'",
  "UPDATE metadata SET value = '' WHERE key = 'project_id'",
])('an absent identity row still refuses without a valid canonical id (%s)', async (sql) => {
  alter(sibling, "DELETE FROM contexts WHERE id = 'project_identity'; " + sql);
  const before = fs.readFileSync(dbPath(sibling));
  expect((await refusal()).code).toBe('PROJECT_ADDRESS_UNRESOLVABLE');
  expect(readStoredProjectAddress(sibling).error).toBe('metadata has no stored project_id');
  expect(fs.readFileSync(dbPath(sibling))).toEqual(before);
});
it('refuses SQL NULL identity from an older nullable schema', async () => {
  alter(
    sibling,
    "DROP TABLE contexts; CREATE TABLE contexts (id TEXT, content TEXT); INSERT INTO contexts VALUES ('project_identity', NULL)"
  );
  expect((await refusal()).code).toBe('PROJECT_ADDRESS_UNRESOLVABLE');
});
it('reads local-only identities for list without inventing an address', async () => {
  const result = await cmosProjectList({});
  expect(result.success).toBe(true);
  expect(result.data?.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'target', address: ADDRESS, projectRoot: target }),
      expect.objectContaining({ id: 'sibling', address: null, projectRoot: sibling }),
    ])
  );
  expect(formatProjectListForLLM(result)).toContain('local-only');
});
it('reads the canonical metadata id when an older identity blob does not repeat it', async () => {
  alter(
    target,
    "UPDATE contexts SET content = json_set(content, '$.project_id', '') WHERE id = 'project_identity'"
  );
  const before = fs.readFileSync(dbPath(target));
  expect(resolveRegisteredAddress(ADDRESS, graph)).toEqual({ projectRoot: target });
  const result = await cmosProjectList({});
  expect(result.data?.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'target', address: ADDRESS, projectRoot: target }),
    ])
  );
  expect(fs.readFileSync(dbPath(target))).toEqual(before);
});
it('list still gives paths and an explicit warning when one store cannot supply identity', async () => {
  alter(sibling, 'DROP TABLE contexts');
  const result = await cmosProjectList({});
  expect(result.success).toBe(true);
  expect(result.warnings?.join(' ')).toContain(sibling);
  expect(result.data?.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ projectRoot: sibling, id: null, address: null }),
    ])
  );
  expect(formatProjectListForLLM(result)).toContain('identity unavailable');
});
it('a cross-process exclusive lock blocks a unique match rather than hiding a duplicate', async () => {
  const duplicate = add('locked', ADDRESS);
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        '-e',
        `const DB=require(process.argv[1]); const db=new DB(process.argv[2]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('ready'); setInterval(()=>{},1000);`,
        require.resolve('better-sqlite3'),
        dbPath(duplicate),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    await once(child.stdout!, 'data');
    expect((await refusal()).message).toMatch(/unreadable|locked/i);
  } finally {
    if (child) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});
