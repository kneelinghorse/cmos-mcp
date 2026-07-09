// ABOUTME: Jest globalSetup — isolates every test-worker's project-graph registry
// ABOUTME: under a per-run tmpdir via CMOS_CONFIG_DIR so tests never write to ~/.config/cmos-mcp.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const CMOS_CONFIG_DIR_ENV = 'CMOS_CONFIG_DIR';

export default async function globalSetup(): Promise<void> {
  if (process.env[CMOS_CONFIG_DIR_ENV]) {
    return;
  }

  const prefix = path.join(os.tmpdir(), 'cmos-mcp-jest-');
  const dir = await fs.mkdtemp(prefix);

  process.env[CMOS_CONFIG_DIR_ENV] = dir;
  (globalThis as unknown as { __CMOS_JEST_CONFIG_DIR__?: string }).__CMOS_JEST_CONFIG_DIR__ = dir;
}
