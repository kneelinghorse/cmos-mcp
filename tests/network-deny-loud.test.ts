// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m10 — the network deny fails a test that reached for the network even when the code
// ABOUTME: swallowed the error, proven by running a probe file in a nested jest with the deny installed.

import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('s92-m10 — an unapproved outbound request fails its test loudly', () => {
  it('fails a test whose code swallowed the blocked connection, naming the origin', () => {
    const config = {
      rootDir: REPO_ROOT,
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/tests/fixtures/network-deny-probe'],
      testMatch: ['**/*.probe.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/jest-setup-network-deny.ts'],
    };
    const run = spawnSync(
      process.execPath,
      [require.resolve('jest/bin/jest'), '--config', JSON.stringify(config), '--coverage=false'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, CMOS_LIVE_DASHBOARD: '' } }
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status).not.toBe(0);
    expect(output).toContain(
      'This test attempted 1 outbound network connection(s) the suite does not allow: example.com:80'
    );
  }, 120_000);
});
