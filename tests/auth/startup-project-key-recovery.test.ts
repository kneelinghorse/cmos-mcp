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

  /**
   * s87-m07 (#528) — REWRITTEN. This asserted `skipped-unconfigured` with the message
   * "dashboard client unavailable — recovery deferred", which was wrong twice: NOTHING is
   * deferred (no later run retries this, and the runner early-returns whenever a local row
   * exists), and the real cause is knowable at that point.
   *
   * Classification is now hoisted above the null-client early return, so an EMPTY store reports
   * the cause it actually has — no user-scoped key — and names where the credentials live.
   */
  it('names the real cause for a credential-less store, rather than deferring nothing', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const result = await runStartupProjectKeyRecovery({
      projectRoot: path.join(tempDir, 'no-client'),
      metadataReader: async () => ({ registered: true, projectId: 'proj-id' }),
      clientFactory: async () => null,
      store,
    });
    expect(result.status).toBe('skipped-no-user-scoped-key');
    // It says WHERE, so the operator has somewhere to go.
    expect(result.message).toContain('credentials.json');
    // …and it no longer promises a retry that never comes.
    expect(result.message).not.toContain('deferred');
  });

  it('a NON-EMPTY store with a null client reports an inconsistency, not a configuration gap', async () => {
    // The other half of the pair, and the reason `skipped-unconfigured` could not simply be
    // repointed: a store that HOLDS keys is not unconfigured. Filing this under a word meaning
    // "not configured" would have named the wrong cause — the defect this sprint closes.
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('user-parent-x', {
      key: 'cmk_user',
      label: 'device',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    const result = await runStartupProjectKeyRecovery({
      projectRoot: path.join(tempDir, 'no-client-but-keys'),
      metadataReader: async () => ({ registered: true, projectId: 'proj-id' }),
      clientFactory: async () => null,
      store,
    });
    expect(result.status).not.toBe('skipped-no-user-scoped-key');
    expect(result.message).not.toContain('deferred');
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
   * s87-m07 (#528) — THE REACHABILITY DISCLAIMER THAT STOOD HERE IS DELETED BECAUSE IT BECAME
   * FALSE. It said `skipped-no-user-scoped-key` was "not producible through this runner at all,
   * by any type-conforming factory", because the runner reported `skipped-unconfigured` before it
   * classified. Classification is now hoisted above that early return, so a null-client factory
   * on an empty store produces exactly that status — and the test above asserts it. A disclaimer
   * that survives the change it describes is a comment asserting something that is not so.
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
   * s87-m07 (#528) — THE SECOND FALSE DISCLAIMER IS DELETED. It said `no-user-scoped-key` was
   * "NOT assertable through this runner", because the runner reported `skipped-unconfigured`
   * before it classified. That reason no longer exists: with classification hoisted, a
   * null-client factory on an empty store reports it here, and the test near the top of this file
   * asserts it directly. Both disclaimers were accurate when written and became false the moment
   * the code they described changed — which is why this mission deletes rather than softens them.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * s87-m07 (#530) — A TEST WAS RETIRED HERE, AND THE REASON IS THE MISSION'S OWN THESIS.
   *
   * It read: "reports an inconsistency rather than a skip when a resolved client belongs to no
   * attributable arm", and it expressed that state by passing `keySource: 'none'`. `'none'` was a
   * published `KeySource` member that NO producer in `src/` ever emitted — the exact defect this
   * mission removes. With it gone, `DashboardClientFactory` requires a non-null `KeySource`, so
   * "a RESOLVED client belonging to no attributable arm" is not merely unproduced: it is
   * unrepresentable through this runner's own factory contract.
   *
   * Forcing it through with a cast would have kept a test for a state the type system forbids —
   * asserting behaviour that cannot occur, which is what `'none'` was doing in the first place.
   *
   * THE COVERAGE IS NOT LOST, and that is why this is a retirement rather than a deletion. The
   * REACHABLE form of an unattributable resolution is a NULL CLIENT, which is exactly what the
   * hoisted classification now handles — and "a NON-EMPTY store with a null client reports an
   * inconsistency, not a configuration gap", near the top of this file, asserts it.
   */
});
