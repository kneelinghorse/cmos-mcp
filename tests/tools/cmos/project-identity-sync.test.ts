/**
 * Sprint 72 m03 — project_identity emit (outbound) tests.
 *
 * Verifies, against a real seed-schema collab store with a mocked broker: the
 * project_identity dispatcher hook (maybePropagateProjectIdentity) emits
 * 'project_identity_updated' {name} (NO entity id) under the project_identity soft-lock;
 * the cmos_context dispatcher wires it on the project_identity update path, and only when
 * project_name changed; a solo store is a no-op; the change-guard suppresses a redundant
 * emit; a broker conflict folds a restore-hint into result.warnings that the update
 * formatter renders. Mirrors the mission_active / sprint_status precedent.
 *
 * @module tests/tools/cmos/project-identity-sync
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmosContext } from '../../../src/tools/cmos/cmos-context';
import { maybePropagateProjectIdentity } from '../../../src/tools/cmos/sync-locks';
import { formatProjectIdentityUpdateForLLM } from '../../../src/tools/cmos/cmos-context-project-identity';
import { createSuccess } from '../../../src/tools/cmos/errors';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';

const SLUG = 'test-project';
const PLATFORM_ID = 'platform-uuid-1';

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

const LOCK = {
  fieldScope: 'project_identity',
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
      return json({ success: true, data: { projects: [{ id: PLATFORM_ID, slug: SLUG }] } });
    }
    if (url.includes('/takeover')) {
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

describe('project_identity emit (Sprint 72 m03)', () => {
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-pidsync-test-'));
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

  afterEach(() => {
    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createStore(opts: { collab?: boolean; name?: string; extraSql?: string } = {}): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', '${opts.name ?? 'My Project'}');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', '${SLUG}');
      ${opts.collab !== false ? `INSERT OR REPLACE INTO metadata (key, value) VALUES ('collab_role', 'editor');` : ''}
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      ${opts.extraSql ?? ''}
    `);
    db.close();
  }

  // ─── maybePropagateProjectIdentity (the dispatcher hook, tested directly) ───────

  it('emits exactly ONE project_identity_updated {name} (no entity id) under the project_identity lock', async () => {
    createStore({ name: 'My Project' });
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);

    expect(out.success).toBe(true);
    expect(callOrder.filter((c) => c === 'push')).toHaveLength(1);

    const body = pushedBodies[0];
    expect(body.eventType).toBe('project_identity_updated');
    const data = body.data as Record<string, unknown>;
    expect(data.name).toBe('My Project');
    expect(typeof data.occurredAt).toBe('number');
    expect(typeof data.originSeq).toBe('number');
    expect('missionId' in data).toBe(false);
    expect('sprintId' in data).toBe(false);
    expect('entityId' in data).toBe(false);

    // Lock acquired + released for the project_identity scope only.
    expect(lockScopes).toContain('acquire:project_identity');
    expect(lockScopes).toContain('release:project_identity');
    expect(
      lockScopes.some((s) => s.includes('mission_active') || s.includes('sprint_status'))
    ).toBe(false);
  });

  it('is a NO-OP on a SOLO store (no collab_role) — no emit, no warnings, no fetch', async () => {
    createStore({ collab: false, name: 'My Project' });
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);
    expect(out.success).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('change-guard: suppresses a redundant emit when the recorded name equals the current name', async () => {
    createStore({
      name: 'My Project',
      extraSql: `INSERT INTO metadata (key, value) VALUES ('mutable_status:project_identity:project', '${JSON.stringify(
        { status: 'My Project', occurredAt: 1, originSeq: 1, authorUserId: null }
      ).replace(/'/g, "''")}');`,
    });
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);
    expect(out.success).toBe(true);
    expect(callOrder).not.toContain('push');
  });

  it('folds a superseded-conflict restore hint into result.warnings (resilient, local edit kept)', async () => {
    createStore({ name: 'My Project' });
    pushConflict = {
      id: 'conf-pid',
      fieldScope: 'project_identity',
      entityId: 'project',
      field: 'name',
      appliedValue: 'Their Name',
      appliedAuthorUserId: 'other',
      appliedOccurredAt: 9_999_999_999_999,
      supersededValue: 'My Project',
      supersededAuthorUserId: 'me',
      supersededOccurredAt: 1,
      detectedAt: '2026-06-02T11:00:00Z',
      resolved: false,
      youWereSuperseded: true,
    };
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);
    expect(out.success).toBe(true);
    expect(out.warnings?.some((w) => w.includes('conf-pid'))).toBe(true);
  });

  it('formatProjectIdentityUpdateForLLM renders folded-in collab warnings (#790)', () => {
    const formatted = formatProjectIdentityUpdateForLLM({
      success: true,
      data: {
        fieldsUpdated: ['project_name'],
        message: 'Updated 1 field(s) in project_identity.',
      } as unknown as Parameters<typeof formatProjectIdentityUpdateForLLM>[0]['data'],
      warnings: ['Your name edit was superseded (conflict conf-pid) — restore it.'],
    });
    expect(formatted).toContain('Warnings:');
    expect(formatted).toContain('conf-pid');
  });

  // ─── cmos_context dispatcher wiring ─────────────────────────────────────────────

  it('cmos_context(update project_identity project_name) on a collab store emits project_identity_updated', async () => {
    createStore({ name: 'Old Name' });
    const result = await cmosContext({
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'project_name', value: 'Renamed Project' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(callOrder.filter((c) => c === 'push')).toHaveLength(1);
    const data = pushedBodies[0].data as Record<string, unknown>;
    expect(pushedBodies[0].eventType).toBe('project_identity_updated');
    expect(data.name).toBe('Renamed Project');
  });

  it('cmos_context(update project_identity) NOT touching project_name emits nothing (guard)', async () => {
    createStore({ name: 'My Project' });
    const result = await cmosContext({
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'description', value: 'a new description' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(callOrder).not.toContain('push');
  });

  it('cmos_context(update project_identity project_name) on a SOLO store emits nothing, no fetch', async () => {
    createStore({ collab: false, name: 'Old Name' });
    const result = await cmosContext({
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'project_name', value: 'Renamed Project' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
