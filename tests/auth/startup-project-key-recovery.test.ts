// ABOUTME: Unit tests for runStartupProjectKeyRecovery — Sprint 57 m02 startup hook.
// ABOUTME: Covers skipped/no-project, skipped/unregistered, skipped/already-present, recovered, reissue-failed.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { runStartupProjectKeyRecovery } from '../../src/auth/project-key-capture';
import { CMOS_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';
import type { KeySource, ProjectKeyRecord } from '../../src/intelligence/credential-store';
import type {
  DashboardClient,
  ReissueProjectKeyResult,
} from '../../src/tools/cmos/dashboard-client';
import type { CmosToolResult } from '../../src/tools/cmos/types';

function stubClient(
  options: {
    authenticatingKeyId?: string | undefined;
    reissue?: CmosToolResult<ReissueProjectKeyResult>;
  } = {}
): DashboardClient {
  const keyId = 'authenticatingKeyId' in options ? options.authenticatingKeyId : 'user-parent-1';
  return {
    authenticatingKeyId: keyId,
    reissueProjectKey: async () =>
      options.reissue ??
      ({
        success: true,
        data: {
          key: 'cmk_reissued',
          keyId: 'reissued-id',
          label: 'reissued-label',
          revokedKeyIds: [],
        },
      } as CmosToolResult<ReissueProjectKeyResult>),
  } as unknown as DashboardClient;
}

/**
 * s86-m06 — `DashboardClientFactory` now returns the `{client, keySource}` PAIR, because
 * `keySource` is what lets the runner name WHICH arm failed to attribute a mint. A bare
 * client made the two failure states indistinguishable, which is how one message came to
 * name a cause ("run device code flow") that is false in one of them.
 */
function resolvedStub(
  options: Parameters<typeof stubClient>[0] = {},
  keySource: KeySource = 'user-scoped'
): { client: DashboardClient; keySource: KeySource } {
  return { client: stubClient(options), keySource };
}

describe('runStartupProjectKeyRecovery', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-recovery-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns skipped-no-project when no projectRoot is supplied', async () => {
    const result = await runStartupProjectKeyRecovery({});
    expect(result.status).toBe('skipped-no-project');
    expect(result.checked).toBe(false);
  });

  it('returns skipped-not-registered when the project has no dashboard registration', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const result = await runStartupProjectKeyRecovery({
      projectRoot: '/tmp/unregistered',
      metadataReader: async () => ({ registered: false, projectId: null }),
      clientFactory: async () => resolvedStub(),
      store,
    });
    expect(result.status).toBe('skipped-not-registered');
  });

  it('returns skipped-already-present when the credential store has a row for this root', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'already-present');
    const existing: ProjectKeyRecord = {
      key: 'cmk_here',
      keyId: 'here-id',
      parentKeyId: 'here-parent',
      label: 'here',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    await store.upsertProjectKey(projectRoot, existing);

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-id' }),
      clientFactory: async () => resolvedStub(),
      store,
    });
    expect(result.status).toBe('skipped-already-present');
  });

  it('returns skipped-unconfigured when no dashboard client can be built', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const result = await runStartupProjectKeyRecovery({
      projectRoot: path.join(tempDir, 'no-client'),
      metadataReader: async () => ({ registered: true, projectId: 'proj-id' }),
      clientFactory: async () => null,
      store,
    });
    expect(result.status).toBe('skipped-unconfigured');
  });

  it('returns recovered and writes a fresh project-scoped record when reissue succeeds', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'recover-me');

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-abc' }),
      clientFactory: async () => resolvedStub({ authenticatingKeyId: 'user-parent-1' }),
      store,
    });

    expect(result.status).toBe('recovered');
    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted?.key).toBe('cmk_reissued');
    expect(persisted?.parentKeyId).toBe('user-parent-1');
  });

  it('returns error when reissue fails', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'error');

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-xyz' }),
      clientFactory: async () =>
        resolvedStub({
          authenticatingKeyId: 'user-parent-1',
          reissue: {
            success: false,
            error: { code: 'DASHBOARD_ERROR', message: 'upstream 500' },
          } as CmosToolResult<ReissueProjectKeyResult>,
        }),
      store,
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('upstream 500');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });

  /**
   * s86-m06 — the single `skipped-no-parent-key-id` case split in two.
   *
   * The old status carried the message "run device code flow, then reissue will succeed",
   * which is false in the second case below (the store HAS user-scoped keys — the resolved
   * credential simply is not one of them) and over-promises in both (startup recovery
   * returns `skipped-already-present` whenever a local row exists, so no restart recovers
   * anything by itself).
   *
   * REACHABILITY, STATED PLAINLY so it is not mistaken for coverage it is not: neither status
   * arises with the DEFAULT factory, and one of the two — `skipped-no-user-scoped-key` — is not
   * producible through this runner at all, by any type-conforming factory. The default factory
   * returns null when no credential resolves, and the runner reports `skipped-unconfigured`
   * before it classifies; a factory that DOES return a client can never yield the empty-store
   * classification, which requires no client. That reachability limit was equally true of the
   * status they replace: the runner early-returns on a present local row, so the old
   * arm-2-with-no-keyId state was already unreachable here (see the code comment on
   * `defaultClientFactory`). The operator-facing surface where both states ARE reachable is
   * `cmos_auth(action="reissue")`, covered by tests/auth/reissue-resolution.test.ts.
   */
  it('returns skipped-unattributable-credential for a credential that is not a device-code user key', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'unattributable');
    // A user-scoped key IS present, so a message blaming device code would be false.
    await store.upsertUserScopedKey('user-parent-1', {
      key: 'cmk_user',
      label: 'device',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-p' }),
      clientFactory: async () => resolvedStub({ authenticatingKeyId: undefined }, 'legacy-env'),
      store,
    });

    expect(result.status).toBe('skipped-unattributable-credential');
    expect(result.message).toContain('CMOS_DASHBOARD_API_KEY');
    expect(result.message).not.toContain('will succeed');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });

  /**
   * The remaining classification outcome, `no-user-scoped-key`, is NOT assertable through
   * this runner — the default factory returns null on a credential-less store and the runner
   * reports `skipped-unconfigured` before it classifies. Naming a test for it here and
   * asserting something else would be the "test name asserts what the test no longer checks"
   * defect this sprint is closing. It is asserted where it fires: the reissue handler, in
   * tests/auth/reissue-resolution.test.ts (DEVICE_CODE_REQUIRED naming the store path), and
   * the [WARN] routing of both new statuses is asserted by the `test.each` in
   * tests/index.runtime.test.ts.
   */
  it('reports an inconsistency rather than a skip when a resolved client belongs to no attributable arm', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'inconsistent');

    const result = await runStartupProjectKeyRecovery({
      projectRoot,
      metadataReader: async () => ({ registered: true, projectId: 'proj-p' }),
      clientFactory: async () => resolvedStub({ authenticatingKeyId: undefined }, 'none'),
      store,
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('inconsistent');
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });
});
