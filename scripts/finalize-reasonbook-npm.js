#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Completes the fixed legacy npm deprecation and inert name placeholder after Reasonbook ships.
// ABOUTME: Verifies public registry evidence without credentials before each independently retryable write.
const fs = require('node:fs');
const { constants } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');

const REGISTRY = 'https://registry.npmjs.org';
const MIGRATION =
  'https://github.com/kneelinghorse/reasonbook/blob/main/docs/migrating-from-cmos.md';
const DEPRECATION = `CMOS is now Reasonbook. Use @aquex/reasonbook. Migration: ${MIGRATION}`;
// Exact SemVer only: registry data may supply a version, never an npm tag, range or package spec.
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function placeholderFiles(root) {
  return {
    'package.json':
      JSON.stringify(
        {
          name: 'cmos-mcp',
          version: '1.0.0',
          description: 'CMOS is now Reasonbook. Install @aquex/reasonbook instead.',
          license: 'Apache-2.0',
          repository: { type: 'git', url: 'git+https://github.com/kneelinghorse/reasonbook.git' },
          bin: { 'cmos-mcp': 'bin.js' },
          files: ['bin.js', 'README.md', 'LICENSE'],
        },
        null,
        2
      ) + '\n',
    'README.md': `# CMOS is now Reasonbook\n\nThis package only prints the move notice. It does not install or start a server.\n\nInstall the new server explicitly:\n\n\`\`\`sh\nnpx --prefer-offline -y @aquex/reasonbook@4.0.0\n\`\`\`\n\n[Migration guide](${MIGRATION})\n`,
    'bin.js':
      '#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\nconsole.log("CMOS is now Reasonbook. Run explicitly: npx --prefer-offline -y @aquex/reasonbook@4.0.0");\n',
    LICENSE: fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'),
  };
}

function npmEnvironment(env, mutation) {
  const result = { ...env };
  if (!mutation) {
    delete result.NODE_AUTH_TOKEN;
    delete result.NPM_TOKEN;
  }
  return result;
}

function runNpm(args, { mutation, cwd }) {
  return spawnSync('npm', [...args, '--registry', REGISTRY], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    env: npmEnvironment(process.env, mutation),
  });
}

function readResult(result, allowAbsent = false) {
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm returned no valid JSON; refusing follow-up');
  }
  if (result.status !== 0) {
    if (allowAbsent && data?.error?.code === 'E404') return null;
    throw new Error(`npm read failed (${data?.error?.code || 'unknown'}); refusing follow-up`);
  }
  if (!data || data.error) throw new Error('npm returned invalid registry data');
  return data;
}

function failureDiagnostics(result) {
  // Treat npm output as untrusted: emit only recognized codes, never summaries or raw text.
  const npmCodes = new Set([
    'EOTP',
    'EAUTH',
    'ENEEDAUTH',
    'EPRIVATE',
    'EPUBLISHCONFLICT',
    'EUNSCOPED',
    'EUSAGE',
    'EINVALIDTAGNAME',
    'EBADSEMVER',
    'EINTEGRITY',
    'ENOTFOUND',
    'EAI_AGAIN',
  ]);
  let code;
  try {
    code = JSON.parse(result.stdout)?.error?.code;
  } catch {
    // Non-JSON output remains private; status and spawn diagnostics can still identify failure.
  }
  return {
    npmCode:
      typeof code === 'string' &&
      (/^E[45]\d{2}$/.test(code) || npmCodes.has(code) || Object.hasOwn(constants.errno, code))
        ? code
        : null,
    status:
      Number.isInteger(result.status) && result.status >= 0 && result.status <= 255
        ? result.status
        : null,
    signal:
      typeof result.signal === 'string' && Object.hasOwn(constants.signals, result.signal)
        ? result.signal
        : null,
    spawnCode:
      typeof result.error?.code === 'string' && Object.hasOwn(constants.errno, result.error.code)
        ? result.error.code
        : null,
  };
}

function verifyTarball(file, files) {
  const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(
    entries,
    Object.keys(files)
      .map((name) => `package/${name}`)
      .sort(),
    'placeholder tarball file set differs'
  );
  for (const [name, expected] of Object.entries(files)) {
    const actual = execFileSync('tar', ['-xOzf', file, `package/${name}`], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    assert.equal(actual, expected, `placeholder tarball contents differ: ${name}`);
  }
}

function verifyDirectory(dir, files) {
  assert.equal(
    JSON.stringify(fs.readdirSync(dir).sort()),
    JSON.stringify(Object.keys(files).sort()),
    'placeholder file set differs'
  );
  for (const [name, expected] of Object.entries(files)) {
    assert.ok(
      fs.lstatSync(path.join(dir, name)).isFile(),
      'placeholder must contain regular files'
    );
    assert.equal(
      fs.readFileSync(path.join(dir, name), 'utf8'),
      expected,
      `placeholder contents differ: ${name}`
    );
  }
}

function runPhase(phase, { root, scratch, runNpm: npm = runNpm }) {
  if (!['prepare', 'deprecate', 'publish', 'verify'].includes(phase))
    throw new Error('Unknown fixed follow-up phase');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (
    pkg.name !== '@aquex/reasonbook' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version) ||
    Number(pkg.version.split('.')[0]) < 4
  ) {
    throw new Error('Follow-up requires the stable @aquex/reasonbook release, version 4 or later');
  }
  const read = (spec, allowAbsent = false) =>
    readResult(npm(['view', spec, '--json'], { mutation: false, cwd: scratch }), allowAbsent);
  const readLegacyVersions = () => {
    const name = '@aquex/cmos-mcp';
    const legacy = read(name);
    assert.ok(legacy.name === name, 'unexpected legacy package');
    const versions = legacy.versions;
    assert.ok(
      Array.isArray(versions) &&
        versions.length > 0 &&
        versions.every((version) => typeof version === 'string' && EXACT_VERSION.test(version)) &&
        new Set(versions).size === versions.length,
      'legacy version list must contain unique exact versions'
    );
    return versions.map((version) => {
      const entry = read(`${name}@${version}`);
      assert.ok(
        entry.name === name && entry.version === version,
        'legacy version metadata does not match requested package and version'
      );
      return entry;
    });
  };
  const legacyCountingRule =
    'each unique version listed in @aquex/cmos-mcp metadata, read and verified by exact version (including prereleases)';
  const published = read(`@aquex/reasonbook@${pkg.version}`);
  assert.equal(published.name, pkg.name, 'published target name differs');
  assert.equal(published.version, pkg.version, 'published target version differs');
  assert.equal(published.mcpName, 'ai.aquex/reasonbook', 'published registry namespace differs');

  const files = placeholderFiles(root);
  const existing = read('cmos-mcp', true);
  if (existing) {
    assert.ok(
      existing.name === 'cmos-mcp' &&
        existing.version === '1.0.0' &&
        JSON.stringify(existing.versions) === '["1.0.0"]' &&
        JSON.stringify(existing.maintainers?.map((person) => person.name).sort()) ===
          '["kneelinghorse"]',
      'placeholder collision: fixed version or maintainer differs'
    );
    const downloads = fs.mkdtempSync(path.join(scratch, 'verify-'));
    try {
      const packed = readResult(
        npm(
          ['pack', 'cmos-mcp@1.0.0', '--ignore-scripts', '--json', '--pack-destination', downloads],
          { mutation: false, cwd: scratch }
        )
      );
      assert.equal(packed.length, 1, 'expected one registry tarball');
      assert.equal(
        packed[0].filename,
        'cmos-mcp-1.0.0.tgz',
        'unexpected registry tarball filename'
      );
      verifyTarball(path.join(downloads, packed[0].filename), files);
    } finally {
      fs.rmSync(downloads, { recursive: true, force: true });
    }
  }
  const dir = path.join(scratch, 'placeholder');
  const mutate = (args) => {
    const result = npm([...args, '--json'], { mutation: true, cwd: scratch });
    if (result.status !== 0)
      throw new Error(
        `npm ${args[0]} failed (${JSON.stringify(failureDiagnostics(result))}); no success claimed. Retry verifies the registry again.`
      );
  };
  if (phase === 'prepare') {
    if (!existing) {
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(files))
        fs.writeFileSync(path.join(dir, name), content, {
          mode: name === 'bin.js' ? 0o755 : 0o644,
        });
      verifyDirectory(dir, files);
    }
    return { placeholder: existing ? 'verified-existing' : 'prepared' };
  }
  if (phase === 'deprecate') {
    const versions = readLegacyVersions();
    if (versions.every((version) => version.deprecated === DEPRECATION))
      return {
        deprecation: 'verified-existing',
        deprecatedVersions: versions.length,
        countingRule: legacyCountingRule,
      };
    mutate(['deprecate', '@aquex/cmos-mcp@*', DEPRECATION]);
    return { deprecation: 'submitted' };
  }
  if (phase === 'publish') {
    if (existing) return { placeholder: 'verified-existing' };
    verifyDirectory(dir, files);
    mutate([
      'publish',
      dir,
      '--ignore-scripts',
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance=false',
    ]);
    return { placeholder: 'submitted' };
  }
  assert.ok(existing, 'placeholder is not published');
  const versions = readLegacyVersions();
  for (const version of versions) {
    assert.equal(version.deprecated, DEPRECATION, `missing deprecation on ${version.version}`);
  }
  return {
    placeholder: 'verified-existing',
    deprecatedVersions: versions.length,
    countingRule: legacyCountingRule,
  };
}

if (require.main === module) {
  try {
    if (
      process.argv.length !== 3 ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REPOSITORY !== 'kneelinghorse/reasonbook-pro' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      !process.env.RUNNER_TEMP
    ) {
      throw new Error('Run only the fixed workflow on the private repository main branch');
    }
    console.log(
      JSON.stringify(
        runPhase(process.argv[2], {
          root: path.resolve(__dirname, '..'),
          scratch: process.env.RUNNER_TEMP,
        }),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { placeholderFiles, verifyTarball, runPhase, readResult, npmEnvironment };
