// ABOUTME: Sprint 67 m05 — runCleanup helper coverage. Verifies the dry-run vs --prune split,
// ABOUTME: stale-detection across the (inRegistry, onDisk) matrix, and that the s66-m06 cache
// ABOUTME: invalidation makes a subsequent load() observe the prune.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { ProjectRegistry } from '../../src/intelligence/project-registry';
import { runCleanup } from '../../scripts/cleanup-stale-credkeys';

describe('cleanup-stale-credkeys', () => {
  let configDir: string;
  let scratch: string;

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-cleanup-cfg-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-cleanup-scratch-'));
    CredentialStore.resetInstance();
    ProjectRegistry.resetInstance();
  });

  afterEach(() => {
    CredentialStore.resetInstance();
    ProjectRegistry.resetInstance();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function makeProjectRoot(name: string): string {
    const root = path.join(scratch, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  async function seedProjectKey(projectRoot: string, keyId: string): Promise<void> {
    const store = await CredentialStore.create({ configDir });
    await store.upsertProjectKey(projectRoot, {
      key: `cmk_test_${keyId}`,
      keyId,
      label: `test:${keyId}`,
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      parentKeyId: 'parent-1',
    });
    CredentialStore.resetInstance();
  }

  /**
   * Write the registry file directly so we can register a projectRoot
   * regardless of whether it has CMOS — ProjectRegistry.register() requires
   * cmos/db/cmos.sqlite to exist, which is more setup than these tests need
   * (we're exercising the cleanup logic, not the detector).
   */
  function seedRegistryEntry(projectRoot: string, name: string): void {
    const registryPath = path.join(configDir, 'project-registry.json');
    const now = new Date().toISOString();
    const resolvedRoot = path.resolve(projectRoot);
    let registryFile: { version: number; projects: Record<string, unknown>; updatedAt: string };
    if (fs.existsSync(registryPath)) {
      registryFile = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } else {
      registryFile = { version: 1, projects: {}, updatedAt: now };
    }
    registryFile.projects[resolvedRoot] = {
      projectRoot: resolvedRoot,
      name,
      registeredAt: now,
      lastAccessedAt: now,
    };
    registryFile.updatedAt = now;
    fs.writeFileSync(registryPath, JSON.stringify(registryFile, null, 2));
  }

  it('returns an empty stale list when every key points at a registered + on-disk project', async () => {
    const root = makeProjectRoot('valid-1');
    await seedProjectKey(root, 'keyA');
    seedRegistryEntry(root, 'valid-1');

    const summary = await runCleanup({ configDir });

    expect(summary.total).toBe(1);
    expect(summary.stale).toBe(0);
    expect(summary.kept).toBe(1);
    expect(summary.rows[0].recommendation).toBe('keep');
    expect(summary.rows[0].inRegistry).toBe(true);
    expect(summary.rows[0].onDisk).toBe(true);
  });

  it('flags a key whose projectRoot is missing from BOTH the registry and the filesystem', async () => {
    const ghostRoot = path.join(scratch, 'never-existed');
    await seedProjectKey(ghostRoot, 'ghost-1');
    // intentionally NOT registered, NOT on disk

    const summary = await runCleanup({ configDir });

    expect(summary.stale).toBe(1);
    expect(summary.rows[0].recommendation).toBe('stale-remove');
    expect(summary.rows[0].inRegistry).toBe(false);
    expect(summary.rows[0].onDisk).toBe(false);
  });

  it('flags a key that is in the registry but not on disk (either-signal-missing is stale)', async () => {
    const root = makeProjectRoot('registered-then-deleted');
    await seedProjectKey(root, 'keyB');
    seedRegistryEntry(root, 'registered-then-deleted');
    fs.rmSync(root, { recursive: true, force: true });

    const summary = await runCleanup({ configDir });

    expect(summary.stale).toBe(1);
    expect(summary.rows[0].recommendation).toBe('stale-remove');
    expect(summary.rows[0].inRegistry).toBe(true);
    expect(summary.rows[0].onDisk).toBe(false);
  });

  it('flags a key that is on disk but not in the registry (either-signal-missing is stale)', async () => {
    const root = makeProjectRoot('on-disk-unregistered');
    await seedProjectKey(root, 'keyC');
    // intentionally NOT registered

    const summary = await runCleanup({ configDir });

    expect(summary.stale).toBe(1);
    expect(summary.rows[0].recommendation).toBe('stale-remove');
    expect(summary.rows[0].inRegistry).toBe(false);
    expect(summary.rows[0].onDisk).toBe(true);
  });

  it('--prune removes stale keys, leaves valid keys untouched', async () => {
    const validRoot = makeProjectRoot('still-valid');
    await seedProjectKey(validRoot, 'valid-key');
    seedRegistryEntry(validRoot, 'still-valid');

    const ghostRoot = path.join(scratch, 'phantom');
    await seedProjectKey(ghostRoot, 'phantom-key');

    const summary = await runCleanup({ configDir, prune: true });

    expect(summary.stale).toBe(1);
    expect(summary.removed).toBe(1);
    expect(summary.kept).toBe(1);

    // Verify the prune actually persisted (mtime-based cache invalidation
    // from s66-m06 makes a fresh load() see the change).
    CredentialStore.resetInstance();
    const verify = await CredentialStore.create({ configDir });
    const remaining = await verify.listProjectKeys();
    expect(Object.keys(remaining)).toEqual([path.resolve(validRoot)]);
  });

  it('dry-run does NOT mutate even when stale keys are present', async () => {
    const ghostRoot = path.join(scratch, 'phantom-2');
    await seedProjectKey(ghostRoot, 'phantom-key-2');

    const summary = await runCleanup({ configDir }); // no prune flag

    expect(summary.stale).toBe(1);
    expect(summary.removed).toBe(0);

    CredentialStore.resetInstance();
    const verify = await CredentialStore.create({ configDir });
    const remaining = await verify.listProjectKeys();
    expect(Object.keys(remaining)).toHaveLength(1);
  });

  it('is idempotent on re-run with --prune (second pass finds zero stale)', async () => {
    const ghostRoot = path.join(scratch, 'idempotent-ghost');
    await seedProjectKey(ghostRoot, 'idempotent-key');

    const first = await runCleanup({ configDir, prune: true });
    expect(first.stale).toBe(1);
    expect(first.removed).toBe(1);

    const second = await runCleanup({ configDir, prune: true });
    expect(second.stale).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.total).toBe(0);
  });
});
