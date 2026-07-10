// ABOUTME: cmos_db backfill action — replays CMOS state as sync events to the dashboard PG mirror.
// ABOUTME: Includes large-delta guard, per-request timeout, overall wall-clock timeout, and progress logging.

/**
 * cmos_db backfill action
 *
 * Replays existing CMOS state (sprints, missions, sessions, decisions)
 * as sync events so the dashboard has the full project picture.
 *
 * Idempotency: Tracks a `backfill_cursor` in the metadata table.
 * Re-running only pushes events with timestamps after the cursor.
 * Use `force: true` to replay everything regardless of cursor.
 *
 * Reliability:
 * - Large-delta guard: skips push when any table exceeds LARGE_DELTA_THRESHOLD (50) records.
 *   Instructs the user to re-upload the SQLite file instead.
 * - Per-request timeout: each HTTP push aborts after PER_REQUEST_TIMEOUT_MS (30s).
 * - Overall timeout: the push loop aborts after OVERALL_TIMEOUT_MS (120s) wall-clock time.
 * - Progress logging: reports pushed/failed/remaining to stderr every PROGRESS_LOG_INTERVAL events.
 *
 * @module tools/cmos/cmos-db-backfill
 */

import * as path from 'path';
import { withClientAsync, type CmosDatabaseClient } from './client';
import { DashboardClient } from './dashboard-client';
import { createError, createSuccess, CmosErrors } from './errors';
import type { CmosToolResult } from './types';
import { migrateContentHash, computeContentHash } from './schema-migrations';

// ─── Types ───────────────────────────────────────────────────────────────────

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum per-table event delta before skipping push and recommending SQLite re-upload.
 * Exported so tests can reference the boundary without magic numbers.
 */
export const LARGE_DELTA_THRESHOLD = 50;

/** Per-request HTTP timeout for sync event pushes (ms). */
const PER_REQUEST_TIMEOUT_MS = 30_000;

/** Maximum wall-clock time for a full backfill run (ms). */
const OVERALL_TIMEOUT_MS = 120_000;

/** Log a progress line every N events pushed/failed. */
const PROGRESS_LOG_INTERVAL = 10;

/**
 * Event types to suppress on the event-replay path because the dashboard PG
 * mirror cannot ingest them yet (it would HTTP 400).
 *
 * EMPTY as of dashboard migration 029 (dashboard msg bbf75ca1, 2026-05-31):
 * next_step_created / constraint_added / snapshot_taken now have mirror tables
 * (cmos_next_steps / cmos_constraints / cmos_context_snapshots, keyed
 * (project_id, id)) and are ingested on BOTH the event-replay and file-based
 * paths — so nothing is suppressed today and a force backfill reconciles the
 * full firehose. This supersedes the temporary suppression added for the Q3 gap
 * (dashboard msg 03064b74; carry-forward #770).
 *
 * The mechanism stays as a version-skew valve: if the client ever emits a new
 * genesis event type before the dashboard ingests it, add it here to suppress it
 * on the fallback event-replay path until the dashboard catches up. Exported so
 * tests can assert the gate.
 */
export const DASHBOARD_UNSUPPORTED_EVENT_TYPES: ReadonlySet<string> = new Set<string>();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CmosDbBackfillParams {
  projectRoot?: string;
  /** Force full backfill, ignoring cursor */
  force?: boolean;
  /** Dry run: count events without pushing */
  dryRun?: boolean;
  /** Per-request HTTP timeout in ms (default: 30_000). Override in tests for fast abort. */
  perRequestTimeoutMs?: number;
  /** Overall wall-clock timeout for the full push loop (ms, default: 120_000). */
  overallTimeoutMs?: number;
  /**
   * Test hook: inject a replacement for Date.now() to make timeout checks deterministic.
   * Never set this in production code.
   */
  _getNow?: () => number;
}

export interface CmosDbBackfillResult {
  mode: 'backfill';
  dryRun: boolean;
  totalEvents: number;
  pushed: number;
  failed: number;
  skipped: number;
  breakdown: {
    sprints: number;
    missions: number;
    sessions: number;
    decisions: number;
    learnings: number;
    dependencies: number;
  };
  cursor: string | null;
  previousCursor: string | null;
  message: string;
  /** Number of duplicate events skipped by content hash dedup */
  deduped: number;
  /** Warnings about identity repair or other issues */
  warnings?: string[];
}

// ─── DB Row Types ────────────────────────────────────────────────────────────

/**
 * The genesis provenance columns (s68 ADR §1, stamped on every firehose row by
 * genesisColumns) carried by the 5 emitted firehose row types. s71-m01 (decision
 * #777) surfaces them in the outbound event `data` so the dashboard's migration-024
 * mirror can order LWW-by-(occurred_at, origin_seq) on the shared mutable surface
 * instead of falling back to synced_at. s71-m02 adds `schema_version` so the full
 * genesis set round-trips for the PULL consumer, which reconstructs a replica row
 * carrying the origin's provenance verbatim (NOT re-stamped). The other two genesis
 * columns — event_type and project_id — already ride on the envelope top-level
 * (eventType / projectId), so they are not duplicated here. Optional because a row
 * written before the firehose migration won't have them — the dashboard reads NULL
 * provenance as "fall back to synced_at", so it degrades cleanly. author_user_id is
 * deliberately NOT here: it stays dashboard-authoritative (stamped on PUSH).
 */
interface GenesisProvenanceRow {
  stable_event_id?: string | null;
  occurred_at?: number | null;
  origin_seq?: number | null;
  schema_version?: number | null;
}

interface SprintRow extends GenesisProvenanceRow {
  id: string;
  title: string;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  total_missions: number | null;
  completed_missions: number | null;
}

interface MissionRow extends GenesisProvenanceRow {
  id: string;
  sprint_id: string | null;
  name: string;
  status: string;
  notes: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface SessionRow extends GenesisProvenanceRow {
  id: string;
  type: string;
  title: string;
  sprint_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  summary: string | null;
  next_steps: string | null;
  captures: string | null;
}

interface DecisionRow extends GenesisProvenanceRow {
  id: number;
  decision_text: string;
  sprint_id: string | null;
  // s69-m04: column renamed session_id → author_session_id. SELECT * surfaces
  // whichever the store carries; both are optional so a migrated DB (only
  // author_session_id) and a legacy snapshot (only session_id) both type-check.
  author_session_id?: string | null;
  session_id?: string | null;
  mission_id: string | null;
  project_domain: string | null;
  created_at: string;
  content_hash: string | null;
}

interface LearningRow extends GenesisProvenanceRow {
  id: number;
  content: string;
  category: string | null;
  status: string;
  sprint_id: string | null;
  // s69-m04: see DecisionRow — session_id renamed to author_session_id.
  author_session_id?: string | null;
  session_id?: string | null;
  mission_id: string | null;
  created_at: string;
  content_hash: string | null;
}

interface DependencyRow {
  from_id: string;
  to_id: string;
  type: string;
  from_created_at: string | null;
}

interface MetadataRow {
  value: string;
}

// ─── Backfill Event ──────────────────────────────────────────────────────────

interface BackfillEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Project identity for sync envelope construction */
interface ProjectIdentity {
  projectId: string;
  projectName: string;
}

/** Build a sync envelope for the dashboard push API */
function buildSyncEnvelope(
  identity: ProjectIdentity,
  eventType: string,
  timestamp: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  return {
    projectId: identity.projectId,
    projectName: identity.projectName,
    eventType,
    timestamp,
    data,
  };
}

/**
 * Extract the genesis provenance fields (s71-m01 decision #777; schema_version
 * added s71-m02) from a firehose row into the outbound event `data`. camelCase
 * keys to match the existing data builders — the dashboard accepts camelCase OR
 * snake_case (msg 03064b74 Q1). Null when the row predates the firehose migration;
 * the dashboard reads NULL as "fall back to synced_at". occurred_at rides here in
 * `data` as raw ms-epoch, NEVER in the envelope `timestamp` (which must stay ISO
 * 8601 or the dashboard 400s the event).
 */
function provenanceData(row: GenesisProvenanceRow): {
  stableEventId: string | null;
  occurredAt: number | null;
  originSeq: number | null;
  schemaVersion: number | null;
} {
  return {
    stableEventId: row.stable_event_id ?? null,
    occurredAt: row.occurred_at ?? null,
    originSeq: row.origin_seq ?? null,
    schemaVersion: row.schema_version ?? null,
  };
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Resolve a DashboardClient for cmos_db sync operations.
 *
 * Routes through fromEnvForProject so the MCP-tool path authenticates with the
 * Sprint 57 credential-store key (the device-code / project-scoped cmk_ token,
 * used as a permanent Bearer) — no CMOS_DASHBOARD_* env vars required.
 * fromEnvForProject is a strict superset of fromEnv: it still falls back to the
 * legacy CMOS_DASHBOARD_API_KEY and USER+PASSWORD env vars (steps 4-5) for
 * standalone script/CI callers that run without a local credential store.
 *
 * s73 review finding: cmos_db backfill/reconcile/identify_orphans/purge were the
 * last sync surface still on env-only auth via fromEnv; every other sync path
 * (cmos_status, sync-pull, sync-mutable-push, sync-locks, checkpoint-backfill,
 * cmos_message) already resolves through the credential store. This closes that
 * gap, so a scrubbed .env (key-only auth) no longer breaks cmos_db.
 */
async function resolveSyncClient(
  projectRoot: string | undefined,
  overrides?: { timeoutMs?: number }
): Promise<CmosToolResult<DashboardClient>> {
  const result = await DashboardClient.fromEnvForProject(projectRoot, overrides);
  if (!result.success || !result.data) {
    return createError(result.error ?? CmosErrors.dashboardNotConfigured());
  }
  return createSuccess(result.data.client);
}

export async function cmosDbBackfill(
  params: CmosDbBackfillParams
): Promise<CmosToolResult<CmosDbBackfillResult>> {
  // Resolve the dashboard client (credential store first, env fallback);
  // honour per-request timeout override
  const clientResult = await resolveSyncClient(params.projectRoot, {
    timeoutMs: params.perRequestTimeoutMs ?? PER_REQUEST_TIMEOUT_MS,
  });
  if (!clientResult.success || !clientResult.data) {
    return createError(CmosErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      const identity = getProjectIdentity(db);
      const previousCursor = getCursor(db);
      // force=true bypasses the large-delta guard but still resumes from the cursor.
      // Starting from scratch on every force run means the timeout always hits the same
      // early events and the cursor can never advance past them (or worse, regresses).
      // True "replay from scratch" can be achieved by clearing the cursor first.
      const since = previousCursor;

      // s81-m01: when file-based sync fails and we drop to the slower event-replay
      // path below, capture WHY so it surfaces as a structured warnings[] entry on
      // the result — not stderr-only. A silent fallback masked the #391 choke as a
      // slow-but-succeeding backfill; the warning makes the degraded path audible.
      let fileSyncFallbackWarning: string | null = null;

      // File-based sync: if the project is registered (has a dashboard_slug), use
      // POST /api/sync/sqlite-backfill instead of event-replay. One HTTP call handles
      // any number of records without timeout or cursor issues.
      if (!params.dryRun) {
        const slugResult = db.getOne<MetadataRow>(
          `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
        );
        const slug = (slugResult.success && slugResult.data?.value) || null;
        if (slug) {
          // s81-m02: keep the STRICT expectedSlug=derive(project_name) guard on this
          // explicit-backfill path. Unlike the checkpoint path, cmosDbBackfill has no
          // reconcile/confirm step, so it cannot safely relax the guard against a possibly
          // stale dashboard_slug. When project_name diverges from the incumbent slug the
          // file-sync is refused (EXPECTED_SLUG_MISMATCH) and we fall through to
          // event-replay below, which keys by metadata.project_id (the stable local key) —
          // so a divergent-name store still syncs to the RIGHT project and never
          // mis-routes. (defect-3's getProjectIdentity keeps project_name consistent with
          // dashboard_slug when it was missing, so the common registered case still
          // file-syncs.)
          const fileResult = await dashboardClient.syncSqliteFile(
            db.path,
            slug,
            deriveProjectSlug(identity.projectName)
          );
          if (fileResult.success && fileResult.data) {
            const d = fileResult.data;
            const counts = d.counts ?? {};
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            return createSuccess<CmosDbBackfillResult>({
              mode: 'backfill',
              dryRun: false,
              totalEvents: total,
              pushed: total,
              failed: d.errors.length,
              skipped: 0,
              deduped: 0,
              breakdown: {
                sprints: counts['sprints'] ?? 0,
                missions: counts['missions'] ?? 0,
                sessions: counts['sessions'] ?? 0,
                decisions: counts['decisions'] ?? 0,
                learnings: counts['learnings'] ?? 0,
                dependencies: counts['dependencies'] ?? 0,
              },
              cursor: null,
              previousCursor,
              message:
                `File-based sync complete (${d.durationMs}ms): ${total} record(s) synced` +
                (d.errors.length > 0 ? `, ${d.errors.length} error(s)` : '') +
                `. Sprints: ${counts['sprints'] ?? 0}, missions: ${counts['missions'] ?? 0}, sessions: ${counts['sessions'] ?? 0}, decisions: ${counts['decisions'] ?? 0}, learnings: ${counts['learnings'] ?? 0}.`,
            });
          }
          // File sync failed — fall through to event-replay as fallback
          const fileSyncErr = fileResult.error?.message ?? 'unknown';
          fileSyncFallbackWarning =
            `File-based sync failed (slug: ${slug}) — fell back to slower event-replay: ${fileSyncErr}. ` +
            'The dashboard mirror was still updated via event-replay, but this path is cursor-bound and slower; ' +
            'investigate the file-sync failure if it recurs.';
          console.error(`[backfill] ${fileSyncFallbackWarning}`);
        }
      }

      // Ensure content_hash columns exist and are populated
      migrateContentHash(db);

      const warnings: string[] = [];
      // s81-m01: surface the file-sync→event-replay fallback (captured above) so the
      // degraded path is visible on the tool response, not just stderr. Ordered first
      // so it leads the warnings list when it fires.
      if (fileSyncFallbackWarning) {
        warnings.push(fileSyncFallbackWarning);
      }
      if (identity.repaired) {
        warnings.push(
          `Project metadata was empty — repaired from ${identity.repairSource} (id: ${identity.projectId}, name: ${identity.projectName})`
        );
      } else if (identity.projectId === 'unknown') {
        warnings.push(
          'Project identity is still "unknown" after repair attempts. ' +
            'Run cmos_project(action="register", projectRoot="<path>", name="<name>") to set identity.'
        );
      }

      const events: BackfillEvent[] = [];
      const breakdown = {
        sprints: 0,
        missions: 0,
        sessions: 0,
        decisions: 0,
        learnings: 0,
        dependencies: 0,
        nextSteps: 0,
        constraints: 0,
        snapshots: 0,
      };

      // 1. Sprints
      const sprintsResult = db.getMany<SprintRow>(`SELECT * FROM sprints ORDER BY id`);
      if (sprintsResult.success && sprintsResult.data) {
        for (const sprint of sprintsResult.data) {
          const ts = sprint.start_date ?? sprint.end_date ?? new Date().toISOString();
          if (since && ts <= since) continue;

          events.push({
            type: 'sprint_added',
            timestamp: ts,
            data: { sprintId: sprint.id, title: sprint.title, ...provenanceData(sprint) },
          });
          breakdown.sprints++;

          if (sprint.status === 'Completed' && sprint.end_date) {
            events.push({
              type: 'sprint_completed',
              timestamp: sprint.end_date,
              data: {
                sprintId: sprint.id,
                previousStatus: 'Active',
                completedAt: sprint.end_date,
                lifecycle: {
                  kpis: {
                    totalMissions: sprint.total_missions,
                    completedMissions: sprint.completed_missions,
                  },
                },
                ...provenanceData(sprint),
              },
            });
            breakdown.sprints++;
          }
        }
      }

      // 2. Missions
      const missionsResult = db.getMany<MissionRow>(
        `SELECT * FROM missions ORDER BY COALESCE(created_at, started_at, completed_at, id)`
      );
      if (missionsResult.success && missionsResult.data) {
        for (const mission of missionsResult.data) {
          const createdTs = mission.created_at ?? mission.started_at ?? new Date().toISOString();
          if (since && createdTs <= since) continue;

          // Always emit mission_added so every mission gets a PG row
          events.push({
            type: 'mission_added',
            timestamp: createdTs,
            data: {
              missionId: mission.id,
              name: mission.name,
              sprintId: mission.sprint_id ?? '',
              status: mission.status,
              objective: mission.notes ?? null,
              successCriteria: null,
              deliverables: null,
              addedAt: createdTs,
              ...provenanceData(mission),
            },
          });
          breakdown.missions++;

          if (mission.started_at) {
            events.push({
              type: 'mission_started',
              timestamp: mission.started_at,
              data: {
                missionId: mission.id,
                previousStatus: 'Queued',
                currentStatus: 'In Progress',
                sprintId: mission.sprint_id,
                notes: null,
                transitionAt: mission.started_at,
                ...provenanceData(mission),
              },
            });
            breakdown.missions++;
          }

          if (mission.status === 'Completed' && mission.completed_at) {
            events.push({
              type: 'mission_completed',
              timestamp: mission.completed_at,
              data: {
                missionId: mission.id,
                previousStatus: 'In Progress',
                currentStatus: 'Completed',
                completedAt: mission.completed_at,
                ...provenanceData(mission),
              },
            });
            breakdown.missions++;
          }

          if (mission.status === 'Blocked') {
            events.push({
              type: 'mission_blocked',
              timestamp: createdTs,
              data: {
                missionId: mission.id,
                previousStatus: 'In Progress',
                currentStatus: 'Blocked',
                reason: mission.notes ?? 'Unknown',
                ...provenanceData(mission),
              },
            });
            breakdown.missions++;
          }
        }
      }

      // 3. Sessions
      const sessionsResult = db.getMany<SessionRow>(`SELECT * FROM sessions ORDER BY started_at`);
      if (sessionsResult.success && sessionsResult.data) {
        for (const session of sessionsResult.data) {
          if (since && session.started_at <= since) continue;

          events.push({
            type: 'session_started',
            timestamp: session.started_at,
            data: {
              sessionId: session.id,
              type: session.type,
              title: session.title,
              startedAt: session.started_at,
              sprintId: session.sprint_id,
              ...provenanceData(session),
            },
          });
          breakdown.sessions++;

          if (session.status === 'completed' && session.completed_at) {
            let captureCount = 0;
            let nextSteps: string[] | null = null;
            try {
              captureCount = JSON.parse(session.captures ?? '[]').length;
            } catch {
              /* ignore */
            }
            try {
              nextSteps = session.next_steps ? JSON.parse(session.next_steps) : null;
            } catch {
              /* ignore */
            }

            events.push({
              type: 'session_completed',
              timestamp: session.completed_at,
              data: {
                sessionId: session.id,
                completedAt: session.completed_at,
                summary: session.summary,
                captureCount,
                nextSteps,
                ...provenanceData(session),
              },
            });
            breakdown.sessions++;
          }
        }
      }

      // 4. Decisions (with content hash dedup)
      const seenDecisionHashes = new Set<string>();
      let deduped = 0;
      const decisionsResult = db.getMany<DecisionRow>(
        `SELECT * FROM strategic_decisions ORDER BY created_at`
      );
      if (decisionsResult.success && decisionsResult.data) {
        for (const decision of decisionsResult.data) {
          if (since && decision.created_at <= since) continue;

          // Compute or use stored content hash for dedup
          const hash =
            decision.content_hash ??
            computeContentHash(decision.decision_text, decision.project_domain ?? 'general');
          if (seenDecisionHashes.has(hash)) {
            deduped++;
            continue;
          }
          seenDecisionHashes.add(hash);

          events.push({
            type: 'decision_captured',
            timestamp: decision.created_at,
            data: {
              decisionId: decision.id,
              sessionId: decision.author_session_id ?? decision.session_id ?? '',
              category: 'decision',
              content: decision.decision_text,
              contentHash: hash,
              missionId: decision.mission_id,
              sprintId: decision.sprint_id,
              ...provenanceData(decision),
            },
          });
          breakdown.decisions++;
        }
      }

      // 5. Learnings (with content hash dedup)
      const seenLearningHashes = new Set<string>();
      const learningsResult = db.getMany<LearningRow>(
        `SELECT * FROM learnings ORDER BY created_at`
      );
      if (learningsResult.success && learningsResult.data) {
        for (const learning of learningsResult.data) {
          if (since && learning.created_at <= since) continue;

          // Compute or use stored content hash for dedup
          const hash =
            learning.content_hash ?? computeContentHash(learning.content, learning.category ?? '');
          if (seenLearningHashes.has(hash)) {
            deduped++;
            continue;
          }
          seenLearningHashes.add(hash);

          events.push({
            type: 'learning_captured',
            timestamp: learning.created_at,
            data: {
              learningId: learning.id,
              content: learning.content,
              contentHash: hash,
              sessionId: learning.author_session_id ?? learning.session_id ?? '',
              sprintId: learning.sprint_id,
              missionId: learning.mission_id,
              capturedAt: learning.created_at,
              ...provenanceData(learning),
            },
          });
          breakdown.learnings++;
        }
      }

      // 6. Dependencies (join with missions to get a timestamp)
      const dependenciesResult = db.getMany<DependencyRow>(
        `SELECT d.from_id, d.to_id, d.type, m.created_at AS from_created_at
         FROM mission_dependencies d
         LEFT JOIN missions m ON d.from_id = m.id
         ORDER BY COALESCE(m.created_at, d.from_id)`
      );
      if (dependenciesResult.success && dependenciesResult.data) {
        for (const dep of dependenciesResult.data) {
          const ts = dep.from_created_at ?? new Date().toISOString();
          if (since && ts <= since) continue;

          events.push({
            type: 'dependency_added',
            timestamp: ts,
            data: {
              fromId: dep.from_id,
              toId: dep.to_id,
              type: dep.type,
            },
          });
          breakdown.dependencies++;
        }
      }

      // 7. Next steps (s69-m03 §2.5 sync-emitter parity for next_step_created)
      const nextStepsResult = db.getMany<{
        id: number;
        content: string;
        status: string;
        session_id: string | null;
        sprint_id: string | null;
        mission_id: string | null;
        created_at: string;
      }>(
        `SELECT id, content, status, session_id, sprint_id, mission_id, created_at FROM next_steps ORDER BY created_at`
      );
      if (nextStepsResult.success && nextStepsResult.data) {
        for (const step of nextStepsResult.data) {
          if (since && step.created_at <= since) continue;
          events.push({
            type: 'next_step_created',
            timestamp: step.created_at,
            data: {
              nextStepId: step.id,
              content: step.content,
              status: step.status,
              sessionId: step.session_id ?? '',
              sprintId: step.sprint_id,
              missionId: step.mission_id,
            },
          });
          breakdown.nextSteps++;
        }
      }

      // 8. Constraints (s69-m03 §2.5 sync-emitter parity for constraint_added)
      const constraintsResult = db.getMany<{
        id: number;
        content: string;
        status: string;
        session_id: string | null;
        sprint_id: string | null;
        created_at: string;
        expires_at: string | null;
      }>(
        `SELECT id, content, status, session_id, sprint_id, created_at, expires_at FROM constraints ORDER BY created_at`
      );
      if (constraintsResult.success && constraintsResult.data) {
        for (const constraint of constraintsResult.data) {
          if (since && constraint.created_at <= since) continue;
          events.push({
            type: 'constraint_added',
            timestamp: constraint.created_at,
            data: {
              constraintId: constraint.id,
              content: constraint.content,
              status: constraint.status,
              sessionId: constraint.session_id ?? '',
              sprintId: constraint.sprint_id,
              expiresAt: constraint.expires_at,
            },
          });
          breakdown.constraints++;
        }
      }

      // 9. Context snapshots (s69-m03 §2.5 sync-emitter parity for snapshot_taken)
      const snapshotsResult = db.getMany<{
        id: number;
        context_id: string;
        session_id: string | null;
        source: string | null;
        created_at: string;
      }>(
        `SELECT id, context_id, session_id, source, created_at FROM context_snapshots ORDER BY created_at`
      );
      if (snapshotsResult.success && snapshotsResult.data) {
        for (const snapshot of snapshotsResult.data) {
          if (since && snapshot.created_at <= since) continue;
          events.push({
            type: 'snapshot_taken',
            timestamp: snapshot.created_at,
            data: {
              snapshotId: snapshot.id,
              contextId: snapshot.context_id,
              sessionId: snapshot.session_id ?? '',
              source: snapshot.source,
            },
          });
          breakdown.snapshots++;
        }
      }

      // Q3 dashboard-ingest gate (dashboard msg 03064b74; carry-forward #770):
      // drop event types the dashboard PG mirror cannot ingest yet — pushing
      // them on this event-replay path returns HTTP 400. The file-based sync
      // path returns earlier and is unaffected (it uploads the whole SQLite
      // file; the dashboard's sqlite-backfill endpoint decides what to ingest
      // server-side). Suppression is surfaced as a warning below, never silent.
      let suppressed = 0;
      for (let i = events.length - 1; i >= 0; i--) {
        if (DASHBOARD_UNSUPPORTED_EVENT_TYPES.has(events[i].type)) {
          events.splice(i, 1);
          suppressed++;
        }
      }
      if (suppressed > 0) {
        // Keep the large-delta guard honest: these counts are no longer pushed.
        breakdown.nextSteps = 0;
        breakdown.constraints = 0;
        breakdown.snapshots = 0;
        warnings.push(
          `Suppressed ${suppressed} event(s) of types not yet in the dashboard ingest allowlist ` +
            `(${[...DASHBOARD_UNSUPPORTED_EVENT_TYPES].join(', ')}). These are not part of the ` +
            `sync drift; remove from DASHBOARD_UNSUPPORTED_EVENT_TYPES once the dashboard adds the mirror tables.`
        );
      }

      // Sort chronologically
      events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const totalEvents = events.length;

      // Large-delta guard: skip push when any entity type exceeds threshold.
      // Directs the user to re-upload the SQLite file instead.
      // Bypassed when force=true — upserts are idempotent, large-batch replays are safe.
      if (!params.dryRun && !params.force) {
        const tableNames = Object.keys(breakdown) as (keyof typeof breakdown)[];
        for (const table of tableNames) {
          if (breakdown[table] > LARGE_DELTA_THRESHOLD) {
            const dashUrl = process.env['CMOS_DASHBOARD_URL'] ?? '';
            const slugResult = db.getOne<MetadataRow>(
              `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
            );
            const slug = (slugResult.success && slugResult.data?.value) || 'your-project';
            const uploadPath = dashUrl ? `${dashUrl}/projects/${slug}` : 'your dashboard';
            const warningMsg =
              `Delta too large: ${breakdown[table]} ${table} records exceed threshold of ` +
              `${LARGE_DELTA_THRESHOLD}. Re-upload your SQLite file at ${uploadPath} instead.`;
            console.error(`[backfill] ${warningMsg}`);
            return createSuccess<CmosDbBackfillResult>({
              mode: 'backfill',
              dryRun: false,
              totalEvents,
              pushed: 0,
              failed: 0,
              skipped: totalEvents,
              deduped,
              breakdown,
              cursor: previousCursor,
              previousCursor,
              message: `Delta too large (${breakdown[table]} ${table} records). Re-upload your SQLite file at ${uploadPath} instead.`,
              warnings: [warningMsg, ...(warnings.length > 0 ? warnings : [])],
            });
          }
        }
      }

      if (params.dryRun) {
        return createSuccess<CmosDbBackfillResult>({
          mode: 'backfill',
          dryRun: true,
          totalEvents,
          pushed: 0,
          failed: 0,
          skipped: 0,
          deduped,
          breakdown,
          cursor: previousCursor,
          previousCursor,
          message: `Dry run: ${totalEvents} events would be pushed (${breakdown.sprints} sprint, ${breakdown.missions} mission, ${breakdown.sessions} session, ${breakdown.decisions} decision, ${breakdown.learnings} learning, ${breakdown.dependencies} dependency events)${deduped > 0 ? `. ${deduped} duplicate(s) skipped by content hash.` : ''}.`,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      }

      // Push events sequentially with per-request and overall timeouts
      const getNow = params._getNow ?? Date.now;
      const effectiveOverallTimeout = params.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
      const wallClockStart = getNow();
      let pushed = 0;
      let failed = 0;
      let latestTimestamp: string | null = null;
      let timedOut = false;

      for (const event of events) {
        // Check wall-clock overall timeout before each push
        if (getNow() - wallClockStart > effectiveOverallTimeout) {
          timedOut = true;
          const remaining = totalEvents - pushed - failed;
          console.error(
            `[backfill] Overall timeout (${effectiveOverallTimeout}ms) exceeded. ` +
              `Aborted: ${pushed} pushed, ${failed} failed, ${remaining} remaining.`
          );
          break;
        }

        const envelope = buildSyncEnvelope(identity, event.type, event.timestamp, event.data);
        const result = await dashboardClient.pushSyncEvent(
          envelope as unknown as Record<string, unknown>
        );

        if (result.success) {
          pushed++;
          latestTimestamp = event.timestamp;
        } else {
          failed++;
          console.warn(`[backfill] Failed to push ${event.type}: ${result.error?.message}`);
        }

        // Progress logging every PROGRESS_LOG_INTERVAL events
        const processed = pushed + failed;
        if (processed % PROGRESS_LOG_INTERVAL === 0) {
          const remaining = totalEvents - processed;
          console.error(
            `[backfill] Progress: ${pushed} pushed, ${failed} failed, ${remaining} remaining`
          );
        }
      }

      // Update cursor — only advance, never regress.
      // A force=true run that times out early must not overwrite a previously-advanced
      // cursor with an earlier timestamp, or the next run re-processes the same events.
      if (latestTimestamp && (!previousCursor || latestTimestamp > previousCursor)) {
        db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('backfill_cursor', ?)`, [
          latestTimestamp,
        ]);
      }

      const finalWarnings = warnings.length > 0 ? [...warnings] : [];
      if (timedOut) {
        const remaining = totalEvents - pushed - failed;
        finalWarnings.push(
          `Backfill timed out after ${effectiveOverallTimeout}ms. ` +
            `${remaining} event(s) not pushed. Re-run to continue from cursor.`
        );
      }

      return createSuccess<CmosDbBackfillResult>({
        mode: 'backfill',
        dryRun: false,
        totalEvents,
        pushed,
        failed,
        skipped: 0,
        deduped,
        breakdown,
        cursor: latestTimestamp ?? previousCursor,
        previousCursor,
        message: `Backfill complete: ${pushed}/${totalEvents} events pushed${failed > 0 ? ` (${failed} failed)` : ''}${deduped > 0 ? ` (${deduped} duplicates skipped)` : ''}. ${breakdown.sprints} sprint, ${breakdown.missions} mission, ${breakdown.sessions} session, ${breakdown.decisions} decision, ${breakdown.learnings} learning, ${breakdown.dependencies} dependency events.`,
        warnings: finalWarnings.length > 0 ? finalWarnings : undefined,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Result of getProjectIdentity including repair metadata */
export interface ProjectIdentityResult extends ProjectIdentity {
  /** Whether repair was attempted */
  repaired: boolean;
  /** Source used for repair (if any) */
  repairSource: 'dashboard_slug' | 'directory' | 'master_context' | null;
}

function getProjectIdentity(db: CmosDatabaseClient): ProjectIdentityResult {
  const pidResult = db.getOne<MetadataRow>(`SELECT value FROM metadata WHERE key = 'project_id'`);
  const pnameResult = db.getOne<MetadataRow>(
    `SELECT value FROM metadata WHERE key = 'project_name'`
  );

  let projectId = (pidResult.success && pidResult.data?.value) || '';
  let projectName = (pnameResult.success && pnameResult.data?.value) || '';

  // If both are present, return as-is
  if (projectId && projectName) {
    return { projectId, projectName, repaired: false, repairSource: null };
  }

  // s81-m02 defect-3: before deriving identity from the directory basename (which a
  // renamed copy gets WRONG) or falling back to 'Unknown' (which pushes into an
  // 'Unknown' dashboard container), prefer the RECONCILED incumbent dashboard identity
  // if the store carries one. dashboard_slug is the stable key resolveAndPersistOwner
  // adopts from the dashboard's incumbent row, so a registered/reconciled store never
  // pushes as 'Unknown' and a renamed copy keeps the incumbent slug over its new folder.
  const dashSlugRow = db.getOne<MetadataRow>(
    `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
  );
  const dashboardSlug = (dashSlugRow.success && dashSlugRow.data?.value) || '';
  if (dashboardSlug) {
    if (!projectId) projectId = dashboardSlug;
    if (!projectName) {
      projectName = dashboardSlug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
      projectId,
    ]);
    db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`, [
      projectName,
    ]);
    return { projectId, projectName, repaired: true, repairSource: 'dashboard_slug' };
  }

  // Attempt repair from directory name (db path: {root}/cmos/db/cmos.sqlite)
  const dbPath = db.path;
  const projectRoot = path.resolve(dbPath, '..', '..', '..');
  const dirName = path.basename(projectRoot);

  if (dirName && dirName !== '.' && dirName !== '/') {
    if (!projectName) {
      projectName = dirName
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    if (!projectId) {
      projectId = dirName.toLowerCase().replace(/\s+/g, '-');
    }

    // Persist the repair
    db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
      projectId,
    ]);
    db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`, [
      projectName,
    ]);

    return { projectId, projectName, repaired: true, repairSource: 'directory' };
  }

  // Attempt repair from master_context
  const contextResult = db.getOne<{ content: string }>(
    `SELECT content FROM contexts WHERE id = 'master_context'`
  );
  if (contextResult.success && contextResult.data?.content) {
    try {
      const content = JSON.parse(contextResult.data.content);
      const ctxProject = content.project_identity || content.project || {};
      const ctxName = ctxProject.name as string | undefined;
      if (ctxName) {
        if (!projectName) projectName = ctxName;
        if (!projectId) projectId = ctxName.toLowerCase().replace(/\s+/g, '-');

        db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
          projectId,
        ]);
        db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`, [
          projectName,
        ]);

        return { projectId, projectName, repaired: true, repairSource: 'master_context' };
      }
    } catch {
      // JSON parse failure — fall through to fallback
    }
  }

  // Fallback: still unknown
  return {
    projectId: projectId || 'unknown',
    projectName: projectName || 'Unknown',
    repaired: false,
    repairSource: null,
  };
}

function getCursor(db: CmosDatabaseClient): string | null {
  const result = db.getOne<MetadataRow>(`SELECT value FROM metadata WHERE key = 'backfill_cursor'`);
  return (result.success && result.data?.value) || null;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconciliationTableResult {
  table: string;
  sqliteCount: number;
  pgCount: number;
  match: boolean;
  delta: number;
}

export interface ReconciliationResult {
  tables: ReconciliationTableResult[];
  allMatch: boolean;
  totalSqlite: number;
  totalPg: number;
  /** Whether counts are project-scoped (true) or global (false/fallback) */
  projectScoped: boolean;
  /** Project slug used for project-scoped reconciliation, null if global */
  projectSlug: string | null;
  syncLogEntries: number;
  failedEntries: number;
  lastSyncAt: string | null;
}

/** PG table → SQLite table name mapping (used by global reconciliation fallback) */
const PG_TO_SQLITE_TABLE: Record<string, string> = {
  cmos_sprints: 'sprints',
  cmos_missions: 'missions',
  cmos_sessions: 'sessions',
  cmos_decisions: 'strategic_decisions',
  cmos_learnings: 'learnings',
  cmos_mission_dependencies: 'mission_dependencies',
};

/** Derive a dashboard-compatible slug from the project name */
function deriveProjectSlug(projectName: string): string {
  return projectName.toLowerCase().replace(/\s+/g, '-');
}

interface CountRow {
  cnt: number;
}

export async function cmosDbReconcile(params: {
  projectRoot?: string;
}): Promise<CmosToolResult<ReconciliationResult>> {
  const clientResult = await resolveSyncClient(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(CmosErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      // Resolve project slug from metadata
      const identity = getProjectIdentity(db);
      const slug = deriveProjectSlug(identity.projectName);

      // Use project-scoped status endpoint for accurate table counts
      // (project-state endpoint caps entity arrays, e.g. sessions LIMIT 50)
      const statusResult = await dashboardClient.getSyncStatus(slug);
      if (!statusResult.success || !statusResult.data) {
        // Fallback to global endpoint if project-scoped status fails
        return reconcileWithGlobalEndpoint(db, dashboardClient);
      }

      const pgStatus = statusResult.data;
      const tables: ReconciliationTableResult[] = [];

      for (const pgTable of pgStatus.tables) {
        const sqliteTable = PG_TO_SQLITE_TABLE[pgTable.table];
        if (!sqliteTable) continue;

        const countResult = db.getOne<CountRow>(`SELECT COUNT(*) AS cnt FROM ${sqliteTable}`);
        const sqliteCount = countResult.success && countResult.data ? countResult.data.cnt : 0;

        tables.push({
          table: sqliteTable,
          sqliteCount,
          pgCount: pgTable.count,
          match: sqliteCount === pgTable.count,
          delta: sqliteCount - pgTable.count,
        });
      }

      const totalSqlite = tables.reduce((sum, t) => sum + t.sqliteCount, 0);
      const totalPg = tables.reduce((sum, t) => sum + t.pgCount, 0);

      return createSuccess<ReconciliationResult>({
        tables,
        allMatch: tables.every((t) => t.match),
        totalSqlite,
        totalPg,
        projectScoped: true,
        projectSlug: slug,
        syncLogEntries: pgStatus.totalSyncLogEntries,
        failedEntries: pgStatus.failedSyncLogEntries,
        lastSyncAt: pgStatus.lastSyncAt,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/** Fallback: reconcile using global endpoint (pre-Sprint 34 behavior) */
async function reconcileWithGlobalEndpoint(
  db: CmosDatabaseClient,
  client: DashboardClient
): Promise<CmosToolResult<ReconciliationResult>> {
  const statusResult = await client.getSyncStatus();
  if (!statusResult.success || !statusResult.data) {
    return createError(
      statusResult.error ?? CmosErrors.dashboardError('Failed to fetch sync status')
    );
  }

  const pgStatus = statusResult.data;
  const tables: ReconciliationTableResult[] = [];

  for (const pgTable of pgStatus.tables) {
    const sqliteTable = PG_TO_SQLITE_TABLE[pgTable.table];
    if (!sqliteTable) continue;

    const countResult = db.getOne<CountRow>(`SELECT COUNT(*) AS cnt FROM ${sqliteTable}`);
    const sqliteCount = countResult.success && countResult.data ? countResult.data.cnt : 0;

    tables.push({
      table: sqliteTable,
      sqliteCount,
      pgCount: pgTable.count,
      match: sqliteCount === pgTable.count,
      delta: sqliteCount - pgTable.count,
    });
  }

  const totalSqlite = tables.reduce((sum, t) => sum + t.sqliteCount, 0);
  const totalPg = tables.reduce((sum, t) => sum + t.pgCount, 0);

  return createSuccess<ReconciliationResult>({
    tables,
    allMatch: tables.every((t) => t.match),
    totalSqlite,
    totalPg,
    projectScoped: false,
    projectSlug: null,
    syncLogEntries: pgStatus.totalSyncLogEntries,
    failedEntries: pgStatus.failedSyncLogEntries,
    lastSyncAt: pgStatus.lastSyncAt,
  });
}

export function formatReconciliationForLLM(result: CmosToolResult<ReconciliationResult>): string {
  if (!result.success) {
    return `Reconciliation failed: ${result.error?.message ?? 'Unknown error'}`;
  }

  const d = result.data!;
  const scopeLabel = d.projectScoped
    ? `Reconciliation (project-scoped: ${d.projectSlug}): `
    : 'Reconciliation (global): ';
  const lines = [
    scopeLabel + (d.allMatch ? 'ALL MATCH' : 'MISMATCHES DETECTED'),
    '',
    'Table                    | SQLite | PG   | Match | Delta',
    '-------------------------|--------|------|-------|------',
  ];

  for (const t of d.tables) {
    const status = t.match ? 'YES' : 'NO';
    const delta = t.delta === 0 ? '0' : t.delta > 0 ? `+${t.delta}` : `${t.delta}`;
    lines.push(
      `${t.table.padEnd(25)}| ${String(t.sqliteCount).padEnd(7)}| ${String(t.pgCount).padEnd(5)}| ${status.padEnd(6)}| ${delta}`
    );
  }

  lines.push('');
  lines.push(`Totals: SQLite=${d.totalSqlite}, PG=${d.totalPg}`);
  lines.push(`Sync log: ${d.syncLogEntries} entries, ${d.failedEntries} failed`);
  if (d.lastSyncAt) {
    lines.push(`Last sync: ${d.lastSyncAt}`);
  }

  return lines.join('\n');
}

// ─── PG Orphan Identification ────────────────────────────────────────────────

export interface PgOrphanEntry {
  table: string;
  id: string;
  /** Secondary ID for composite keys (e.g., dependency to_id) */
  secondaryId?: string;
}

export interface PgOrphanReport {
  orphans: PgOrphanEntry[];
  totalOrphans: number;
  tablesChecked: string[];
  projectSlug: string;
}

/**
 * Identify PG-side orphan entity IDs that don't exist in SQLite.
 * Compares entity IDs from the dashboard project state API against local SQLite.
 *
 * Note: The project state API may cap entity arrays for large tables.
 * When caps are hit, orphan detection for that table is skipped.
 */
export async function identifyPgOrphans(params: {
  projectRoot?: string;
}): Promise<CmosToolResult<PgOrphanReport>> {
  const clientResult = await resolveSyncClient(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(CmosErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      const identity = getProjectIdentity(db);
      const slug = deriveProjectSlug(identity.projectName);

      // Get full PG state
      const stateResult = await dashboardClient.getSyncProjectState(slug);
      if (!stateResult.success || !stateResult.data) {
        return createError(
          stateResult.error ?? CmosErrors.dashboardError('Failed to fetch PG project state')
        );
      }

      const pgState = stateResult.data;
      const orphans: PgOrphanEntry[] = [];
      const tablesChecked: string[] = [];

      // Compare missions
      if (pgState.missions && Array.isArray(pgState.missions)) {
        tablesChecked.push('missions');
        const sqliteIds = getSqliteIds(db, 'missions', 'id');
        for (const pgMission of pgState.missions) {
          const row = pgMission as unknown as Record<string, unknown>;
          const id = (row.missionId as string) ?? (row.id as string);
          if (id && !sqliteIds.has(id)) {
            orphans.push({ table: 'missions', id });
          }
        }
      }

      // Compare sessions
      if (pgState.sessions && Array.isArray(pgState.sessions)) {
        tablesChecked.push('sessions');
        const sqliteIds = getSqliteIds(db, 'sessions', 'id');
        for (const pgSession of pgState.sessions) {
          const row = pgSession as unknown as Record<string, unknown>;
          const id = (row.sessionId as string) ?? (row.id as string);
          if (id && !sqliteIds.has(id)) {
            orphans.push({ table: 'sessions', id });
          }
        }
      }

      // Compare dependencies (composite key: from_id + to_id)
      if (pgState.dependencies && Array.isArray(pgState.dependencies)) {
        tablesChecked.push('mission_dependencies');
        const sqliteDeps = getSqliteDependencyKeys(db);
        for (const pgDep of pgState.dependencies) {
          const dep = pgDep as unknown as Record<string, unknown>;
          const fromId = (dep.fromId ?? dep.from_id) as string;
          const toId = (dep.toId ?? dep.to_id) as string;
          if (fromId && toId) {
            const key = `${fromId}|${toId}`;
            if (!sqliteDeps.has(key)) {
              orphans.push({ table: 'mission_dependencies', id: fromId, secondaryId: toId });
            }
          }
        }
      }

      return createSuccess<PgOrphanReport>({
        orphans,
        totalOrphans: orphans.length,
        tablesChecked,
        projectSlug: slug,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/** Get all entity IDs from a SQLite table as a Set */
function getSqliteIds(db: CmosDatabaseClient, table: string, idColumn: string): Set<string> {
  const result = db.getMany<{ id: string }>(`SELECT ${idColumn} as id FROM ${table}`);
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((row) => row.id));
}

/** Get all dependency composite keys as a Set */
function getSqliteDependencyKeys(db: CmosDatabaseClient): Set<string> {
  const result = db.getMany<{ from_id: string; to_id: string }>(
    `SELECT from_id, to_id FROM mission_dependencies`
  );
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((row) => `${row.from_id}|${row.to_id}`));
}

export function formatPgOrphanReportForLLM(result: CmosToolResult<PgOrphanReport>): string {
  if (!result.success) {
    return `PG orphan identification failed: ${result.error?.message ?? 'Unknown error'}`;
  }

  const d = result.data!;
  if (d.totalOrphans === 0) {
    return `PG Orphan Check (${d.projectSlug}): No orphans found across ${d.tablesChecked.length} tables.`;
  }

  const lines = [`PG Orphan Report (${d.projectSlug}): ${d.totalOrphans} orphan(s) found`, ''];

  const byTable = new Map<string, PgOrphanEntry[]>();
  for (const orphan of d.orphans) {
    const existing = byTable.get(orphan.table) ?? [];
    existing.push(orphan);
    byTable.set(orphan.table, existing);
  }

  for (const [table, entries] of byTable) {
    lines.push(`${table} (${entries.length} orphan${entries.length > 1 ? 's' : ''}):`);
    for (const entry of entries) {
      if (entry.secondaryId) {
        lines.push(`  - ${entry.id} → ${entry.secondaryId}`);
      } else {
        lines.push(`  - ${entry.id}`);
      }
    }
    lines.push('');
  }

  lines.push(`Tables checked: ${d.tablesChecked.join(', ')}`);
  return lines.join('\n');
}

// ─── Purge ───────────────────────────────────────────────────────────────────

export interface PurgeResult {
  purgedProject: string;
  tablesCleared: string[];
  rowsDeleted: number;
}

export async function cmosDbPurge(params: {
  confirm?: boolean;
  projectRoot?: string;
  expectedSlug?: string;
}): Promise<CmosToolResult<PurgeResult>> {
  if (!params.confirm) {
    return createError({
      code: 'CONFIRMATION_REQUIRED',
      message:
        'Purge requires explicit confirmation. Pass confirm=true to proceed. ' +
        'This will delete ALL mirrored data for this project from the PG mirror.',
      suggestion: 'Call cmos_db(action="purge", confirm=true) to proceed.',
    });
  }

  const clientResult = await resolveSyncClient(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(CmosErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      const identity = getProjectIdentity(db);
      const slug = deriveProjectSlug(identity.projectName);

      const purgeResult = await dashboardClient.purgeMirror(slug, params.expectedSlug ?? undefined);
      if (!purgeResult.success || !purgeResult.data) {
        return createError(
          purgeResult.error ?? CmosErrors.dashboardError('Failed to purge mirror')
        );
      }

      return createSuccess<PurgeResult>({
        purgedProject: purgeResult.data.purgedProject,
        tablesCleared: purgeResult.data.tablesCleared,
        rowsDeleted: purgeResult.data.rowsDeleted,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatPurgeForLLM(result: CmosToolResult<PurgeResult>): string {
  if (!result.success) {
    return `Purge failed: ${result.error?.message ?? 'Unknown error'}`;
  }

  const d = result.data!;
  const lines = [
    `Purge Complete: ${d.purgedProject}`,
    '',
    `Tables cleared: ${d.tablesCleared.join(', ')}`,
    `Rows deleted: ${d.rowsDeleted}`,
    '',
    'Run cmos_db(action="backfill", force=true) to re-sync all data.',
  ];

  return lines.join('\n');
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

export function formatBackfillForLLM(result: CmosToolResult<CmosDbBackfillResult>): string {
  if (!result.success) {
    return `Backfill failed: ${result.error?.message ?? 'Unknown error'}`;
  }

  const d = result.data!;
  const lines = [
    d.dryRun ? 'Backfill Dry Run' : 'Backfill Complete',
    '',
    d.message,
    '',
    `Events: ${d.pushed} pushed, ${d.failed} failed`,
    `Breakdown: ${d.breakdown.sprints} sprint, ${d.breakdown.missions} mission, ${d.breakdown.sessions} session, ${d.breakdown.decisions} decision, ${d.breakdown.learnings} learning, ${d.breakdown.dependencies} dependency`,
  ];

  if (d.previousCursor) {
    lines.push(`Previous cursor: ${d.previousCursor}`);
  }
  if (d.cursor) {
    lines.push(`Current cursor: ${d.cursor}`);
  }

  return lines.join('\n');
}
