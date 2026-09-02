/**
 * cmos_db backfill action tests
 *
 * Tests for the historical event backfill handler that replays
 * CMOS state as sync events to the dashboard.
 *
 * @module tests/tools/cmos/cmos-db-backfill
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosDbBackfill,
  formatBackfillForLLM,
  cmosDbReconcile,
  formatReconciliationForLLM,
  cmosDbPurge,
  formatPurgeForLLM,
  type CmosDbBackfillResult,
  type ReconciliationResult,
  type PurgeResult,
} from '../../../src/tools/cmos/cmos-db-backfill';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { DEFAULT_DASHBOARD_URL } from '../../../src/tools/cmos/dashboard-client';
import type { CmosToolResult } from '../../../src/tools/cmos/types';

// ─── Fetch Mock ───────────────────────────────────────────────────────────────

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

function loginResponse() {
  return {
    success: true,
    data: {
      token: 'test-jwt-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: 'user-1', email: 'test@example.com', username: 'tester', projects: [] },
    },
  };
}

function dashboardEnvelope(data: unknown = { received: true }) {
  return { success: true, data };
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
    return new Response(JSON.stringify(dashboardEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ─── Test Setup ───────────────────────────────────────────────────────────────

describe('cmosDbBackfill', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set env vars
    for (const key of ['CMOS_DASHBOARD_URL', 'CMOS_DASHBOARD_USER', 'CMOS_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.CMOS_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.CMOS_DASHBOARD_USER = 'test@example.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'test-password';

    // Create temp dir with CMOS structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-backfill-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    setupFetchMock();
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb(extraSql = '') {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT,
        created_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT NOT NULL DEFAULT 'test',
        summary TEXT,
        status TEXT NOT NULL,
        captures TEXT,
        next_steps TEXT,
        metadata TEXT,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        sprint_id TEXT,
        session_id TEXT,
        mission_id TEXT,
        created_at TEXT NOT NULL,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE mission_dependencies (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id)
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');

      ${extraSql}
    `);
    db.close();
  }

  // ─── Empty DB ───────────────────────────────────────────────────────────────

  it('should handle empty database with zero events', async () => {
    createDb();
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.totalEvents).toBe(0);
    expect(result.data?.pushed).toBe(0);
    expect(result.data?.breakdown).toEqual({
      sprints: 0,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
      nextSteps: 0,
      constraints: 0,
      snapshots: 0,
    });
  });

  // ─── Sprint Events ─────────────────────────────────────────────────────────

  it('should generate sprint_added events for active sprints', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.sprints).toBe(1);
    expect(result.data?.totalEvents).toBe(1);
    expect(result.data?.pushed).toBe(1);

    // Verify push call envelope
    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    expect(pushCalls).toHaveLength(1);
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.eventType).toBe('sprint_added');
    expect(body.projectId).toBe('proj-test');
    expect(body.data.sprintId).toBe('s30');
  });

  it('should generate sprint_added + sprint_completed for completed sprints', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date, end_date, total_missions, completed_missions)
      VALUES ('s29', 'Sprint 29', 'Completed', '2026-02-20T00:00:00Z', '2026-02-28T00:00:00Z', 4, 4);
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.sprints).toBe(2); // added + completed
    expect(result.data?.totalEvents).toBe(2);
  });

  // ─── Mission Events ─────────────────────────────────────────────────────────

  it('should generate mission_started and mission_completed events', async () => {
    createDb(`
      INSERT INTO missions (id, sprint_id, name, status, created_at, started_at, completed_at)
      VALUES ('s30-m01', 's30', 'Context Cleanup', 'Completed',
              '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', '2026-03-01T12:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.missions).toBe(3); // added + started + completed
  });

  it('should generate mission_blocked events for blocked missions', async () => {
    createDb(`
      INSERT INTO missions (id, sprint_id, name, status, notes, created_at)
      VALUES ('s30-m02', 's30', 'Blocked Mission', 'Blocked', 'Waiting on API', '2026-03-02T10:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.missions).toBe(2); // added + blocked

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    // First event is mission_added, second is mission_blocked
    const body = JSON.parse((pushCalls[1][1] as { body: string }).body);
    expect(body.eventType).toBe('mission_blocked');
    expect(body.data.reason).toBe('Waiting on API');
  });

  // ─── Session Events ─────────────────────────────────────────────────────────

  it('should generate session events for completed sessions', async () => {
    createDb(`
      INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, summary, captures, next_steps)
      VALUES ('sess-1', 'build', 'Build Session', 's30',
              '2026-03-01T09:00:00Z', '2026-03-01T17:00:00Z', 'completed',
              'Good progress', '["cap1","cap2"]', '["Deploy","Test"]');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.sessions).toBe(2); // started + completed
  });

  // ─── Decision Events ───────────────────────────────────────────────────────

  it('should generate decision_captured events', async () => {
    createDb(`
      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, session_id, mission_id)
      VALUES ('Use TypeScript for all tools', '2026-03-01T11:00:00Z', 's30', 'sess-1', 's30-m01');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.decisions).toBe(1);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.eventType).toBe('decision_captured');
    expect(body.data.content).toBe('Use TypeScript for all tools');
    expect(body.data.decisionId).toBe(1); // AUTOINCREMENT row ID
  });

  it('should include decisionId as integer row ID for dedup', async () => {
    createDb(`
      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, session_id, mission_id)
      VALUES ('First decision', '2026-03-01T10:00:00Z', 's30', 'sess-1', 's30-m01'),
             ('Second decision', '2026-03-01T11:00:00Z', 's30', 'sess-1', 's30-m01');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.decisions).toBe(2);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const bodies = pushCalls.map((call: unknown[]) =>
      JSON.parse((call[1] as { body: string }).body)
    );
    const decisionBodies = bodies.filter(
      (b: Record<string, unknown>) => b.eventType === 'decision_captured'
    );
    expect(decisionBodies).toHaveLength(2);
    expect(decisionBodies[0].data.decisionId).toBe(1);
    expect(decisionBodies[1].data.decisionId).toBe(2);
  });

  // ─── Dry Run ────────────────────────────────────────────────────────────────

  it('should not push events in dry run mode', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
      INSERT INTO missions (id, sprint_id, name, status, created_at, started_at)
      VALUES ('s30-m01', 's30', 'Mission 1', 'In Progress', '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.totalEvents).toBe(3); // 1 sprint + 1 mission_added + 1 mission_started
    expect(result.data?.pushed).toBe(0);

    // No sync push calls should have been made (login may not happen either)
    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    expect(pushCalls).toHaveLength(0);
  });

  // ─── File-based Sync (registered projects) ─────────────────────────────────

  it('should use file-based sync when dashboard_slug is present', async () => {
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'test-project');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-05T00:00:00Z');
    `);

    const hitUrls: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      hitUrls.push(url);
      if (url.includes('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              token: 'test-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              user: { id: 'u1', email: 'test@example.com', projects: [] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/sync/sqlite-backfill')) {
        return new Response(
          JSON.stringify({
            success: true,
            counts: {
              sprints: 1,
              missions: 0,
              sessions: 0,
              decisions: 0,
              learnings: 0,
              dependencies: 0,
            },
            errors: [],
            durationMs: 42,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Should not hit event-replay endpoint
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.message).toMatch(/File-based sync complete/);
    expect(result.data?.pushed).toBe(1);
    // Must have hit sqlite-backfill, NOT /api/sync/events
    expect(hitUrls.some((u) => u.includes('/api/sync/sqlite-backfill'))).toBe(true);
    expect(hitUrls.some((u) => u.includes('/api/sync/events'))).toBe(false);
  });

  it('should fall back to event-replay when file-based sync fails', async () => {
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'test-project');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-05T00:00:00Z');
    `);

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              token: 'test-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              user: { id: 'u1', email: 'test@example.com', projects: [] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/sync/sqlite-backfill')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      // Event-replay fallback — return success
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    // Fell back to event-replay — totalEvents is the sprint count, not file-based
    expect(result.data?.totalEvents).toBe(1);
    expect(result.data?.message).not.toMatch(/File-based sync/);
    // s81-m01: the fallback is no longer silent — it surfaces a structured warning
    // on the result (not stderr-only) so a degraded sync path is audible to callers.
    expect(result.data?.warnings).toBeDefined();
    expect(result.data?.warnings?.some((w) => /fell back to slower event-replay/i.test(w))).toBe(
      true
    );
  });

  it('s81-m02: a store missing project_id/name but registered (dashboard_slug present) repairs from the incumbent slug — never pushes as Unknown — and file-sync is NOT rejected by expectedSlug', async () => {
    // Renamed-copy shape: no project_id/project_name (would fall to directory basename
    // 'cmos-backfill-test-*', which ≠ the incumbent slug), but dashboard_slug carries the
    // reconciled incumbent. Defect-3: identity repairs from dashboard_slug (not 'Unknown',
    // not the divergent directory basename). Defect-2: expectedSlug=slug, so the file-sync
    // guard does NOT reject with EXPECTED_SLUG_MISMATCH and we stay on the file path.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'incumbent-proj');
    `);
    db.close();

    const backfillBodies: string[] = [];
    const graphIdsObservedAtPublish: Array<string | null> = [];
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              token: 'test-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              user: { id: 'u1', email: 'test@example.com', projects: [] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/sync/sqlite-backfill')) {
        const graph = await ProjectGraphRegistry.create();
        graphIdsObservedAtPublish.push(graph.getByStorePath(tempDir));
        // FormData body — capture the projectSlug field to confirm the incumbent slug.
        const form = init?.body as FormData | undefined;
        backfillBodies.push(String(form?.get?.('projectSlug') ?? ''));
        return new Response(
          JSON.stringify({ success: true, counts: { sprints: 0 }, errors: [], durationMs: 5 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    // Defect-2: stayed on the file path (guard did not reject) — NOT event-replay.
    expect(result.success).toBe(true);
    expect(result.data?.message).toMatch(/File-based sync complete/);
    expect(backfillBodies).toContain('incumbent-proj');
    expect(graphIdsObservedAtPublish).toEqual(['incumbent-proj']);

    // Defect-3: identity was repaired from the incumbent slug, never 'Unknown'.
    const verifyDb = new Database(dbPath);
    const pid = verifyDb.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
      | { value: string }
      | undefined;
    const pname = verifyDb
      .prepare(`SELECT value FROM metadata WHERE key = 'project_name'`)
      .get() as { value: string } | undefined;
    verifyDb.close();
    expect(pid?.value).toBe('incumbent-proj');
    expect(pname?.value).not.toBe('Unknown');
    expect(pname?.value).toBe('Incumbent Proj');
    const graph = await ProjectGraphRegistry.create();
    expect(graph.getByStorePath(tempDir)).toBe(pid?.value);
  });

  // ─── Q3 dashboard-ingest gate (dashboard msg 03064b74; carry-forward #770) ───

  it('emits the full firehose on the event-replay path (no suppression after dashboard migration 029)', async () => {
    // Dashboard migration 029 (msg bbf75ca1) added mirror tables + ingest for
    // next_step_created / constraint_added / snapshot_taken on both sync paths,
    // so DASHBOARD_UNSUPPORTED_EVENT_TYPES is now empty — these 3 flow on the
    // event-replay path instead of being splice-suppressed. No dashboard_slug →
    // straight to event-replay (the path the old Q3 gate filtered).
    createDb(`
      CREATE TABLE next_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, status TEXT, session_id TEXT, sprint_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, status TEXT, session_id TEXT, sprint_id TEXT, created_at TEXT NOT NULL, expires_at TEXT);
      CREATE TABLE context_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT, source TEXT, created_at TEXT NOT NULL);
      INSERT INTO sprints (id, title, status, start_date) VALUES ('s70', 'Sprint 70', 'Active', '2026-05-30T00:00:00Z');
      INSERT INTO next_steps (content, status, created_at) VALUES ('a next step', 'pending', '2026-05-30T01:00:00Z');
      INSERT INTO constraints (content, status, created_at) VALUES ('a constraint', 'active', '2026-05-30T02:00:00Z');
      INSERT INTO context_snapshots (context_id, source, created_at) VALUES ('master_context', 'test', '2026-05-30T03:00:00Z');
    `);

    const result = await cmosDbBackfill({ projectRoot: tempDir, force: true });

    expect(result.success).toBe(true);
    // All 4 events now flow — sprint_added + the 3 formerly-suppressed types.
    expect(result.data?.totalEvents).toBe(4);

    const bodies = fetchMock.mock.calls
      .filter((call: unknown[]) => {
        const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
        return url.includes('/api/sync/events');
      })
      .map((call: unknown[]) => JSON.parse((call[1] as { body: string }).body));
    const pushedTypes = bodies.map((b: Record<string, unknown>) => b.eventType);

    expect(pushedTypes).toContain('sprint_added');
    expect(pushedTypes).toContain('next_step_created');
    expect(pushedTypes).toContain('constraint_added');
    expect(pushedTypes).toContain('snapshot_taken');
    // No suppression warning — the gate is empty.
    expect(
      result.data?.warnings?.some((w) => /not yet in the dashboard ingest allowlist/.test(w))
    ).toBeFalsy();

    // Payloads match the shapes the dashboard confirmed it ingests (msg bbf75ca1).
    const byType = (t: string) =>
      bodies.find((b: Record<string, unknown>) => b.eventType === t)?.data as Record<
        string,
        unknown
      >;
    expect(byType('next_step_created')).toMatchObject({
      content: 'a next step',
      status: 'pending',
    });
    expect(byType('next_step_created')).toHaveProperty('nextStepId');
    expect(byType('constraint_added')).toMatchObject({ content: 'a constraint', status: 'active' });
    expect(byType('constraint_added')).toHaveProperty('constraintId');
    expect(byType('snapshot_taken')).toMatchObject({ contextId: 'master_context', source: 'test' });
    expect(byType('snapshot_taken')).toHaveProperty('snapshotId');
  });

  // ─── Cursor Idempotency ─────────────────────────────────────────────────────

  it('should respect backfill cursor and skip older events', async () => {
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('backfill_cursor', '2026-03-01T12:00:00Z');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s29', 'Sprint 29', 'Active', '2026-02-01T00:00:00Z');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-05T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    // Only s30 should be pushed (s29 start_date <= cursor)
    expect(result.data?.totalEvents).toBe(1);
    expect(result.data?.previousCursor).toBe('2026-03-01T12:00:00Z');
  });

  it('should respect cursor when force=true (only bypasses large-delta guard)', async () => {
    // force=true no longer ignores the cursor — it only bypasses the large-delta guard.
    // Starting from scratch on every force run caused cursor regression when timeouts hit
    // early events, making backfill unable to make forward progress.
    // To replay from scratch: clear the backfill_cursor first, then run backfill.
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('backfill_cursor', '2026-03-01T12:00:00Z');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s29', 'Sprint 29', 'Active', '2026-02-01T00:00:00Z');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-05T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir, force: true });

    expect(result.success).toBe(true);
    // Only s30 should be pushed (s29 start_date <= cursor, even with force=true)
    expect(result.data?.totalEvents).toBe(1);
  });

  it('should never regress cursor even if timeout fires at early events', async () => {
    // Simulates the stuck-cursor bug: a force=true run times out at events with timestamps
    // earlier than the previous cursor, which would have overwritten the cursor with a
    // regressed value. Cursor must only ever advance.
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('backfill_cursor', '2026-03-05T00:00:00Z');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s29', 'Sprint 29', 'Active', '2026-02-01T00:00:00Z');
    `);
    // Inject a getNow that immediately trips the overall timeout so 0 events are pushed.
    // latestTimestamp stays null — cursor must not be updated (not regressed).
    const wallClockStart = Date.now();
    const result = await cmosDbBackfill({
      projectRoot: tempDir,
      _getNow: () => wallClockStart + 999_999,
    });

    expect(result.success).toBe(true);
    // No events pushed (timeout fired before first push)
    expect(result.data?.pushed).toBe(0);

    // Cursor must remain at previous value — not erased, not regressed
    const db = new Database(dbPath);
    const row = db.prepare(`SELECT value FROM metadata WHERE key = 'backfill_cursor'`).get() as
      | { value: string }
      | undefined;
    db.close();
    expect(row?.value).toBe('2026-03-05T00:00:00Z');
  });

  it('should update cursor after successful push', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-05T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.cursor).toBe('2026-03-05T00:00:00Z');

    // Verify cursor was persisted in DB
    const db = new Database(dbPath);
    const row = db.prepare(`SELECT value FROM metadata WHERE key = 'backfill_cursor'`).get() as
      | {
          value: string;
        }
      | undefined;
    db.close();
    expect(row?.value).toBe('2026-03-05T00:00:00Z');
  });

  // ─── Chronological Ordering ─────────────────────────────────────────────────

  it('should sort events chronologically before pushing', async () => {
    createDb(`
      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id)
      VALUES ('Decision A', '2026-03-03T00:00:00Z', 's30');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
      INSERT INTO sessions (id, type, title, started_at, status)
      VALUES ('sess-1', 'build', 'Build', '2026-03-02T00:00:00Z', 'active');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.totalEvents).toBe(3);

    // Verify chronological order: sprint (03-01), session (03-02), decision (03-03)
    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const types = pushCalls.map((call: unknown[]) => {
      const body = JSON.parse((call[1] as { body: string }).body);
      return body.eventType;
    });
    expect(types).toEqual(['sprint_added', 'session_started', 'decision_captured']);
  });

  // ─── Full Lifecycle ─────────────────────────────────────────────────────────

  it('should handle full project lifecycle with all entity types', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date, end_date, total_missions, completed_missions)
      VALUES ('s29', 'Sprint 29', 'Completed', '2026-02-20T00:00:00Z', '2026-02-28T00:00:00Z', 4, 4),
             ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z', NULL, NULL, NULL);

      INSERT INTO missions (id, sprint_id, name, status, created_at, started_at, completed_at, notes)
      VALUES ('s29-m01', 's29', 'M1', 'Completed', '2026-02-20T10:00:00Z', '2026-02-20T10:00:00Z', '2026-02-21T15:00:00Z', 'Done'),
             ('s30-m01', 's30', 'M2', 'In Progress', '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', NULL, NULL);

      INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, summary, captures)
      VALUES ('sess-1', 'build', 'Build S29', 's29', '2026-02-20T09:00:00Z', '2026-02-20T17:00:00Z', 'completed', 'Great', '["c1"]'),
             ('sess-2', 'build', 'Build S30', 's30', '2026-03-01T09:00:00Z', NULL, 'active', NULL, NULL);

      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, session_id, mission_id)
      VALUES ('Use Zod', '2026-02-20T12:00:00Z', 's29', 'sess-1', 's29-m01'),
             ('Use Vitest', '2026-03-01T11:00:00Z', 's30', 'sess-2', 's30-m01');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    const d = result.data!;
    expect(d.breakdown.sprints).toBe(3); // s29 added + completed, s30 added
    expect(d.breakdown.missions).toBe(5); // 2 mission_added + s29-m01 started + completed, s30-m01 started
    expect(d.breakdown.sessions).toBe(3); // sess-1 started + completed, sess-2 started
    expect(d.breakdown.decisions).toBe(2);
    expect(d.totalEvents).toBe(13);
    expect(d.pushed).toBe(13);
    expect(d.failed).toBe(0);
  });

  // ─── Push Failure Handling ──────────────────────────────────────────────────

  it('should count failed pushes without crashing', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s31', 'Sprint 31', 'Active', '2026-03-10T00:00:00Z');
    `);

    let pushCount = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      pushCount++;
      if (pushCount === 1) {
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(dashboardEnvelope()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.totalEvents).toBe(2);
    expect(result.data?.pushed).toBe(1);
    expect(result.data?.failed).toBe(1);
  });

  // ─── Dashboard Not Configured ───────────────────────────────────────────────

  it('should return error when dashboard is not configured', async () => {
    delete process.env.CMOS_DASHBOARD_URL;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;

    createDb();
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  // ─── Project Identity ───────────────────────────────────────────────────────

  it('should use project identity from metadata table', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.projectId).toBe('proj-test');
    expect(body.projectName).toBe('Test Project');
  });

  // ─── Project Identity Repair ──────────────────────────────────────────────

  it('should repair empty metadata from directory name', async () => {
    // Create DB without project_id/project_name metadata
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO sprints (id, title, status, start_date) VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
    `);
    db.close();

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.warnings).toBeDefined();
    expect(result.data?.warnings?.some((w) => w.includes('repaired from directory'))).toBe(true);

    // Verify the repaired identity was used in the envelope
    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const pushBody = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(pushBody.projectId).not.toBe('unknown');
    expect(pushBody.projectName).not.toBe('Unknown');

    // Verify metadata was persisted in DB
    const verifyDb = new Database(dbPath);
    const pid = verifyDb.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
      | { value: string }
      | undefined;
    const pname = verifyDb
      .prepare(`SELECT value FROM metadata WHERE key = 'project_name'`)
      .get() as { value: string } | undefined;
    verifyDb.close();
    expect(pid?.value).toBeDefined();
    expect(pid?.value).not.toBe('');
    expect(pname?.value).toBeDefined();
    expect(pname?.value).not.toBe('');
  });

  it('should repair from master_context when directory name unavailable', async () => {
    // Create DB with empty metadata but a master_context that has project identity
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'master', '${JSON.stringify({ project_identity: { name: 'My Test Project' } }).replace(/'/g, "''")}');
      INSERT INTO sprints (id, title, status, start_date) VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
    `);
    db.close();

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    // Directory repair fires first (since the temp dir has a name),
    // so we just verify repair happened and identity is non-unknown
    expect(result.data?.warnings).toBeDefined();
    expect(result.data?.warnings?.some((w) => w.includes('repaired'))).toBe(true);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const pushBody = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(pushBody.projectId).not.toBe('unknown');
  });

  it('should not emit warnings when metadata is already populated', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.warnings).toBeUndefined();
  });

  // ─── Learning Events ────────────────────────────────────────────────────────

  it('should generate learning_captured events', async () => {
    createDb(`
      INSERT INTO learnings (content, category, status, sprint_id, session_id, mission_id, created_at)
      VALUES ('TypeScript reduces runtime bugs', 'technical', 'active', 's30', 'sess-1', 's30-m01', '2026-03-01T11:30:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.learnings).toBe(1);
    expect(result.data?.totalEvents).toBe(1);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.eventType).toBe('learning_captured');
    expect(body.data.content).toBe('TypeScript reduces runtime bugs');
    expect(body.data.learningId).toBe(1); // AUTOINCREMENT row ID
    expect(body.data.sessionId).toBe('sess-1');
    expect(body.data.sprintId).toBe('s30');
    expect(body.data.missionId).toBe('s30-m01');
  });

  it('should include learningId as integer row ID for dedup', async () => {
    createDb(`
      INSERT INTO learnings (content, category, status, sprint_id, session_id, created_at)
      VALUES ('First learning', 'technical', 'active', 's30', 'sess-1', '2026-03-01T10:00:00Z'),
             ('Second learning', 'process', 'active', 's30', 'sess-1', '2026-03-01T11:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.learnings).toBe(2);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const bodies = pushCalls.map((call: unknown[]) =>
      JSON.parse((call[1] as { body: string }).body)
    );
    const learningBodies = bodies.filter(
      (b: Record<string, unknown>) => b.eventType === 'learning_captured'
    );
    expect(learningBodies).toHaveLength(2);
    expect(learningBodies[0].data.learningId).toBe(1);
    expect(learningBodies[1].data.learningId).toBe(2);
  });

  it('should handle learnings with null optional fields', async () => {
    createDb(`
      INSERT INTO learnings (content, status, created_at)
      VALUES ('Standalone learning', 'active', '2026-03-01T12:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.learnings).toBe(1);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.data.sessionId).toBe('');
    expect(body.data.sprintId).toBeNull();
    expect(body.data.missionId).toBeNull();
  });

  it('should respect cursor for learnings', async () => {
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('backfill_cursor', '2026-03-01T12:00:00Z');
      INSERT INTO learnings (content, status, created_at)
      VALUES ('Old learning', 'active', '2026-03-01T10:00:00Z');
      INSERT INTO learnings (content, status, created_at)
      VALUES ('New learning', 'active', '2026-03-05T10:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.learnings).toBe(1); // Only new learning
  });

  // ─── Dependency Events ─────────────────────────────────────────────────────

  it('should generate dependency_added events', async () => {
    createDb(`
      INSERT INTO missions (id, sprint_id, name, status, created_at)
      VALUES ('s30-m01', 's30', 'Mission 1', 'Queued', '2026-03-01T10:00:00Z'),
             ('s30-m02', 's30', 'Mission 2', 'Queued', '2026-03-01T10:05:00Z');
      INSERT INTO mission_dependencies (from_id, to_id, type)
      VALUES ('s30-m01', 's30-m02', 'Blocks');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.breakdown.dependencies).toBe(1);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    // Find the dependency event among all push calls
    const depBody = pushCalls
      .map((call: unknown[]) => JSON.parse((call[1] as { body: string }).body))
      .find((b: Record<string, unknown>) => b.eventType === 'dependency_added');
    expect(depBody).toBeDefined();
    expect(depBody.data.fromId).toBe('s30-m01');
    expect(depBody.data.toId).toBe('s30-m02');
    expect(depBody.data.type).toBe('Blocks');
  });

  it('should respect cursor for dependencies', async () => {
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('backfill_cursor', '2026-03-02T00:00:00Z');
      INSERT INTO missions (id, sprint_id, name, status, created_at)
      VALUES ('s29-m01', 's29', 'Old Mission', 'Completed', '2026-02-20T10:00:00Z'),
             ('s30-m01', 's30', 'New Mission', 'Queued', '2026-03-05T10:00:00Z'),
             ('s30-m02', 's30', 'New Mission 2', 'Queued', '2026-03-05T10:05:00Z');
      INSERT INTO mission_dependencies (from_id, to_id, type)
      VALUES ('s29-m01', 's30-m01', 'Enables'),
             ('s30-m01', 's30-m02', 'Blocks');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    // s29-m01 created_at is before cursor, so that dependency is skipped
    // s30-m01 dependency should be included
    expect(result.data?.breakdown.dependencies).toBe(1);
  });

  it('should include learnings and dependencies in dry run counts', async () => {
    createDb(`
      INSERT INTO missions (id, sprint_id, name, status, created_at)
      VALUES ('s30-m01', 's30', 'M1', 'Queued', '2026-03-01T10:00:00Z'),
             ('s30-m02', 's30', 'M2', 'Queued', '2026-03-01T10:05:00Z');
      INSERT INTO learnings (content, status, created_at)
      VALUES ('Learning 1', 'active', '2026-03-01T12:00:00Z');
      INSERT INTO mission_dependencies (from_id, to_id, type)
      VALUES ('s30-m01', 's30-m02', 'Requires');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.breakdown.learnings).toBe(1);
    expect(result.data?.breakdown.dependencies).toBe(1);
    expect(result.data?.totalEvents).toBe(4); // 2 mission_added + 1 learning + 1 dependency
    expect(result.data?.pushed).toBe(0);
    expect(result.data?.message).toContain('learning');
    expect(result.data?.message).toContain('dependency');
  });

  it('should maintain chronological order with learnings and dependencies mixed in', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-01T00:00:00Z');
      INSERT INTO missions (id, sprint_id, name, status, created_at)
      VALUES ('s30-m01', 's30', 'M1', 'Queued', '2026-03-02T00:00:00Z'),
             ('s30-m02', 's30', 'M2', 'Queued', '2026-03-02T00:00:00Z');
      INSERT INTO learnings (content, status, sprint_id, created_at)
      VALUES ('Early learning', 'active', 's30', '2026-03-03T00:00:00Z');
      INSERT INTO mission_dependencies (from_id, to_id, type)
      VALUES ('s30-m01', 's30-m02', 'Blocks');
      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id)
      VALUES ('Late decision', '2026-03-04T00:00:00Z', 's30');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const types = pushCalls.map((call: unknown[]) => {
      const body = JSON.parse((call[1] as { body: string }).body);
      return body.eventType;
    });
    // sprint (03-01), mission_added x2 + dependency (03-02), learning (03-03), decision (03-04)
    expect(types).toEqual([
      'sprint_added',
      'mission_added',
      'mission_added',
      'dependency_added',
      'learning_captured',
      'decision_captured',
    ]);
  });

  // ─── Provenance fields on the wire (s71-m01, decision #777) ─────────────────
  // The 3 genesis columns (stable_event_id, occurred_at, origin_seq) are stamped
  // on every firehose row locally by genesisColumns but must also ride in the
  // outbound event `data` so the dashboard's migration-024 mirror can populate
  // them and order LWW-by-(occurred_at, origin_seq) on the shared mutable surface
  // instead of falling back to synced_at. occurred_at (ms-epoch) goes in `data`,
  // NEVER the envelope `timestamp` (which must stay ISO 8601 — dashboard msg
  // 03064b74 Q1). author_user_id stays dashboard-authoritative — never sent.

  it('s71-m01: emits stable_event_id/occurred_at/origin_seq in decision data; envelope timestamp stays ISO', async () => {
    createDb(`
      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, session_id, mission_id, stable_event_id, occurred_at, origin_seq)
      VALUES ('Provenance decision', '2026-05-31T11:00:00Z', 's71', 'sess-1', 's71-m01', '01KSZE7E33NT696EW6HK8XJTPH', 1780245313635, 777);
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.eventType).toBe('decision_captured');
    // Provenance rides in `data` (camelCase; dashboard accepts camel OR snake).
    expect(body.data.stableEventId).toBe('01KSZE7E33NT696EW6HK8XJTPH');
    expect(body.data.occurredAt).toBe(1780245313635);
    expect(body.data.originSeq).toBe(777);
    // occurred_at (ms-epoch) must NOT leak into the envelope timestamp — it stays
    // the row's ISO 8601 created_at, or the dashboard rejects the event.
    expect(body.timestamp).toBe('2026-05-31T11:00:00Z');
  });

  it('s71-m01/m02: every firehose event type carries genesis provenance incl. schemaVersion (shared per-row)', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date, end_date, total_missions, completed_missions, stable_event_id, occurred_at, origin_seq, schema_version)
      VALUES ('s71', 'Sprint 71', 'Completed', '2026-05-31T00:00:00Z', '2026-05-31T20:00:00Z', 1, 1, 'SPRINTULID0000000000000000', 1780240000000, 10, 1);
      INSERT INTO missions (id, sprint_id, name, status, created_at, started_at, completed_at, stable_event_id, occurred_at, origin_seq, schema_version)
      VALUES ('s71-m01', 's71', 'M1', 'Completed', '2026-05-31T01:00:00Z', '2026-05-31T02:00:00Z', '2026-05-31T03:00:00Z', 'MISSIONULID000000000000000', 1780241000000, 11, 1);
      INSERT INTO missions (id, sprint_id, name, status, notes, created_at, stable_event_id, occurred_at, origin_seq, schema_version)
      VALUES ('s71-m02', 's71', 'M2', 'Blocked', 'blocked reason', '2026-05-31T08:00:00Z', 'MISSION2ULID00000000000000', 1780245000000, 15, 1);
      INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, summary, captures, stable_event_id, occurred_at, origin_seq, schema_version)
      VALUES ('sess-1', 'build', 'Build', 's71', '2026-05-31T04:00:00Z', '2026-05-31T05:00:00Z', 'completed', 'ok', '["c1"]', 'SESSIONULID000000000000000', 1780242000000, 12, 1);
      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, stable_event_id, occurred_at, origin_seq, schema_version)
      VALUES ('A decision', '2026-05-31T06:00:00Z', 's71', 'DECISIONULID00000000000000', 1780243000000, 13, 2);
      INSERT INTO learnings (content, status, sprint_id, created_at, stable_event_id, occurred_at, origin_seq, schema_version)
      VALUES ('A learning', 'active', 's71', '2026-05-31T07:00:00Z', 'LEARNINGULID00000000000000', 1780244000000, 14, 1);
      INSERT INTO mission_dependencies (from_id, to_id, type)
      VALUES ('s71-m01', 's71-m02', 'Blocks');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir, force: true });

    expect(result.success).toBe(true);

    const bodies = fetchMock.mock.calls
      .filter((call: unknown[]) => {
        const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
        return url.includes('/api/sync/events');
      })
      .map((call: unknown[]) => JSON.parse((call[1] as { body: string }).body));

    const firehoseTypes = new Set([
      'sprint_added',
      'sprint_completed',
      'mission_added',
      'mission_started',
      'mission_completed',
      'mission_blocked',
      'session_started',
      'session_completed',
      'decision_captured',
      'learning_captured',
    ]);
    const firehoseBodies = bodies.filter((b: Record<string, unknown>) =>
      firehoseTypes.has(b.eventType as string)
    );
    // All 10 firehose event types are present in this fixture.
    expect(new Set(firehoseBodies.map((b: Record<string, unknown>) => b.eventType)).size).toBe(10);
    for (const b of firehoseBodies) {
      const data = b.data as Record<string, unknown>;
      expect(typeof data.stableEventId).toBe('string');
      expect(typeof data.occurredAt).toBe('number');
      expect(typeof data.originSeq).toBe('number');
      expect(typeof data.schemaVersion).toBe('number');
    }

    // schema_version is preserved verbatim, not hardcoded to 1 — the decision row
    // carries 2, so the wire must too (this is what lets the PULL consumer round-trip it).
    const decisionData = bodies.find(
      (b: Record<string, unknown>) => b.eventType === 'decision_captured'
    )?.data as Record<string, unknown>;
    expect(decisionData.schemaVersion).toBe(2);

    // dependency_added is NOT a firehose table — it must carry NO genesis provenance.
    // Asserting on a REAL dependency event (not its absence) guards against a future
    // mistake that wires provenanceData() into the dependency builder.
    const depBody = bodies.find((b: Record<string, unknown>) => b.eventType === 'dependency_added');
    expect(depBody).toBeDefined();
    const depData = depBody!.data as Record<string, unknown>;
    expect(depData).not.toHaveProperty('stableEventId');
    expect(depData).not.toHaveProperty('occurredAt');
    expect(depData).not.toHaveProperty('originSeq');

    // Multiple events derived from one row share that row's genesis provenance.
    const fromMission = (type: string) =>
      bodies.find((b: Record<string, unknown>) => b.eventType === type)?.data as Record<
        string,
        unknown
      >;
    expect(fromMission('mission_added').stableEventId).toBe('MISSIONULID000000000000000');
    expect(fromMission('mission_started').stableEventId).toBe('MISSIONULID000000000000000');
    expect(fromMission('mission_completed').stableEventId).toBe('MISSIONULID000000000000000');
  });

  it('s71-m01: provenance fields are null when unset; author_user_id is never client-supplied', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s71', 'Sprint 71', 'Active', '2026-05-31T00:00:00Z');
    `);
    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);

    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    const body = JSON.parse((pushCalls[0][1] as { body: string }).body);
    expect(body.data.stableEventId).toBeNull();
    expect(body.data.occurredAt).toBeNull();
    expect(body.data.originSeq).toBeNull();
    expect(body.data.schemaVersion).toBeNull();
    // author_user_id stays dashboard-authoritative — must never be client-supplied.
    expect(body.data.authorUserId).toBeUndefined();
    expect(body.data.author_user_id).toBeUndefined();
  });

  // ─── Reliability Guards ─────────────────────────────────────────────────────

  it('should skip push and warn when any table delta exceeds threshold (51 decisions)', async () => {
    // 51 decisions exceeds LARGE_DELTA_THRESHOLD of 50
    const rows = Array.from({ length: 51 }, (_, i) => {
      const day = Math.floor(i / 24) + 1;
      const hour = i % 24;
      return `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decision ${i}', '2026-03-0${day}T${String(hour).padStart(2, '0')}:00:00Z')`;
    }).join(';\n');
    createDb(rows);

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.pushed).toBe(0);
    expect(result.data?.skipped).toBe(result.data?.totalEvents); // all skipped
    expect(result.data?.warnings).toBeDefined();
    expect(result.data?.warnings?.[0]).toContain('Delta too large');
    expect(result.data?.message).toContain('Re-upload');
    expect(result.data?.message).toContain(
      'https://test-dashboard.example.com/projects/your-project'
    );

    // No sync events should have been pushed
    const pushCalls = fetchMock.mock.calls.filter((call: unknown[]) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL | Request).toString();
      return url.includes('/api/sync/events');
    });
    expect(pushCalls).toHaveLength(0);
  });

  it('uses the baked dashboard URL in the large-delta remedy when the env URL is absent', async () => {
    delete process.env.CMOS_DASHBOARD_URL;
    const rows = Array.from({ length: 51 }, (_, i) => {
      const day = Math.floor(i / 24) + 1;
      const hour = i % 24;
      return `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decision ${i}', '2026-03-0${day}T${String(hour).padStart(2, '0')}:00:00Z')`;
    }).join(';\n');
    createDb(rows);

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.pushed).toBe(0);
    expect(result.data?.message).toContain(`${DEFAULT_DASHBOARD_URL}/projects/your-project`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should bypass large-delta guard when force=true (51 decisions)', async () => {
    // 51 decisions would normally trigger the guard — force=true must bypass it
    const rows = Array.from({ length: 51 }, (_, i) => {
      const day = Math.floor(i / 24) + 1;
      const hour = i % 24;
      return `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decision ${i}', '2026-03-0${day}T${String(hour).padStart(2, '0')}:00:00Z')`;
    }).join(';\n');
    createDb(rows);

    const result = await cmosDbBackfill({ projectRoot: tempDir, force: true });

    expect(result.success).toBe(true);
    expect(result.data?.pushed).toBe(51);
    expect(result.data?.skipped).toBe(0);
    // No large-delta warning
    expect(result.data?.warnings?.some((w) => w.includes('Delta too large'))).toBeFalsy();
  });

  it('should push normally when delta is exactly at threshold (50 decisions)', async () => {
    // 50 decisions = exactly at threshold — should NOT trigger guard
    const rows = Array.from({ length: 50 }, (_, i) => {
      const day = Math.floor(i / 24) + 1;
      const hour = i % 24;
      return `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decision ${i}', '2026-03-0${day}T${String(hour).padStart(2, '0')}:00:00Z')`;
    }).join(';\n');
    createDb(rows);

    const result = await cmosDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.pushed).toBe(50);
    expect(result.data?.failed).toBe(0);
    // No large-delta warning
    expect(result.data?.warnings?.some((w) => w.includes('Delta too large'))).toBeFalsy();
  });

  it('should handle per-request timeout gracefully — timeout counts as failure, not crash', async () => {
    createDb(`
      INSERT INTO strategic_decisions (decision_text, created_at)
      VALUES ('Decision 1', '2026-03-01T00:00:00Z');
    `);

    // Slow fetch that honours AbortSignal
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            new Response(JSON.stringify(dashboardEnvelope()), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }, 500); // 500ms — much longer than perRequestTimeoutMs: 10
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const result = await cmosDbBackfill({
      projectRoot: tempDir,
      perRequestTimeoutMs: 10, // 10ms — triggers abort before 500ms mock completes
    });

    expect(result.success).toBe(true);
    expect(result.data?.failed).toBe(1); // timeout → failure, not unhandled crash
    expect(result.data?.pushed).toBe(0);
  });

  it('should abort with partial progress when overall timeout is exceeded', async () => {
    // 5 decisions
    const rows = Array.from({ length: 5 }, (_, i) => {
      return `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decision ${i}', '2026-03-01T0${i}:00:00Z')`;
    }).join(';\n');
    createDb(rows);

    // Injected now() advances 60ms per call — deterministic, not time-sensitive
    let tick = 0;
    const mockNow = () => tick++ * 60; // 0, 60, 120, 180, 240...

    const result = await cmosDbBackfill({
      projectRoot: tempDir,
      overallTimeoutMs: 150,
      _getNow: mockNow,
    });

    // wallClockStart = 0 (tick=0)
    // iter 1: 60-0=60 ≤ 150 → push event 1 (tick=1)
    // iter 2: 120-0=120 ≤ 150 → push event 2 (tick=2)
    // iter 3: 180-0=180 > 150 → timeout
    expect(result.success).toBe(true);
    expect(result.data?.pushed).toBeGreaterThanOrEqual(1); // at least some pushed
    expect(result.data?.pushed).toBeLessThan(5); // not all 5
    expect(result.data?.warnings).toBeDefined();
    expect(result.data?.warnings?.some((w) => w.toLowerCase().includes('timed out'))).toBe(true);
  });

  it('should log progress to stderr during backfill', async () => {
    // 11 decisions — enough to trigger progress log at interval=10
    const rows = Array.from({ length: 11 }, (_, i) => {
      return `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decision ${i}', '2026-03-01T${String(i).padStart(2, '0')}:00:00Z')`;
    }).join(';\n');
    createDb(rows);

    // s86-m01: this it() has always been titled "to stderr" while asserting on
    // console.error — an instance of the sprint's own class inside its own suite.
    // cmos-db-backfill now writes via process.stderr.write (it is reachable from
    // the fire-and-forget checkpoint IIFE, where a late console call throws
    // "Cannot log after tests are done" and reds an otherwise-green run), so the
    // capture matches the title. House pattern: tests/auth/legacy-auth-warn.test.ts.
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      writes.push(
        typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array)
      );
      return true;
    };

    try {
      await cmosDbBackfill({ projectRoot: tempDir });
    } finally {
      process.stderr.write = originalWrite;
    }

    // Should have logged at least one progress line with pushed/failed/remaining.
    // Both substring checks are deliberately kept: '[backfill]' proves the prefix
    // survived the conversion and 'pushed' proves it is a progress/summary line
    // rather than any other stderr traffic the run happens to emit.
    const progressLines = writes.filter(
      (line) => line.includes('[backfill]') && line.includes('pushed')
    );
    expect(progressLines.length).toBeGreaterThan(0);
  });

  // ─── LLM Formatter ─────────────────────────────────────────────────────────

  describe('formatBackfillForLLM', () => {
    it('should format successful backfill result', () => {
      const result: CmosToolResult<CmosDbBackfillResult> = {
        success: true,
        data: {
          mode: 'backfill',
          dryRun: false,
          totalEvents: 10,
          pushed: 10,
          failed: 0,
          skipped: 0,
          deduped: 0,
          breakdown: {
            sprints: 2,
            missions: 3,
            sessions: 3,
            decisions: 2,
            learnings: 0,
            dependencies: 0,
          },
          cursor: '2026-03-05T00:00:00Z',
          previousCursor: null,
          message: 'Backfill complete: 10/10 events pushed.',
        },
      };

      const output = formatBackfillForLLM(result);
      expect(output).toContain('Backfill Complete');
      expect(output).toContain('10 pushed');
      expect(output).toContain('2 sprint');
      expect(output).toContain('Current cursor:');
    });

    it('should format dry run result', () => {
      const result: CmosToolResult<CmosDbBackfillResult> = {
        success: true,
        data: {
          mode: 'backfill',
          dryRun: true,
          totalEvents: 5,
          pushed: 0,
          failed: 0,
          skipped: 0,
          deduped: 0,
          breakdown: {
            sprints: 1,
            missions: 2,
            sessions: 1,
            decisions: 1,
            learnings: 0,
            dependencies: 0,
          },
          cursor: null,
          previousCursor: null,
          message: 'Dry run: 5 events would be pushed.',
        },
      };

      const output = formatBackfillForLLM(result);
      expect(output).toContain('Backfill Dry Run');
      expect(output).toContain('0 pushed');
    });

    it('should format error result', () => {
      const result: CmosToolResult<CmosDbBackfillResult> = {
        success: false,
        error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Dashboard not configured' },
      };

      const output = formatBackfillForLLM(result);
      expect(output).toContain('Backfill failed');
      expect(output).toContain('Dashboard not configured');
    });
  });
});

// ─── Reconciliation Tests ───────────────────────────────────────────────────

describe('cmosDbReconcile', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  function syncStatusResponse(tableCounts: Record<string, number>) {
    const tables = Object.entries(tableCounts).map(([table, count]) => ({ table, count }));
    return {
      success: true,
      data: {
        tables,
        totalMirrorRows: tables.reduce((sum, t) => sum + t.count, 0),
        totalSyncLogEntries: 100,
        unprocessedSyncLogEntries: 0,
        failedSyncLogEntries: 0,
        lastSyncAt: '2026-03-10T05:00:00Z',
        oldestUnprocessedAt: null,
        projectCount: 1,
      },
    };
  }

  /** Build project-scoped state response with entity arrays of the right length */
  function projectStateResponse(counts: {
    sprints?: number;
    missions?: number;
    sessions?: number;
    decisions?: number;
    learnings?: number;
    dependencies?: number;
  }) {
    return {
      success: true,
      data: {
        project: {
          id: 'proj-test',
          slug: 'test-project',
          name: 'Test Project',
          schemaVersion: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-03-10T05:00:00Z',
        },
        sprints: Array.from({ length: counts.sprints ?? 0 }, (_, i) => ({ id: `s${i}` })),
        missions: Array.from({ length: counts.missions ?? 0 }, (_, i) => ({ id: `m${i}` })),
        sessions: Array.from({ length: counts.sessions ?? 0 }, (_, i) => ({ id: `ps${i}` })),
        decisions: Array.from({ length: counts.decisions ?? 0 }, (_, i) => ({ id: i })),
        learnings: Array.from({ length: counts.learnings ?? 0 }, (_, i) => ({ id: i })),
        dependencies: Array.from({ length: counts.dependencies ?? 0 }, (_, i) => ({
          fromId: `m${i}`,
          toId: `m${i + 1}`,
        })),
      },
    };
  }

  beforeEach(() => {
    for (const key of ['CMOS_DASHBOARD_URL', 'CMOS_DASHBOARD_USER', 'CMOS_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.CMOS_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.CMOS_DASHBOARD_USER = 'test@example.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'test-password';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-reconcile-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb(extraSql = '') {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      ${extraSql}
    `);
    db.close();
  }

  /** Setup fetch mock for project-scoped reconciliation (default path) */
  function setupFetchForProjectScopedReconcile(counts: {
    sprints?: number;
    missions?: number;
    sessions?: number;
    decisions?: number;
    learnings?: number;
    dependencies?: number;
  }) {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Project-scoped status endpoint: /api/sync/status?projectSlug=...
      if (url.includes('/api/sync/status') && url.includes('projectSlug=')) {
        return new Response(
          JSON.stringify(
            syncStatusResponse({
              cmos_sprints: counts.sprints ?? 0,
              cmos_missions: counts.missions ?? 0,
              cmos_sessions: counts.sessions ?? 0,
              cmos_decisions: counts.decisions ?? 0,
              cmos_learnings: counts.learnings ?? 0,
              cmos_mission_dependencies: counts.dependencies ?? 0,
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Global status endpoint (no projectSlug query param)
      if (url.includes('/api/sync/status')) {
        return new Response(
          JSON.stringify(
            syncStatusResponse({
              cmos_sprints: 0,
              cmos_missions: 0,
              cmos_sessions: 0,
              cmos_decisions: 0,
              cmos_learnings: 0,
              cmos_mission_dependencies: 0,
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  /** Setup fetch mock for global fallback reconciliation */
  function setupFetchForGlobalReconcile(tableCounts: Record<string, number>) {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Project-scoped status endpoint returns 404 → triggers global fallback
      if (url.includes('/api/sync/status') && url.includes('projectSlug=')) {
        return new Response(JSON.stringify({ error: 'Project not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Global status endpoint (no projectSlug) returns actual counts
      if (url.includes('/api/sync/status')) {
        return new Response(JSON.stringify(syncStatusResponse(tableCounts)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('should report all tables matching when counts are equal (project-scoped)', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active'), ('s2', 'Sprint 2', 'Active');
      INSERT INTO missions (id, name, status) VALUES ('m1', 'M1', 'Queued');
      INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('D1', '2026-01-01T00:00:00Z');
    `);
    setupFetchForProjectScopedReconcile({
      sprints: 2,
      missions: 1,
      sessions: 0,
      decisions: 1,
      learnings: 0,
      dependencies: 0,
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.allMatch).toBe(true);
    expect(result.data?.projectScoped).toBe(true);
    expect(result.data?.projectSlug).toBe('test-project');
    expect(result.data?.tables).toHaveLength(6);
    for (const t of result.data!.tables) {
      expect(t.match).toBe(true);
      expect(t.delta).toBe(0);
    }
  });

  it('should detect mismatches with positive delta (SQLite > PG)', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active'), ('s2', 'Sprint 2', 'Active'), ('s3', 'Sprint 3', 'Active');
    `);
    setupFetchForProjectScopedReconcile({
      sprints: 1,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.allMatch).toBe(false);
    expect(result.data?.projectScoped).toBe(true);

    const sprintTable = result.data!.tables.find((t) => t.table === 'sprints');
    expect(sprintTable?.sqliteCount).toBe(3);
    expect(sprintTable?.pgCount).toBe(1);
    expect(sprintTable?.delta).toBe(2);
    expect(sprintTable?.match).toBe(false);
  });

  it('should detect mismatches with negative delta (PG > SQLite)', async () => {
    createDb(`
      INSERT INTO missions (id, name, status) VALUES ('m1', 'M1', 'Queued');
    `);
    setupFetchForProjectScopedReconcile({
      sprints: 0,
      missions: 3,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.allMatch).toBe(false);

    const missionTable = result.data!.tables.find((t) => t.table === 'missions');
    expect(missionTable?.sqliteCount).toBe(1);
    expect(missionTable?.pgCount).toBe(3);
    expect(missionTable?.delta).toBe(-2);
  });

  it('should include sync log stats from global endpoint', async () => {
    createDb();
    setupFetchForProjectScopedReconcile({
      sprints: 0,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.syncLogEntries).toBe(100);
    expect(result.data?.failedEntries).toBe(0);
    expect(result.data?.lastSyncAt).toBe('2026-03-10T05:00:00Z');
  });

  it('should call project-scoped endpoint with derived slug', async () => {
    createDb();
    setupFetchForProjectScopedReconcile({ sprints: 0 });

    await cmosDbReconcile({ projectRoot: tempDir });

    // project_name is 'Test Project' → slug is 'test-project'
    const urls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0]?.toString()
    );
    expect(urls.some((u) => u?.includes('/api/sync/status?projectSlug=test-project'))).toBe(true);
  });

  it('should return error when dashboard is not configured', async () => {
    delete process.env.CMOS_DASHBOARD_URL;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;
    createDb();

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('should handle complete API failure on both endpoints', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(false);
  });

  it('should fall back to global endpoint when project-scoped returns 404', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active');
    `);
    setupFetchForGlobalReconcile({
      cmos_sprints: 1,
      cmos_missions: 0,
      cmos_sessions: 0,
      cmos_decisions: 0,
      cmos_learnings: 0,
      cmos_mission_dependencies: 0,
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.projectScoped).toBe(false);
    expect(result.data?.projectSlug).toBeNull();
    expect(result.data?.allMatch).toBe(true);
  });

  it('should only include 6 mapped entity types in project-scoped result', async () => {
    createDb();
    setupFetchForProjectScopedReconcile({
      sprints: 0,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await cmosDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.tables).toHaveLength(6);
    const tableNames = result.data!.tables.map((t) => t.table);
    expect(tableNames).toContain('sprints');
    expect(tableNames).toContain('missions');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('strategic_decisions');
    expect(tableNames).toContain('learnings');
    expect(tableNames).toContain('mission_dependencies');
  });

  it('reconciles via the credential-store key with NO env creds (s73 fix: fromEnvForProject, not fromEnv)', async () => {
    // s73 review: cmos_db was the last sync surface still on env-only auth. Under
    // the old DashboardClient.fromEnv() path, scrubbing the env (no API key, no
    // USER+PASSWORD) returned dashboardNotConfigured even when a device-code key
    // existed in the credential store. fromEnvForProject resolves that store key
    // (used directly as a Bearer — no /api/auth/login), so reconcile succeeds.
    const prevConfigDir = process.env.CMOS_CONFIG_DIR;
    const prevApiKey = process.env.CMOS_DASHBOARD_API_KEY;
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-credstore-'));
    try {
      // The credential-store key is the ONLY credential available.
      delete process.env.CMOS_DASHBOARD_USER;
      delete process.env.CMOS_DASHBOARD_PASSWORD;
      delete process.env.CMOS_DASHBOARD_API_KEY;
      process.env.CMOS_CONFIG_DIR = storeDir;
      CredentialStore.resetInstance();
      const store = await CredentialStore.create({ configDir: storeDir });
      await store.upsertUserScopedKey('store-key-id', {
        key: 'cmk_storekey',
        label: 'device-code test',
        issuedAt: new Date().toISOString(),
        lastUsedAt: '',
      });

      createDb();
      setupFetchForProjectScopedReconcile({
        sprints: 0,
        missions: 0,
        sessions: 0,
        decisions: 0,
        learnings: 0,
        dependencies: 0,
      });

      const result = await cmosDbReconcile({ projectRoot: tempDir });

      // Would be dashboardNotConfigured under the old fromEnv() path.
      expect(result.success).toBe(true);

      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      // API-key auth uses the key directly as a Bearer — it never logs in.
      expect(urls.some((u) => u.includes('/api/auth/login'))).toBe(false);
      // A sync request carried the store key as its Bearer token.
      const sawStoreKeyBearer = fetchMock.mock.calls.some((c) => {
        const init = c[1] as { headers?: Record<string, string> } | undefined;
        return (init?.headers ?? {}).Authorization === 'Bearer cmk_storekey';
      });
      expect(sawStoreKeyBearer).toBe(true);
    } finally {
      CredentialStore.resetInstance();
      if (prevConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
      else process.env.CMOS_CONFIG_DIR = prevConfigDir;
      if (prevApiKey === undefined) delete process.env.CMOS_DASHBOARD_API_KEY;
      else process.env.CMOS_DASHBOARD_API_KEY = prevApiKey;
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  // ─── Formatter ───────────────────────────────────────────────────────────

  describe('formatReconciliationForLLM', () => {
    it('should format matching project-scoped reconciliation', () => {
      const result: CmosToolResult<ReconciliationResult> = {
        success: true,
        data: {
          tables: [
            { table: 'sprints', sqliteCount: 5, pgCount: 5, match: true, delta: 0 },
            { table: 'missions', sqliteCount: 10, pgCount: 10, match: true, delta: 0 },
          ],
          allMatch: true,
          totalSqlite: 15,
          totalPg: 15,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 50,
          failedEntries: 0,
          lastSyncAt: '2026-03-10T05:00:00Z',
        },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('project-scoped: cmos-mcp');
      expect(output).toContain('ALL MATCH');
      expect(output).toContain('SQLite=15');
      expect(output).toContain('PG=15');
    });

    it('should format mismatched reconciliation', () => {
      const result: CmosToolResult<ReconciliationResult> = {
        success: true,
        data: {
          tables: [
            { table: 'sprints', sqliteCount: 25, pgCount: 18, match: false, delta: 7 },
            { table: 'missions', sqliteCount: 106, pgCount: 106, match: true, delta: 0 },
          ],
          allMatch: false,
          totalSqlite: 131,
          totalPg: 124,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 100,
          failedEntries: 5,
          lastSyncAt: '2026-03-10T05:00:00Z',
        },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('MISMATCHES DETECTED');
      expect(output).toContain('5 failed');
    });

    it('should format global fallback reconciliation', () => {
      const result: CmosToolResult<ReconciliationResult> = {
        success: true,
        data: {
          tables: [{ table: 'sprints', sqliteCount: 5, pgCount: 5, match: true, delta: 0 }],
          allMatch: true,
          totalSqlite: 5,
          totalPg: 5,
          projectScoped: false,
          projectSlug: null,
          syncLogEntries: 50,
          failedEntries: 0,
          lastSyncAt: '2026-03-10T05:00:00Z',
        },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('global');
      expect(output).toContain('ALL MATCH');
    });

    it('should format error result', () => {
      const result: CmosToolResult<ReconciliationResult> = {
        success: false,
        error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Dashboard not configured' },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('Reconciliation failed');
    });
  });
});

// ─── Purge Tests ──────────────────────────────────────────────────────────────

describe('cmosDbPurge', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['CMOS_DASHBOARD_URL', 'CMOS_DASHBOARD_USER', 'CMOS_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.CMOS_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.CMOS_DASHBOARD_USER = 'test@example.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'test-password';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-purge-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb() {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    `);
    db.close();
  }

  it('should require explicit confirmation', async () => {
    createDb();

    const result = await cmosDbPurge({ projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(result.error?.message).toContain('confirm=true');
  });

  it('should reject when confirm is false', async () => {
    createDb();

    const result = await cmosDbPurge({ confirm: false, projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('should call POST /api/sync/purge with project slug', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sync/purge')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              purgedProject: 'test-project',
              tablesCleared: [
                'cmos_sprints',
                'cmos_missions',
                'cmos_sessions',
                'cmos_decisions',
                'cmos_learnings',
                'cmos_mission_dependencies',
              ],
              rowsDeleted: 42,
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

    const result = await cmosDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.purgedProject).toBe('test-project');
    expect(result.data?.tablesCleared).toHaveLength(6);
    expect(result.data?.rowsDeleted).toBe(42);

    // Verify the POST body includes projectSlug
    const purgeCall = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]?.toString();
      return url?.includes('/api/sync/purge');
    });
    expect(purgeCall).toBeDefined();
    const body = JSON.parse(purgeCall![1]?.body as string);
    expect(body.projectSlug).toBe('test-project');
  });

  it('should return error when dashboard is not configured', async () => {
    delete process.env.CMOS_DASHBOARD_URL;
    delete process.env.CMOS_DASHBOARD_USER;
    delete process.env.CMOS_DASHBOARD_PASSWORD;
    createDb();

    const result = await cmosDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('should handle dashboard API errors', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(false);
  });

  it('should refuse purge when expectedSlug does not match the local project slug', async () => {
    createDb();

    const result = await cmosDbPurge({
      confirm: true,
      projectRoot: tempDir,
      expectedSlug: 'different-project',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXPECTED_SLUG_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('formatPurgeForLLM', () => {
    it('should format successful purge', () => {
      const result: CmosToolResult<PurgeResult> = {
        success: true,
        data: {
          purgedProject: 'test-project',
          tablesCleared: ['cmos_sprints', 'cmos_missions'],
          rowsDeleted: 15,
        },
      };

      const output = formatPurgeForLLM(result);
      expect(output).toContain('Purge Complete: test-project');
      expect(output).toContain('Rows deleted: 15');
      expect(output).toContain('backfill');
    });

    it('should format failed purge', () => {
      const result: CmosToolResult<PurgeResult> = {
        success: false,
        error: { code: 'DASHBOARD_ERROR', message: 'Something went wrong' },
      };

      const output = formatPurgeForLLM(result);
      expect(output).toContain('Purge failed');
    });
  });
});

// ─── Content Hash Dedup Tests ─────────────────────────────────────────────────

describe('cmosDbBackfill — content hash dedup', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['CMOS_DASHBOARD_URL', 'CMOS_DASHBOARD_USER', 'CMOS_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.CMOS_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.CMOS_DASHBOARD_USER = 'test@example.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'test-password';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-dedup-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
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

  function createDbWithDuplicates() {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');

      -- Insert duplicate decisions (same text, different rows)
      INSERT INTO strategic_decisions (decision_text, created_at, project_domain) VALUES ('Use PostgreSQL for ACID', '2026-01-01T00:00:00Z', 'general');
      INSERT INTO strategic_decisions (decision_text, created_at, project_domain) VALUES ('Use PostgreSQL for ACID', '2026-01-02T00:00:00Z', 'general');
      INSERT INTO strategic_decisions (decision_text, created_at, project_domain) VALUES ('Enable WAL mode', '2026-01-03T00:00:00Z', 'general');

      -- Insert duplicate learnings (same content, different rows)
      INSERT INTO learnings (content, category, created_at) VALUES ('SQLite handles concurrent reads well', 'technical', '2026-01-01T00:00:00Z');
      INSERT INTO learnings (content, category, created_at) VALUES ('SQLite handles concurrent reads well', 'technical', '2026-01-02T00:00:00Z');
      INSERT INTO learnings (content, category, created_at) VALUES ('Graph BFS depth 2 is optimal', 'technical', '2026-01-03T00:00:00Z');
    `);
    db.close();
  }

  it('should dedup decisions with identical content during backfill', async () => {
    createDbWithDuplicates();

    const result = await cmosDbBackfill({ force: true, dryRun: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    // 3 decision rows - 1 duplicate = 2 unique decisions
    expect(result.data!.breakdown.decisions).toBe(2);
    expect(result.data!.deduped).toBeGreaterThanOrEqual(1);
    expect(result.data!.message).toContain('duplicate');
  });

  it('should dedup learnings with identical content during backfill', async () => {
    createDbWithDuplicates();

    const result = await cmosDbBackfill({ force: true, dryRun: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    // 3 learning rows - 1 duplicate = 2 unique learnings
    expect(result.data!.breakdown.learnings).toBe(2);
  });

  it('should include contentHash in decision events', async () => {
    createDbWithDuplicates();

    const pushedEvents: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sync/events') && init?.body) {
        const body = JSON.parse(init.body as string);
        pushedEvents.push(body);
      }
      return new Response(JSON.stringify(dashboardEnvelope()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await cmosDbBackfill({ force: true, projectRoot: tempDir });

    expect(result.success).toBe(true);

    const decisionEvents = pushedEvents.filter((e) => e.eventType === 'decision_captured');
    // Only 2 unique decisions should be pushed
    expect(decisionEvents).toHaveLength(2);

    // Each should have a contentHash
    for (const event of decisionEvents) {
      const data = event.data as Record<string, unknown>;
      expect(data.contentHash).toBeDefined();
      expect(typeof data.contentHash).toBe('string');
      expect((data.contentHash as string).length).toBe(64); // SHA-256 hex
    }
  });

  it('should add content_hash column via migration if missing', async () => {
    createDbWithDuplicates();

    // Run backfill which triggers migration
    await cmosDbBackfill({ force: true, dryRun: true, projectRoot: tempDir });

    // Verify columns were added
    const db = new Database(dbPath);
    const decisionCols = (db.pragma('table_info(strategic_decisions)') as { name: string }[]).map(
      (c) => c.name
    );
    const learningCols = (db.pragma('table_info(learnings)') as { name: string }[]).map(
      (c) => c.name
    );
    db.close();

    expect(decisionCols).toContain('content_hash');
    expect(learningCols).toContain('content_hash');
  });

  it('should produce 0 deduped on re-run with unique data', async () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');

      -- All unique decisions
      INSERT INTO strategic_decisions (decision_text, created_at, project_domain) VALUES ('Decision A', '2026-01-01T00:00:00Z', 'general');
      INSERT INTO strategic_decisions (decision_text, created_at, project_domain) VALUES ('Decision B', '2026-01-02T00:00:00Z', 'general');
      INSERT INTO strategic_decisions (decision_text, created_at, project_domain) VALUES ('Decision C', '2026-01-03T00:00:00Z', 'tooling');
    `);
    db.close();

    const result = await cmosDbBackfill({ force: true, dryRun: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data!.breakdown.decisions).toBe(3);
    expect(result.data!.deduped).toBe(0);
  });
});

// ─── computeContentHash Tests ─────────────────────────────────────────────────

describe('computeContentHash', () => {
  it('should produce consistent hashes for same input', () => {
    const { computeContentHash } = require('../../../src/tools/cmos/schema-migrations');
    const hash1 = computeContentHash('Use PostgreSQL', 'general');
    const hash2 = computeContentHash('Use PostgreSQL', 'general');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('should produce different hashes for different text', () => {
    const { computeContentHash } = require('../../../src/tools/cmos/schema-migrations');
    const hash1 = computeContentHash('Use PostgreSQL', 'general');
    const hash2 = computeContentHash('Use MongoDB', 'general');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different domains', () => {
    const { computeContentHash } = require('../../../src/tools/cmos/schema-migrations');
    const hash1 = computeContentHash('Use PostgreSQL', 'general');
    const hash2 = computeContentHash('Use PostgreSQL', 'tooling');
    expect(hash1).not.toBe(hash2);
  });
});
