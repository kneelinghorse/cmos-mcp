// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies desktop Node discovery without modifying the machine's shell or Homebrew installations.
// ABOUTME: Fixed fallback locations are redirected only in copied fixtures, while the shipped list stays pinned.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, hooks } from './fixtures';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

test.each(['path', 'login', 'fixed', 'absent'])('desktop Node discovery through %s', (source) => {
  const root = fixture();
  try {
    const launch = path.join(root, 'launch.sh');
    const node = path.join(root, 'node');
    const shell = path.join(root, 'shell');
    const fixed = path.join(root, 'fixed-node');
    const original = fs.readFileSync(path.join(hooks, 'launch.sh'), 'utf8');
    expect(original).toContain('/opt/homebrew/bin/node /usr/local/bin/node');
    fs.writeFileSync(
      launch,
      original.replace(
        '/opt/homebrew/bin/node /usr/local/bin/node',
        `${quote(fixed)} ${quote(path.join(root, 'absent-node'))}`
      )
    );
    fs.writeFileSync(
      path.join(root, 'run.mjs'),
      'console.log(JSON.stringify(process.argv.slice(2)));'
    );
    if (source === 'path' || source === 'login') fs.symlinkSync(process.execPath, node);
    if (source === 'login')
      fs.writeFileSync(shell, `#!/bin/sh\nprintf '%s\\n' ${quote(node)}\n`, { mode: 0o755 });
    if (source === 'fixed') fs.symlinkSync(process.execPath, fixed);
    const result = spawnSync('/bin/sh', [launch, 'serve', '--install-root', 'shared'], {
      env: { PATH: source === 'path' ? root : '', SHELL: source === 'login' ? shell : '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    if (source === 'absent') {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Node 20 or newer');
    } else {
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toEqual(['serve', '--install-root', 'shared']);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
