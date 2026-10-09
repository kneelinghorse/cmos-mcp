// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises duplicate adapter suppression before telemetry or hook side effects at the CLI boundary.
// ABOUTME: Real runtime receipts distinguish successful turn delivery from failures and repeated lifecycle calls.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { readTelemetry } from '../../src/tools/cmos/local-telemetry';
import { seedCmosDb } from '../helpers/seedCmosDb';

const verb = jest.fn();
jest.mock('../../src/cli/session-start', () => ({ run: (...args: unknown[]) => verb(...args) }));
jest.mock('../../src/cli/prompt', () => ({ run: (...args: unknown[]) => verb(...args) }));
jest.mock('../../src/cli/stop', () => ({ run: (...args: unknown[]) => verb(...args) }));
jest.mock('../../src/cli/session-end', () => ({ run: (...args: unknown[]) => verb(...args) }));
let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-hook-dedupe-'));
  root = path.join(tmp, 'project');
  dbPath = seedCmosDb(root, { projectId: 'dedupe' });
  env = {
    ...process.env,
    CMOS_CONFIG_DIR: path.join(tmp, 'config'),
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_PID: String(process.pid),
  };
  verb.mockReset().mockResolvedValue('Delivered context.');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
async function hook(
  event: string,
  source = 'cmos-plugin',
  input: Record<string, string> = {},
  override: Partial<CliIo> = {}
) {
  let stdout = '';
  const stderr: string[] = [];
  const code = await runCli(['hook', event, '--hook-source', source, '--format', 'text'], {
    cwd: root,
    env,
    readStdin: async () =>
      JSON.stringify({
        session_id: 'one-session',
        cwd: root,
        prompt: 'A legitimate repeated question about records',
        ...input,
      }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr.push(text);
    },
    ...override,
  });
  return { code, stdout, stderr };
}
it('a losing source has no output, telemetry or verb effects, even after duplicate SessionEnd', async () => {
  expect((await hook('session-start')).stdout).toContain('Delivered');
  expect(await hook('prompt', 'other-adapter', { prompt_id: 'p1' })).toEqual({
    code: 0,
    stdout: '',
    stderr: [],
  });
  expect(verb).toHaveBeenCalledTimes(1);
  expect(readTelemetry({ dbPath, projectId: 'dedupe' }, env)).toHaveLength(1);
  await hook('session-end');
  await hook('session-end');
  expect((await hook('session-start', 'other-adapter')).stdout).toBe('');
  expect(verb).toHaveBeenCalledTimes(3);
});
it('all winning compact and resume calls remain eligible even with the previous prompt ID', async () => {
  for (const source of ['compact', 'compact', 'resume', 'resume']) {
    expect(
      (await hook('session-start', 'cmos-plugin', { source, prompt_id: 'last-turn' })).stdout
    ).toContain('Delivered');
  }
  expect(verb).toHaveBeenCalledTimes(4);
});
it('preserves real prompt IDs and commits only after successful output', async () => {
  const failed = await hook(
    'prompt',
    'cmos-plugin',
    { prompt_id: 'p1' },
    {
      stdout: () => {
        throw new Error('broken output');
      },
    }
  );
  expect(failed.stderr.join('')).toContain('broken output');
  expect((await hook('prompt', 'cmos-plugin', { prompt_id: 'p1' })).stdout).toContain('Delivered');
  expect((await hook('prompt', 'cmos-plugin', { prompt_id: 'p1' })).stdout).toBe('');
  expect(verb).toHaveBeenCalledTimes(2);
  expect(verb.mock.calls[0][0].input.prompt_id).toBe('p1');
  // No invented identity from repeated prompt text when prompt_id is absent.
  await hook('prompt');
  await hook('prompt');
  expect(verb).toHaveBeenCalledTimes(4);
});
it('unverifiable epochs have no source election guarantee but real prompt IDs still dedupe', async () => {
  const override = { env: { ...env, CLAUDE_PID: '' } };
  await hook('session-start', 'cmos-plugin', {}, override);
  await hook('session-start', 'other-adapter', {}, override);
  await hook('prompt', 'cmos-plugin', { prompt_id: 'real-turn' }, override);
  await hook('prompt', 'other-adapter', { prompt_id: 'real-turn' }, override);
  expect(verb).toHaveBeenCalledTimes(3);
});

it('keeps the elected source when CMOS is initialized during the same harness session', async () => {
  fs.rmSync(path.join(root, 'cmos'), { recursive: true, force: true });
  await hook('session-start', 'cmos-plugin');
  dbPath = seedCmosDb(root, { projectId: 'dedupe' });
  expect((await hook('session-start', 'other-adapter')).stdout).toBe('');
  expect(verb).toHaveBeenCalledTimes(1);
});
it('Stop remains silent and calls its stage once per identified turn, independently of prompt receipt', async () => {
  await hook('prompt', 'cmos-plugin', { prompt_id: 'turn' });
  expect((await hook('stop', 'cmos-plugin', { prompt_id: 'turn' })).stdout).toBe('');
  await hook('stop', 'cmos-plugin', { prompt_id: 'turn' });
  expect(verb).toHaveBeenCalledTimes(2);
});
