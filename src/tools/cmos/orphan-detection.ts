/**
 * Orphaned Entity Detection
 *
 * Detects orphaned sprints (no missions), orphaned missions (no parent sprint
 * or stale In Progress status), and stale sessions (active but old).
 * Surfaces warnings in cmos_agent_onboard for operational hygiene.
 *
 * Carried forward from Sprint 30 backlog.
 *
 * @module tools/cmos/orphan-detection
 */

import type { CmosDatabaseClient } from './client';
import {
  SPRINT_NO_OPEN_WORK_STATUSES,
  MISSION_TERMINAL_STATUSES,
  missionCompletedSql,
  statusNotInSql,
} from './terminal-status';
import { tableHasColumn } from './genesis-columns';
import { sprintIdOrderSql } from './sprint-ordering';

/** Default threshold: sessions active for >24 hours are stale */
const STALE_SESSION_HOURS = 24;

/** Default threshold: In Progress missions older than 7 days are stale */
const STALE_MISSION_DAYS = 7;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OrphanedSprint {
  id: string;
  title: string;
  status: string | null;
}

export interface OrphanedMission {
  id: string;
  name: string;
  status: string;
  reason: 'no_sprint' | 'stale_in_progress';
  startedAt: string | null;
}

export interface StaleSession {
  id: string;
  type: string;
  title: string;
  startedAt: string;
  hoursActive: number;
  /** s84-m03: the session's own project_id (guarded read). Foreign → the onboard
   *  "complete stale session" action renders id-only instead of embedding the title. */
  projectId?: string | null;
}

export interface OrphanDetectionResult {
  orphanedSprints: OrphanedSprint[];
  orphanedMissions: OrphanedMission[];
  staleSessions: StaleSession[];
  totalOrphans: number;
}

// ─── Row Types ───────────────────────────────────────────────────────────────

interface SprintRow {
  id: string;
  title: string;
  status: string | null;
}

interface MissionRow {
  id: string;
  name: string;
  status: string;
  started_at: string | null;
}

interface SessionRow {
  id: string;
  type: string;
  title: string;
  started_at: string;
  hours_active: number;
  /** s84-m03: guarded project_id read (NULL on an ancient store). */
  project_id?: string | null;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Detect orphaned entities across sprints, missions, and sessions.
 *
 * - Orphaned sprints: sprints with zero missions
 * - Orphaned missions (no_sprint): missions with null/empty sprint_id
 * - Orphaned missions (stale_in_progress): In Progress missions started >7 days ago
 * - Stale sessions: active sessions started >24 hours ago
 */
export function detectOrphans(
  client: CmosDatabaseClient,
  options?: {
    staleSessionHours?: number;
    staleMissionDays?: number;
  }
): OrphanDetectionResult {
  const sessionThreshold = options?.staleSessionHours ?? STALE_SESSION_HOURS;
  const missionThreshold = options?.staleMissionDays ?? STALE_MISSION_DAYS;

  const orphanedSprints = findOrphanedSprints(client);
  const orphanedMissions = findOrphanedMissions(client, missionThreshold);
  const staleSessions = findStaleSessions(client, sessionThreshold);

  return {
    orphanedSprints,
    orphanedMissions,
    staleSessions,
    totalOrphans: orphanedSprints.length + orphanedMissions.length + staleSessions.length,
  };
}

/**
 * Build warning strings from orphan detection results.
 * Returns an empty array if no orphans are found.
 */
export function buildOrphanWarnings(result: OrphanDetectionResult): string[] {
  const warnings: string[] = [];

  if (result.orphanedSprints.length > 0) {
    const ids = result.orphanedSprints.map((s) => s.id).join(', ');
    warnings.push(
      `${result.orphanedSprints.length} orphaned sprint(s) with no missions: ${ids}. Consider adding missions or archiving.`
    );
  }

  for (const m of result.orphanedMissions) {
    if (m.reason === 'no_sprint') {
      warnings.push(
        `Mission ${m.id} ("${m.name}") has an invalid empty sprint ID. Assign an existing sprint or correct it to NULL for unscheduled work.`
      );
    } else {
      warnings.push(
        `Mission ${m.id} ("${m.name}") has been In Progress since ${m.startedAt}. Consider completing or blocking it.`
      );
    }
  }

  if (result.staleSessions.length > 0) {
    for (const s of result.staleSessions) {
      warnings.push(
        `Session ${s.id} ("${s.title}") has been active for ${Math.round(s.hoursActive)}h. Consider completing it.`
      );
    }
  }

  return warnings;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

function findOrphanedSprints(client: CmosDatabaseClient): OrphanedSprint[] {
  const result = client.getMany<SprintRow>(
    `SELECT s.id, s.title, s.status
     FROM sprints s
     LEFT JOIN missions m ON m.sprint_id = s.id
     WHERE ${statusNotInSql('s.status', SPRINT_NO_OPEN_WORK_STATUSES)}
     GROUP BY s.id
     HAVING COUNT(m.id) = 0
     ORDER BY ${sprintIdOrderSql('s.id', 'ASC')}`
  );

  if (!result.success || !result.data) return [];

  return result.data.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
  }));
}

function findOrphanedMissions(client: CmosDatabaseClient, staleDays: number): OrphanedMission[] {
  const missions: OrphanedMission[] = [];

  // NULL is valid unscheduled work. Only an invalid empty ID needs assignment cleanup.
  const noSprintResult = client.getMany<MissionRow>(
    `SELECT id, name, status, started_at
     FROM missions
     WHERE sprint_id = ''
       AND ${statusNotInSql('status', MISSION_TERMINAL_STATUSES)}
       AND NOT (${missionCompletedSql('status')})
     ORDER BY id`
  );
  if (noSprintResult.success && noSprintResult.data) {
    for (const row of noSprintResult.data) {
      missions.push({
        id: row.id,
        name: row.name,
        status: row.status,
        reason: 'no_sprint',
        startedAt: row.started_at,
      });
    }
  }

  // Stale In Progress missions
  const staleResult = client.getMany<MissionRow>(
    `SELECT id, name, status, started_at
     FROM missions
     WHERE status = 'In Progress'
       AND julianday(started_at) < julianday('now', '-' || ? || ' days')
     ORDER BY julianday(started_at)`,
    [staleDays]
  );
  if (staleResult.success && staleResult.data) {
    for (const row of staleResult.data) {
      missions.push({
        id: row.id,
        name: row.name,
        status: row.status,
        reason: 'stale_in_progress',
        startedAt: row.started_at,
      });
    }
  }

  return missions;
}

function findStaleSessions(client: CmosDatabaseClient, staleHours: number): StaleSession[] {
  // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
  const projExpr = tableHasColumn(client, 'sessions', 'project_id')
    ? 'project_id'
    : 'NULL AS project_id';
  // s92-m03: explicit sessions only. An implicit session lives as long as its process does, and
  // reconcile closes it once that process is gone or it idles past 12 h.
  const explicitOnly = tableHasColumn(client, 'sessions', 'implicit') ? 'AND implicit = 0' : '';
  const result = client.getMany<SessionRow>(
    `SELECT id, type, title, started_at, ${projExpr},
            CAST((julianday('now') - julianday(started_at)) * 24 AS REAL) AS hours_active
     FROM sessions
     WHERE status = 'active' ${explicitOnly}
       AND julianday(started_at) < julianday('now', '-' || ? || ' hours')
     ORDER BY julianday(started_at)`,
    [staleHours]
  );

  if (!result.success || !result.data) return [];

  return result.data.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    startedAt: row.started_at,
    hoursActive: row.hours_active,
    projectId: row.project_id ?? null,
  }));
}
