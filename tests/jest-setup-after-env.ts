// ABOUTME: Per-worker test isolation — strips real dashboard credentials before each
// ABOUTME: test so fire-and-forget checkpoint syncs never hit the live dashboard or log late.

import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect } from '@jest/globals';
import {
  captureRunControls,
  cleanBeforeTest,
  clearProductSettings,
  restoreRunControls,
  RUN_ENV_KEY,
  type RunControls,
} from './helpers/test-env-isolation';

// Capture happened before any test/module imports, so .env cannot silently opt a run into live mode.
const runControls: RunControls = process.env[RUN_ENV_KEY]
  ? JSON.parse(process.env[RUN_ENV_KEY]!)
  : captureRunControls(process.env);
clearProductSettings(process.env);

const runConfigRoot = process.env.JEST_RECORD_CONFIG_DIR_CANONICAL;
const testPath = expect.getState().testPath ?? `unknown-test-${process.env.JEST_WORKER_ID ?? '1'}`;
const testPathKey = createHash('sha256').update(testPath).digest('hex').slice(0, 16);
const testFileConfigDir = runConfigRoot
  ? path.join(runConfigRoot, `worker-${process.env.JEST_WORKER_ID ?? '1'}`, testPathKey)
  : undefined;
if (testFileConfigDir) {
  mkdirSync(testFileConfigDir, { recursive: true });
}
restoreRunControls(process.env, runControls, testFileConfigDir);

/**
 * Sprint 70 m01 (decision #754c): the repo `.env` carries the developer's real
 * dashboard credentials, and src/index's env-loader copies them into
 * `process.env` on import — it only fills *absent* keys, so neither globalSetup
 * nor setupFiles can pre-empt it (they run before the in-worker import). With
 * those creds present, `triggerCheckpointBackfill` (fired-and-forgotten from
 * rbook_session(complete) and rbook_sprint(complete) — s86-m01 correction: those
 * are the ONLY two call sites; rbook_agent_onboard does NOT trigger it, and
 * `grep -rn triggerCheckpointBackfill src/` returns exactly 5 lines — the
 * declaration, two imports and those two calls) runs a REAL sync against the
 * live dashboard and emits its `[CHECKPOINT] File sync` log AFTER the triggering
 * test has torn down — surfacing as a `--runInBand`-deterministic "Cannot log
 * after tests are done" failure (and, worse, syncing throwaway tmpdir fixtures
 * to production).
 *
 * Stripping the creds in a global `beforeEach` (which runs AFTER each worker's
 * env-loader import, and BEFORE any test file's own `beforeEach` / inline
 * assignment) routes that fire-and-forget to its credentials-only early-return
 * before it spawns the async sync. Tests that genuinely exercise dashboard auth
 * set these vars themselves (their `beforeEach` runs after this one, or they
 * assign inline in the test body) and are unaffected — the audit in s70 m01
 * confirmed none set them at module scope or in `beforeAll`. Live-dashboard
 * runs (RBOOK_LIVE_DASHBOARD=1) authenticate via the device-code flow and a
 * tmpdir credential store, not these vars, but we leave their env untouched to
 * be safe.
 */
beforeEach(() => {
  cleanBeforeTest(process.env, runControls);
});

/**
 * s86-m01/s88-m08 — re-assert this test file's isolated RBOOK_CONFIG_DIR after every test.
 *
 * Twelve sites across eleven files delete this var deliberately (each restoring it
 * from a describe-scoped snapshot, or inline in a try/finally), and until this
 * mission one of them — the afterEach in tests/tools/rbook/rbook-agent-onboard.test.ts
 * — deleted it without ever restoring it. Once it is gone, both CredentialStore and
 * ProjectGraphRegistry fall back to the developer's real `~/.config/rbook`, so
 * the suite starts writing the machine's live registry. That file has been fixed;
 * this hook is the backstop that keeps the next one from silently re-opening it.
 *
 * RE-ASSERT, NEVER THROW. Throwing would turn a single bad afterEach into ~178 red
 * suites and would collide head-on with the files that mutate this var on purpose.
 * Jest runs afterEach innermost-first, so each file's own restore already ran by
 * the time this fires — for well-behaved files this hook is a no-op that writes
 * back the value that is already there.
 *
 * The per-run root comes from JEST_RECORD_CONFIG_DIR_CANONICAL, stamped by globalSetup. A stable
 * hash of Jest's current testPath gives every file its own graph/credential store; the worker id
 * prevents two parallel workers from ever sharing a SQLite file. This matters now that identity
 * collisions fail loud: unrelated fixtures in unrelated suites must not form one portfolio.
 */
afterEach(() => {
  restoreRunControls(process.env, runControls, testFileConfigDir);
});
