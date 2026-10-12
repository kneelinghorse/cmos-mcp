// ABOUTME: Jest globalSetup — provisions the per-run root used for test-file Reasonbook config dirs.
// ABOUTME: Test-file isolation is completed in jest-setup-after-env.ts; teardown removes the root.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from '../src/intelligence/legacy-compat';
import { captureRunControls, restoreRunControls, RUN_ENV_KEY } from './helpers/test-env-isolation';

import {
  DIST_MANIFEST_FINGERPRINT_ENV,
  distManifestFingerprint,
} from './helpers/dist-manifest-fingerprint';

const RBOOK_CONFIG_DIR_ENV = 'RBOOK_CONFIG_DIR';

/**
 * s86-m01 — an immutable copy of the run's canonical RBOOK_CONFIG_DIR, used by the
 * root re-assert guard in tests/jest-setup-after-env.ts.
 *
 * It needs its own name because the guard cannot recover the canonical value from
 * any other source. Capturing `process.env.RBOOK_CONFIG_DIR` at module load of
 * jest-setup-after-env.ts does not work: setupFilesAfterEnv is re-required per
 * test FILE while `process` is shared across files under --runInBand, so once any
 * file leaves the var deleted, every later file captures `undefined` and the guard
 * re-asserts nothing. `globalThis.__RBOOK_JEST_CONFIG_DIR__` below is not reachable
 * either — globalSetup/globalTeardown run in the main process and each test file
 * gets a fresh `global`. A second env var survives both. No test touches this name,
 * so nothing can clobber it the way RBOOK_CONFIG_DIR itself gets clobbered.
 */
const JEST_RECORD_CONFIG_DIR_CANONICAL = 'JEST_RECORD_CONFIG_DIR_CANONICAL';

/**
 * s86-m01 — default the checkpoint-sync kill switch to 'off' for test runs, but
 * ONLY when the operator has not set it.
 *
 * That conditional is what keeps the mission's own evidence falsifiable:
 * `RBOOK_CHECKPOINT_SYNC=on npm test -- --runInBand` restores real behaviour for a
 * whole run, so a green run with zero "Cannot log after tests are done" can be
 * attributed to the actual fix (stderr writes + the deterministic drain) rather
 * than to the switch having suppressed the code path entirely.
 */
export default async function globalSetup(): Promise<void> {
  // s92-m10: fingerprint the real build manifest; jest-global-teardown.ts fails the run if any
  // test rewrote it (the server reads it to report a stale build).
  process.env[DIST_MANIFEST_FINGERPRINT_ENV] = distManifestFingerprint();

  const runControls = captureRunControls(process.env);
  process.env[RUN_ENV_KEY] = JSON.stringify(runControls);
  restoreRunControls(process.env, runControls);

  const explicitConfigDir = getSetting('CONFIG_DIR');
  if (explicitConfigDir) {
    // An operator-supplied dir wins, but the guard still needs to know what
    // "correct" means for this run — so stamp the canonical copy on this branch too.
    process.env[JEST_RECORD_CONFIG_DIR_CANONICAL] = explicitConfigDir;
    return;
  }

  const prefix = path.join(os.tmpdir(), 'rbook-jest-');
  const dir = await fs.mkdtemp(prefix);

  process.env[RBOOK_CONFIG_DIR_ENV] = dir;
  process.env[JEST_RECORD_CONFIG_DIR_CANONICAL] = dir;
  (globalThis as unknown as { __RBOOK_JEST_CONFIG_DIR__?: string }).__RBOOK_JEST_CONFIG_DIR__ = dir;
}
