// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Package-manager discovery stays adjacent to Node instead of accepting an unrelated PATH npm.
// ABOUTME: Windows paths use explicit shell handling for npm and a shell-free JS entry for user arguments.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixture, moduleUrl, node } from './fixtures';

describe('plugin package-manager commands', () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('missing adjacent npm fails instead of silently falling back to PATH', () => {
    const result = node(
      `import {packageManager} from ${moduleUrl('package-manager.mjs')};try{packageManager('npm',[],{execPath:${JSON.stringify(path.join(root, 'node'))}})}catch(error){console.log(error.message)}`
    );
    expect(result.stdout).toContain('npm is missing beside Node');
  });

  test('Windows npm preserves a spaced prefix through environment arguments and npx avoids the shell', () => {
    fs.writeFileSync(path.join(root, 'npm.cmd'), 'fixture');
    fs.mkdirSync(path.join(root, 'node_modules/npm/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/npm/bin/npx-cli.js'), 'fixture');
    const prefix = path.join(root, 'space & percent% !');
    const result = node(
      `import {packageManager} from ${moduleUrl('package-manager.mjs')};const runtime={execPath:${JSON.stringify(path.join(root, 'node.exe'))},platform:'win32'};console.log(JSON.stringify({npm:packageManager('npm',['install','--prefix',${JSON.stringify(prefix)}],runtime),npx:packageManager('npx',['literal & argument'],runtime)}));`
    );
    expect(result.status).toBe(0);
    const { npm, npx } = JSON.parse(result.stdout);
    expect(npm.shell).toBe(true);
    expect(npm.env.CMOS_NPM_ARG_2).toBe(prefix);
    expect(npm.args[2]).toBe('"%CMOS_NPM_ARG_2%"');
    expect(npx.shell).toBe(false);
    expect(npx.args[1]).toBe('literal & argument');
  });
});
