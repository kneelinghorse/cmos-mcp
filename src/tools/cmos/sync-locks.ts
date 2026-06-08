// ABOUTME: Sprint 71 m05 / 72 m01 — soft-lock control plane for the mutable surface:
// ABOUTME: resolve the platform project id, wrap the m04 push in acquire→push→release
// ABOUTME: (take-over-on-expired + respect-active-holder), all generic over fieldScope,
// ABOUTME: and the resilient dispatcher hook that propagates a mutable-surface edit on
// ABOUTME: a collab store (thin mission_active wrapper keeps the mission path frozen).

/**
 * Soft-lock orchestration (Sprint 71 m05, UC2 — see cmos/docs/multiuser-collab-client.md §6).
 *
 * m04 built the data plane (pull-before-push + per-field push + inbound LWW). m05 is
 * the control plane that wraps it:
 *
 *   - `resolvePlatformProjectId` — the lock + conflict routes key on the platform
 *     `projects.id` (what authorizeProjectAccess resolves), NOT the cmos_projects.id
 *     that GET /state returns. We resolve it once via getMyProjects() matched by slug
 *     and cache it in `metadata.platform_project_id`.
 *   - `pushMutableStatusUnderLock` — acquire the advisory `mission_active` soft-lock
 *     (take over an EXPIRED lock; respect — i.e. surface — an ACTIVE holder and push
 *     anyway, since the lock is advisory and the broker's LWW + restore is the real
 *     safety net), run the m04 push with the EDITOR's own credential, then release a
 *     lock we hold.
 *   - `maybePropagateMissionStatus` — the cmos_mission_transition hook. On a COLLAB
 *     store, after a successful transition, push the post-transition status to the
 *     broker. RESILIENT: a sync/lock/network failure never fails the local
 *     transition — it is folded into the result's warnings.
 *
 * The editor own-identity requirement (criterion 3) falls out of the existing
 * `fromEnvForProject` resolution: a shared project has no project-scoped key for the
 * editor, so it resolves to their user-scoped key — the same credential drives both
 * the lock calls and the push, and author_user_id is stamped dashboard-authoritative.
 *
 * @module tools/cmos/sync-locks
 */

import { withClientAsync, type CmosDatabaseClient } from './client';
import { DashboardClient, type ProjectLock } from './dashboard-client';
import { createSuccess, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import { readDashboardSlug } from './sync-merge';
import {
  isCollabStore,
  readStatusState,
  PROJECT_IDENTITY_ENTITY_ID,
  type MutableFieldScope,
} from './sync-mutable';
import { getProjectIdentity } from './project-identity';
import { pushMutableStatus, type PushMutableStatusResult } from './sync-mutable-push';

function readMeta(db: CmosDatabaseClient, key: string): string | null {
  const row = db.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return row.success && row.data?.value ? row.data.value : null;
}

function writeMeta(db: CmosDatabaseClient, key: string, value: string): void {
  db.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value]);
}

/** Slug-scoped cache key (matches the `pull_cursor:<slug>` convention), so a store
 *  re-pointed at a different dashboard project never returns a stale platform id. */
function platformProjectIdKey(slug: string): string {
  return `platform_project_id:${slug}`;
}

/**
 * Resolve the platform `projects.id` for the project's slug (Sprint 71 m05). Cached
 * in `metadata.platform_project_id:<slug>` after the first lookup. Returns null when
 * the slug can't be matched in getMyProjects() (e.g. not a member, or the dashboard is
 * unreachable) — the caller then proceeds lockless. NOT the cmos_projects.id that the
 * clone stores as dashboard_project_id (different namespace — the whole point).
 */
export async function resolvePlatformProjectId(
  db: CmosDatabaseClient,
  client: DashboardClient,
  slug: string
): Promise<string | null> {
  const cacheKey = platformProjectIdKey(slug);
  const cached = readMeta(db, cacheKey);
  if (cached) return cached;
  const mine = await client.getMyProjects();
  if (!mine.success || !mine.data) return null;
  const match = mine.data.projects.find((p) => p.slug === slug);
  if (!match || !match.id) return null;
  writeMeta(db, cacheKey, match.id);
  return match.id;
}

// ─── Lock-wrapped push ───────────────────────────────────────────────────────

export type LockState =
  | 'acquired' // we acquired a free lock
  | 'tookover' // an expired lock — we took it over
  | 'held-by-other' // an active lock another editor holds (we pushed anyway, advisory)
  | 'unavailable' // couldn't resolve the platform id / reach the lock API
  | 'skipped'; // not a collab store (no lock attempted)

export interface PushUnderLockResult {
  lockState: LockState;
  lockHolder: { userId: string; email: string; expiresAt: string } | null;
  released: boolean;
  /** The m04 push outcome, or null when the push itself errored. */
  push: PushMutableStatusResult | null;
  warnings: string[];
}

export interface PushUnderLockParams {
  projectRoot?: string;
  slug?: string;
  /** The mutable scope (Sprint 72 m01). Defaults to 'mission_active' (frozen path). */
  fieldScope?: MutableFieldScope;
  /** The entity whose mutable field changed. Defaults to `missionId` for the mission scope. */
  entityId?: string;
  /** Mission-path alias for `entityId` (the Sprint 71 m05 call shape). */
  missionId?: string;
  status: string;
  now?: number;
  client?: DashboardClient;
}

/**
 * Acquire the advisory `mission_active` soft-lock, run the m04 push with the editor's
 * own credential, then release a lock we hold. The lock is advisory: an ACTIVE
 * holder is surfaced (not blocking) and the push still proceeds, because the broker's
 * LWW + the conflict/restore surface is the real safety net (dashboard Q3). An
 * EXPIRED lock is taken over. The push runs regardless of lock state — a lock failure
 * never blocks propagation.
 */
export async function pushMutableStatusUnderLock(
  params: PushUnderLockParams
): Promise<CmosToolResult<PushUnderLockResult>> {
  // Resolve scope + entity (Sprint 72 m01). Defaults preserve the frozen mission path.
  const fieldScope: MutableFieldScope = params.fieldScope ?? 'mission_active';
  const entityId = params.entityId ?? params.missionId;

  let client = params.client;
  if (!client) {
    const cr = await DashboardClient.fromEnvForProject(params.projectRoot);
    if (!cr.success || !cr.data)
      return { success: false, error: CmosErrors.dashboardNotConfigured() };
    client = cr.data.client;
  }

  const warnings: string[] = [];
  let lockState: LockState = 'unavailable';
  let lockHolder: PushUnderLockResult['lockHolder'] = null;
  let weHoldLock = false;

  // Resolve the platform project id (cached) and acquire the lock. Any failure here
  // degrades to a lockless push — the lock is advisory, not a gate.
  const platformId = await withClientAsync(
    async (db) => {
      const slug = params.slug ?? readDashboardSlug(db);
      if (!slug) return createSuccess<string | null>(null);
      return createSuccess<string | null>(await resolvePlatformProjectId(db, client!, slug));
    },
    { projectRoot: params.projectRoot }
  );

  const pid = platformId.success ? platformId.data : null;
  if (!pid) {
    warnings.push(
      'Could not resolve the platform project id (getMyProjects/slug) — pushed without a soft-lock. ' +
        'The broker LWW + conflict/restore still protects the edit.'
    );
  } else {
    const acq = await client.acquireLock(pid, fieldScope);
    if (acq.success && acq.data) {
      if (acq.data.ok) {
        lockState = 'acquired';
        weHoldLock = true;
      } else if (acq.data.reason === 'expired') {
        const took = await client.takeoverLock(pid, fieldScope);
        if (took.success && took.data?.ok) {
          lockState = 'tookover';
          weHoldLock = true;
        } else if (took.success && took.data && !took.data.ok) {
          // The takeover lost a race — the lock became active again under a new holder.
          lockState = 'held-by-other';
          lockHolder = lockHolderOf(took.data.lock);
          warnings.push(lockContentionWarning(lockHolder, fieldScope));
        } else {
          // The takeover CALL failed (network, or 403 write-denied) — proceed lockless
          // rather than mislabel it as another editor holding the lock.
          lockState = 'unavailable';
          warnings.push(
            `Could not take over the expired ${fieldScope} lock (${
              took.error?.message ?? 'lock API error'
            }) — pushed without a lock.`
          );
        }
      } else {
        // active lock another editor holds
        lockState = 'held-by-other';
        lockHolder = lockHolderOf(acq.data.lock);
        warnings.push(lockContentionWarning(lockHolder, fieldScope));
      }
    } else {
      warnings.push(
        `Soft-lock unavailable (${acq.error?.message ?? 'lock API error'}) — pushed without a lock.`
      );
    }
  }

  // Run the m04 push with the same editor credential. Pull-before-push + converge.
  const push = await pushMutableStatus({
    projectRoot: params.projectRoot,
    slug: params.slug,
    fieldScope,
    entityId,
    status: params.status,
    now: params.now,
    client,
  });

  // Release a lock we hold, regardless of push outcome (best-effort).
  let released = false;
  if (weHoldLock && pid) {
    const rel = await client.releaseLock(pid, fieldScope);
    released = rel.success ? (rel.data?.released ?? false) : false;
    if (!rel.success) warnings.push(`Failed to release the soft-lock: ${rel.error?.message}`);
  }

  if (!push.success) {
    warnings.push(
      `Shared-project sync failed: ${push.error?.message ?? 'push error'}. The local edit is kept; ` +
        'retry to propagate it.'
    );
    return createSuccess<PushUnderLockResult>({
      lockState,
      lockHolder,
      released,
      push: null,
      warnings,
    });
  }

  if (push.data?.superseded && push.data.conflict) {
    warnings.push(
      `Your '${params.status}' edit was superseded by '${push.data.localStatus}' (conflict ` +
        `${push.data.conflict.id}) — restore your version via the conflict surface.`
    );
  }

  return createSuccess<PushUnderLockResult>({
    lockState,
    lockHolder,
    released,
    push: push.data ?? null,
    warnings,
  });
}

function lockHolderOf(lock: ProjectLock | null): PushUnderLockResult['lockHolder'] {
  if (!lock) return null;
  return { userId: lock.holderUserId, email: lock.holderEmail, expiresAt: lock.expiresAt };
}

function lockContentionWarning(
  holder: PushUnderLockResult['lockHolder'],
  scope: MutableFieldScope
): string {
  const who = holder ? `${holder.email} (until ${holder.expiresAt})` : 'another editor';
  return (
    `${scope} is locked by ${who} — your edit was pushed anyway (the soft-lock is advisory; ` +
    'the broker LWW + conflict/restore is the real safety net).'
  );
}

// ─── Dispatcher hook ─────────────────────────────────────────────────────────

/**
 * After a successful mutable-surface edit, propagate it to the broker IFF this is a
 * collaborative store (Sprint 72 m01, generic over scope). RESILIENT by contract: the
 * local edit already succeeded, so any sync/lock/network failure is folded into the
 * result's `warnings` and the result stays successful — collaboration must never make
 * a local edit fail. A solo store (no collab_role) returns the result untouched, so the
 * calling handler behaves byte-identically for non-shared projects.
 *
 * `statusReader` re-reads the authoritative post-handler value for the entity (mission
 * status / sprint status / project name) and is only invoked on a collab store.
 *
 * `options.emitOnlyIfChanged` (Sprint 72 m02) suppresses a redundant emit when the
 * re-read value equals the recorded `mutable_status:<scope>:<entityId>` winner — so a
 * status-bearing edit that doesn't actually change the value doesn't push. The mission
 * path does NOT pass it (every transition emits), keeping mission_active frozen.
 */
export async function maybePropagateMutableStatus<T>(
  result: CmosToolResult<T>,
  scope: MutableFieldScope,
  entityId: string,
  statusReader: (db: CmosDatabaseClient) => string | null,
  projectRoot: string | undefined,
  options?: { emitOnlyIfChanged?: boolean }
): Promise<CmosToolResult<T>> {
  if (!result.success || !result.data) return result;
  try {
    const info = await withClientAsync(
      async (db) => {
        if (!isCollabStore(db))
          return createSuccess({ collab: false, status: null as string | null });
        const current = statusReader(db);
        // Change-guard: a no-op (same-as-recorded) edit emits nothing.
        if (options?.emitOnlyIfChanged && current != null) {
          const recorded = readStatusState(db, scope, entityId);
          if (recorded?.status === current) {
            return createSuccess({ collab: true, status: null as string | null });
          }
        }
        return createSuccess({ collab: true, status: current });
      },
      { projectRoot }
    );
    if (!info.success || !info.data?.collab || !info.data.status) return result;

    const outcome = await pushMutableStatusUnderLock({
      projectRoot,
      fieldScope: scope,
      entityId,
      status: info.data.status,
    });
    const w = outcome.success
      ? (outcome.data?.warnings ?? [])
      : [outcome.error?.message ?? 'collab sync error'];
    if (w.length > 0) {
      result.warnings = [...(result.warnings ?? []), ...w];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    result.warnings = [
      ...(result.warnings ?? []),
      `Collab propagation error (non-fatal): ${message}`,
    ];
  }
  return result;
}

/**
 * Thin `mission_active` wrapper over {@link maybePropagateMutableStatus} (Sprint 72 m01,
 * fork #6) — the cmos_mission_transition hook. Preserves the Sprint 71 m05 signature +
 * behavior byte-for-byte so cmos-mission-transition.ts stays UNTOUCHED.
 */
export async function maybePropagateMissionStatus<T>(
  result: CmosToolResult<T>,
  missionId: string,
  projectRoot: string | undefined
): Promise<CmosToolResult<T>> {
  return maybePropagateMutableStatus(
    result,
    'mission_active',
    missionId,
    (db) => {
      const row = db.getOne<{ status: string }>('SELECT status FROM missions WHERE id = ?', [
        missionId,
      ]);
      return row.success ? (row.data?.status ?? null) : null;
    },
    projectRoot
  );
}

/**
 * Thin `sprint_status` wrapper over {@link maybePropagateMutableStatus} (Sprint 72 m02) —
 * the cmos_sprint dispatcher hook. Re-reads the authoritative `sprints.status` and emits
 * `sprint_updated` under the sprint_status soft-lock, ONLY when the status actually
 * changed (emitOnlyIfChanged). Resilient: a sync/lock failure folds into result.warnings
 * and never fails the local sprint edit; a solo store is a no-op.
 */
export async function maybePropagateSprintStatus<T>(
  result: CmosToolResult<T>,
  sprintId: string,
  projectRoot: string | undefined
): Promise<CmosToolResult<T>> {
  return maybePropagateMutableStatus(
    result,
    'sprint_status',
    sprintId,
    (db) => {
      const row = db.getOne<{ status: string | null }>('SELECT status FROM sprints WHERE id = ?', [
        sprintId,
      ]);
      return row.success ? (row.data?.status ?? null) : null;
    },
    projectRoot,
    { emitOnlyIfChanged: true }
  );
}

/**
 * Thin `project_identity` wrapper over {@link maybePropagateMutableStatus} (Sprint 72 m03) —
 * the cmos_context project_identity update dispatcher hook. Re-reads the authoritative
 * post-update `project_name` and emits `project_identity_updated` {name} under the
 * project_identity soft-lock (advisory acquire→push→release, #789), keyed on the
 * PROJECT_IDENTITY_ENTITY_ID sentinel. emitOnlyIfChanged suppresses a same-name re-emit;
 * resilient + no-op on solo stores. The caller gates this on `project_name` having
 * actually been in the update (so a description-only edit emits nothing).
 */
export async function maybePropagateProjectIdentity<T>(
  result: CmosToolResult<T>,
  projectRoot: string | undefined
): Promise<CmosToolResult<T>> {
  return maybePropagateMutableStatus(
    result,
    'project_identity',
    PROJECT_IDENTITY_ENTITY_ID,
    (db) => getProjectIdentity(db)?.project_name ?? null,
    projectRoot,
    { emitOnlyIfChanged: true }
  );
}
