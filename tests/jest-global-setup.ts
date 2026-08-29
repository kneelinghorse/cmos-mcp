// ABOUTME: Jest globalSetup — provisions the per-run root used for test-file CMOS config dirs.
// ABOUTME: Test-file isolation is completed in jest-setup-after-env.ts; teardown removes the root.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const CMOS_CONFIG_DIR_ENV = 'CMOS_CONFIG_DIR';

/**
 * s86-m01 — an immutable copy of the run's canonical CMOS_CONFIG_DIR, used by the
 * root re-assert guard in tests/jest-setup-after-env.ts.
 *
 * It needs its own name because the guard cannot recover the canonical value from
 * any other source. Capturing `process.env.CMOS_CONFIG_DIR` at module load of
 * jest-setup-after-env.ts does not work: setupFilesAfterEnv is re-required per
 * test FILE while `process` is shared across files under --runInBand, so once any
 * file leaves the var deleted, every later file captures `undefined` and the guard
 * re-asserts nothing. `globalThis.__CMOS_JEST_CONFIG_DIR__` below is not reachable
 * either — globalSetup/globalTeardown run in the main process and each test file
 * gets a fresh `global`. A second env var survives both. No test touches this name,
 * so nothing can clobber it the way CMOS_CONFIG_DIR itself gets clobbered.
 */
const CMOS_JEST_CONFIG_DIR_CANONICAL = 'CMOS_JEST_CONFIG_DIR_CANONICAL';

/**
 * s86-m01 — default the checkpoint-sync kill switch to 'off' for test runs, but
 * ONLY when the operator has not set it.
 *
 * That conditional is what keeps the mission's own evidence falsifiable:
 * `CMOS_CHECKPOINT_SYNC=on npm test -- --runInBand` restores real behaviour for a
 * whole run, so a green run with zero "Cannot log after tests are done" can be
 * attributed to the actual fix (stderr writes + the deterministic drain) rather
 * than to the switch having suppressed the code path entirely.
 */
const CMOS_CHECKPOINT_SYNC_ENV = 'CMOS_CHECKPOINT_SYNC';

export default async function globalSetup(): Promise<void> {
  if (process.env[CMOS_CHECKPOINT_SYNC_ENV] === undefined) {
    process.env[CMOS_CHECKPOINT_SYNC_ENV] = 'off';
  }

  if (process.env[CMOS_CONFIG_DIR_ENV]) {
    // An operator-supplied dir wins, but the guard still needs to know what
    // "correct" means for this run — so stamp the canonical copy on this branch too.
    process.env[CMOS_JEST_CONFIG_DIR_CANONICAL] = process.env[CMOS_CONFIG_DIR_ENV];
    return;
  }

  const prefix = path.join(os.tmpdir(), 'cmos-mcp-jest-');
  const dir = await fs.mkdtemp(prefix);

  process.env[CMOS_CONFIG_DIR_ENV] = dir;
  process.env[CMOS_JEST_CONFIG_DIR_CANONICAL] = dir;
  (globalThis as unknown as { __CMOS_JEST_CONFIG_DIR__?: string }).__CMOS_JEST_CONFIG_DIR__ = dir;
}
