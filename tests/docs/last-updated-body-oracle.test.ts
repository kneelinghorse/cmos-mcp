// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves Last Updated stamps follow non-stamp body changes, not release dates or stamp edits.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  lastUpdatedBodyChangeFindings,
  latestNonStampBodyChangeDate,
} from './last-updated-body-oracle';

const DOC = 'docs/guide.md';

function git(repo: string, args: readonly string[], date?: string): void {
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=CMOS Test',
      '-c',
      'user.email=test@example.com',
      ...args,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: date
        ? {
            ...process.env,
            GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
            GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
          }
        : process.env,
      stdio: 'pipe',
    }
  );
}

function writeGuide(repo: string, stamp: string, body: string): void {
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, DOC), `# Guide\n\n${body}\n\n**Last Updated**: ${stamp}\n`);
}

function currentBranch(repo: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

describe('Last Updated body-change oracle', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'last-updated-oracle-'));
    git(repo, ['init', '--quiet']);
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## [1.0.0] — 2026-01-01\n');
    writeGuide(repo, '2026-01-01', 'Original body.');
    git(repo, ['add', 'CHANGELOG.md', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'initial'], '2026-01-01');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('fires when a committed body edit is newer than the unchanged stamp', () => {
    writeGuide(repo, '2026-01-01', 'Body changed after the stamp.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit body'], '2026-01-02');

    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: DOC, value: '2026-01-01' }])).toEqual([
      'docs/guide.md stamps Last Updated 2026-01-01, but its latest non-stamp body change is 2026-01-02',
    ]);
  });

  it('counts body text that resembles a unified-diff file header', () => {
    writeGuide(repo, '2026-01-01', 'Original body.\n++ b/example.md');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'add header-shaped prose'], '2026-01-02');

    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: DOC, value: '2026-01-01' }])).toEqual([
      'docs/guide.md stamps Last Updated 2026-01-01, but its latest non-stamp body change is 2026-01-02',
    ]);
  });

  it('ignores a stamp-only repair from a malformed historical value', () => {
    writeGuide(repo, 'TBD', 'Original body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'leave placeholder stamp'], '2026-01-02');

    writeGuide(repo, '2026-01-03', 'Original body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'repair stamp value'], '2026-01-03');

    expect(latestNonStampBodyChangeDate(repo, DOC)).toBe('2026-01-01');
  });

  it('ignores a later commit that changes only the stamp', () => {
    writeGuide(repo, '2026-01-01', 'Body changed after the stamp.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit body'], '2026-01-02');

    writeGuide(repo, '2026-01-02', 'Body changed after the stamp.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'refresh stamp'], '2026-01-03');

    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: DOC, value: '2026-01-02' }])).toEqual([]);
  });

  it('treats an uncommitted body edit as a change today', () => {
    writeGuide(repo, '2026-01-01', 'Uncommitted body edit.');

    expect(
      lastUpdatedBodyChangeFindings(
        repo,
        [{ rel: DOC, value: '2026-01-01' }],
        new Date(2026, 0, 2, 12)
      )
    ).toEqual([
      'docs/guide.md stamps Last Updated 2026-01-01, but its latest non-stamp body change is 2026-01-02',
    ]);
  });

  it('does not treat an uncommitted stamp-only edit as a body change', () => {
    writeGuide(repo, '2026-01-02', 'Original body.');

    expect(
      lastUpdatedBodyChangeFindings(
        repo,
        [{ rel: DOC, value: '2026-01-02' }],
        new Date(2026, 0, 3, 12)
      )
    ).toEqual([]);
  });

  it('follows a renamed file and still finds the body-changing commit', () => {
    const renamed = 'docs/renamed-guide.md';
    fs.renameSync(path.join(repo, DOC), path.join(repo, renamed));
    fs.appendFileSync(path.join(repo, renamed), '\nBody changed during rename.\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'rename and edit body'], '2026-01-02');

    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: renamed, value: '2026-01-01' }])).toEqual([
      'docs/renamed-guide.md stamps Last Updated 2026-01-01, but its latest non-stamp body change is 2026-01-02',
    ]);
  });

  it('does not advance the body date for a staged pure rename', () => {
    writeGuide(repo, '2026-01-02', 'Body changed with its stamp.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit body and stamp'], '2026-01-02');

    const renamed = 'docs/pure-rename.md';
    fs.renameSync(path.join(repo, DOC), path.join(repo, renamed));
    git(repo, ['add', '-A']);

    expect(
      lastUpdatedBodyChangeFindings(
        repo,
        [{ rel: renamed, value: '2026-01-02' }],
        new Date(2026, 0, 3, 12)
      )
    ).toEqual([]);

    git(repo, ['commit', '--quiet', '-m', 'pure rename'], '2026-01-03');
    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: renamed, value: '2026-01-02' }])).toEqual(
      []
    );
  });

  it('fires when a merge conflict is resolved with a unique body edit', () => {
    const mainBranch = currentBranch(repo);

    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    writeGuide(repo, '2026-01-01', 'Feature body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit body on feature'], '2026-01-02');

    git(repo, ['checkout', '--quiet', mainBranch]);
    writeGuide(repo, '2026-01-01', 'Main body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit body on main'], '2026-01-02');

    expect(() => git(repo, ['merge', '--no-commit', 'feature'])).toThrow();
    writeGuide(repo, '2026-01-01', 'Unique conflict resolution body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'resolve guide conflict'], '2026-01-03');

    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: DOC, value: '2026-01-02' }])).toEqual([
      'docs/guide.md stamps Last Updated 2026-01-02, but its latest non-stamp body change is 2026-01-03',
    ]);
  });

  it('fails loudly when --follow omits a merge after one parent renamed the file', () => {
    const mainBranch = currentBranch(repo);
    const renamed = 'docs/renamed.md';

    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    git(repo, ['mv', DOC, renamed]);
    git(repo, ['add', renamed]);
    git(repo, ['commit', '--quiet', '-m', 'rename on feature'], '2026-01-02');

    git(repo, ['checkout', '--quiet', mainBranch]);
    writeGuide(repo, '2026-01-02', 'Main body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit old path on main'], '2026-01-02');

    git(repo, ['merge', '--quiet', '--no-commit', '--no-ff', 'feature']);
    fs.rmSync(path.join(repo, DOC), { force: true });
    fs.writeFileSync(
      path.join(repo, renamed),
      '# Guide\n\nUnique renamed conflict resolution.\n\n**Last Updated**: 2026-01-02\n'
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'resolve renamed guide conflict'], '2026-01-03');

    expect(() =>
      lastUpdatedBodyChangeFindings(repo, [{ rel: renamed, value: '2026-01-02' }])
    ).toThrow('git --follow cannot prove merge history across renamed paths');
  });

  it('fails loudly for the mirror topology that keeps the original parent path', () => {
    const mainBranch = currentBranch(repo);
    const renamed = 'docs/renamed.md';

    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    git(repo, ['mv', DOC, renamed]);
    git(repo, ['add', renamed]);
    git(repo, ['commit', '--quiet', '-m', 'rename on feature'], '2026-01-02');

    git(repo, ['checkout', '--quiet', mainBranch]);
    writeGuide(repo, '2026-01-02', 'Main body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit old path on main'], '2026-01-02');

    git(repo, ['merge', '--quiet', '--no-commit', '--no-ff', 'feature']);
    fs.rmSync(path.join(repo, renamed), { force: true });
    writeGuide(repo, '2026-01-02', 'Unique resolution on the original path.');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--quiet', '-m', 'resolve merge at original path'], '2026-01-03');

    expect(() => lastUpdatedBodyChangeFindings(repo, [{ rel: DOC, value: '2026-01-02' }])).toThrow(
      'git --follow cannot prove merge history across renamed paths'
    );
  });

  it('does not advance to an ordinary merge whose body equals one parent', () => {
    const mainBranch = currentBranch(repo);

    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    writeGuide(repo, '2026-01-02', 'Feature body adopted unchanged by the merge.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit body on feature'], '2026-01-02');

    git(repo, ['checkout', '--quiet', mainBranch]);
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'main branch work\n');
    git(repo, ['add', 'main-only.txt']);
    git(repo, ['commit', '--quiet', '-m', 'change another file on main'], '2026-01-03');
    git(repo, ['merge', '--quiet', '--no-edit', 'feature'], '2026-01-04');

    expect(lastUpdatedBodyChangeFindings(repo, [{ rel: DOC, value: '2026-01-02' }])).toEqual([]);
    expect(latestNonStampBodyChangeDate(repo, DOC)).toBe('2026-01-02');
  });

  it('ignores a merge conflict whose resolution changes only the stamp', () => {
    const mainBranch = currentBranch(repo);

    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    writeGuide(repo, '2026-01-02', 'Original body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'refresh feature stamp'], '2026-01-02');

    git(repo, ['checkout', '--quiet', mainBranch]);
    writeGuide(repo, '2026-01-03', 'Original body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'refresh main stamp'], '2026-01-03');

    expect(() => git(repo, ['merge', '--no-commit', 'feature'])).toThrow();
    writeGuide(repo, '2026-01-04', 'Original body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'resolve stamp conflict'], '2026-01-04');

    expect(latestNonStampBodyChangeDate(repo, DOC)).toBe('2026-01-01');
  });

  it('does not count a merge body that normalizes to one parent despite a unique stamp', () => {
    const mainBranch = currentBranch(repo);

    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    writeGuide(repo, '2026-01-02', 'Feature body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit feature body and stamp'], '2026-01-02');

    git(repo, ['checkout', '--quiet', mainBranch]);
    writeGuide(repo, '2026-01-02', 'Main body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'edit main body and stamp'], '2026-01-02');

    expect(() => git(repo, ['merge', '--no-commit', 'feature'])).toThrow();
    writeGuide(repo, '2026-01-03', 'Main body.');
    git(repo, ['add', DOC]);
    git(repo, ['commit', '--quiet', '-m', 'resolve to main body with new stamp'], '2026-01-03');

    expect(latestNonStampBodyChangeDate(repo, DOC)).toBe('2026-01-02');
  });

  it('fails loudly when a stamped file is not tracked', () => {
    const untracked = 'docs/untracked.md';
    writeGuide(repo, '2026-01-01', 'Original body.');
    fs.copyFileSync(path.join(repo, DOC), path.join(repo, untracked));

    expect(() =>
      lastUpdatedBodyChangeFindings(repo, [{ rel: untracked, value: '2026-01-01' }])
    ).toThrow('docs/untracked.md is not tracked by git');
  });

  it('fails loudly when history is shallow', () => {
    const cloneParent = fs.mkdtempSync(path.join(os.tmpdir(), 'last-updated-shallow-'));
    const shallowRepo = path.join(cloneParent, 'repo');
    try {
      execFileSync(
        'git',
        ['clone', '--quiet', '--depth', '1', pathToFileURL(repo).href, shallowRepo],
        {
          encoding: 'utf8',
          stdio: 'pipe',
        }
      );

      expect(() =>
        lastUpdatedBodyChangeFindings(shallowRepo, [{ rel: DOC, value: '2026-01-01' }])
      ).toThrow('requires complete git history, not a shallow clone');
    } finally {
      fs.rmSync(cloneParent, { recursive: true, force: true });
    }
  });
});
