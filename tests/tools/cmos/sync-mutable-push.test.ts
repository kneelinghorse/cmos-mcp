/**
 * Sprint 71 m04 — outbound pull-before-push tests (sync-mutable-push.ts).
 *
 * Verifies, against a real seed-schema collab store with a mocked broker: the
 * pre-push pull runs first, a FRESH per-edit (occurred_at, origin_seq) is stamped,
 * the mission_updated event is pushed with the right envelope, the inline LWW
 * conflict converges the local row (superseded path) or is surfaced (won path),
 * append-only behavior is untouched, and the collab + pull-failure guards hold.
 *
 * @module tests/tools/cmos/sync-mutable-push
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatPushMutableStatusForLLM,
  pushMutableStatus,
} from '../../../src/tools/cmos/sync-mutable-push';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

const SLUG = 'test-project';

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

// ─── Controllable broker state ───────────────────────────────────────────────────

interface EventPage {
  events: unknown[];
  nextCursor: number;
  hasMore: boolean;
}
let pullPage: EventPage = { events: [], nextCursor: 0, hasMore: false };
let pullShouldFail = false;
let nextPushResponse: Record<string, unknown> = { success: true };
let pushShouldFail = false;
let pushedBodies: Record<string, unknown>[] = [];
let callOrder: string[] = [];

const PULL_PROVENANCE_WARNING =
  '1 genesis event(s) lacked the provenance/data needed to reconstruct a replica row ' +
  'faithfully (a pre-s71-m01 origin, or a malformed payload) and were skipped — not ' +
  're-stamped, to preserve cross-machine event identity.';

function arrangeSuccessfulPullWithWarning(): void {
  pullPage = {
    events: [
      {
        cursor: 7,
        eventType: 'decision_captured',
        payload: {
          projectId: 'proj-test',
          projectName: 'Test Project',
          eventType: 'decision_captured',
          timestamp: '2026-05-31T10:00:00Z',
          // Missing stableEventId/occurredAt/originSeq: syncPull succeeds but warns that
          // it could not reconstruct this genesis row without inventing provenance.
          data: { decisionId: 9, content: 'no provenance' },
        },
        receivedAt: '2026-05-31T10:00:01Z',
        processed: true,
        error: null,
      },
    ],
    nextCursor: 7,
    hasMore: false,
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

function setupFetchMock(): void {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/auth/login')) {
      return new Response(JSON.stringify(loginResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/events') && method === 'GET') {
      callOrder.push('pull');
      if (pullShouldFail) return new Response('Server error', { status: 500 });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            events: pullPage.events,
            nextCursor: pullPage.nextCursor,
            hasMore: pullPage.hasMore,
            returnedCount: pullPage.events.length,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/api/sync/events') && method === 'POST') {
      callOrder.push('push');
      pushedBodies.push(
        init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      );
      if (pushShouldFail) return new Response('Server error', { status: 500 });
      return new Response(JSON.stringify(nextPushResponse), {
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

// ─── Test setup ──────────────────────────────────────────────────────────────────

describe('pushMutableStatus (Sprint 71 m04)', () => {
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-mutablepush-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    CmosDetector.resetInstance();
    pullPage = { events: [], nextCursor: 0, hasMore: false };
    pullShouldFail = false;
    nextPushResponse = { success: true };
    pushShouldFail = false;
    pushedBodies = [];
    callOrder = [];
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

  function createStore(opts: { collab?: boolean } = {}): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', '${SLUG}');
      ${opts.collab !== false ? `INSERT OR REPLACE INTO metadata (key, value) VALUES ('collab_role', 'editor');` : ''}
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      INSERT INTO missions (id, name, status) VALUES ('m1', 'Mission 1', 'In Progress');
    `);
    db.close();
  }

  function missionStatus(): string {
    const db = new Database(dbPath);
    const row = db.prepare(`SELECT status FROM missions WHERE id = 'm1'`).get() as {
      status: string;
    };
    db.close();
    return row.status;
  }

  // ─── Happy path ─────────────────────────────────────────────────────────────────

  it('pulls before pushing, stamps fresh ordering, and pushes mission_updated', async () => {
    createStore();
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });

    expect(result.success).toBe(true);
    expect(result.data?.pulledBeforePush).toBe(true);
    expect(result.data?.occurredAt).toBe(1780250000000);
    expect(result.data?.originSeq).toBe(1);
    expect(result.data?.superseded).toBe(false);
    expect(result.data?.localStatus).toBe('Completed');
    expect(result.warnings).toBeUndefined();

    // The pull ran BEFORE the push (pull-before-push discipline).
    expect(callOrder).toEqual(['pull', 'push']);

    // Envelope: mission_updated carrying currentStatus + fresh occurred_at INSIDE data
    // (never the envelope timestamp), slug as projectId.
    const body = pushedBodies[0];
    expect(body.eventType).toBe('mission_updated');
    expect(body.projectId).toBe(SLUG);
    expect(body.timestamp).toBe(new Date(1780250000000).toISOString());
    const data = body.data as Record<string, unknown>;
    expect(data.missionId).toBe('m1');
    expect(data.currentStatus).toBe('Completed');
    expect(data.occurredAt).toBe(1780250000000);
    expect(data.originSeq).toBe(1);

    // Local row optimistically reflects the edit.
    expect(missionStatus()).toBe('Completed');
  });

  it('carries a successful pull-before-push warning onto the push result and rendered answer', async () => {
    createStore();
    arrangeSuccessfulPullWithWarning();

    const pending = pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    await expect(pending).resolves.toMatchObject({ success: true });
    const result = await pending;

    expect(callOrder).toEqual(['pull', 'push']);
    // The pull's advisory is not summarized, prefixed, or otherwise rewritten by the push leg.
    expect(result.warnings).toEqual([PULL_PROVENANCE_WARNING]);
    const answer = formatPushMutableStatusForLLM(result);
    expect(answer).toContain('Warnings:');
    expect(answer).toContain(PULL_PROVENANCE_WARNING);
    expect(answer.split(PULL_PROVENANCE_WARNING)).toHaveLength(2);
  });

  it('preserves a successful pull warning when the broker push fails', async () => {
    createStore();
    arrangeSuccessfulPullWithWarning();
    pushShouldFail = true;

    const pending = pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    await expect(pending).resolves.toMatchObject({
      success: false,
      error: { code: 'DASHBOARD_ERROR' },
    });
    const result = await pending;

    expect(callOrder).toEqual(['pull', 'push']);
    expect(result.warnings).toEqual([PULL_PROVENANCE_WARNING]);
    const answer = formatPushMutableStatusForLLM(result);
    expect(answer).toContain(
      'Mutable push failed: Dashboard error: Server error 500: Server error'
    );
    expect(answer).toContain('Warnings:');
    expect(answer.split(PULL_PROVENANCE_WARNING)).toHaveLength(2);
  });

  it('preserves a successful pull warning when a non-collab store refuses the push', async () => {
    createStore({ collab: false });
    arrangeSuccessfulPullWithWarning();

    const pending = pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    await expect(pending).resolves.toMatchObject({
      success: false,
      error: { code: 'NOT_COLLAB_STORE' },
    });
    const result = await pending;

    expect(callOrder).toEqual(['pull']);
    expect(result.warnings).toEqual([PULL_PROVENANCE_WARNING]);
    const answer = formatPushMutableStatusForLLM(result);
    expect(answer).toContain('Mutable push failed: The mutable-surface event-push path');
    expect(answer).toContain('Warnings:');
    expect(answer.split(PULL_PROVENANCE_WARNING)).toHaveLength(2);
  });

  // ─── Pull-before-push converges a newer remote value before the edit ──────────────

  it('applies a newer remote transition during the pre-push pull (does not push from a stale base)', async () => {
    createStore();
    // The broker has a newer completion the local store has not seen yet.
    pullPage = {
      events: [
        {
          cursor: 7,
          eventType: 'mission_updated',
          payload: {
            projectId: 'proj-test',
            eventType: 'mission_updated',
            timestamp: '2026-05-31T10:00:00Z',
            data: {
              missionId: 'm1',
              currentStatus: 'Blocked',
              occurredAt: 1780249000000,
              originSeq: 3,
            },
          },
          receivedAt: '2026-05-31T10:00:01Z',
          processed: true,
          error: null,
        },
      ],
      nextCursor: 7,
      hasMore: false,
    };

    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000, // newer than the pulled remote edit
    });

    expect(result.success).toBe(true);
    // Our edit is newer than the pulled value, so after the push our value stands —
    // but the point is the pull ran and applied the remote value first.
    expect(callOrder).toEqual(['pull', 'push']);
    const data = pushedBodies[0].data as Record<string, unknown>;
    expect(data.occurredAt as number).toBeGreaterThan(1780249000000);
  });

  // ─── Superseded (our push lost LWW) ──────────────────────────────────────────────

  it('converges the local row to the broker LWW winner when superseded', async () => {
    createStore();
    nextPushResponse = {
      success: true,
      conflict: {
        id: 'conf-1',
        fieldScope: 'mission_active',
        entityId: 'm1',
        field: 'status',
        appliedValue: 'Blocked',
        appliedAuthorUserId: 'other-user',
        appliedOccurredAt: 1780259999999,
        supersededValue: 'Completed',
        supersededAuthorUserId: 'me',
        supersededOccurredAt: 1780250000000,
        detectedAt: '2026-05-31T11:00:00Z',
        resolved: false,
        youWereSuperseded: true,
      },
    };

    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });

    expect(result.success).toBe(true);
    expect(result.data?.superseded).toBe(true);
    expect(result.data?.localStatus).toBe('Blocked'); // converged to the winner
    expect(result.data?.conflict?.id).toBe('conf-1');
    // The local row was converged to the broker's winning value, not left at our edit.
    expect(missionStatus()).toBe('Blocked');
  });

  it('surfaces a conflict where WE won (youWereSuperseded=false) without reverting local', async () => {
    createStore();
    nextPushResponse = {
      success: true,
      conflict: {
        id: 'conf-2',
        fieldScope: 'mission_active',
        entityId: 'm1',
        field: 'status',
        appliedValue: 'Completed',
        appliedAuthorUserId: 'me',
        appliedOccurredAt: 1780250000000,
        supersededValue: 'Queued',
        supersededAuthorUserId: 'other-user',
        supersededOccurredAt: 1780240000000,
        detectedAt: '2026-05-31T11:00:00Z',
        resolved: false,
        youWereSuperseded: false,
      },
    };

    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });

    expect(result.success).toBe(true);
    expect(result.data?.superseded).toBe(false);
    expect(result.data?.localStatus).toBe('Completed');
    expect(result.data?.conflict?.id).toBe('conf-2');
    expect(missionStatus()).toBe('Completed');
  });

  // ─── skipPull ─────────────────────────────────────────────────────────────────────

  it('skips the pre-push pull when skipPull is set', async () => {
    createStore();
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
      skipPull: true,
    });
    expect(result.success).toBe(true);
    expect(result.data?.pulledBeforePush).toBe(false);
    expect(callOrder).toEqual(['push']); // no pull
  });

  // ─── Guards ───────────────────────────────────────────────────────────────────────

  it('refuses to push on a non-collab (solo) store', async () => {
    createStore({ collab: false });
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_COLLAB_STORE');
    expect(result.warnings).toBeUndefined();
    expect(callOrder).not.toContain('push'); // never pushed
    expect(missionStatus()).toBe('In Progress'); // local untouched
    expect(formatPushMutableStatusForLLM(result)).toBe(
      'Mutable push failed: The mutable-surface event-push path is only for shared/collaborative ' +
        'stores (metadata.collab_role set). A solo project syncs mutable state via the whole-DB ' +
        'file-sync on checkpoint; per-field event-push would be redundant.'
    );
  });

  it('returns an error on push failure, leaving the optimistic local edit in place (caller retries)', async () => {
    createStore();
    pushShouldFail = true;
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.success).toBe(false);
    expect(result.warnings).toBeUndefined();
    expect(callOrder).toEqual(['pull', 'push']); // it did attempt the push
    // Optimistic-apply semantic (documented): the local edit stands so a retry can
    // re-push it; the broker reconciles via LWW on the eventual successful push.
    expect(missionStatus()).toBe('Completed');
    expect(formatPushMutableStatusForLLM(result)).toBe(
      'Mutable push failed: Dashboard error: Server error 500: Server error'
    );
  });

  it('aborts the push when the pre-push pull fails (no blind clobber)', async () => {
    createStore();
    pullShouldFail = true;
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PULL_BEFORE_PUSH_FAILED');
    expect(callOrder).not.toContain('push'); // never reached the push
    expect(missionStatus()).toBe('In Progress'); // local untouched
  });

  // ─── Sprint 72 m01 — generic scope envelopes ──────────────────────────────────

  function seedSprint(): void {
    const db = new Database(dbPath);
    db.exec(`INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active');`);
    db.close();
  }

  function sprintStatus(): string {
    const db = new Database(dbPath);
    const row = db.prepare(`SELECT status FROM sprints WHERE id = 's1'`).get() as {
      status: string;
    };
    db.close();
    return row.status;
  }

  it('emits sprint_updated with {sprintId,status} data for fieldScope=sprint_status', async () => {
    createStore();
    seedSprint();
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      fieldScope: 'sprint_status',
      entityId: 's1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.success).toBe(true);
    expect(result.data?.fieldScope).toBe('sprint_status');
    expect(result.data?.entityId).toBe('s1');

    const body = pushedBodies[0];
    expect(body.eventType).toBe('sprint_updated');
    const data = body.data as Record<string, unknown>;
    expect(data.sprintId).toBe('s1');
    expect(data.status).toBe('Completed');
    expect(data.occurredAt).toBe(1780250000000);
    expect(data.originSeq).toBe(1);
    expect('missionId' in data).toBe(false);

    // Optimistic local apply hit sprints.status (no updated_at column on sprints).
    expect(sprintStatus()).toBe('Completed');
  });

  it('emits project_identity_updated with {name} (no entity id) for fieldScope=project_identity', async () => {
    createStore();
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      fieldScope: 'project_identity',
      entityId: 'project',
      status: 'Renamed Project',
      now: 1780250000000,
    });
    expect(result.success).toBe(true);
    expect(result.data?.fieldScope).toBe('project_identity');
    expect(result.data?.entityId).toBe('project');

    const body = pushedBodies[0];
    expect(body.eventType).toBe('project_identity_updated');
    const data = body.data as Record<string, unknown>;
    expect(data.name).toBe('Renamed Project');
    expect(data.occurredAt).toBe(1780250000000);
    expect(data.originSeq).toBe(1);
    expect('missionId' in data).toBe(false);
    expect('sprintId' in data).toBe(false);
  });

  it('still emits an identical mission_updated envelope when fieldScope defaults (frozen)', async () => {
    createStore();
    const result = await pushMutableStatus({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.success).toBe(true);
    expect(result.data?.fieldScope).toBe('mission_active');
    expect(result.data?.entityId).toBe('m1');

    const body = pushedBodies[0];
    expect(body.eventType).toBe('mission_updated');
    const data = body.data as Record<string, unknown>;
    expect(data.missionId).toBe('m1');
    expect(data.currentStatus).toBe('Completed');
    expect('sprintId' in data).toBe(false);
    expect('name' in data).toBe(false);
  });
});
