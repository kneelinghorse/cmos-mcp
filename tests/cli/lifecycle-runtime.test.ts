// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Lifecycle facts are bounded repository observations from a once-captured baseline.
// ABOUTME: Compact markers and cleanup are isolated to the owning session, without removing durable receipts.

import { execFileSync, type ExecFileSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  captureBaseline,
  gitObservations,
  markPreCompact,
  hasCompactMarker,
  consumeCompactMarker,
  cleanupLifecycle,
  lifecyclePaths,
} from '../../src/cli/lifecycle-runtime';
import { hookRuntimeIdentity, electHookSource, hookRuntimePath } from '../../src/cli/hook-runtime';
let tmp: string;
let root: string;
let env: NodeJS.ProcessEnv;
let clock: number;
let gitCalls: Array<{ args: readonly string[]; timeout: number | undefined }>;
let observeGit: (
  args: readonly string[],
  options: ExecFileSyncOptions
) => ReturnType<typeof execFileSync>;
const realExecFileSync = execFileSync;
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function key(session = 'session') {
  return hookRuntimeIdentity({ session_id: session, cwd: root }, env)!;
}
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-lifecycle-'));
  root = path.join(tmp, 'project');
  fs.mkdirSync(root);
  env = { ...process.env, CMOS_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: root };
  git('init');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'existing.txt'), 'original\n');
  git('add', '.');
  git('commit', '-m', 'baseline');
  clock = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  gitCalls = [];
  // Semantic fixtures exercise real Git without making CI scheduling part of their oracle.
  // The unchanged production timeout is recorded first and asserted outside its catch paths.
  observeGit = (args, options) => realExecFileSync('git', args, { ...options, timeout: 10_000 });
  jest
    .spyOn(require('child_process') as typeof import('child_process'), 'execFileSync')
    .mockImplementation((file, args, options) => {
      if (file !== 'git' || !Array.isArray(args) || args[0] !== '--no-optional-locks')
        return realExecFileSync(file, args, options);
      gitCalls.push({ args: args.slice(3), timeout: options?.timeout });
      return observeGit(args, options ?? {});
    });
});
afterEach(() => {
  try {
    for (const call of gitCalls) {
      expect(call.timeout).toBeGreaterThan(0);
      expect(call.timeout).toBeLessThanOrEqual(100);
    }
  } finally {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
it('captures baseline once, labels pre-existing dirt, and counts observations without claiming authorship', () => {
  fs.writeFileSync(path.join(root, 'existing.txt'), 'pre-existing dirt\n');
  captureBaseline(key(), env, Date.now() + 2000);
  const baseline = fs.readFileSync(lifecyclePaths(key(), env).baseline);
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  git('add', '.');
  git('commit', '-m', 'observed');
  captureBaseline(key(), env, Date.now() + 2000);
  expect(fs.readFileSync(lifecyclePaths(key(), env).baseline)).toEqual(baseline);
  const facts = gitObservations(key(), env, Date.now() + 2000);
  expect(facts).toContain('not agent authorship');
  expect(facts).toContain('1 reachable commit');
  expect(facts).toContain('pre-existing dirty paths');
  expect(facts).toContain('existing.txt');
  expect(facts).toContain('new.txt');
});
it('marks rewritten history, missing baselines, non-git and expired observations honestly', () => {
  expect(gitObservations(key(), env, Date.now() + 2000)).toContain('baseline unavailable');
  captureBaseline(key(), env, Date.now() + 2000);
  git('commit', '--amend', '-m', 'rewritten');
  expect(gitObservations(key(), env, Date.now() + 2000)).toContain('rewritten history');
  expect(gitObservations(key(), env, Date.now() - 1)).toContain('timeout');
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  captureBaseline(key('not-git'), env, Date.now() + 2000);
  expect(gitObservations(key('not-git'), env, Date.now() + 2000)).toContain('not a Git repository');
});
it('cleans only owned transient files and retains election and another session marker', () => {
  captureBaseline(key(), env, Date.now() + 2000);
  markPreCompact(key(), env);
  markPreCompact(key('other'), env);
  electHookSource(key(), 'cmos-plugin', 'verified-epoch', env);
  const election = fs.readFileSync(hookRuntimePath(key(), env));
  expect(hasCompactMarker(key(), env)).toBe(true);
  consumeCompactMarker(key(), env);
  expect(hasCompactMarker(key(), env)).toBe(false);
  markPreCompact(key(), env);
  cleanupLifecycle(key(), env);
  cleanupLifecycle(key(), env);
  expect(fs.existsSync(lifecyclePaths(key(), env).baseline)).toBe(false);
  expect(hasCompactMarker(key(), env)).toBe(false);
  expect(hasCompactMarker(key('other'), env)).toBe(true);
  expect(fs.readFileSync(hookRuntimePath(key(), env))).toEqual(election);
});
it('bounded Git reads do not update the repository index', () => {
  const index = path.join(root, '.git', 'index');
  const before = fs.readFileSync(index);
  captureBaseline(key(), env, Date.now() + 2000);
  expect(gitObservations(key(), env, Date.now() + 2000)).toContain('0 reachable commits');
  expect(fs.readFileSync(index)).toEqual(before);
});

it.each(['baseline', 'observation'] as const)(
  'distinguishes a child timeout from an ordinary Git failure during %s',
  (phase) => {
    if (phase === 'observation') captureBaseline(key(), env, clock + 2000);
    for (const code of ['ETIMEDOUT', 'ENOENT']) {
      gitCalls = [];
      observeGit = () => {
        throw Object.assign(new Error('fixture Git failure'), { code });
      };
      if (phase === 'baseline') {
        const identity = key(code);
        captureBaseline(identity, env, clock + 2000);
        expect(JSON.parse(fs.readFileSync(lifecyclePaths(identity, env).baseline, 'utf8'))).toEqual(
          {
            availability: code === 'ETIMEDOUT' ? 'timeout' : 'unavailable',
          }
        );
      } else {
        expect(gitObservations(key(), env, clock + 2000)).toContain(
          code === 'ETIMEDOUT'
            ? 'timeout; exit facts unavailable'
            : 'Git unavailable; exit facts unavailable'
        );
      }
      expect(gitCalls.map((call) => call.timeout)).toEqual([100]);
    }
  }
);

it.each([
  { phase: 'baseline', budget: 250, callerBudget: 2000 },
  { phase: 'observation', budget: 300, callerBudget: 2000 },
  { phase: 'baseline', budget: 40, callerBudget: 40 },
  { phase: 'observation', budget: 40, callerBudget: 40 },
] as const)(
  'stops spawning after the $phase budget of $budget ms expires',
  ({ phase, budget, callerBudget }) => {
    if (phase === 'observation') captureBaseline(key(), env, clock + 2000);
    gitCalls = [];
    const callerDeadline = clock + callerBudget;
    observeGit = () => {
      // Simulate scheduling time after the child returns, without sleeping or relying on host load.
      clock += budget;
      return phase === 'baseline' ? `${root}\n` : '';
    };
    if (phase === 'baseline') {
      captureBaseline(key(), env, callerDeadline);
      expect(JSON.parse(fs.readFileSync(lifecyclePaths(key(), env).baseline, 'utf8'))).toEqual({
        availability: 'timeout',
      });
    } else {
      expect(gitObservations(key(), env, callerDeadline)).toContain(
        'timeout; exit facts unavailable'
      );
    }
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0].timeout).toBe(Math.min(100, callerBudget));
  }
);

it('shrinks the last baseline child timeout to the remaining 250 ms budget', () => {
  const replies = [`${root}\n`, 'baseline-head\n', ''];
  const elapsed = [90, 90, 0];
  observeGit = () => {
    clock += elapsed.shift()!;
    return replies.shift()!;
  };
  captureBaseline(key(), env, clock + 2000);
  expect(JSON.parse(fs.readFileSync(lifecyclePaths(key(), env).baseline, 'utf8'))).toEqual({
    availability: 'available',
    head: 'baseline-head',
    dirty: [],
  });
  expect(gitCalls.map((call) => call.timeout)).toEqual([100, 100, 70]);
});

it('shrinks exit child timeouts to the remaining 300 ms budget', () => {
  captureBaseline(key(), env, clock + 2000);
  gitCalls = [];
  const replies = ['', 'current-head\n', '', '0\n', ''];
  const elapsed = [70, 70, 70, 70, 0];
  observeGit = () => {
    clock += elapsed.shift()!;
    return replies.shift()!;
  };
  expect(gitObservations(key(), env, clock + 2000)).toContain('0 reachable commits');
  expect(gitCalls.map((call) => call.timeout)).toEqual([100, 100, 100, 90, 20]);
});
