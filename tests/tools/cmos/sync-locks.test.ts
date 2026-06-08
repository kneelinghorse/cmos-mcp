/**
 * Sprint 71 m05 — soft-lock orchestration tests (sync-locks.ts).
 *
 * Verifies, against a real seed-schema collab store with a mocked broker: the
 * platform-id resolution + cache, the acquire→push→release flow, take-over-on-expired,
 * respect-active-holder (push proceeds, no release), the lockless fallback, conflict
 * surfacing, and the RESILIENT dispatcher hook (collab propagates; solo is a no-op;
 * a sync failure never fails the local transition).
 *
 * @module tests/tools/cmos/sync-locks
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pushMutableStatusUnderLock,
  maybePropagateMissionStatus,
  maybePropagateMutableStatus,
} from '../../../src/tools/cmos/sync-locks';
import { formatMissionStartForLLM } from '../../../src/tools/cmos/cmos-mission-start';
import { createSuccess } from '../../../src/tools/cmos/errors';
import type { DashboardClient } from '../../../src/tools/cmos/dashboard-client';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

const SLUG = 'test-project';
const PLATFORM_ID = 'platform-uuid-1';

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

const LOCK = {
  fieldScope: 'mission_active',
  holderUserId: 'u-other',
  holderDisplayName: 'Other Editor',
  holderEmail: 'other@x.com',
  acquiredAt: '2026-05-31T10:00:00Z',
  expiresAt: '2026-05-31T10:30:00Z',
  expired: false,
};

// Controllable broker behavior.
let myProjects: Array<{ id: string; slug: string }> = [{ id: PLATFORM_ID, slug: SLUG }];
let acquireMode: 'ok' | 'held' | 'expired' | 'error' = 'ok';
let takeoverMode: 'ok' | 'active' = 'ok';
let pushConflict: Record<string, unknown> | null = null;
let pullFails = false;
let callOrder: string[] = [];

function loginResponse() {
  return {
    success: true,
    data: {
      token: 't',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: { id: 'me', email: 'me@x.com', username: 'me', projects: [] },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupFetchMock(): void {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/auth/login')) return json(loginResponse());
    if (url.includes('/api/projects/me')) {
      callOrder.push('me');
      return json({ success: true, data: { projects: myProjects } });
    }
    if (url.includes('/takeover')) {
      callOrder.push('takeover');
      return takeoverMode === 'ok'
        ? json({ success: true, data: { lock: { ...LOCK, holderUserId: 'me' } } })
        : json({ success: false, data: { lock: LOCK } }, 409);
    }
    if (url.includes('/release')) {
      callOrder.push('release');
      return json({ success: true, data: { released: true } });
    }
    if (url.endsWith('/locks') && method === 'POST') {
      callOrder.push('acquire');
      if (acquireMode === 'ok')
        return json({ success: true, data: { lock: { ...LOCK, holderUserId: 'me' } } });
      if (acquireMode === 'error') return new Response('boom', { status: 500 });
      return json(
        {
          success: false,
          data: { lock: { ...LOCK, expired: acquireMode === 'expired' }, reason: acquireMode },
        },
        409
      );
    }
    if (url.includes('/events') && method === 'GET') {
      callOrder.push('pull');
      if (pullFails) return new Response('err', { status: 500 });
      return json({
        success: true,
        data: { events: [], nextCursor: 0, hasMore: false, returnedCount: 0 },
      });
    }
    if (url.includes('/api/sync/events') && method === 'POST') {
      callOrder.push('push');
      return json(pushConflict ? { success: true, conflict: pushConflict } : { success: true });
    }
    return json({ success: true, data: {} });
  });
}

describe('pushMutableStatusUnderLock + maybePropagateMissionStatus (Sprint 71 m05)', () => {
  let tempDir: string;
  let dbPath: string;
  const ENV_BACKUP: Record<string, string | undefined> = {};
  const seedSchema = fs.readFileSync(
    path.join(__dirname, '../../../cmos-seed/db/schema.sql'),
    'utf8'
  );

  beforeEach(() => {
    for (const k of ['CMOS_DASHBOARD_URL', 'CMOS_DASHBOARD_USER', 'CMOS_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[k] = process.env[k];
    }
    process.env.CMOS_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.CMOS_DASHBOARD_USER = 'me@x.com';
    process.env.CMOS_DASHBOARD_PASSWORD = 'pw';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-synclocks-test-'));
    fs.mkdirSync(path.join(tempDir, 'cmos', 'db'), { recursive: true });
    dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');

    CmosDetector.resetInstance();
    myProjects = [{ id: PLATFORM_ID, slug: SLUG }];
    acquireMode = 'ok';
    takeoverMode = 'ok';
    pushConflict = null;
    pullFails = false;
    callOrder = [];
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    setupFetchMock();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
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

  function metaValue(key: string): string | undefined {
    const db = new Database(dbPath);
    const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    db.close();
    return row?.value;
  }

  // ─── Acquire → push → release ───────────────────────────────────────────────

  it('acquires a free lock, pushes, then releases (and caches the platform id)', async () => {
    createStore();
    const result = await pushMutableStatusUnderLock({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.success).toBe(true);
    expect(result.data?.lockState).toBe('acquired');
    expect(result.data?.released).toBe(true);
    expect(result.data?.push?.pushedStatus).toBe('Completed');
    // Lock acquired BEFORE the push; released AFTER it.
    expect(callOrder.indexOf('acquire')).toBeLessThan(callOrder.indexOf('push'));
    expect(callOrder.indexOf('push')).toBeLessThan(callOrder.indexOf('release'));
    // Platform id resolved + cached under the slug-scoped key.
    expect(metaValue(`platform_project_id:${SLUG}`)).toBe(PLATFORM_ID);
  });

  it('takes over an EXPIRED lock then pushes', async () => {
    createStore();
    acquireMode = 'expired';
    takeoverMode = 'ok';
    const result = await pushMutableStatusUnderLock({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Blocked',
      now: 1780250000000,
    });
    expect(result.data?.lockState).toBe('tookover');
    expect(callOrder).toContain('takeover');
    expect(result.data?.released).toBe(true);
  });

  it('respects an ACTIVE holder — surfaces a warning, pushes anyway, does NOT release', async () => {
    createStore();
    acquireMode = 'held';
    const result = await pushMutableStatusUnderLock({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.data?.lockState).toBe('held-by-other');
    expect(result.data?.lockHolder?.email).toBe('other@x.com');
    expect(result.data?.released).toBe(false);
    expect(callOrder).not.toContain('release'); // we never held it
    expect(callOrder).toContain('push'); // advisory — pushed anyway
    expect(result.data?.warnings.some((w) => w.includes('locked by'))).toBe(true);
  });

  it('falls back to a lockless push when the platform id cannot be resolved', async () => {
    createStore();
    myProjects = []; // no matching slug
    const result = await pushMutableStatusUnderLock({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.data?.lockState).toBe('unavailable');
    expect(callOrder).not.toContain('acquire');
    expect(callOrder).toContain('push'); // push still happens
    expect(result.data?.warnings.some((w) => w.includes('platform project id'))).toBe(true);
  });

  it('surfaces a superseded conflict in the warnings', async () => {
    createStore();
    pushConflict = {
      id: 'conf-9',
      fieldScope: 'mission_active',
      entityId: 'm1',
      field: 'status',
      appliedValue: 'Blocked',
      appliedAuthorUserId: 'other',
      appliedOccurredAt: 1780259999999,
      supersededValue: 'Completed',
      supersededAuthorUserId: 'me',
      supersededOccurredAt: 1780250000000,
      detectedAt: '2026-05-31T11:00:00Z',
      resolved: false,
      youWereSuperseded: true,
    };
    const result = await pushMutableStatusUnderLock({
      projectRoot: tempDir,
      missionId: 'm1',
      status: 'Completed',
      now: 1780250000000,
    });
    expect(result.data?.push?.superseded).toBe(true);
    expect(result.data?.warnings.some((w) => w.includes('conf-9'))).toBe(true);
  });

  // ─── Dispatcher hook ────────────────────────────────────────────────────────

  it('maybePropagate is a NO-OP on a solo store (no fetch, result untouched)', async () => {
    createStore({ collab: false });
    const base = createSuccess({ ok: true });
    const out = await maybePropagateMissionStatus(base, 'm1', tempDir);
    expect(out.success).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled(); // solo store never reaches the broker
  });

  it('maybePropagate pushes on a collab store and folds a conflict into warnings', async () => {
    createStore();
    pushConflict = {
      id: 'conf-x',
      fieldScope: 'mission_active',
      entityId: 'm1',
      field: 'status',
      appliedValue: 'Blocked',
      appliedAuthorUserId: 'other',
      appliedOccurredAt: 9,
      supersededValue: 'Completed',
      supersededAuthorUserId: 'me',
      supersededOccurredAt: 1,
      detectedAt: '2026-05-31T11:00:00Z',
      resolved: false,
      youWereSuperseded: true,
    };
    const base = createSuccess({ ok: true });
    const out = await maybePropagateMissionStatus(base, 'm1', tempDir);
    expect(out.success).toBe(true); // the local transition result is preserved
    expect(callOrder).toContain('push');
    expect(out.warnings?.some((w) => w.includes('conf-x'))).toBe(true);
  });

  it('the transition formatters render folded-in collab warnings (m05 review fix)', () => {
    // The dispatcher folds collab-sync warnings into result.warnings; the per-action
    // LLM formatters must render them (previously only `complete` did).
    const formatted = formatMissionStartForLLM({
      success: true,
      data: {
        missionId: 'm1',
        previousStatus: 'Queued',
        currentStatus: 'In Progress',
        startedAt: '2026-06-01T00:00:00Z',
        relevantDecisions: [],
      } as unknown as Parameters<typeof formatMissionStartForLLM>[0]['data'],
      warnings: ['mission_active is locked by other@x.com — pushed anyway.'],
    });
    expect(formatted).toContain('Warnings:');
    expect(formatted).toContain('locked by other@x.com');
  });

  it('maybePropagate is RESILIENT — a pull failure folds into warnings, result stays successful', async () => {
    createStore();
    pullFails = true; // pull-before-push aborts the push
    const base = createSuccess({ ok: true });
    const out = await maybePropagateMissionStatus(base, 'm1', tempDir);
    expect(out.success).toBe(true); // local transition NOT failed by the sync error
    expect(out.warnings?.some((w) => w.toLowerCase().includes('sync failed'))).toBe(true);
  });

  // ─── Sprint 72 m01 — generic scope threading ──────────────────────────────────

  it('threads params.fieldScope into acquire/takeover/release (no mission_active literal)', async () => {
    createStore();
    const db0 = new Database(dbPath);
    db0.exec(`INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active');`);
    db0.close();

    const lockScopes: Array<{ method: string; scope: string }> = [];
    const fake = {
      getMyProjects: async () => ({
        success: true,
        data: { projects: [{ id: PLATFORM_ID, slug: SLUG }] },
      }),
      acquireLock: async (_pid: string, scope: string) => {
        lockScopes.push({ method: 'acquire', scope });
        return { success: true, data: { ok: true, lock: { ...LOCK, holderUserId: 'me' } } };
      },
      takeoverLock: async (_pid: string, scope: string) => {
        lockScopes.push({ method: 'takeover', scope });
        return { success: true, data: { ok: true, lock: { ...LOCK, holderUserId: 'me' } } };
      },
      releaseLock: async (_pid: string, scope: string) => {
        lockScopes.push({ method: 'release', scope });
        return { success: true, data: { released: true } };
      },
      pushMutableEvent: async () => ({ success: true, data: { conflict: null } }),
    } as unknown as DashboardClient;

    const result = await pushMutableStatusUnderLock({
      projectRoot: tempDir,
      fieldScope: 'sprint_status',
      entityId: 's1',
      status: 'Completed',
      now: 1780250000000,
      client: fake,
    });

    expect(result.success).toBe(true);
    expect(lockScopes.length).toBeGreaterThan(0);
    // Every lock call carried the sprint_status scope — no leaked mission_active literal.
    expect(lockScopes.every((c) => c.scope === 'sprint_status')).toBe(true);
    expect(lockScopes.some((c) => c.scope === 'mission_active')).toBe(false);
  });

  it('maybePropagateMutableStatus propagates a sprint_status edit on a collab store', async () => {
    createStore();
    const db0 = new Database(dbPath);
    db0.exec(`INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Completed');`);
    db0.close();

    const base = createSuccess({ ok: true });
    const out = await maybePropagateMutableStatus(
      base,
      'sprint_status',
      's1',
      (db) => {
        const row = db.getOne<{ status: string }>('SELECT status FROM sprints WHERE id = ?', [
          's1',
        ]);
        return row.success ? (row.data?.status ?? null) : null;
      },
      tempDir
    );

    expect(out.success).toBe(true);
    expect(callOrder).toContain('push'); // reached the broker via the lock-wrapped push
  });

  it('maybePropagateMutableStatus is a NO-OP on a solo store', async () => {
    createStore({ collab: false });
    const base = createSuccess({ ok: true });
    const out = await maybePropagateMutableStatus(
      base,
      'sprint_status',
      's1',
      () => 'Completed',
      tempDir
    );
    expect(out.success).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
