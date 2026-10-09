// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Deadline expiration during lazy verb loading prevents that verb from starting side effects.
// ABOUTME: A controlled module import advances the clock, exposing effects that an output-only guard misses.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';

let mockNow = 0;
const mockVerbRun = jest.fn(async () => null);
jest.mock('../../src/cli/pre-compact', () => {
  mockNow += 1001;
  return { run: mockVerbRun };
});

it('does not run a verb whose lazy import consumed the remaining deadline', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-lazy-deadline-'));
  mockNow = Date.now();
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  const output: string[] = [];
  try {
    expect(
      await runCli(['hook', 'pre-compact'], {
        env: {
          CMOS_CONFIG_DIR: path.join(tmp, 'config'),
          CMOS_AMBIENT: 'on',
          CLAUDE_PROJECT_DIR: '',
          CLAUDE_PID: '',
        },
        cwd: tmp,
        startedAtMs: mockNow,
        readStdin: async () => JSON.stringify({ session_id: 'late-import', cwd: tmp }),
        stdout: (value) => {
          output.push(value);
        },
        stderr: () => undefined,
      })
    ).toBe(0);
    expect(output).toEqual([]);
    expect(mockVerbRun.mock.calls.length).toBe(0);
    expect(
      fs.readFileSync(path.join(tmp, 'config', 'runtime', 'fail-open.jsonl'), 'utf8')
    ).toContain('"cause":"deadline"');
  } finally {
    clock.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
