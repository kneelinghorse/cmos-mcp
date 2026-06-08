// ABOUTME: Sprint 71 m04 / 72 m01 — outbound pull-before-push for the mutable surface.
// ABOUTME: Pull first (converge the local base to the broker), stamp a FRESH per-edit
// ABOUTME: (occurred_at, origin_seq), push the scope's event (mission_updated /
// ABOUTME: sprint_updated / project_identity_updated) with the editor's own identity,
// ABOUTME: then react to the broker's inline LWW conflict. Generic over fieldScope.

/**
 * Outbound mutable-surface push (Sprint 71 m04, UC2 — see
 * cmos/docs/multiuser-collab-client.md §5). The "you're behind, pull first" model:
 *
 *   1. PULL-BEFORE-PUSH — run the m02 pull first so a stale local value can't be the
 *      basis of the edit. The append-only bulk is NOT gated by this — only the
 *      mutable surface pulls first. If the pull fails we refuse to push (a blind
 *      push could clobber an unseen newer remote value).
 *   2. FRESH STAMP — `occurred_at = edit wall-clock ms`, `origin_seq = per-client
 *      monotonic counter` (dashboard Q2). The row's frozen genesis provenance is the
 *      WRONG ordering signal for an edit, so we stamp the edit's own.
 *   3. APPLY LOCAL — optimistically set the local status + record the fresh ordering.
 *   4. PUSH — `mission_updated {missionId, currentStatus, occurredAt, originSeq}` with
 *      the editor's OWN credential (fromEnvForProject's project→user fallback);
 *      author_user_id is stamped dashboard-authoritative.
 *   5. REACT — if the response carries a conflict and we were superseded, converge
 *      the local row to the broker's LWW winner and surface the conflict so the
 *      caller can offer restore (the durable backstop is GET /conflicts + restore).
 *
 * SCOPE — generic over fieldScope (Sprint 72 m01). mission_active is the frozen
 * Sprint 71 path; sprint_status and project_identity slot in via the eventType↔scope map
 * and the per-scope envelope builder (sync-mutable.ts) now that the broker wires all
 * three resolvers in prod (design doc §8). entityId selects the entity per scope.
 *
 * The handler-level wiring (acquire soft-lock → edit → release; assert editor auth)
 * is m05's job; m04 leaves the live transition handlers untouched.
 *
 * @module tools/cmos/sync-mutable-push
 */

import { ulid } from 'ulid';
import { withClientAsync, type CmosDatabaseClient } from './client';
import { DashboardClient, type MutableConflict } from './dashboard-client';
import { createError, createSuccess, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import { readDashboardSlug } from './sync-merge';
import { syncPull } from './sync-pull';
import {
  isCollabStore,
  nextOriginSeq,
  applyLocalMutableStatus,
  mutableEventTypeForScope,
  buildMutableEventData,
  type MutableFieldScope,
} from './sync-mutable';

export interface PushMutableStatusParams {
  projectRoot?: string;
  /** Dashboard slug to push to. Defaults to metadata.dashboard_slug. */
  slug?: string;
  /**
   * The mutable scope being pushed (Sprint 72 m01). Defaults to 'mission_active' — the
   * frozen Sprint 71 mission path.
   */
  fieldScope?: MutableFieldScope;
  /**
   * The entity whose mutable field changed: a mission id, a sprint id, or the
   * `PROJECT_IDENTITY_ENTITY_ID` sentinel for project_identity. Defaults to `missionId`
   * for the mission scope.
   */
  entityId?: string;
  /** Mission-path alias for `entityId` (the Sprint 71 m04 call shape). */
  missionId?: string;
  /** The new value (mission/sprint status, or the project name). */
  status: string;
  /** Skip the pre-push pull (when the caller already pulled this cycle). Default false. */
  skipPull?: boolean;
  /** Injectable clock (ms) for deterministic tests. Defaults to Date.now(). */
  now?: number;
  /** Injectable DashboardClient (tests). Defaults to fromEnvForProject resolution. */
  client?: DashboardClient;
}

export interface PushMutableStatusResult {
  fieldScope: MutableFieldScope;
  entityId: string;
  pushedStatus: string;
  /** The fresh per-edit ordering stamped on the pushed event. */
  occurredAt: number;
  originSeq: number;
  pulledBeforePush: boolean;
  /** The broker's inline LWW conflict, when one was recorded. */
  conflict: MutableConflict | null;
  /** True when OUR push was the LWW loser (the broker kept a newer value). */
  superseded: boolean;
  /** The status the local row holds after converging to the LWW winner. */
  localStatus: string;
  message: string;
}

export async function pushMutableStatus(
  params: PushMutableStatusParams
): Promise<CmosToolResult<PushMutableStatusResult>> {
  // Resolve the scope + entity (Sprint 72 m01). Defaults preserve the frozen mission
  // path: fieldScope='mission_active', entityId=missionId.
  const fieldScope: MutableFieldScope = params.fieldScope ?? 'mission_active';
  const entityId = params.entityId ?? params.missionId;
  if (!entityId) {
    return createError({
      code: 'MISSING_PARAMETER',
      message:
        'pushMutableStatus requires an entityId (or missionId for the mission_active scope).',
      suggestion:
        'Pass entityId (a sprint id, the project_identity sentinel) or missionId for fieldScope=mission_active.',
    });
  }

  // Resolve the editor's credential (project-scoped → user-scoped fallback) so an
  // editor on a shared project pushes with their OWN identity (dashboard Q4).
  let dashboardClient = params.client;
  if (!dashboardClient) {
    const clientResult = await DashboardClient.fromEnvForProject(params.projectRoot);
    if (!clientResult.success || !clientResult.data) {
      return createError(CmosErrors.dashboardNotConfigured());
    }
    dashboardClient = clientResult.data.client;
  }

  // (1) Pull-before-push: converge the local base BEFORE we edit. A pull failure
  // aborts the push rather than risk clobbering an unseen newer remote value.
  let pulledBeforePush = false;
  if (!params.skipPull) {
    const pull = await syncPull({ projectRoot: params.projectRoot, slug: params.slug });
    if (!pull.success) {
      return createError({
        code: 'PULL_BEFORE_PUSH_FAILED',
        message:
          'Pull-before-push failed, so the mutable edit was NOT pushed (a blind push from a ' +
          `possibly-stale base could clobber a newer remote value): ${
            pull.error?.message ?? 'pull error'
          }`,
        suggestion: 'Resolve the dashboard connectivity/auth error and retry.',
      });
    }
    pulledBeforePush = true;
  }

  return withClientAsync(
    async (db) => {
      const slug = params.slug ?? readDashboardSlug(db);
      if (!slug) {
        return createError({
          code: 'MISSING_PARAMETER',
          message:
            'No dashboard slug available to push a mutable edit (metadata.dashboard_slug unset).',
          suggestion: 'Register/clone the project first, or pass an explicit slug.',
        });
      }
      if (!isCollabStore(db)) {
        return createError({
          code: 'NOT_COLLAB_STORE',
          message:
            'The mutable-surface event-push path is only for shared/collaborative stores ' +
            '(metadata.collab_role set). A solo project syncs mutable state via the whole-DB ' +
            'file-sync on checkpoint; per-field event-push would be redundant.',
          suggestion:
            'Clone the project from a shared /state snapshot (cmos_db clone), or set collab_role to opt in.',
        });
      }

      // (2) Fresh per-edit ordering (NOT the row's frozen genesis provenance).
      // nextOriginSeq is consumed here, before the push; a failed push therefore
      // leaves a gap in the sequence — harmless (the broker's LWW compares absolute
      // values, see nextOriginSeq's doc and the s71-m04 review).
      const now = params.now ?? Date.now();
      const occurredAt = now;
      const originSeq = nextOriginSeq(db);

      // (3) Optimistically apply the edit locally + record the fresh ordering as the
      // current winner. This is deliberate: the local row reflects the editor's intent
      // immediately. If the push fails (below) we return the error WITHOUT reverting —
      // the edit is real local state, and a retry re-pushes it; the broker reconciles
      // via LWW on the eventual successful push (or the other editor's next pull). In
      // the m05 integration the transition handler has already written this status, so
      // this call's real job there is to record the mutable-status ordering.
      applyLocalMutableStatus(db, fieldScope, entityId, params.status, occurredAt, originSeq);

      const projectName = readMetaValue(db, 'project_name') ?? slug;
      const eventType = mutableEventTypeForScope(fieldScope);
      const envelope: Record<string, unknown> = {
        // The dashboard routes membership by SLUG (getAccessibleProjectBySlug), so the
        // envelope's projectId field carries the slug — matching the existing emitter
        // where project_id == slug, and correct where a clone's id differs from slug.
        projectId: slug,
        projectName,
        eventType,
        // ISO 8601 envelope timestamp; occurred_at rides INSIDE data as raw ms-epoch
        // (never the envelope timestamp, or the dashboard 400s the event).
        timestamp: new Date(now).toISOString(),
        data: buildMutableEventData(fieldScope, entityId, params.status, {
          occurredAt,
          originSeq,
          stableEventId: ulid(now),
          schemaVersion: 1,
        }),
      };

      // (4) Push with the editor's own identity.
      const pushResult = await dashboardClient!.pushMutableEvent(envelope);
      if (!pushResult.success || !pushResult.data) {
        return createError(
          pushResult.error ?? CmosErrors.dashboardError('Mutable event push failed')
        );
      }

      // (5) React to the broker's inline LWW outcome.
      const conflict = pushResult.data.conflict ?? null;
      let superseded = false;
      let localStatus = params.status;
      if (conflict && conflict.youWereSuperseded) {
        const winner = conflict.appliedValue ?? params.status;
        applyLocalMutableStatus(
          db,
          fieldScope,
          entityId,
          winner,
          conflict.appliedOccurredAt ?? occurredAt,
          null,
          conflict.appliedAuthorUserId
        );
        superseded = true;
        localStatus = winner;
      }

      return createSuccess<PushMutableStatusResult>({
        fieldScope,
        entityId,
        pushedStatus: params.status,
        occurredAt,
        originSeq,
        pulledBeforePush,
        conflict,
        superseded,
        localStatus,
        message: superseded
          ? `Pushed ${eventType} for '${entityId}' (${params.status}); broker LWW kept a ` +
            `newer value '${localStatus}' — your edit is recoverable via restore (conflict ${conflict?.id}).`
          : `Pushed ${eventType} for '${entityId}' → '${params.status}'` +
            (conflict
              ? ` (you won; another editor's value was superseded, conflict ${conflict.id}).`
              : '.'),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

function readMetaValue(db: CmosDatabaseClient, key: string): string | null {
  const row = db.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return row.success && row.data?.value ? row.data.value : null;
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

export function formatPushMutableStatusForLLM(
  result: CmosToolResult<PushMutableStatusResult>
): string {
  if (!result.success) {
    return `Mutable push failed: ${result.error?.message ?? 'Unknown error'}`;
  }
  const d = result.data!;
  const lines = [
    `Mutable push (${d.fieldScope})`,
    '',
    d.message,
    '',
    `Entity: ${d.entityId} | Pushed: ${d.pushedStatus} | Local now: ${d.localStatus}`,
    `Ordering: occurredAt=${d.occurredAt}, originSeq=${d.originSeq} | ` +
      `Pulled-before-push: ${d.pulledBeforePush ? 'yes' : 'no'}`,
  ];
  if (d.conflict) {
    lines.push(
      d.superseded
        ? `⚠ Superseded — restore your value: conflict ${d.conflict.id} (was '${d.conflict.supersededValue}').`
        : `Conflict ${d.conflict.id}: you won; '${d.conflict.supersededValue}' was superseded.`
    );
  }
  return lines.join('\n');
}
