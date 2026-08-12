// ABOUTME: Per-worker test isolation — strips real dashboard credentials before each
// ABOUTME: test so fire-and-forget checkpoint syncs never hit the live dashboard or log late.

import { afterEach, beforeEach } from '@jest/globals';

/**
 * Dashboard credential env vars that gate `triggerCheckpointBackfill`
 * (src/tools/cmos/checkpoint-backfill.ts). When any are set, that
 * fire-and-forget sync runs a REAL network call against the production
 * dashboard.
 */
const DASHBOARD_CRED_ENV_KEYS = [
  'CMOS_DASHBOARD_API_KEY',
  'CMOS_DASHBOARD_USER',
  'CMOS_DASHBOARD_PASSWORD',
] as const;

/**
 * Sprint 70 m01 (decision #754c): the repo `.env` carries the developer's real
 * dashboard credentials, and src/index's env-loader copies them into
 * `process.env` on import — it only fills *absent* keys, so neither globalSetup
 * nor setupFiles can pre-empt it (they run before the in-worker import). With
 * those creds present, `triggerCheckpointBackfill` (fired-and-forgotten from
 * cmos_session(complete) and cmos_sprint(complete) — s86-m01 correction: those
 * are the ONLY two call sites; cmos_agent_onboard does NOT trigger it, and
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
 * runs (CMOS_LIVE_DASHBOARD=1) authenticate via the device-code flow and a
 * tmpdir credential store, not these vars, but we leave their env untouched to
 * be safe.
 */
beforeEach(() => {
  if (process.env.CMOS_LIVE_DASHBOARD === '1') {
    return;
  }
  for (const key of DASHBOARD_CRED_ENV_KEYS) {
    delete process.env[key];
  }
});

/**
 * s86-m01 — re-assert the run's canonical CMOS_CONFIG_DIR after every test.
 *
 * Twelve sites across eleven files delete this var deliberately (each restoring it
 * from a describe-scoped snapshot, or inline in a try/finally), and until this
 * mission one of them — the afterEach in tests/tools/cmos/cmos-agent-onboard.test.ts
 * — deleted it without ever restoring it. Once it is gone, both CredentialStore and
 * ProjectGraphRegistry fall back to the developer's real `~/.config/cmos-mcp`, so
 * the suite starts writing the machine's live registry. That file has been fixed;
 * this hook is the backstop that keeps the next one from silently re-opening it.
 *
 * RE-ASSERT, NEVER THROW. Throwing would turn a single bad afterEach into ~178 red
 * suites and would collide head-on with the files that mutate this var on purpose.
 * Jest runs afterEach innermost-first, so each file's own restore already ran by
 * the time this fires — for well-behaved files this hook is a no-op that writes
 * back the value that is already there.
 *
 * The canonical value comes from CMOS_JEST_CONFIG_DIR_CANONICAL, stamped by
 * tests/jest-global-setup.ts (both branches). See that file for why neither a
 * module-load capture nor `globalThis` can supply it.
 */
afterEach(() => {
  const canonical = process.env.CMOS_JEST_CONFIG_DIR_CANONICAL;
  if (canonical) {
    process.env.CMOS_CONFIG_DIR = canonical;
  }
});
