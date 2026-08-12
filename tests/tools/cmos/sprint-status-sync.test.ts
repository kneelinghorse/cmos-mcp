/**
 * Sprint 72 m02 — sprint_status emit (outbound) tests.
 *
 * Verifies, against a real seed-schema collab store with a mocked broker: the
 * sprint_status dispatcher hook (maybePropagateSprintStatus) emits 'sprint_updated'
 * {sprintId,status,occurredAt,originSeq} under the sprint_status soft-lock; the
 * cmos_sprint dispatcher wires it on the update path (and only when status changed);
 * a solo store is a no-op; the change-guard suppresses a redundant same-status emit;
 * a broker conflict folds a restore-hint into result.warnings that the sprint update
 * formatter renders. Mirrors the mission_active precedent (sync-locks.test.ts).
 *
 * @module tests/tools/cmos/sprint-status-sync
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosSprint } from '../../../src/tools/cmos/cmos-sprint';
import { __drainCheckpointBackfill } from '../../../src/tools/cmos/checkpoint-backfill';
import { maybePropagateSprintStatus } from '../../../src/tools/cmos/sync-locks';
import { formatSprintUpdateForLLM } from '../../../src/tools/cmos/cmos-sprint-update';
import { createSuccess } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

const SLUG = 'test-project';
const PLATFORM_ID = 'platform-uuid-1';

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

const LOCK = {
  fieldScope: 'sprint_status',
  holderUserId: 'me',
  holderDisplayName: 'Me',
  holderEmail: 'me@x.com',
  acquiredAt: '2026-06-02T10:00:00Z',
  expiresAt: '2026-06-02T10:30:00Z',
  expired: false,
};

let pushConflict: Record<string, unknown> | null = null;
let pushedBodies: Record<string, unknown>[] = [];
let lockScopes: string[] = [];
let callOrder: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

function setupFetchMock(): void {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/auth/login')) return json(loginResponse());
    if (url.includes('/api/projects/me')) {
      callOrder.push('me');
      return json({ success: true, data: { projects: [{ id: PLATFORM_ID, slug: SLUG }] } });
    }
    if (url.includes('/takeover')) {
      // takeover/release carry the scope in the URL path: /locks/<scope>/takeover.
      const m = url.match(/\/locks\/([^/]+)\/takeover/);
      lockScopes.push(`takeover:${m ? decodeURIComponent(m[1]) : ''}`);
      return json({ success: true, data: { lock: { ...LOCK, holderUserId: 'me' } } });
    }
    if (url.includes('/release')) {
      const m = url.match(/\/locks\/([^/]+)\/release/);
      lockScopes.push(`release:${m ? decodeURIComponent(m[1]) : ''}`);
      return json({ success: true, data: { released: true } });
    }
    if (url.endsWith('/locks') && method === 'POST') {
      const scope = init?.body ? (JSON.parse(String(init.body)).fieldScope as string) : '';
      lockScopes.push(`acquire:${scope}`);
      callOrder.push('acquire');
      return json({ success: true, data: { lock: { ...LOCK, holderUserId: 'me' } } });
    }
    if (url.includes('/events') && method === 'GET') {
      callOrder.push('pull');
      return json({
        success: true,
        data: { events: [], nextCursor: 0, hasMore: false, returnedCount: 0 },
      });
    }
    if (url.includes('/api/sync/events') && method === 'POST') {
      callOrder.push('push');
      pushedBodies.push(
        init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      );
      return json(pushConflict ? { success: true, conflict: pushConflict } : { success: true });
    }
    return json({ success: true, data: {} });
  });
}

describe('sprint_status emit (Sprint 72 m02)', () => {
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-sprintsync-test-'));
    fs.mkdirSync(path.join(tempDir, 'cmos', 'db'), { recursive: true });
    dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');

    CmosDetector.resetInstance();
    pushConflict = null;
    pushedBodies = [];
    lockScopes = [];
    callOrder = [];
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    setupFetchMock();
  });

  afterEach(async () => {
    // s86-m01: THIS describe is the one that armed the CI late-log flake. Its
    // beforeEach re-sets the three dashboard credential vars that the root
    // beforeEach (tests/jest-setup-after-env.ts) strips, which opens the
    // credential gate in triggerCheckpointBackfill. cmos_sprint(action='complete')
    // fires that sync and drops the promise, so without an explicit drain the
    // detached body is still running when this hook restores the env below —
    // it then re-resolves credentials mid-flight, falls to the no-slug path, and
    // logs "[CHECKPOINT] Backfill failed: …" after Jest has torn the suite down.
    //
    // ORDER IS LOAD-BEARING: drain BEFORE the restore loop. Draining after the
    // env is gone reproduces the bug rather than fixing it.
    await __drainCheckpointBackfill();

    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createStore(
    opts: { collab?: boolean; sprintStatus?: string; extraSql?: string } = {}
  ): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', '${SLUG}');
      ${opts.collab !== false ? `INSERT OR REPLACE INTO metadata (key, value) VALUES ('collab_role', 'editor');` : ''}
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', '${opts.sprintStatus ?? 'Active'}');
      ${opts.extraSql ?? ''}
    `);
    db.close();
  }

  // ─── maybePropagateSprintStatus (the dispatcher hook, tested directly) ──────────

  it('emits exactly ONE sprint_updated {sprintId,status,occurredAt,originSeq} under the sprint_status lock', async () => {
    createStore({ sprintStatus: 'Completed' });
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);

    expect(out.success).toBe(true);
    expect(callOrder.filter((c) => c === 'push')).toHaveLength(1);

    const body = pushedBodies[0];
    expect(body.eventType).toBe('sprint_updated');
    const data = body.data as Record<string, unknown>;
    expect(data.sprintId).toBe('s1');
    expect(data.status).toBe('Completed');
    expect(typeof data.occurredAt).toBe('number');
    expect(typeof data.originSeq).toBe('number');
    expect('missionId' in data).toBe(false);

    // The soft-lock was acquired + released for the sprint_status scope (no mission_active).
    expect(lockScopes).toContain('acquire:sprint_status');
    expect(lockScopes).toContain('release:sprint_status');
    expect(lockScopes.some((s) => s.includes('mission_active'))).toBe(false);
  });

  it('is a NO-OP on a SOLO store (no collab_role) — no emit, no warnings, no fetch', async () => {
    createStore({ collab: false, sprintStatus: 'Completed' });
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);
    expect(out.success).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('change-guard: suppresses a redundant emit when the recorded status equals the current status', async () => {
    // Pre-seed the recorded mutable_status as already 'Completed' to match the current row.
    createStore({
      sprintStatus: 'Completed',
      extraSql: `INSERT INTO metadata (key, value) VALUES ('mutable_status:sprint_status:s1', '${JSON.stringify(
        { status: 'Completed', occurredAt: 1, originSeq: 1, authorUserId: null }
      ).replace(/'/g, "''")}');`,
    });
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);
    expect(out.success).toBe(true);
    expect(callOrder).not.toContain('push'); // unchanged → nothing emitted
  });

  it('folds a superseded-conflict restore hint into result.warnings (resilient, local edit kept)', async () => {
    createStore({ sprintStatus: 'Completed' });
    pushConflict = {
      id: 'conf-sp',
      fieldScope: 'sprint_status',
      entityId: 's1',
      field: 'status',
      appliedValue: 'Active',
      appliedAuthorUserId: 'other',
      appliedOccurredAt: 9_999_999_999_999,
      supersededValue: 'Completed',
      supersededAuthorUserId: 'me',
      supersededOccurredAt: 1,
      detectedAt: '2026-06-02T11:00:00Z',
      resolved: false,
      youWereSuperseded: true,
    };
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);
    expect(out.success).toBe(true); // local edit never fails on a sync conflict
    expect(out.warnings?.some((w) => w.includes('conf-sp'))).toBe(true);
  });

  it('formatSprintUpdateForLLM renders folded-in collab warnings (#790 render-the-warnings)', () => {
    const formatted = formatSprintUpdateForLLM({
      success: true,
      data: { sprintId: 's1', updatedFields: ['status'] } as unknown as Parameters<
        typeof formatSprintUpdateForLLM
      >[0]['data'],
      warnings: [
        "Your 'Completed' edit was superseded by 'Active' (conflict conf-sp) — restore it.",
      ],
    });
    expect(formatted).toContain('Warnings:');
    expect(formatted).toContain('conf-sp');
  });

  // ─── cmos_sprint dispatcher wiring ──────────────────────────────────────────────

  it('cmos_sprint(update, status) on a collab store emits sprint_updated with the new status', async () => {
    createStore({ sprintStatus: 'Active' });
    const result = await cmosSprint({
      action: 'update',
      sprintId: 's1',
      fields: { status: 'In Progress' },
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(callOrder.filter((c) => c === 'push')).toHaveLength(1);
    const data = pushedBodies[0].data as Record<string, unknown>;
    expect(pushedBodies[0].eventType).toBe('sprint_updated');
    expect(data.sprintId).toBe('s1');
    expect(data.status).toBe('In Progress');
  });

  it('cmos_sprint(update) WITHOUT a status field emits nothing (guard)', async () => {
    createStore({ sprintStatus: 'Active' });
    const result = await cmosSprint({
      action: 'update',
      sprintId: 's1',
      fields: { focus: 'a new focus' },
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(callOrder).not.toContain('push'); // no status change → no emit
  });

  it('cmos_sprint(update, status) on a SOLO store behaves byte-identically (no emit, no fetch)', async () => {
    createStore({ collab: false, sprintStatus: 'Active' });
    const result = await cmosSprint({
      action: 'update',
      sprintId: 's1',
      fields: { status: 'In Progress' },
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cmos_sprint(complete) on a collab store emits sprint_updated {status:Completed}', async () => {
    createStore({
      sprintStatus: 'Active',
      extraSql: `
        INSERT INTO contexts (id, source_path, content) VALUES ('project_context', 'p', '{}');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m1', 's1', 'Mission 1', 'Completed');`,
    });
    const result = await cmosSprint({
      action: 'complete',
      sprintId: 's1',
      summary: 'done',
      forceComplete: true,
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    const sprintUpdates = pushedBodies.filter((b) => b.eventType === 'sprint_updated');
    expect(sprintUpdates).toHaveLength(1);
    expect((sprintUpdates[0].data as Record<string, unknown>).status).toBe('Completed');
  });
});
