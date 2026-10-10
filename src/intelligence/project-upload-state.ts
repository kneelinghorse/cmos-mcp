// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Registry-owned dashboard upload debt, leases and outcomes shared by server processes.
// ABOUTME: Lease tokens fence completion; generations retain writes made after a snapshot claim.

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export const UPLOAD_QUIET_MS = 5 * 60_000;
export const UPLOAD_MAX_WAIT_MS = 30 * 60_000;
export const UPLOAD_LEASE_MS = 5 * 60_000;

export interface UploadState {
  readonly firstOwedAt: number | null;
  readonly latestWriteAt: number | null;
  readonly generation: number;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastOutcome: string | null;
  readonly lastError: string | null;
  readonly lastSyncedAt: number | null;
  readonly blocked: boolean;
}

export interface UploadLease {
  readonly token: string;
  readonly generation: number;
}

export interface UploadOutcome {
  readonly success: boolean;
  readonly error?: string;
  readonly blocked?: boolean;
}

const COLUMNS: Readonly<Record<string, string>> = {
  upload_first_owed_at: 'INTEGER',
  upload_latest_write_at: 'INTEGER',
  upload_first_after_claim_at: 'INTEGER',
  upload_generation: 'INTEGER NOT NULL DEFAULT 0',
  upload_lease_token: 'TEXT',
  upload_lease_expires_at: 'INTEGER',
  upload_last_attempt_at: 'INTEGER',
  upload_last_outcome: 'TEXT',
  upload_last_error: 'TEXT',
  upload_blocked: 'INTEGER NOT NULL DEFAULT 0',
};

/** Race-safe additive migration: only a proved concurrent addition may suppress an ALTER error. */
export function ensureUploadColumns(db: Database.Database): void {
  const names = (): Set<string> =>
    new Set(
      (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
  const existing = names();
  for (const [name, type] of Object.entries(COLUMNS)) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
    } catch (error) {
      if (!names().has(name)) throw error;
    }
  }
}

export function readUploadState(db: Database.Database, id: string): UploadState | null {
  const row = db
    .prepare(
      `SELECT upload_first_owed_at AS firstOwedAt,
    upload_latest_write_at AS latestWriteAt, COALESCE(upload_generation,0) AS generation,
    upload_lease_token AS leaseToken, upload_lease_expires_at AS leaseExpiresAt,
    upload_last_attempt_at AS lastAttemptAt, upload_last_outcome AS lastOutcome,
    upload_last_error AS lastError, last_synced_at AS lastSyncedAt,
    COALESCE(upload_blocked,0) AS blocked FROM projects
    WHERE project_id = ? AND archived_at IS NULL`
    )
    .get(id) as (Omit<UploadState, 'blocked'> & { blocked: number }) | undefined;
  return row ? { ...row, blocked: row.blocked !== 0 } : null;
}

export function markUploadOwed(db: Database.Database, id: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE projects SET
    upload_first_owed_at = COALESCE(upload_first_owed_at, ?), upload_latest_write_at = ?,
    upload_first_after_claim_at = CASE WHEN upload_lease_token IS NOT NULL
      THEN COALESCE(upload_first_after_claim_at, ?) ELSE upload_first_after_claim_at END,
    upload_generation = COALESCE(upload_generation,0) + 1
    WHERE project_id = ? AND archived_at IS NULL`
      )
      .run(now, now, now, id).changes > 0
  );
}

export function claimUpload(
  db: Database.Database,
  id: string,
  now: number,
  explicit: boolean
): UploadLease | null {
  const token = randomUUID();
  // UPDATE ... RETURNING captures the generation in the same atomic statement as the claim.
  const row = db
    .prepare(
      `UPDATE projects SET upload_lease_token = ?,
    upload_lease_expires_at = ?, upload_last_attempt_at = ?, upload_last_outcome = 'uploading',
    upload_first_after_claim_at = NULL
    WHERE project_id = ? AND archived_at IS NULL
    AND (upload_lease_token IS NULL OR COALESCE(upload_lease_expires_at,0) <= ?)
    AND (? = 1 OR (COALESCE(upload_blocked,0) = 0 AND upload_first_owed_at IS NOT NULL
      AND (upload_latest_write_at <= ? OR upload_first_owed_at <= ?)))
    RETURNING COALESCE(upload_generation,0) AS generation`
    )
    .get(
      token,
      now + UPLOAD_LEASE_MS,
      now,
      id,
      now,
      explicit ? 1 : 0,
      now - UPLOAD_QUIET_MS,
      now - UPLOAD_MAX_WAIT_MS
    ) as { generation: number } | undefined;
  return row ? { token, generation: row.generation } : null;
}

export function renewUploadLease(
  db: Database.Database,
  id: string,
  token: string,
  now: number
): boolean {
  return (
    db
      .prepare(
        `UPDATE projects SET upload_lease_expires_at = ?
    WHERE project_id = ? AND upload_lease_token = ? AND upload_lease_expires_at > ?
    AND archived_at IS NULL`
      )
      .run(now + UPLOAD_LEASE_MS, id, token, now).changes > 0
  );
}

/** Failure preserves debt; only successful explicit attempts can clear an auth backoff. */
export function finishUpload(
  db: Database.Database,
  id: string,
  lease: UploadLease,
  now: number,
  outcome: UploadOutcome
): boolean {
  return (
    db
      .prepare(
        `UPDATE projects SET upload_lease_token = NULL,
    upload_lease_expires_at = NULL, upload_last_outcome = ?, upload_last_error = ?,
    upload_blocked = CASE WHEN ? = 1 THEN 0 WHEN ? = 1 THEN 1 ELSE upload_blocked END,
    last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
    upload_first_owed_at = CASE WHEN ? = 1 THEN CASE WHEN upload_generation = ? THEN NULL
      ELSE COALESCE(upload_first_after_claim_at,upload_first_owed_at) END ELSE upload_first_owed_at END,
    upload_first_after_claim_at = NULL,
    upload_latest_write_at = CASE WHEN ? = 1 AND upload_generation = ? THEN NULL ELSE upload_latest_write_at END
    WHERE project_id = ? AND upload_lease_token = ? AND upload_lease_expires_at > ?`
      )
      .run(
        outcome.success ? 'success' : 'failed',
        outcome.success ? null : (outcome.error ?? 'Unknown error').slice(0, 500),
        outcome.success ? 1 : 0,
        outcome.blocked ? 1 : 0,
        outcome.success ? 1 : 0,
        now,
        outcome.success ? 1 : 0,
        lease.generation,
        outcome.success ? 1 : 0,
        lease.generation,
        id,
        lease.token,
        now
      ).changes > 0
  );
}
