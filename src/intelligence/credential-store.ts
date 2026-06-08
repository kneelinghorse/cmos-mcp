// ABOUTME: CredentialStore — local persistence for dashboard credentials minted via the RFC 8628 device code flow.
// ABOUTME: Shape mirrors dashboard's user-scoped/project-scoped split so m02/m03 can key project keys to their spawning user key.

/**
 * Local credential store for cmos-dashboard API keys.
 *
 * Sprint 57 m01 — replaces Sprint 56 m04's `project-keys.json` paste flow.
 * The store is populated by the device code flow (user-scoped keys) and,
 * once m02 lands, by POST /api/projects/register response capture
 * (project-scoped keys bound to their parent user-scoped key via
 * `parentKeyId`).
 *
 * File: `<configDir>/credentials.json` where `configDir` defaults to
 * `~/.config/cmos-mcp` and can be overridden by the `CMOS_CONFIG_DIR`
 * environment variable (same override the ProjectRegistry uses for test
 * isolation).
 *
 * @module intelligence/credential-store
 */

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { pathExists, ensureDir, writeFileAtomic } from '../utils/fs';

/** Same CMOS_CONFIG_DIR env var used by ProjectRegistry — single source of truth. */
export const CMOS_CONFIG_DIR_ENV = 'CMOS_CONFIG_DIR';

/** Default on-disk filename. */
export const DEFAULT_CREDENTIALS_FILENAME = 'credentials.json';

/**
 * Source reported by fromEnvForProject so callers can log which resolution
 * path fired. Sprint 58 m02 expanded the enum to separate the legacy arms
 * from the device-code arms — the onboard `authTier` field and the startup
 * WARN machinery both key off this value.
 */
export type KeySource =
  | 'project-scoped'
  | 'user-scoped'
  | 'legacy-env'
  | 'password-fallback'
  | 'none';

/** A user-scoped key — minted per device via the device code flow. */
export interface UserScopedKeyRecord {
  /** Plaintext `cmk_...` key. */
  key: string;
  /** Dashboard-assigned label (e.g. `"device: cmos-mcp/1.x (darwin; host) @ 2026-..."`). */
  label: string;
  /** ISO timestamp when the dashboard issued the key. */
  issuedAt: string;
  /** ISO timestamp of the most recent send/init that used this key. */
  lastUsedAt: string;
}

/**
 * Grace-window slot holding a previously-active project key during a rotation
 * so in-flight requests using the old key don't 401 before `revokeAt`.
 * Sprint 57 m03 — populated by `cmos_auth(action=rotate)`; purged on read when
 * `revokeAt` has passed.
 */
export interface PendingRevokeRecord {
  key: string;
  keyId: string;
  /** ISO timestamp after which the key is hard-revoked on the dashboard. */
  revokeAt: string;
}

/** A project-scoped key — bound to `parentKeyId` on the dashboard side. */
export interface ProjectKeyRecord {
  /** Plaintext `cmk_...` key. */
  key: string;
  /** Dashboard-side `keyId` of this project-scoped key. */
  keyId: string;
  /** `keyId` of the user-scoped credential that spawned this project key. */
  parentKeyId: string;
  /** Dashboard-assigned label. */
  label: string;
  /** ISO timestamp when the dashboard issued the key. */
  issuedAt: string;
  /** ISO timestamp of the most recent send/init that used this key. */
  lastUsedAt: string;
  /** Optional grace-window slot for the prior key during rotation. */
  pendingRevoke?: PendingRevokeRecord;
}

/** Disk shape. Version gate lets later schema bumps migrate forward. */
export interface CredentialStoreFile {
  version: number;
  userScopedKeys: Record<string, UserScopedKeyRecord>;
  projectKeys: Record<string, ProjectKeyRecord>;
  updatedAt: string;
}

export interface CredentialStoreOptions {
  /** Override config directory (default: `CMOS_CONFIG_DIR` env var or `~/.config/cmos-mcp`). */
  configDir?: string;
  /** Override filename (default: `credentials.json`). */
  credentialsFilename?: string;
}

const CURRENT_VERSION = 1;

function emptyStore(): CredentialStoreFile {
  return {
    version: CURRENT_VERSION,
    userScopedKeys: {},
    projectKeys: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * CredentialStore — thin JSON-backed persistence with atomic writes and
 * 0600 file permissions. Singleton by default so callers share cache;
 * tests that need isolation can construct an explicit instance with a
 * temp `configDir`.
 */
export class CredentialStore {
  private static instance: CredentialStore | undefined;

  private readonly configDir: string;
  private readonly credentialsPath: string;
  private cache: CredentialStoreFile | null = null;
  /**
   * mtimeMs from the last read or write. When the on-disk file's mtime no
   * longer matches, the cache is treated as stale and re-read — protects
   * against another process (e.g. a script) writing to the same file while
   * the MCP server holds a long-lived cache. See sprint-65 decision #700.
   */
  private cacheMtimeMs: number | null = null;

  private constructor(options: CredentialStoreOptions = {}) {
    this.configDir =
      options.configDir ??
      process.env[CMOS_CONFIG_DIR_ENV] ??
      path.join(os.homedir(), '.config', 'cmos-mcp');
    const filename = options.credentialsFilename ?? DEFAULT_CREDENTIALS_FILENAME;
    this.credentialsPath = path.join(this.configDir, filename);
  }

  /** Singleton — one store per process by default. */
  static getInstance(options?: CredentialStoreOptions): CredentialStore {
    if (!CredentialStore.instance) {
      CredentialStore.instance = new CredentialStore(options);
    }
    return CredentialStore.instance;
  }

  /** Reset singleton (tests only). */
  static resetInstance(): void {
    CredentialStore.instance = undefined;
  }

  /** Async factory — ensures the config directory exists before any read/write. */
  static async create(options?: CredentialStoreOptions): Promise<CredentialStore> {
    const store = CredentialStore.getInstance(options);
    await ensureDir(store.configDir);
    return store;
  }

  /** Absolute path to the credentials file. */
  get path(): string {
    return this.credentialsPath;
  }

  /** Drop in-memory cache; next read re-reads from disk. */
  clearCache(): void {
    this.cache = null;
    this.cacheMtimeMs = null;
  }

  /**
   * Insert or replace a user-scoped key keyed by `keyId`.
   * Later device-code exchanges on the same device can overwrite prior rows.
   */
  async upsertUserScopedKey(keyId: string, record: UserScopedKeyRecord): Promise<void> {
    if (!keyId) {
      throw new Error('upsertUserScopedKey: keyId is required');
    }
    const store = await this.load();
    store.userScopedKeys[keyId] = record;
    await this.save(store);
  }

  /** Return a user-scoped key record by `keyId`, or `undefined` if absent. */
  async getUserScopedKey(keyId: string): Promise<UserScopedKeyRecord | undefined> {
    const store = await this.load();
    return store.userScopedKeys[keyId];
  }

  /**
   * Return all user-scoped keys. Keyed by `keyId`; values are records.
   * Used by `fromEnvForProject()` fallback + m03's `cmos_auth(action=list)`.
   */
  async listUserScopedKeys(): Promise<Record<string, UserScopedKeyRecord>> {
    const store = await this.load();
    return { ...store.userScopedKeys };
  }

  /**
   * Insert or replace a project-scoped key keyed by absolute `projectRoot`.
   * The caller supplies `parentKeyId` — the user-scoped keyId that authenticated
   * the register (or reissue) call, so m03's `cmos_auth(action=list)` can filter
   * "mine-only" keys by matching against the local `userScopedKeys` map.
   */
  async upsertProjectKey(projectRoot: string, record: ProjectKeyRecord): Promise<void> {
    if (!projectRoot) {
      throw new Error('upsertProjectKey: projectRoot is required');
    }
    const store = await this.load();
    store.projectKeys[path.resolve(projectRoot)] = record;
    await this.save(store);
  }

  /**
   * Return the project-scoped key for a project root, or `undefined`.
   * Project roots are normalized via `path.resolve` before lookup so
   * callers don't have to worry about trailing slashes or cwd-relative paths.
   */
  async getProjectKey(projectRoot: string): Promise<ProjectKeyRecord | undefined> {
    if (!projectRoot) return undefined;
    const store = await this.load();
    return store.projectKeys[path.resolve(projectRoot)];
  }

  /**
   * Return all project-scoped keys keyed by absolute `projectRoot`.
   * Used by m03's `cmos_auth(action=list)` and by the m02 startup recovery
   * hook to detect "registered in dashboard but missing locally" projects.
   */
  async listProjectKeys(): Promise<Record<string, ProjectKeyRecord>> {
    const store = await this.load();
    return { ...store.projectKeys };
  }

  /**
   * Remove a user-scoped key by `keyId`. No-op when the key isn't present.
   * Sprint 57 m03 — used by `cmos_auth(action=revoke)` for user-scoped keys.
   */
  async removeUserScopedKey(keyId: string): Promise<void> {
    if (!keyId) return;
    const store = await this.load();
    if (store.userScopedKeys[keyId]) {
      delete store.userScopedKeys[keyId];
      await this.save(store);
    }
  }

  /**
   * Remove a project-scoped key by `projectRoot`. No-op when the key isn't
   * present. Sprint 57 m03 — used by `cmos_auth(action=revoke)`.
   */
  async removeProjectKey(projectRoot: string): Promise<void> {
    if (!projectRoot) return;
    const store = await this.load();
    const resolved = path.resolve(projectRoot);
    if (store.projectKeys[resolved]) {
      delete store.projectKeys[resolved];
      await this.save(store);
    }
  }

  /**
   * Swap the project key at `projectRoot`, keeping the outgoing key in the
   * new record's `pendingRevoke` slot so in-flight requests survive the
   * `graceSeconds` window before dashboard revokes the old key.
   *
   * Sprint 57 m03 — called atomically from `cmos_auth(action=rotate)` so
   * readers never observe a split (old gone, new not yet written) state.
   */
  async swapProjectKey(
    projectRoot: string,
    next: ProjectKeyRecord,
    pendingRevoke: PendingRevokeRecord
  ): Promise<void> {
    if (!projectRoot) {
      throw new Error('swapProjectKey: projectRoot is required');
    }
    const store = await this.load();
    store.projectKeys[path.resolve(projectRoot)] = { ...next, pendingRevoke };
    await this.save(store);
  }

  /**
   * Drop a `pendingRevoke` slot once `revokeAt` has passed. Caller supplies
   * the decision (usually after the dashboard has revoked the old key).
   */
  async clearPendingRevoke(projectRoot: string): Promise<void> {
    if (!projectRoot) return;
    const store = await this.load();
    const resolved = path.resolve(projectRoot);
    const existing = store.projectKeys[resolved];
    if (existing && existing.pendingRevoke) {
      const { pendingRevoke: _drop, ...rest } = existing;
      void _drop;
      store.projectKeys[resolved] = rest;
      await this.save(store);
    }
  }

  private async load(): Promise<CredentialStoreFile> {
    if (this.cache && (await this.isCacheFresh())) {
      return this.cache;
    }

    // Cache miss or stale — re-read from disk so a concurrent writer's changes surface.
    this.cache = null;
    this.cacheMtimeMs = null;

    try {
      const exists = await pathExists(this.credentialsPath);
      if (!exists) {
        this.cache = emptyStore();
        return this.cache;
      }
      const raw = await fs.readFile(this.credentialsPath, 'utf-8');
      const stat = await fs.stat(this.credentialsPath);
      const parsed = JSON.parse(raw) as Partial<CredentialStoreFile>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.version !== 'number' ||
        !parsed.userScopedKeys ||
        !parsed.projectKeys
      ) {
        this.cache = emptyStore();
        this.cacheMtimeMs = stat.mtimeMs;
        return this.cache;
      }
      this.cache = {
        version: parsed.version,
        userScopedKeys: parsed.userScopedKeys as Record<string, UserScopedKeyRecord>,
        projectKeys: parsed.projectKeys as Record<string, ProjectKeyRecord>,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
      this.cacheMtimeMs = stat.mtimeMs;
      return this.cache;
    } catch {
      this.cache = emptyStore();
      this.cacheMtimeMs = null;
      return this.cache;
    }
  }

  private async isCacheFresh(): Promise<boolean> {
    // No cached mtime means the cache was built from a missing or unreadable
    // file — always re-check so a later-appearing file is picked up.
    if (this.cacheMtimeMs === null) return false;
    try {
      const stat = await fs.stat(this.credentialsPath);
      return stat.mtimeMs === this.cacheMtimeMs;
    } catch {
      return false;
    }
  }

  private async save(store: CredentialStoreFile): Promise<void> {
    store.updatedAt = new Date().toISOString();
    this.cache = store;
    await ensureDir(this.configDir);
    const content = JSON.stringify(store, null, 2);
    await writeFileAtomic(this.credentialsPath, content, { mode: 0o600 });
    // Capture post-write mtime so our own write doesn't fail the freshness check.
    try {
      const stat = await fs.stat(this.credentialsPath);
      this.cacheMtimeMs = stat.mtimeMs;
    } catch {
      this.cacheMtimeMs = null;
    }
  }
}
