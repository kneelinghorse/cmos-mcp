// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives the real shim and detached worker against an adjacent local npm double.
// ABOUTME: Proves the production entrypoints publish native-ready installs without touching the network or dist.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copiedPlugin, fixture, packageCode, version } from './fixtures';

test('cold SessionStart detaches one worker, then the next session uses its fully marked install', async () => {
  const root = fixture();
  const data = path.join(root, 'data');
  const installRoot = path.join(
    data,
    `${version}-${process.platform}-${process.arch}-abi${process.versions.modules}`
  );
  try {
    const plugin = copiedPlugin(root);
    const localNode = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, localNode);
    fs.chmodSync(localNode, 0o755);
    const npmScript = path.join(root, 'npm-fixture.js');
    fs.writeFileSync(
      npmScript,
      `const fs=require('node:fs');const path=require('node:path');
      const prefix=process.argv[process.argv.indexOf('--prefix')+1];
      fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},'install'+String.fromCharCode(10));
      ${packageCode('prefix')}`
    );
    if (process.platform === 'win32')
      fs.writeFileSync(path.join(root, 'npm.cmd'), `@"${localNode}" "${npmScript}" %*\r\n`);
    else fs.symlinkSync(npmScript, path.join(root, 'npm'));
    const env = {
      ...process.env,
      PATH: '',
      CLAUDE_PLUGIN_DATA: data,
      CMOS_CONFIG_DIR: path.join(root, 'config'),
    };
    const invoke = () =>
      spawnSync(
        localNode,
        [
          path.join(plugin, 'hooks/run.mjs'),
          'hook',
          'session-start',
          '--hook-source',
          'cmos-plugin',
        ],
        { env, input: '{}', encoding: 'utf8', timeout: 5000 }
      );
    const first = invoke();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('CMOS is installing');
    const deadline = Date.now() + 10000;
    while (
      (!fs.existsSync(path.join(installRoot, '.cmos-ready.json')) ||
        fs.existsSync(installRoot + '.lock')) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(path.join(installRoot, '.cmos-ready.json'))).toBe(true);
    const second = invoke();
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).args).toEqual([
      'hook',
      'session-start',
      '--hook-source',
      'cmos-plugin',
    ]);
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    // These PIDs are read only from this test's own isolated worker files, never a process list.
    if (fs.existsSync(installRoot + '.lock')) {
      const owner = JSON.parse(fs.readFileSync(installRoot + '.lock', 'utf8'));
      try {
        process.kill(owner.pid, 'SIGKILL');
      } catch {
        /* Worker already exited. */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
