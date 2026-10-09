// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Source election distinguishes process lifetimes and keeps duplicate adapters inert.
// ABOUTME: Transactional prompt receipts survive end events, while failed deliveries remain retryable.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  beginHookReceipt,
  electHookSource,
  hookRuntimeIdentity,
  hookRuntimePath,
} from '../../src/cli/hook-runtime';
import { harnessProcessEpoch } from '../../src/cli/harness-epoch';

let tmp: string;
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-hook-runtime-'));
  root = path.join(tmp, 'project');
  fs.mkdirSync(root);
  env = { CMOS_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: root };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const input = { session_id: 'private-session' };
function identity() {
  return hookRuntimeIdentity(input, env)!;
}

it('keys a canonical harness directory independently of CMOS discovery and respects env precedence', () => {
  const first = identity();
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(root, alias);
  expect(
    hookRuntimeIdentity({ ...input, cwd: '/ignored' }, { ...env, CLAUDE_PROJECT_DIR: alias })
  ).toEqual(first);
  fs.mkdirSync(path.join(root, 'cmos', 'db'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cmos', 'db', 'cmos.sqlite'), 'created after first hook');
  expect(identity()).toEqual(first);
  expect(hookRuntimeIdentity({ ...input, cwd: root }, { ...env, CLAUDE_PROJECT_DIR: '' })).toEqual(
    first
  );
  expect(hookRuntimeIdentity(input, { CMOS_CONFIG_DIR: env.CMOS_CONFIG_DIR })).toBeNull();
});

it('elects only explicit sources with a verified epoch and retains a winner until a new process epoch', () => {
  const key = identity();
  expect(electHookSource(key, 'cmos-plugin', 'verified-epoch-one', env)).toBe(true);
  const before = fs.readFileSync(hookRuntimePath(key, env));
  expect(electHookSource(key, 'legacy-adapter', 'verified-epoch-one', env)).toBe(false);
  expect(fs.readFileSync(hookRuntimePath(key, env))).toEqual(before);
  expect(electHookSource(key, 'cmos-plugin', 'verified-epoch-one', env)).toBe(true);
  expect(electHookSource(key, 'legacy-adapter', 'verified-epoch-two', env)).toBe(true);
  expect(electHookSource(key, 'cmos-plugin', 'verified-epoch-two', env)).toBe(false);
  expect(electHookSource(key, 'legacy-adapter', null, env)).toBe(true);
  expect(electHookSource(key, undefined, 'verified-epoch-two', env)).toBe(true);
  expect(fs.readFileSync(hookRuntimePath(key, env)).toString()).not.toContain('private-session');
});

it('uses a real harness process epoch, never an absent PID or a hook process start fallback', () => {
  expect(harnessProcessEpoch({})).toBeNull();
  expect(harnessProcessEpoch({ CLAUDE_PID: 'not-a-pid' })).toBeNull();
  expect(harnessProcessEpoch({ CLAUDE_PID: '999999999' })).toBeNull();
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const epoch = harnessProcessEpoch({ CLAUDE_PID: String(process.pid) });
    expect(epoch).toBeTruthy();
    expect(epoch).not.toBe(String(process.pid));
    expect(harnessProcessEpoch({ CLAUDE_PID: String(process.pid) })).toBe(epoch);
  }
});

it('holds identified prompt receipts through delivery; rollback permits retry and success suppresses replay', () => {
  const key = identity();
  const first = beginHookReceipt(key, 'prompt', 'real-prompt-id', env)!;
  expect(first.duplicate).toBe(false);
  const other = new Database(hookRuntimePath(key, env), { timeout: 0 });
  expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
  other.close();
  first.rollback();
  const retry = beginHookReceipt(key, 'prompt', 'real-prompt-id', env)!;
  expect(retry.duplicate).toBe(false);
  retry.commit();
  const duplicate = beginHookReceipt(key, 'prompt', 'real-prompt-id', env)!;
  expect(duplicate.duplicate).toBe(true);
  duplicate.rollback();
  expect(beginHookReceipt(key, 'prompt', undefined, env)).toBeNull();
  // Lifecycle IDs can name the last prompt rather than a new occurrence: never suppress them.
  expect(beginHookReceipt(key, 'session-start', 'real-prompt-id', env)).toBeNull();
  expect(beginHookReceipt(key, 'pre-compact', 'real-prompt-id', env)).toBeNull();
  expect(beginHookReceipt(key, 'session-end', 'real-prompt-id', env)).toBeNull();
});

it('refuses runtime placement in the harness directory even before init creates a store', () => {
  const unsafe = { ...env, CMOS_CONFIG_DIR: path.join(root, 'config') };
  expect(() => electHookSource(identity(), 'cmos-plugin', 'epoch', unsafe)).toThrow(/unsafe/);
  expect(fs.existsSync(path.join(root, 'config'))).toBe(false);
});

it('an established losing source reads its election without competing for a writer lock', () => {
  const key = identity();
  electHookSource(key, 'cmos-plugin', 'verified-epoch', env);
  const held = new Database(hookRuntimePath(key, env), { timeout: 0 });
  held.exec('BEGIN IMMEDIATE');
  try {
    expect(electHookSource(key, 'other-adapter', 'verified-epoch', env)).toBe(false);
  } finally {
    held.exec('ROLLBACK');
    held.close();
  }
});
