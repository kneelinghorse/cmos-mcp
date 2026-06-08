// ABOUTME: Shared insert-union merge primitives for the Sprint 71 sync client.
// ABOUTME: One idempotent ON CONFLICT(natural key) insert per entity, reused by
// ABOUTME: BOTH the PULL consumer (m02) and the clone-from-/state bootstrap (m03).

/**
 * Insert-union merge core (Sprint 71).
 *
 * The PULL consumer (sync-pull.ts, m02) and the clone bootstrap (sync-bootstrap.ts,
 * m03) write the SAME local rows from two different sources — an event stream vs a
 * /state snapshot. To avoid two divergent copies of the per-entity INSERT SQL
 * (s71-m03 criterion: "reuse the m02 insert-union merge, no duplicate logic"), the
 * idempotent ON CONFLICT(natural key) inserts live here ONCE, parameterized by a
 * normalized per-entity row shape. Each caller maps its own field names onto that
 * shape; the SQL, conflict semantics, and provenance preservation are shared.
 *
 * The genesis verbs are stamped as literals per entity (sprint_added, mission_added,
 * session_started, decision_captured, learning_captured) — the row's frozen
 * cross-store aggregation bucket, identical for both sources. dependency_added is a
 * creation EDGE (not a firehose table) so it carries no genesis provenance.
 *
 * PROVENANCE — preserved, never re-stamped. A replica/clone row carries the
 * ORIGIN's genesis provenance verbatim (stable_event_id, occurred_at, origin_seq,
 * schema_version) so cross-machine event identity + the dashboard's
 * LWW-by-(occurred_at, origin_seq) ordering survive. These rows do NOT go through
 * genesisColumns (which would mint a fresh ULID/clock). Every provenance field
 * except projectId is nullable: a single-user origin (or pre-s71-m01 row)
 * legitimately carries NULL provenance, and a faithful clone preserves the NULL.
 * schema_version is the one exception — the column is NOT NULL DEFAULT 1, so a
 * null coalesces to 1 (every row is v1 until an event type bumps its shape).
 *
 * @module tools/cmos/sync-merge
 */

import type { CmosDatabaseClient } from './client';

// ─── Provenance ────────────────────────────────────────────────────────────────

export interface GenesisProvenance {
  /** Cross-store aggregation key — the origin project's project_id. Required. */
  projectId: string;
  stableEventId: string | null;
  occurredAt: number | null;
  originSeq: number | null;
  /** Per-event-type row-shape version. Null coalesces to 1 at insert (NOT NULL DEFAULT 1). */
  schemaVersion: number | null;
}

export type InsertOutcome = 'inserted' | 'duplicate' | 'failed';

// ─── Normalized row inputs (SQLite column shape, source-agnostic) ────────────────
// Each path (event PULL / state clone) maps its own field names onto these.
// Optional fields default to NULL — they are all nullable-default-NULL in the seed
// schema, so a path that omits them produces the same row as one that passes null.

export interface MergeSprintRow {
  id: string;
  title: string | null;
  status?: string | null;
  focus?: string | null;
  totalMissions?: number | null;
  completedMissions?: number | null;
}

export interface MergeMissionRow {
  id: string;
  sprintId: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface MergeSessionRow {
  id: string;
  type: string | null;
  title: string | null;
  sprintId?: string | null;
  startedAt: string | null;
  completedAt?: string | null;
  /** sessions.status is NOT NULL DEFAULT 'active' — callers pass a concrete value. */
  status: string;
}

export interface MergeDecisionRow {
  id: number;
  decisionText: string | null;
  createdAt: string | null;
  sprintId: string | null;
  missionId: string | null;
  category: string | null;
  sessionId: string | null;
  contentHash: string | null;
}

export interface MergeLearningRow {
  id: number;
  content: string | null;
  category: string | null;
  /** learnings.status is NOT NULL DEFAULT 'active'. */
  status: string;
  sprintId: string | null;
  sessionId: string | null;
  missionId: string | null;
  createdAt: string | null;
  contentHash: string | null;
}

export interface MergeDependencyRow {
  fromId: string;
  toId: string;
  type: string;
}

// ─── Insert-union (ON CONFLICT(natural key) DO NOTHING) ──────────────────────────

/** Run an insert-union; 'inserted' when a row landed, 'duplicate' on no-op, 'failed' on error. */
export function runInsert(db: CmosDatabaseClient, sql: string, params: unknown[]): InsertOutcome {
  const result = db.execute(sql, params as never);
  if (!result.success || !result.data) return 'failed';
  return result.data.changes > 0 ? 'inserted' : 'duplicate';
}

export function insertSprintRow(
  db: CmosDatabaseClient,
  row: MergeSprintRow,
  prov: GenesisProvenance
): InsertOutcome {
  return runInsert(
    db,
    `INSERT INTO sprints
       (id, title, status, focus, total_missions, completed_missions,
        project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sprint_added', ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      row.id,
      row.title,
      row.status ?? null,
      row.focus ?? null,
      row.totalMissions ?? null,
      row.completedMissions ?? null,
      prov.projectId,
      prov.stableEventId,
      prov.occurredAt,
      prov.originSeq,
      prov.schemaVersion ?? 1,
    ]
  );
}

export function insertMissionRow(
  db: CmosDatabaseClient,
  row: MergeMissionRow,
  prov: GenesisProvenance
): InsertOutcome {
  return runInsert(
    db,
    `INSERT INTO missions
       (id, sprint_id, name, status, objective, created_at, started_at, completed_at,
        project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mission_added', ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      row.id,
      row.sprintId,
      row.name,
      row.status,
      row.objective,
      row.createdAt ?? null,
      row.startedAt ?? null,
      row.completedAt ?? null,
      prov.projectId,
      prov.stableEventId,
      prov.occurredAt,
      prov.originSeq,
      prov.schemaVersion ?? 1,
    ]
  );
}

export function insertSessionRow(
  db: CmosDatabaseClient,
  row: MergeSessionRow,
  prov: GenesisProvenance
): InsertOutcome {
  return runInsert(
    db,
    `INSERT INTO sessions
       (id, type, title, sprint_id, started_at, completed_at, status,
        project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'session_started', ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      row.id,
      row.type,
      row.title,
      row.sprintId ?? null,
      row.startedAt,
      row.completedAt ?? null,
      row.status,
      prov.projectId,
      prov.stableEventId,
      prov.occurredAt,
      prov.originSeq,
      prov.schemaVersion ?? 1,
    ]
  );
}

export function insertDecisionRow(
  db: CmosDatabaseClient,
  row: MergeDecisionRow,
  prov: GenesisProvenance
): InsertOutcome {
  return runInsert(
    db,
    `INSERT INTO strategic_decisions
       (id, context_id, decision_text, created_at, sprint_id, mission_id, category,
        author_session_id, content_hash,
        project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, 'master_context', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'decision_captured', ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      row.id,
      row.decisionText,
      row.createdAt,
      row.sprintId,
      row.missionId,
      row.category,
      row.sessionId,
      row.contentHash,
      prov.projectId,
      prov.stableEventId,
      prov.occurredAt,
      prov.originSeq,
      prov.schemaVersion ?? 1,
    ]
  );
}

export function insertLearningRow(
  db: CmosDatabaseClient,
  row: MergeLearningRow,
  prov: GenesisProvenance
): InsertOutcome {
  return runInsert(
    db,
    `INSERT INTO learnings
       (id, content, category, status, sprint_id, author_session_id, mission_id, created_at,
        content_hash,
        project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'learning_captured', ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      row.id,
      row.content,
      row.category,
      row.status,
      row.sprintId,
      row.sessionId,
      row.missionId,
      row.createdAt,
      row.contentHash,
      prov.projectId,
      prov.stableEventId,
      prov.occurredAt,
      prov.originSeq,
      prov.schemaVersion ?? 1,
    ]
  );
}

export function insertDependencyRow(
  db: CmosDatabaseClient,
  row: MergeDependencyRow
): InsertOutcome {
  return runInsert(
    db,
    `INSERT INTO mission_dependencies (from_id, to_id, type)
     VALUES (?, ?, ?)
     ON CONFLICT(from_id, to_id) DO NOTHING`,
    [row.fromId, row.toId, row.type]
  );
}

// ─── Cursor + slug persistence (per-project, in metadata) ────────────────────────

/** Metadata key for a project's PULL cursor — per-slug so distinct shared
 *  projects pulled/cloned into one store keep independent cursors. */
export function pullCursorKey(slug: string): string {
  return `pull_cursor:${slug}`;
}

export function readPullCursor(db: CmosDatabaseClient, slug: string): number {
  const row = db.getOne<{ value: string }>(`SELECT value FROM metadata WHERE key = ?`, [
    pullCursorKey(slug),
  ]);
  const raw = row.success && row.data ? Number.parseInt(row.data.value, 10) : 0;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function persistPullCursor(db: CmosDatabaseClient, slug: string, cursor: number): void {
  db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, [
    pullCursorKey(slug),
    String(cursor),
  ]);
}

export function readDashboardSlug(db: CmosDatabaseClient): string | null {
  const row = db.getOne<{ value: string }>(
    `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
  );
  return row.success && row.data?.value ? row.data.value : null;
}

// ─── Value coercion helpers ──────────────────────────────────────────────────────

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string value, or null for anything else (nullable TEXT columns; a NOT-NULL
 *  column left null makes the INSERT fail loudly → counted, not silent). */
export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Empty string → null (a sprint_id of '' would violate the sprint_id foreign key). */
export function emptyToNull(value: unknown): string | null {
  const s = asString(value);
  return s && s.length > 0 ? s : null;
}

/**
 * Coerce a provenance integer that may arrive as a number (event PULL `data`) OR a
 * BIGINT string (/state, where node-pg marshals BIGINT verbatim as a string so
 * occurred_at stays raw ms-epoch with no Date/Number coercion on the wire). A
 * string is parsed in base 10; a blank/non-numeric value is null. ms-epoch
 * (~1.78e12) and per-client origin_seq are both well within Number.MAX_SAFE_INTEGER,
 * so the parsed Number is exact.
 */
export function toProvenanceInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
