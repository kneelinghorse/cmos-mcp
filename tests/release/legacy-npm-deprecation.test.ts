// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Legacy deprecation verifies each listed version, including prereleases, before any npm write.
// ABOUTME: Real npm metadata shapes prevent a latest-only response from claiming all versions are complete.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { runPhase } = require('../../scripts/finalize-reasonbook-npm');
const root = path.resolve(__dirname, '../..');
let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-deprecation-'));
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
test.each([
  ['stable and prerelease versions', ['3.3.0-rc.1', '3.4.0', '3.5.0']],
  ['one version', ['3.5.0']],
])('completed deprecation reads each exact version: %s', (_name, versions) => {
  const dir = localRoot();
  const records = (versions as string[]).map((version) => ({
    ...legacyVersion,
    version,
    deprecated: deprecation,
  }));
  const runNpm = jest.fn((args: string[], options: { mutation: boolean }) => {
    expect(options.mutation).toBe(false);
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp') return absent;
    return legacyRead(args, records);
  });
  expect(runPhase('deprecate', { root: dir, scratch, runNpm })).toEqual({
    deprecation: 'verified-existing',
    deprecatedVersions: versions.length,
    countingRule:
      'each unique version listed in @aquex/cmos-mcp metadata, read and verified by exact version (including prereleases)',
  });
  expect(runNpm.mock.calls.slice(2).map(([args]) => args)).toEqual([
    ['view', legacyVersion.name, '--json'],
    ...(versions as string[]).map((version) => [
      'view',
      `${legacyVersion.name}@${version}`,
      '--json',
    ]),
  ]);
});
test.each([
  ['missing pointer', undefined],
  ['different pointer', 'Use another package'],
])('latest correct but older %s still makes exactly one fixed mutation', (_name, deprecated) => {
  const dir = localRoot();
  const records = [
    { ...legacyVersion, version: '3.3.0-rc.1', deprecated },
    { ...legacyVersion, deprecated: deprecation },
  ];
  const runNpm = jest.fn((args: string[]) => {
    if (args[0] !== 'view') return ok({});
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp') return absent;
    return legacyRead(args, records);
  });
  expect(runPhase('deprecate', { root: dir, scratch, runNpm })).toEqual({
    deprecation: 'submitted',
  });
  expect(
    runNpm.mock.calls.filter((call: any[]) => call[1].mutation).map((call: any[]) => call[0])
  ).toEqual([['deprecate', `${legacyVersion.name}@*`, deprecation, '--json']]);
  expect(runNpm.mock.calls.slice(2, -1).map((call: any[]) => call[0])).toEqual([
    ['view', legacyVersion.name, '--json'],
    ['view', `${legacyVersion.name}@3.3.0-rc.1`, '--json'],
    ['view', `${legacyVersion.name}@3.5.0`, '--json'],
  ]);
});
test.each([
  ['missing', undefined],
  ['empty', []],
  ['non-array', '3.5.0'],
  ['non-string', [35]],
  ['duplicate', ['3.5.0', '3.5.0']],
  ['tag', ['latest']],
  ['range', ['^3.5.0']],
  ['foreign spec', ['@other/package@1.0.0']],
  ['path', ['file:../package']],
  ['whitespace', ['3.5.0 --registry=https://evil.invalid']],
  ['leading zero', ['03.5.0']],
  ['invalid numeric prerelease', ['3.3.0-rc.01']],
])('a %s version list refuses before any data-derived query or mutation', (_name, versions) => {
  const dir = localRoot();
  const runNpm = jest.fn((args: string[]) => {
    if (args[0] !== 'view') return ok({});
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp') return absent;
    return ok({ ...legacyVersion, deprecated: deprecation, versions });
  });
  expect(() => runPhase('deprecate', { root: dir, scratch, runNpm })).toThrow();
  expect(runNpm).toHaveBeenCalledTimes(3);
  expect(runNpm.mock.calls.filter((call: any[]) => call[1].mutation)).toHaveLength(0);
});
test.each([
  [
    'metadata refusal',
    'metadata',
    { ...absent, stdout: JSON.stringify({ error: { code: 'E403' } }) },
  ],
  ['metadata unreadable JSON', 'metadata', { status: 0, stdout: 'not JSON', stderr: '' }],
  ['metadata wrong package', 'metadata', ok({ name: '@other/package', versions: ['3.5.0'] })],
  [
    'version refusal',
    'version',
    { ...absent, stdout: JSON.stringify({ error: { code: 'E403' } }) },
  ],
  ['version unreadable JSON', 'version', { status: 0, stdout: 'not JSON', stderr: '' }],
  [
    'version wrong package',
    'version',
    ok({ name: '@other/package', version: '3.5.0', deprecated: deprecation }),
  ],
  [
    'version mismatch',
    'version',
    ok({ ...legacyVersion, version: '3.4.0', deprecated: deprecation }),
  ],
])('legacy %s refuses before any deprecation mutation', (_name, stage, invalid) => {
  const dir = localRoot();
  const runNpm = jest.fn((args: string[]) => {
    if (args[0] !== 'view') return ok({});
    if (args[1] === '@aquex/reasonbook@4.0.0') return ok(release);
    if (args[1] === 'cmos-mcp') return absent;
    const metadata = args[1] === legacyVersion.name || args[1] === `${legacyVersion.name}@*`;
    if (
      (metadata ? 'metadata' : 'version') === stage &&
      (metadata || args[1] === `${legacyVersion.name}@${legacyVersion.version}`)
    )
      return invalid;
    return legacyRead(args, [
      { ...legacyVersion, version: '3.3.0-rc.1' },
      { ...legacyVersion, deprecated: deprecation },
    ]);
  });
  expect(() => runPhase('deprecate', { root: dir, scratch, runNpm })).toThrow();
  expect(runNpm.mock.calls.filter((call: any[]) => call[1].mutation)).toHaveLength(0);
});
