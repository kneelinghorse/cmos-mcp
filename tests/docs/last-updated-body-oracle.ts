// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Test-only oracle for Last Updated stamps on Markdown files tracked by git.
// ABOUTME: Ignores stamp-only diffs and fails rather than guessing when git omits needed history.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface LastUpdatedStamp {
  readonly rel: string;
  readonly value: string;
}

const COMMIT_SEPARATOR = '\x1e';
const HEADER_SEPARATOR = '\x1f';
const LAST_UPDATED_LINE = /^\s*\*\*Last Updated\*\*:\s*.*$/;

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function patchChangesBody(patch: string): boolean {
  let prefixWidth = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff ')) {
      prefixWidth = 0;
      continue;
    }

    const hunk = /^(@{2,}) /.exec(line);
    if (hunk) {
      prefixWidth = hunk[1].length - 1;
      continue;
    }

    if (prefixWidth === 0 || line.length < prefixWidth) continue;
    const prefix = line.slice(0, prefixWidth);
    if (![...prefix].some((character) => character === '+' || character === '-')) continue;
    if (!LAST_UPDATED_LINE.test(line.slice(prefixWidth))) return true;
  }
  return false;
}

function localIsoDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeBody(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !LAST_UPDATED_LINE.test(line))
    .join('\n');
}

function renamedPathsInHistory(repoRoot: string, historyPath: string): string[] {
  const fields = git(repoRoot, [
    'log',
    '--full-history',
    '-m',
    '--find-renames',
    '--format=',
    '--name-status',
    '-z',
    '--diff-filter=R',
  ]).split('\0');
  const renameGraph = new Map<string, Set<string>>();
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++];
    if (!/^R\d+$/.test(status)) {
      i++;
      continue;
    }
    const oldPath = fields[i++];
    const newPath = fields[i++];
    const oldNeighbors = renameGraph.get(oldPath) ?? new Set<string>();
    const newNeighbors = renameGraph.get(newPath) ?? new Set<string>();
    oldNeighbors.add(newPath);
    newNeighbors.add(oldPath);
    renameGraph.set(oldPath, oldNeighbors);
    renameGraph.set(newPath, newNeighbors);
  }

  const paths = new Set([historyPath]);
  const pending = [historyPath];
  while (pending.length > 0) {
    for (const neighbor of renameGraph.get(pending.pop() as string) ?? []) {
      if (paths.has(neighbor)) continue;
      paths.add(neighbor);
      pending.push(neighbor);
    }
  }
  return [...paths].sort();
}

/** Merges that touched any path the file had across its renames, with their commit dates. */
function mergesAcrossRenames(
  repoRoot: string,
  historyPath: string
): { readonly paths: string[]; readonly merges: Array<{ hash: string; date: string }> } {
  const paths = renamedPathsInHistory(repoRoot, historyPath);
  if (paths.length === 1) return { paths, merges: [] };
  const merges = git(repoRoot, [
    'log',
    '--full-history',
    '--merges',
    `--format=%H${HEADER_SEPARATOR}%cs`,
    '--',
    ...paths,
  ])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date] = line.split(HEADER_SEPARATOR);
      return { hash, date };
    });
  return { paths, merges };
}

/** The file's body at `rev`, under whichever of its historical paths exists there; null if none. */
function bodyAt(repoRoot: string, rev: string, paths: readonly string[]): string | null {
  for (const candidate of paths) {
    try {
      return normalizeBody(git(repoRoot, ['show', `${rev}:${candidate}`]));
    } catch {
      // not at this path in this commit
    }
  }
  return null;
}

/** Dates of commits in `range` that changed the file's body under any of its historical paths. */
function bodyChangeDatesIn(repoRoot: string, range: string, paths: readonly string[]): string[] {
  const log = git(repoRoot, [
    'log',
    range,
    '--find-renames',
    '--format=%x1e%H%x1f%P%x1f%cs',
    '--patch',
    '-m',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--',
    ...paths,
  ]);
  return log
    .split(COMMIT_SEPARATOR)
    .slice(1)
    .flatMap((record) => {
      const headerEnd = record.indexOf('\n');
      if (headerEnd < 0) return [];
      const date = record.slice(0, headerEnd).trim().split(HEADER_SEPARATOR)[2];
      return date && patchChangesBody(record.slice(headerEnd + 1)) ? [date] : [];
    });
}

/**
 * Whether a merge dated after the latest body change found could hide a later one. It cannot when
 * its own version of the file equals one parent's (it introduced no body of its own), and when no
 * commit on any parent's side since their merge base changed the body after `latest`. That is the
 * release-merge shape: a branch renamed and edited the file, the other side never touched it.
 */
export function mergeCanHideLaterChange(
  repoRoot: string,
  merge: { hash: string; date: string },
  paths: readonly string[],
  latest: string
): boolean {
  const parents = git(repoRoot, ['rev-list', '--parents', '-n', '1', merge.hash])
    .trim()
    .split(' ')
    .slice(1);
  if (parents.length < 2) return true;
  const own = bodyAt(repoRoot, merge.hash, paths);
  if (!parents.some((parent) => bodyAt(repoRoot, parent, paths) === own)) return true;
  let base: string;
  try {
    base = git(repoRoot, ['merge-base', '--octopus', ...parents]).trim();
  } catch {
    return true;
  }
  return parents.some((parent) =>
    bodyChangeDatesIn(repoRoot, `${base}..${parent}`, paths).some((date) => date > latest)
  );
}

/**
 * `git log --follow` can lose a renamed file's history at a merge, so a merge across renames is a
 * place a body change may hide. A merge can only hide changes made on the branches it joined, which
 * this oracle (it already reads commit dates as time) dates no later than the merge itself. So the
 * walk stands when every such merge is dated no later than the latest body change it found, or,
 * for a later merge, when that merge provably hides nothing (mergeCanHideLaterChange); otherwise
 * the oracle refuses rather than guess (s92-m06 renamed the seed template; its release merge into
 * main is later than the rename).
 */
function assertMergesCannotHideLaterChange(
  repoRoot: string,
  rel: string,
  across: ReturnType<typeof mergesAcrossRenames>,
  latest: string | undefined
): void {
  const blocking = across.merges.filter(
    (merge) =>
      latest === undefined ||
      (merge.date > latest && mergeCanHideLaterChange(repoRoot, merge, across.paths, latest))
  );
  if (blocking.length === 0) return;
  throw new Error(
    `${rel}: git --follow cannot prove merge history across renamed paths ` +
      `[${across.paths.join(', ')}] (merges: ${[...new Set(blocking.map((m) => m.hash))].join(', ')})`
  );
}

function headPathForWorkingPath(
  repoRoot: string,
  rel: string
): { readonly headPath: string | null; readonly historyPath: string } {
  const fields = git(repoRoot, [
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    'HEAD',
    '--',
  ]).split('\0');

  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++];
    if (status.startsWith('R')) {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      if (newPath === rel) return { headPath: oldPath, historyPath: oldPath };
      continue;
    }

    const changedPath = fields[i++];
    if (status === 'A' && changedPath === rel) {
      return { headPath: null, historyPath: rel };
    }
  }

  return { headPath: rel, historyPath: rel };
}

export function latestNonStampBodyChangeDate(
  repoRoot: string,
  rel: string,
  now: Date = new Date()
): string {
  if (git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error(
      'Last Updated body-change oracle requires complete git history, not a shallow clone'
    );
  }

  try {
    git(repoRoot, ['ls-files', '--error-unmatch', '--', rel]);
  } catch {
    throw new Error(
      `${rel} is not tracked by git; its Last Updated stamp has no body-change oracle`
    );
  }

  const { headPath, historyPath } = headPathForWorkingPath(repoRoot, rel);
  const currentBody = normalizeBody(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  if (headPath === null) return localIsoDate(now);

  let headBody: string;
  try {
    headBody = normalizeBody(git(repoRoot, ['show', `HEAD:${headPath}`]));
  } catch {
    throw new Error(`Cannot read HEAD:${headPath}; ${rel}'s body-change history is unavailable`);
  }
  if (currentBody !== headBody) return localIsoDate(now);

  const history = git(repoRoot, [
    'log',
    '--follow',
    '--find-renames',
    '--root',
    '--format=%x1e%H%x1f%P%x1f%cs',
    '--date=short',
    '--patch',
    '-m',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--',
    historyPath,
  ]);
  const records = history
    .split(COMMIT_SEPARATOR)
    .slice(1)
    .flatMap((record) => {
      const headerEnd = record.indexOf('\n');
      if (headerEnd < 0) return [];
      const [hash, parentsText, date] = record.slice(0, headerEnd).trim().split(HEADER_SEPARATOR);
      if (!hash || parentsText === undefined || !date) return [];
      const parentCount = parentsText === '' ? 0 : parentsText.split(' ').length;
      return [
        { hash, date, parentCount, changesBody: patchChangesBody(record.slice(headerEnd + 1)) },
      ];
    });

  const across = mergesAcrossRenames(repoRoot, historyPath);

  const commits = new Map<
    string,
    { readonly date: string; readonly parentCount: number; readonly parentDiffs: boolean[] }
  >();
  for (const record of records) {
    const commit = commits.get(record.hash) ?? {
      date: record.date,
      parentCount: record.parentCount,
      parentDiffs: [],
    };
    commit.parentDiffs.push(record.changesBody);
    commits.set(record.hash, commit);
  }

  const bodyChangeDates = [...commits.values()]
    .filter((commit) => {
      if (commit.parentCount <= 1) return commit.parentDiffs.some(Boolean);
      return commit.parentDiffs.length >= commit.parentCount && commit.parentDiffs.every(Boolean);
    })
    .map((commit) => commit.date)
    .sort();

  const latest = bodyChangeDates[bodyChangeDates.length - 1];
  assertMergesCannotHideLaterChange(repoRoot, rel, across, latest);
  if (!latest) {
    throw new Error(`${rel} has no non-stamp body change in git history`);
  }
  return latest;
}

export function lastUpdatedBodyChangeFindings(
  repoRoot: string,
  stamps: readonly LastUpdatedStamp[],
  now: Date = new Date()
): string[] {
  return stamps
    .map((stamp) => ({
      ...stamp,
      latestBodyChange: latestNonStampBodyChangeDate(repoRoot, stamp.rel, now),
    }))
    .filter((stamp) => stamp.value < stamp.latestBodyChange)
    .map(
      (stamp) =>
        `${stamp.rel} stamps Last Updated ${stamp.value}, but its latest non-stamp body change is ` +
        stamp.latestBodyChange
    );
}
