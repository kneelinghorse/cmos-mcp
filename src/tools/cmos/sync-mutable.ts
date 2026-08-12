// ABOUTME: Sprint 71 m04 / 72 m01 — the mutable-surface LWW state engine: the
// ABOUTME: collab-role gate, per-entity status ordering (metadata-backed, no migration),
// ABOUTME: the shared incomingWins LWW key, and inbound application of pulled mutable
// ABOUTME: edits GENERIC over fieldScope (mission_active/sprint_status/project_identity;
// ABOUTME: mission_active frozen). The outbound pull-before-push path lives in
// ABOUTME: sync-mutable-push.ts (kept separate to avoid a sync-pull import cycle).

/**
 * Mutable-surface engine (Sprint 71 m04, UC2 — see cmos/docs/multiuser-collab-client.md).
 *
 * The mutable surface (project_identity, mission active status, sprint status) is
 * the small slice of CMOS state that two editors can race on. This module holds
 * the CLIENT half of the conflict story:
 *
 *   - `collab_role` marker — presence puts a store in collaborative mutable-surface
 *     mode (pull-before-push + per-field event push + inbound LWW). Absence = a solo
 *     store whose mutable edits ride the existing whole-DB file-sync, unchanged.
 *   - per-entity status ordering — `(status, occurred_at, origin_seq)` persisted in
 *     the existing `metadata` table (Fork C: no schema migration; the surface is
 *     tiny). Needed because inbound LWW spans *incremental* pulls — you can't see
 *     all events at once, so the last winner's ordering must persist.
 *   - `incomingWins` — a byte-for-byte mirror of the dashboard's LWW key, so the
 *     local mirror converges with the broker's mirror.
 *   - `applyInboundMissionStatus` — applies a pulled transition to the local row
 *     iff it wins LWW (called by sync-pull on collab stores).
 *
 * SCOPE (as-built after Sprint 72 m01–m03, dashboard deploy 1f4987a2): all THREE
 * mutable scopes are broker-wired and exercised end-to-end through the generic
 * `fieldScope` engine — `mission_active`, `sprint_status`, and `project_identity`.
 * The dashboard accepts all three event types in prod; this module emits the
 * per-scope envelope (`buildMutableEventData`) and applies inbound LWW for each
 * (`inboundMutableFieldsForEventType` / `MUTABLE_STATUS_EVENT_TYPES`).
 * `mission_active` is kept byte-for-byte frozen (the Sprint 71 m04 shape, via thin
 * wrappers); `sprint_status` (m02) and `project_identity` (m03) were added by
 * parameterizing that proven path over the scope set, not by forking it.
 *
 * @module tools/cmos/sync-mutable
 */

import type { CmosDatabaseClient } from './client';
import { patchProjectIdentity } from './project-identity';
import { checkWrite, countWrite, type WriteSink } from './write-guard';

export type CollabRole = 'owner' | 'editor';

/** Mirrors the dashboard's ConflictFieldScope. All three scopes are wired (s72 m01–m03). */
export type MutableFieldScope = 'mission_active' | 'sprint_status' | 'project_identity';

/**
 * The mission-status transition event types m04 applies inbound on a collab store.
 * `mission_updated` is the fresh-stamped event the m04 outbound path emits; the
 * three named verbs are the genesis-derived transitions the backfill emitter sends
 * (carrying the row's frozen genesis provenance). Both route through the same LWW.
 */
export const MUTABLE_MISSION_STATUS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'mission_started',
  'mission_completed',
  'mission_blocked',
  'mission_updated',
]);

// ─── Scope → event type + per-scope envelope (Sprint 72 m01) ────────────────────

/**
 * The fixed sentinel entity id for project_identity (fork #3): it has no per-row id,
 * so emit + inbound both key its ordering state on
 * `mutable_status:project_identity:project`. Centralized here so the two sides cannot
 * diverge.
 */
export const PROJECT_IDENTITY_ENTITY_ID = 'project';

/**
 * Scope → outbound push event type. IDENTITY-PRESERVING for mission_active: the mission
 * path keeps emitting `mission_updated` exactly. The dashboard already accepts all three
 * event types in prod (deploy 1f4987a2 — see design doc §8).
 */
const MUTABLE_EVENT_TYPE_BY_SCOPE: Readonly<Record<MutableFieldScope, string>> = {
  mission_active: 'mission_updated',
  sprint_status: 'sprint_updated',
  project_identity: 'project_identity_updated',
};

export function mutableEventTypeForScope(scope: MutableFieldScope): string {
  return MUTABLE_EVENT_TYPE_BY_SCOPE[scope];
}

/** The fresh per-edit ordering + identity stamped into a pushed mutable event. */
export interface MutableEventOrdering {
  occurredAt: number;
  originSeq: number;
  stableEventId: string;
  schemaVersion: number;
}

/**
 * Build the per-scope `data` envelope for a pushed mutable event. The representative
 * field differs by scope — mission: {missionId,currentStatus}; sprint: {sprintId,status};
 * project_identity: {name} (NO entity id). mission_active is byte-for-byte the Sprint 71
 * m04 shape (field order preserved so the serialized event is identical).
 */
export function buildMutableEventData(
  scope: MutableFieldScope,
  entityId: string,
  value: string,
  ordering: MutableEventOrdering
): Record<string, unknown> {
  const base = {
    occurredAt: ordering.occurredAt,
    originSeq: ordering.originSeq,
    stableEventId: ordering.stableEventId,
    schemaVersion: ordering.schemaVersion,
  };
  switch (scope) {
    case 'mission_active':
      return { missionId: entityId, currentStatus: value, ...base };
    case 'sprint_status':
      return { sprintId: entityId, status: value, ...base };
    case 'project_identity':
      return { name: value, ...base };
  }
}

// ─── Inbound routing (Sprint 72 m02) ────────────────────────────────────────────

/**
 * The full set of inbound mutable-status event types recognized + applied on a collab
 * store — a SUPERSET of the mission verbs (kept distinct so the proven mission inbound
 * path stays byte-for-byte). sprint_status added in s72 m02; project_identity in m03.
 */
export const MUTABLE_STATUS_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...MUTABLE_MISSION_STATUS_EVENT_TYPES,
  'sprint_updated',
  'project_identity_updated',
]);

/**
 * Per-event-type inbound extraction descriptor: which scope a pulled event belongs to,
 * and which `data` fields carry the entity id + the representative value. A scope with
 * no per-row id (project_identity) sets `fixedEntityId` instead of `entityKey`.
 */
export interface InboundMutableFields {
  scope: MutableFieldScope;
  entityKey?: string;
  valueKey: string;
  fixedEntityId?: string;
}

/**
 * Map a pulled event type to its inbound extraction descriptor, or null when the event
 * is not a recognized mutable-surface transition. The four mission verbs all map to
 * mission_active {missionId,currentStatus} (the Sprint 71 shape, unchanged).
 */
export function inboundMutableFieldsForEventType(eventType: string): InboundMutableFields | null {
  if (MUTABLE_MISSION_STATUS_EVENT_TYPES.has(eventType)) {
    return { scope: 'mission_active', entityKey: 'missionId', valueKey: 'currentStatus' };
  }
  if (eventType === 'sprint_updated') {
    return { scope: 'sprint_status', entityKey: 'sprintId', valueKey: 'status' };
  }
  if (eventType === 'project_identity_updated') {
    // No per-row id: the representative field is `name`, keyed on the 'project' sentinel.
    return {
      scope: 'project_identity',
      valueKey: 'name',
      fixedEntityId: PROJECT_IDENTITY_ENTITY_ID,
    };
  }
  return null;
}

export interface OrderingKey {
  occurredAt: number | null;
  originSeq: number | null;
}

/**
 * LWW key — a faithful mirror of the dashboard's `incomingWins()`
 * (conflict-resolution.ts): newer `occurred_at` wins; on a tie, higher
 * `origin_seq` wins; on a full tie OR any null, the incoming (last-arrival) wins.
 * Keeping ONE definition of this key on both sides is what makes a pulled edit land
 * locally exactly as the broker resolved it.
 */
export function incomingWins(incoming: OrderingKey, current: OrderingKey | null): boolean {
  if (!current) return true;
  if (incoming.occurredAt != null && current.occurredAt != null) {
    if (incoming.occurredAt !== current.occurredAt) {
      return incoming.occurredAt > current.occurredAt;
    }
    const a = incoming.originSeq ?? Number.NEGATIVE_INFINITY;
    const b = current.originSeq ?? Number.NEGATIVE_INFINITY;
    if (a !== b) return a > b;
    return true; // full tie → last arrival (incoming) wins
  }
  return true; // missing any occurred_at → synced_at-style last-arrival wins
}

// ─── Metadata-backed state (Fork C — no schema migration) ──────────────────────

function readMeta(db: CmosDatabaseClient, key: string): string | null {
  const row = db.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return row.success && row.data?.value ? row.data.value : null;
}

/**
 * The sink handed to a write whose caller supplied none. It is a real array that NOTHING
 * READS — a fresh one per call, so it cannot grow. It exists as a NAMED call-site argument
 * rather than a `sink: WriteSink = []` parameter default, because a default lets a future
 * caller re-open the hole s86-m02b closed without the omission appearing in any diff.
 *
 * Reached today only through the exported entry points below whose `sink` is still OPTIONAL:
 * `setCollabRole`, `writeStatusState`, `nextOriginSeq`, `applyLocalMutableStatus`,
 * `applyInboundMutableStatus`, and the two frozen `mission_active` wrappers. They stay
 * optional because their remaining sink-less callers (sync-mutable-push.ts and
 * tests/tools/cmos/sync-mutable.test.ts) are outside this mission's edit set — for those
 * calls the DB error is genuinely LOST, which is the state today, not a claim that it
 * reaches an answer.
 */
function unreportedSink(): WriteSink {
  return [];
}

/**
 * s86-m02b — the LWW ordering state, the collab-role marker and the origin_seq counter all
 * live in `metadata`, and a lost write here is silent divergence: the next inbound edit
 * compares against ordering that was never recorded. `sink` is REQUIRED: every caller must
 * name where the DB error goes, even when the answer is {@link unreportedSink}.
 */
function writeMeta(db: CmosDatabaseClient, key: string, value: string, sink: WriteSink): void {
  const res = db.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
    key,
    value,
  ]);
  checkWrite(res, sink, `metadata.${key}`);
}

export const COLLAB_ROLE_KEY = 'collab_role';

export function readCollabRole(db: CmosDatabaseClient): CollabRole | null {
  const v = readMeta(db, COLLAB_ROLE_KEY);
  return v === 'owner' || v === 'editor' ? v : null;
}

/** Presence of a collab role ⇒ the store participates in collaborative mutable sync. */
export function isCollabStore(db: CmosDatabaseClient): boolean {
  return readCollabRole(db) !== null;
}

export function setCollabRole(db: CmosDatabaseClient, role: CollabRole, sink?: WriteSink): void {
  writeMeta(db, COLLAB_ROLE_KEY, role, sink ?? unreportedSink());
}

export interface StatusState {
  status: string | null;
  occurredAt: number | null;
  originSeq: number | null;
  authorUserId: string | null;
}

function statusStateKey(scope: MutableFieldScope, entityId: string): string {
  return `mutable_status:${scope}:${entityId}`;
}

/** The last LWW-winning ordering for a mutable field, or null if never tracked. */
export function readStatusState(
  db: CmosDatabaseClient,
  scope: MutableFieldScope,
  entityId: string
): StatusState | null {
  const raw = readMeta(db, statusStateKey(scope, entityId));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<StatusState>;
    return {
      status: typeof o.status === 'string' ? o.status : null,
      occurredAt: typeof o.occurredAt === 'number' ? o.occurredAt : null,
      originSeq: typeof o.originSeq === 'number' ? o.originSeq : null,
      authorUserId: typeof o.authorUserId === 'string' ? o.authorUserId : null,
    };
  } catch {
    return null;
  }
}

export function writeStatusState(
  db: CmosDatabaseClient,
  scope: MutableFieldScope,
  entityId: string,
  state: StatusState,
  sink?: WriteSink
): void {
  writeMeta(db, statusStateKey(scope, entityId), JSON.stringify(state), sink ?? unreportedSink());
}

const ORIGIN_SEQ_KEY = 'mutable_origin_seq';

/**
 * Per-client monotonic counter for the fresh per-edit `origin_seq` (dashboard Q2).
 * Tiebreaks two edits that share an `occurred_at` ms; only meaningful within one
 * client's clock, which is exactly what the dashboard's origin_seq tiebreak wants.
 *
 * The contract is MONOTONIC, not gapless: it is consumed before a push, so a failed
 * push leaves a gap (the value is spent but never landed). That is harmless — the
 * dashboard's LWW compares ABSOLUTE `(occurred_at, origin_seq)` values, never the
 * deltas between them, so a skipped value changes no ordering decision (s71-m04
 * review, finding 3).
 */
export function nextOriginSeq(db: CmosDatabaseClient, sink?: WriteSink): number {
  const current = Number.parseInt(readMeta(db, ORIGIN_SEQ_KEY) ?? '0', 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  writeMeta(db, ORIGIN_SEQ_KEY, String(next), sink ?? unreportedSink());
  return next;
}

// ─── Local status writes ───────────────────────────────────────────────────────

/**
 * Write the authoritative local row for a mutable scope. Returns the number of rows
 * touched (mission/sprint UPDATEs); project_identity always resolves to its single
 * seeded contexts row, so it reports 1 on success / 0 on failure.
 *
 * NOTE: `sprints` has NO `updated_at` column (unlike `missions`), so the sprint write
 * deliberately omits it. project_identity's `name` lives in the
 * contexts(id='project_identity') JSON blob — patchProjectIdentity ensures the row,
 * merges the field, and stamps its own updated_at.
 *
 * s86-m02b: countWrite separates the two zeros the callers act on. `success, changes: 0`
 * means the WHERE matched no local row (a legitimate skip); `success: false` means the
 * UPDATE errored, which the inbound path would otherwise ALSO report as 'skipped'. `sink` is
 * REQUIRED (no parameter default) and ALL THREE arms route their DB error into it — including
 * project_identity, whose failure previously landed in patchProjectIdentity's own defaulted
 * array and was discarded.
 */
function writeLocalEntityValue(
  db: CmosDatabaseClient,
  scope: MutableFieldScope,
  entityId: string,
  value: string,
  sink: WriteSink
): number {
  switch (scope) {
    case 'mission_active': {
      const res = db.execute('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?', [
        value,
        new Date().toISOString(),
        entityId,
      ]);
      return countWrite(res, sink, `missions.status (${entityId})`);
    }
    case 'sprint_status': {
      const res = db.execute('UPDATE sprints SET status = ? WHERE id = ?', [value, entityId]);
      return countWrite(res, sink, `sprints.status (${entityId})`);
    }
    case 'project_identity': {
      // patchProjectIdentity (project-identity.ts) predates WriteSink: its sink parameter is a
      // plain message `string[]`, so the ENVELOPE arm is handed to it directly and the
      // structured `{failures}` arm gets the same checkWrite message re-wrapped rather than
      // dropped. Its `code` is DB_ERROR because the boolean return has already discarded the
      // originating envelope's code — widening patchProjectIdentity to WriteSink would recover
      // it, and project-identity.ts is outside this mission's edit set.
      const messages: string[] = Array.isArray(sink) ? sink : [];
      const patched = patchProjectIdentity(db, { project_name: value }, messages);
      if (!Array.isArray(sink)) {
        for (const message of messages) {
          sink.failures.push({ op: `project_identity (${entityId})`, code: 'DB_ERROR', message });
        }
      }
      return patched ? 1 : 0;
    }
  }
}

/**
 * Unconditionally set a local mutable row's value + record the given ordering as the
 * current LWW winner, generic over scope. Used by the OUTBOUND path for our own
 * optimistic edit and for convergence to a broker-chosen winner. Returns the number of
 * rows touched.
 */
export function applyLocalMutableStatus(
  db: CmosDatabaseClient,
  scope: MutableFieldScope,
  entityId: string,
  value: string,
  occurredAt: number | null,
  originSeq: number | null,
  authorUserId: string | null = null,
  sink?: WriteSink
): number {
  const writes = sink ?? unreportedSink();
  const changes = writeLocalEntityValue(db, scope, entityId, value, writes);
  writeStatusState(
    db,
    scope,
    entityId,
    { status: value, occurredAt, originSeq, authorUserId },
    writes
  );
  return changes;
}

/**
 * Thin `mission_active` wrapper over {@link applyLocalMutableStatus} (Sprint 72 m01,
 * fork #6). Preserves the Sprint 71 m04 mission signature + behavior byte-for-byte so
 * existing callers/tests stay untouched — the mission path is frozen.
 */
export function applyLocalMissionStatus(
  db: CmosDatabaseClient,
  missionId: string,
  status: string,
  occurredAt: number | null,
  originSeq: number | null,
  authorUserId: string | null = null
): number {
  return applyLocalMutableStatus(
    db,
    'mission_active',
    missionId,
    status,
    occurredAt,
    originSeq,
    authorUserId
  );
}

// ─── Inbound apply ─────────────────────────────────────────────────────────────

export interface InboundMutableStatus {
  entityId: string;
  value: string;
  occurredAt: number | null;
  originSeq: number | null;
  authorUserId: string | null;
}

export type InboundOutcome = 'applied' | 'skipped';

/**
 * Apply a pulled mutable-surface edit to the local row via LWW, generic over scope
 * (Sprint 72 m01).
 *
 * Returns 'applied' when the incoming edit wins (newer ordering) AND a local row
 * exists to update. Returns 'skipped' when the incoming edit lost LWW to a newer local
 * value (so a stale remote edit can NOT clobber a fresher local one), OR when no local
 * row exists (`changes === 0`).
 *
 * On the no-local-row case we skip without recording ordering state. This is safe
 * because the case is unreachable under normal delivery, by two independent guarantees
 * (s71-m04 review, finding 1): (1) the pull drains `cmos_sync_log.id` ASC contiguously,
 * so an entity's genesis insert is merged before any of its transitions; (2) the clone
 * bootstrap seeds every entity's current value from GET /state. project_identity never
 * hits the NO-ROW skip — patchProjectIdentity seeds its row on demand — though an ERRORED
 * identity patch does return 0 and therefore skips (see below). Recording ordering for
 * a non-existent row would buy no convergence (the append-only genesis insert-union
 * never reads it), so we surface a skip rather than fabricate a ghost row.
 *
 * s86-m02b: an ERRORED update also yields `changes === 0` and is therefore reported as
 * 'skipped' too — the two are indistinguishable in the returned enum. sync-pull.ts passes its
 * own `warnings` array here (the one it emits on the result and formatSyncPullForLLM renders),
 * so the DB error reaches the answer instead of `transitionsSkipped` presenting a failed write
 * as a benign LWW loss. A caller that omits `sink` loses the error — see {@link unreportedSink}.
 */
export function applyInboundMutableStatus(
  db: CmosDatabaseClient,
  scope: MutableFieldScope,
  edit: InboundMutableStatus,
  sink?: WriteSink
): InboundOutcome {
  const current = readStatusState(db, scope, edit.entityId);
  if (!incomingWins({ occurredAt: edit.occurredAt, originSeq: edit.originSeq }, current)) {
    return 'skipped';
  }
  const writes = sink ?? unreportedSink();
  const changes = writeLocalEntityValue(db, scope, edit.entityId, edit.value, writes);
  if (changes === 0) {
    return 'skipped';
  }
  writeStatusState(
    db,
    scope,
    edit.entityId,
    {
      status: edit.value,
      occurredAt: edit.occurredAt,
      originSeq: edit.originSeq,
      authorUserId: edit.authorUserId,
    },
    writes
  );
  return 'applied';
}

export interface InboundMissionStatus {
  missionId: string;
  status: string;
  occurredAt: number | null;
  originSeq: number | null;
  authorUserId: string | null;
}

/**
 * Thin `mission_active` wrapper over {@link applyInboundMutableStatus} (Sprint 72 m01,
 * fork #6). Preserves the Sprint 71 m04 inbound signature + behavior byte-for-byte —
 * sync-pull calls this; the mission path is frozen.
 */
export function applyInboundMissionStatus(
  db: CmosDatabaseClient,
  edit: InboundMissionStatus
): InboundOutcome {
  return applyInboundMutableStatus(db, 'mission_active', {
    entityId: edit.missionId,
    value: edit.status,
    occurredAt: edit.occurredAt,
    originSeq: edit.originSeq,
    authorUserId: edit.authorUserId,
  });
}
