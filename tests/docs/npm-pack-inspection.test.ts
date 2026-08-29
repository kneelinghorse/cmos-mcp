// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves the real npm-pack fixture launches portably without shell-parsing archive paths.

import { npmPackInvocation, toPackagePath } from './npm-pack-inspection';

describe('npm pack inspection command', () => {
  it('normalizes platform-relative paths to npm package paths', () => {
    expect(toPackagePath('cmos-seed\\docs\\README.md', '\\')).toBe('cmos-seed/docs/README.md');
  });

  it('runs npm through its JavaScript CLI when npm exposes that path', () => {
    expect(
      npmPackInvocation(
        'C:\\Temp Files\\packed output',
        'win32',
        { npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' },
        'C:\\Program Files\\nodejs\\node.exe'
      )
    ).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        'C:\\Temp Files\\packed output',
      ],
    });
  });

  it('uses cmd.exe for npm.cmd when no JavaScript CLI path is available on Windows', () => {
    expect(
      npmPackInvocation('C:\\Temp\\pack', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'npm.cmd',
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        'C:\\Temp\\pack',
      ],
    });
  });
});
