// ABOUTME: Unit tests for CredentialStore — Sprint 57 m01 local credential persistence.
// ABOUTME: Covers atomic write + 0600 perms + CMOS_CONFIG_DIR override + multi-user-scoped-key coexistence.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  CredentialStore,
  CMOS_CONFIG_DIR_ENV,
  type ProjectKeyRecord,
  type UserScopedKeyRecord,
} from '../../src/intelligence/credential-store';

describe('CredentialStore', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-store-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function keyRecord(overrides: Partial<UserScopedKeyRecord> = {}): UserScopedKeyRecord {
    const now = new Date().toISOString();
    return {
      key: 'cmk_user_abc',
      label: 'device: cmos-mcp/1.0.0 (darwin; host) @ 2026-04-17T12:00:00Z',
      issuedAt: now,
      lastUsedAt: now,
      ...overrides,
    };
  }

  function projectRecord(overrides: Partial<ProjectKeyRecord> = {}): ProjectKeyRecord {
    const now = new Date().toISOString();
    return {
      key: 'cmk_project_xyz',
      keyId: 'project-key-id-1',
      parentKeyId: 'user-key-id-1',
      label: 'auto: registered 2026-04-17T12:00:00Z',
      issuedAt: now,
      lastUsedAt: now,
      ...overrides,
    };
  }

  it('writes credentials.json atomically with 0600 permissions', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('user-key-id-1', keyRecord());

    const stat = await fs.stat(store.path);
    // Mask to the access-bit portion; ignore file-type bits.
    expect(stat.mode & 0o777).toBe(0o600);

    const raw = await fs.readFile(store.path, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.userScopedKeys['user-key-id-1']?.key).toBe('cmk_user_abc');
    expect(parsed.projectKeys).toEqual({});
  });

  it('supports multiple user-scoped keys coexisting (one per device)', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey(
      'laptop-key',
      keyRecord({ key: 'cmk_laptop', label: 'device: laptop' })
    );
    await store.upsertUserScopedKey(
      'desktop-key',
      keyRecord({ key: 'cmk_desktop', label: 'device: desktop' })
    );

    const all = await store.listUserScopedKeys();
    expect(Object.keys(all).sort()).toEqual(['desktop-key', 'laptop-key']);
    expect(all['laptop-key']?.key).toBe('cmk_laptop');
    expect(all['desktop-key']?.key).toBe('cmk_desktop');
  });

  it('upsert replaces an existing user-scoped key row keyed by keyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('key-1', keyRecord({ key: 'cmk_v1' }));
    await store.upsertUserScopedKey('key-1', keyRecord({ key: 'cmk_v2' }));

    const fetched = await store.getUserScopedKey('key-1');
    expect(fetched?.key).toBe('cmk_v2');
    const all = await store.listUserScopedKeys();
    expect(Object.keys(all)).toEqual(['key-1']);
  });

  it('returns undefined when a user-scoped key is not present', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    expect(await store.getUserScopedKey('does-not-exist')).toBeUndefined();
    expect(await store.listUserScopedKeys()).toEqual({});
  });

  it('honors CMOS_CONFIG_DIR env var when no explicit configDir is supplied', async () => {
    process.env[CMOS_CONFIG_DIR_ENV] = tempDir;
    const store = await CredentialStore.create();
    expect(store.path).toBe(path.join(tempDir, 'credentials.json'));

    await store.upsertUserScopedKey('k', keyRecord());
    const raw = await fs.readFile(store.path, 'utf-8');
    expect(JSON.parse(raw).userScopedKeys.k).toBeDefined();
  });

  it('normalizes projectRoot via path.resolve on getProjectKey', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const absolute = path.resolve('/tmp/project-a');
    // Hand-seed the store file so we can confirm lookup normalization without
    // needing an upsertProjectKey surface (that lands in m02).
    await fs.writeFile(
      store.path,
      JSON.stringify({
        version: 1,
        userScopedKeys: {},
        projectKeys: { [absolute]: projectRecord({ key: 'cmk_abs_hit' }) },
        updatedAt: new Date().toISOString(),
      })
    );
    store.clearCache();

    const resolved = await store.getProjectKey('/tmp/project-a');
    expect(resolved?.key).toBe('cmk_abs_hit');
  });

  it('returns undefined when projectRoot is an empty string', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    expect(await store.getProjectKey('')).toBeUndefined();
  });

  it('treats a missing credentials.json as an empty store', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    expect(await store.listUserScopedKeys()).toEqual({});
    expect(await store.getProjectKey('/any')).toBeUndefined();
  });

  it('treats a malformed credentials.json as an empty store without throwing', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await fs.writeFile(store.path, 'not valid json');
    store.clearCache();

    expect(await store.listUserScopedKeys()).toEqual({});
  });

  it('treats a credentials.json missing required fields as an empty store', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await fs.writeFile(
      store.path,
      JSON.stringify({ version: 1 /* missing userScopedKeys/projectKeys */ })
    );
    store.clearCache();

    expect(await store.listUserScopedKeys()).toEqual({});
  });

  it('upsertUserScopedKey rejects an empty keyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await expect(store.upsertUserScopedKey('', keyRecord())).rejects.toThrow(/keyId is required/);
  });

  it('round-trips user-scoped + project key rows through disk reads (cache bypass)', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('user-A', keyRecord({ key: 'cmk_user_A' }));

    // Hand-append a projectKey to confirm the read path returns it after a cache drop.
    const raw = JSON.parse(await fs.readFile(store.path, 'utf-8'));
    raw.projectKeys[path.resolve('/tmp/p')] = projectRecord({ key: 'cmk_proj_P' });
    await fs.writeFile(store.path, JSON.stringify(raw));
    store.clearCache();

    expect((await store.getUserScopedKey('user-A'))?.key).toBe('cmk_user_A');
    expect((await store.getProjectKey('/tmp/p'))?.key).toBe('cmk_proj_P');
  });

  it('upsertProjectKey writes a project-scoped row, then getProjectKey reads it back (path-normalized)', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'project-x');
    await store.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_proj_new' }));

    expect((await store.getProjectKey(projectRoot))?.key).toBe('cmk_proj_new');
    // Trailing slash normalizes to the same row.
    expect((await store.getProjectKey(`${projectRoot}/`))?.key).toBe('cmk_proj_new');
  });

  it('upsert replaces an existing project-scoped row for the same root', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'project-y');
    await store.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_v1' }));
    await store.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_v2' }));

    expect((await store.getProjectKey(projectRoot))?.key).toBe('cmk_v2');
    const all = await store.listProjectKeys();
    expect(Object.keys(all)).toHaveLength(1);
  });

  it('upsertProjectKey rejects an empty projectRoot', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await expect(store.upsertProjectKey('', projectRecord())).rejects.toThrow(
      /projectRoot is required/
    );
  });

  it('listProjectKeys returns every row keyed by absolute projectRoot', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const rootA = path.join(tempDir, 'project-A');
    const rootB = path.join(tempDir, 'project-B');
    await store.upsertProjectKey(rootA, projectRecord({ key: 'cmk_A' }));
    await store.upsertProjectKey(rootB, projectRecord({ key: 'cmk_B' }));

    const all = await store.listProjectKeys();
    expect(Object.keys(all).sort()).toEqual([path.resolve(rootA), path.resolve(rootB)].sort());
    expect(all[path.resolve(rootA)]?.key).toBe('cmk_A');
  });

  it('removeUserScopedKey drops the row keyed by keyId', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('keep', keyRecord({ key: 'cmk_keep' }));
    await store.upsertUserScopedKey('drop', keyRecord({ key: 'cmk_drop' }));
    await store.removeUserScopedKey('drop');

    expect(await store.getUserScopedKey('drop')).toBeUndefined();
    expect(await store.getUserScopedKey('keep')).toBeDefined();
  });

  it('removeProjectKey is a no-op on a missing root', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await expect(store.removeProjectKey('/not/registered')).resolves.toBeUndefined();
  });

  it('swapProjectKey atomically writes the new key with a pendingRevoke slot', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'rotator');
    await store.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_v1', keyId: 'v1' }));

    const next: ProjectKeyRecord = projectRecord({ key: 'cmk_v2', keyId: 'v2' });
    await store.swapProjectKey(projectRoot, next, {
      key: 'cmk_v1',
      keyId: 'v1',
      revokeAt: '2099-01-01T00:00:00Z',
    });

    const after = await store.getProjectKey(projectRoot);
    expect(after?.key).toBe('cmk_v2');
    expect(after?.pendingRevoke).toEqual({
      key: 'cmk_v1',
      keyId: 'v1',
      revokeAt: '2099-01-01T00:00:00Z',
    });
  });

  it('clearPendingRevoke drops the pending slot without touching the active key', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'cleanup');
    await store.swapProjectKey(projectRoot, projectRecord({ key: 'cmk_v2', keyId: 'v2' }), {
      key: 'cmk_v1',
      keyId: 'v1',
      revokeAt: '2099-01-01T00:00:00Z',
    });

    await store.clearPendingRevoke(projectRoot);
    const after = await store.getProjectKey(projectRoot);
    expect(after?.key).toBe('cmk_v2');
    expect(after?.pendingRevoke).toBeUndefined();
  });

  it('getInstance returns the same instance across calls until resetInstance', async () => {
    process.env[CMOS_CONFIG_DIR_ENV] = tempDir;
    const a = CredentialStore.getInstance();
    const b = CredentialStore.getInstance();
    expect(a).toBe(b);
    CredentialStore.resetInstance();
    const c = CredentialStore.getInstance();
    expect(c).not.toBe(a);
  });
});
