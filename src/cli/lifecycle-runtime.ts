// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps transient compact markers and once-captured Git baselines outside the project.
// ABOUTME: Exit facts describe bounded repository observations, never authorship, and cleanup is exact-path only.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runtimeDir } from '../tools/cmos/harness-session';
import type { HookRuntimeIdentity } from './hook-runtime';
import { prepareRuntimeFile, requireSafeRuntime } from './runtime-file';

interface Baseline {
  readonly availability: 'available' | 'not-git' | 'unavailable' | 'timeout';
  readonly head?: string | null;
  readonly dirty?: readonly string[];
}
const target = (key: HookRuntimeIdentity) => ({
  projectId: '',
  dbPath: path.join(key.directory, 'cmos', 'db', 'cmos.sqlite'),
});

export function lifecyclePaths(
  key: HookRuntimeIdentity,
  env: NodeJS.ProcessEnv
): { baseline: string; compact: string } {
  const base = path.join(runtimeDir(env), 'lifecycle', `${key.sessionHash}-${key.directoryHash}`);
  return { baseline: `${base}.baseline.json`, compact: `${base}.compact` };
}
function git(
  key: HookRuntimeIdentity,
  env: NodeJS.ProcessEnv,
  deadline: number,
  args: string[]
): string {
  if (Date.now() >= deadline) throw new Error('timeout');
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', key.directory, ...args], {
      encoding: 'utf8',
      timeout: Math.max(1, Math.min(100, deadline - Date.now())),
      maxBuffer: 65536,
      env: { ...env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ETIMEDOUT') throw new Error('timeout');
    throw error;
  }
}
function dirtyPaths(output: string): string[] {
  const records = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    paths.push(records[index].slice(3));
    if (/^[RC]|^.[RC]/.test(records[index])) index++;
  }
  return [...new Set(paths)];
}
function readBaseline(key: HookRuntimeIdentity, env: NodeJS.ProcessEnv): Baseline | null {
  const file = lifecyclePaths(key, env).baseline;
  requireSafeRuntime(file, target(key));
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
    if (
      !['available', 'not-git', 'unavailable', 'timeout'].includes(value.availability) ||
      (value.availability === 'available' &&
        (!Array.isArray(value.dirty) || !(value.head === null || typeof value.head === 'string')))
    )
      throw new Error('invalid lifecycle baseline');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Called at SessionStart before any CMOS write. A resume/compact never replaces the baseline. */
export function captureBaseline(
  key: HookRuntimeIdentity | null,
  env: NodeJS.ProcessEnv,
  deadlineAtMs: number
): void {
  if (!key || readBaseline(key, env)) return;
  const deadline = Math.min(deadlineAtMs, Date.now() + 250);
  let baseline: Baseline;
  try {
    try {
      git(key, env, deadline, ['rev-parse', '--show-toplevel']);
    } catch (error) {
      if ((error as { status?: number }).status === 128) throw new Error('not-git');
      throw error;
    }
    let head: string | null = null;
    try {
      head = git(key, env, deadline, ['rev-parse', '--verify', 'HEAD']).trim();
    } catch (error) {
      if ((error as { status?: number }).status !== 128) throw error;
    }
    baseline = {
      availability: 'available',
      head,
      dirty: dirtyPaths(
        git(key, env, deadline, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    baseline = {
      availability: message === 'timeout' || message === 'not-git' ? message : 'unavailable',
    };
  }
  const file = lifecyclePaths(key, env).baseline;
  prepareRuntimeFile(file, target(key));
  try {
    fs.writeFileSync(file, JSON.stringify(baseline), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function pathsLabel(paths: readonly string[]): string {
  const unique = [...new Set(paths)].sort();
  const examples = unique
    .slice(0, 8)
    .map((name) => JSON.stringify(name.slice(0, 100)))
    .join(', ');
  return `${unique.length} (distinct paths${examples ? `: ${examples}` : ''}${unique.length > 8 ? '; examples limited to 8' : ''})`;
}

/** Bounded local Git only; a failed observation is unavailable, never an empty count. */
export function gitObservations(
  key: HookRuntimeIdentity | null,
  env: NodeJS.ProcessEnv,
  deadlineAtMs: number
): string {
  const prefix = 'Repository observations (not agent authorship): ';
  if (!key) return prefix + 'baseline unavailable.';
  const baseline = readBaseline(key, env);
  if (!baseline) return prefix + 'baseline unavailable.';
  if (Date.now() >= deadlineAtMs) return prefix + 'timeout; exit facts unavailable.';
  if (baseline.availability !== 'available') {
    const reason =
      baseline.availability === 'not-git' ? 'not a Git repository' : baseline.availability;
    return prefix + `baseline ${reason}; changes cannot be compared.`;
  }
  const deadline = Math.min(deadlineAtMs, Date.now() + 300);
  const preexisting = `pre-existing dirty paths: ${pathsLabel(baseline.dirty ?? [])}`;
  try {
    const dirty = dirtyPaths(
      git(key, env, deadline, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    );
    if (!baseline.head)
      return (
        prefix +
        `baseline had no HEAD; commit comparison unavailable; ${preexisting}; current dirty paths: ${pathsLabel(dirty)}.`
      );
    const head = git(key, env, deadline, ['rev-parse', '--verify', 'HEAD']).trim();
    try {
      git(key, env, deadline, ['merge-base', '--is-ancestor', baseline.head, head]);
    } catch (error) {
      if ((error as { status?: number }).status === 1)
        return (
          prefix +
          `rewritten history; baseline is not an ancestor of HEAD; ${preexisting}; current dirty paths: ${pathsLabel(dirty)}.`
        );
      throw error;
    }
    const commits = git(key, env, deadline, [
      'rev-list',
      '--count',
      `${baseline.head}..${head}`,
    ]).trim();
    if (!/^\d+$/.test(commits)) throw new Error('invalid Git count');
    const changed = git(key, env, deadline, ['diff', '--name-only', '-z', baseline.head, '--'])
      .split('\0')
      .filter(Boolean);
    return (
      prefix +
      `${commits} reachable commits (HEAD excluding baseline ancestors); paths differing from baseline commit or currently untracked: ${pathsLabel([...changed, ...dirty])}; ${preexisting}.`
    );
  } catch (error) {
    return (
      prefix +
      `${error instanceof Error && error.message === 'timeout' ? 'timeout' : 'Git unavailable'}; exit facts unavailable; ${preexisting}.`
    );
  }
}

export function markPreCompact(key: HookRuntimeIdentity | null, env: NodeJS.ProcessEnv): void {
  if (!key) return;
  const file = lifecyclePaths(key, env).compact;
  prepareRuntimeFile(file, target(key));
  fs.writeFileSync(file, 'compact\n', { mode: 0o600 });
}
export function hasCompactMarker(key: HookRuntimeIdentity, env: NodeJS.ProcessEnv): boolean {
  const file = lifecyclePaths(key, env).compact;
  requireSafeRuntime(file, target(key));
  return fs.existsSync(file);
}
export function consumeCompactMarker(
  key: HookRuntimeIdentity | null,
  env: NodeJS.ProcessEnv
): void {
  if (!key) return;
  const file = lifecyclePaths(key, env).compact;
  requireSafeRuntime(file, target(key));
  fs.rmSync(file, { force: true });
}
export function cleanupLifecycle(key: HookRuntimeIdentity | null, env: NodeJS.ProcessEnv): void {
  if (!key) return;
  for (const file of Object.values(lifecyclePaths(key, env))) {
    requireSafeRuntime(file, target(key));
    fs.rmSync(file, { force: true });
  }
}
