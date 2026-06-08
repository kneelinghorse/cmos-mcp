// ABOUTME: Real-store isolation guard — under Jest, refuses a WRITE-capable open of a
// ABOUTME: CMOS SQLite store outside os.tmpdir() so a test can't schema-mutate the real dogfood store.

import * as fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Thrown by {@link assertJestDbPathIsolated} when a non-isolated store open is
 * attempted under Jest. A dedicated class so callers that wrap DB-open in a
 * try/catch (e.g. CmosDatabaseClient.create()) can re-throw it instead of
 * masking it into a generic connection-failed result — the guard must FAIL LOUD.
 */
export class RealStoreGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealStoreGuardError';
  }
}

/**
 * Narrow allowlist of absolute path prefixes that may be opened under Jest even
 * though they live outside os.tmpdir().
 *
 * EMPTY by design (Sprint 70 m01, decision #754): tests/fixtures and
 * tests/test-data were audited and carry NO committed SQLite fixtures, so every
 * legitimate test DB already lands under os.tmpdir(). Add an entry ONLY with an
 * inline justification — and prefer copying the fixture to a tmpdir at setup
 * over allowlisting it.
 */
export const JEST_DB_PATH_ALLOWLIST: readonly string[] = [];

/**
 * Resolve symlinks on the longest existing prefix of `p`, then re-append the
 * not-yet-created tail.
 *
 * better-sqlite3 creates the DB file on open, so the candidate path frequently
 * does not exist yet — a bare `fs.realpathSync` would throw ENOENT. We still
 * canonicalize the existing prefix so macOS `/var`→`/private/var` (and
 * `/tmp`→`/private/tmp`) symlinks line up with a realpath'd `os.tmpdir()`,
 * which is the whole point of the comparison.
 */
export function realpathOfLongestExistingPrefix(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  // Bounded loop: dirname() strictly shortens the path until the FS root.
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return path.resolve(p);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True iff `candidate` is `ancestor` itself or sits beneath it. */
function isWithin(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(ancestor + path.sep);
}

/**
 * Pure predicate: may `dbPath` be opened under Jest? True iff it is an
 * in-memory/anonymous DB, lives under (realpath'd) os.tmpdir(), or matches the
 * allowlist.
 *
 * Does NOT consult `JEST_WORKER_ID` (that gate lives in
 * {@link assertJestDbPathIsolated}) and never opens the database — it only
 * resolves path strings, so it is safe to unit-test without a real DB.
 */
export function isJestAllowedDbPath(
  dbPath: string,
  allowlist: readonly string[] = JEST_DB_PATH_ALLOWLIST
): boolean {
  // In-memory and anonymous on-disk-temp DBs touch no real file.
  if (dbPath === ':memory:' || dbPath === '') {
    return true;
  }

  const dbReal = realpathOfLongestExistingPrefix(dbPath);
  // Canonicalize BOTH sides: os.tmpdir() is itself a symlink on macOS
  // (/var→/private/var, /tmp→/private/tmp). Comparing a realpath'd dbPath
  // against a RAW os.tmpdir() would false-reject every tmpdir DB and break the
  // whole suite — do not drop the realpath on this line. (decision #754)
  const tmpReal = realpathOfLongestExistingPrefix(os.tmpdir());
  if (isWithin(dbReal, tmpReal)) {
    return true;
  }

  for (const allowed of allowlist) {
    if (isWithin(dbReal, realpathOfLongestExistingPrefix(allowed))) {
      return true;
    }
  }
  return false;
}

/**
 * Guard invoked at WRITE-capable CMOS-store open sites — primarily
 * `CmosDatabaseClient.ensureConnection` (the chokepoint for every CMOS read/write,
 * immediately before `new Database()`), plus the raw better-sqlite3 fresh-store
 * open in `cmosProjectInit` whose `projectRoot` is caller-supplied. It is NOT a
 * global SQLite interceptor: read-only opens (snapshot/restore/sweep validation,
 * cross-store fan-out) cannot run a lazy schema migration, so they are out of
 * scope — the s69 leak was a WRITE that triggered a migration.
 *
 * Strict no-op outside Jest (`JEST_WORKER_ID` unset) — zero production behavior
 * or perf change. Under Jest it THROWS {@link RealStoreGuardError}, naming the
 * offending absolute path, when `dbPath` is not an allowed isolated path, so a
 * stray cwd-resolved open fails loud with a stack trace instead of silently
 * schema-mutating the real dogfood store. (Sprint 70 m01, decision #754)
 */
export function assertJestDbPathIsolated(
  dbPath: string,
  allowlist: readonly string[] = JEST_DB_PATH_ALLOWLIST
): void {
  if (!process.env.JEST_WORKER_ID) {
    return;
  }
  if (isJestAllowedDbPath(dbPath, allowlist)) {
    return;
  }
  throw new RealStoreGuardError(
    `[real-store-guard] Refusing to open a non-tmpdir SQLite database under Jest: ${dbPath}\n` +
      `  resolved: ${realpathOfLongestExistingPrefix(dbPath)}\n` +
      `  tmpdir:   ${realpathOfLongestExistingPrefix(os.tmpdir())}\n` +
      `This open would risk mutating the real dogfood store. Pin the test to an isolated ` +
      `tmpdir path (os.tmpdir()), or — for a read-only committed fixture — add it to ` +
      `JEST_DB_PATH_ALLOWLIST in src/tools/cmos/real-store-guard.ts with a justification. ` +
      `(s70-m01, decision #754)`
  );
}
