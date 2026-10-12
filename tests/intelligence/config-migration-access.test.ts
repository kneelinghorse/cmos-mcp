// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Cached config objects must not outlive a shared-config migration and fork private state.
// ABOUTME: Retained readers, writers and singleton factories refuse locks and moved legacy paths.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';

let temporary: string;
let legacy: string;
let current: string;
const record = () => ({
  key: 'test-credential',
  label: 'migration fixture',
  issuedAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
});

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'config-migration-access-'));
  legacy = path.join(temporary, '.config', 'cmos-mcp');
  current = path.join(temporary, '.config', 'rbook');
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
});

afterEach(() => {
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  fs.rmSync(temporary, { recursive: true, force: true });
});

it.each(['.rbook-config-migration.json', '.rbook-config-migration.lock'])(
  'refuses cached credential reads and pinned factories while %s exists',
  async (marker) => {
    const store = await CredentialStore.create({ configDir: legacy });
    await store.upsertUserScopedKey('before', record());
    await store.listUserScopedKeys();
    fs.writeFileSync(path.join(path.dirname(legacy), marker), '{}');
    await expect(store.listUserScopedKeys()).rejects.toThrow(/migrat/i);
    expect(() => CredentialStore.getInstance()).toThrow(/migrat/i);
    await expect(CredentialStore.create({ configDir: legacy })).rejects.toThrow(/migrat/i);
  }
);

it('rechecks before saving when migration starts during an awaited credential read', async () => {
  const store = await CredentialStore.create({ configDir: legacy });
  await store.upsertUserScopedKey('before', record());
  const bytes = fs.readFileSync(store.path);
  const pending = store.upsertUserScopedKey('after', record());
  fs.mkdirSync(path.join(path.dirname(legacy), '.rbook-config-migration.lock'));
  await expect(pending).rejects.toThrow(/migrat/i);
  expect(fs.readFileSync(store.path)).toEqual(bytes);
});

it('does not write or retain an unpersisted key when migration begins during save preparation', async () => {
  const store = await CredentialStore.create({ configDir: legacy });
  await store.upsertUserScopedKey('before', record());
  const bytes = fs.readFileSync(store.path);
  const marker = path.join(path.dirname(legacy), '.rbook-config-migration.lock');
  const mkdir = fs.promises.mkdir;
  const interleave = jest
    .spyOn(fs.promises, 'mkdir')
    .mockImplementation(async (directory, options) => {
      const result = await mkdir(directory, options);
      if (directory === legacy) fs.mkdirSync(marker);
      return result;
    });
  try {
    await expect(store.upsertUserScopedKey('after', record())).rejects.toThrow(/migrat/i);
  } finally {
    interleave.mockRestore();
  }
  expect(fs.readFileSync(store.path)).toEqual(bytes);
  fs.rmSync(marker, { recursive: true });
  expect(Object.keys(await store.listUserScopedKeys())).toEqual(['before']);
});

it('does not recreate a moved legacy directory through retained credential objects or factories', async () => {
  const store = await CredentialStore.create({ configDir: legacy });
  await store.upsertUserScopedKey('before', record());
  fs.renameSync(legacy, current);
  await expect(store.listUserScopedKeys()).rejects.toThrow(/restart|config|moved/i);
  await expect(store.upsertUserScopedKey('after', record())).rejects.toThrow(
    /restart|config|moved/i
  );
  expect(() => CredentialStore.getInstance()).toThrow(/restart|config|moved/i);
  await expect(CredentialStore.create({ configDir: legacy })).rejects.toThrow(
    /restart|config|moved/i
  );
  expect(fs.existsSync(legacy)).toBe(false);
  const fresh = await CredentialStore.create({ configDir: current });
  expect(Object.keys(await fresh.listUserScopedKeys())).toEqual(['before']);
});

it('guards retained registry connections and pinned factories before reading or writing', async () => {
  const graph = await ProjectGraphRegistry.create({ configDir: legacy });
  graph.register({
    project_id: 'before',
    store_path: path.join(temporary, 'project'),
    name: 'Before',
  });
  fs.mkdirSync(path.join(path.dirname(legacy), '.rbook-config-migration.lock'));
  expect(() => graph.list()).toThrow(/migrat/i);
  expect(() =>
    graph.register({
      project_id: 'after',
      store_path: path.join(temporary, 'other'),
      name: 'After',
    })
  ).toThrow(/migrat/i);
  expect(() => ProjectGraphRegistry.getInstance()).toThrow(/migrat/i);
  await expect(ProjectGraphRegistry.create({ configDir: legacy })).rejects.toThrow(/migrat/i);
  fs.rmSync(path.join(path.dirname(legacy), '.rbook-config-migration.lock'), { recursive: true });
  expect(graph.list().map((row) => row.project_id)).toEqual(['before']);
});

it('does not reopen or recreate a moved legacy registry through a retained closed object', async () => {
  const graph = await ProjectGraphRegistry.create({ configDir: legacy });
  graph.register({
    project_id: 'before',
    store_path: path.join(temporary, 'project'),
    name: 'Before',
  });
  graph.close();
  fs.renameSync(legacy, current);
  expect(() => graph.list()).toThrow(/restart|config|moved/i);
  expect(() => ProjectGraphRegistry.getInstance()).toThrow(/restart|config|moved/i);
  await expect(ProjectGraphRegistry.create({ configDir: legacy })).rejects.toThrow(
    /restart|config|moved/i
  );
  expect(fs.existsSync(legacy)).toBe(false);
  const fresh = await ProjectGraphRegistry.create({ configDir: current });
  expect(fresh.list().map((row) => row.project_id)).toEqual(['before']);
});
