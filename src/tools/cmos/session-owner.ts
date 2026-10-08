// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m03 — whose session a write belongs to: the project's one explicit session, else this
// ABOUTME: process's own implicit session, opened lazily. Also the facts reconcile decides on.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { performance } from 'perf_hooks';

import type { CmosDatabaseClient } from './client';
import { CMOS_ERROR_CODES } from './errors';
import { genesisColumns, getProjectId, tableHasColumn } from './genesis-columns';
import { normalizeCloseTimestamp } from './sprint-end-date-repair';
import type { CmosToolError } from './types';
import { checkWrite } from './write-guard';

/**
 * WHY (aquex.ai message 9b183348 item 4; s92 design, m03). A capture with no open session was
 * refused with SESSION_NOT_ACTIVE, and neither cmos_review nor cmos_agent_onboard opens one, so the
 * first capture of most conversations failed. No harness has an open/close ritual of its own. Since
 * 3.2.0 a write that names no session lands in an IMPLICIT session the server opens for the calling
 * process.
 *
 * THE CALLER'S SESSION, in order:
 *   1. the project's active EXPLICIT session, if there is one. Explicit sessions stay project-wide
 *      and one at a time, exactly as before;
 *   2. otherwise this process's own active implicit session;
 *   3. otherwise, for a write, a new implicit session owned by this process.
 * No lookup ever returns another process's implicit session. The six single-active readers this
 * replaces each took "the" active row, which stops being one row once every process has its own.
 *
 * WHO A PROCESS IS. `ext:<id>` when an external id was set: S93's hook CLI runs one process per
 * hook and keys by the harness session id. Otherwise `pid:<host>:<pid>:<start>`, where host is a
 * short hash of the hostname (never the name) and start is this process's start time in ms, so a
 * reused pid is a different owner.
 *
 * NO SPRINT. A process outlives sprints, so an implicit session carries no sprint_id. Every row it
 * writes resolves its own sprint when it is written, as any untagged write does, instead of
 * inheriting the sprint that was open when its process started.
 */

/** An implicit session idle longer than this is closed by reconcile, whoever owns it. */
export const IMPLICIT_SESSION_IDLE_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

export interface SessionOwner {
  /** Stored in `sessions.owner_key`. */
  key: string;
  kind: 'external' | 'process';
  pid: number;
}

/** The PID namespace this process lives in, where the OS exposes one (Linux); else empty. */
function pidNamespace(): string {
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return '';
  }
}

/**
 * A short, stable id for "the PID space this process can probe". The hostname alone is not that:
 * WSL2 beside Windows, or containers sharing the host's name, see different processes under one
 * hostname, and probing a pid from the wrong space would read a live owner as dead. Platform and
 * the PID namespace keep those apart. The hostname itself is never stored.
 */
export const THIS_HOST_ID = createHash('sha256')
  .update([os.hostname(), process.platform, pidNamespace()].join('\0'))
  .digest('hex')
  .slice(0, 12);

const PROCESS_STARTED_MS = Math.round(performance.timeOrigin);

let externalOwnerId: string | null = null;
let ownerOverride: SessionOwner | null = null;

/** Key this process's implicit sessions by an external id (S93's hook CLI: the harness session). */
export function setExternalSessionOwner(id: string | null): void {
  const trimmed = id?.trim();
  externalOwnerId = trimmed ? trimmed : null;
}

/** Test seam: act as another owner. Shipped code never calls it. */
export function setSessionOwnerForTesting(owner: SessionOwner | null): void {
  ownerOverride = owner;
}

/** The owner key a process with this pid and start time has on this host. */
export function processOwnerKey(pid: number, startedMs: number, hostId = THIS_HOST_ID): string {
  return `pid:${hostId}:${pid}:${startedMs}`;
}

export function currentSessionOwner(): SessionOwner {
  if (ownerOverride) return ownerOverride;
  if (externalOwnerId) {
    return { key: `ext:${externalOwnerId}`, kind: 'external', pid: process.pid };
  }
  return {
    key: processOwnerKey(process.pid, PROCESS_STARTED_MS),
    kind: 'process',
    pid: process.pid,
  };
}

/**
 * `dead` only when the owner is a process on THIS host and that pid is gone. A reused pid reads
 * `alive`, which can only delay a close until the idle bound; it never closes a live session.
 * External owners and other hosts read `unknown`: nothing here can probe them.
 */
export type OwnerLiveness = 'self' | 'alive' | 'dead' | 'unknown';

export function ownerLiveness(
  ownerKey: string | null,
  self: SessionOwner = currentSessionOwner()
): OwnerLiveness {
  if (!ownerKey) return 'unknown';
  if (ownerKey === self.key) return 'self';
  const match = /^pid:([0-9a-f]+):(\d+):(\d+)$/.exec(ownerKey);
  if (!match || match[1] !== THIS_HOST_ID) return 'unknown';
  try {
    process.kill(Number(match[2]), 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead';
  }
}

/** Format: PS-YYYY-MM-DD-NNN, one counter per project per day. */
export function generateSessionId(existingIds: string[]): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const prefix = `PS-${dateStr}-`;

  // Find the highest counter for today
  let maxCounter = 0;
  for (const id of existingIds) {
    if (id.startsWith(prefix)) {
      const counterStr = id.slice(prefix.length);
      const counter = parseInt(counterStr, 10);
      if (!isNaN(counter) && counter > maxCounter) {
        maxCounter = counter;
      }
    }
  }

  return `${prefix}${String(maxCounter + 1).padStart(3, '0')}`;
}

export interface NewSessionInput {
  type: string;
  title: string;
  sprintId: string | null;
  agent: string;
  /** ISO timestamp for started_at and the start event. */
  now: string;
  implicit: boolean;
  ownerKey: string | null;
}

export type NewSessionOutcome =
  | { ok: true; sessionId: string; warnings: string[] }
  | { ok: false; error: CmosToolError };

/**
 * The one place a local session row is written (explicit start and implicit open). Retries on a
 * session-id collision (a restore, or another process minting the same counter between the SELECT
 * and the INSERT), stamps genesis columns, and logs the start event.
 *
 * PRECONDITION: the caller ran ensureImplicitSessionColumns into its own answer's warnings (the
 * migration-warning census requires the migration at the answer boundary, not in a helper). A
 * caller that forgot fails loudly on the INSERT's column list, never silently.
 */
export function insertNewSession(
  client: CmosDatabaseClient,
  input: NewSessionInput
): NewSessionOutcome {
  const warnings: string[] = [];
  const todayPrefix = `PS-${new Date().toISOString().split('T')[0]}-`;
  const MAX_ID_RETRIES = 3;
  let sessionId = '';
  let inserted: ReturnType<CmosDatabaseClient['execute']> = { success: false };

  for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
    const existing = client.getMany<{ id: string }>(
      'SELECT id FROM sessions WHERE id LIKE ? ORDER BY id DESC',
      [`${todayPrefix}%`]
    );
    sessionId = generateSessionId(
      existing.success && existing.data ? existing.data.map((r) => r.id) : []
    );

    const g = genesisColumns(client, 'sessions', getProjectId(client));
    inserted = client.execute(
      `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures, next_steps, metadata, implicit, owner_key, ${g.columns.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', NULL, NULL, ?, ?, ${g.placeholders})`,
      [
        sessionId,
        input.type,
        input.title,
        input.sprintId,
        input.now,
        input.agent,
        input.implicit ? 1 : 0,
        input.ownerKey,
        ...g.values,
      ]
    );
    if (inserted.success) break;

    // Only a UNIQUE collision on the session id is worth another counter.
    const isIdCollision =
      inserted.error?.code === CMOS_ERROR_CODES.INVALID_PARAMETER && inserted.error?.field === 'id';
    if (!isIdCollision) break;
  }

  if (!inserted.success) {
    return {
      ok: false,
      error: {
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to create session: ${inserted.error?.message ?? 'Unknown error'}`,
        suggestion: 'Check database permissions and schema integrity',
      },
    };
  }

  const rawEvent = JSON.stringify({
    ts: input.now,
    agent: input.agent,
    session: sessionId,
    action: 'start',
    status: 'active',
    summary: input.title,
  });
  // The session DID start, so a lost event row must not undo it, but it must not be silent either.
  checkWrite(
    client.execute(
      `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
       VALUES (?, ?, ?, 'start', 'active', ?, ?, ?)`,
      [input.now, input.agent, sessionId, input.title, input.sprintId, rawEvent]
    ),
    warnings,
    'Session start event logging'
  );

  return { ok: true, sessionId, warnings };
}

export interface CallerSession {
  sessionId: string;
  implicit: boolean;
  /** True when this call opened the implicit session. */
  opened: boolean;
}

export type CallerSessionOutcome =
  | { ok: true; session: CallerSession | null; warnings: string[] }
  | { ok: false; error: CmosToolError };

/** The title an implicit session carries: who opened it, never a hostname. */
export function implicitSessionTitle(owner: SessionOwner = currentSessionOwner()): string {
  return owner.kind === 'external'
    ? `Implicit session (${owner.key})`
    : `Implicit session (process ${owner.pid})`;
}

/** Stores in which this process has used an implicit session, for the close at stdin end. */
const storesWithImplicitUse = new Map<string, number>();

function noteImplicitUse(dbPath: string): void {
  storesWithImplicitUse.set(dbPath, Date.now());
}

/** Store paths this process opened or found its implicit session in. */
export function storesUsedImplicitly(): string[] {
  return [...storesWithImplicitUse.keys()];
}

/**
 * Reconcile runs once per process per store: after the first write call there, of any kind and
 * whether or not it succeeded, and only for that call's own store. A store counts as reconciled
 * only once a reconcile pass actually read it.
 */
const reconciledStores = new Set<string>();

export function storeNeedsReconcile(dbPath: string): boolean {
  return !reconciledStores.has(dbPath);
}

export function markStoreReconciled(dbPath: string): void {
  reconciledStores.add(dbPath);
}

/**
 * The session a write that names none belongs to (see the module docblock for the order). With
 * `open: false` it never writes a session row and answers null when the caller has none.
 *
 * PRECONDITION: as for {@link insertNewSession}, the caller ran ensureImplicitSessionColumns.
 */
export function resolveCallerSession(
  client: CmosDatabaseClient,
  options: { open: boolean; agent?: string; now?: string }
): CallerSessionOutcome {
  const warnings: string[] = [];

  const explicit = client.getOne<{ id: string }>(
    `SELECT id FROM sessions WHERE status = 'active' AND implicit = 0 ORDER BY started_at DESC LIMIT 1`,
    []
  );
  if (!explicit.success) {
    return {
      ok: false,
      error: explicit.error ?? {
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: 'Failed to find active session',
      },
    };
  }
  if (explicit.data) {
    return {
      ok: true,
      session: { sessionId: explicit.data.id, implicit: false, opened: false },
      warnings,
    };
  }

  const owner = currentSessionOwner();
  const own = client.getOne<{ id: string }>(
    `SELECT id FROM sessions
      WHERE status = 'active' AND implicit = 1 AND owner_key = ?
      ORDER BY started_at DESC LIMIT 1`,
    [owner.key]
  );
  if (!own.success) {
    return {
      ok: false,
      error: own.error ?? {
        code: CMOS_ERROR_CODES.DB_QUERY_FAILED,
        message: "Failed to find this process's implicit session",
      },
    };
  }
  if (own.data) {
    noteImplicitUse(client.path);
    return {
      ok: true,
      session: { sessionId: own.data.id, implicit: true, opened: false },
      warnings,
    };
  }
  if (!options.open) return { ok: true, session: null, warnings };

  const opened = insertNewSession(client, {
    type: 'custom',
    title: implicitSessionTitle(owner),
    sprintId: null,
    agent: options.agent ?? 'assistant',
    now: options.now ?? new Date().toISOString(),
    implicit: true,
    ownerKey: owner.key,
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  noteImplicitUse(client.path);
  return {
    ok: true,
    session: { sessionId: opened.sessionId, implicit: true, opened: true },
    warnings: [...warnings, ...opened.warnings],
  };
}

/**
 * The latest moment a session did anything: its start, its newest capture, and the newest decision
 * or learning it authored. Derived, so no row write is needed per activity.
 *
 * Stored times are UTC. SQLite's own spelling (`YYYY-MM-DD HH:MM:SS`, no zone) is normalized to
 * ISO first: Date.parse reads that spelling as LOCAL time, which east of UTC makes a session look
 * hours older than it is, close enough to the idle bound to close a live one.
 */
export function lastActivityMs(
  client: CmosDatabaseClient,
  session: { id: string; started_at: string; captures: string | null }
): number {
  const parse = (value: string): number => Date.parse(normalizeCloseTimestamp(value));
  const times: number[] = [parse(session.started_at)];
  try {
    const captures: unknown = JSON.parse(session.captures ?? '[]');
    if (Array.isArray(captures)) {
      for (const capture of captures) {
        const stamp = (capture as { timestamp?: unknown })?.timestamp;
        if (typeof stamp === 'string') times.push(parse(stamp));
      }
    }
  } catch {
    // An unreadable capture blob adds nothing; the other anchors still count.
  }
  for (const table of ['strategic_decisions', 'learnings'] as const) {
    const newest = client.getOne<{ newest: string | null }>(
      `SELECT MAX(created_at) AS newest FROM ${table} WHERE author_session_id = ?`,
      [session.id]
    );
    if (newest.success && newest.data?.newest) times.push(parse(newest.data.newest));
  }
  const known = times.filter((t) => Number.isFinite(t));
  return known.length > 0 ? Math.max(...known) : Date.now();
}

/**
 * Whether a named session belongs to another running process: implicit, not this process's, and
 * its owner alive (or not probeable from here). Such a session is never WRITTEN to by this caller,
 * however idle: a write would be attributed to that process and would restart its idle clock. It
 * may be COMPLETED once it has idled past the bound, which is exactly when reconcile would close
 * it; a session whose owner is gone is fair game for both.
 */
export function heldByAnotherProcess(
  client: CmosDatabaseClient,
  session: {
    id: string;
    started_at: string;
    captures: string | null;
    implicit?: number | null;
    owner_key?: string | null;
  },
  purpose: 'write' | 'complete',
  nowMs: number = Date.now(),
  self: SessionOwner = currentSessionOwner()
): boolean {
  if (session.implicit !== 1) return false;
  const liveness = ownerLiveness(session.owner_key ?? null, self);
  if (liveness === 'self' || liveness === 'dead') return false;
  if (purpose === 'write') return true;
  return nowMs - lastActivityMs(client, session) <= IMPLICIT_SESSION_IDLE_HOURS * HOUR_MS;
}

export type CloseReason = 'owner-exited' | 'idle' | 'process-exit';

export interface SessionToClose {
  sessionId: string;
  title: string;
  implicit: boolean;
  reason: CloseReason;
  idleHours: number;
}

interface ActiveSessionRow {
  id: string;
  title: string;
  started_at: string;
  captures: string | null;
  owner_key: string | null;
}

const roundHours = (ms: number): number => Math.round((ms / HOUR_MS) * 10) / 10;

/**
 * Implicit sessions reconcile should close: another process's session whose owner is gone from
 * this host, or any implicit session idle past {@link IMPLICIT_SESSION_IDLE_HOURS}. This process's
 * own sessions are never candidates. Null when the read failed. The finders below never migrate: a
 * store without the `implicit` column has no implicit session, and every active session is explicit.
 */
export function implicitSessionsToClose(
  client: CmosDatabaseClient,
  nowMs: number = Date.now(),
  self: SessionOwner = currentSessionOwner()
): SessionToClose[] | null {
  if (!tableHasColumn(client, 'sessions', 'implicit')) return [];
  const rows = client.getMany<ActiveSessionRow>(
    `SELECT id, title, started_at, captures, owner_key FROM sessions
      WHERE status = 'active' AND implicit = 1 AND (owner_key IS NULL OR owner_key <> ?)
      ORDER BY started_at ASC`,
    [self.key]
  );
  if (!rows.success || !rows.data) return null;

  const close: SessionToClose[] = [];
  for (const row of rows.data) {
    const idleMs = nowMs - lastActivityMs(client, row);
    const liveness = ownerLiveness(row.owner_key, self);
    if (liveness === 'dead') {
      close.push({
        sessionId: row.id,
        title: row.title,
        implicit: true,
        reason: 'owner-exited',
        idleHours: roundHours(idleMs),
      });
    } else if (idleMs > IMPLICIT_SESSION_IDLE_HOURS * HOUR_MS) {
      close.push({
        sessionId: row.id,
        title: row.title,
        implicit: true,
        reason: 'idle',
        idleHours: roundHours(idleMs),
      });
    }
  }
  return close;
}

/**
 * The explicit sessions an explicit start would meet: those idle past the bound (closed first, with
 * a receipt) and a count of live ones (which make the start refuse). Null when the read failed.
 */
export function explicitSessionsAtStart(
  client: CmosDatabaseClient,
  nowMs: number = Date.now()
): { idle: SessionToClose[]; live: number } | null {
  const migrated = tableHasColumn(client, 'sessions', 'implicit');
  const rows = client.getMany<ActiveSessionRow>(
    migrated
      ? `SELECT id, title, started_at, captures, owner_key FROM sessions
          WHERE status = 'active' AND implicit = 0
          ORDER BY started_at ASC`
      : `SELECT id, title, started_at, captures, NULL AS owner_key FROM sessions
          WHERE status = 'active'
          ORDER BY started_at ASC`,
    []
  );
  if (!rows.success || !rows.data) return null;
  const idle: SessionToClose[] = [];
  let live = 0;
  for (const row of rows.data) {
    const idleMs = nowMs - lastActivityMs(client, row);
    if (idleMs > IMPLICIT_SESSION_IDLE_HOURS * HOUR_MS) {
      idle.push({
        sessionId: row.id,
        title: row.title,
        implicit: false,
        reason: 'idle',
        idleHours: roundHours(idleMs),
      });
    } else {
      live += 1;
    }
  }
  return { idle, live };
}

/** This process's own active implicit session in a store, if any. */
export function ownImplicitSession(
  client: CmosDatabaseClient,
  self: SessionOwner = currentSessionOwner()
): { id: string; title: string } | null {
  if (!tableHasColumn(client, 'sessions', 'implicit')) return null;
  const own = client.getOne<{ id: string; title: string }>(
    `SELECT id, title FROM sessions
      WHERE status = 'active' AND implicit = 1 AND owner_key = ?
      ORDER BY started_at DESC LIMIT 1`,
    [self.key]
  );
  return own.success && own.data ? own.data : null;
}

/**
 * The summary a session closed by the server carries: counts and mission ids, nothing generated.
 */
export function automaticCloseSummary(input: {
  reason: CloseReason;
  idleHours: number | null;
  captures: string | null;
  decisions: number;
  learnings: number;
}): string {
  const why =
    input.reason === 'process-exit'
      ? 'its process ended'
      : input.reason === 'owner-exited'
        ? 'the process that opened it is gone'
        : `idle ${input.idleHours ?? '?'} h, past the ${IMPLICIT_SESSION_IDLE_HOURS} h bound`;
  const byCategory = new Map<string, number>();
  const missions = new Set<string>();
  try {
    const captures: unknown = JSON.parse(input.captures ?? '[]');
    if (Array.isArray(captures)) {
      for (const capture of captures) {
        const c = capture as { category?: unknown; missionId?: unknown };
        const category = typeof c.category === 'string' ? c.category : 'unknown';
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
        if (typeof c.missionId === 'string' && c.missionId) missions.add(c.missionId);
      }
    }
  } catch {
    byCategory.set('unreadable', 1);
  }
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
  const parts = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => `${count} ${category}`);
  return (
    `Closed automatically: ${why}. ` +
    `${total} capture${total === 1 ? '' : 's'}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}; ` +
    `${input.decisions} decision${input.decisions === 1 ? '' : 's'} and ` +
    `${input.learnings} learning${input.learnings === 1 ? '' : 's'} authored` +
    (missions.size > 0 ? `; missions: ${[...missions].sort().join(', ')}` : '') +
    '.'
  );
}
