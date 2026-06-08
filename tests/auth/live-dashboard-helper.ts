// ABOUTME: Shared helper for Sprint 58 m03 live-dashboard test blocks — gated on CMOS_LIVE_DASHBOARD=1.
// ABOUTME: describeLive skips the block by default so the standard `npm test` run stays hermetic and offline.

/**
 * Sprint 58 m03 — gating helper for live-dashboard integration tests.
 *
 * Default `npm test` is hermetic — no network, no credentials required.
 * When `CMOS_LIVE_DASHBOARD=1` is exported in the shell, `describeLive`
 * flips to a real `describe` block and the test hits the dashboard URL
 * configured via `CMOS_DASHBOARD_URL`.
 *
 * Live tests MUST NOT be wired into CI: the device-code leg requires a
 * human to approve the code in a browser, and the cleanup path revokes
 * real dashboard keys.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const LIVE_FLAG_ENV = 'CMOS_LIVE_DASHBOARD';
const BASE_URL_ENV = 'CMOS_DASHBOARD_URL';

export const isLiveDashboardEnabled = (): boolean => process.env[LIVE_FLAG_ENV] === '1';

/**
 * `describe` when `CMOS_LIVE_DASHBOARD=1`, otherwise `describe.skip` so the
 * default jest run stays offline. Skipped blocks print their title so it's
 * obvious why a suite didn't execute.
 */
export const describeLive: jest.Describe = isLiveDashboardEnabled() ? describe : describe.skip;

export interface LiveDashboardConfig {
  baseUrl: string;
  /** Tmpdir used for this live run's CredentialStore — never the real config dir. */
  tempConfigDir: string;
}

/**
 * Set up a fresh tmpdir for CMOS_CONFIG_DIR so the live run never mutates
 * `~/.config/cmos-mcp/credentials.json`. Throws a clear message when the
 * required env isn't configured so the test exit code points at setup, not
 * at a real contract drift.
 */
export async function setUpLiveConfig(prefix: string): Promise<LiveDashboardConfig> {
  const baseUrl = process.env[BASE_URL_ENV];
  if (!baseUrl) {
    throw new Error(
      `${BASE_URL_ENV} is required when ${LIVE_FLAG_ENV}=1 (e.g. https://cmos.aquex.ai)`
    );
  }

  const tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), `live-dashboard-${prefix}-`));
  return { baseUrl, tempConfigDir };
}

/** Best-effort tmpdir cleanup — swallow errors so a failed test still reports its own cause. */
export async function tearDownLiveConfig(config: LiveDashboardConfig): Promise<void> {
  try {
    await fs.rm(config.tempConfigDir, { recursive: true, force: true });
  } catch {
    // Non-fatal — tests may have open file handles during a failure.
  }
}
