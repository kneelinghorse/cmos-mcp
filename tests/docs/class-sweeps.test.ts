// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Proves class-sweep ledgers reject unclassified source and lost fixes in isolated Git trees.
// ABOUTME: Public fixtures need no private evidence, historical objects, product runtime or database.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createClassSweepFixture, step } from '../helpers/class-sweep-fixture';

const { runClassSweeps } = require('../../scripts/class-sweeps');
const { validateArtifacts } = require('../../scripts/lib/class-sweep-schema');
const { evaluateSweeps } = require('../../scripts/lib/class-sweep-evaluator');
const REPO = path.resolve(__dirname, '../..');
let root: string;
let artifacts: any[];
let fixture: ReturnType<typeof createClassSweepFixture>;
const git = (...args: string[]) => fixture.git(...args);
const put = (file: string, content: string) => fixture.put(file, content);
const save = () => fixture.save();
const arm = (id = 'readers') => fixture.arm(id);
const check = () => fixture.check();
const expectFailure = (pattern: RegExp) => {
  const result = check();
  expect(result.ok).toBe(false);
  expect(result.issues.join('\n')).toMatch(pattern);
};

beforeEach(() => {
  fixture = createClassSweepFixture();
  ({ root, artifacts } = fixture);
  expect(check().issues).toEqual([]);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('public class-sweep contract', () => {
  it('checks the real repository and all four mandatory arms', () => {
    const report = runClassSweeps(REPO);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sweeps.map((s: any) => `${s.mission}/${s.arm}`)).toEqual([
      's92-m03/readers',
      's92-m09/inserts',
      's94-m11/literal',
      's94-m11/variable',
    ]);
  });

  it('runs with one unrelated commit, no private files and unavailable recorded SHAs', () => {
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'public fixture'
    );
    expect(() => git('cat-file', '-e', 'a'.repeat(40))).toThrow();
    expect(fs.existsSync(path.join(root, 'cmos'))).toBe(false);
    expect(check()).toMatchObject({
      ok: true,
      issues: [],
      universe: { trackedFiles: 54, textFiles: 54 },
    });
  });

  it.each(['src/new.ts', 'src/new.md'])(
    'rejects a new tracked candidate across every extension: %s',
    (file) => {
      put(file, "SELECT id FROM sessions WHERE status = 'ACTIVE'\n");
      git('add', file);
      expectFailure(/unclassified|residual/);
    }
  );

  it('rejects an identical extra matching line even when the file count stays nine', () => {
    const w = arm('inserts').witnesses[0];
    put(w.file, `${w.text}\n${w.text}\n`);
    expectFailure(/multiplicity|unclassified/);
  });

  it('rejects residual syntax in a file outside the historical paths', () => {
    put('src/new.txt', '`${command} ambient off`\n');
    git('add', 'src/new.txt');
    expectFailure(/residual/);
  });

  it('requires fixed witnesses even after old predicate text vanished', () => {
    put(arm().witnesses[0].file, '// unrelated replacement\n');
    expectFailure(/witness/);
  });

  it('does not use line numbers as identities', () => {
    const w = arm().witnesses[0];
    put(w.file, `// harmless line\n\n${w.text}\n`);
    expect(check().ok).toBe(true);
  });

  it('reports a vanished historical outside occurrence without failing', () => {
    const a = arm('literal');
    a.historical.matches[0].class = 'outside';
    delete a.historical.matches[0].resolution;
    a.witnesses.shift();
    save();
    const result = check();
    expect(result.ok).toBe(true);
    expect(result.sweeps.find((s: any) => s.arm === 'literal').vanishedHistorical).toContain('h0');
  });

  it('does not multiply a current fixed token when two old sites share it', () => {
    const a = arm();
    a.historical.matches[1].resolution.witnessIds = ['w0'];
    a.witnesses.splice(1, 1);
    save();
    expect(check().ok).toBe(true);
  });

  it('explicit removal grants no permission to reintroduce old syntax elsewhere', () => {
    const a = arm();
    a.historical.matches[0].resolution = { removed: true, reason: 'Deleted obsolete path.' };
    a.witnesses.shift();
    save();
    expect(check().ok).toBe(true);
    put('src/reintroduced.txt', a.historical.matches[0].text);
    git('add', 'src/reintroduced.txt');
    expectFailure(/unclassified|residual/);
  });

  it.each(['s92-m03', 's92-m09', 's94-m11'])('refuses missing mandatory artifact %s', (id) => {
    fs.unlinkSync(path.join(root, `tests/sweeps/${id}.json`));
    expectFailure(/missing|required|read/i);
  });

  it.each([
    ['missing variable arm', () => artifacts[2].arms.pop()],
    [
      'arbitrary replacement mission',
      () => {
        artifacts[0].mission = 's92-m01';
      },
    ],
    [
      'duplicate mission',
      () => {
        artifacts[1].mission = artifacts[0].mission;
      },
    ],
    [
      'count arithmetic',
      () => {
        arm().historical.count++;
      },
    ],
    [
      'missing historical row',
      () => {
        arm().historical.matches.pop();
      },
    ],
    [
      'empty predicate',
      () => {
        arm().predicate = [];
      },
    ],
    [
      'no-op required predicate',
      () => {
        arm().predicate[0].pattern = 'never-match';
      },
    ],
    [
      'wrong required flags',
      () => {
        arm().predicate[0].flags = 'i';
      },
    ],
    [
      'unknown classification',
      () => {
        arm().historical.matches[0].class = 'safe';
      },
    ],
    [
      'missing witness reference',
      () => {
        arm().historical.matches[0].resolution.witnessIds = ['unknown'];
      },
    ],
    [
      'occurrence gap',
      () => {
        arm().witnesses[0].occurrence = 2;
      },
    ],
    [
      'duplicate witness token',
      () => {
        arm().witnesses.push({ ...arm().witnesses[0], id: 'extra' });
      },
    ],
    [
      'unsafe path',
      () => {
        arm().witnesses[0].file = 'src/../outside.ts';
      },
    ],
    [
      'unknown schema key',
      () => {
        arm().skip = true;
      },
    ],
  ] as [string, () => void][])('rejects %s', (_label, mutate) => {
    mutate();
    save();
    expect(check().ok).toBe(false);
  });

  it.each([
    ['[[:alpha:]]', ''],
    ['[^[:alpha:]]', ''],
    ['(', ''],
    ['x', 'g'],
    ['x', 'y'],
    ['x', 'ii'],
    ['x', 'q'],
    ['', ''],
  ])('rejects unsupported residual regex %s/%s', (pattern, flags) => {
    arm().residual = [step(pattern, flags)];
    save();
    expectFailure(/regex|pattern|flag|predicate/i);
  });

  it('rejects a historical left token competing with a current token', () => {
    const a = arm('inserts');
    a.historical.matches[0].text = a.witnesses[0].text;
    a.historical.matches[0].class = 'left';
    delete a.historical.matches[0].resolution;
    a.witnesses[0].class = 'left';
    save();
    expectFailure(/duplicate|overlap/);
  });

  it('applies case flags to raw source text, excluding formatted paths and line numbers', () => {
    const validated = validateArtifacts(artifacts);
    const text = fs.readFileSync(path.join(root, arm().witnesses[0].file), 'utf8');
    const input = [{ file: 'src/FROM sessions status active.ts', lines: [text] }];
    const report = evaluateSweeps(validated, input);
    expect(report.sweeps.find((s: any) => s.arm === 'readers').currentCount).toBe(0);
    put('src/case.txt', 'from sessions STATUS ACTIVE\nFROM sessions STATUS ACTIVE\n');
    git('add', 'src/case.txt');
    expect(check().sweeps.find((s: any) => s.arm === 'readers').currentCount).toBe(1);
  });

  it('reports binary and invalid UTF-8 exclusions while keeping all extensions', () => {
    put('src/binary.dat', 'a\0b');
    fs.writeFileSync(path.join(root, 'src/invalid.txt'), Buffer.from([0xff]));
    git('add', 'src');
    expect(check()).toMatchObject({
      ok: true,
      universe: {
        trackedFiles: 56,
        textFiles: 54,
        excluded: [
          { file: 'src/binary.dat', reason: 'binary NUL' },
          { file: 'src/invalid.txt', reason: 'invalid UTF-8' },
        ],
      },
    });
  });

  it('does not claim untracked source coverage or match evidence strings in artifacts', () => {
    put('src/untracked.ts', 'FROM sessions status active');
    expect(check().ok).toBe(true);
  });

  it('fails on a missing tracked source instead of silently shrinking the universe', () => {
    fs.unlinkSync(path.join(root, arm().witnesses[0].file));
    expectFailure(/read|missing|ENOENT/);
  });

  it('fails on a working-tree symlink instead of following it', () => {
    const file = path.join(root, arm().witnesses[0].file);
    fs.unlinkSync(file);
    fs.symlinkSync('/etc/hosts', file);
    expectFailure(/regular|symlink|unsafe/);
  });

  it('rejects an unmerged index entry instead of choosing a side', () => {
    const file = arm().witnesses[0].file;
    const hash = git('rev-parse', `:${file}`).toString().trim();
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      input: `0 ${'0'.repeat(40)}\t${file}\n100644 ${hash} 1\t${file}\n100644 ${hash} 2\t${file}\n`,
    });
    expectFailure(/unmerged/);
  });

  it('rejects a tracked symlink even when the working path became a regular file', () => {
    put('target.txt', 'plain data');
    fs.symlinkSync('../target.txt', path.join(root, 'src/link'));
    git('add', 'src/link');
    fs.unlinkSync(path.join(root, 'src/link'));
    put('src/link', 'plain data');
    expectFailure(/nonregular indexed/);
  });

  it('rejects a parent symlink escaping the repository', () => {
    put('src/nested/code.txt', 'plain data');
    git('add', 'src/nested');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'class-sweep-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'code.txt'), 'plain data');
      fs.rmSync(path.join(root, 'src/nested'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'src/nested'));
      expectFailure(/unsafe escaping/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('runs the actual CLI in the isolated public tree and fails on bad arguments', () => {
    for (const file of [
      'scripts/class-sweeps.js',
      'scripts/lib/class-sweep-schema.js',
      'scripts/lib/class-sweep-evaluator.js',
    ])
      put(file, fs.readFileSync(path.join(REPO, file), 'utf8'));
    const output = execFileSync(process.execPath, ['scripts/class-sweeps.js', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(JSON.parse(output).ok).toBe(true);
    expect(() =>
      execFileSync(process.execPath, ['scripts/class-sweeps.js', '--staged'], {
        cwd: root,
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('fails closed on a real read error', () => {
    const nativeFs = require('fs');
    const read = nativeFs.readFileSync;
    const target = path.join(fs.realpathSync(root), arm().witnesses[0].file);
    const spy = jest.spyOn(nativeFs, 'readFileSync').mockImplementation(((
      file: any,
      ...args: any[]
    ) => {
      if (file === target) throw new Error('injected source read failure');
      return (read as any)(file, ...args);
    }) as any);
    try {
      expectFailure(/injected source read failure/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects unknown artifact files rather than silently ignoring them', () => {
    put('tests/sweeps/unknown.json', '{}');
    expectFailure(/unknown|artifact/);
  });
});
