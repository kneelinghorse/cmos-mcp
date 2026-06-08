/**
 * Sprint 71 m03 — clone-from-/state bootstrap tests.
 *
 * Verifies the clone bootstrap (sync-bootstrap.ts) against a real seed-schema store
 * with a mocked GET /state snapshot: current-mutable-state clone, provenance
 * preservation (verbatim, incl. BIGINT-string parsing and NULL single-user
 * tolerance), cursor seeding to syncLog.maxCursor, FK-integrity context ensure,
 * idempotent re-clone, and the hand-off to the m02 tail-pull from the seeded cursor.
 *
 * @module tests/tools/cmos/sync-bootstrap
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncBootstrap, formatSyncBootstrapForLLM } from '../../../src/tools/cmos/sync-bootstrap';
import { syncPull } from '../../../src/tools/cmos/sync-pull';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

// ─── Fetch mock ────────────────────────────────────────────────────────────────

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

const SLUG = 'shared-project';

interface StateOpts {
  /** When true, every entity's provenance fields are NULL (single-user mode). */
  nullProvenance?: boolean;
  maxCursor?: number;
}

function buildState(opts: StateOpts = {}) {
  const prov = (stableEventId: string, occurredAt: string, originSeq: string, schemaVersion = 1) =>
    opts.nullProvenance
      ? { stableEventId: null, occurredAt: null, originSeq: null, schemaVersion: null }
      : { stableEventId, occurredAt, originSeq, schemaVersion };

  return {
    project: {
      id: 'proj-shared',
      slug: SLUG,
      name: 'Shared Project',
      schemaVersion: '2.1',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:00.000Z',
    },
    sprints: [
      {
        id: 's1',
        title: 'Sprint One',
        status: 'Active',
        focus: 'Focus text',
        totalMissions: 2,
        completedMissions: 1,
        syncedAt: '2026-05-31T01:00:00.000Z',
        ...prov('01STATESPRINTULID000000000', '1780240000001', '1'),
      },
    ],
    missions: [
      {
        id: 'm1',
        sprintId: 's1',
        name: 'Mission One',
        status: 'Completed', // CURRENT mutable status — the reason /state is the clone source
        objective: 'Do the thing',
        startedAt: '2026-05-31T02:00:00.000Z',
        completedAt: '2026-05-31T03:00:00.000Z',
        syncedAt: '2026-05-31T03:01:00.000Z',
        ...prov('01STATEMISSION1ULID0000000', '1780240000002', '2'),
      },
      {
        id: 'm2',
        sprintId: 's1',
        name: 'Mission Two',
        status: 'Current',
        objective: 'Do the other thing',
        startedAt: null,
        completedAt: null,
        syncedAt: '2026-05-31T03:02:00.000Z',
        ...prov('01STATEMISSION2ULID0000000', '1780240000003', '3'),
      },
    ],
    sessions: [
      {
        id: 'sess1',
        type: 'build',
        title: 'Build session',
        status: 'completed', // CURRENT status (genesis would be 'active')
        startedAt: '2026-05-31T02:30:00.000Z',
        completedAt: '2026-05-31T03:30:00.000Z',
        syncedAt: '2026-05-31T03:31:00.000Z',
        ...prov('01STATESESSIONULID00000000', '1780240000004', '4'),
      },
    ],
    decisions: [
      {
        id: 10,
        decisionText: 'A cloned decision',
        category: 'tooling',
        sprintId: 's1',
        sessionId: 'sess1',
        missionId: 'm1',
        createdAt: '2026-05-31T02:45:00.000Z',
        syncedAt: '2026-05-31T02:46:00.000Z',
        ...prov('01STATEDECISIONULID0000000', '1780245313635', '777', 2),
      },
    ],
    learnings: [
      {
        id: 20,
        content: 'A cloned learning',
        category: 'process',
        sprintId: 's1',
        createdAt: '2026-05-31T02:50:00.000Z',
        syncedAt: '2026-05-31T02:51:00.000Z',
        ...prov('01STATELEARNINGULID0000000', '1780245400000', '888'),
      },
    ],
    dependencies: [
      { fromId: 'm1', toId: 'm2', type: 'Blocks', syncedAt: '2026-05-31T03:05:00.000Z' },
    ],
    contexts: [
      {
        id: 'master_context',
        updatedAt: '2026-05-31T03:00:00.000Z',
        syncedAt: '2026-05-31T03:00:00.000Z',
      },
    ],
    metadata: [],
    syncLog: {
      totalEntries: 6,
      processedEntries: 6,
      failedEntries: 0,
      maxCursor: opts.maxCursor ?? 42,
    },
  };
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

let stateBody: ReturnType<typeof buildState> | null = null;
let stateStatus = 200;
let eventsPages: Array<{ events: unknown[]; nextCursor: number; hasMore: boolean }> = [];
let eventsPageIndex = 0;
let eventsRequestUrls: string[] = [];

function setupFetchMock(): void {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/auth/login')) {
      return new Response(JSON.stringify(loginResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/state')) {
      if (stateStatus !== 200) return new Response('Server error', { status: stateStatus });
      return new Response(JSON.stringify({ success: true, data: stateBody }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/events')) {
      eventsRequestUrls.push(url);
      const page = eventsPages[eventsPageIndex] ?? { events: [], nextCursor: 0, hasMore: false };
      eventsPageIndex++;
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

// ─── Test setup ──────────────────────────────────────────────────────────────

describe('syncBootstrap (Sprint 71 m03)', () => {
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-bootstrap-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
    stateBody = buildState();
    stateStatus = 200;
    eventsPages = [];
    eventsPageIndex = 0;
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

  /** A bare seed-schema store with NO project identity and NO master_context row
   *  — the realistic fresh clone target (bootstrap seeds identity + contexts). */
  function createFreshStore(): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.close();
  }

  function openDb(): InstanceType<typeof Database> {
    return new Database(dbPath);
  }

  function meta(key: string): string | undefined {
    const db = openDb();
    const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    db.close();
    return row?.value;
  }

  // ─── Full clone with CURRENT mutable state ────────────────────────────────────

  it('reconstructs every entity from /state with CURRENT mutable status', async () => {
    createFreshStore();
    const result = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });

    expect(result.success).toBe(true);
    // 1 sprint + 2 missions + 1 session + 1 decision + 1 learning + 1 dependency = 7
    expect(result.data?.inserted).toBe(7);
    expect(result.data?.failed).toBe(0);
    expect(result.data?.insertedByType).toEqual({
      sprint_added: 1,
      mission_added: 2,
      session_started: 1,
      decision_captured: 1,
      learning_captured: 1,
      dependency_added: 1,
    });

    const db = openDb();
    const sprint = db.prepare(`SELECT * FROM sprints WHERE id = 's1'`).get() as Record<
      string,
      unknown
    >;
    const mission = db.prepare(`SELECT * FROM missions WHERE id = 'm1'`).get() as Record<
      string,
      unknown
    >;
    const session = db.prepare(`SELECT * FROM sessions WHERE id = 'sess1'`).get() as Record<
      string,
      unknown
    >;
    const decision = db.prepare(`SELECT * FROM strategic_decisions WHERE id = 10`).get() as Record<
      string,
      unknown
    >;
    const learning = db.prepare(`SELECT * FROM learnings WHERE id = 20`).get() as Record<
      string,
      unknown
    >;
    const dep = db.prepare(`SELECT from_id, to_id, type FROM mission_dependencies`).get() as Record<
      string,
      unknown
    >;
    db.close();

    // Current mutable state cloned — NOT stuck at creation values.
    expect(sprint.status).toBe('Active');
    expect(sprint.focus).toBe('Focus text');
    expect(sprint.total_missions).toBe(2);
    expect(sprint.completed_missions).toBe(1);
    expect(mission.status).toBe('Completed');
    expect(mission.started_at).toBe('2026-05-31T02:00:00.000Z');
    expect(mission.completed_at).toBe('2026-05-31T03:00:00.000Z');
    expect(session.status).toBe('completed'); // not the genesis 'active'
    expect(decision.decision_text).toBe('A cloned decision');
    expect(decision.author_session_id).toBe('sess1');
    expect(decision.mission_id).toBe('m1');
    expect(learning.content).toBe('A cloned learning');
    expect(dep).toEqual({ from_id: 'm1', to_id: 'm2', type: 'Blocks' });
  });

  // ─── Provenance preserved verbatim (BIGINT strings → ints) ─────────────────────

  it('preserves /state provenance verbatim, parsing BIGINT strings to integers', async () => {
    createFreshStore();
    await syncBootstrap({ projectRoot: tempDir, slug: SLUG });

    const db = openDb();
    const decision = db.prepare(`SELECT * FROM strategic_decisions WHERE id = 10`).get() as Record<
      string,
      unknown
    >;
    db.close();

    expect(decision.stable_event_id).toBe('01STATEDECISIONULID0000000');
    expect(decision.occurred_at).toBe(1780245313635); // raw ms-epoch, parsed from string
    expect(decision.origin_seq).toBe(777);
    expect(decision.schema_version).toBe(2);
    expect(decision.event_type).toBe('decision_captured');
    expect(decision.project_id).toBe('proj-shared'); // seeded from /state.project.id
    // author_user_id stays unset on the clone (dashboard-authoritative).
    expect(decision.author_user_id).toBeNull();
  });

  // ─── NULL provenance tolerated (single-user mode) ──────────────────────────────

  it('tolerates NULL provenance (single-user mode) — inserts, never re-stamps', async () => {
    createFreshStore();
    stateBody = buildState({ nullProvenance: true });

    const result = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(result.success).toBe(true);
    expect(result.data?.inserted).toBe(7);
    expect(result.data?.failed).toBe(0);

    const db = openDb();
    const mission = db.prepare(`SELECT * FROM missions WHERE id = 'm1'`).get() as Record<
      string,
      unknown
    >;
    db.close();
    // Preserved NULL — not a freshly minted ULID/clock.
    expect(mission.stable_event_id).toBeNull();
    expect(mission.occurred_at).toBeNull();
    expect(mission.origin_seq).toBeNull();
    // schema_version is NOT NULL DEFAULT 1 — a null coalesces to 1.
    expect(mission.schema_version).toBe(1);
    // Current status still cloned faithfully.
    expect(mission.status).toBe('Completed');
  });

  // ─── Cursor seeding ────────────────────────────────────────────────────────────

  it('seeds the per-project PULL cursor to syncLog.maxCursor', async () => {
    createFreshStore();
    const result = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(result.data?.cursorSeeded).toBe(42);
    expect(meta(`pull_cursor:${SLUG}`)).toBe('42');
  });

  it('records the dashboard linkage so a follow-on pull resolves the slug', async () => {
    createFreshStore();
    await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(meta('dashboard_slug')).toBe(SLUG);
    expect(meta('dashboard_project_id')).toBe('proj-shared');
    expect(meta('project_id')).toBe('proj-shared');
  });

  // ─── Collab marker (Sprint 71 m04, Fork A) ─────────────────────────────────────

  it('marks the clone as a collaborative store (collab_role=editor) so mutable edits route through event-push', async () => {
    createFreshStore();
    await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(meta('collab_role')).toBe('editor');
  });

  // ─── FK integrity: master_context ensured ──────────────────────────────────────

  it('ensures master_context so decision FKs hold on a fresh store', async () => {
    createFreshStore();
    const result = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(result.data?.contextsEnsured).toBeGreaterThanOrEqual(1);
    expect(result.data?.failed).toBe(0);

    const db = openDb();
    const ctx = db.prepare(`SELECT id FROM contexts WHERE id = 'master_context'`).get() as
      | { id: string }
      | undefined;
    const decisionCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM strategic_decisions`).get() as { c: number }
    ).c;
    db.close();
    expect(ctx?.id).toBe('master_context');
    expect(decisionCount).toBe(1);
  });

  // ─── Idempotent re-clone ───────────────────────────────────────────────────────

  it('is idempotent: re-cloning reports duplicates, never double-inserts', async () => {
    createFreshStore();
    const first = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(first.data?.inserted).toBe(7);
    expect(first.data?.duplicates).toBe(0);

    const second = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(second.data?.inserted).toBe(0);
    expect(second.data?.duplicates).toBe(7);

    const db = openDb();
    const missionCount = (db.prepare(`SELECT COUNT(*) AS c FROM missions`).get() as { c: number })
      .c;
    db.close();
    expect(missionCount).toBe(2);
  });

  // ─── Hand-off to the m02 tail-pull ─────────────────────────────────────────────

  it('hands off to the m02 tail-pull from the seeded cursor (?since=maxCursor)', async () => {
    createFreshStore();
    await syncBootstrap({ projectRoot: tempDir, slug: SLUG });

    // A new genesis event arrives after the snapshot high-water mark (cursor 42).
    eventsPages = [
      {
        events: [
          {
            cursor: 43,
            eventType: 'decision_captured',
            payload: {
              projectId: 'proj-shared',
              projectName: 'Shared Project',
              eventType: 'decision_captured',
              timestamp: '2026-05-31T04:00:00.000Z',
              data: {
                decisionId: 11,
                content: 'A post-snapshot decision',
                stableEventId: '01TAILDECISIONULID00000000',
                occurredAt: 1780250000000,
                originSeq: 900,
                schemaVersion: 1,
              },
            },
            receivedAt: '2026-05-31T04:00:01.000Z',
            processed: true,
            error: null,
          },
        ],
        nextCursor: 43,
        hasMore: false,
      },
    ];

    const pull = await syncPull({ projectRoot: tempDir, slug: SLUG });
    expect(pull.success).toBe(true);
    // The tail-pull must start from the seeded cursor, not 0.
    expect(eventsRequestUrls[0]).toContain('since=42');
    expect(pull.data?.fromCursor).toBe(42);
    expect(pull.data?.inserted).toBe(1);

    const db = openDb();
    const tail = db.prepare(`SELECT decision_text FROM strategic_decisions WHERE id = 11`).get() as
      | { decision_text: string }
      | undefined;
    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM strategic_decisions`).get() as { c: number }
    ).c;
    db.close();
    expect(tail?.decision_text).toBe('A post-snapshot decision');
    expect(total).toBe(2); // snapshot decision + tail decision
  });

  // ─── Error / guard paths ───────────────────────────────────────────────────────

  it('errors with MISSING_PARAMETER when no slug is available', async () => {
    createFreshStore();
    const result = await syncBootstrap({ projectRoot: tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  it('errors when the /state fetch fails', async () => {
    createFreshStore();
    stateStatus = 500;
    const result = await syncBootstrap({ projectRoot: tempDir, slug: SLUG });
    expect(result.success).toBe(false);
  });

  // ─── Formatter ──────────────────────────────────────────────────────────────────

  it('formats a successful clone for the LLM', () => {
    const formatted = formatSyncBootstrapForLLM({
      success: true,
      data: {
        slug: SLUG,
        projectId: 'proj-shared',
        cursorSeeded: 42,
        inserted: 7,
        duplicates: 0,
        failed: 0,
        insertedByType: { sprint_added: 1, mission_added: 2 },
        contextsEnsured: 1,
        message: 'ok',
      },
    });
    expect(formatted).toContain('Clone complete');
    expect(formatted).toContain('Cursor seeded: 42');
    expect(formatted).toContain('mission_added:2');
  });
});
