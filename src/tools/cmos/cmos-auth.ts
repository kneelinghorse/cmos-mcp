// ABOUTME: Agent-callable key lifecycle — cmos_auth(action=rotate|revoke|list|reissue|login|login_init|login_complete|logout).
// ABOUTME: Thin dispatcher over DashboardClient + CredentialStore so agents can self-heal credentials.

/**
 * `cmos_auth` consolidated tool — Sprint 57 m03 + Sprint 58 m01 + Sprint 59 m02/m03/m04.
 *
 * Gives agents self-service credential actions:
 *   - `rotate`         — mint a new project-scoped key, keep the old one in a
 *                         local `pendingRevoke` slot until the dashboard-scheduled
 *                         `revokeAt` timestamp so in-flight requests don't 401.
 *   - `revoke`         — hard-revoke a specific `keyId` (or the current project
 *                         key for `projectRoot`). Dashboard invalidates immediately;
 *                         local row is removed.
 *   - `list`           — return the dashboard's `GET /api/keys` tree, optionally
 *                         filtered to "mine only" (keys spawned by a user-scoped
 *                         credential currently in this MCP's local store).
 *   - `reissue`        — manual lost-key recovery. Wraps `recoverProjectKey`
 *                         (same endpoint, exposed as an explicit agent action).
 *   - `login`          — RFC 8628 device-code bootstrap as a single blocking call.
 *                         NOTE: The prompt is invisible in IDE MCP hosts (VSCode,
 *                         Cursor, Claude Desktop) because the tool blocks polling
 *                         for the full `expiresIn` window and captured-to-response
 *                         fields only render on tool return. Prefer `login_init`
 *                         + `login_complete` for agent-driven auth in chat. Kept
 *                         for terminal callers where stderr is visible, and for
 *                         scripts/bootstrap-device-code.ts parity.
 *   - `login_init`     — Sprint 59 m04: first leg of the IDE-safe two-call flow.
 *                         Calls `/api/auth/device/code`, returns
 *                         `{deviceCode, userCode, verificationUri, expiresIn,
 *                         interval}` immediately (no blocking) so the agent can
 *                         render the prompt to the user before the code expires.
 *   - `login_complete` — Sprint 59 m04: second leg. Polls `/api/auth/device/token`
 *                         within a bounded `maxWaitSeconds` window and returns
 *                         `{status: 'approved'|'pending'|'expired'|'denied', ...}`.
 *                         Agent calls this after the user approves in browser
 *                         (or repeatedly until terminal). On `approved`, persists
 *                         the minted user-scoped key via CredentialStore.
 *   - `logout`         — Sprint 59 m03: symmetric counterpart to login. Revokes
 *                         the current user-scoped key on the dashboard via the
 *                         unified `revokeKey(keyId)` (m02) and removes the local
 *                         row. Auto-picks the keyId when exactly one user-scoped
 *                         key is in the store; requires an explicit `keyId` when
 *                         there are multiple. Project-scoped children are left
 *                         alone — they remain valid standalone cmk_ bearers
 *                         server-side and their local rows stay intact.
 *
 * All return structured results so agents don't need to parse error strings.
 * `rotate` / `revoke` / `reissue` / `login` / `login_complete` are write
 * surfaces — they always persist (or explicitly report why they didn't) before
 * returning success.
 *
 * @module tools/cmos/cmos-auth
 */

import { z } from 'zod';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import {
  CredentialStore,
  type ProjectKeyRecord,
  type UserScopedKeyRecord,
} from '../../intelligence/credential-store';
import { DashboardClient, type ListedKey, CMOS_DASHBOARD_URL_ENV } from './dashboard-client';
import { withClientAsync } from './client';
import { recoverProjectKey } from '../../auth/project-key-capture';
import {
  DeviceCodeError,
  buildUserAgent,
  defaultPrompter,
  pollForTokenBounded,
  readPackageVersion,
  requestDeviceCode,
  runDeviceCodeFlow,
  type BoundedPollOptions,
  type BoundedPollStatus,
  type DeviceCodeResponse,
  type DeviceCodeFlowOptions,
  type DeviceTokenSuccess,
} from '../../auth/device-code';

export const CMOS_AUTH_ACTIONS = [
  'rotate',
  'revoke',
  'list',
  'reissue',
  'login',
  'login_init',
  'login_complete',
  'logout',
] as const;
export type CmosAuthAction = (typeof CMOS_AUTH_ACTIONS)[number];

const DEFAULT_LOGIN_COMPLETE_MAX_WAIT_SECONDS = 30;
const DEFAULT_LOGIN_COMPLETE_INTERVAL_SECONDS = 2;

export const cmosAuthSchema = z
  .object({
    action: z
      .enum(CMOS_AUTH_ACTIONS)
      .describe(
        'Credential action: rotate | revoke | list | reissue | login | login_init | login_complete | logout'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe(
        'Project root for rotate/revoke/reissue. Defaults to the caller context when absent.'
      ),
    keyId: z
      .string()
      .optional()
      .describe(
        'Specific dashboard-side keyId. revoke: omit to revoke the current project key for projectRoot. logout: omit when there is exactly one user-scoped key in the local store; required when there are multiple.'
      ),
    graceSeconds: z
      .number()
      .int()
      .positive()
      .max(86_400)
      .optional()
      .describe(
        'Grace window for rotate (default: dashboard-side 300s). Keeps old key live while in-flight requests complete.'
      ),
    mineOnly: z
      .boolean()
      .optional()
      .describe(
        'list only: when true (default), filter to keys spawned by a user-scoped key currently in this MCP store.'
      ),
    deviceCode: z
      .string()
      .optional()
      .describe(
        'login_complete only: deviceCode from a prior login_init call. The dashboard-side opaque handle for the pending approval.'
      ),
    maxWaitSeconds: z
      .number()
      .int()
      .positive()
      .max(600)
      .optional()
      .describe(
        'login_complete only: bound the poll window before returning status=pending (default 30s). Agent can re-call login_complete to keep polling.'
      ),
    pollIntervalSeconds: z
      .number()
      .int()
      .positive()
      .max(60)
      .optional()
      .describe(
        'login_complete only: base poll interval (default 2s). Pass the interval from login_init for best behavior; dashboard slow_down responses bump this internally.'
      ),
  })
  .strict();

export type CmosAuthParams = z.infer<typeof cmosAuthSchema>;

export interface RotateActionResult {
  action: 'rotate';
  projectId: string;
  newKeyId: string;
  oldKeyId: string;
  revokeAt: string;
  graceSeconds: number | null;
}

export interface RevokeActionResult {
  action: 'revoke';
  keyId: string;
  /**
   * Local-inferred scope (from the MCP's credential store). 'unknown' when
   * the keyId was not present locally — the dashboard still revoked it, but
   * no local cleanup applied. Dashboard does NOT echo scope back from
   * /api/keys/:keyId/revoke — we infer pre-revoke for cleanup routing.
   */
  scope: 'user' | 'project' | 'unknown';
  revokedAt: string;
}

export interface ListActionResult {
  action: 'list';
  mineOnly: boolean;
  userScoped: ListedKey[];
  projectScoped: ListedKey[];
  /** Count of rows filtered out when mineOnly=true. 0 when mineOnly=false. */
  filteredOut: number;
}

export interface ReissueActionResult {
  action: 'reissue';
  projectId: string;
  newKeyId: string;
  revokedKeyIds: string[];
}

/**
 * Sprint 58 m01 — RFC 8628 device-code bootstrap result.
 *
 * `verificationUri`/`userCode`/`expiresIn`/`interval` come from the initial
 * `/api/auth/device/code` response (captured by the response-prompter) so IDE
 * MCP hosts render them in the tool payload rather than swallowing stderr.
 *
 * `keyId`/`label` come from the eventual `/api/auth/device/token` success body
 * after the user approves. The minted user-scoped key is persisted to the
 * credential store before this result is returned.
 */
export interface LoginActionResult {
  action: 'login';
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  keyId: string;
  label: string;
}

/**
 * Sprint 59 m04 — `login_init` result. First leg of the IDE-safe two-call
 * auth flow; returns device code response immediately (no blocking) so the
 * agent can surface userCode + verificationUri to the user before the code
 * expires. Pass `deviceCode` and `interval` back to `login_complete`.
 */
export interface LoginInitActionResult {
  action: 'login_init';
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * Sprint 59 m04 — `login_complete` result. Second leg of the two-call flow.
 * `status` is one of four terminal states; transport / malformed failures
 * surface as `success: false` with code `DASHBOARD_ERROR`. On `approved`, the
 * minted user-scoped key is persisted before the result is returned.
 * `intervalSeconds` is set on `approved` / `pending` so the agent can carry
 * any `slow_down`-adjusted interval into the next `login_complete` call.
 */
export interface LoginCompleteActionResult {
  action: 'login_complete';
  status: 'approved' | 'pending' | 'expired' | 'denied';
  keyId?: string;
  label?: string;
  description?: string;
  intervalSeconds?: number;
}

/**
 * Sprint 59 m03 — `logout` result. Symmetric to login: revokes the current
 * user-scoped key on the dashboard and removes the local row. Project-scoped
 * children are not cascade-revoked — they remain standalone valid cmk_
 * bearers on the dashboard and in the local store.
 */
export interface LogoutActionResult {
  action: 'logout';
  keyId: string;
  revokedAt: string;
}

export type CmosAuthResult =
  | RotateActionResult
  | RevokeActionResult
  | ListActionResult
  | ReissueActionResult
  | LoginActionResult
  | LoginInitActionResult
  | LoginCompleteActionResult
  | LogoutActionResult;

export const cmosAuthToolDefinition = {
  name: 'cmos_auth',
  description:
    'Agent-callable credential lifecycle. Actions: login_init (non-blocking — starts RFC 8628 ' +
    'device-code flow, returns userCode + verificationUri immediately; agent renders them for ' +
    'user approval) + login_complete (polls within a bounded window; returns status ' +
    "'approved'|'pending'|'expired'|'denied'). Prefer login_init + login_complete for " +
    'agent-driven auth in chat — a single blocking login is invisible in IDE MCP hosts. ' +
    'login (legacy single-call blocking flow; kept for terminal callers where stderr is visible). ' +
    'logout (symmetric to login — revokes the current user-scoped key on the dashboard + clears the local row). ' +
    'rotate (mint new project key with grace window), revoke (hard-revoke a keyId), ' +
    'list (view credential tree, mine-only by default), reissue (recover a lost project key). ' +
    'All writes persist atomically to the local credential store; agents can call these ' +
    'directly without human intervention.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...CMOS_AUTH_ACTIONS],
        description:
          'Credential action: rotate | revoke | list | reissue | login | login_init | login_complete | logout',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root for rotate/revoke/reissue. Defaults to caller context.',
      },
      keyId: {
        type: 'string',
        description:
          'Specific dashboard keyId to revoke. Omit to revoke the current project key for projectRoot.',
      },
      graceSeconds: {
        type: 'number',
        minimum: 1,
        maximum: 86_400,
        description: 'Rotate grace window (default: 300s dashboard-side).',
      },
      mineOnly: {
        type: 'boolean',
        description:
          'list only: default true. When true, filter to keys spawned by a local user-scoped credential.',
      },
      deviceCode: {
        type: 'string',
        description:
          'login_complete only: deviceCode from a prior login_init call. Opaque dashboard-side handle.',
      },
      maxWaitSeconds: {
        type: 'number',
        minimum: 1,
        maximum: 600,
        description:
          'login_complete only: bound the poll window before returning status=pending (default 30s).',
      },
      pollIntervalSeconds: {
        type: 'number',
        minimum: 1,
        maximum: 60,
        description:
          'login_complete only: base poll interval (default 2s). Use the interval from login_init for best behavior.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

// ─── Injection points ────────────────────────────────────────────────────────

/**
 * Build a dashboard client for `projectRoot`. Swappable in tests.
 * Returns `null` when the dashboard cannot be configured (missing URL or
 * credentials) — caller surfaces a typed error.
 */
export type DashboardClientResolver = (
  projectRoot: string | undefined
) => Promise<DashboardClient | null>;

/**
 * Read `dashboard_project_id` + `dashboard_registered` from the SQLite
 * metadata table. Returns `null` when the project has no DB (eg. uninitialized).
 */
export type DashboardProjectIdReader = (projectRoot: string) => Promise<string | null>;

const defaultDashboardClientResolver: DashboardClientResolver = async (projectRoot) => {
  const result = await DashboardClient.fromEnvForProject(projectRoot);
  if (!result.success || !result.data) return null;
  return result.data.client;
};

const defaultDashboardProjectIdReader: DashboardProjectIdReader = async (projectRoot) => {
  try {
    const result = await withClientAsync<string | null>(
      async (client) => {
        const row = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_project_id'`
        );
        const registered = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_registered'`
        );
        const isRegistered = registered.success && registered.data?.value === 'true';
        const id = (row.success && row.data?.value) || null;
        return { success: true, data: isRegistered ? id : null };
      },
      { projectRoot }
    );
    if (!result.success) return null;
    return result.data ?? null;
  } catch {
    return null;
  }
};

/**
 * Swappable device-code flow implementation. Default: `runDeviceCodeFlow` from
 * `src/auth/device-code`. Tests inject a wrapper that passes a mock
 * `fetchImpl` / `sleepFn` / `nowFn` through to the real flow so the handler's
 * prompter-capture + error-mapping stays exercised end-to-end.
 */
export type DeviceCodeFlowImpl = (options: DeviceCodeFlowOptions) => Promise<DeviceTokenSuccess>;

/**
 * Sprint 59 m04 — swappable request for the device/code leg. Tests inject a
 * wrapper around `requestDeviceCode` that threads a mock fetchImpl through.
 */
export type DeviceCodeRequesterImpl = (options: {
  baseUrl: string;
  userAgent: string;
}) => Promise<DeviceCodeResponse>;

/**
 * Sprint 59 m04 — swappable bounded poll for the device/token leg. Tests
 * inject a wrapper around `pollForTokenBounded` that threads mock
 * fetchImpl / sleepFn / nowFn through.
 */
export type TokenPollerImpl = (options: BoundedPollOptions) => Promise<BoundedPollStatus>;

export interface CmosAuthDependencies {
  store?: CredentialStore;
  clientResolver?: DashboardClientResolver;
  projectIdReader?: DashboardProjectIdReader;
  /** Sprint 58 m01 — override for tests; default = `runDeviceCodeFlow`. */
  deviceCodeFlow?: DeviceCodeFlowImpl;
  /** Sprint 59 m04 — override for tests; default wraps `requestDeviceCode`. */
  deviceCodeRequester?: DeviceCodeRequesterImpl;
  /** Sprint 59 m04 — override for tests; default = `pollForTokenBounded`. */
  tokenPoller?: TokenPollerImpl;
  /**
   * Sprint 58 m01 — override for tests; default reads
   * `process.env[CMOS_DASHBOARD_URL_ENV]`. Null disables the login action.
   */
  dashboardBaseUrl?: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function isAction(value: string): value is CmosAuthAction {
  return (CMOS_AUTH_ACTIONS as readonly string[]).includes(value);
}

export async function cmosAuth(
  params: CmosAuthParams,
  deps: CmosAuthDependencies = {}
): Promise<CmosToolResult<CmosAuthResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';
  if (!isAction(actionValue)) {
    return createError<CmosAuthResult>(
      CmosErrors.invalidAction('cmos_auth', actionValue, CMOS_AUTH_ACTIONS)
    );
  }

  const store = deps.store ?? (await CredentialStore.create());
  const clientResolver = deps.clientResolver ?? defaultDashboardClientResolver;
  const projectIdReader = deps.projectIdReader ?? defaultDashboardProjectIdReader;
  const deviceCodeFlow = deps.deviceCodeFlow ?? runDeviceCodeFlow;
  const deviceCodeRequester =
    deps.deviceCodeRequester ?? (({ baseUrl, userAgent }) => requestDeviceCode(baseUrl, userAgent));
  const tokenPoller = deps.tokenPoller ?? pollForTokenBounded;
  const dashboardBaseUrl =
    deps.dashboardBaseUrl !== undefined
      ? deps.dashboardBaseUrl
      : process.env[CMOS_DASHBOARD_URL_ENV];

  switch (actionValue) {
    case 'rotate':
      return handleRotate(params, store, clientResolver, projectIdReader);
    case 'revoke':
      return handleRevoke(params, store, clientResolver);
    case 'list':
      return handleList(params, store, clientResolver);
    case 'reissue':
      return handleReissue(params, store, clientResolver, projectIdReader);
    case 'login':
      return handleLogin(store, deviceCodeFlow, dashboardBaseUrl);
    case 'login_init':
      return handleLoginInit(deviceCodeRequester, dashboardBaseUrl);
    case 'login_complete':
      return handleLoginComplete(params, store, tokenPoller, dashboardBaseUrl);
    case 'logout':
      return handleLogout(params, store, clientResolver);
  }
}

async function handleRotate(
  params: CmosAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver,
  projectIdReader: DashboardProjectIdReader
): Promise<CmosToolResult<CmosAuthResult>> {
  if (!params.projectRoot) {
    return createError<CmosAuthResult>(CmosErrors.missingParameter('projectRoot'));
  }

  const existing = await store.getProjectKey(params.projectRoot);
  if (!existing) {
    return createError<CmosAuthResult>({
      code: 'CREDENTIAL_NOT_FOUND',
      message: `No project-scoped key found locally for ${params.projectRoot}`,
      suggestion:
        'Run registration or cmos_auth(action=reissue) to populate the local project key first.',
    });
  }

  const projectId = await projectIdReader(params.projectRoot);
  if (!projectId) {
    return createError<CmosAuthResult>({
      code: 'PROJECT_NOT_REGISTERED',
      message: `No dashboard_project_id recorded for ${params.projectRoot}`,
      suggestion: 'The project must be registered with the dashboard before keys can be rotated.',
    });
  }

  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  const rotate = await client.rotateProjectKey(
    projectId,
    params.graceSeconds !== undefined ? { graceSeconds: params.graceSeconds } : {}
  );
  if (!rotate.success || !rotate.data) {
    return createError<CmosAuthResult>(
      rotate.error ?? CmosErrors.dashboardError('rotate returned no data')
    );
  }

  const now = new Date().toISOString();
  const next: ProjectKeyRecord = {
    key: rotate.data.newKey,
    keyId: rotate.data.newKeyId,
    parentKeyId: existing.parentKeyId,
    label: rotate.data.label ?? existing.label,
    issuedAt: now,
    lastUsedAt: now,
  };
  await store.swapProjectKey(params.projectRoot, next, {
    key: existing.key,
    keyId: rotate.data.oldKeyId,
    revokeAt: rotate.data.revokeAt,
  });

  return createSuccess<CmosAuthResult>({
    action: 'rotate',
    projectId,
    newKeyId: rotate.data.newKeyId,
    oldKeyId: rotate.data.oldKeyId,
    revokeAt: rotate.data.revokeAt,
    graceSeconds: params.graceSeconds ?? null,
  });
}

async function handleRevoke(
  params: CmosAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver
): Promise<CmosToolResult<CmosAuthResult>> {
  // Sprint 59 m02 — unified scope-aware revoke. Accepts either an explicit
  // keyId or a projectRoot (to derive the keyId from the local project key).
  // The dashboard infers scope from the key row and enforces ownership, so
  // the tool no longer needs `projectId` to build the URL.
  let targetKeyId = params.keyId;
  if (!targetKeyId) {
    if (!params.projectRoot) {
      return createError<CmosAuthResult>({
        code: 'MISSING_PARAMETER',
        message: 'revoke requires either keyId or projectRoot.',
        suggestion:
          'Pass keyId to revoke a specific key, or projectRoot to revoke that project’s local project-scoped key.',
      });
    }
    const existing = await store.getProjectKey(params.projectRoot);
    if (!existing) {
      return createError<CmosAuthResult>({
        code: 'CREDENTIAL_NOT_FOUND',
        message: `No project-scoped key found locally for ${params.projectRoot}, and no explicit keyId was supplied.`,
        suggestion: 'Pass keyId to revoke a specific dashboard key.',
      });
    }
    targetKeyId = existing.keyId;
  }

  // Determine scope locally from credential store BEFORE calling revoke.
  // Dashboard message 335c3a34 (2026-04-23) confirmed the shipped response
  // envelope is {keyId, revokedAt} — scope is inferred server-side but NOT
  // echoed back. Local inference drives cleanup routing.
  const userScopedKeys = await store.listUserScopedKeys();
  const allProjects = await store.listProjectKeys();
  let scope: 'user' | 'project' | 'unknown';
  if (userScopedKeys[targetKeyId]) {
    scope = 'user';
  } else {
    const hasProjectMatch = Object.values(allProjects).some(
      (record) => record.keyId === targetKeyId || record.pendingRevoke?.keyId === targetKeyId
    );
    scope = hasProjectMatch ? 'project' : 'unknown';
  }

  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  const result = await client.revokeKey(targetKeyId);
  if (!result.success || !result.data) {
    return createError<CmosAuthResult>(
      result.error ?? CmosErrors.dashboardError('revoke returned no data')
    );
  }

  // Local cleanup per inferred scope. 'unknown' → no local row to clean.
  if (scope === 'user') {
    await store.removeUserScopedKey(targetKeyId);
  } else if (scope === 'project') {
    for (const [projectRoot, record] of Object.entries(allProjects)) {
      if (record.keyId === targetKeyId) {
        await store.removeProjectKey(projectRoot);
      } else if (record.pendingRevoke?.keyId === targetKeyId) {
        await store.clearPendingRevoke(projectRoot);
      }
    }
  }

  return createSuccess<CmosAuthResult>({
    action: 'revoke',
    keyId: targetKeyId,
    scope,
    revokedAt: result.data.revokedAt,
  });
}

async function handleList(
  params: CmosAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver
): Promise<CmosToolResult<CmosAuthResult>> {
  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  const listResult = await client.listKeys();
  if (!listResult.success || !listResult.data) {
    return createError<CmosAuthResult>(
      listResult.error ?? CmosErrors.dashboardError('list returned no data')
    );
  }

  const mineOnly = params.mineOnly !== false; // default true
  const localUserScopedKeys: Record<string, UserScopedKeyRecord> = await store.listUserScopedKeys();
  const mineKeyIds = new Set(Object.keys(localUserScopedKeys));

  const userScoped: ListedKey[] = [];
  const projectScoped: ListedKey[] = [];
  let filteredOut = 0;

  for (const key of listResult.data.keys) {
    const isUserScoped = !key.projectId;
    if (mineOnly) {
      const belongsToMe = isUserScoped
        ? mineKeyIds.has(key.id)
        : key.parentKeyId !== null && mineKeyIds.has(key.parentKeyId);
      if (!belongsToMe) {
        filteredOut += 1;
        continue;
      }
    }
    if (isUserScoped) {
      userScoped.push(key);
    } else {
      projectScoped.push(key);
    }
  }

  return createSuccess<CmosAuthResult>({
    action: 'list',
    mineOnly,
    userScoped,
    projectScoped,
    filteredOut,
  });
}

async function handleReissue(
  params: CmosAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver,
  projectIdReader: DashboardProjectIdReader
): Promise<CmosToolResult<CmosAuthResult>> {
  if (!params.projectRoot) {
    return createError<CmosAuthResult>(CmosErrors.missingParameter('projectRoot'));
  }

  const projectId = await projectIdReader(params.projectRoot);
  if (!projectId) {
    return createError<CmosAuthResult>({
      code: 'PROJECT_NOT_REGISTERED',
      message: `No dashboard_project_id recorded for ${params.projectRoot}`,
      suggestion: 'Project must be registered before a key can be reissued.',
    });
  }

  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  // recoverProjectKey no-ops when a local key already exists; reissue should
  // force a fresh key even when something is present, so drop any existing
  // row first.
  await store.removeProjectKey(params.projectRoot);

  const recovery = await recoverProjectKey({
    projectRoot: params.projectRoot,
    projectId,
    client,
    store,
  });

  if (recovery.kind === 'recovered') {
    return createSuccess<CmosAuthResult>({
      action: 'reissue',
      projectId,
      newKeyId: recovery.record.keyId,
      revokedKeyIds: [],
    });
  }
  if (recovery.kind === 'missing-parent-key-id') {
    return createError<CmosAuthResult>({
      code: 'DEVICE_CODE_REQUIRED',
      message:
        'Dashboard client has no authenticatingKeyId — device code flow must be run before reissue',
      suggestion:
        'Run the device code bootstrap (s57-m01) so the credential store has at least one user-scoped key.',
    });
  }
  if (recovery.kind === 'reissue-failed') {
    return createError<CmosAuthResult>(CmosErrors.dashboardError(recovery.error));
  }
  // 'no-op-already-present' can't happen — we removed the existing row above.
  return createError<CmosAuthResult>(
    CmosErrors.dashboardError('reissue recovery returned an unexpected state')
  );
}

async function handleLogin(
  store: CredentialStore,
  deviceCodeFlow: DeviceCodeFlowImpl,
  dashboardBaseUrl: string | null | undefined
): Promise<CmosToolResult<CmosAuthResult>> {
  if (!dashboardBaseUrl) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  let captured: DeviceCodeResponse | undefined;
  try {
    const token = await deviceCodeFlow({
      baseUrl: dashboardBaseUrl,
      credentialStore: store,
      prompter: (response) => {
        // Dual-emit: (a) capture into the response payload so IDE MCP hosts
        // (which swallow stderr) can render verificationUri/userCode to the
        // user/agent, (b) print to stderr so terminal callers and live
        // integration tests see the prompt immediately instead of after the
        // poll loop completes.
        captured = response;
        defaultPrompter(response);
      },
    });

    if (!captured) {
      // The default flow always invokes the prompter before polling; this
      // only triggers if a test double omits it.
      return createError<CmosAuthResult>(
        CmosErrors.dashboardError('device code flow produced no prompt response')
      );
    }

    return createSuccess<CmosAuthResult>({
      action: 'login',
      verificationUri: captured.verificationUri,
      userCode: captured.userCode,
      expiresIn: captured.expiresIn,
      interval: captured.interval,
      keyId: token.keyId,
      label: token.label,
    });
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      return createError<CmosAuthResult>(mapDeviceCodeError(err));
    }
    throw err;
  }
}

async function handleLoginInit(
  deviceCodeRequester: DeviceCodeRequesterImpl,
  dashboardBaseUrl: string | null | undefined
): Promise<CmosToolResult<CmosAuthResult>> {
  if (!dashboardBaseUrl) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  const version = await readPackageVersion();
  const userAgent = buildUserAgent(version);

  try {
    const response = await deviceCodeRequester({ baseUrl: dashboardBaseUrl, userAgent });
    return createSuccess<CmosAuthResult>({
      action: 'login_init',
      deviceCode: response.deviceCode,
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      expiresIn: response.expiresIn,
      interval: response.interval,
    });
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      return createError<CmosAuthResult>(mapDeviceCodeError(err));
    }
    throw err;
  }
}

async function handleLoginComplete(
  params: CmosAuthParams,
  store: CredentialStore,
  tokenPoller: TokenPollerImpl,
  dashboardBaseUrl: string | null | undefined
): Promise<CmosToolResult<CmosAuthResult>> {
  if (!dashboardBaseUrl) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }
  if (!params.deviceCode) {
    return createError<CmosAuthResult>(CmosErrors.missingParameter('deviceCode'));
  }

  const maxWaitSeconds = params.maxWaitSeconds ?? DEFAULT_LOGIN_COMPLETE_MAX_WAIT_SECONDS;
  const intervalSeconds = params.pollIntervalSeconds ?? DEFAULT_LOGIN_COMPLETE_INTERVAL_SECONDS;

  const version = await readPackageVersion();
  const userAgent = buildUserAgent(version);

  try {
    const poll = await tokenPoller({
      baseUrl: dashboardBaseUrl,
      deviceCode: params.deviceCode,
      userAgent,
      intervalSeconds,
      maxWaitSeconds,
    });

    switch (poll.status) {
      case 'approved': {
        const now = new Date().toISOString();
        const record: UserScopedKeyRecord = {
          key: poll.key,
          label: poll.label,
          issuedAt: now,
          lastUsedAt: now,
        };
        await store.upsertUserScopedKey(poll.keyId, record);
        return createSuccess<CmosAuthResult>({
          action: 'login_complete',
          status: 'approved',
          keyId: poll.keyId,
          label: poll.label,
          intervalSeconds: poll.intervalSeconds,
        });
      }
      case 'pending':
        return createSuccess<CmosAuthResult>({
          action: 'login_complete',
          status: 'pending',
          intervalSeconds: poll.intervalSeconds,
        });
      case 'expired':
        return createSuccess<CmosAuthResult>({
          action: 'login_complete',
          status: 'expired',
        });
      case 'denied':
        return createSuccess<CmosAuthResult>({
          action: 'login_complete',
          status: 'denied',
          ...(poll.description !== undefined ? { description: poll.description } : {}),
        });
    }
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      return createError<CmosAuthResult>(mapDeviceCodeError(err));
    }
    throw err;
  }
}

async function handleLogout(
  params: CmosAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver
): Promise<CmosToolResult<CmosAuthResult>> {
  const userScopedKeys = await store.listUserScopedKeys();
  const localKeyIds = Object.keys(userScopedKeys);

  let targetKeyId: string;
  if (params.keyId) {
    if (!userScopedKeys[params.keyId]) {
      return createError<CmosAuthResult>({
        code: 'CREDENTIAL_NOT_FOUND',
        message: `keyId ${params.keyId} is not a user-scoped key in the local credential store.`,
        suggestion:
          'logout specifically targets user-scoped login sessions. For project-scoped revocation use cmos_auth(action="revoke", keyId=...).',
      });
    }
    targetKeyId = params.keyId;
  } else if (localKeyIds.length === 0) {
    return createError<CmosAuthResult>({
      code: 'CREDENTIAL_NOT_FOUND',
      message: 'No user-scoped key in the local credential store to logout.',
      suggestion:
        'Run cmos_auth(action="login_init") then login_complete to bootstrap a credential first.',
    });
  } else if (localKeyIds.length === 1) {
    targetKeyId = localKeyIds[0]!;
  } else {
    return createError<CmosAuthResult>({
      code: 'MISSING_PARAMETER',
      message: `Multiple user-scoped keys (${localKeyIds.length}) in the local store — pass an explicit keyId to logout a specific one.`,
      suggestion:
        'cmos_auth(action="list", mineOnly=true) lists your user-scoped keys; pass the target as keyId.',
    });
  }

  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<CmosAuthResult>(CmosErrors.dashboardNotConfigured());
  }

  const result = await client.revokeKey(targetKeyId);
  if (!result.success || !result.data) {
    return createError<CmosAuthResult>(
      result.error ?? CmosErrors.dashboardError('logout revokeKey returned no data')
    );
  }

  // Remove the local user-scoped row. Project-scoped children are left alone
  // — they keep working server-side as standalone cmk_ bearers; if the user
  // wants to clean them up they can revoke each individually.
  await store.removeUserScopedKey(targetKeyId);

  return createSuccess<CmosAuthResult>({
    action: 'logout',
    keyId: targetKeyId,
    revokedAt: result.data.revokedAt,
  });
}

function mapDeviceCodeError(err: DeviceCodeError): {
  code: string;
  message: string;
  suggestion: string;
} {
  switch (err.code) {
    case 'expired_token':
      return {
        code: 'DEVICE_CODE_EXPIRED',
        message: err.description
          ? `Device code expired before authorization completed: ${err.description}`
          : 'Device code expired before authorization completed',
        suggestion:
          'Re-run cmos_auth(action="login") to request a fresh code, then approve it at the verificationUri before it expires.',
      };
    case 'access_denied':
      return {
        code: 'DEVICE_CODE_ACCESS_DENIED',
        message: err.description
          ? `Authorization was denied: ${err.description}`
          : 'Authorization was denied at the dashboard',
        suggestion:
          'Approve the device code at the verificationUri when re-running cmos_auth(action="login").',
      };
    case 'request_failed':
    case 'malformed_response':
    default:
      return {
        code: 'DASHBOARD_ERROR',
        message: `Dashboard error: ${err.message}`,
        suggestion: 'Check the dashboard is reachable and the device-code endpoints are healthy.',
      };
  }
}

export function formatAuthForLLM(action: string, result: CmosToolResult<CmosAuthResult>): string {
  if (!result.success || !result.data) {
    return `cmos_auth ${action} failed: ${result.error?.message ?? 'unknown error'}`;
  }
  const d = result.data;
  switch (d.action) {
    case 'rotate':
      return `Rotated project key on ${d.projectId}: new=${d.newKeyId}, old=${d.oldKeyId} revokes at ${d.revokeAt}.`;
    case 'revoke':
      return `Revoked ${d.scope}-scoped key ${d.keyId}.`;
    case 'list':
      return `Listed ${d.userScoped.length} user-scoped + ${d.projectScoped.length} project-scoped keys (mineOnly=${d.mineOnly}, filteredOut=${d.filteredOut}).`;
    case 'reissue':
      return `Reissued project key on ${d.projectId}: new keyId=${d.newKeyId}.`;
    case 'login':
      return `Logged in via device code (keyId=${d.keyId}, label="${d.label}"). Open ${d.verificationUri} and enter ${d.userCode} if you haven't already — this key is now persisted locally.`;
    case 'login_init':
      return `Device code issued. Open ${d.verificationUri} and enter ${d.userCode} (expires in ${d.expiresIn}s). Then call cmos_auth(action="login_complete", deviceCode, pollIntervalSeconds=${d.interval}).`;
    case 'login_complete': {
      switch (d.status) {
        case 'approved':
          return `Login approved. keyId=${d.keyId ?? 'unknown'}, label="${d.label ?? ''}" persisted locally.`;
        case 'pending':
          return `Login still pending approval. Call cmos_auth(action="login_complete") again (pollIntervalSeconds=${d.intervalSeconds ?? '?'}).`;
        case 'expired':
          return `Device code expired before approval. Re-run cmos_auth(action="login_init") to request a fresh code.`;
        case 'denied':
          return `Login denied at the dashboard${d.description ? `: ${d.description}` : ''}.`;
      }
      return `login_complete ${String(d.status)}`;
    }
    case 'logout':
      return `Logged out user-scoped key ${d.keyId} (revoked at ${d.revokedAt}). Local row cleared.`;
  }
}
