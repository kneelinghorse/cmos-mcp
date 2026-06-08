// ABOUTME: Sprint 71 m03 — clone/bootstrap a shared project from GET /state.
// ABOUTME: Reconstructs a local SQLite store from the dashboard's full-state
// ABOUTME: snapshot (correct CURRENT mutable status) and seeds the PULL cursor.

/**
 * Clone-from-/state bootstrap (Sprint 71 m03, UC1 critical path).
 *
 * GET /api/sync/projects/:slug/state returns the dashboard's full snapshot of a
 * shared project — the CURRENT mutable state of every entity (mission/sprint/
 * session status), which an event replay cannot reconstruct: the m02 PULL consumer
 * defers transition events, so a from-cursor-0 replay would leave status stuck at
 * creation values. This bootstrap insert-unions that snapshot into a local store,
 * then seeds the per-project PULL cursor to syncLog.maxCursor so the follow-on
 * incremental pull (m02, ?since=maxCursor) fetches ONLY newer events.
 *
 * REUSE — the per-entity insert-union lives once in sync-merge.ts and is shared
 * with the m02 PULL consumer (s71-m03 criterion: no duplicate insert logic). This
 * path only maps the /state row field names onto the shared normalized row shape;
 * unlike the PULL (genesis-only, append-only), the clone carries each entity's
 * current status/focus/timestamps — that is the whole reason /state is the source.
 *
 * PROVENANCE — preserved verbatim, never re-stamped (same posture as m02). /state
 * carries genesis provenance as { stableEventId, occurredAt, originSeq,
 * schemaVersion }, where occurredAt/originSeq are BIGINT STRINGS (raw ms-epoch, no
 * coercion) and all four are NULL in single-user mode today. A clone preserves the
 * NULL — it does NOT mint fresh provenance. This means the clone target must be a
 * fresh/un-migrated store (seed-schema genesis columns are nullable); a store whose
 * firehose migration already upgraded those columns to NOT NULL cannot hold a
 * NULL-provenance row, so such rows fail-and-count loudly rather than synthesize.
 *
 * IDENTITY — the clone stamps rows with the store's project_id (existing
 * metadata.project_id, else seeded from /state.project.id) and records the
 * dashboard linkage (dashboard_slug, dashboard_project_id) when absent so the
 * follow-on `cmos_db pull` resolves the same slug. Existing identity is never
 * clobbered.
 *
 * FK INTEGRITY — /state omits context bodies (the mirror stores no content), so the
 * bootstrap ensures placeholder context rows exist (always incl. 'master_context')
 * before inserting decisions, whose context_id FK would otherwise fail. Context
 * BODIES are not cloned from /state — that is surfaced as a warning.
 *
 * READ-ONLY against the dashboard; only the local store is written.
 *
 * @module tools/cmos/sync-bootstrap
 */

import { withClientAsync, type CmosDatabaseClient } from './client';
import { DashboardClient, type SyncProjectStateResult } from './dashboard-client';
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
  asString,
  asNumber,
  emptyToNull,
  toProvenanceInt,
} from './sync-merge';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SyncBootstrapParams {
  projectRoot?: string;
  /** Dashboard slug to clone. Defaults to metadata.dashboard_slug. */
  slug?: string;
}

export interface SyncBootstrapResult {
  slug: string;
  /** The project_id stamped onto every cloned row (cross-store aggregation key). */
  projectId: string;
  /** The per-project PULL cursor seeded from the snapshot's syncLog.maxCursor. */
  cursorSeeded: number;
  /** Rows newly inserted (ON CONFLICT no-op excluded). */
  inserted: number;
  /** Rows already present locally (idempotent re-clone). */
  duplicates: number;
  /** Rows whose local insert errored (e.g. NOT NULL on a migrated store) — counted. */
  failed: number;
  /** Newly-inserted count keyed by genesis event type. */
  insertedByType: Record<string, number>;
  /** Context rows created to satisfy FK integrity (bodies NOT cloned from /state). */
  contextsEnsured: number;
  message: string;
  warnings?: string[];
}

interface BootstrapTally {
  inserted: number;
  duplicates: number;
  failed: number;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export async function syncBootstrap(
  params: SyncBootstrapParams
): Promise<CmosToolResult<SyncBootstrapResult>> {
  // Membership-scoped — resolve the credential the same way the PULL path does, so
  // an owner/editor authenticates correctly for a shared project.
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
            'No dashboard slug available to clone: the project is not registered (metadata.dashboard_slug is unset).',
          suggestion: 'Pass an explicit slug to clone, or register the project first.',
        });
      }

      const stateResult = await dashboardClient.getSyncProjectState(slug);
      if (!stateResult.success || !stateResult.data) {
        return createError(
          stateResult.error ?? CmosErrors.dashboardError('Failed to fetch /state snapshot')
        );
      }
      const state = stateResult.data;

      const warnings: string[] = [];

      // Clone identity: stamp rows with the store's project_id, seeding it from the
      // snapshot for a fresh store; never clobber existing identity.
      const projectId = ensureCloneIdentity(db, state, slug);

      const tally: BootstrapTally = { inserted: 0, duplicates: 0, failed: 0 };
      const insertedByType: Record<string, number> = {};
      const rec = (eventType: string, outcome: InsertOutcome): void => {
        if (outcome === 'inserted') {
          tally.inserted++;
          insertedByType[eventType] = (insertedByType[eventType] ?? 0) + 1;
        } else if (outcome === 'duplicate') {
          tally.duplicates++;
        } else {
          tally.failed++;
        }
      };
      const provOf = (r: {
        stableEventId: string | null;
        occurredAt: string | null;
        originSeq: string | null;
        schemaVersion: number | null;
      }): GenesisProvenance => ({
        projectId,
        stableEventId: r.stableEventId ?? null,
        occurredAt: toProvenanceInt(r.occurredAt),
        originSeq: toProvenanceInt(r.originSeq),
        schemaVersion: r.schemaVersion ?? null,
      });

      // FK integrity: ensure context rows exist (decisions.context_id FK). /state
      // omits context bodies, so seed placeholders; always guarantee master_context.
      const contextsEnsured = ensureContexts(db, state.contexts);
      if (state.decisions && state.decisions.length > 0) {
        warnings.push(
          'Context bodies are not carried by GET /state (the mirror stores no content); ' +
            'placeholder context rows were created for FK integrity only.'
        );
      }

      // Insert order respects FKs: sprints → sessions → missions → decisions →
      // learnings → dependencies (missions/sessions ref sprints; decisions/learnings
      // ref sprints/sessions/missions; dependencies ref missions).
      for (const s of state.sprints ?? []) {
        const id = asString(s.id);
        if (!id) {
          rec('sprint_added', 'failed');
          continue;
        }
        rec(
          'sprint_added',
          insertSprintRow(
            db,
            {
              id,
              title: asString(s.title),
              status: asString(s.status),
              focus: asString(s.focus),
              totalMissions: asNumber(s.totalMissions),
              completedMissions: asNumber(s.completedMissions),
            },
            provOf(s)
          )
        );
      }

      for (const se of state.sessions ?? []) {
        const id = asString(se.id);
        if (!id) {
          rec('session_started', 'failed');
          continue;
        }
        rec(
          'session_started',
          insertSessionRow(
            db,
            {
              id,
              type: asString(se.type),
              title: asString(se.title),
              startedAt: asString(se.startedAt),
              completedAt: asString(se.completedAt),
              // sessions.status is NOT NULL — fall back to 'active' if the snapshot omits it.
              status: asString(se.status) ?? 'active',
            },
            provOf(se)
          )
        );
      }

      for (const m of state.missions ?? []) {
        const id = asString(m.id);
        if (!id) {
          rec('mission_added', 'failed');
          continue;
        }
        rec(
          'mission_added',
          insertMissionRow(
            db,
            {
              id,
              sprintId: emptyToNull(m.sprintId),
              name: asString(m.name),
              status: asString(m.status),
              objective: asString(m.objective),
              startedAt: asString(m.startedAt),
              completedAt: asString(m.completedAt),
            },
            provOf(m)
          )
        );
      }

      for (const dec of state.decisions ?? []) {
        const id = asNumber(dec.id);
        if (id === null) {
          rec('decision_captured', 'failed');
          continue;
        }
        rec(
          'decision_captured',
          insertDecisionRow(
            db,
            {
              id,
              decisionText: asString(dec.decisionText),
              createdAt: asString(dec.createdAt),
              sprintId: asString(dec.sprintId),
              missionId: asString(dec.missionId),
              category: asString(dec.category),
              sessionId: asString(dec.sessionId),
              contentHash: null, // /state omits content_hash
            },
            provOf(dec)
          )
        );
      }

      for (const l of state.learnings ?? []) {
        const id = asNumber(l.id);
        if (id === null) {
          rec('learning_captured', 'failed');
          continue;
        }
        rec(
          'learning_captured',
          insertLearningRow(
            db,
            {
              id,
              content: asString(l.content),
              category: asString(l.category),
              status: 'active',
              sprintId: asString(l.sprintId),
              sessionId: null, // /state omits author_session_id on learnings
              missionId: null, // /state omits mission_id on learnings
              createdAt: asString(l.createdAt),
              contentHash: null, // /state omits content_hash
            },
            provOf(l)
          )
        );
      }

      for (const dep of state.dependencies ?? []) {
        const fromId = asString(dep.fromId);
        const toId = asString(dep.toId);
        const type = asString(dep.type);
        if (!fromId || !toId || !type) {
          rec('dependency_added', 'failed');
          continue;
        }
        rec('dependency_added', insertDependencyRow(db, { fromId, toId, type }));
      }

      // Seed the PULL cursor to the snapshot high-water mark so the follow-on
      // incremental pull fetches only newer events. Never regress an existing cursor.
      const maxCursor = state.syncLog?.maxCursor ?? 0;
      const cursorSeeded = Math.max(readPullCursor(db, slug), maxCursor);
      persistPullCursor(db, slug, cursorSeeded);
      if (state.syncLog?.maxCursor === undefined) {
        warnings.push(
          'GET /state did not return syncLog.maxCursor; the PULL cursor was left at ' +
            `${cursorSeeded}. A follow-on incremental pull would re-drain from there.`
        );
      }

      if (tally.failed > 0) {
        warnings.push(
          `${tally.failed} row(s) failed to insert locally. On a store whose firehose ` +
            `migration already made the provenance columns NOT NULL, a snapshot row with NULL ` +
            `provenance (single-user mode) cannot be stored without re-stamping — which the ` +
            `preserve-verbatim contract forbids. Clone into a fresh/un-migrated store.`
        );
      }

      return createSuccess<SyncBootstrapResult>({
        slug,
        projectId,
        cursorSeeded,
        inserted: tally.inserted,
        duplicates: tally.duplicates,
        failed: tally.failed,
        insertedByType,
        contextsEnsured,
        message:
          `Cloned '${slug}' from /state: ${tally.inserted} inserted, ` +
          `${tally.duplicates} duplicate(s)` +
          (tally.failed > 0 ? `, ${tally.failed} failed` : '') +
          `. PULL cursor seeded to ${cursorSeeded}` +
          (maxCursor > 0 ? ` (snapshot MAX(cmos_sync_log.id))` : '') +
          `.`,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Identity + context FK helpers ───────────────────────────────────────────────

function readMetadataValue(db: CmosDatabaseClient, key: string): string | null {
  const row = db.getOne<{ value: string }>(`SELECT value FROM metadata WHERE key = ?`, [key]);
  return row.success && row.data?.value ? row.data.value : null;
}

function setIfEmpty(db: CmosDatabaseClient, key: string, value: string): void {
  if (!value) return;
  if (readMetadataValue(db, key)) return;
  db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, [key, value]);
}

/**
 * Resolve the project_id to stamp on cloned rows, seeding the store's dashboard
 * linkage when absent. Prefers the store's existing project_id (a clone targeting
 * its own store), else the snapshot's project.id. Never clobbers existing identity.
 */
function ensureCloneIdentity(
  db: CmosDatabaseClient,
  state: SyncProjectStateResult,
  slug: string
): string {
  const existing = readMetadataValue(db, 'project_id');
  const projectId = existing && existing.length > 0 ? existing : state.project.id;
  setIfEmpty(db, 'project_id', projectId);
  setIfEmpty(db, 'project_name', asString(state.project.name) ?? '');
  setIfEmpty(db, 'dashboard_slug', slug);
  setIfEmpty(db, 'dashboard_project_id', asString(state.project.id) ?? '');
  // Mark the clone as a collaborative store so its mutable edits route through the
  // m04 pull-before-push event path (and its pulls apply inbound transitions via
  // LWW) instead of the solo whole-DB file-sync. Default 'editor' — a clone, by
  // definition, received a shared project; author_user_id is dashboard-authoritative
  // so the value never misattributes authorship, and the gate only needs presence.
  // See cmos/docs/multiuser-collab-client.md §4 (Fork A). 'collab_role' = COLLAB_ROLE_KEY.
  setIfEmpty(db, 'collab_role', 'editor');
  return projectId;
}

/**
 * Ensure a context row exists for every context id referenced by the snapshot, plus
 * 'master_context' (the strategic_decisions.context_id default + FK target). /state
 * carries no context body, so source_path/content are placeholders — the row exists
 * purely so decision/snapshot foreign keys hold. Returns the count newly created.
 */
function ensureContexts(
  db: CmosDatabaseClient,
  contexts?: { id: string; updatedAt: string | null }[]
): number {
  const ids = new Set<string>(['master_context']);
  for (const c of contexts ?? []) {
    const id = asString(c.id);
    if (id) ids.add(id);
  }
  let created = 0;
  for (const id of ids) {
    const res = db.execute(
      `INSERT INTO contexts (id, source_path, content) VALUES (?, ?, '{}')
       ON CONFLICT(id) DO NOTHING`,
      [id, id]
    );
    if (res.success && res.data && res.data.changes > 0) created++;
  }
  return created;
}

// ─── LLM Formatter ─────────────────────────────────────────────────────────────

export function formatSyncBootstrapForLLM(result: CmosToolResult<SyncBootstrapResult>): string {
  if (!result.success) {
    return `Clone failed: ${result.error?.message ?? 'Unknown error'}`;
  }
  const d = result.data!;
  const lines = [
    `Clone complete (${d.slug})`,
    '',
    d.message,
    '',
    `Inserted: ${d.inserted} (${
      Object.entries(d.insertedByType)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ') || 'none'
    })`,
    `Duplicates: ${d.duplicates} | Cursor seeded: ${d.cursorSeeded} | Contexts ensured: ${d.contextsEnsured}`,
  ];
  if (d.failed > 0) {
    lines.push(`Failed: ${d.failed}`);
  }
  if (d.warnings && d.warnings.length > 0) {
    lines.push('', ...d.warnings.map((w) => `⚠ ${w}`));
  }
  return lines.join('\n');
}
