// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives compact markers, digest delivery and factual session close through real hook entry points.
// ABOUTME: Failed output preserves retry state, successful close cleans only transient state and never invents a session.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import * as digest from '../../src/cli/digest';
import { observeRenderedContext } from '../../src/cli/telemetry';
import { hookRuntimeIdentity } from '../../src/cli/hook-runtime';
import { hasCompactMarker, lifecyclePaths } from '../../src/cli/lifecycle-runtime';
import { ensureHarnessSession } from '../../src/cli/harness-ops';
import * as harnessOps from '../../src/cli/harness-ops';
import * as lifecycle from '../../src/cli/lifecycle-runtime';
import { recallStatePath } from '../../src/cli/recall-runtime';
import { setExternalSessionOwner } from '../../src/tools/cmos/session-owner';
import { seedCmosDb } from '../helpers/seedCmosDb';
let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const savedConfig = process.env.CMOS_CONFIG_DIR;
const text = '  • d:7 A concrete delivered decision.';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-hook-lifecycle-'));
  root = path.join(tmp, 'project');
  dbPath = seedCmosDb(root, { projectId: 'lifecycle' });
  env = {
    ...process.env,
    CMOS_CONFIG_DIR: path.join(tmp, 'config'),
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_PID: String(process.pid),
    CLAUDE_CODE_SESSION_ID: '',
  };
  process.env.CMOS_CONFIG_DIR = env.CMOS_CONFIG_DIR;
  jest.spyOn(digest, 'buildDigest').mockImplementation(async (_root, io) => {
    observeRenderedContext(io, {
      text,
      returnedIds: ['d:7'],
      items: [{ typedId: 'd:7', start: 0, end: text.length }],
    });
    return text;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});
function key() {
  return hookRuntimeIdentity({ session_id: 'lifecycle-session', cwd: root }, env)!;
}
async function hook(
  event: string,
  input: Record<string, string> = {},
  override: Partial<CliIo> = {}
) {
  let stdout = '';
  const stderr: string[] = [];
  const code = await runCli(['hook', event, '--format', 'text', '--hook-source', 'cmos-plugin'], {
    cwd: root,
    env,
    readStdin: async () => JSON.stringify({ session_id: 'lifecycle-session', cwd: root, ...input }),
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr.push(value);
    },
    ...override,
  });
  setExternalSessionOwner(null);
  return { code, stdout, stderr };
}
it('consumes PreCompact only after successful compact digest output and records its actual typed spans', async () => {
  expect((await hook('pre-compact')).stdout).toBe('');
  expect(hasCompactMarker(key(), env)).toBe(true);
  const failed = await hook(
    'session-start',
    { source: 'compact' },
    {
      stdout: () => {
        throw new Error('broken pipe');
      },
    }
  );
  expect(failed.stderr.join('')).toContain('broken pipe');
  expect(hasCompactMarker(key(), env)).toBe(true);
  expect((await hook('session-start', { source: 'compact' })).stdout).toContain('d:7');
  expect(hasCompactMarker(key(), env)).toBe(false);
  const state = new Database(recallStatePath('lifecycle-session', env), { readonly: true });
  expect(state.prepare('SELECT typed_id FROM seen').all()).toEqual([{ typed_id: 'd:7' }]);
  expect(state.prepare('SELECT * FROM delivery').all()).toEqual([]);
  state.close();
  expect((await hook('session-start', { source: 'compact' })).stdout).toContain('d:7');
});
it('closes only existing owned sessions with honest observations, preserving recall after duplicate end', async () => {
  await hook('session-start', { source: 'startup' });
  const owned = await ensureHarnessSession(root, 'lifecycle-session');
  expect(owned).not.toBeNull();
  const recallBefore = fs.readFileSync(recallStatePath('lifecycle-session', env));
  expect(await hook('session-end')).toEqual({ code: 0, stdout: '', stderr: [] });
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare('SELECT status, summary FROM sessions WHERE id=?')
    .get(owned!.sessionId) as { status: string; summary: string };
  expect(row.status).toBe('completed');
  expect(row.summary).toContain('Repository observations (not agent authorship)');
  expect(row.summary).toContain('not a Git repository');
  const count = db.prepare('SELECT count(*) AS n FROM sessions').get();
  db.close();
  expect(fs.existsSync(lifecyclePaths(key(), env).baseline)).toBe(false);
  await hook('session-end');
  const after = new Database(dbPath, { readonly: true });
  expect(after.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual(count);
  after.close();
  expect(fs.readFileSync(recallStatePath('lifecycle-session', env))).toEqual(recallBefore);
});
it('never creates an empty CMOS session solely for exit observations', async () => {
  await hook('session-start', { source: 'startup' });
  expect(await hook('session-end')).toEqual({ code: 0, stdout: '', stderr: [] });
  const db = new Database(dbPath, { readonly: true });
  expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM session_events').get()).toEqual({ n: 0 });
  db.close();
});

it('does not begin close writes when Git observations exhaust the remaining deadline', async () => {
  await hook('session-start', { source: 'startup' });
  const owned = await ensureHarnessSession(root, 'lifecycle-session');
  expect(owned).not.toBeNull();
  const close = jest.spyOn(harnessOps, 'endHarnessSession');
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(lifecycle, 'gitObservations').mockImplementation(() => {
    now += 1001;
    return 'Repository observations: timeout; exit facts unavailable.';
  });
  expect((await hook('session-end')).stdout).toBe('');
  expect(close).not.toHaveBeenCalled();
  const db = new Database(dbPath, { readonly: true });
  expect(db.prepare('SELECT status FROM sessions WHERE id=?').get(owned!.sessionId)).toEqual({
    status: 'active',
  });
  db.close();
  expect(fs.existsSync(lifecyclePaths(key(), env).baseline)).toBe(true);
});
