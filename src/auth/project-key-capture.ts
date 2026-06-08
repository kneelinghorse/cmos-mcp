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
import { CredentialStore, type ProjectKeyRecord } from '../intelligence/credential-store';

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
  | { kind: 'recovered'; record: ProjectKeyRecord }
  | { kind: 'no-op-already-present' }
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
  return { kind: 'recovered', record };
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
    | 'skipped-no-parent-key-id'
    | 'recovered'
    | 'error';
  message: string;
}

/** Thin abstraction so tests can stub SQLite metadata reads. */
export type ProjectMetadataReader = (
  projectRoot: string
) => Promise<{ registered: boolean; projectId: string | null } | null>;

/** Thin abstraction so tests can stub dashboard-client construction. */
export type DashboardClientFactory = (projectRoot: string) => Promise<DashboardClient | null>;

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

async function defaultClientFactory(projectRoot: string): Promise<DashboardClient | null> {
  const result = await DashboardClient.fromEnvForProject(projectRoot);
  if (!result.success || !result.data) return null;
  return result.data.client;
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
  const client = await clientFactory(options.projectRoot);
  if (!client) {
    return {
      checked: true,
      status: 'skipped-unconfigured',
      message: 'dashboard client unavailable — recovery deferred',
    };
  }

  const result = await recoverProjectKey({
    projectRoot: options.projectRoot,
    projectId: metadata.projectId,
    client,
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
      return {
        checked: true,
        status: 'skipped-no-parent-key-id',
        message:
          'dashboard client has no authenticatingKeyId — run device code flow, then reissue will succeed',
      };
    case 'reissue-failed':
      return {
        checked: true,
        status: 'error',
        message: `reissue failed: ${result.error}`,
      };
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
}

/**
 * Inspect the local credential store on startup and emit a one-line [WARN]
 * when no user-scoped keys are present. A fresh install with no device-code
 * bootstrap looks identical to a broken install from the MCP's perspective —
 * this makes that state audible so the operator knows to run
 * `cmos_auth(action="login")` before attempting a send.
 *
 * Non-fatal: never throws. Startup continues regardless.
 */
export async function runStartupCredentialCheck(
  options: { store?: CredentialStore; writer?: (line: string) => void } = {}
): Promise<StartupCredentialCheckResult> {
  const store = options.store ?? (await CredentialStore.create());
  const writer = options.writer ?? ((line: string) => process.stderr.write(line));

  const userKeys = await store.listUserScopedKeys();
  const count = Object.keys(userKeys).length;

  if (count === 0) {
    writer(
      '[WARN] cmos-mcp: no user-scoped credentials found; run cmos_auth(action="login") to bootstrap\n'
    );
    return { status: 'empty-credential-store', warned: true, userScopedKeyCount: 0 };
  }

  return { status: 'has-user-scoped-keys', warned: false, userScopedKeyCount: count };
}
