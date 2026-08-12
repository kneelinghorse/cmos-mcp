// ABOUTME: Sprint 57 m02 — capture + partial-failure recovery for auto-issued project-scoped keys.
// ABOUTME: Keeps the credential-store write discipline out of checkpoint-backfill and the startup hook.

/**
 * Project-scoped key capture + /reissue recovery.
 *
 * This module centralizes the two write paths that move a project-scoped
 * key from the dashboard into the local `CredentialStore`:
 *
 *  1. **Auto-capture on registration** (`captureRegisterResponse`) —
 *     `POST /api/projects/register` returns `{ key, keyId, label }` on
 *     first-time registration. We stamp it to `projectKeys[projectRoot]`
 *     with `parentKeyId` set to the user-scoped credential that
 *     authenticated the register call.
 *
 *  2. **Partial-failure recovery** (`recoverProjectKey`) — if the register
 *     response arrives but the local write fails (crash, disk error), the
 *     dashboard has a project-scoped key that we don't know about. We call
 *     `POST /api/projects/:id/keys/reissue` on next startup, which revokes
 *     the orphan and mints a fresh one bound to the same parent.
 *
 * @module auth/project-key-capture
 */

import { DashboardClient } from '../tools/cmos/dashboard-client';
import type { RegisterProjectResult } from '../tools/cmos/dashboard-client';
import { withClientAsync } from '../tools/cmos/client';
import {
  CredentialStore,
  type KeySource,
  type ProjectKeyRecord,
} from '../intelligence/credential-store';

/**
 * Status returned by the capture/recovery functions so callers can log
 * the outcome without pattern-matching on errors.
 */
export type ProjectKeyCaptureStatus =
  | 'captured'
  | 'reregistration-noop'
  | 'missing-parent-key-id'
  | 'no-key-in-response';

export interface CaptureRegisterResponseOptions {
  /** Absolute project root the captured key should be keyed under. */
  projectRoot: string;
  /** The dashboard response from `registerProject`. */
  response: RegisterProjectResult;
  /**
   * Authenticating user-scoped keyId (from `client.authenticatingKeyId`).
   * Stamped into `parentKeyId` on the resulting record. When undefined we
   * bail out with `missing-parent-key-id` rather than write a record with
   * empty attribution — m03's "mine-only" filter would silently skip it.
   */
  parentKeyId: string | undefined;
  /** Override (tests) — defaults to the CredentialStore singleton. */
  store?: CredentialStore;
}

/**
 * Inspect a `/register` response and persist a new project-scoped key row
 * when one was minted. Idempotent re-registrations (`keyRotated === false`)
 * are no-ops; first-time registrations with a `key` produce a write.
 */
export async function captureRegisterResponse(
  options: CaptureRegisterResponseOptions
): Promise<ProjectKeyCaptureStatus> {
  // Idempotent re-register — dashboard explicitly signals "no new key minted."
  if (options.response.keyRotated === false) {
    return 'reregistration-noop';
  }

  const { key, keyId, label } = options.response;
  if (!key || !keyId) {
    return 'no-key-in-response';
  }

  if (!options.parentKeyId) {
    return 'missing-parent-key-id';
  }

  const now = new Date().toISOString();
  const record: ProjectKeyRecord = {
    key,
    keyId,
    parentKeyId: options.parentKeyId,
    label: label ?? '',
    issuedAt: now,
    lastUsedAt: now,
  };

  const store = options.store ?? (await CredentialStore.create());
  await store.upsertProjectKey(options.projectRoot, record);
  return 'captured';
}

// ─── s86-m06: attribution classification ─────────────────────────────────────

/**
 * Why a project-key mint cannot be attributed to a user-scoped parent.
 *
 * These are DIFFERENT operator situations that the pre-s86-m06 code collapsed into
 * one message blaming a missing device-code bootstrap — false whenever the store
 * already holds a user-scoped key. Splitting the type is what makes two honest
 * messages possible.
 */
export type AttributionFailure =
  /** The credential store holds zero user-scoped keys — device code genuinely has not been run. */
  | { kind: 'no-user-scoped-key'; storePath: string }
  /**
   * A credential resolved, but it is not a device-code user key, so the dashboard
   * cannot bind the mint to a parent. `via` names which arm supplied it.
   */
  | {
      kind: 'unattributable-credential';
      via: 'explicit-override' | 'legacy-env' | 'password-fallback';
    }
  /**
   * Impossible by construction — kept as a TYPED failure rather than a skip so an
   * internal inconsistency surfaces instead of silently disabling recovery
   * (agents.md Process Hardening #4: no silent fail-open on an activation predicate).
   */
  | { kind: 'inconsistent-resolution'; detail: string; storePath: string };

export type AttributionResult =
  | { ok: true; parentKeyId: string }
  | { ok: false; failure: AttributionFailure };

/**
 * Decide whether a resolved dashboard client can attribute a project-key mint,
 * and if not, WHY — by rule, from the resolution arm that produced it.
 *
 * The rules are ordered and each is derivable from `fromEnvForUser`'s arms; none
 * is an allowlist:
 *
 *  1. `authenticatingKeyId` set → attributable. Only arm 3 sets it.
 *  2. `keySource === 'user-scoped'` with no id → arm 1, an explicit `apiKey`
 *     override. This combination arises from arm 1 and ONLY arm 1 (arm 3 always
 *     stamps the id) — asserted by test rather than trusted from this comment.
 *  3. `keySource` of `legacy-env` / `password-fallback` → arms 4 / 5.
 *  4. No client at all → the chain fell off its end. An empty store is
 *     `no-user-scoped-key` (naming the store's path so the operator knows which
 *     file); a NON-empty store is impossible by construction (arm 3 would have
 *     fired) and returns the inconsistency.
 *  5. Anything else (a project-scoped client handed in by a caller that resolved
 *     through the wrong entry point) is also the inconsistency, never a skip.
 *
 * Every branch returns `{ok:true, parentKeyId}` or a typed failure. There is no
 * bare `undefined` and no "carry on without attribution" path.
 */
export async function classifyAttribution(
  client: DashboardClient | null,
  keySource: KeySource | null,
  store: CredentialStore
): Promise<AttributionResult> {
  // (1) Attributable — arm 3 stamped the user-scoped keyId that authenticated us.
  const parentKeyId = client?.authenticatingKeyId;
  if (parentKeyId) {
    return { ok: true, parentKeyId };
  }

  if (client) {
    // (2) Arm 1 — a caller-supplied credential. We cannot know whose it is.
    if (keySource === 'user-scoped') {
      return {
        ok: false,
        failure: { kind: 'unattributable-credential', via: 'explicit-override' },
      };
    }
    // (3) Arms 4 / 5 — legacy env key or email+password.
    if (keySource === 'legacy-env' || keySource === 'password-fallback') {
      return { ok: false, failure: { kind: 'unattributable-credential', via: keySource } };
    }
    // (5) A client whose arm cannot attribute and is not one of the above.
    return {
      ok: false,
      failure: {
        kind: 'inconsistent-resolution',
        detail: `a client resolved with keySource=${keySource ?? 'null'} carries no authenticating keyId; the user-scoped entry point cannot return this arm`,
        storePath: store.path,
      },
    };
  }

  // (4) No client at all.
  const userKeys = await store.listUserScopedKeys();
  if (Object.keys(userKeys).length === 0) {
    return { ok: false, failure: { kind: 'no-user-scoped-key', storePath: store.path } };
  }
  return {
    ok: false,
    failure: {
      kind: 'inconsistent-resolution',
      detail: `no dashboard client resolved, yet the credential store holds ${Object.keys(userKeys).length} user-scoped key(s); the user-scoped arm should have fired`,
      storePath: store.path,
    },
  };
}

export interface RecoverProjectKeyOptions {
  /** Absolute project root the recovered key should be keyed under. */
  projectRoot: string;
  /** Dashboard-side project UUID — needed for the `/reissue` URL. */
  projectId: string;
  /** Client authenticated via the user-scoped credential. */
  client: DashboardClient;
  /** Override (tests) — defaults to the CredentialStore singleton. */
  store?: CredentialStore;
}

export type ProjectKeyRecoveryStatus =
  /**
   * s86-m06 — `revokedKeyIds` is what the DASHBOARD reported it revoked as part of
   * this reissue. It used to be discarded here and reported to the operator as a
   * hardcoded `[]`, i.e. "nothing was revoked" while N keys had been.
   *
   * `undefined` means the response carried NO such list — which is NOT the same fact
   * as an empty list, and must not be rendered as one. `request<T>` casts the body
   * without validating it, so an absent (or non-array) field is a real possibility
   * and the dashboard-side response shape is unverified from this repo.
   */
  | { kind: 'recovered'; record: ProjectKeyRecord; revokedKeyIds: string[] | undefined }
  | { kind: 'no-op-already-present' }
  /**
   * s86-m06 — now UNREACHABLE from both callers: each classifies attribution via
   * `classifyAttribution` before calling in. Kept as a guard so a future caller
   * that skips the classification fails loudly instead of writing a record with
   * empty attribution; both consumers map it to a typed internal-invariant error,
   * never to a skip.
   */
  | { kind: 'missing-parent-key-id' }
  | { kind: 'reissue-failed'; error: string };

/**
 * Call `/api/projects/:id/keys/reissue` and persist the response to the
 * local store. Callers should gate this behind a check that `getProjectKey`
 * returns undefined (otherwise the existing key is fine).
 */
export async function recoverProjectKey(
  options: RecoverProjectKeyOptions
): Promise<ProjectKeyRecoveryStatus> {
  const store = options.store ?? (await CredentialStore.create());
  const existing = await store.getProjectKey(options.projectRoot);
  if (existing) {
    return { kind: 'no-op-already-present' };
  }

  const parentKeyId = options.client.authenticatingKeyId;
  if (!parentKeyId) {
    return { kind: 'missing-parent-key-id' };
  }

  const result = await options.client.reissueProjectKey(options.projectId);
  if (!result.success || !result.data) {
    return {
      kind: 'reissue-failed',
      error: result.error?.message ?? 'reissue returned no data',
    };
  }

  const now = new Date().toISOString();
  const record: ProjectKeyRecord = {
    key: result.data.key,
    keyId: result.data.keyId,
    parentKeyId,
    label: result.data.label,
    issuedAt: now,
    lastUsedAt: now,
  };
  await store.upsertProjectKey(options.projectRoot, record);
  return {
    kind: 'recovered',
    record,
    // Deliberately NOT `?? []`: coercing an absent field to an empty list would let the
    // answer assert that the dashboard reported nothing revoked when it reported nothing
    // at all. A non-array body is treated as "not reported" for the same reason.
    revokedKeyIds: Array.isArray(result.data.revokedKeyIds) ? result.data.revokedKeyIds : undefined,
  };
}

// ─── Startup recovery hook ───────────────────────────────────────────────────

/** Structured result for the startup recovery runner — logged by `initializeServer`. */
export interface StartupProjectKeyRecoveryResult {
  checked: boolean;
  status:
    | 'skipped-no-project'
    | 'skipped-not-registered'
    | 'skipped-already-present'
    | 'skipped-unconfigured'
    /**
     * s86-m06 — the single `skipped-no-parent-key-id` split in two, because it
     * named ONE cause ("run device code") for two states, and that cause is false
     * in the second one. Both are logged at [WARN] by index.ts: a state in which
     * auto-recovery is structurally impossible until the operator acts is not
     * information.
     */
    | 'skipped-no-user-scoped-key'
    | 'skipped-unattributable-credential'
    | 'recovered'
    | 'error';
  message: string;
}

/** Thin abstraction so tests can stub SQLite metadata reads. */
export type ProjectMetadataReader = (
  projectRoot: string
) => Promise<{ registered: boolean; projectId: string | null } | null>;

/**
 * Thin abstraction so tests can stub dashboard-client construction.
 *
 * s86-m06 — returns the `{client, keySource}` PAIR rather than a bare client:
 * `keySource` is what lets `classifyAttribution` name which arm failed to
 * attribute, and a bare client makes the two failure states indistinguishable.
 */
export type DashboardClientFactory = (
  projectRoot: string
) => Promise<{ client: DashboardClient; keySource: KeySource } | null>;

async function defaultMetadataReader(
  projectRoot: string
): Promise<{ registered: boolean; projectId: string | null } | null> {
  try {
    const result = await withClientAsync<{
      registered: boolean;
      projectId: string | null;
    }>(
      async (client) => {
        const registered = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_registered'`
        );
        const projectId = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_project_id'`
        );
        return {
          success: true,
          data: {
            registered: registered.success && registered.data?.value === 'true',
            projectId: (projectId.success && projectId.data?.value) || null,
          },
        };
      },
      { projectRoot }
    );
    if (!result.success || !result.data) return null;
    return result.data;
  } catch {
    return null;
  }
}

async function defaultClientFactory(
  // Unused by design: user-scoped resolution is not project-keyed. The parameter
  // stays because the injectable factory type is called with a project root.
  _projectRoot: string
): Promise<{ client: DashboardClient; keySource: KeySource } | null> {
  // s86-m06 — USER-scoped resolution, deliberately not `fromEnvForProject`.
  //
  // HONEST STATEMENT OF WHAT THIS CHANGE DOES TODAY: nothing observable. This
  // factory is only ever reached AFTER `runStartupProjectKeyRecovery`'s
  // `skipped-already-present` early return has proven no local project row
  // exists, so `fromEnvForProject`'s arm 2 is provably dead at this call site and
  // the two entry points resolve identically here. It is a latent-trap removal,
  // not a behaviour fix: reissue-on-a-present-row is the reachable defect and it
  // lives in `handleReissue`, not here.
  //
  // Its gate is therefore STRUCTURAL: no CALL to the project-scoped entry point may
  // remain anywhere under src/auth — enforced by
  // tests/auth/user-scoped-resolution-gate.test.ts, which counts call sites, not
  // mentions (s86-m06 criterion 9, whose literal "the grep returns zero" form is not
  // achievable: this comment and auth-state.ts's accurate prose both name the chain).
  // Do NOT revert this line to the project-scoped resolver as a "no-op
  // simplification" in a later dead-code sweep: the next caller who removes the
  // early return above would silently reintroduce authenticating a repair with the
  // credential being repaired.
  const result = await DashboardClient.fromEnvForUser();
  if (!result.success || !result.data) return null;
  return { client: result.data.client, keySource: result.data.keySource };
}

/**
 * Scan the current project for a registered-but-missing project key and call
 * `/reissue` to recover it. Runs at startup after attribution self-test.
 *
 * Always returns a structured result — never throws. The caller (index.ts)
 * logs a single line based on `status`.
 */
export async function runStartupProjectKeyRecovery(
  options: {
    projectRoot?: string;
    metadataReader?: ProjectMetadataReader;
    clientFactory?: DashboardClientFactory;
    store?: CredentialStore;
  } = {}
): Promise<StartupProjectKeyRecoveryResult> {
  if (!options.projectRoot) {
    return {
      checked: false,
      status: 'skipped-no-project',
      message: 'no project root resolved — skipping',
    };
  }

  const metadataReader = options.metadataReader ?? defaultMetadataReader;
  const metadata = await metadataReader(options.projectRoot);
  if (!metadata || !metadata.registered || !metadata.projectId) {
    return {
      checked: true,
      status: 'skipped-not-registered',
      message: 'project has no dashboard registration — nothing to recover',
    };
  }

  const store = options.store ?? (await CredentialStore.create());
  const existing = await store.getProjectKey(options.projectRoot);
  if (existing) {
    return {
      checked: true,
      status: 'skipped-already-present',
      message: 'local project key already present',
    };
  }

  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const resolved = await clientFactory(options.projectRoot);
  if (!resolved) {
    return {
      checked: true,
      status: 'skipped-unconfigured',
      message: 'dashboard client unavailable — recovery deferred',
    };
  }

  // s86-m06 — classify BEFORE calling reissue, and say which of the two states we
  // are in. The old single status told the operator to bootstrap a device code and
  // promised the next reissue would then work — asserted even when the store already
  // held user-scoped keys, and even though startup recovery skips outright whenever a
  // local row exists.
  const attribution = await classifyAttribution(resolved.client, resolved.keySource, store);
  if (!attribution.ok) {
    return startupResultForAttributionFailure(attribution.failure);
  }

  const result = await recoverProjectKey({
    projectRoot: options.projectRoot,
    projectId: metadata.projectId,
    client: resolved.client,
    store,
  });

  switch (result.kind) {
    case 'recovered':
      return {
        checked: true,
        status: 'recovered',
        message: `reissued project key (keyId=${result.record.keyId})`,
      };
    case 'no-op-already-present':
      return {
        checked: true,
        status: 'skipped-already-present',
        message: 'local project key present on re-read',
      };
    case 'missing-parent-key-id':
      // Unreachable: classifyAttribution above already returned on this state.
      // Surfaced as an error rather than a skip so the inconsistency is audible.
      return {
        checked: true,
        status: 'error',
        message:
          'internal inconsistency: attribution classified as usable, but the recovery path found no parent keyId',
      };
    case 'reissue-failed':
      return {
        checked: true,
        status: 'error',
        message: `reissue failed: ${result.error}`,
      };
  }
}

/**
 * Map an attribution failure to a startup status + a message that names the state
 * it is actually in. s86-m06: no branch here may say "device code flow must be
 * run" when the credential store holds a user-scoped key, and none may promise
 * that a later reissue "will succeed".
 */
function startupResultForAttributionFailure(
  failure: AttributionFailure
): StartupProjectKeyRecoveryResult {
  switch (failure.kind) {
    case 'no-user-scoped-key':
      return {
        checked: true,
        status: 'skipped-no-user-scoped-key',
        message: `credential store at ${failure.storePath} holds no user-scoped keys, so an auto-issued project key cannot be attributed; run cmos_auth(action="login") to bootstrap one`,
      };
    case 'unattributable-credential':
      return {
        checked: true,
        status: 'skipped-unattributable-credential',
        message: `the resolved dashboard credential (${describeAttributionArm(failure.via)}) is not a device-code user key, so the dashboard cannot bind a reissued project key to a parent; migrate to a device-code user key via cmos_auth(action="login")`,
      };
    case 'inconsistent-resolution':
      return {
        checked: true,
        status: 'error',
        message: `credential resolution is inconsistent: ${failure.detail} (store: ${failure.storePath})`,
      };
  }
}

/** Operator-facing name for the resolution arm that supplied an unattributable credential. */
export function describeAttributionArm(
  via: 'explicit-override' | 'legacy-env' | 'password-fallback'
): string {
  switch (via) {
    case 'explicit-override':
      return 'a caller-supplied apiKey override';
    case 'legacy-env':
      return 'the legacy CMOS_DASHBOARD_API_KEY environment variable';
    case 'password-fallback':
      return 'the CMOS_DASHBOARD_USER + CMOS_DASHBOARD_PASSWORD fallback';
  }
}

// ─── Sprint 58 m02: startup credential-store empty check ─────────────────────

export type StartupCredentialCheckStatus = 'has-user-scoped-keys' | 'empty-credential-store';

export interface StartupCredentialCheckResult {
  status: StartupCredentialCheckStatus;
  /** True when we emitted the [WARN] line on stderr for this run. */
  warned: boolean;
  /** Count of user-scoped keys observed in the local store (0 when empty). */
  userScopedKeyCount: number;
  /** s78-m06: whether a dashboard was explicitly configured (CMOS_DASHBOARD_URL set).
   *  The empty-store WARN is gated on this so a local-forever install boots silent. */
  dashboardConfigured: boolean;
}

/**
 * Inspect the local credential store on startup and emit a one-line [WARN]
 * when no user-scoped keys are present. A fresh install with no device-code
 * bootstrap looks identical to a broken install from the MCP's perspective —
 * this makes that state audible so the operator knows to run
 * `cmos_auth(action="login")` before attempting a send.
 *
 * Non-fatal: never throws. Startup continues regardless.
 *
 * s78-m06: the empty-store WARN is gated on dashboard INTENT. A local-forever install
 * with no CMOS_DASHBOARD_URL needs no credentials, so the WARN was pure noise on the
 * quietest, most common path — it is suppressed there. When the operator explicitly
 * configured a dashboard (CMOS_DASHBOARD_URL set), an empty store IS actionable, so the
 * WARN stands.
 */
export async function runStartupCredentialCheck(
  options: {
    store?: CredentialStore;
    writer?: (line: string) => void;
    dashboardUrl?: string;
  } = {}
): Promise<StartupCredentialCheckResult> {
  const store = options.store ?? (await CredentialStore.create());
  const writer = options.writer ?? ((line: string) => process.stderr.write(line));
  const dashboardConfigured =
    (options.dashboardUrl ?? process.env.CMOS_DASHBOARD_URL ?? '').trim().length > 0;

  const userKeys = await store.listUserScopedKeys();
  const count = Object.keys(userKeys).length;

  if (count === 0) {
    if (dashboardConfigured) {
      writer(
        '[WARN] cmos-mcp: no user-scoped credentials found; run cmos_auth(action="login") to bootstrap\n'
      );
      return {
        status: 'empty-credential-store',
        warned: true,
        userScopedKeyCount: 0,
        dashboardConfigured,
      };
    }
    // Local-forever: no dashboard intent → no credentials needed → boot silently.
    return {
      status: 'empty-credential-store',
      warned: false,
      userScopedKeyCount: 0,
      dashboardConfigured,
    };
  }

  return {
    status: 'has-user-scoped-keys',
    warned: false,
    userScopedKeyCount: count,
    dashboardConfigured,
  };
}
