/**
 * Dashboard HTTP Client & Credential-Based Authentication
 *
 * Reusable HTTP client for calling the cmos-dashboard REST API.
 * Authenticates via POST /api/auth/login with user credentials,
 * caches the JWT, and re-authenticates when it expires.
 *
 * @module tools/cmos/dashboard-client
 */

import { readFileSync } from 'fs';
import path from 'path';
import type { CmosToolResult } from './types';
import { createError, createSuccess, CmosErrors } from './errors';
import {
  CredentialStore,
  type KeySource,
  type UserScopedKeyRecord,
} from '../../intelligence/credential-store';

// ─── Environment Variable Names ──────────────────────────────────────────────

export const CMOS_DASHBOARD_URL_ENV = 'CMOS_DASHBOARD_URL';
export const CMOS_DASHBOARD_USER_ENV = 'CMOS_DASHBOARD_USER';
export const CMOS_DASHBOARD_PASSWORD_ENV = 'CMOS_DASHBOARD_PASSWORD';
export const CMOS_DASHBOARD_API_KEY_ENV = 'CMOS_DASHBOARD_API_KEY';

/**
 * Default dashboard URL used when CMOS_DASHBOARD_URL is unset or empty.
 * Sprint 62 m02: bakes the canonical aquex.ai endpoint into the npm-shipped
 * package so fresh installs reach the right host without env config. The 402
 * graceful-degradation path (m05) is the actual fresh-user UX when the user
 * has no account yet — they hit the default URL, dashboard returns 402, and
 * cmos_message etc surface https://cmos.aquex.ai/register for sign-up.
 */
export const DEFAULT_DASHBOARD_URL = 'https://cmos.aquex.ai';

/**
 * Resolve the dashboard base URL from explicit override → env var → baked default.
 * Treats empty string as unset (per IDE-spawn empty-string env trap).
 *
 * Exported so downstream tools (cmos_status, future hosts) can read the same
 * effective URL without re-implementing the precedence chain.
 */
export function resolveDashboardBaseUrl(override?: string): string {
  if (override) return override;
  const envValue = process.env[CMOS_DASHBOARD_URL_ENV];
  if (envValue) return envValue;
  return DEFAULT_DASHBOARD_URL;
}

// ─── Sprint 58 m02: legacy-auth migration WARN ───────────────────────────────

/**
 * Tracks whether we've already emitted a [WARN] line for each legacy arm in
 * this process, so the warning fires exactly once per arm per run — loud
 * enough to be seen, quiet enough that repeated calls don't spam logs.
 *
 * Visible to tests via `__resetLegacyAuthWarnSeen` so assertions can force
 * a clean slate per case.
 */
const legacyAuthWarnSeen = new Set<'legacy-env' | 'password-fallback'>();

function warnLegacyAuth(arm: 'legacy-env' | 'password-fallback'): void {
  if (legacyAuthWarnSeen.has(arm)) return;
  legacyAuthWarnSeen.add(arm);
  const armLabel = arm === 'legacy-env' ? 'legacy-env' : 'password-fallback';
  process.stderr.write(
    `[WARN] cmos-mcp: authenticating via ${armLabel}; run cmos_auth(action="login") to migrate to device-code credentials\n`
  );
}

/** Test helper — reset the per-process WARN seen-set. */
export function __resetLegacyAuthWarnSeen(): void {
  legacyAuthWarnSeen.clear();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardClientConfig {
  /** Dashboard base URL (e.g. https://cmos.aquex.ai) */
  baseUrl: string;
  /** API key for dashboard auth (cmk_ prefix). If set, email/password are not needed. */
  apiKey?: string;
  /** User email for dashboard login */
  email?: string;
  /** User password for dashboard login */
  password?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

export interface LoginResponse {
  success: boolean;
  data: {
    token: string;
    expiresAt: string;
    user: {
      id: string;
      email: string;
      username?: string;
      projects: unknown[];
    };
  };
}

/**
 * Cached user identity from the last successful login.
 * Used for address discovery (username) and sender context (userId).
 */
export interface DashboardUserIdentity {
  userId: string;
  email: string;
  username: string | null;
}

export interface DashboardMessage {
  id: string;
  type: string;
  summary: string;
  body?: string;
  from?: string;
  to?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  evidence?: unknown[];
  /** Explicit sender project ID (intel message types) */
  from_project_id?: string;
  /** Explicit recipient project ID (intel message types) */
  to_project_id?: string;
  /** Canonical cmos:// address of the sender, echoed back by the dashboard when supported. */
  senderAddress?: string;
  /**
   * Routing/delivery status returned by the dashboard when recipient-relay ACKs are available
   * (e.g. "queued", "delivered", "failed"). Absent on dashboards that have not yet implemented
   * the ACK surface — callers should treat absence as "status=pending, unknown routing" and
   * NOT infer delivery success. Tracked as a cross-repo dependency on the dashboard side.
   */
  deliveryStatus?: string;
  /**
   * Sprint 31 dashboard ACK signal — how the dashboard attributed this send:
   *   `api-key`      — project-scoped key auth (post-rotation steady state)
   *   `request-body` — legacy user-scoped key + body-level senderProjectId
   *   `none`         — could not identify a sender project
   * Sprint 57 m04 reads this to surface authState in whoami + onboard.
   */
  deliveryAck?: {
    identitySource: 'api-key' | 'request-body' | 'none';
    recordedSender?: {
      projectId?: string | null;
      slug?: string | null;
      cmosAddress?: string | null;
    };
  };
  // ── Live dashboard fields (s80-m05 probe, 2026-07-09) ──────────────────────
  // The dashboard returns a RICHER row than the s31-era typed set above. These are
  // the fields observed on a real inbox row; the summary shape (MessageSummary) picks
  // from them, and body-on-get returns the whole row. NOTE: the human-readable
  // attribution the dashboard actually populates is `senderProject`/`senderDisplayName`
  // (NOT `from`/`from_project_id`/`senderAddress`, which are empty on live rows).
  /** ActivityPub verb (e.g. "update"), mirrors MESSAGE_TYPE_MAP. */
  verb?: string;
  /** ActivityPub object type (e.g. "mission"). */
  objectType?: string;
  /** Nested payload; `payload.body` is the full message text (the bulk of list bytes). */
  payload?: { body?: string } & Record<string, unknown>;
  /** When the recipient responded (accept/decline/reply). */
  respondedAt?: string | null;
  /** Free-text response notes (heavy; body-on-get only). */
  responseNotes?: string | null;
  /** Inbox: the sender project's display name (e.g. "CMOS-MCP Pro"). */
  senderProject?: string | null;
  /** Inbox: the sender operator's display name (e.g. "kneelinghorse"). */
  senderDisplayName?: string | null;
  /** Inbox: the sender operator's email. */
  senderEmail?: string | null;
  /** Sent: the recipient project's display name. */
  targetProject?: string | null;
  /** Sent: the target mission id, when the message was addressed to one. */
  targetMissionId?: string | null;
  // ── s84-m01: sprint-47 dashboard messaging cutover (msg 3d59132e) ──────────
  // The cutover REPURPOSES `senderProject`/`targetProject` to carry the SLUG
  // (they previously carried the display NAME) and adds these `*Name` twins to
  // carry the display NAME, plus four additive identity UUIDs on every row.
  // Version-tolerant reads use `*Name ?? *Project` (name ?? slug) so they yield
  // the NAME pre-cutover (only slug-less `*Project`=NAME populated) AND
  // post-cutover (`*Name`=NAME populated). All optional so a pre-cutover row parses.
  /** Inbox: the sender project's display name post-cutover (twin of the now-slug `senderProject`). */
  senderProjectName?: string | null;
  /** Sent: the recipient project's display name post-cutover (twin of the now-slug `targetProject`). */
  targetProjectName?: string | null;
  /** Additive identity UUID: sender operator's user id. Distinct from the snake_case
   *  `from_project_id` (a PROJECT id) and from the outbound `SendMessageParams.senderProjectId`. */
  senderUserId?: string | null;
  /** Additive identity UUID: sender PROJECT id. Distinct from the snake_case `from_project_id`
   *  (legacy intel field) and the outbound `SendMessageParams.senderProjectId`. */
  senderProjectId?: string | null;
  /** Additive identity UUID: recipient operator's user id. */
  targetUserId?: string | null;
  /** Additive identity UUID: recipient PROJECT id. Distinct from the snake_case `to_project_id`. */
  targetProjectId?: string | null;
}

export interface SendMessageParams {
  targetAddress: string;
  type: string;
  summary: string;
  body?: string;
  evidence?: unknown[];
  /** Sender project ID for cross-project same-owner sends */
  senderProjectId?: string;
  /** Explicit sender project ID for project-to-project routing (intel types) */
  fromProjectId?: string;
  /** Explicit recipient project ID for project-to-project routing (intel types) */
  toProjectId?: string;
  /**
   * Canonical cmos://<owner>/<slug> address of the sender. Sent to the dashboard in addition to
   * senderProjectId so the relay can attribute messages even if its auto-resolve path falls back
   * to a sibling project (Sprint 52 m02). Omitted when the local project_identity cmos_address
   * is empty or still in the legacy cmos://unknown/* form.
   */
  senderAddress?: string;
}

function canonicalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function expectedSlugMismatchError(
  operation: string,
  expectedSlug: string,
  actualSlug: string
): CmosToolResult<never> {
  return createError({
    code: 'EXPECTED_SLUG_MISMATCH',
    message: `Refusing ${operation}: expected slug '${expectedSlug}' but resolved '${actualSlug}'.`,
    suggestion:
      'Verify the call is targeting the intended project and pass the canonical slug from the trusted local project context.',
  });
}

export interface ListMessagesParams {
  tab?: 'inbox' | 'sent';
  status?: string;
  limit?: number;
  /** s84-m02: SQL-side pagination offset (dashboard m05). Omitted → dashboard defaults to 0. */
  offset?: number;
}

export interface ListMessagesResult {
  messages: DashboardMessage[];
  unreadCount: number;
  totalCount: number;
  /** s84-m02: page size the dashboard actually returned (dashboard m05). Absent on a
   *  pre-cutover dashboard that does not echo it — callers treat absence as unknown. */
  returnedCount?: number;
}

export interface RespondToMessageParams {
  messageId: string;
  status: 'accepted' | 'declined' | 'replied';
  notes?: string;
}

export interface AckMessageParams {
  messageId: string;
}

/** Dashboard /ack response shape (Sprint 72 m04, migration 031). Terminal pending→acknowledged. */
export interface AckMessageResult {
  messageId: string;
  previousStatus: string;
  status: string;
  ackedAt: string;
}

export interface ResolveAddressParams {
  address: string;
}

export interface ResolveAddressResult {
  resolved: boolean;
  projectName?: string;
  agentId?: string;
}

/** A project entry from the dashboard directory. */
export interface DirectoryProject {
  id: string;
  name: string;
  address: string;
  owner: string;
  description?: string;
  slug?: string;
  isOwner?: boolean;
}

export interface ListDirectoryResult {
  projects: DirectoryProject[];
  totalCount: number;
}

export interface GetMyProjectsResult {
  projects: DirectoryProject[];
  totalCount: number;
}

type RawDirectoryProject = Partial<DirectoryProject> & {
  cmosAddress?: string;
};

function pickNewestUserScopedKey(
  keys: Record<string, UserScopedKeyRecord>
): { keyId: string; record: UserScopedKeyRecord } | undefined {
  const entries = Object.entries(keys);
  if (entries.length === 0) return undefined;
  const best = entries.reduce((a, b) => ((b[1].issuedAt ?? '') > (a[1].issuedAt ?? '') ? b : a));
  return { keyId: best[0], record: best[1] };
}

function parseOwnerFromAddress(address: string | undefined): string | undefined {
  if (!address || !address.startsWith('cmos://')) {
    return undefined;
  }

  const body = address.slice('cmos://'.length);
  const [owner] = body.split('/');
  return owner && owner.trim().length > 0 ? owner.trim() : undefined;
}

function normalizeDirectoryProject(project: RawDirectoryProject): DirectoryProject {
  const address = project.address ?? project.cmosAddress ?? '';
  const owner = project.owner ?? parseOwnerFromAddress(address) ?? 'unknown';

  return {
    id: project.id ?? '',
    name: project.name ?? '',
    address,
    owner,
    ...(project.description ? { description: project.description } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
    ...(project.isOwner !== undefined ? { isOwner: project.isOwner } : {}),
  };
}

function normalizeProjectListResult<
  T extends { projects?: RawDirectoryProject[]; totalCount?: number },
>(data: T): { projects: DirectoryProject[]; totalCount: number } {
  const projects = (data.projects ?? []).map((project) => normalizeDirectoryProject(project));
  return {
    projects,
    totalCount: data.totalCount ?? projects.length,
  };
}

/** Row count for a single PG mirror table. */
export interface SyncStatusTableCount {
  table: string;
  count: number;
}

/** Response from GET /api/sync/status — reconciliation data. */
export interface SyncStatusResult {
  tables: SyncStatusTableCount[];
  totalMirrorRows: number;
  totalSyncLogEntries: number;
  unprocessedSyncLogEntries: number;
  failedSyncLogEntries: number;
  lastSyncAt: string | null;
  oldestUnprocessedAt: string | null;
  projectCount: number;
}

/** Result from POST /api/projects/register — project registration. */
export interface RegisterProjectResult {
  slug: string;
  projectId: string;
  reregistered: boolean;
  backfill: { counts: Record<string, number> };
  /**
   * Auto-issued project-scoped key — present on first-time registration only.
   * Sprint 57 m02: dashboard returns the plaintext key exactly once here so
   * the MCP client can capture it into the local credential store. Absent on
   * idempotent re-registrations (see `keyRotated`).
   */
  key?: string;
  /** Dashboard-side UUID of the auto-issued key — pairs with `key`. */
  keyId?: string;
  /** Human-readable label (dashboard-generated from the register User-Agent). */
  label?: string;
  /**
   * Set to `false` by the dashboard on idempotent re-registration to signal
   * "project already exists for this user-scoped credential — no new key minted."
   * Undefined (absent) on first-time register.
   */
  keyRotated?: boolean;
}

/** Result from POST /api/projects/:id/keys/reissue — lost-key recovery. */
export interface ReissueProjectKeyResult {
  key: string;
  keyId: string;
  label: string;
  /** Dashboard-side keyIds that were revoked as part of this reissue. */
  revokedKeyIds: string[];
}

/** Result from POST /api/projects/:id/keys/rotate — atomic mint-new + schedule-revoke-old. */
export interface RotateProjectKeyResult {
  newKey: string;
  newKeyId: string;
  oldKeyId: string;
  /** ISO timestamp when the old key becomes invalid on the dashboard side. */
  revokeAt: string;
  /** Optional dashboard-assigned label for the new key. */
  label?: string;
}

/**
 * Result from POST /api/projects/:id/keys/revoke/:keyId (legacy project-scoped
 * endpoint) AND from POST /api/keys/:keyId/revoke (Sprint 59 m02 / dashboard
 * s34-m03 scope-aware unified endpoint). Both endpoints share the same
 * response envelope for parser-reuse — only the URL differs. Scope is inferred
 * server-side; the MCP caller determines local cleanup scope from its own
 * credential store lookup prior to calling revoke (since scope is not echoed
 * back).
 */
export interface RevokeKeyResult {
  keyId: string;
  revokedAt: string;
}

/** A single row from GET /api/keys. */
export interface ListedKey {
  id: string;
  projectId: string | null;
  projectSlug: string | null;
  parentKeyId: string | null;
  label: string | null;
  issuedVia: 'device_code' | 'registration_auto' | 'manual_generate' | string;
  lastUsedAt: string | null;
  revokeAt: string | null;
  createdAt: string;
}

/** Envelope returned by GET /api/keys. */
export interface ListKeysResult {
  keys: ListedKey[];
}

/** Result from POST /api/sync/sqlite-backfill — bulk file-based sync. */
export interface SyncSqliteFileResult {
  success: boolean;
  counts: Record<string, number>;
  errors: string[];
  durationMs: number;
}

/** Result from POST /api/sync/purge — purge confirmation. */
export interface PurgeMirrorResult {
  purgedProject: string;
  tablesCleared: string[];
  rowsDeleted: number;
}

/**
 * A single event from GET /api/sync/projects/:slug/events (Sprint 71 m02 PULL).
 * Mirrors the broker's MirrorSyncEvent shape.
 */
export interface PulledSyncEvent {
  /** cmos_sync_log.id — the broker-assigned monotonic pull cursor for this event. */
  cursor: number;
  eventType: string;
  /**
   * The stored event envelope, verbatim: { projectId, projectName, eventType,
   * timestamp, data, senderUserId }. Genesis provenance rides inside `data`
   * (camelCase, from the s71-m01/m02 emitter) — the dashboard stores and echoes
   * `data` unmodified, so whatever was pushed round-trips here.
   */
  payload: unknown;
  receivedAt: string;
  processed: boolean;
  error: string | null;
}

/** Response from GET /api/sync/projects/:slug/events?since=<cursor>. */
export interface PullEventsResult {
  events: PulledSyncEvent[];
  /** Cursor to pass as ?since= on the next pull — the last event's cursor, or the
   *  input `since` unchanged when the page is empty. */
  nextCursor: number;
  hasMore: boolean;
  returnedCount: number;
}

/**
 * A mutable-surface LWW conflict recorded by the broker (Sprint 71 m04). Mirrors
 * the dashboard's `ProjectConflict` plus the `youWereSuperseded` flag the push
 * response adds for the pushing client. `appliedValue` is the LWW winner;
 * `supersededValue` is the loser the superseded author can restore.
 */
export interface MutableConflict {
  id: string;
  fieldScope: string;
  entityId: string;
  field: string;
  appliedValue: string | null;
  appliedAuthorUserId: string | null;
  appliedOccurredAt: number | null;
  supersededValue: string | null;
  supersededAuthorUserId: string | null;
  supersededOccurredAt: number | null;
  detectedAt: string;
  resolved: boolean;
  /** True for the client whose pushed edit was the LWW loser. */
  youWereSuperseded: boolean;
}

/**
 * Response from POST /api/sync/events for a mutable-surface edit (Sprint 71 m04).
 * The broker returns `conflict` at the TOP level (NOT under `data`), so the
 * `request()` unwrapper passes the whole `{success, conflict?}` through.
 */
export interface MutablePushResult {
  success: boolean;
  conflict?: MutableConflict;
}

/** Advisory soft-lock field scopes (mirrors the dashboard's LockFieldScope). */
export type LockFieldScope = 'project_identity' | 'mission_active' | 'sprint_status';

/** A soft-lock row from the dashboard locks API (Sprint 71 m05). 30-min TTL. */
export interface ProjectLock {
  fieldScope: string;
  holderUserId: string;
  holderDisplayName: string | null;
  holderEmail: string;
  acquiredAt: string;
  expiresAt: string;
  /** DB-clock evaluation: expiresAt < NOW(). An expired lock is takeover-eligible. */
  expired: boolean;
}

/**
 * Outcome of acquire/takeover. `ok` true → we now hold the lock. On contention the
 * acquire route returns 409 with the holder + `reason` ('held' = active, another
 * member holds it; 'expired' = takeover-eligible); takeover returns 409 with no
 * reason when the lock is still active.
 */
export type LockResult =
  | { ok: true; lock: ProjectLock }
  | { ok: false; lock: ProjectLock | null; reason: 'held' | 'expired' | 'active' };

/**
 * Genesis provenance carried on each /state entity row (Sprint 71 m03; dashboard
 * ASK 2). occurredAt/originSeq are BIGINT carried VERBATIM as STRINGS (raw ms-epoch
 * / per-client counter, no Number/Date coercion on the wire); schemaVersion is a
 * number. All NULL in single-user mode today; populated once a shared push carries
 * them. The clone preserves them verbatim (never re-stamps).
 */
export interface SyncStateProvenance {
  stableEventId: string | null;
  occurredAt: string | null;
  originSeq: string | null;
  schemaVersion: number | null;
}

export interface SyncStateSprint extends SyncStateProvenance {
  id: string;
  title: string | null;
  status: string | null;
  focus: string | null;
  totalMissions: number | null;
  completedMissions: number | null;
  syncedAt: string;
}

export interface SyncStateMission extends SyncStateProvenance {
  id: string;
  sprintId: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  startedAt: string | null;
  completedAt: string | null;
  syncedAt: string;
}

export interface SyncStateSession extends SyncStateProvenance {
  id: string;
  type: string | null;
  title: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  syncedAt: string;
}

export interface SyncStateDecision extends SyncStateProvenance {
  id: number;
  decisionText: string | null;
  category: string | null;
  sprintId: string | null;
  sessionId: string | null;
  missionId: string | null;
  createdAt: string | null;
  syncedAt: string;
}

export interface SyncStateLearning extends SyncStateProvenance {
  id: number;
  content: string | null;
  category: string | null;
  sprintId: string | null;
  createdAt: string | null;
  syncedAt: string;
}

export interface SyncStateDependency {
  fromId: string;
  toId: string;
  type: string;
  syncedAt: string;
}

export interface SyncStateContext {
  id: string;
  updatedAt: string | null;
  syncedAt: string;
}

export interface SyncStateMetadataEntry {
  key: string;
  value: string;
  syncedAt: string;
}

/** Per-project sync-log counters + high-water cursor (Sprint 71 m03; dashboard ASK 1). */
export interface SyncStateSyncLog {
  totalEntries: number;
  processedEntries: number;
  failedEntries: number;
  /** COALESCE(MAX(cmos_sync_log.id), 0) — seed the PULL cursor here, then tail-pull. */
  maxCursor: number;
}

/**
 * Per-project sync state from GET /api/sync/projects/:slug/state. Returns the
 * CURRENT mutable state of every entity (the clone source — an event replay can't
 * reconstruct current status). `contexts`/`metadata`/`syncLog` are optional so a
 * pre-deploy dashboard (without the m03 additions) still parses; the clone degrades
 * gracefully (cursor falls back to 0 with a warning).
 */
export interface SyncProjectStateResult {
  project: {
    id: string;
    slug: string;
    name: string;
    schemaVersion: string | null;
    createdAt: string;
    updatedAt: string;
  };
  sprints: SyncStateSprint[];
  missions: SyncStateMission[];
  sessions: SyncStateSession[];
  decisions: SyncStateDecision[];
  learnings: SyncStateLearning[];
  dependencies: SyncStateDependency[];
  contexts?: SyncStateContext[];
  metadata?: SyncStateMetadataEntry[];
  syncLog?: SyncStateSyncLog;
}

// ─── DashboardClient ─────────────────────────────────────────────────────────

/**
 * HTTP client for the cmos-dashboard REST API.
 *
 * Authenticates with user credentials via /api/auth/login,
 * caches the JWT, and re-authenticates when expired.
 * All methods return CmosToolResult for consistent error handling.
 */
export class DashboardClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly authMethod: 'apiKey' | 'jwt';

  /** Cached auth token */
  private cachedToken: string | null = null;
  /** Token expiry time (ms since epoch) */
  private tokenExpiresAt: number = 0;
  /** Cached user identity from last login */
  private cachedIdentity: DashboardUserIdentity | null = null;
  /**
   * Dashboard-side keyId of the user-scoped credential authenticating this client,
   * when known. Set by `fromEnvForProject()` whenever it picks a user-scoped key
   * out of the credential store. Used by `registerProject()` to stamp `parentKeyId`
   * on the auto-issued project-scoped key captured into the local store.
   */
  private _authenticatingKeyId: string | undefined;
  /** Buffer before expiry to trigger re-auth (30 seconds) */
  private static readonly EXPIRY_BUFFER_MS = 30_000;

  constructor(config: DashboardClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;

    if (config.apiKey) {
      this.authMethod = 'apiKey';
      this.cachedToken = config.apiKey;
      this.tokenExpiresAt = Infinity;
      this.email = '';
      this.password = '';
    } else {
      this.authMethod = 'jwt';
      this.email = config.email ?? '';
      this.password = config.password ?? '';
    }
  }

  /**
   * Create a DashboardClient from environment variables.
   * Returns an error result if not configured.
   */
  static fromEnv(overrides?: Partial<DashboardClientConfig>): CmosToolResult<DashboardClient> {
    const baseUrl = resolveDashboardBaseUrl(overrides?.baseUrl);
    const apiKey = overrides?.apiKey ?? process.env[CMOS_DASHBOARD_API_KEY_ENV];

    // API key auth takes precedence over email/password
    if (apiKey) {
      return createSuccess(
        new DashboardClient({
          baseUrl,
          apiKey,
          timeoutMs: overrides?.timeoutMs,
        })
      );
    }

    // Fallback to email/password auth
    const email = overrides?.email ?? process.env[CMOS_DASHBOARD_USER_ENV];
    const password = overrides?.password ?? process.env[CMOS_DASHBOARD_PASSWORD_ENV];

    if (!email || !password) {
      return createError(CmosErrors.dashboardNotConfigured());
    }

    return createSuccess(
      new DashboardClient({
        baseUrl,
        email,
        password,
        timeoutMs: overrides?.timeoutMs,
      })
    );
  }

  /**
   * Create a DashboardClient using the local CredentialStore minted by the
   * Sprint 57 device code flow.
   *
   * Resolution order:
   *   1. Explicit `apiKey` override (tests / callers bypassing the store).
   *   2. Project-scoped key in CredentialStore for `projectRoot` (set by m02
   *      auto-issue capture on `POST /api/projects/register`).
   *   3. Newest user-scoped key in CredentialStore (minted by device code
   *      flow; used before a project-scoped key has been issued for this root).
   *   4. Legacy `CMOS_DASHBOARD_API_KEY` env var — carried forward so users
   *      who configured the env var directly before device code landed keep
   *      working.
   *   5. Email/password env vars — terminal fallback.
   *
   * `keySource` surfaces which arm fired so the eventual whoami + onboard
   * surface (m04) can show identitySource to the agent.
   */
  static async fromEnvForProject(
    projectRoot: string | undefined,
    overrides?: Partial<DashboardClientConfig> & { credentialStore?: CredentialStore }
  ): Promise<
    CmosToolResult<{
      client: DashboardClient;
      keySource: KeySource;
      matchedProjectRoot: string | null;
    }>
  > {
    const baseUrl = resolveDashboardBaseUrl(overrides?.baseUrl);

    const buildConfig = (apiKey: string): DashboardClientConfig => ({
      baseUrl,
      apiKey,
      ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    });

    // (1) Explicit override.
    if (overrides?.apiKey) {
      return createSuccess({
        client: new DashboardClient(buildConfig(overrides.apiKey)),
        keySource: 'user-scoped' as KeySource,
        matchedProjectRoot: null,
      });
    }

    const store = overrides?.credentialStore ?? (await CredentialStore.create());

    // (2) Project-scoped key in the credential store.
    if (projectRoot) {
      const projectKey = await store.getProjectKey(projectRoot);
      if (projectKey) {
        return createSuccess({
          client: new DashboardClient(buildConfig(projectKey.key)),
          keySource: 'project-scoped' as KeySource,
          matchedProjectRoot: path.resolve(projectRoot),
        });
      }
    }

    // (3) Newest user-scoped key in the credential store.
    const userScopedKeys = await store.listUserScopedKeys();
    const pick = pickNewestUserScopedKey(userScopedKeys);
    if (pick) {
      const client = new DashboardClient(buildConfig(pick.record.key));
      client.setAuthenticatingKeyId(pick.keyId);
      return createSuccess({
        client,
        keySource: 'user-scoped' as KeySource,
        matchedProjectRoot: null,
      });
    }

    // (4) Legacy env-var user-scoped key.
    const envKey = process.env[CMOS_DASHBOARD_API_KEY_ENV];
    if (envKey) {
      warnLegacyAuth('legacy-env');
      return createSuccess({
        client: new DashboardClient(buildConfig(envKey)),
        keySource: 'legacy-env' as KeySource,
        matchedProjectRoot: null,
      });
    }

    // (5) Email/password terminal fallback.
    const email = overrides?.email ?? process.env[CMOS_DASHBOARD_USER_ENV];
    const password = overrides?.password ?? process.env[CMOS_DASHBOARD_PASSWORD_ENV];
    if (!email || !password) {
      return createError(CmosErrors.dashboardNotConfigured());
    }

    warnLegacyAuth('password-fallback');
    return createSuccess({
      client: new DashboardClient({
        baseUrl,
        email,
        password,
        ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      }),
      keySource: 'password-fallback' as KeySource,
      matchedProjectRoot: null,
    });
  }

  /**
   * Authenticate with the dashboard and cache the token.
   */
  private async authenticate(): Promise<CmosToolResult<string>> {
    const url = `${this.baseUrl}/api/auth/login`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email: this.email, password: this.password }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        return createError(CmosErrors.dashboardAuthFailed(this.baseUrl));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        return createError(
          CmosErrors.dashboardError(`Login failed: HTTP ${response.status}: ${text}`)
        );
      }

      const loginResponse = (await response.json()) as LoginResponse;
      this.cachedToken = loginResponse.data.token;
      this.tokenExpiresAt = new Date(loginResponse.data.expiresAt).getTime();
      this.cachedIdentity = {
        userId: loginResponse.data.user.id,
        email: loginResponse.data.user.email,
        username: loginResponse.data.user.username ?? null,
      };

      return createSuccess(this.cachedToken);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            CmosErrors.dashboardUnreachable(
              this.baseUrl,
              `Login timed out after ${this.timeoutMs}ms`
            )
          );
        }
        return createError(CmosErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(CmosErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  /**
   * Get a valid auth token, re-authenticating if needed.
   */
  private async getAuthToken(): Promise<CmosToolResult<string>> {
    // API keys are permanent — no expiry check, no login needed
    if (this.authMethod === 'apiKey') {
      return createSuccess(this.cachedToken!);
    }
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt - DashboardClient.EXPIRY_BUFFER_MS) {
      return createSuccess(this.cachedToken);
    }
    return this.authenticate();
  }

  /**
   * s84-m02 — parse the dashboard's unified error envelope `{ error, hint }`
   * (dashboard m04) from a 4xx JSON body, best-effort. Returns `{}` when the body
   * is not JSON or carries neither field, so callers fall back to a generic message.
   * Reads the response body via `.json()`; pass a `.clone()` if the caller also
   * needs to read the body as text afterward.
   */
  private static async parseErrorEnvelope(
    response: Response
  ): Promise<{ detail?: string; hint?: string }> {
    const errorBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const detail = errorBody?.error ? String(errorBody.error) : undefined;
    const hint = errorBody?.hint ? String(errorBody.hint) : undefined;
    return { ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) };
  }

  /**
   * Make an authenticated HTTP request to the dashboard.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<CmosToolResult<T>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }

    const url = `${this.baseUrl}${path}`;
    const token = tokenResult.data!;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401) {
        // 401 = token expired/invalid server-side — clear the cache so the next call
        // re-authenticates (jwt clients re-login; apiKey clients surface the failure).
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        return createError(CmosErrors.dashboardAuthFailed(this.baseUrl));
      }

      if (response.status === 403) {
        // s84-m02: a 403 is an AUTHZ denial, NOT token expiry — do NOT clear the cached
        // token. Clearing poisoned apiKey auth (an apiKey client has no re-login path, so
        // the very next call sent `Bearer null`) and mislabeled a genuine forbidden — e.g.
        // ack/respond "not the recipient", or an owner-gated route that returns 403 (not
        // 404) after the dashboard m04 cutover — as an authentication failure. Parse the
        // unified {error,hint} envelope the same way the 404 branch does.
        const { detail, hint } = await DashboardClient.parseErrorEnvelope(response);
        return createError(CmosErrors.dashboardForbidden(path, detail, hint));
      }

      if (response.status === 402) {
        const text = await response.text().catch(() => '');
        return createError(CmosErrors.dashboardUpgradeRequired(text || undefined));
      }

      if (response.status === 404) {
        const { detail, hint } = await DashboardClient.parseErrorEnvelope(response);
        return createError(CmosErrors.dashboardNotFound(path, detail, hint));
      }

      if (response.status >= 500) {
        const text = await response.text().catch(() => 'Unknown server error');
        return createError(CmosErrors.dashboardError(`Server error ${response.status}: ${text}`));
      }

      if (!response.ok) {
        // Unified error envelope (dashboard m04): prefer the {error,hint} fields when the
        // body carries them, else fall back to the raw text. Clone so a non-JSON body can
        // still be read as text after the JSON parse attempt.
        const { detail, hint } = await DashboardClient.parseErrorEnvelope(response.clone());
        if (detail) {
          return createError(CmosErrors.dashboardError(hint ? `${detail} (${hint})` : detail));
        }
        const text = await response.text().catch(() => 'Unknown error');
        return createError(CmosErrors.dashboardError(`HTTP ${response.status}: ${text}`));
      }

      const json = (await response.json()) as Record<string, unknown>;
      // Dashboard API wraps responses in {success, data} envelope — unwrap it
      const data = (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
      return createSuccess(data);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            CmosErrors.dashboardUnreachable(
              this.baseUrl,
              `Request timed out after ${this.timeoutMs}ms`
            )
          );
        }
        return createError(CmosErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(CmosErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  // ─── Public API Methods ──────────────────────────────────────────────────

  /**
   * Get the cached user identity from the last login.
   * Returns null if not yet authenticated.
   */
  get userIdentity(): DashboardUserIdentity | null {
    return this.cachedIdentity;
  }

  /**
   * `keyId` of the user-scoped credential that authenticated this client, if known.
   * Sprint 57 m02 — populated by `fromEnvForProject()` when a user-scoped key is
   * picked from the credential store. Callers capturing the auto-issued register
   * response stamp this into `parentKeyId` on the resulting project-scoped record.
   */
  get authenticatingKeyId(): string | undefined {
    return this._authenticatingKeyId;
  }

  /** Internal setter used by the factories when they know the keyId. */
  setAuthenticatingKeyId(keyId: string | undefined): void {
    this._authenticatingKeyId = keyId;
  }

  /**
   * Send a message to a target address.
   */
  async sendMessage(params: SendMessageParams): Promise<CmosToolResult<DashboardMessage>> {
    const body: Record<string, unknown> = {
      targetAddress: params.targetAddress,
      type: params.type,
      summary: params.summary,
      body: params.body,
      evidence: params.evidence,
    };
    if (params.senderProjectId) {
      body.senderProjectId = params.senderProjectId;
    }
    if (params.fromProjectId) {
      body.fromProjectId = params.fromProjectId;
    }
    if (params.toProjectId) {
      body.toProjectId = params.toProjectId;
    }
    if (params.senderAddress) {
      body.senderAddress = params.senderAddress;
    }
    const result = await this.request<DashboardMessage>('POST', '/api/messages', body);

    if (
      result.success &&
      result.data &&
      params.senderAddress &&
      result.data.senderAddress &&
      result.data.senderAddress !== params.senderAddress
    ) {
      console.warn(
        `[dashboard-client] senderAddress echo mismatch: sent ${params.senderAddress}, dashboard echoed ${result.data.senderAddress}`
      );
    }

    // Sprint 57 m04: capture the dashboard's identitySource ACK so whoami +
    // onboard can surface "still on legacy user-scoped key" as a warning.
    if (result.success && result.data?.deliveryAck?.identitySource) {
      // Lazy import to keep the dashboard-client free of upstream auth coupling
      // and to avoid a require cycle with src/auth.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { recordDeliveryAck } = require('../../auth/delivery-ack-cache') as {
        recordDeliveryAck: (s: 'api-key' | 'request-body' | 'none') => void;
      };
      recordDeliveryAck(result.data.deliveryAck.identitySource);
    }

    return result;
  }

  /**
   * List messages (inbox or sent).
   */
  async listMessages(params?: ListMessagesParams): Promise<CmosToolResult<ListMessagesResult>> {
    const query = new URLSearchParams();
    if (params?.tab) query.set('tab', params.tab);
    if (params?.status) query.set('status', params.status);
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    // s84-m02: only send offset when provided so omitting it reproduces the exact
    // pre-cutover call args (dashboard defaults offset to 0 server-side).
    if (params?.offset !== undefined) query.set('offset', String(params.offset));

    const queryString = query.toString();
    const path = `/api/messages${queryString ? `?${queryString}` : ''}`;

    return this.request<ListMessagesResult>('GET', path);
  }

  /**
   * s84-m02 — fetch a single message by id (dashboard m01: GET /api/messages/:id).
   * Authorized read-one returning the same slug/name fields as the list rows, with no
   * read/ack side-effect (safe to poll). The dashboard 404s a non-UUID id or a message
   * the caller cannot see; the shared request() maps that to DASHBOARD_NOT_FOUND, which
   * cmos_message.handleGet() catches to fall back to the pre-deploy paging scan.
   */
  async getMessageById(id: string): Promise<CmosToolResult<DashboardMessage>> {
    return this.request<DashboardMessage>('GET', `/api/messages/${encodeURIComponent(id)}`);
  }

  /**
   * Respond to a message (accept, decline, or reply).
   */
  async respondToMessage(
    params: RespondToMessageParams
  ): Promise<CmosToolResult<DashboardMessage>> {
    return this.request<DashboardMessage>('POST', `/api/messages/${params.messageId}/respond`, {
      status: params.status,
      notes: params.notes,
    });
  }

  /**
   * Acknowledge (mark-read) a pending message (Sprint 72 m04). Status-only round-trip to
   * the dashboard's `POST /api/messages/:id/ack` (migration 031). Terminal pending →
   * 'acknowledged' — NOT a response (responded_at stays NULL; read_at is stamped). 409 if
   * the message is not pending; 403 if the caller is not the recipient.
   */
  async ackMessage(params: AckMessageParams): Promise<CmosToolResult<AckMessageResult>> {
    return this.request<AckMessageResult>('POST', `/api/messages/${params.messageId}/ack`);
  }

  /**
   * Resolve a cmos:// address to verify it exists.
   */
  async resolveAddress(
    params: ResolveAddressParams
  ): Promise<CmosToolResult<ResolveAddressResult>> {
    return this.request<ResolveAddressResult>(
      'GET',
      `/api/messages/resolve?address=${encodeURIComponent(params.address)}`
    );
  }

  /**
   * List all addressable projects in the dashboard directory.
   */
  async listDirectory(): Promise<CmosToolResult<ListDirectoryResult>> {
    const result = await this.request<ListDirectoryResult>('GET', '/api/projects/directory/public');
    if (!result.success || !result.data) {
      return result;
    }
    return createSuccess(normalizeProjectListResult(result.data));
  }

  /**
   * Get projects owned by the authenticated user.
   */
  async getMyProjects(): Promise<CmosToolResult<GetMyProjectsResult>> {
    const result = await this.request<GetMyProjectsResult>('GET', '/api/projects/me');
    if (!result.success || !result.data) {
      return result;
    }
    return createSuccess(normalizeProjectListResult(result.data));
  }

  /**
   * Push a sync event to the dashboard.
   * Used by checkpoint backfill.
   */
  async pushSyncEvent(envelope: Record<string, unknown>): Promise<CmosToolResult<void>> {
    return this.request<void>('POST', '/api/sync/events', envelope);
  }

  /**
   * Push a mutable-surface edit (e.g. `mission_updated`) to POST /api/sync/events
   * and return the broker's inline LWW outcome (Sprint 71 m04). Unlike
   * `pushSyncEvent` (fire-and-forget for the append-only bulk), the mutable path
   * needs the response's top-level `conflict` — `request()` returns the whole
   * `{success, conflict?}` body because there is no `data` envelope on this route.
   * The editor authenticates with their OWN credential (resolved upstream via
   * `fromEnvForProject`); `author_user_id` is stamped dashboard-authoritative.
   */
  async pushMutableEvent(
    envelope: Record<string, unknown>
  ): Promise<CmosToolResult<MutablePushResult>> {
    return this.request<MutablePushResult>('POST', '/api/sync/events', envelope);
  }

  /**
   * Like `request`, but returns the HTTP status alongside the parsed envelope and
   * does NOT special-case 401/403/404/409 (Sprint 71 m05). The lock + conflict
   * endpoints need the body of a 4xx (a 409 acquire carries the holder; a 403 is a
   * real authz denial, not token expiry), so this variant surfaces every HTTP
   * response and only errors on a transport/timeout failure. Parses JSON best-effort.
   */
  private async requestWithStatus<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<CmosToolResult<{ status: number; body: T | null }>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${tokenResult.data!}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const parsed = (await response.json().catch(() => null)) as T | null;
      return createSuccess({ status: response.status, body: parsed });
    } catch (error: unknown) {
      clearTimeout(timeout);
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? `Request timed out after ${this.timeoutMs}ms`
            : error.message
          : 'Unknown network error';
      return createError(CmosErrors.dashboardUnreachable(this.baseUrl, message));
    }
  }

  /**
   * Query a project's advisory soft-locks (Sprint 71 m05). Any member may read them.
   * `platformProjectId` is the platform `projects.id` (resolve via getMyProjects by
   * slug — NOT the cmos_projects.id that /state returns).
   */
  async queryLocks(platformProjectId: string): Promise<CmosToolResult<{ locks: ProjectLock[] }>> {
    const r = await this.requestWithStatus<{ data?: { locks?: ProjectLock[] } }>(
      'GET',
      `/api/projects/${encodeURIComponent(platformProjectId)}/locks`
    );
    if (!r.success || !r.data)
      return createError(r.error ?? CmosErrors.dashboardError('Lock query failed'));
    if (r.data.status !== 200) {
      return createError(CmosErrors.dashboardError(`Lock query HTTP ${r.data.status}`));
    }
    return createSuccess({ locks: r.data.body?.data?.locks ?? [] });
  }

  /**
   * Acquire a soft-lock on a field scope (Sprint 71 m05). 200 → we hold it; 409 →
   * another member holds it, with `reason` ('held' = active, 'expired' = takeover-
   * eligible) and the holder for surfacing. Writers only (a 403 surfaces as an error).
   */
  async acquireLock(
    platformProjectId: string,
    fieldScope: LockFieldScope
  ): Promise<CmosToolResult<LockResult>> {
    const r = await this.requestWithStatus<{
      data?: { lock?: ProjectLock; reason?: 'held' | 'expired' };
    }>('POST', `/api/projects/${encodeURIComponent(platformProjectId)}/locks`, { fieldScope });
    if (!r.success || !r.data)
      return createError(r.error ?? CmosErrors.dashboardError('Lock acquire failed'));
    if (r.data.status === 200 && r.data.body?.data?.lock) {
      return createSuccess<LockResult>({ ok: true, lock: r.data.body.data.lock });
    }
    if (r.data.status === 409) {
      return createSuccess<LockResult>({
        ok: false,
        lock: r.data.body?.data?.lock ?? null,
        reason: r.data.body?.data?.reason ?? 'held',
      });
    }
    return createError(CmosErrors.dashboardError(`Lock acquire HTTP ${r.data.status}`));
  }

  /**
   * Take over an EXPIRED lock and notify the prior holder (Sprint 71 m05). 200 → we
   * now hold it; 409 → the lock is still active and cannot be taken over.
   */
  async takeoverLock(
    platformProjectId: string,
    fieldScope: LockFieldScope
  ): Promise<CmosToolResult<LockResult>> {
    const r = await this.requestWithStatus<{ data?: { lock?: ProjectLock } }>(
      'POST',
      `/api/projects/${encodeURIComponent(platformProjectId)}/locks/${encodeURIComponent(
        fieldScope
      )}/takeover`
    );
    if (!r.success || !r.data)
      return createError(r.error ?? CmosErrors.dashboardError('Lock takeover failed'));
    if (r.data.status === 200 && r.data.body?.data?.lock) {
      return createSuccess<LockResult>({ ok: true, lock: r.data.body.data.lock });
    }
    if (r.data.status === 409) {
      return createSuccess<LockResult>({
        ok: false,
        lock: r.data.body?.data?.lock ?? null,
        reason: 'active',
      });
    }
    return createError(CmosErrors.dashboardError(`Lock takeover HTTP ${r.data.status}`));
  }

  /** Release a lock we hold (Sprint 71 m05). No-op server-side if we do not hold it. */
  async releaseLock(
    platformProjectId: string,
    fieldScope: LockFieldScope
  ): Promise<CmosToolResult<{ released: boolean }>> {
    const r = await this.requestWithStatus<{ data?: { released?: boolean } }>(
      'POST',
      `/api/projects/${encodeURIComponent(platformProjectId)}/locks/${encodeURIComponent(
        fieldScope
      )}/release`
    );
    if (!r.success || !r.data)
      return createError(r.error ?? CmosErrors.dashboardError('Lock release failed'));
    if (r.data.status !== 200) {
      return createError(CmosErrors.dashboardError(`Lock release HTTP ${r.data.status}`));
    }
    return createSuccess({ released: r.data.body?.data?.released ?? false });
  }

  /**
   * List a project's mutable-surface conflicts (Sprint 71 m05, deferred from m04).
   * `platformProjectId` is the platform `projects.id` (resolve via getMyProjects by
   * slug). Defaults to unresolved-only; pass `unresolvedOnly: false` for the full set.
   */
  async getProjectConflicts(
    platformProjectId: string,
    opts?: { unresolvedOnly?: boolean; entityId?: string }
  ): Promise<CmosToolResult<{ conflicts: MutableConflict[] }>> {
    const query = new URLSearchParams();
    if (opts?.unresolvedOnly === false) query.set('unresolvedOnly', 'false');
    if (opts?.entityId) query.set('entityId', opts.entityId);
    const qs = query.toString();
    return this.request<{ conflicts: MutableConflict[] }>(
      'GET',
      `/api/projects/${encodeURIComponent(platformProjectId)}/conflicts${qs ? `?${qs}` : ''}`
    );
  }

  /**
   * Restore a superseded mutable value — re-applies `superseded_value`, marks resolved
   * (Sprint 71 m05). Server-enforced: only the superseded author or the project owner
   * may restore. `platformProjectId` is the platform `projects.id`.
   */
  async restoreConflict(
    platformProjectId: string,
    conflictId: string
  ): Promise<CmosToolResult<{ conflict: MutableConflict }>> {
    return this.request<{ conflict: MutableConflict }>(
      'POST',
      `/api/projects/${encodeURIComponent(platformProjectId)}/conflicts/${encodeURIComponent(
        conflictId
      )}/restore`
    );
  }

  /**
   * Get sync reconciliation status from the dashboard.
   * Returns per-table row counts in the PG mirror.
   */
  async getSyncStatus(projectSlug?: string): Promise<CmosToolResult<SyncStatusResult>> {
    const query = projectSlug ? `?projectSlug=${encodeURIComponent(projectSlug)}` : '';
    return this.request<SyncStatusResult>('GET', `/api/sync/status${query}`);
  }

  /**
   * Get full project sync state from the dashboard.
   * Returns all synced entities for a specific project.
   */
  async getSyncProjectState(slug: string): Promise<CmosToolResult<SyncProjectStateResult>> {
    return this.request<SyncProjectStateResult>(
      'GET',
      `/api/sync/projects/${encodeURIComponent(slug)}/state`
    );
  }

  /**
   * Incremental PULL: fetch mirror events for a project with cursor > since,
   * ordered by cmos_sync_log.id ascending (Sprint 71 m02 — the missing half of
   * the sync loop). Membership-scoped server-side (owner or active share), so an
   * editor/collaborator can pull a shared project. Returns ONE bounded page; the
   * caller (sync-pull.ts) pages until hasMore=false. The cursor is independent of
   * the emitter's provenance columns, so it works even while those are NULL.
   */
  async getProjectEventsSince(
    slug: string,
    since: number,
    limit?: number
  ): Promise<CmosToolResult<PullEventsResult>> {
    const query = new URLSearchParams();
    query.set('since', String(since));
    if (limit !== undefined) {
      query.set('limit', String(limit));
    }
    return this.request<PullEventsResult>(
      'GET',
      `/api/sync/projects/${encodeURIComponent(slug)}/events?${query.toString()}`
    );
  }

  /**
   * Purge all mirrored data for a project from the PG mirror.
   * Used before re-backfill to ensure clean state.
   */
  async purgeMirror(
    projectSlug: string,
    expectedSlug?: string
  ): Promise<CmosToolResult<PurgeMirrorResult>> {
    if (expectedSlug && canonicalizeSlug(projectSlug) !== canonicalizeSlug(expectedSlug)) {
      return expectedSlugMismatchError(
        'mirror purge',
        canonicalizeSlug(expectedSlug),
        canonicalizeSlug(projectSlug)
      );
    }

    const result = await this.request<PurgeMirrorResult>('POST', '/api/sync/purge', {
      projectSlug,
      confirm: true,
    });

    // 404 means the project doesn't exist in PG yet — nothing to purge, treat as success
    if (!result.success && result.error?.code === 'DASHBOARD_NOT_FOUND') {
      return createSuccess<PurgeMirrorResult>({
        purgedProject: projectSlug,
        tablesCleared: [],
        rowsDeleted: 0,
      });
    }

    return result;
  }

  /**
   * Register a project with the dashboard by uploading the SQLite database.
   * Used for auto-registration on first checkpoint.
   *
   * Endpoint: POST /api/projects/register (multipart/form-data)
   * - 201: New registration
   * - 200: Re-registration (purges and re-backfills)
   */
  /**
   * POST the local SQLite file as multipart/form-data to /api/sync/sqlite-backfill.
   * This is the bulk reconciliation path — idempotent, returns per-entity counts.
   * Uses an extended timeout (60s minimum) to accommodate large file uploads.
   */
  async syncSqliteFile(
    filePath: string,
    projectSlug: string,
    expectedSlug?: string
  ): Promise<CmosToolResult<SyncSqliteFileResult>> {
    if (expectedSlug && canonicalizeSlug(projectSlug) !== canonicalizeSlug(expectedSlug)) {
      return expectedSlugMismatchError(
        'SQLite sync',
        canonicalizeSlug(expectedSlug),
        canonicalizeSlug(projectSlug)
      );
    }

    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }

    // Read the SQLite file
    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return createError(CmosErrors.dashboardError(`Failed to read SQLite file: ${msg}`));
    }

    // Build multipart form
    const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
    const formData = new FormData();
    formData.append('database', blob, 'cmos.sqlite');
    formData.append('projectSlug', projectSlug);

    const url = `${this.baseUrl}/api/sync/sqlite-backfill`;
    const token = tokenResult.data!;
    const controller = new AbortController();
    // Use longer timeout for file upload (60s minimum)
    const uploadTimeoutMs = Math.max(this.timeoutMs, 60_000);
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          // Content-Type is set automatically by fetch for FormData
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        return createError(CmosErrors.dashboardAuthFailed(this.baseUrl));
      }

      if (response.status === 402) {
        const text = await response.text().catch(() => '');
        return createError(CmosErrors.dashboardUpgradeRequired(text || undefined));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        return createError(
          CmosErrors.dashboardError(`SQLite backfill failed: HTTP ${response.status}: ${text}`)
        );
      }

      const json = (await response.json()) as Record<string, unknown>;
      const data = (
        json && typeof json === 'object' && 'data' in json ? json.data : json
      ) as SyncSqliteFileResult;
      return createSuccess(data);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            CmosErrors.dashboardUnreachable(
              this.baseUrl,
              `SQLite backfill timed out after ${uploadTimeoutMs}ms`
            )
          );
        }
        return createError(CmosErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(CmosErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  async registerProject(params: {
    projectName: string;
    sqlitePath: string;
    localDbPath?: string;
    expectedSlug?: string;
  }): Promise<CmosToolResult<RegisterProjectResult>> {
    const derivedSlug = canonicalizeSlug(params.projectName);
    if (params.expectedSlug && derivedSlug !== canonicalizeSlug(params.expectedSlug)) {
      return expectedSlugMismatchError(
        'project registration',
        canonicalizeSlug(params.expectedSlug),
        derivedSlug
      );
    }

    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }

    // Read the SQLite file
    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(params.sqlitePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return createError(CmosErrors.dashboardError(`Failed to read SQLite file: ${msg}`));
    }

    // Build multipart form
    const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
    const formData = new FormData();
    formData.append('database', blob, 'cmos.sqlite');
    formData.append('projectName', params.projectName);
    if (params.localDbPath) {
      formData.append('localDbPath', params.localDbPath);
    }

    const url = `${this.baseUrl}/api/projects/register`;
    const token = tokenResult.data!;
    const controller = new AbortController();
    // Use longer timeout for file upload (60s minimum)
    const uploadTimeoutMs = Math.max(this.timeoutMs, 60_000);
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          // Content-Type is set automatically by fetch for FormData
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        return createError(CmosErrors.dashboardAuthFailed(this.baseUrl));
      }

      if (response.status === 402) {
        const text = await response.text().catch(() => '');
        return createError(CmosErrors.dashboardUpgradeRequired(text || undefined));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        return createError(
          CmosErrors.dashboardError(`Registration failed: HTTP ${response.status}: ${text}`)
        );
      }

      const json = (await response.json()) as Record<string, unknown>;
      const data = (
        json && typeof json === 'object' && 'data' in json ? json.data : json
      ) as RegisterProjectResult;
      return createSuccess(data);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            CmosErrors.dashboardUnreachable(
              this.baseUrl,
              `Registration timed out after ${uploadTimeoutMs}ms`
            )
          );
        }
        return createError(CmosErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(CmosErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  /**
   * Reissue a project-scoped key after partial-failure recovery.
   *
   * POSTs `/api/projects/:id/keys/reissue` with user-scoped `cmk_...` Bearer
   * auth (same auth mode as `/rotate`, `/revoke`, `/register`, `/keys`).
   * Dashboard revokes all prior project-scoped keys bound to the caller's
   * `parent_key_id` for this project and mints a fresh one, returning the
   * plaintext exactly once in the response body. No grace window — reissue
   * implies the current key is lost or compromised.
   *
   * Originally landed in Sprint 57 m02. Sprint 58 m03 live verification
   * (2026-04-22) exposed that the dashboard endpoint was rejecting user-scoped
   * Bearer with HTTP 400 "Reissue requires a logged-in dashboard session".
   * Sprint 59 m01 + dashboard s34-m02 (2026-04-23) fixed the drift — removed
   * the api-key rejection at dashboard projects.ts:740 and added an ownership
   * check matching the existing revoke route. The MCP-side contract
   * (cmk_ Bearer + `{key, keyId, label, revokedKeyIds}` response) did not
   * change — only the dashboard-side acceptance did.
   */
  async reissueProjectKey(projectId: string): Promise<CmosToolResult<ReissueProjectKeyResult>> {
    if (!projectId) {
      return createError(CmosErrors.dashboardError('reissueProjectKey: projectId is required'));
    }
    return this.request<ReissueProjectKeyResult>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/keys/reissue`,
      {}
    );
  }

  /**
   * Rotate a project-scoped key with an optional grace window.
   *
   * Sprint 57 m03 — `POST /api/projects/:id/keys/rotate` mints a new project
   * key and schedules the old one for revocation in `graceSeconds` (default
   * 300 dashboard-side). Response fields: `newKey`, `newKeyId`, `oldKeyId`,
   * `revokeAt`. Local callers store the new key and hold the old one in
   * `pendingRevoke` so in-flight requests survive the grace window.
   */
  async rotateProjectKey(
    projectId: string,
    options: { graceSeconds?: number } = {}
  ): Promise<CmosToolResult<RotateProjectKeyResult>> {
    if (!projectId) {
      return createError(CmosErrors.dashboardError('rotateProjectKey: projectId is required'));
    }
    const body: Record<string, unknown> = {};
    if (options.graceSeconds !== undefined) {
      body.graceSeconds = options.graceSeconds;
    }
    return this.request<RotateProjectKeyResult>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/keys/rotate`,
      body
    );
  }

  /**
   * Scope-aware unified revoke.
   *
   * Sprint 59 m02 / dashboard s34-m03 — `POST /api/keys/:keyId/revoke`. Works
   * for both user-scoped (`projectId IS NULL`) and project-scoped rows; the
   * dashboard infers scope from the key row and enforces ownership:
   *   - user-scoped: requester's `userId` must equal the key row's `user_id`
   *   - project-scoped: requester must own the project (same check as
   *     `/api/projects/:id/keys/revoke/:keyId`)
   *
   * Response envelope `{keyId, revokedAt}` matches the legacy project-scoped
   * endpoint byte-for-byte — deliberate parser-reuse per dashboard team
   * message 335c3a34 (2026-04-23). The inferred scope is NOT echoed back;
   * callers determine it from their own credential store before invoking.
   *
   * No grace window — the key is invalid as soon as this returns. Use `rotate`
   * when a grace window is wanted instead.
   */
  async revokeKey(keyId: string): Promise<CmosToolResult<RevokeKeyResult>> {
    if (!keyId) {
      return createError(CmosErrors.dashboardError('revokeKey: keyId is required'));
    }
    return this.request<RevokeKeyResult>(
      'POST',
      `/api/keys/${encodeURIComponent(keyId)}/revoke`,
      {}
    );
  }

  /**
   * Hard-revoke a project-scoped key immediately via the legacy project-scoped endpoint.
   *
   * Sprint 57 m03 — `POST /api/projects/:id/keys/revoke/:keyId`. No grace
   * window; the key is invalid from the dashboard's perspective as soon as
   * this returns. Kept unchanged per dashboard team commitment — the
   * profile.ejs key-management UI calls this endpoint directly and existing
   * callers keep working. New callers should prefer `revokeKey(keyId)` (the
   * Sprint 59 m02 unified surface), which also handles user-scoped rows.
   */
  async revokeProjectKey(
    projectId: string,
    keyId: string
  ): Promise<CmosToolResult<RevokeKeyResult>> {
    if (!projectId || !keyId) {
      return createError(
        CmosErrors.dashboardError('revokeProjectKey: projectId and keyId are required')
      );
    }
    return this.request<RevokeKeyResult>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/keys/revoke/${encodeURIComponent(keyId)}`,
      {}
    );
  }

  /**
   * List every key the authenticated credential can see.
   *
   * Sprint 57 m03 — `GET /api/keys`. Response is the full credential tree
   * (user-scoped rows where `projectId === null` plus their spawned
   * project-scoped children via `parentKeyId`). Callers apply the "mine-only"
   * filter locally by matching `parentKeyId` against their own credential
   * store's `userScopedKeys`.
   */
  async listKeys(): Promise<CmosToolResult<ListKeysResult>> {
    return this.request<ListKeysResult>('GET', '/api/keys');
  }
}
