// ABOUTME: Regression tests for the Sprint 70 m01 real-store isolation guard —
// ABOUTME: proves it refuses non-tmpdir DB opens under Jest without touching the file.

import * as fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isJestAllowedDbPath,
  assertJestDbPathIsolated,
  realpathOfLongestExistingPrefix,
  RealStoreGuardError,
  JEST_DB_PATH_ALLOWLIST,
} from '../../../src/tools/cmos/real-store-guard';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';

// The real dogfood store at the repo root — the exact path the guard must
// refuse to open under Jest (decision #754).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const REAL_STORE = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');

describe('real-store isolation guard (s70-m01)', () => {
  const savedWorkerId = process.env.JEST_WORKER_ID;

  afterEach(() => {
    if (savedWorkerId === undefined) {
      delete process.env.JEST_WORKER_ID;
    } else {
      process.env.JEST_WORKER_ID = savedWorkerId;
    }
  });

  describe('isJestAllowedDbPath (pure predicate, no DB open, no JEST gate)', () => {
    test('rejects the repo real dogfood store path', () => {
      expect(isJestAllowedDbPath(REAL_STORE)).toBe(false);
    });

    test('allows an existing path under os.tmpdir()', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-allow-'));
      try {
        expect(isJestAllowedDbPath(path.join(dir, 'cmos.sqlite'))).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('allows a not-yet-created tmpdir path without throwing ENOENT', () => {
      const p = path.join(os.tmpdir(), 'guard-missing-xyz', 'sub', 'cmos.sqlite');
      expect(isJestAllowedDbPath(p)).toBe(true);
    });

    test('canonicalizes BOTH dbPath and os.tmpdir() (macOS /tmp->/private/tmp symlink)', () => {
      // os.tmpdir() is itself a symlink on macOS. A path built from the RAW
      // tmpdir must be allowed — which only holds if the predicate realpaths the
      // tmpdir side too. If that realpath were dropped, this would false-reject
      // every tmpdir DB on macOS and break the whole suite. (decision #754)
      const rawTmp = os.tmpdir();
      const realTmp = fs.realpathSync(rawTmp);
      const dir = fs.mkdtempSync(path.join(rawTmp, 'guard-symlink-'));
      try {
        expect(isJestAllowedDbPath(path.join(dir, 'cmos.sqlite'))).toBe(true);
        if (rawTmp !== realTmp) {
          // Stronger assertion on platforms (macOS) where tmpdir is a symlink;
          // skipped on Linux CI where /tmp is not symlinked.
          expect(isJestAllowedDbPath(path.join(fs.realpathSync(dir), 'cmos.sqlite'))).toBe(true);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('allows :memory: and the anonymous on-disk-temp DB', () => {
      expect(isJestAllowedDbPath(':memory:')).toBe(true);
      expect(isJestAllowedDbPath('')).toBe(true);
    });

    test('honors an explicit allowlist entry covering the path', () => {
      expect(isJestAllowedDbPath(REAL_STORE, [REPO_ROOT])).toBe(true);
    });

    test('does not consult JEST_WORKER_ID (stays pure when the var is unset)', () => {
      delete process.env.JEST_WORKER_ID;
      expect(isJestAllowedDbPath(REAL_STORE)).toBe(false);
    });
  });

  describe('assertJestDbPathIsolated (JEST_WORKER_ID-gated guard)', () => {
    test('under a simulated worker id, throws on the real store path, naming it', () => {
      process.env.JEST_WORKER_ID = '1';
      expect(() => assertJestDbPathIsolated(REAL_STORE)).toThrow(/real-store-guard/);
      expect(() => assertJestDbPathIsolated(REAL_STORE)).toThrow(REAL_STORE);
    });

    test('throws a typed RealStoreGuardError so wrapping callers can re-throw it', () => {
      process.env.JEST_WORKER_ID = '1';
      expect(() => assertJestDbPathIsolated(REAL_STORE)).toThrow(RealStoreGuardError);
    });

    test('rejecting a non-tmpdir path does not create/open the DB file', () => {
      process.env.JEST_WORKER_ID = '1';
      // A phantom repo-relative path: if the guard opened it, better-sqlite3
      // would create the file. It must reject by string alone and leave the
      // filesystem untouched — proving "without opening it" (decision #754).
      const phantom = path.join(REPO_ROOT, 'cmos', 'db', `phantom-${process.pid}.sqlite`);
      expect(fs.existsSync(phantom)).toBe(false);
      expect(() => assertJestDbPathIsolated(phantom)).toThrow(/real-store-guard/);
      expect(fs.existsSync(phantom)).toBe(false);
    });

    test('under a simulated worker id, is a no-op for a tmpdir path', () => {
      process.env.JEST_WORKER_ID = '1';
      const p = path.join(os.tmpdir(), 'guard-ok-noop', 'cmos.sqlite');
      expect(() => assertJestDbPathIsolated(p)).not.toThrow();
    });

    test('is a strict no-op when JEST_WORKER_ID is unset (production path)', () => {
      delete process.env.JEST_WORKER_ID;
      expect(() => assertJestDbPathIsolated(REAL_STORE)).not.toThrow();
    });
  });

  describe('realpathOfLongestExistingPrefix', () => {
    test('canonicalizes the existing prefix and re-appends the missing tail', () => {
      const tail = path.join('nope-xyz', 'a', 'b.sqlite');
      const resolved = realpathOfLongestExistingPrefix(path.join(os.tmpdir(), tail));
      const tmpReal = fs.realpathSync(os.tmpdir());
      expect(resolved.startsWith(tmpReal + path.sep)).toBe(true);
      expect(resolved.endsWith(tail)).toBe(true);
    });
  });

  describe('allowlist hygiene', () => {
    test('the allowlist is empty by default (audited: no committed fixture DBs)', () => {
      expect(JEST_DB_PATH_ALLOWLIST).toEqual([]);
    });
  });

  describe('CmosDatabaseClient.create() fails loud on a real-store path (no masking)', () => {
    test('rejects with RealStoreGuardError instead of a DB_CONNECTION_FAILED result', async () => {
      process.env.JEST_WORKER_ID = '1';
      // Regression: create() wraps ensureConnection() in a try/catch that maps
      // errors to a DB_CONNECTION_FAILED result. The guard throw must NOT be
      // masked into a (success:false) result a test could tolerate — it must
      // propagate so a leak fails loud. (decision #754)
      await expect(CmosDatabaseClient.create({ dbPath: REAL_STORE })).rejects.toThrow(
        RealStoreGuardError
      );
      await expect(CmosDatabaseClient.create({ dbPath: REAL_STORE })).rejects.toThrow(
        /real-store-guard/
      );
    });

    test('opens a tmpdir store normally under Jest (guard is a no-op for isolated paths)', async () => {
      process.env.JEST_WORKER_ID = '1';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-create-ok-'));
      try {
        const result = await CmosDatabaseClient.create({ dbPath: path.join(dir, 'cmos.sqlite') });
        expect(result.success).toBe(true);
        if (result.success && result.data) {
          result.data.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
