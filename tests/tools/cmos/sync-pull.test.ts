/**
 * Sprint 71 m02 — PULL-MERGE consumer tests.
 *
 * Verifies the incremental PULL consumer (sync-pull.ts) against a real
 * seed-schema store with mocked dashboard responses: genesis insert-union,
 * provenance preservation (not re-stamp), transition deferral, cursor
 * advance/persist, pagination, idempotent re-pull, and per-event isolation.
 *
 * @module tests/tools/cmos/sync-pull
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncPull, formatSyncPullForLLM } from '../../../src/tools/cmos/sync-pull';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

// ─── Fetch mock ────────────────────────────────────────────────────────────────

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

const SLUG = 'test-project';

interface PulledEvent {
  cursor: number;
  eventType: string;
  payload: unknown;
  receivedAt: string;
  processed: boolean;
  error: string | null;
}
interface EventPage {
  events: PulledEvent[];
  nextCursor: number;
  hasMore: boolean;
}

let eventPages: EventPage[] = [];
let pageIndex = 0;
let eventsRequestUrls: string[] = [];

function queuePages(...pages: EventPage[]): void {
  eventPages = pages;
  pageIndex = 0;
}

function loginResponse() {
  return {
    success: true,
    data: {
      token: 'test-jwt-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: { id: 'user-1', email: 'test@example.com', username: 'tester', projects: [] },
    },
  };
}

function setupFetchMock() {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/auth/login')) {
      return new Response(JSON.stringify(loginResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/events')) {
      eventsRequestUrls.push(url);
      const page = eventPages[pageIndex] ?? { events: [], nextCursor: 0, hasMore: false };
      pageIndex++;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            events: page.events,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            returnedCount: page.events.length,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ─── Event builders ──────────────────────────────────────────────────────────

interface Prov {
  stableEventId: string;
  occurredAt: number;
  originSeq: number;
  schemaVersion?: number;
}

function ev(
  cursor: number,
  eventType: string,
  data: Record<string, unknown>,
  opts: { timestamp?: string; projectId?: string } = {}
): PulledEvent {
  return {
    cursor,
    eventType,
    payload: {
      projectId: opts.projectId ?? 'proj-test',
      projectName: 'Test Project',
      eventType,
      timestamp: opts.timestamp ?? '2026-05-31T10:00:00Z',
      data,
      senderUserId: 'u1',
    },
    receivedAt: '2026-05-31T10:00:01Z',
    processed: true,
    error: null,
  };
}

function withProv(data: Record<string, unknown>, p: Prov): Record<string, unknown> {
  return {
    ...data,
    stableEventId: p.stableEventId,
    occurredAt: p.occurredAt,
    originSeq: p.originSeq,
    schemaVersion: p.schemaVersion ?? 1,
  };
}

// ─── Test setup ────────────────────────────────────────────────────────────────

describe('syncPull (Sprint 71 m02)', () => {
  let tempDir: string;
  let dbPath: string;
  const ENV_BACKUP: Record<string, string | undefined> = {};
  const seedSchema = fs.readFileSync(
    path.join(__dirname, '../../../cmos-seed/db/schema.sql'),
    'utf8'
  );

  beforeEach(() => {
    for (const key of ['CMOS_DASHBOARD_URL', 'CMOS_DASHBOARD_USER', 'CMOS_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.CMOS_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.CMOS_DASHBOARD_USER = 'test@example.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'test-password';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-syncpull-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
    eventsRequestUrls = [];
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    setupFetchMock();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createStore(extraSql = ''): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', '${SLUG}');
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'master', '{}');
      ${extraSql}
    `);
    db.close();
  }

  function openDb(): InstanceType<typeof Database> {
    return new Database(dbPath);
  }

  function cursorValue(): string | undefined {
    const db = openDb();
    const row = db
      .prepare(`SELECT value FROM metadata WHERE key = ?`)
      .get(`pull_cursor:${SLUG}`) as { value: string } | undefined;
    db.close();
    return row?.value;
  }

  // ─── Provenance preservation ────────────────────────────────────────────────

  it('inserts a genesis decision preserving the origin provenance verbatim (no re-stamp)', async () => {
    createStore();
    queuePages({
      events: [
        ev(
          42,
          'decision_captured',
          withProv(
            { decisionId: 5, content: 'A pulled decision', contentHash: 'h5' },
            {
              stableEventId: '01TESTDECISIONULID00000000',
              occurredAt: 1780245313635,
              originSeq: 777,
              schemaVersion: 2,
            }
          )
        ),
      ],
      nextCursor: 42,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.inserted).toBe(1);
    expect(result.data?.insertedByType).toEqual({ decision_captured: 1 });

    const db = openDb();
    const row = db.prepare(`SELECT * FROM strategic_decisions WHERE id = 5`).get() as Record<
      string,
      unknown
    >;
    db.close();
    expect(row.decision_text).toBe('A pulled decision');
    // Provenance is the ORIGIN's, carried verbatim — not a freshly minted ULID/seq.
    expect(row.stable_event_id).toBe('01TESTDECISIONULID00000000');
    expect(row.occurred_at).toBe(1780245313635);
    expect(row.origin_seq).toBe(777);
    expect(row.schema_version).toBe(2);
    expect(row.project_id).toBe('proj-test');
    expect(row.event_type).toBe('decision_captured');
    // author_user_id stays unset on the replica (dashboard-authoritative).
    expect(row.author_user_id).toBeNull();
    // created_at comes from the envelope timestamp (ISO), not occurred_at (ms).
    expect(row.created_at).toBe('2026-05-31T10:00:00Z');
  });

  // ─── Idempotent re-pull ───────────────────────────────────────────────────────

  it('is idempotent: re-pulling the same event inserts once, then reports duplicates', async () => {
    createStore();
    const page: EventPage = {
      events: [
        ev(
          10,
          'learning_captured',
          withProv(
            { learningId: 3, content: 'L3' },
            { stableEventId: '01TESTLEARNINGULID00000000', occurredAt: 1780240000000, originSeq: 3 }
          )
        ),
      ],
      nextCursor: 10,
      hasMore: false,
    };

    queuePages(page);
    const first = await syncPull({ projectRoot: tempDir });
    expect(first.data?.inserted).toBe(1);
    expect(first.data?.duplicates).toBe(0);

    // Reset the cursor so the same event is fetched again, simulating a re-pull
    // from the beginning. The ON CONFLICT(natural key) makes the merge a no-op.
    const db = openDb();
    db.prepare(`DELETE FROM metadata WHERE key = ?`).run(`pull_cursor:${SLUG}`);
    db.close();

    queuePages(page);
    const second = await syncPull({ projectRoot: tempDir });
    expect(second.data?.inserted).toBe(0);
    expect(second.data?.duplicates).toBe(1);

    const dbc = openDb();
    const count = (dbc.prepare(`SELECT COUNT(*) AS c FROM learnings`).get() as { c: number }).c;
    dbc.close();
    expect(count).toBe(1);
  });

  // ─── Cursor advance + persistence ──────────────────────────────────────────────

  it('advances and persists the per-project cursor to nextCursor', async () => {
    createStore();
    queuePages({
      events: [
        ev(
          99,
          'sprint_added',
          withProv(
            { sprintId: 's99', title: 'Sprint 99' },
            { stableEventId: '01TESTSPRINTULID0000000000', occurredAt: 1780240000000, originSeq: 1 }
          )
        ),
      ],
      nextCursor: 99,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.fromCursor).toBe(0);
    expect(result.data?.toCursor).toBe(99);
    expect(cursorValue()).toBe('99');
  });

  it('resumes from the persisted cursor (sends it as ?since=)', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('pull_cursor:${SLUG}', '500');`);
    queuePages({ events: [], nextCursor: 500, hasMore: false });

    await syncPull({ projectRoot: tempDir });
    expect(eventsRequestUrls[0]).toContain('since=500');
  });

  // ─── Pagination ────────────────────────────────────────────────────────────────

  it('pages until hasMore=false, merging every page', async () => {
    createStore();
    queuePages(
      {
        events: [
          ev(
            1,
            'decision_captured',
            withProv(
              { decisionId: 1, content: 'd1' },
              { stableEventId: '01D1', occurredAt: 1780240000001, originSeq: 1 }
            )
          ),
        ],
        nextCursor: 1,
        hasMore: true,
      },
      {
        events: [
          ev(
            2,
            'decision_captured',
            withProv(
              { decisionId: 2, content: 'd2' },
              { stableEventId: '01D2', occurredAt: 1780240000002, originSeq: 2 }
            )
          ),
        ],
        nextCursor: 2,
        hasMore: false,
      }
    );

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.pages).toBe(2);
    expect(result.data?.received).toBe(2);
    expect(result.data?.inserted).toBe(2);
    expect(result.data?.toCursor).toBe(2);
    expect(cursorValue()).toBe('2');
  });

  // ─── Transition deferral (mutable surface → UC2) ────────────────────────────────

  it('defers transition events (counts, does NOT apply the mutable status)', async () => {
    createStore();
    queuePages({
      events: [
        ev(
          1,
          'mission_added',
          withProv(
            {
              missionId: 'm-x',
              name: 'Mission X',
              sprintId: '',
              status: 'In Progress',
              objective: null,
            },
            { stableEventId: '01MX', occurredAt: 1780240000000, originSeq: 1 }
          )
        ),
        ev(
          2,
          'mission_completed',
          withProv(
            { missionId: 'm-x', currentStatus: 'Completed', completedAt: '2026-05-31T12:00:00Z' },
            { stableEventId: '01MX', occurredAt: 1780240000000, originSeq: 1 }
          )
        ),
      ],
      nextCursor: 2,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.inserted).toBe(1); // mission_added only
    expect(result.data?.transitionsDeferred).toBe(1); // mission_completed deferred

    const db = openDb();
    const row = db.prepare(`SELECT status FROM missions WHERE id = 'm-x'`).get() as {
      status: string;
    };
    db.close();
    // The deferred transition must NOT have flipped the local status to Completed.
    expect(row.status).toBe('In Progress');
  });

  // ─── Missing provenance is skipped, never re-stamped ────────────────────────────

  it('skips a genesis event whose required provenance is missing (no re-stamp, no insert)', async () => {
    createStore();
    queuePages({
      events: [
        // No stableEventId/occurredAt/originSeq in data → cannot reconstruct faithfully.
        ev(7, 'decision_captured', { decisionId: 9, content: 'no provenance' }),
      ],
      nextCursor: 7,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.skippedMissingProvenance).toBe(1);
    expect(result.data?.inserted).toBe(0);

    const db = openDb();
    const count = (
      db.prepare(`SELECT COUNT(*) AS c FROM strategic_decisions`).get() as { c: number }
    ).c;
    db.close();
    expect(count).toBe(0);
  });

  it('counts a structurally-malformed payload (no data object) as skippedMissingProvenance, not failed', async () => {
    createStore();
    queuePages({
      events: [
        // payload carries no `data` object → un-reconstructable. This must NOT land
        // in `failed` (which implies a retryable DB insert error), but in the
        // "couldn't extract what's needed" bucket.
        {
          cursor: 8,
          eventType: 'decision_captured',
          payload: { projectId: 'proj-test', eventType: 'decision_captured' },
          receivedAt: '2026-05-31T10:00:01Z',
          processed: true,
          error: null,
        },
      ],
      nextCursor: 8,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.skippedMissingProvenance).toBe(1);
    expect(result.data?.failed).toBe(0);
    expect(result.data?.inserted).toBe(0);
  });

  // ─── Dependency edges + FK isolation ────────────────────────────────────────────

  it('inserts dependency edges (no provenance) and isolates an FK-failing edge', async () => {
    createStore();
    queuePages({
      events: [
        ev(
          1,
          'mission_added',
          withProv(
            { missionId: 'dep-mA', name: 'A', sprintId: '', status: 'Queued' },
            { stableEventId: '01MA', occurredAt: 1780240000001, originSeq: 1 }
          )
        ),
        ev(
          2,
          'mission_added',
          withProv(
            { missionId: 'dep-mB', name: 'B', sprintId: '', status: 'Queued' },
            { stableEventId: '01MB', occurredAt: 1780240000002, originSeq: 2 }
          )
        ),
        ev(3, 'dependency_added', { fromId: 'dep-mA', toId: 'dep-mB', type: 'Blocks' }),
        // References a mission that does not exist → FK violation, isolated.
        ev(4, 'dependency_added', { fromId: 'dep-mA', toId: 'ghost-mission', type: 'Blocks' }),
      ],
      nextCursor: 4,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.failed).toBe(1); // the ghost-referencing edge
    // 2 missions + 1 valid dependency inserted.
    expect(result.data?.inserted).toBe(3);

    const db = openDb();
    const deps = db.prepare(`SELECT from_id, to_id FROM mission_dependencies`).all() as Array<{
      from_id: string;
      to_id: string;
    }>;
    db.close();
    expect(deps).toEqual([{ from_id: 'dep-mA', to_id: 'dep-mB' }]);
  });

  // ─── Unknown event type ─────────────────────────────────────────────────────────

  it('skips unrecognized event types', async () => {
    createStore();
    queuePages({
      events: [ev(1, 'something_unexpected', { foo: 'bar' })],
      nextCursor: 1,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.skippedUnknownType).toBe(1);
    expect(result.data?.inserted).toBe(0);
  });

  // ─── Empty pull ───────────────────────────────────────────────────────────────

  it('handles an empty pull (no new events) without advancing the cursor', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('pull_cursor:${SLUG}', '12');`);
    queuePages({ events: [], nextCursor: 12, hasMore: false });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.received).toBe(0);
    expect(result.data?.inserted).toBe(0);
    expect(result.data?.toCursor).toBe(12);
  });

  // ─── All genesis types ──────────────────────────────────────────────────────────

  it('insert-unions every genesis event type with preserved provenance', async () => {
    createStore();
    queuePages({
      events: [
        ev(
          1,
          'sprint_added',
          withProv(
            { sprintId: 's100', title: 'S100' },
            { stableEventId: '01S', occurredAt: 1780240000001, originSeq: 1 }
          )
        ),
        ev(
          2,
          'session_started',
          withProv(
            {
              sessionId: 'sess-9',
              type: 'build',
              title: 'Build',
              startedAt: '2026-05-31T09:00:00Z',
              sprintId: '',
            },
            { stableEventId: '01SESS', occurredAt: 1780240000002, originSeq: 2 }
          )
        ),
        ev(
          3,
          'mission_added',
          withProv(
            { missionId: 'm-9', name: 'M9', sprintId: '', status: 'Queued', objective: 'do' },
            { stableEventId: '01M9', occurredAt: 1780240000003, originSeq: 3 }
          )
        ),
        ev(
          4,
          'decision_captured',
          withProv(
            { decisionId: 50, content: 'dec' },
            { stableEventId: '01DEC', occurredAt: 1780240000004, originSeq: 4 }
          )
        ),
        ev(
          5,
          'learning_captured',
          withProv(
            { learningId: 60, content: 'lrn' },
            { stableEventId: '01LRN', occurredAt: 1780240000005, originSeq: 5 }
          )
        ),
      ],
      nextCursor: 5,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.inserted).toBe(5);
    expect(result.data?.insertedByType).toEqual({
      sprint_added: 1,
      session_started: 1,
      mission_added: 1,
      decision_captured: 1,
      learning_captured: 1,
    });

    const db = openDb();
    const session = db
      .prepare(`SELECT status, stable_event_id FROM sessions WHERE id = 'sess-9'`)
      .get() as {
      status: string;
      stable_event_id: string;
    };
    db.close();
    expect(session.status).toBe('active'); // session_started default
    expect(session.stable_event_id).toBe('01SESS');
  });

  // ─── Error / guard paths ──────────────────────────────────────────────────────

  it('errors with MISSING_PARAMETER when no slug is available', async () => {
    // Store without dashboard_slug.
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(
      `INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
       INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');`
    );
    db.close();

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  it('hard-fails when the first page request fails', async () => {
    createStore();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Server error', { status: 500 });
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.success).toBe(false);
  });

  // ─── Formatter ──────────────────────────────────────────────────────────────────

  it('formats a successful pull for the LLM', () => {
    const formatted = formatSyncPullForLLM({
      success: true,
      data: {
        slug: SLUG,
        fromCursor: 0,
        toCursor: 5,
        pages: 1,
        received: 5,
        inserted: 4,
        duplicates: 1,
        transitionsApplied: 0,
        transitionsSkipped: 0,
        transitionsDeferred: 2,
        skippedMissingProvenance: 0,
        skippedUnknownType: 0,
        failed: 0,
        insertedByType: { decision_captured: 4 },
        message: 'ok',
      },
    });
    expect(formatted).toContain('PULL complete');
    expect(formatted).toContain('decision_captured:4');
    expect(formatted).toContain('deferred');
  });

  // ─── Collab-store inbound mutable-LWW (Sprint 71 m04) ───────────────────────────

  function missionAdded(cursor: number, id: string, status: string, p: Prov): PulledEvent {
    return ev(
      cursor,
      'mission_added',
      withProv({ missionId: id, name: id, sprintId: '', status, objective: null }, p)
    );
  }
  function missionTransition(
    cursor: number,
    type: string,
    id: string,
    currentStatus: string,
    p: Prov
  ): PulledEvent {
    return ev(cursor, type, withProv({ missionId: id, currentStatus }, p));
  }

  it('applies an inbound mission transition to the local row on a COLLAB store', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');`);
    queuePages({
      events: [
        missionAdded(1, 'm-c', 'In Progress', {
          stableEventId: '01MC',
          occurredAt: 1780240000000,
          originSeq: 1,
        }),
        // A fresh per-edit completion (newer occurred_at) — should apply via LWW.
        missionTransition(2, 'mission_completed', 'm-c', 'Completed', {
          stableEventId: '01MCEDIT',
          occurredAt: 1780240999999,
          originSeq: 5,
        }),
      ],
      nextCursor: 2,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.inserted).toBe(1); // mission_added
    expect(result.data?.transitionsApplied).toBe(1);
    expect(result.data?.transitionsDeferred).toBe(0);

    const db = openDb();
    const row = db.prepare(`SELECT status FROM missions WHERE id = 'm-c'`).get() as {
      status: string;
    };
    const state = db
      .prepare(`SELECT value FROM metadata WHERE key = 'mutable_status:mission_active:m-c'`)
      .get() as { value: string } | undefined;
    db.close();
    expect(row.status).toBe('Completed'); // inbound transition flipped local status
    expect(JSON.parse(state!.value).occurredAt).toBe(1780240999999); // tracked winner ordering
  });

  it('does NOT clobber a newer local value with a STALE inbound transition (LWW skip)', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');`);
    queuePages({
      events: [
        missionAdded(1, 'm-d', 'In Progress', {
          stableEventId: '01MD',
          occurredAt: 1780240000000,
          originSeq: 1,
        }),
        // Newer edit wins → Blocked @ 2000.
        missionTransition(2, 'mission_updated', 'm-d', 'Blocked', {
          stableEventId: '01MD2',
          occurredAt: 1780240002000,
          originSeq: 2,
        }),
        // STALE edit (older occurred_at) → must lose LWW, NOT clobber Blocked.
        missionTransition(3, 'mission_completed', 'm-d', 'Completed', {
          stableEventId: '01MD3',
          occurredAt: 1780240001000,
          originSeq: 9,
        }),
      ],
      nextCursor: 3,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(1); // only the Blocked edit applied
    expect(result.data?.transitionsSkipped).toBe(1); // the stale Completed edit skipped

    const db = openDb();
    const row = db.prepare(`SELECT status FROM missions WHERE id = 'm-d'`).get() as {
      status: string;
    };
    db.close();
    expect(row.status).toBe('Blocked'); // stale edit did not clobber the newer value
  });

  it('skips an inbound transition for a mission row that does not exist yet (no state recorded)', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');`);
    queuePages({
      events: [
        // mission_added never arrives in this page — transition references a ghost row.
        missionTransition(1, 'mission_completed', 'ghost-m', 'Completed', {
          stableEventId: '01GHOST',
          occurredAt: 1780240000000,
          originSeq: 1,
        }),
      ],
      nextCursor: 1,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(0);
    expect(result.data?.transitionsSkipped).toBe(1);

    const db = openDb();
    const state = db
      .prepare(`SELECT value FROM metadata WHERE key = 'mutable_status:mission_active:ghost-m'`)
      .get() as { value: string } | undefined;
    db.close();
    expect(state).toBeUndefined(); // no ordering state recorded for a non-existent row
  });

  it('still DEFERS mission transitions on a SOLO store (no collab_role) — m02 behavior preserved', async () => {
    createStore(); // no collab_role
    queuePages({
      events: [
        missionAdded(1, 'm-solo', 'In Progress', {
          stableEventId: '01SOLO',
          occurredAt: 1780240000000,
          originSeq: 1,
        }),
        missionTransition(2, 'mission_completed', 'm-solo', 'Completed', {
          stableEventId: '01SOLO2',
          occurredAt: 1780240999999,
          originSeq: 2,
        }),
      ],
      nextCursor: 2,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(0);
    expect(result.data?.transitionsDeferred).toBe(1);

    const db = openDb();
    const row = db.prepare(`SELECT status FROM missions WHERE id = 'm-solo'`).get() as {
      status: string;
    };
    db.close();
    expect(row.status).toBe('In Progress'); // deferred — not applied on a solo store
  });

  it('defers sprint_completed/session_completed even on a collab store (not broker-wired)', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');`);
    queuePages({
      events: [
        ev(
          1,
          'sprint_completed',
          withProv(
            { sprintId: 's-x', currentStatus: 'Completed' },
            { stableEventId: '01SX', occurredAt: 1780240000000, originSeq: 1 }
          )
        ),
        ev(
          2,
          'session_completed',
          withProv(
            { sessionId: 'sess-x', currentStatus: 'completed' },
            { stableEventId: '01SESSX', occurredAt: 1780240000001, originSeq: 2 }
          )
        ),
      ],
      nextCursor: 2,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsDeferred).toBe(2);
    expect(result.data?.transitionsApplied).toBe(0);
  });

  // ─── Collab-store inbound sprint_status (Sprint 72 m02) ──────────────────────────

  function sprintUpdated(cursor: number, id: string, status: string, p: Prov): PulledEvent {
    return ev(cursor, 'sprint_updated', withProv({ sprintId: id, status }, p));
  }

  it('applies an inbound sprint_updated to the local sprints.status on a COLLAB store', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');
      INSERT INTO sprints (id, title, status) VALUES ('s-c', 'Sprint C', 'Active');`);
    queuePages({
      events: [
        sprintUpdated(1, 's-c', 'Completed', {
          stableEventId: '01SPC',
          occurredAt: 1780240999999,
          originSeq: 5,
        }),
      ],
      nextCursor: 1,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(1);
    expect(result.data?.transitionsDeferred).toBe(0);

    const db = openDb();
    const row = db.prepare(`SELECT status FROM sprints WHERE id = 's-c'`).get() as {
      status: string;
    };
    const state = db
      .prepare(`SELECT value FROM metadata WHERE key = 'mutable_status:sprint_status:s-c'`)
      .get() as { value: string } | undefined;
    db.close();
    expect(row.status).toBe('Completed');
    expect(JSON.parse(state!.value).occurredAt).toBe(1780240999999);
  });

  it('does NOT clobber a newer local sprint status with a STALE inbound sprint_updated (LWW skip)', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');
      INSERT INTO sprints (id, title, status) VALUES ('s-d', 'Sprint D', 'Active');`);
    queuePages({
      events: [
        sprintUpdated(1, 's-d', 'In Progress', {
          stableEventId: '01SD1',
          occurredAt: 1780240002000,
          originSeq: 2,
        }),
        sprintUpdated(2, 's-d', 'Completed', {
          stableEventId: '01SD2',
          occurredAt: 1780240001000, // stale (older) → must lose LWW
          originSeq: 9,
        }),
      ],
      nextCursor: 2,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(1);
    expect(result.data?.transitionsSkipped).toBe(1);

    const db = openDb();
    const row = db.prepare(`SELECT status FROM sprints WHERE id = 's-d'`).get() as {
      status: string;
    };
    db.close();
    expect(row.status).toBe('In Progress'); // stale edit did not clobber the newer value
  });

  it('still DEFERS sprint_updated on a SOLO store (no collab_role)', async () => {
    createStore(
      `INSERT INTO sprints (id, title, status) VALUES ('s-solo', 'Sprint Solo', 'Active');`
    );
    queuePages({
      events: [
        sprintUpdated(1, 's-solo', 'Completed', {
          stableEventId: '01SSOLO',
          occurredAt: 1780240999999,
          originSeq: 1,
        }),
      ],
      nextCursor: 1,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(0);
    expect(result.data?.transitionsDeferred).toBe(1);

    const db = openDb();
    const row = db.prepare(`SELECT status FROM sprints WHERE id = 's-solo'`).get() as {
      status: string;
    };
    db.close();
    expect(row.status).toBe('Active'); // deferred — not applied on a solo store
  });

  // ─── Collab-store inbound project_identity (Sprint 72 m03) ───────────────────────

  function readProjectName(): string | undefined {
    const db = openDb();
    const r = db.prepare(`SELECT content FROM contexts WHERE id = 'project_identity'`).get() as
      | { content: string }
      | undefined;
    db.close();
    return r ? (JSON.parse(r.content).project_name as string) : undefined;
  }

  it('applies an inbound project_identity_updated to the local project_name on a COLLAB store', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');`);
    queuePages({
      events: [
        ev(
          1,
          'project_identity_updated',
          withProv(
            { name: 'Renamed By Peer' },
            { stableEventId: '01PID1', occurredAt: 1780240999999, originSeq: 5 }
          )
        ),
      ],
      nextCursor: 1,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(1);
    expect(result.data?.transitionsDeferred).toBe(0);

    expect(readProjectName()).toBe('Renamed By Peer');

    const db = openDb();
    const state = db
      .prepare(`SELECT value FROM metadata WHERE key = 'mutable_status:project_identity:project'`)
      .get() as { value: string } | undefined;
    db.close();
    expect(JSON.parse(state!.value).occurredAt).toBe(1780240999999);
  });

  it('does NOT clobber a newer local project_name with a STALE inbound project_identity_updated', async () => {
    createStore(`INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');`);
    queuePages({
      events: [
        ev(
          1,
          'project_identity_updated',
          withProv(
            { name: 'Newer Name' },
            { stableEventId: '01PID2', occurredAt: 1780240002000, originSeq: 2 }
          )
        ),
        ev(
          2,
          'project_identity_updated',
          withProv(
            { name: 'Stale Name' },
            { stableEventId: '01PID3', occurredAt: 1780240001000, originSeq: 9 } // stale
          )
        ),
      ],
      nextCursor: 2,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(1);
    expect(result.data?.transitionsSkipped).toBe(1);
    expect(readProjectName()).toBe('Newer Name'); // stale edit did not clobber
  });

  it('still DEFERS project_identity_updated on a SOLO store (no collab_role)', async () => {
    createStore();
    queuePages({
      events: [
        ev(
          1,
          'project_identity_updated',
          withProv(
            { name: 'Should Not Apply' },
            { stableEventId: '01PIDSOLO', occurredAt: 1780240999999, originSeq: 1 }
          )
        ),
      ],
      nextCursor: 1,
      hasMore: false,
    });

    const result = await syncPull({ projectRoot: tempDir });
    expect(result.data?.transitionsApplied).toBe(0);
    expect(result.data?.transitionsDeferred).toBe(1);
  });
});
