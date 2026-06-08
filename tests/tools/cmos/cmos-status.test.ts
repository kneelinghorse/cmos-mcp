// ABOUTME: Tests for cmos_status — Sprint 62 m06 at-a-glance status payload.
// ABOUTME: Verifies the 5 frozen fields, cross-side parity with onboard.authState.authTier, and graceful local-only fallback.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cmosStatus,
  cmosStatusToolDefinition,
  formatStatusForLLM,
} from '../../../src/tools/cmos/cmos-status';
import {
  DashboardClient,
  CMOS_DASHBOARD_URL_ENV,
  CMOS_DASHBOARD_API_KEY_ENV,
  CMOS_DASHBOARD_USER_ENV,
  CMOS_DASHBOARD_PASSWORD_ENV,
  DEFAULT_DASHBOARD_URL,
} from '../../../src/tools/cmos/dashboard-client';
import type { SyncStatusResult } from '../../../src/tools/cmos/dashboard-client';
import { CredentialStore } from '../../../src/intelligence/credential-store';

describe('cmosStatus', () => {
  let tempDir: string;
  let configDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-status-test-'));
    const cmosDbDir = path.join(tempDir, 'cmos', 'db');
    fs.mkdirSync(cmosDbDir, { recursive: true });
    const dbPath = path.join(cmosDbDir, 'cmos.sqlite');

    // Minimal schema — cmos_status reads contexts (project_identity row) only.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT,
        content TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    db.close();

    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-status-creds-'));

    savedEnv = {
      [CMOS_DASHBOARD_URL_ENV]: process.env[CMOS_DASHBOARD_URL_ENV],
      [CMOS_DASHBOARD_API_KEY_ENV]: process.env[CMOS_DASHBOARD_API_KEY_ENV],
      [CMOS_DASHBOARD_USER_ENV]: process.env[CMOS_DASHBOARD_USER_ENV],
      [CMOS_DASHBOARD_PASSWORD_ENV]: process.env[CMOS_DASHBOARD_PASSWORD_ENV],
      CMOS_CONFIG_DIR: process.env.CMOS_CONFIG_DIR,
    };

    delete process.env[CMOS_DASHBOARD_URL_ENV];
    delete process.env[CMOS_DASHBOARD_API_KEY_ENV];
    delete process.env[CMOS_DASHBOARD_USER_ENV];
    delete process.env[CMOS_DASHBOARD_PASSWORD_ENV];
    process.env.CMOS_CONFIG_DIR = configDir;

    // CredentialStore is a process-scoped singleton — reset it per test so
    // a key written in one test doesn't bleed into the next via cache.
    CredentialStore.resetInstance();

    // Stub the dashboard round-trip. The 3 auth_tier tests below are the only
    // ones that supply credentials, so they are the only ones whose
    // cmosStatus() → resolveLastSyncAt() reaches fromEnvForProject() success
    // and calls getSyncStatus() — an otherwise LIVE, unmocked fetch() to
    // production cmos.aquex.ai. The client's 10s AbortController timeout
    // exceeds jest's 5s default testTimeout, so under full-suite parallel
    // contention jest kills the test before it returns (CI runs --runInBand,
    // so it only flaked locally). Mocking at the prototype keeps every test in
    // this file off the network. The stub mirrors the honest null-path
    // (dashboard reachable, nothing synced for this throwaway tmpdir project →
    // lastSyncAt null), so last_sync_at stays null exactly as it was — the
    // assertions stay honest, only the timing variable is removed (learning #232).
    const emptySyncStatus: SyncStatusResult = {
      tables: [],
      totalMirrorRows: 0,
      totalSyncLogEntries: 0,
      unprocessedSyncLogEntries: 0,
      failedSyncLogEntries: 0,
      lastSyncAt: null,
      oldestUnprocessedAt: null,
      projectCount: 0,
    };
    jest
      .spyOn(DashboardClient.prototype, 'getSyncStatus')
      .mockResolvedValue({ success: true, data: emptySyncStatus });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    CredentialStore.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ─── Tool definition shape ──────────────────────────────────────────────

  it('tool definition exposes name=cmos_status with no required params', () => {
    expect(cmosStatusToolDefinition.name).toBe('cmos_status');
    const schema = cmosStatusToolDefinition.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    // The only optional input is projectRoot — no free-text fields, so the
    // Sprint 60 m02 sanitizer wiring is N/A for this tool.
    expect(Object.keys(schema.properties)).toEqual(['projectRoot']);
  });

  // ─── Local-only mode ────────────────────────────────────────────────────

  it('local-only mode: returns the 5 frozen fields with null timestamps and authTier=none', async () => {
    const result = await cmosStatus({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // The 5 frozen fields per dashboard team msg 416315a7 — exact key set.
    expect(Object.keys(result.data!).sort()).toEqual([
      'auth_tier',
      'cmos_address',
      'dashboard_url',
      'last_delivery_observed_at',
      'last_sync_at',
    ]);

    expect(result.data!.cmos_address).toBe('local-only');
    expect(result.data!.dashboard_url).toBe(DEFAULT_DASHBOARD_URL);
    expect(result.data!.auth_tier).toBe('none');
    expect(result.data!.last_sync_at).toBeNull();
    expect(result.data!.last_delivery_observed_at).toBeNull();
  });

  // ─── cmos_address normalization ─────────────────────────────────────────

  it('returns the canonical cmos_address when project_identity has one set', async () => {
    // Seed project_identity with a canonical address.
    const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
    const db = new Database(dbPath);
    const identity = {
      project_id: 'p1',
      project_name: 'Test',
      cmos_address: 'cmos://derek/test-project',
      platform: 'aquex.ai',
      domain: '',
      project_type: 'build',
      tier: 'build',
      status: 'active_development',
      description: '',
      objectives: [],
      related_projects: [],
      foundational_docs: [],
      tracelab_refs: [],
      type_fields: {},
      identity_contract_version: 'v1',
      created_at: '',
      updated_at: '',
    };
    db.prepare(
      "INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', '', ?, ?)"
    ).run(JSON.stringify(identity), new Date().toISOString());
    db.close();

    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.cmos_address).toBe('cmos://derek/test-project');
  });

  it('normalizes a cmos://unknown/* address to local-only', async () => {
    const dbPath = path.join(tempDir, 'cmos', 'db', 'cmos.sqlite');
    const db = new Database(dbPath);
    const identity = {
      project_id: 'p1',
      project_name: 'Test',
      cmos_address: 'cmos://unknown/test-stale',
      platform: 'aquex.ai',
      domain: '',
      project_type: 'build',
      tier: 'build',
      status: 'active_development',
      description: '',
      objectives: [],
      related_projects: [],
      foundational_docs: [],
      tracelab_refs: [],
      type_fields: {},
      identity_contract_version: 'v1',
      created_at: '',
      updated_at: '',
    };
    db.prepare(
      "INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', '', ?, ?)"
    ).run(JSON.stringify(identity), new Date().toISOString());
    db.close();

    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.data?.cmos_address).toBe('local-only');
  });

  // ─── dashboard_url precedence ───────────────────────────────────────────

  it('dashboard_url respects an explicit CMOS_DASHBOARD_URL env override', async () => {
    process.env[CMOS_DASHBOARD_URL_ENV] = 'https://staging.cmos.aquex.ai';
    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.data?.dashboard_url).toBe('https://staging.cmos.aquex.ai');
  });

  it('dashboard_url falls back to baked default when env is empty string (IDE-spawn trap)', async () => {
    process.env[CMOS_DASHBOARD_URL_ENV] = '';
    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.data?.dashboard_url).toBe(DEFAULT_DASHBOARD_URL);
  });

  // ─── auth_tier parity (mirrors onboard.authState.authTier) ──────────────

  it('auth_tier=device-code when a user-scoped key is in the credential store', async () => {
    const store = await CredentialStore.create({ configDir });
    await store.upsertUserScopedKey('test-key-id', {
      key: 'cmk_test',
      label: 'test',
      issuedAt: new Date().toISOString(),
      lastUsedAt: '',
    });
    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.data?.auth_tier).toBe('device-code');
  });

  it('auth_tier=legacy-env when CMOS_DASHBOARD_API_KEY is set and store is empty', async () => {
    process.env[CMOS_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';
    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.data?.auth_tier).toBe('legacy-env');
  });

  it('auth_tier=password-fallback when only USER+PASSWORD env are set', async () => {
    process.env[CMOS_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[CMOS_DASHBOARD_PASSWORD_ENV] = 'pwd';
    const result = await cmosStatus({ projectRoot: tempDir });
    expect(result.data?.auth_tier).toBe('password-fallback');
  });

  // ─── formatStatusForLLM ─────────────────────────────────────────────────

  it('formatStatusForLLM renders all 5 fields and a sign-up nudge in local-only mode', async () => {
    const result = await cmosStatus({ projectRoot: tempDir });
    const formatted = formatStatusForLLM(result);
    expect(formatted).toContain('cmos_address:');
    expect(formatted).toContain('dashboard_url:');
    expect(formatted).toContain('auth_tier:');
    expect(formatted).toContain('last_sync_at:');
    expect(formatted).toContain('last_delivery_observed_at:');
    expect(formatted).toContain('https://cmos.aquex.ai');
  });
});
