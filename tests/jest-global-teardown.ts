// ABOUTME: Jest globalTeardown — removes the per-run CMOS_CONFIG_DIR tmpdir provisioned by globalSetup.
// ABOUTME: Ignores missing/EACCES errors so a corrupted tmpdir never fails CI.

import { promises as fs } from 'fs';

export default async function globalTeardown(): Promise<void> {
  const dir = (globalThis as unknown as { __CMOS_JEST_CONFIG_DIR__?: string })
    .__CMOS_JEST_CONFIG_DIR__;
  if (!dir) {
    return;
  }

  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Silent — cleanup is best-effort; tmpdir OS eventually reclaims it.
  }
}
