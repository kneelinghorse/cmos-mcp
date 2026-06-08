// ABOUTME: Regression test for Sprint 66 m06 — reproduces decision #700 (Sprint 65) where the
// ABOUTME: CredentialStore singleton cache silently clobbered concurrent writes from another process.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  CredentialStore,
  CMOS_CONFIG_DIR_ENV,
  type ProjectKeyRecord,
  type UserScopedKeyRecord,
} from '../../src/intelligence/credential-store';

describe('CredentialStore — cache invalidation (Sprint 66 m06)', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-store-cache-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function userRecord(overrides: Partial<UserScopedKeyRecord> = {}): UserScopedKeyRecord {
    const now = new Date().toISOString();
    return {
      key: 'cmk_user_default',
      label: 'device: test',
      issuedAt: now,
      lastUsedAt: now,
      ...overrides,
    };
  }

  function projectRecord(overrides: Partial<ProjectKeyRecord> = {}): ProjectKeyRecord {
    const now = new Date().toISOString();
    return {
      key: 'cmk_proj_default',
      keyId: 'proj-key-id',
      parentKeyId: 'user-key-id',
      label: 'auto: registered',
      issuedAt: now,
      lastUsedAt: now,
      ...overrides,
    };
  }

  // Bump the file mtime forward by a clear margin so the cache-freshness check
  // fires deterministically regardless of underlying filesystem mtime resolution.
  async function bumpMtime(filePath: string): Promise<void> {
    const stat = await fs.stat(filePath);
    const future = new Date(stat.mtimeMs + 5000);
    await fs.utimes(filePath, future, future);
  }

  it('detects an external write to credentials.json and re-reads on next load', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('initial', userRecord({ key: 'cmk_initial' }));

    // External writer (simulating another process) appends a new row directly.
    const raw = await fs.readFile(store.path, 'utf-8');
    const parsed = JSON.parse(raw);
    parsed.userScopedKeys['external'] = userRecord({ key: 'cmk_external' });
    await fs.writeFile(store.path, JSON.stringify(parsed));
    await bumpMtime(store.path);

    // Without mtime-based invalidation this returns the stale cache (only 'initial').
    const keys = await store.listUserScopedKeys();
    expect(Object.keys(keys).sort()).toEqual(['external', 'initial']);
    expect(keys['external']?.key).toBe('cmk_external');
  });

  it('reproduces decision #700: process B mutation must not clobber process A write', async () => {
    // Process B: long-running MCP server. Loads + caches initial state.
    const processB = await CredentialStore.create({ configDir: tempDir });
    await processB.upsertUserScopedKey('user-key', userRecord({ key: 'cmk_user' }));
    // Prime B's cache by reading (mirrors MCP server having loaded credentials at startup).
    expect(Object.keys(await processB.listUserScopedKeys())).toEqual(['user-key']);

    // Process A: separate script invocation. Independent CredentialStore instance
    // pointing at the same file (simulated via resetInstance + create).
    CredentialStore.resetInstance();
    const processA = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'project-from-A');
    await processA.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_proj_from_A' }));
    await bumpMtime(processA.path);

    // Process B does a subsequent mutation. Before the fix, B's load() returned the
    // pre-A cache and B's save() overwrote process A's projectKey entry on disk.
    await processB.upsertUserScopedKey('user-key-2', userRecord({ key: 'cmk_user_2' }));

    // Verify the on-disk file reflects both writers — read from a third fresh instance.
    CredentialStore.resetInstance();
    const verifier = await CredentialStore.create({ configDir: tempDir });
    const userKeys = await verifier.listUserScopedKeys();
    const projectKeys = await verifier.listProjectKeys();

    expect(userKeys['user-key']?.key).toBe('cmk_user');
    expect(userKeys['user-key-2']?.key).toBe('cmk_user_2');
    expect(projectKeys[path.resolve(projectRoot)]?.key).toBe('cmk_proj_from_A');
  });

  it('skips re-reading the file when the cached mtime matches disk (cache hit path)', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('only', userRecord({ key: 'cmk_only' }));

    // Spy starts AFTER the upsert so the post-save mtime stat doesn't count.
    const readFileSpy = jest.spyOn(fs, 'readFile');
    await store.getUserScopedKey('only');
    await store.listUserScopedKeys();
    await store.listProjectKeys();
    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();
  });
});
