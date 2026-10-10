// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Run the portable rules preservation gate's self-test and destructive mutation controls.
// ABOUTME: All fixture stores and git repositories live in temporary directories.
import { execFileSync } from 'child_process';
import * as path from 'path';

it('rejects lost, changed and reordered rules while preserving project content in legacy files', () => {
  expect(() =>
    execFileSync(
      'python3',
      ['-B', path.resolve(__dirname, '../../scripts/rules-preservation.py'), 'self-test'],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        stdio: 'pipe',
      }
    )
  ).not.toThrow();
});
