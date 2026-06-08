// ABOUTME: Sprint 71 m02 — the PULL consumer, the missing half of the sync loop.
// ABOUTME: Fetches events-since-cursor from the dashboard broker and insert-unions
// ABOUTME: GENESIS events into local SQLite, preserving the origin's provenance.

/**
 * PULL-MERGE consumer (Sprint 71 m02, UC1 critical path).
 *
 * Calls GET /api/sync/projects/:slug/events?since=<cursor>&limit=N, receives
 * { events, nextCursor, hasMore, returnedCount }, and insert-unions the returned
 * events into the local SQLite store. Pages until hasMore=false.
 *
 * SCOPE — genesis vs transition (decision #728, operator-directed):
 *   - GENESIS / creation events (decision_captured, learning_captured,
 *     mission_added, sprint_added, session_started, dependency_added) are
 *     insert-unioned with ON CONFLICT(natural key) DO NOTHING — the append-only
 *     bulk is conflict-free, so re-pull is idempotent.
 *   - MISSION-STATUS transition events (mission_started/completed/blocked,
 *     mission_updated) are, on a COLLAB store (metadata.collab_role set), APPLIED
 *     to the local mission row via LWW (Sprint 71 m04, the inbound half of the
 *     mutable surface — see sync-mutable.ts). On a SOLO store they remain
 *     counted-and-deferred (m02 behavior, unchanged) — a single-writer store has
 *     no inbound mutable edits to reconcile.
 *   - The remaining transition events (sprint_completed, session_completed) stay
 *     DEFERRED: sprint_status/session status are not broker-wired conflict surfaces
 *     yet (mission-active scope; see cmos/docs/multiuser-collab-client.md §7).
 *
 * MERGE — the per-entity insert-union lives in sync-merge.ts and is SHARED with the
 * m03 clone-from-/state bootstrap (no duplicate insert logic). This consumer maps
 * the event `data` field names onto the shared normalized row shape.
 *
 * PROVENANCE — preserved, never re-stamped. A pulled event is a REPLICA of an
 * origin event, so its row is inserted carrying the origin's genesis provenance
 * verbatim (project_id, stable_event_id, occurred_at, origin_seq, event_type,
 * schema_version). It does NOT call genesisColumns — that would mint a fresh ULID
 * and a local occurred_at/origin_seq, breaking cross-machine event identity and
 * the dashboard's LWW-by-(occurred_at, origin_seq) ordering. A genesis event whose
 * required provenance is missing (a pre-s71-m01 origin) cannot be faithfully
 * reconstructed and is skipped + counted, never re-stamped, never silently dropped.
 *
 * CURSOR — the per-project cursor is the dashboard's cmos_sync_log.id (broker-
 * assigned BIGSERIAL), persisted in metadata as `pull_cursor:<slug>`. It advances
 * to nextCursor after each page so an interrupted pull resumes from where it left
 * off. NOT stable_event_id/occurred_at (which may be NULL on older rows).
 *
 * READ-ONLY against the dashboard; only the local store is written.
 *
 * @module tools/cmos/sync-pull
 */

import { withClientAsync, type CmosDatabaseClient } from './client';
import { DashboardClient, type PulledSyncEvent } from './dashboard-client';
import { createError, createSuccess, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import {
  type GenesisProvenance,
  type InsertOutcome,
  insertSprintRow,
  insertMissionRow,
  insertSessionRow,
  insertDecisionRow,
  insertLearningRow,
  insertDependencyRow,
  readPullCursor,
  persistPullCursor,
  readDashboardSlug,
  asRecord,
  asString,
  asNumber,
  emptyToNull,
  toProvenanceInt,
} from './sync-merge';
import {
  isCollabStore,
  applyInboundMutableStatus,
  MUTABLE_STATUS_EVENT_TYPES,
  inboundMutableFieldsForEventType,
} from './sync-mutable';

// ─── Event-type partitions (decision #728 genesis-vs-transition split) ─────────

/**
 * Genesis (creation) event types the PULL consumer insert-unions. The 5 firehose
 * genesis verbs + dependency_added (a creation edge; not a firehose table, so it
 * carries no genesis provenance). Idempotent by natural key.
 */
export const PULL_GENESIS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'decision_captured',
  'learning_captured',
  'mission_added',
  'sprint_added',
  'session_started',
  'dependency_added',
]);

/**
 * Transition events on the MUTABLE surface — explicitly deferred to UC2 (m04/m05).
 * Counted + logged by m02, never applied. See decision #728 + the s71-m04 mission
 * note on inbound mutable-LWW ownership.
 */
export const PULL_TRANSITION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'mission_started',
  'mission_completed',
  'mission_blocked',
  'sprint_completed',
  'session_completed',
]);

const DEFAULT_PULL_LIMIT = 500;
/** Safety bound on the pagination loop — far above any realistic tail. */
const DEFAULT_MAX_PAGES = 1000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyncPullParams {
  projectRoot?: string;
  /** Dashboard slug to pull. Defaults to metadata.dashboard_slug. */
  slug?: string;
  /** Per-page limit (default 500; the broker caps at 1000). */
  limit?: number;
  /** Safety bound on the pagination loop (default 1000 pages). */
  maxPages?: number;
}

export interface SyncPullResult {
  slug: string;
  fromCursor: number;
  toCursor: number;
  pages: number;
  /** Total events the broker returned across all pages. */
  received: number;
  /** Genesis events newly inserted (ON CONFLICT no-op excluded). */
  inserted: number;
  /** Genesis events already present locally (idempotent re-pull / dup). */
  duplicates: number;
  /** Mission-status transitions applied to a local row via LWW (collab store, m04). */
  transitionsApplied: number;
  /** Mission-status transitions that lost LWW to a newer local value, or had no
   *  local mission row yet — counted, not applied (collab store, m04). */
  transitionsSkipped: number;
  /** Transition events deferred (solo store, or not-yet-wired sprint/session). */
  transitionsDeferred: number;
  /** Genesis events skipped because required provenance was missing/malformed. */
  skippedMissingProvenance: number;
  /** Events with an unrecognized type — skipped. */
  skippedUnknownType: number;
  /** Genesis events whose local insert errored (e.g. FK) — isolated + counted. */
  failed: number;
  /** Newly-inserted count keyed by genesis event type. */
  insertedByType: Record<string, number>;
  message: string;
  warnings?: string[];
}

interface MergeTally {
  inserted: number;
  duplicates: number;
  transitionsApplied: number;
  transitionsSkipped: number;
  transitionsDeferred: number;
  skippedMissingProvenance: number;
  skippedUnknownType: number;
  failed: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export async function syncPull(params: SyncPullParams): Promise<CmosToolResult<SyncPullResult>> {
  // Membership-scoped PULL — resolve the credential the same way the checkpoint
  // path does (project-scoped key → user-scoped → legacy), so an owner/editor
  // authenticates correctly for a shared project.
  const clientResult = await DashboardClient.fromEnvForProject(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(CmosErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data.client;

  return withClientAsync(
    async (db) => {
      const slug = params.slug ?? readDashboardSlug(db);
      if (!slug) {
        return createError({
          code: 'MISSING_PARAMETER',
          message:
            'No dashboard slug available to pull: the project is not registered (metadata.dashboard_slug is unset).',
          suggestion:
            'Register the project with the dashboard first, or pass an explicit slug to pull.',
        });
      }

      const limit = params.limit ?? DEFAULT_PULL_LIMIT;
      const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
      const fromCursor = readPullCursor(db, slug);
      // Inbound mutable-LWW only runs on a collaborative store (m04). A solo store
      // has no inbound mutable edits to reconcile, so transitions stay deferred —
      // preserving the exact m02 behavior for every non-shared project.
      const collab = isCollabStore(db);

      const tally: MergeTally = {
        inserted: 0,
        duplicates: 0,
        transitionsApplied: 0,
        transitionsSkipped: 0,
        transitionsDeferred: 0,
        skippedMissingProvenance: 0,
        skippedUnknownType: 0,
        failed: 0,
      };
      const insertedByType: Record<string, number> = {};
      const warnings: string[] = [];

      let cursor = fromCursor;
      let pages = 0;
      let received = 0;

      while (pages < maxPages) {
        const pageResult = await dashboardClient.getProjectEventsSince(slug, cursor, limit);
        if (!pageResult.success || !pageResult.data) {
          // Hard-fail only if we got nothing at all; otherwise persist progress
          // (the cursor is already advanced for completed pages) and surface a
          // resumable warning rather than discarding merged events.
          if (pages === 0) {
            return createError(
              pageResult.error ?? CmosErrors.dashboardError('PULL request failed')
            );
          }
          warnings.push(
            `PULL stopped after ${pages} page(s): ${pageResult.error?.message ?? 'dashboard error'}. ` +
              `Re-run to resume from cursor ${cursor}.`
          );
          break;
        }

        const page = pageResult.data;
        pages++;
        received += page.events.length;

        for (const event of page.events) {
          mergeEvent(db, event, tally, insertedByType, collab);
        }

        // Advance + persist the cursor after each page so an interrupted multi-page
        // pull resumes from the last fully-merged page. The cursor advances even when
        // individual events in the page were skipped/failed (per-event isolation): the
        // cursor is the broker's cmos_sync_log.id, and ON CONFLICT(natural key) makes a
        // re-pull idempotent, so advancing past an isolated failure never double-applies.
        cursor = page.nextCursor;
        persistPullCursor(db, slug, cursor);

        if (!page.hasMore) break;
        // Defensive: a hasMore=true page that returned nothing would loop forever.
        if (page.events.length === 0) break;
      }

      if (pages >= maxPages) {
        warnings.push(
          `Reached maxPages=${maxPages}; more events may remain. Re-run to continue from cursor ${cursor}.`
        );
      }
      if (tally.failed > 0) {
        warnings.push(
          `${tally.failed} genesis event(s) failed to insert locally (e.g. an unmet foreign key from ` +
            `out-of-order delivery); each was isolated and counted, not silently dropped. The page ` +
            `cursor still advanced past them, so a plain re-run won't re-fetch them — a full re-pull ` +
            `(reset the pull_cursor) re-applies them once the referenced rows exist. In normal ` +
            `cmos_sync_log ordering a row's genesis precedes any edge referencing it, so this is rare.`
        );
      }
      if (tally.skippedMissingProvenance > 0) {
        warnings.push(
          `${tally.skippedMissingProvenance} genesis event(s) lacked the provenance/data needed to ` +
            `reconstruct a replica row faithfully (a pre-s71-m01 origin, or a malformed payload) and ` +
            `were skipped — not re-stamped, to preserve cross-machine event identity.`
        );
      }

      return createSuccess<SyncPullResult>({
        slug,
        fromCursor,
        toCursor: cursor,
        pages,
        received,
        inserted: tally.inserted,
        duplicates: tally.duplicates,
        transitionsApplied: tally.transitionsApplied,
        transitionsSkipped: tally.transitionsSkipped,
        transitionsDeferred: tally.transitionsDeferred,
        skippedMissingProvenance: tally.skippedMissingProvenance,
        skippedUnknownType: tally.skippedUnknownType,
        failed: tally.failed,
        insertedByType,
        message:
          `Pulled ${received} event(s) for '${slug}' across ${pages} page(s): ` +
          `${tally.inserted} inserted, ${tally.duplicates} duplicate(s)` +
          (tally.transitionsApplied > 0
            ? `, ${tally.transitionsApplied} mutable transition(s) applied`
            : '') +
          (tally.transitionsSkipped > 0
            ? `, ${tally.transitionsSkipped} transition(s) skipped (lost LWW / no row)`
            : '') +
          `, ${tally.transitionsDeferred} transition(s) deferred` +
          (tally.failed > 0 ? `, ${tally.failed} failed` : '') +
          (tally.skippedMissingProvenance > 0
            ? `, ${tally.skippedMissingProvenance} skipped (no provenance)`
            : '') +
          (tally.skippedUnknownType > 0 ? `, ${tally.skippedUnknownType} unknown type` : '') +
          `. Cursor ${fromCursor} → ${cursor}.`,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Per-event merge ─────────────────────────────────────────────────────────

function mergeEvent(
  db: CmosDatabaseClient,
  event: PulledSyncEvent,
  tally: MergeTally,
  insertedByType: Record<string, number>,
  collab: boolean
): void {
  const eventType = event.eventType;

  // Mutable-surface transitions on a COLLAB store: apply to the local row via LWW
  // (m04 inbound, generic over scope as of s72 m02). A stale incoming edit loses to a
  // newer local value, so it can't clobber. See sync-mutable.ts. mutable_origin_seq /
  // status state are metadata-backed.
  if (collab && MUTABLE_STATUS_EVENT_TYPES.has(eventType)) {
    applyInboundTransition(db, event, tally);
    return;
  }
  // Everything else on the mutable surface stays deferred: a solo store's mutable
  // transitions (single-writer, nothing to reconcile) and the not-yet-wired
  // sprint_completed/session_completed for any store.
  if (PULL_TRANSITION_EVENT_TYPES.has(eventType) || MUTABLE_STATUS_EVENT_TYPES.has(eventType)) {
    tally.transitionsDeferred++;
    return;
  }
  if (!PULL_GENESIS_EVENT_TYPES.has(eventType)) {
    tally.skippedUnknownType++;
    return;
  }

  const envelope = asRecord(event.payload);
  const data = envelope ? asRecord(envelope.data) : null;
  if (!envelope || !data) {
    // A structurally-malformed event (no envelope/data object) cannot be
    // reconstructed at all — there is nothing to insert and nothing to preserve.
    // It is NOT a `failed` insert (no DB attempt was made, and an FK-style re-run
    // won't fix it); it belongs in the "couldn't extract what's needed" bucket.
    tally.skippedMissingProvenance++;
    return;
  }
  const timestamp = asString(envelope.timestamp);

  // dependency_added is a creation edge but NOT a firehose table — it has no
  // genesis provenance to preserve, so it is exempt from the provenance gate.
  if (eventType === 'dependency_added') {
    const fromId = asString(data.fromId);
    const toId = asString(data.toId);
    const type = asString(data.type);
    if (!fromId || !toId || !type) {
      record(tally, insertedByType, eventType, 'failed');
      return;
    }
    record(tally, insertedByType, eventType, insertDependencyRow(db, { fromId, toId, type }));
    return;
  }

  const provenance = extractProvenance(data, asString(envelope.projectId));
  if (!provenance) {
    tally.skippedMissingProvenance++;
    return;
  }

  let outcome: InsertOutcome;
  switch (eventType) {
    case 'decision_captured': {
      const id = asNumber(data.decisionId);
      if (id === null) {
        outcome = 'failed';
        break;
      }
      outcome = insertDecisionRow(
        db,
        {
          id,
          decisionText: asString(data.content),
          createdAt: timestamp,
          sprintId: asString(data.sprintId),
          missionId: asString(data.missionId),
          category: asString(data.category),
          sessionId: asString(data.sessionId),
          contentHash: asString(data.contentHash),
        },
        provenance
      );
      break;
    }
    case 'learning_captured': {
      const id = asNumber(data.learningId);
      if (id === null) {
        outcome = 'failed';
        break;
      }
      outcome = insertLearningRow(
        db,
        {
          id,
          content: asString(data.content),
          category: asString(data.category),
          status: 'active',
          sprintId: asString(data.sprintId),
          sessionId: asString(data.sessionId),
          missionId: asString(data.missionId),
          createdAt: timestamp ?? asString(data.capturedAt),
          contentHash: asString(data.contentHash),
        },
        provenance
      );
      break;
    }
    case 'mission_added': {
      const id = asString(data.missionId);
      if (!id) {
        outcome = 'failed';
        break;
      }
      outcome = insertMissionRow(
        db,
        {
          id,
          sprintId: emptyToNull(data.sprintId),
          name: asString(data.name),
          status: asString(data.status),
          objective: asString(data.objective),
          createdAt: timestamp ?? asString(data.addedAt),
        },
        provenance
      );
      break;
    }
    case 'sprint_added': {
      const id = asString(data.sprintId);
      if (!id) {
        outcome = 'failed';
        break;
      }
      outcome = insertSprintRow(db, { id, title: asString(data.title) }, provenance);
      break;
    }
    case 'session_started': {
      const id = asString(data.sessionId);
      if (!id) {
        outcome = 'failed';
        break;
      }
      outcome = insertSessionRow(
        db,
        {
          id,
          type: asString(data.type),
          title: asString(data.title),
          sprintId: emptyToNull(data.sprintId),
          startedAt: asString(data.startedAt) ?? timestamp,
          status: 'active',
        },
        provenance
      );
      break;
    }
    default:
      // Unreachable (guarded by PULL_GENESIS_EVENT_TYPES) — count defensively.
      tally.skippedUnknownType++;
      return;
  }
  record(tally, insertedByType, eventType, outcome);
}

/**
 * Apply a pulled mutable-surface transition to the local row via LWW (m04 inbound,
 * generic over scope as of s72 m02). The event type selects the scope + the data fields
 * carrying the entity id and the representative value (mission {missionId,currentStatus};
 * sprint {sprintId,status}). Frozen-genesis ordering (named transitions) vs fresh
 * per-edit ordering both feed `incomingWins`. An unrecognized/unparseable event is
 * counted as deferred (not applied) so it surfaces rather than silently vanishing.
 */
function applyInboundTransition(
  db: CmosDatabaseClient,
  event: PulledSyncEvent,
  tally: MergeTally
): void {
  const envelope = asRecord(event.payload);
  const data = envelope ? asRecord(envelope.data) : null;
  const fields = inboundMutableFieldsForEventType(event.eventType);
  if (!data || !fields) {
    tally.transitionsDeferred++;
    return;
  }
  const entityId =
    fields.fixedEntityId ?? (fields.entityKey ? asString(data[fields.entityKey]) : null);
  const value = asString(data[fields.valueKey]);
  if (!entityId || !value) {
    tally.transitionsDeferred++;
    return;
  }
  const outcome = applyInboundMutableStatus(db, fields.scope, {
    entityId,
    value,
    occurredAt: toProvenanceInt(data.occurredAt),
    originSeq: toProvenanceInt(data.originSeq),
    authorUserId: asString(data.authorUserId),
  });
  if (outcome === 'applied') {
    tally.transitionsApplied++;
  } else {
    tally.transitionsSkipped++;
  }
}

function record(
  tally: MergeTally,
  insertedByType: Record<string, number>,
  eventType: string,
  outcome: InsertOutcome
): void {
  if (outcome === 'inserted') {
    tally.inserted++;
    insertedByType[eventType] = (insertedByType[eventType] ?? 0) + 1;
  } else if (outcome === 'duplicate') {
    tally.duplicates++;
  } else {
    tally.failed++;
  }
}

/**
 * Reconstruct the origin genesis provenance from a pulled event's `data`.
 * Returns null when any of the three NOT-NULL-on-the-origin genesis values is
 * missing — such an event cannot be inserted as a faithful replica (it would
 * require minting fresh provenance, breaking identity), so the PULL skips it. The
 * clone bootstrap (m03) does NOT use this gate: /state provenance is legitimately
 * NULL in single-user mode and is preserved verbatim.
 * schema_version defaults to 1 when absent (no event type has bumped it).
 */
function extractProvenance(
  data: Record<string, unknown>,
  projectId: string | null
): GenesisProvenance | null {
  const stableEventId = asString(data.stableEventId);
  const occurredAt = toProvenanceInt(data.occurredAt);
  const originSeq = toProvenanceInt(data.originSeq);
  if (!projectId || !stableEventId || occurredAt === null || originSeq === null) {
    return null;
  }
  return {
    projectId,
    stableEventId,
    occurredAt,
    originSeq,
    schemaVersion: toProvenanceInt(data.schemaVersion) ?? 1,
  };
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

export function formatSyncPullForLLM(result: CmosToolResult<SyncPullResult>): string {
  if (!result.success) {
    return `PULL failed: ${result.error?.message ?? 'Unknown error'}`;
  }
  const d = result.data!;
  const lines = [
    `PULL complete (${d.slug})`,
    '',
    d.message,
    '',
    `Inserted: ${d.inserted} (${
      Object.entries(d.insertedByType)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ') || 'none'
    })`,
    `Duplicates: ${d.duplicates} | Transitions: ${d.transitionsApplied} applied, ` +
      `${d.transitionsSkipped} skipped, ${d.transitionsDeferred} deferred`,
  ];
  if (d.skippedMissingProvenance > 0 || d.skippedUnknownType > 0 || d.failed > 0) {
    lines.push(
      `Skipped: ${d.skippedMissingProvenance} no-provenance, ${d.skippedUnknownType} unknown-type, ${d.failed} failed`
    );
  }
  if (d.warnings && d.warnings.length > 0) {
    lines.push('', ...d.warnings.map((w) => `⚠ ${w}`));
  }
  return lines.join('\n');
}
