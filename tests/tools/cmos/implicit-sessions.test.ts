// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m03 — implicit sessions: a write that names no session lands in the caller's own
// ABOUTME: session, no reader takes another process's, and the server closes what nobody will.

/**
 * Two "processes" share one store throughout. They are told apart by owner key: both carry this
 * test's own pid, so the liveness probe reads them as ALIVE, and differ by start time, which is part
 * of the key (a reused pid is a different owner). A DEAD owner is a real pid: a child process that
 * has exited and been reaped. The cross-process version of the attribution test, with two real
 * server processes over stdio, is tests/e2e/implicit-sessions.e2e.ts.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import * as checkpointBackfill from '../../../src/tools/cmos/checkpoint-backfill';
import { withClientAsync } from '../../../src/tools/cmos/client';
import { cmosAgentOnboard } from '../../../src/tools/cmos/cmos-agent-onboard';
import { cmosDecisionsRecord } from '../../../src/tools/cmos/cmos-decisions-record';
import { cmosMissionComplete } from '../../../src/tools/cmos/cmos-mission-complete';
import { cmosProjectSweep } from '../../../src/tools/cmos/cmos-project-sweep';
import { cmosSession } from '../../../src/tools/cmos/cmos-session';
import { cmosSessionCapture } from '../../../src/tools/cmos/cmos-session-capture';
import { cmosSessionComplete } from '../../../src/tools/cmos/cmos-session-complete';
import { cmosSessionStart } from '../../../src/tools/cmos/cmos-session-start';
import { CMOS_ERROR_CODES, createSuccess } from '../../../src/tools/cmos/errors';
import {
  closeOwnImplicitSessions,
  reconcileImplicitSessions,
} from '../../../src/tools/cmos/implicit-session-lifecycle';
import { detectOrphans } from '../../../src/tools/cmos/orphan-detection';
import {
  IMPLICIT_SESSION_SCHEMA_VERSION,
  ensureImplicitSessionColumns,
} from '../../../src/tools/cmos/schema-migrations';
import {
  IMPLICIT_SESSION_IDLE_HOURS,
  insertNewSession,
  lastActivityMs,
  processOwnerKey,
  setSessionOwnerForTesting,
  type SessionOwner,
} from '../../../src/tools/cmos/session-owner';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const SPRINT = 'sprint-m03t';
const PLANNED = 'sprint-m03-planned';
const NEXT = 'sprint-m03-next';
const MISSION = 'm03t-m01';
/** A mission of the PLANNED sprint: its sprint differs from the one open at any close. */
const PLANNED_MISSION = 'm03t-planned-m01';
const HOUR_MS = 60 * 60 * 1000;

const ownerA: SessionOwner = {
  key: processOwnerKey(process.pid, 1),
  kind: 'process',
  pid: process.pid,
};
const ownerB: SessionOwner = {
  key: processOwnerKey(process.pid, 2),
  kind: 'process',
  pid: process.pid,
};

/** A pid that was real and is now gone: a child that exited and was reaped. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

interface Store {
  projectRoot: string;
  dbPath: string;
}

const stores: Store[] = [];

function buildStore(): Store {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m03-'));
  const dbPath = seedCmosDb(projectRoot, { projectName: 's92-m03 fixture' });
  // Each store is its own project: two stores claiming one identity is refused at registration.
  reidentifyCmosTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    // Every sprint is created here, before any write migrates the genesis columns to NOT NULL.
    const now = new Date().toISOString();
    const sprint = db.prepare(
      `INSERT INTO sprints (id, title, status, start_date) VALUES (?, ?, ?, ?)`
    );
    sprint.run(SPRINT, 'Implicit sessions', 'Active', now);
    sprint.run(PLANNED, 'Planned next', 'Planned', now);
    sprint.run(NEXT, 'After that', 'Planned', now);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, started_at) VALUES (?, ?, 'Mission', 'In Progress', ?)`
    ).run(MISSION, SPRINT, now);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, 'Planned work', 'Queued')`
    ).run(PLANNED_MISSION, PLANNED);
  } finally {
    db.close();
  }
  const store = { projectRoot, dbPath };
  stores.push(store);
  return store;
}

interface SessionRow {
  id: string;
  status: string;
  implicit: number;
  owner_key: string | null;
  sprint_id: string | null;
  summary: string | null;
}

function sessionRow(store: Store, id: string): SessionRow {
  const db = new Database(store.dbPath);
  try {
    return db
      .prepare(
        'SELECT id, status, implicit, owner_key, sprint_id, summary FROM sessions WHERE id = ?'
      )
      .get(id) as SessionRow;
  } finally {
    db.close();
  }
}

function query<T>(store: Store, sql: string, ...params: unknown[]): T[] {
  const db = new Database(store.dbPath);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function run(store: Store, sql: string, ...params: unknown[]): void {
  const db = new Database(store.dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Open a session row directly, for an owner and a start time the test chooses. */
async function plantSession(
  store: Store,
  input: { implicit: boolean; ownerKey: string | null; startedAt: string; title?: string }
): Promise<string> {
  const opened = await withClientAsync(
    async (client) => {
      const outcome = insertNewSession(client, {
        type: 'custom',
        title: input.title ?? 'planted',
        sprintId: null,
        agent: 'test',
        now: input.startedAt,
        implicit: input.implicit,
        ownerKey: input.ownerKey,
      });
      if (!outcome.ok) throw new Error(outcome.error.message);
      return createSuccess(outcome.sessionId);
    },
    { projectRoot: store.projectRoot }
  );
  return opened.data!;
}

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR_MS).toISOString();

beforeEach(() => {
  CmosDetector.resetInstance();
});

afterEach(() => {
  setSessionOwnerForTesting(null);
  jest.restoreAllMocks();
  while (stores.length > 0) {
    fs.rmSync(stores.pop()!.projectRoot, { recursive: true, force: true });
  }
});

describe('s92-m03 — a capture never fails for lack of a session', () => {
  it('a fresh process captures with no open session; the rows land in its implicit session', async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);

    const first = await cmosSessionCapture({
      category: 'decision',
      content: 'first capture with no session open',
      projectRoot: store.projectRoot,
    });
    expect(first.success).toBe(true);
    expect(first.data!.implicitSession).toEqual({ opened: true });
    const sessionId = first.data!.sessionId;

    const row = sessionRow(store, sessionId);
    expect(row).toMatchObject({ status: 'active', implicit: 1, owner_key: ownerA.key });
    // An implicit session carries no sprint; the decision resolved its own at write time.
    expect(row.sprint_id).toBeNull();
    const decisions = query<{ author_session_id: string; sprint_id: string }>(
      store,
      'SELECT author_session_id, sprint_id FROM strategic_decisions WHERE decision_text = ?',
      'first capture with no session open'
    );
    expect(decisions).toEqual([{ author_session_id: sessionId, sprint_id: SPRINT }]);

    const second = await cmosSessionCapture({
      category: 'learning',
      content: 'second capture reuses the implicit session',
      projectRoot: store.projectRoot,
    });
    expect(second.success).toBe(true);
    expect(second.data!.sessionId).toBe(sessionId);
    expect(second.data!.implicitSession).toEqual({ opened: false });
  });

  it('an open explicit session still takes every capture that names none, as before 3.2.0', async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    const started = await cmosSessionStart({
      type: 'planning',
      title: 'explicit planning',
      projectRoot: store.projectRoot,
    });
    expect(started.success).toBe(true);

    setSessionOwnerForTesting(ownerB);
    const captured = await cmosSessionCapture({
      category: 'context',
      content: 'lands in the explicit session',
      projectRoot: store.projectRoot,
    });
    expect(captured.success).toBe(true);
    expect(captured.data!.sessionId).toBe(started.data!.sessionId);
    expect(captured.data!.implicitSession).toBeUndefined();
    expect(query(store, 'SELECT id FROM sessions WHERE implicit = 1')).toEqual([]);
  });
});

describe('s92-m03 — attribution: each process writes under its own session', () => {
  it("two processes capture and record; each row's author is its own process's session", async () => {
    const store = buildStore();
    const authored: Record<string, string> = {};

    for (const [name, owner] of [
      ['A', ownerA],
      ['B', ownerB],
    ] as const) {
      setSessionOwnerForTesting(owner);
      const captured = await cmosSessionCapture({
        category: 'decision',
        content: `capture by process ${name}`,
        projectRoot: store.projectRoot,
      });
      const recorded = await cmosDecisionsRecord({
        content: `record by process ${name}`,
        projectRoot: store.projectRoot,
      });
      expect(captured.success).toBe(true);
      expect(recorded.success).toBe(true);
      expect(recorded.data!.authorSessionId).toBe(captured.data!.sessionId);
      authored[name] = captured.data!.sessionId;
    }

    expect(authored.A).not.toBe(authored.B);
    const rows = query<{ decision_text: string; author_session_id: string }>(
      store,
      `SELECT decision_text, author_session_id FROM strategic_decisions ORDER BY id`
    );
    expect(rows).toEqual([
      { decision_text: 'capture by process A', author_session_id: authored.A },
      { decision_text: 'record by process A', author_session_id: authored.A },
      { decision_text: 'capture by process B', author_session_id: authored.B },
      { decision_text: 'record by process B', author_session_id: authored.B },
    ]);
  });

  it("neither process can complete the other's implicit session; each completes its own", async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    const a = await cmosSessionCapture({
      category: 'context',
      content: 'A works',
      projectRoot: store.projectRoot,
    });
    setSessionOwnerForTesting(ownerB);
    const b = await cmosSessionCapture({
      category: 'context',
      content: 'B works',
      projectRoot: store.projectRoot,
    });

    // B names A's session: refused, and A's session is untouched.
    const refused = await cmosSessionComplete({
      sessionId: a.data!.sessionId,
      summary: 'B tries to close A',
      projectRoot: store.projectRoot,
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatchObject({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      field: 'sessionId',
    });
    expect(refused.error!.message).toContain(a.data!.sessionId);
    expect(sessionRow(store, a.data!.sessionId).status).toBe('active');

    // B completes without naming a session: its own closes, A's stays open.
    const own = await cmosSessionComplete({ summary: 'B is done', projectRoot: store.projectRoot });
    expect(own.success).toBe(true);
    expect(own.data!.sessionId).toBe(b.data!.sessionId);
    expect(sessionRow(store, b.data!.sessionId).status).toBe('completed');
    expect(sessionRow(store, a.data!.sessionId).status).toBe('active');

    // With no session left, B's complete finds nothing of its own, and still not A's.
    const nothing = await cmosSessionComplete({
      summary: 'B again',
      projectRoot: store.projectRoot,
    });
    expect(nothing.error?.code).toBe(CMOS_ERROR_CODES.SESSION_NOT_ACTIVE);
    expect(sessionRow(store, a.data!.sessionId).status).toBe('active');
  });
});

describe("s92-m03 — no call writes into another process's implicit session", () => {
  it("a capture naming another live process's implicit session is refused and writes nothing", async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    const a = await cmosSessionCapture({
      category: 'context',
      content: 'A works',
      projectRoot: store.projectRoot,
    });
    const before = query<{ captures: string }>(
      store,
      'SELECT captures FROM sessions WHERE id = ?',
      a.data!.sessionId
    );

    setSessionOwnerForTesting(ownerB);
    const intrusion = await cmosSessionCapture({
      sessionId: a.data!.sessionId,
      category: 'decision',
      content: 'B writes a decision into A by naming it',
      projectRoot: store.projectRoot,
    });
    expect(intrusion.success).toBe(false);
    expect(intrusion.error).toMatchObject({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      field: 'sessionId',
    });
    expect(
      query(
        store,
        'SELECT id FROM strategic_decisions WHERE decision_text = ?',
        'B writes a decision into A by naming it'
      )
    ).toEqual([]);
    expect(
      query<{ captures: string }>(
        store,
        'SELECT captures FROM sessions WHERE id = ?',
        a.data!.sessionId
      )
    ).toEqual(before);
    // B's own sessions were not touched either: the refusal comes before any write.
    expect(query(store, 'SELECT id FROM sessions WHERE owner_key = ?', ownerB.key)).toEqual([]);
  });
});

describe('s92-m03 — reconcile', () => {
  it('closes a dead owner and a 12 h-idle session with receipts, and leaves live ones open', async () => {
    const store = buildStore();
    const dead = await plantSession(store, {
      implicit: true,
      ownerKey: processOwnerKey(deadPid(), 7),
      startedAt: hoursAgo(1),
      title: 'dead owner',
    });
    const live = await plantSession(store, {
      implicit: true,
      ownerKey: ownerB.key,
      startedAt: hoursAgo(1),
      title: 'live owner',
    });
    const idleExternal = await plantSession(store, {
      implicit: true,
      ownerKey: 'ext:hook-session-old',
      startedAt: hoursAgo(IMPLICIT_SESSION_IDLE_HOURS + 1),
      title: 'idle external',
    });
    const freshExternal = await plantSession(store, {
      implicit: true,
      ownerKey: 'ext:hook-session-new',
      startedAt: hoursAgo(1),
      title: 'fresh external',
    });

    // Process A's first capture opens its implicit session, which runs reconcile.
    setSessionOwnerForTesting(ownerA);
    const captured = await cmosSessionCapture({
      category: 'next-step',
      content: 'A arrives',
      projectRoot: store.projectRoot,
    });
    expect(captured.success).toBe(true);
    const receipts = captured.data!.closedSessions ?? [];
    expect(receipts.map((r) => [r.sessionId, r.reason, r.closed]).sort()).toEqual(
      [
        [dead, 'owner-exited', true],
        [idleExternal, 'idle', true],
      ].sort()
    );
    for (const receipt of receipts) {
      expect(receipt.summary).toMatch(/^Closed automatically: /);
      expect(sessionRow(store, receipt.sessionId)).toMatchObject({
        status: 'completed',
        summary: receipt.summary,
      });
    }
    expect(sessionRow(store, live).status).toBe('active');
    expect(sessionRow(store, freshExternal).status).toBe('active');
    expect(sessionRow(store, captured.data!.sessionId).status).toBe('active');
  });

  it("reconcile never closes the calling process's own session, however idle", async () => {
    const store = buildStore();
    const own = await plantSession(store, {
      implicit: true,
      ownerKey: ownerA.key,
      startedAt: hoursAgo(IMPLICIT_SESSION_IDLE_HOURS + 5),
    });
    setSessionOwnerForTesting(ownerA);
    const outcome = await reconcileImplicitSessions(store.projectRoot);
    expect(outcome.receipts).toEqual([]);
    expect(sessionRow(store, own).status).toBe('active');
  });

  it('runs on a process’s first implicit use whatever the handler: a mission completion', async () => {
    const store = buildStore();
    const orphan = await plantSession(store, {
      implicit: true,
      ownerKey: processOwnerKey(deadPid(), 9),
      startedAt: hoursAgo(1),
      title: 'orphan before a mission completion',
    });
    setSessionOwnerForTesting(ownerA);
    const completed = await cmosMissionComplete({
      missionId: MISSION,
      notes: 'done',
      decisions: ['a decision recorded at completion'],
      projectRoot: store.projectRoot,
    });
    expect(completed.success).toBe(true);
    expect(sessionRow(store, orphan).status).toBe('completed');
    expect((completed.warnings ?? []).join('\n')).toContain(orphan);

    // The process reconciled this store once; a later capture finds its session, and closes nothing.
    const later = await cmosSessionCapture({
      category: 'context',
      content: 'after',
      projectRoot: store.projectRoot,
    });
    expect(later.data!.implicitSession).toEqual({ opened: false });
    expect(later.data!.closedSessions).toBeUndefined();
  });

  it("a running process's session is never written into, however idle", async () => {
    const store = buildStore();
    const idle = await plantSession(store, {
      implicit: true,
      ownerKey: ownerA.key,
      startedAt: hoursAgo(IMPLICIT_SESSION_IDLE_HOURS + 1),
    });
    setSessionOwnerForTesting(ownerB);
    const write = await cmosSessionCapture({
      sessionId: idle,
      category: 'decision',
      content: 'a write into an idle session of a live process',
      projectRoot: store.projectRoot,
    });
    expect(write.error).toMatchObject({
      code: CMOS_ERROR_CODES.INVALID_PARAMETER,
      field: 'sessionId',
    });
    expect(
      query(store, 'SELECT id FROM strategic_decisions WHERE author_session_id = ?', idle)
    ).toEqual([]);
    // The refused call was still B's first write to the store, so its reconcile ran and closed
    // the idle session (the receipt rides on the refusal's warnings), instead of the write
    // reviving it.
    expect(sessionRow(store, idle).status).toBe('completed');
    expect((write.warnings ?? []).join('\n')).toContain(idle);
  });

  it('reconciles on the first write even when it lands in a live explicit session', async () => {
    const store = buildStore();
    const orphan = await plantSession(store, {
      implicit: true,
      ownerKey: processOwnerKey(deadPid(), 13),
      startedAt: hoursAgo(1),
      title: 'orphan beside an explicit session',
    });
    const started = await cmosSessionStart({
      type: 'planning',
      title: 'sprint-long explicit',
      projectRoot: store.projectRoot,
    });
    // With no live blocker the start itself reconciled and closed the orphan. Reopen it, to model
    // a process that died after the explicit session began.
    run(store, `UPDATE sessions SET status = 'active', completed_at = NULL WHERE id = ?`, orphan);

    setSessionOwnerForTesting(ownerA);
    const captured = await cmosSessionCapture({
      category: 'context',
      content: 'lands in the explicit session',
      projectRoot: store.projectRoot,
    });
    expect(captured.data!.sessionId).toBe(started.data!.sessionId);
    expect(captured.data!.closedSessions?.map((r) => r.sessionId)).toEqual([orphan]);
    expect(sessionRow(store, orphan).status).toBe('completed');
  });

  it('a session idle past the bound may be completed by any process', async () => {
    const store = buildStore();
    const idle = await plantSession(store, {
      implicit: true,
      ownerKey: ownerA.key,
      startedAt: hoursAgo(IMPLICIT_SESSION_IDLE_HOURS + 1),
    });
    setSessionOwnerForTesting(ownerB);
    const closed = await cmosSessionComplete({
      sessionId: idle,
      summary: 'closing an abandoned session',
      projectRoot: store.projectRoot,
    });
    expect(closed.success).toBe(true);
    expect(sessionRow(store, idle).status).toBe('completed');
  });
});

describe('s92-m03 — idle is measured in UTC whatever the spelling', () => {
  it("reads SQLite's zone-less spelling as UTC, not local time", async () => {
    const store = buildStore();
    // Whole seconds: SQLite's spelling carries none smaller.
    const instant = new Date(Math.floor((Date.now() - 2 * HOUR_MS) / 1000) * 1000);
    const sqliteSpelling = instant
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');
    const measured = await withClientAsync(
      async (client) =>
        createSuccess(
          lastActivityMs(client, { id: 'PS-none', started_at: sqliteSpelling, captures: '[]' })
        ),
      { projectRoot: store.projectRoot }
    );
    // Off by the local UTC offset if the spelling were read as local time (east of UTC: older).
    expect(measured.data).toBe(instant.getTime());
  });
});

describe('s92-m03 — the server closes implicit sessions without syncing', () => {
  it('at process end, closes its own implicit session in every store it used, and uploads nothing', async () => {
    const trigger = jest.spyOn(checkpointBackfill, 'triggerCheckpointBackfill');
    const first = buildStore();
    const second = buildStore();
    setSessionOwnerForTesting(ownerA);
    const inFirst = await cmosSessionCapture({
      category: 'next-step',
      content: 'carry this',
      projectRoot: first.projectRoot,
    });
    const inSecond = await cmosSessionCapture({
      category: 'context',
      content: 'note',
      projectRoot: second.projectRoot,
    });
    setSessionOwnerForTesting(ownerB);
    const other = await cmosSessionCapture({
      category: 'context',
      content: 'B keeps going',
      projectRoot: first.projectRoot,
    });

    setSessionOwnerForTesting(ownerA);
    const outcome = await closeOwnImplicitSessions();
    const closedIds = outcome.receipts.map((r) => r.sessionId).sort();
    expect(closedIds).toEqual([inFirst.data!.sessionId, inSecond.data!.sessionId].sort());
    for (const receipt of outcome.receipts) {
      expect(receipt).toMatchObject({ reason: 'process-exit', closed: true, idleHours: null });
    }
    expect(sessionRow(first, inFirst.data!.sessionId).status).toBe('completed');
    expect(sessionRow(second, inSecond.data!.sessionId).status).toBe('completed');
    expect(sessionRow(first, other.data!.sessionId).status).toBe('active');
    // The deferred next-step materialized at the close, as an explicit complete would do.
    expect(
      query<{ content: string; sprint_id: string }>(
        first,
        'SELECT content, sprint_id FROM next_steps WHERE session_id = ?',
        inFirst.data!.sessionId
      )
    ).toEqual([{ content: 'carry this', sprint_id: SPRINT }]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('positive control: a complete through the cmos_session router does trigger the upload', async () => {
    const trigger = jest.spyOn(checkpointBackfill, 'triggerCheckpointBackfill');
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    await cmosSessionCapture({
      category: 'context',
      content: 'before an explicit complete',
      projectRoot: store.projectRoot,
    });
    const completed = await cmosSession({
      action: 'complete',
      summary: 'asked for',
      projectRoot: store.projectRoot,
    });
    expect(completed.success).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe('s92-m03 — explicit sessions', () => {
  it('an implicit session never blocks an explicit start', async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    await cmosSessionCapture({ category: 'context', content: 'x', projectRoot: store.projectRoot });
    const started = await cmosSessionStart({
      type: 'review',
      title: 'review',
      projectRoot: store.projectRoot,
    });
    expect(started.success).toBe(true);
    expect(started.data!.closedSessions).toBeUndefined();
  });

  it('a start refused by a live explicit session closes nothing', async () => {
    const store = buildStore();
    const live = await plantSession(store, {
      implicit: false,
      ownerKey: null,
      startedAt: hoursAgo(1),
      title: 'live explicit',
    });
    const orphan = await plantSession(store, {
      implicit: true,
      ownerKey: processOwnerKey(deadPid(), 11),
      startedAt: hoursAgo(1),
      title: 'orphan',
    });
    const refused = await cmosSessionStart({
      type: 'planning',
      title: 'refused',
      projectRoot: store.projectRoot,
    });
    expect(refused.error?.code).toBe(CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE);
    expect(sessionRow(store, live).status).toBe('active');
    expect(sessionRow(store, orphan).status).toBe('active');
  });

  it('closes an explicit blocker idle past 12 h with a receipt, and still refuses a fresh one', async () => {
    const store = buildStore();
    const blocker = await plantSession(store, {
      implicit: false,
      ownerKey: null,
      startedAt: hoursAgo(IMPLICIT_SESSION_IDLE_HOURS + 2),
      title: 'forgotten planning',
    });

    const started = await cmosSessionStart({
      type: 'planning',
      title: 'today',
      projectRoot: store.projectRoot,
    });
    expect(started.success).toBe(true);
    expect(started.data!.closedSessions).toEqual([
      expect.objectContaining({
        sessionId: blocker,
        title: 'forgotten planning',
        implicit: false,
        reason: 'idle',
        closed: true,
      }),
    ]);
    expect(sessionRow(store, blocker).status).toBe('completed');

    const again = await cmosSessionStart({
      type: 'planning',
      title: 'second',
      projectRoot: store.projectRoot,
    });
    expect(again.success).toBe(false);
    expect(again.error?.code).toBe(CMOS_ERROR_CODES.SESSION_ALREADY_ACTIVE);
    expect(sessionRow(store, started.data!.sessionId).status).toBe('active');
  });
});

describe('s92-m03 — an explicit sprintId on start and capture (#589)', () => {
  it('start and capture accept an existing sprint of any status', async () => {
    const store = buildStore();
    const started = await cmosSessionStart({
      type: 'planning',
      title: 'planning the next sprint',
      sprintId: PLANNED,
      projectRoot: store.projectRoot,
    });
    expect(started.success).toBe(true);
    expect(sessionRow(store, started.data!.sessionId).sprint_id).toBe(PLANNED);

    const decided = await cmosSessionCapture({
      category: 'decision',
      content: 'tagged to the planned sprint',
      sprintId: PLANNED,
      projectRoot: store.projectRoot,
    });
    const stepped = await cmosSessionCapture({
      category: 'next-step',
      content: 'next-step for the planned sprint',
      sprintId: PLANNED,
      projectRoot: store.projectRoot,
    });
    expect(decided.success && stepped.success).toBe(true);
    expect(
      query<{ sprint_id: string }>(
        store,
        'SELECT sprint_id FROM strategic_decisions WHERE decision_text = ?',
        'tagged to the planned sprint'
      )
    ).toEqual([{ sprint_id: PLANNED }]);

    await cmosSessionComplete({ summary: 'done planning', projectRoot: store.projectRoot });
    expect(
      query<{ sprint_id: string }>(
        store,
        'SELECT sprint_id FROM next_steps WHERE content = ?',
        'next-step for the planned sprint'
      )
    ).toEqual([{ sprint_id: PLANNED }]);
  });

  it("a missionId's sprint decides deferred rows too, over sprintId and over the close", async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    // The mission's sprint (PLANNED) is neither the sprint named (NEXT) nor the one open at the
    // close (SPRINT), so each wrong rule gives a different answer.
    for (const [content, sprintId] of [
      ['mission step', undefined],
      ['mission step naming another sprint', NEXT],
    ] as const) {
      const captured = await cmosSessionCapture({
        category: 'next-step',
        content,
        missionId: PLANNED_MISSION,
        ...(sprintId ? { sprintId } : {}),
        projectRoot: store.projectRoot,
      });
      expect(captured.success).toBe(true);
    }
    await cmosSessionComplete({ summary: 'end', projectRoot: store.projectRoot });
    expect(
      query<{ content: string; sprint_id: string }>(
        store,
        `SELECT content, sprint_id FROM next_steps WHERE content LIKE 'mission step%' ORDER BY content`
      )
    ).toEqual([
      { content: 'mission step', sprint_id: PLANNED },
      { content: 'mission step naming another sprint', sprint_id: PLANNED },
    ]);
  });

  it('a sprint that does not exist is refused by name, and nothing is opened or closed', async () => {
    const store = buildStore();
    const blocker = await plantSession(store, {
      implicit: false,
      ownerKey: null,
      startedAt: hoursAgo(IMPLICIT_SESSION_IDLE_HOURS + 2),
    });
    setSessionOwnerForTesting(ownerA);

    const capture = await cmosSessionCapture({
      category: 'decision',
      content: 'never written',
      sprintId: 'sprint-nope',
      projectRoot: store.projectRoot,
    });
    expect(capture.error).toMatchObject({ code: CMOS_ERROR_CODES.SPRINT_NOT_FOUND });
    expect(capture.error!.message).toContain('sprint-nope');

    const start = await cmosSessionStart({
      type: 'planning',
      title: 'never started',
      sprintId: 'sprint-nope',
      projectRoot: store.projectRoot,
    });
    expect(start.error).toMatchObject({ code: CMOS_ERROR_CODES.SPRINT_NOT_FOUND });

    expect(query(store, 'SELECT id FROM sessions WHERE implicit = 1')).toEqual([]);
    expect(sessionRow(store, blocker).status).toBe('active');
  });

  it("an implicit session's close tags its next-steps with the sprint open at the close", async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    await cmosSessionCapture({
      category: 'next-step',
      content: 'outlived its sprint',
      projectRoot: store.projectRoot,
    });
    // The work moves on: the mission completes, its sprint closes, the next opens. (With work
    // still In Progress there, the write resolver would keep the old sprint, by design.)
    run(store, `UPDATE missions SET status = 'Completed' WHERE id = ?`, MISSION);
    run(store, `UPDATE sprints SET status = 'Completed' WHERE id = ?`, SPRINT);
    run(store, `UPDATE sprints SET status = 'Active' WHERE id = ?`, NEXT);

    const closed = await cmosSessionComplete({ summary: 'end', projectRoot: store.projectRoot });
    expect(closed.success).toBe(true);
    expect(
      query<{ sprint_id: string }>(
        store,
        'SELECT sprint_id FROM next_steps WHERE content = ?',
        'outlived its sprint'
      )
    ).toEqual([{ sprint_id: NEXT }]);
  });
});

describe('s92-m03 — the listers show explicit sessions only', () => {
  it("onboard's active session is the explicit one, never an implicit session", async () => {
    const store = buildStore();
    setSessionOwnerForTesting(ownerA);
    await cmosSessionCapture({ category: 'context', content: 'x', projectRoot: store.projectRoot });
    const implicitOnly = await cmosAgentOnboard({ projectRoot: store.projectRoot });
    expect(implicitOnly.data!.activeSession).toBeNull();

    const started = await cmosSessionStart({
      type: 'review',
      title: 'explicit',
      projectRoot: store.projectRoot,
    });
    const withExplicit = await cmosAgentOnboard({ projectRoot: store.projectRoot });
    expect(withExplicit.data!.activeSession?.id).toBe(started.data!.sessionId);
  });

  it('orphan detection and the cross-project sweep skip implicit sessions', async () => {
    const store = buildStore();
    // 30 h, not 3: orphan detection compares ISO started_at with SQLite datetime() text, so a
    // session stale since earlier the same calendar day is not yet flagged (a separate defect,
    // recorded as a next-step; not this mission's).
    const explicit = await plantSession(store, {
      implicit: false,
      ownerKey: null,
      startedAt: hoursAgo(30),
      title: 'explicit and old',
    });
    await plantSession(store, {
      implicit: true,
      ownerKey: ownerB.key,
      startedAt: hoursAgo(30),
      title: 'implicit and old',
    });

    const orphans = await withClientAsync(
      async (client) => createSuccess(detectOrphans(client, { staleSessionHours: 1 })),
      { projectRoot: store.projectRoot }
    );
    expect(orphans.data!.staleSessions.map((s) => s.id)).toEqual([explicit]);

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m03-cfg-'));
    try {
      ProjectGraphRegistry.resetInstance();
      const graph = await ProjectGraphRegistry.create({ configDir });
      graph.registerStore(store.projectRoot, { name: 's92-m03-sweep' });
      const swept = await cmosProjectSweep({ itemType: 'session' }, graph);
      expect(swept.success).toBe(true);
      expect(swept.data!.items.map((item) => item.summary)).toEqual(['explicit and old']);
    } finally {
      ProjectGraphRegistry.resetInstance();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe('s92-m03 — the migration', () => {
  it('adds both columns once, marks the store, and is a no-op after', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m03-mig-'));
    stores.push({ projectRoot, dbPath: '' });
    const dbDir = path.join(projectRoot, 'cmos', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'cmos.sqlite'));
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', captures TEXT);
      INSERT INTO sessions (id, type, title, started_at) VALUES ('PS-old', 'planning', 'old', 'x');
    `);
    db.close();

    const migrate = () =>
      withClientAsync(async (client) => createSuccess(ensureImplicitSessionColumns(client)), {
        projectRoot,
      });
    const first = await migrate();
    expect(first.data).toMatchObject({
      columnsAdded: ['sessions.implicit', 'sessions.owner_key'],
      alreadyCurrent: false,
    });
    const second = await migrate();
    expect(second.data).toMatchObject({ columnsAdded: [], alreadyCurrent: true });

    const check = new Database(path.join(dbDir, 'cmos.sqlite'));
    try {
      expect(
        check.prepare(`SELECT value FROM metadata WHERE key = 'implicit_session_columns'`).get()
      ).toEqual({ value: IMPLICIT_SESSION_SCHEMA_VERSION });
      // Every pre-existing session is explicit.
      expect(check.prepare(`SELECT implicit, owner_key FROM sessions`).all()).toEqual([
        { implicit: 0, owner_key: null },
      ]);
    } finally {
      check.close();
    }
  });
});

describe('s92-m03 — practice 2 and practice 8 fences', () => {
  const SRC = path.resolve(__dirname, '../../../src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : entry.name.endsWith('.ts') ? [full] : [];
    });
  const relative = (file: string): string => path.relative(path.resolve(SRC, '..'), file);

  it('every session INSERT is one of two known sites, and both stamp genesis columns', () => {
    const sites = files(SRC)
      .filter((file) =>
        /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\b/.test(fs.readFileSync(file, 'utf8'))
      )
      .map(relative)
      .sort();
    expect(sites).toEqual(['src/tools/cmos/session-owner.ts', 'src/tools/cmos/sync-merge.ts']);
    expect(fs.readFileSync(path.join(SRC, 'tools/cmos/session-owner.ts'), 'utf8')).toContain(
      "genesisColumns(client, 'sessions'"
    );
    expect(fs.readFileSync(path.join(SRC, 'tools/cmos/sync-merge.ts'), 'utf8')).toMatch(
      /INSERT INTO sessions\s+\([^)]*project_id, stable_event_id, occurred_at, origin_seq, event_type/
    );
  });

  it('the published single-active predicate matches only explicit-scoped lines', () => {
    // `grep -rn "FROM sessions" src | grep -i status | grep -i active`, as published at mission
    // start (6 sites then). Every remaining hit must scope to explicit sessions.
    const hits = files(SRC).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file: relative(file), line: index + 1, text: line }))
        .filter(
          ({ text }) =>
            text.includes('FROM sessions') && /status/i.test(text) && /active/i.test(text)
        )
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect({ ...hit, scoped: /implicit = 0|explicitOnly/.test(hit.text) }).toMatchObject({
        scoped: true,
      });
    }
  });

  it('no SQL string, multi-line included, picks active sessions without an implicit scope', () => {
    // The line predicate above misses SQL split across lines. This reads every string and
    // template literal that selects from sessions with status 'active', and requires an implicit
    // scope unless the site is named here with the reason it needs none.
    // Each exemption names its file AND a fragment of its one statement, so it cannot cover a
    // new unscoped statement added beside it.
    const UNSCOPED_BY_DESIGN: ReadonlyArray<{ file: string; fragment: RegExp; reason: string }> = [
      {
        file: 'src/tools/cmos/cmos-sprint-complete.ts',
        fragment: /WHERE sprint_id = \? AND status = 'active'/,
        reason: 'activeSessionsAtClose filters by sprint_id; an implicit session has no sprint_id',
      },
      {
        file: 'src/tools/cmos/session-owner.ts',
        fragment: /NULL AS owner_key/,
        reason: 'explicitSessionsAtStart on a store without the column, so no implicit session',
      },
    ];
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const literal_re = /`[^`]*`|'[^'\n]*'|"[^"\n]*"/g;
      for (let match = literal_re.exec(text); match; match = literal_re.exec(text)) {
        const literal = match[0];
        // The 3.1.0 spelling bound the value: `status = ?` with ['active'] right after the SQL.
        const boundActive =
          /FROM\s+sessions\b[^()]*?\bstatus\s*=\s*\?/.test(literal) &&
          /^\s*,\s*\[\s*'active'/.test(text.slice(match.index + literal.length));
        if (boundActive && !/implicit\s*=\s*[01]|explicitOnly/.test(literal)) {
          offenders.push(`${relative(file)}: ${literal.replace(/\s+/g, ' ').slice(0, 120)}`);
          continue;
        }
        // The status predicate must belong to the sessions select: it follows FROM sessions with
        // no parenthesis between, so a subquery inside another table's predicate does not count.
        if (!/FROM\s+sessions\b[^()]*?\bstatus\s*=\s*'active'/.test(literal)) continue;
        if (/implicit\s*=\s*[01]|explicitOnly/.test(literal)) continue;
        const exempt = UNSCOPED_BY_DESIGN.some(
          (entry) => entry.file === relative(file) && entry.fragment.test(literal)
        );
        if (exempt) continue;
        offenders.push(`${relative(file)}: ${literal.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
