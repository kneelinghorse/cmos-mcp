// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves the real Jest teardown rejects manifest mutations in an isolated child process.
// ABOUTME: Relocates unchanged guard sources into a temporary tree; never touches this checkout's dist.

import { afterAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function runGuard(initial: string | null, final: string | null, removeGuard = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-manifest-guard-'));
  fixtures.push(dir);
  // Preserve the exact module layout so the production helper's normal __dirname resolves
  // dist beneath this temporary root. No env override can disable the parent run's guard.
  for (const source of [
    'tests/helpers/dist-manifest-fingerprint.ts',
    'tests/jest-global-teardown.ts',
  ]) {
    const destination = path.join(dir, source.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let content = fs.readFileSync(path.join(root, source), 'utf8');
    if (removeGuard && source.endsWith('jest-global-teardown.ts')) {
      // Mutation control: if teardown loses the fingerprint comparison, the positive-fire
      // cases below must fail. Only this temporary copy is changed.
      content = content.replace(
        'if (before !== undefined && distManifestFingerprint() !== before)',
        'if (false)'
      );
    }
    fs.writeFileSync(
      destination,
      ts.transpileModule(content, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      }).outputText
    );
  }
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir);
  const child = `
    const fs = require('fs');
    const path = require('path');
    const helper = require('./tests/helpers/dist-manifest-fingerprint.js');
    const teardown = require('./tests/jest-global-teardown.js').default;
    const initial = ${JSON.stringify(initial)};
    const final = ${JSON.stringify(final)};
    fs.mkdirSync(path.dirname(helper.DIST_MANIFEST_PATH), { recursive: true });
    if (initial !== null) fs.writeFileSync(helper.DIST_MANIFEST_PATH, initial);
    process.env[helper.DIST_MANIFEST_FINGERPRINT_ENV] = helper.distManifestFingerprint();
    globalThis.__CMOS_JEST_CONFIG_DIR__ = ${JSON.stringify(configDir)};
    if (final === null) fs.rmSync(helper.DIST_MANIFEST_PATH, { force: true });
    else fs.writeFileSync(helper.DIST_MANIFEST_PATH, final);
    teardown().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', child], {
    cwd: dir,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(fs.existsSync(configDir)).toBe(false);
  return { ...result, manifest: path.join(dir, 'dist/.build-manifest.json') };
}

describe('real dist manifest teardown guard', () => {
  it.each([
    ['unchanged bytes', '{"build":"original"}', '{"build":"original"}'],
    ['unchanged absence', null, null],
  ])('allows %s', (_reason, initial, final) => {
    expect(runGuard(initial, final).status).toBe(0);
  });

  it.each([
    ['changed bytes', '{"build":"original"}', '{"build":"rewritten"}'],
    ['a newly created manifest', null, '{"build":"new"}'],
    ['a deleted manifest', '{"build":"original"}', null],
  ])('makes the teardown process fail on %s', (_reason, initial, final) => {
    const result = runGuard(initial, final);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${result.manifest} changed during this test run`);
    expect(result.stderr).toContain('scripts/generate-build-manifest.js --dist <dir>');
  });

  it('loses the failure when the comparison is removed from the temporary copy', () => {
    // A missing manifest or a broken child could otherwise produce a vacuous nonzero result.
    expect(runGuard('original bytes', 'changed bytes', true).status).toBe(0);
  });
});
