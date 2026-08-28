// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m06 — cmos_auth(reissue) through the REAL resolver chain, with revocation
// ABOUTME: modelled where production can actually see it: a 401 on the wire, not a synthetic flag.

/**
 * Sprint 86 m06 — the test that would have caught the defect.
 *
 * WHY NO EXISTING TEST CAUGHT IT. Every `cmos_auth` test injects `clientResolver`
 * via a shared `deps()` helper, so the passing reissue test had NEVER executed
 * `defaultDashboardClientResolver` or `fromEnvForProject`; the DEVICE_CODE_REQUIRED
 * test injected `authenticatingKeyId: undefined` directly. No test anywhere asserted
 * `authenticatingKeyId` as an OUTPUT of any factory, so the arm that never sets it
 * was invisible. This file therefore injects NO resolver at all — it seeds a real
 * `CredentialStore` in a tmpdir and lets production resolution run.
 *
 * WHY REVOCATION IS A 401 AND NOT A FIXTURE FLAG. `CredentialStore.getProjectKey` is
 * a map lookup with no liveness concept, so a `revoked: true` field would test a
 * condition production cannot read — and it would PASS under the rejected fix
 * ("stamp authenticatingKeyId in every arm"), which is exactly the kind of test that
 * let this ship. Revocation here is what the dashboard actually does: the revoked
 * bearer 401s. That is also why the assertions read the captured Authorization
 * HEADERS — "which keyId was recorded" and "which key went on the wire" are different
 * questions, and only the header answers the second.
 *
 * SHAPE-FAITHFUL FIXTURE (gate #926.3, adapted). This mission is gated on no DB
 * column and no SQL query — its entire state is `~/.config/cmos-mcp/credentials.json`
 * — so the "real-store positive fire" obligation cannot take the tmpdir-DB-copy form.
 * Copying the real credentials file is forbidden: it holds live `cmk_` secrets at mode
 * 0600, and the jest global setup exists precisely so no test reads or writes
 * `~/.config/cmos-mcp`. Instead the real store was measured read-only at plan time (21
 * project rows, TWO user-scoped keys, every project row parent-linked) and the fixtures
 * below are faithful to that shape — which is why the matrix includes a
 * multiple-user-key path: a single-key fixture never exercises the newest-key pick.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { cmosAuth, formatAuthForLLM } from '../../src/tools/cmos/cmos-auth';
import {
  CredentialStore,
  CMOS_CONFIG_DIR_ENV,
  type ProjectKeyRecord,
  type UserScopedKeyRecord,
} from '../../src/intelligence/credential-store';
import { DashboardClient } from '../../src/tools/cmos/dashboard-client';
import { classifyAttribution } from '../../src/auth/project-key-capture';

const DASHBOARD_URL = 'https://dashboard.test';
const PROJECT_ID = 'dashboard-project-id';

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string;
}

function userKey(overrides: Partial<UserScopedKeyRecord> = {}): UserScopedKeyRecord {
  return {
    key: 'cmk_user_live',
    label: 'device: test',
    issuedAt: '2026-08-01T00:00:00.000Z',
    lastUsedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function projectKey(overrides: Partial<ProjectKeyRecord> = {}): ProjectKeyRecord {
  return {
    key: 'cmk_project_revoked',
    keyId: 'p-dead',
    parentKeyId: 'user-live-1',
    label: 'project: test',
    issuedAt: '2026-08-02T00:00:00.000Z',
    lastUsedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Patch `global.fetch`, routing on the Authorization header AND the URL+method.
 * There are five `await fetch(` sites in dashboard-client.ts, so a mock that assumed
 * a single call site would silently mis-serve one of them.
 *
 * Any request bearing the revoked project key 401s — that is what revocation looks
 * like from this process. A reissue POST bearing the live user key succeeds.
 */
/**
 * s87-m07 (#527) — `reissueStatus` lets a caller force the mint to FAIL, which is the only way to
 * reach the arm that used to destroy the operator's key. Defaults to 200, so every existing
 * caller is unaffected.
 */
function installFetchMock(
  captured: CapturedRequest[],
  liveUserKeys: string[] = ['cmk_user_live'],
  reissueStatus = 200
) {
  const impl = async (input: unknown, init?: { method?: string; headers?: unknown }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers['Authorization'] ?? headers['authorization'] ?? '';
    captured.push({ url, method, authorization });

    const bearer = authorization.replace(/^Bearer\s+/, '');

    if (!liveUserKeys.includes(bearer)) {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'revoked or unknown key' }),
        text: async () => 'revoked or unknown key',
      };
    }

    if (method === 'POST' && url.includes('/keys/reissue')) {
      if (reissueStatus !== 200) {
        return {
          ok: false,
          status: reissueStatus,
          statusText: reissueStatus === 500 ? 'Internal Server Error' : 'Error',
          json: async () => ({ error: 'upstream exploded' }),
          text: async () => 'upstream exploded',
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            key: 'cmk_project_fresh',
            keyId: 'p-fresh',
            label: 'project: reissued',
            revokedKeyIds: ['p-dead'],
          },
        }),
        text: async () => '',
      };
    }

    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: `unrouted ${method} ${url}` }),
      text: async () => `unrouted ${method} ${url}`,
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jest.spyOn(global, 'fetch' as any).mockImplementation(impl as any);
}

describe('cmos_auth(reissue) credential resolution (s86-m06)', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let store: CredentialStore;
  let captured: CapturedRequest[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmos-reissue-'));
    // House pattern (see cmos-auth.test.ts): unset the shared config dir, reset the
    // singleton, and point the store at this test's own tmpdir. `resetInstance` runs in
    // BOTH hooks or the tmpdir store leaks into unrelated suites via `getInstance`.
    delete process.env[CMOS_CONFIG_DIR_ENV];
    delete process.env.CMOS_DASHBOARD_API_KEY;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;
    process.env.CMOS_DASHBOARD_URL = DASHBOARD_URL;
    CredentialStore.resetInstance();
    store = await CredentialStore.create({ configDir: tempDir });
    captured = [];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const projectRootFor = (name: string): string => path.join(tempDir, name);

  /** No clientResolver, no userClientResolver — production resolution runs. */
  const realResolverDeps = () => ({
    store,
    projectIdReader: async () => PROJECT_ID,
  });

  // ─── criteria 1, 2, 13 — the FIRE test ─────────────────────────────────────

  it('reissues through the real resolver when the local project key is present but revoked', async () => {
    const projectRoot = projectRootFor('fire');
    await store.upsertUserScopedKey('user-live-1', userKey());
    await store.upsertProjectKey(projectRoot, projectKey());
    installFetchMock(captured);

    const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

    // (1) It succeeds, and the fresh row is attributed to the user key that minted it.
    //
    // Asserted as a tuple, deliberately: a bare `expect(result.success).toBe(true)`
    // prints only "expected true, received false" on a RED run, hiding WHICH failure
    // fired and whether anything reached the network. The RED capture for this
    // mission's resolver change is only meaningful if it names both.
    expect({
      success: result.success,
      errorCode: result.error?.code ?? null,
      requestsMade: captured.length,
    }).toEqual({ success: true, errorCode: null, requestsMade: 1 });
    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted?.key).toBe('cmk_project_fresh');
    expect(persisted?.parentKeyId).toBe('user-live-1');

    // (2) WIRE CREDENTIAL. This is the assertion that fails under the rejected
    // "stamp authenticatingKeyId in every arm" option: there, the recorded parent
    // would look right while the POST still went out bearing the revoked project key.
    const reissuePosts = captured.filter(
      (r) => r.method === 'POST' && r.url.includes('/keys/reissue')
    );
    expect(reissuePosts).toHaveLength(1);
    expect(reissuePosts[0]?.authorization).toBe('Bearer cmk_user_live');
    expect(captured.filter((r) => r.authorization.includes('cmk_project_revoked'))).toHaveLength(0);

    // (13) The success payload reports what the dashboard actually revoked.
    if (result.success && result.data?.action === 'reissue') {
      expect(result.data.revokedKeyIds).toEqual(['p-dead']);
      expect(result.data.revokedKeyIdsReported).toBe(true);
    } else {
      throw new Error('expected a reissue success payload');
    }
  });

  it('does not claim the dashboard reported an empty revoked list when it reported none', async () => {
    const projectRoot = projectRootFor('revoked-absent');
    await store.upsertUserScopedKey('user-live-1', userKey());
    // A 200 whose body omits revokedKeyIds entirely. `request<T>` casts without validating,
    // so this is a real response shape — and the dashboard side is unverified from this repo.
    jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(global, 'fetch' as any)
      .mockImplementation((async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: { key: 'cmk_project_fresh', keyId: 'p-fresh', label: 'no-list' },
        }),
        text: async () => '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any);

    const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

    expect(result.success).toBe(true);
    if (!result.success || result.data?.action !== 'reissue') {
      throw new Error('expected a reissue success payload');
    }
    expect(result.data.revokedKeyIdsReported).toBe(false);
    expect(result.data.revokedKeyIds).toEqual([]);

    // The rendered answer states the absence rather than asserting an empty report.
    const rendered = formatAuthForLLM('reissue', result);
    expect(rendered).toContain('carried no revoked-key list');
    expect(rendered).not.toContain('reported an empty revoked-key list');
  });

  // ─── criterion 3 — no row loss on failure (defect D1) ──────────────────────

  it('leaves the original project row intact when attribution fails', async () => {
    const projectRoot = projectRootFor('no-row-loss');
    const original = projectKey();
    await store.upsertProjectKey(projectRoot, original);
    installFetchMock(captured);

    const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DEVICE_CODE_REQUIRED');

    // The operator asked for a repair and got an error; they must not also be left
    // with NO project key row — strictly worse off than before the call.
    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted).toBeDefined();
    expect(persisted?.key).toBe(original.key);
    expect(persisted?.keyId).toBe(original.keyId);

    // And nothing was attempted on the wire before the classification failed.
    expect(captured).toHaveLength(0);
  });

  // ─── criterion 8 — the six-path matrix ────────────────────────────────────

  describe('resolution matrix', () => {
    it('(1) zero user keys + present project row → DEVICE_CODE_REQUIRED naming the store path', async () => {
      const projectRoot = projectRootFor('matrix-1');
      await store.upsertProjectKey(projectRoot, projectKey());
      installFetchMock(captured);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      expect(result.error?.code).toBe('DEVICE_CODE_REQUIRED');
      expect(result.error?.message).toContain(store.path);
      expect(result.error?.message).toContain('credentials.json');
    });

    it('(2) exactly one user key, with a LIVE project row present → success', async () => {
      const projectRoot = projectRootFor('matrix-2');
      await store.upsertUserScopedKey('user-live-1', userKey());
      // A live (non-revoked) project row, which is what distinguishes this path from (4)
      // absent-row and (5) revoked-row. Seeding only the user key would make this fixture
      // byte-identical to (4) and the matrix would cover five states under six names.
      await store.upsertProjectKey(
        projectRoot,
        projectKey({ key: 'cmk_project_live', keyId: 'p-live' })
      );
      installFetchMock(captured, ['cmk_user_live', 'cmk_project_live']);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      expect(result.success).toBe(true);
      // Even with a LIVE project key available, the repair authenticates user-scoped.
      const reissuePosts = captured.filter((r) => r.url.includes('/keys/reissue'));
      expect(reissuePosts[0]?.authorization).toBe('Bearer cmk_user_live');
      expect(captured.filter((r) => r.authorization.includes('cmk_project_live'))).toHaveLength(0);
    });

    it('(3) three user keys with distinct issuedAt → the newest one goes on the wire', async () => {
      const projectRoot = projectRootFor('matrix-3');
      await store.upsertUserScopedKey(
        'user-old',
        userKey({ key: 'cmk_user_old', issuedAt: '2026-01-01T00:00:00.000Z' })
      );
      await store.upsertUserScopedKey(
        'user-newest',
        userKey({ key: 'cmk_user_newest', issuedAt: '2026-08-09T00:00:00.000Z' })
      );
      await store.upsertUserScopedKey(
        'user-middle',
        userKey({ key: 'cmk_user_middle', issuedAt: '2026-04-01T00:00:00.000Z' })
      );
      // Only the newest key authenticates, so a wrong pick surfaces as a 401 too —
      // but the header assertion is what names WHICH key was chosen.
      installFetchMock(captured, ['cmk_user_newest']);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      expect(result.success).toBe(true);
      const reissuePosts = captured.filter((r) => r.url.includes('/keys/reissue'));
      expect(reissuePosts[0]?.authorization).toBe('Bearer cmk_user_newest');
      const persisted = await store.getProjectKey(projectRoot);
      expect(persisted?.parentKeyId).toBe('user-newest');
    });

    it('(4) absent project row → the path that already worked stays green', async () => {
      const projectRoot = projectRootFor('matrix-4');
      await store.upsertUserScopedKey('user-live-1', userKey());
      installFetchMock(captured);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      expect(result.success).toBe(true);
      expect((await store.getProjectKey(projectRoot))?.key).toBe('cmk_project_fresh');
    });

    it('(5) present-but-revoked row → succeeds via the user key', async () => {
      const projectRoot = projectRootFor('matrix-5');
      await store.upsertUserScopedKey('user-live-1', userKey());
      await store.upsertProjectKey(projectRoot, projectKey());
      installFetchMock(captured);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      expect(result.success).toBe(true);
      expect(captured.every((r) => r.authorization === 'Bearer cmk_user_live')).toBe(true);
    });

    it('(6) explicit apiKey override → CREDENTIAL_NOT_ATTRIBUTABLE, never "run device code"', async () => {
      const projectRoot = projectRootFor('matrix-6');
      // A user key IS present — so an error naming device code would be false here.
      await store.upsertUserScopedKey('user-live-1', userKey());
      await store.upsertProjectKey(projectRoot, projectKey());
      installFetchMock(captured);

      const result = await cmosAuth(
        { action: 'reissue', projectRoot },
        {
          ...realResolverDeps(),
          userClientResolver: async () => {
            const resolved = await DashboardClient.fromEnvForUser({
              apiKey: 'cmk_caller_supplied',
              credentialStore: store,
            });
            if (!resolved.success || !resolved.data) throw new Error('override resolve failed');
            return { client: resolved.data.client, keySource: resolved.data.keySource };
          },
        }
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CREDENTIAL_NOT_ATTRIBUTABLE');
      expect(result.error?.message).toContain('caller-supplied apiKey override');
      expect(result.error?.message).not.toContain('device code flow must be run');
      // The row survives this failure too.
      expect((await store.getProjectKey(projectRoot))?.keyId).toBe('p-dead');
    });
  });

  // ─── criterion 7 — the arm-1 invariant rule (2) depends on ────────────────

  describe('fromEnvForUser arm invariant', () => {
    it('returns user-scoped with NO authenticating keyId if and only if apiKey was supplied', async () => {
      // Direction 1: an explicit override → no id (this is arm 1, and only arm 1).
      const override = await DashboardClient.fromEnvForUser({
        apiKey: 'cmk_caller_supplied',
        credentialStore: store,
      });
      expect(override.success).toBe(true);
      expect(override.data?.keySource).toBe('user-scoped');
      expect(override.data?.client.authenticatingKeyId).toBeUndefined();

      // Direction 2: a store key picked → id set. So `user-scoped && no id` cannot
      // arise from arm 3, which is what makes rule (2) sound.
      await store.upsertUserScopedKey('user-live-1', userKey());
      const fromStore = await DashboardClient.fromEnvForUser({ credentialStore: store });
      expect(fromStore.success).toBe(true);
      expect(fromStore.data?.keySource).toBe('user-scoped');
      expect(fromStore.data?.client.authenticatingKeyId).toBe('user-live-1');
    });

    it('never returns a project-scoped arm, even when a project row exists', async () => {
      await store.upsertProjectKey(projectRootFor('arm2'), projectKey());
      await store.upsertUserScopedKey('user-live-1', userKey());

      const resolved = await DashboardClient.fromEnvForUser({ credentialStore: store });

      expect(resolved.data?.keySource).toBe('user-scoped');
      expect(resolved.data?.matchedProjectRoot).toBeNull();
    });
  });

  // ─── criterion 10 — no silent fail-open in classifyAttribution ────────────

  describe('classifyAttribution', () => {
    const clientWith = (keyId: string | undefined): DashboardClient => {
      const client = new DashboardClient({ baseUrl: DASHBOARD_URL, apiKey: 'cmk_any' });
      client.setAuthenticatingKeyId(keyId);
      return client;
    };

    it('rule 1 — an authenticating keyId is attributable', async () => {
      const result = await classifyAttribution(clientWith('user-live-1'), 'user-scoped', store);
      expect(result).toEqual({ ok: true, parentKeyId: 'user-live-1' });
    });

    it('rule 2 — user-scoped with no keyId is the explicit override', async () => {
      const result = await classifyAttribution(clientWith(undefined), 'user-scoped', store);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.failure).toEqual({
        kind: 'unattributable-credential',
        via: 'explicit-override',
      });
    });

    it.each(['legacy-env', 'password-fallback'] as const)(
      'rule 3 — %s is unattributable and names its arm',
      async (keySource) => {
        const result = await classifyAttribution(clientWith(undefined), keySource, store);
        if (result.ok) throw new Error('expected failure');
        expect(result.failure).toEqual({ kind: 'unattributable-credential', via: keySource });
      }
    );

    it('rule 4 — no client and an empty store names the store path', async () => {
      const result = await classifyAttribution(null, null, store);
      if (result.ok) throw new Error('expected failure');
      expect(result.failure.kind).toBe('no-user-scoped-key');
      expect(result.failure).toMatchObject({ storePath: store.path });
    });

    it('rule 4 — no client but a NON-empty store is reported as an inconsistency, not a skip', async () => {
      await store.upsertUserScopedKey('user-live-1', userKey());
      const result = await classifyAttribution(null, null, store);
      if (result.ok) throw new Error('expected failure');
      expect(result.failure.kind).toBe('inconsistent-resolution');
    });

    it('rule 5 — a project-scoped client is an inconsistency, never a success', async () => {
      const result = await classifyAttribution(clientWith(undefined), 'project-scoped', store);
      if (result.ok) throw new Error('expected failure');
      expect(result.failure.kind).toBe('inconsistent-resolution');
    });

    it('no branch returns a skip, a bare undefined, or a success with empty attribution', async () => {
      const cases: Array<[DashboardClient | null, Parameters<typeof classifyAttribution>[1]]> = [
        [clientWith('user-live-1'), 'user-scoped'],
        [clientWith(undefined), 'user-scoped'],
        [clientWith(undefined), 'legacy-env'],
        [clientWith(undefined), 'password-fallback'],
        [clientWith(undefined), 'project-scoped'],
        // s87-m07 (#530): `'none'` removed from KeySource — no producer in src/ emitted it, so
        // this row exercised an unreachable state. `null` is what a caller with no keySource
        // actually passes.
        [clientWith(undefined), null],
        [null, null],
      ];

      for (const [client, keySource] of cases) {
        const result = await classifyAttribution(client, keySource, store);
        expect(result).toBeDefined();
        expect(typeof result.ok).toBe('boolean');
        if (result.ok) {
          expect(result.parentKeyId).toBeTruthy();
        } else {
          expect(result.failure.kind).toBeTruthy();
        }
      }
    });
  });

  // ─── criterion 11 — string truth on the reissue path ─────────────────────

  describe('string truth', () => {
    it('does not blame device code when the store holds a user-scoped key', async () => {
      const projectRoot = projectRootFor('string-truth');
      await store.upsertUserScopedKey('user-live-1', userKey());
      await store.upsertProjectKey(projectRoot, projectKey());
      installFetchMock(captured, ['no-key-authenticates']);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      // A live user key, so the reissue POST 401s — an honest dashboard failure.
      expect(result.success).toBe(false);
      const surfaced = `${result.error?.message ?? ''} ${result.error?.suggestion ?? ''}`;
      expect(surfaced).not.toContain('device code flow must be run');
      expect(surfaced).not.toContain('run device code flow');
    });

    it('the two split failures emit two distinct messages', async () => {
      const projectRoot = projectRootFor('two-messages');
      installFetchMock(captured);

      const noUserKey = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      await store.upsertUserScopedKey('user-live-1', userKey());
      const override = await cmosAuth(
        { action: 'reissue', projectRoot },
        {
          ...realResolverDeps(),
          userClientResolver: async () => {
            const resolved = await DashboardClient.fromEnvForUser({
              apiKey: 'cmk_caller_supplied',
              credentialStore: store,
            });
            if (!resolved.success || !resolved.data) throw new Error('override resolve failed');
            return { client: resolved.data.client, keySource: resolved.data.keySource };
          },
        }
      );

      expect(noUserKey.error?.code).toBe('DEVICE_CODE_REQUIRED');
      expect(override.error?.code).toBe('CREDENTIAL_NOT_ATTRIBUTABLE');
      expect(noUserKey.error?.message).not.toBe(override.error?.message);
    });
  });

  // ─── criterion 12 — rendered, not merely returned (defect D2) ─────────────

  describe('formatAuthForLLM', () => {
    it('renders BOTH the message and the suggestion on a failure', async () => {
      const projectRoot = projectRootFor('rendered');
      await store.upsertProjectKey(projectRoot, projectKey());
      installFetchMock(captured);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());
      const rendered = formatAuthForLLM('reissue', result);

      // Asserting on `result.error.suggestion` alone does NOT satisfy this: the
      // suggestion existed before this mission and reached no rendered answer.
      expect(rendered).toContain(result.error?.message ?? 'MISSING');
      expect(rendered).toContain(result.error?.suggestion ?? 'MISSING');
      expect(rendered).toContain('cmos_auth(action="login_init")');
    });

    it('leaves a success answer unchanged (no stray suggestion line)', async () => {
      const projectRoot = projectRootFor('rendered-ok');
      await store.upsertUserScopedKey('user-live-1', userKey());
      installFetchMock(captured);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());
      const rendered = formatAuthForLLM('reissue', result);

      expect(rendered).toContain('Reissued project key');
      expect(rendered).not.toContain('Suggestion:');
      // The dashboard's revoked list is named in the text, not only in structuredContent.
      expect(rendered).toContain('revoked 1 prior key(s): p-dead');
    });
  });

  /**
   * s87-m07 (#527) — A REISSUE THAT FAILS DASHBOARD-SIDE MUST NOT DESTROY THE KEY IT REPLACES.
   *
   * MEASURED LIVE before the fix: force a 500 on the mint and `getProjectKey` afterwards returns
   * `null`. The operator's only project-scoped credential was gone, and reissue had nothing to
   * put in its place. The delete is the FIRST destructive step and it is LOAD-BEARING —
   * `recoverProjectKey` returns `no-op-already-present` while a row exists, so reissue must clear
   * it to force a fresh mint. The fix is therefore snapshot-and-re-upsert, not move-the-delete.
   *
   * THREE UN-RESTORING ARMS, not the two the next-step names, plus the exception path.
   */
  describe('s87-m07 (#527): a failed reissue restores the key it deleted', () => {
    it('a 500 on the mint leaves the ORIGINAL key and keyId readable', async () => {
      const projectRoot = projectRootFor('restore-500');
      await store.upsertUserScopedKey('user-live-1', userKey());
      const original = projectKey();
      await store.upsertProjectKey(projectRoot, original);
      installFetchMock(captured, undefined, 500);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DASHBOARD_ERROR');

      // THE POINT. Before this mission both of these read `undefined`.
      const persisted = await store.getProjectKey(projectRoot);
      expect(persisted?.key).toBe(original.key);
      expect(persisted?.keyId).toBe(original.keyId);
    });

    it('the same holds for a 401 on the mint — the arm is the same one', async () => {
      const projectRoot = projectRootFor('restore-401');
      await store.upsertUserScopedKey('user-live-1', userKey());
      const original = projectKey();
      await store.upsertProjectKey(projectRoot, original);
      installFetchMock(captured, undefined, 401);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());
      expect(result.success).toBe(false);
      const persisted = await store.getProjectKey(projectRoot);
      expect(persisted?.key).toBe(original.key);
    });

    it('the failure message says "Dashboard error:" exactly ONCE', async () => {
      // Measured before: "Dashboard error: Dashboard error: Server error 500: upstream exploded".
      // The dashboard client's message already carries the prefix; wrapping it again stuttered.
      const projectRoot = projectRootFor('prefix');
      await store.upsertUserScopedKey('user-live-1', userKey());
      await store.upsertProjectKey(projectRoot, projectKey());
      installFetchMock(captured, undefined, 500);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());
      const message = result.error?.message ?? '';
      expect(message).toContain('Dashboard error:');
      expect(message.match(/Dashboard error:/g) ?? []).toHaveLength(1);
    });

    it('an ABSENT-row reissue is unaffected — restore never fabricates a key', async () => {
      // The snapshot may legitimately be `undefined`; restoring must be a no-op then, not an
      // upsert of nothing. Without this arm a restore that ran unconditionally would pass the
      // tests above and corrupt this path.
      const projectRoot = projectRootFor('absent');
      await store.upsertUserScopedKey('user-live-1', userKey());
      installFetchMock(captured, undefined, 500);

      const result = await cmosAuth({ action: 'reissue', projectRoot }, realResolverDeps());
      expect(result.success).toBe(false);
      expect(await store.getProjectKey(projectRoot)).toBeUndefined();
    });
  });
});
