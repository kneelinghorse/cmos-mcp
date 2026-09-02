import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { requiresPrivateEvidence } from '../helpers/public-mirror';

type PackageJsonExports = {
  [key: string]:
    | string
    | {
        types?: string;
        require?: string;
        default?: string;
      };
};

type PackageJson = {
  version?: string;
  main?: string;
  types?: string;
  exports?: PackageJsonExports;
  files?: string[];
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PackageLock = {
  version?: string;
  packages?: Record<string, { version?: string }>;
};

interface MarkdownVersionStamp {
  readonly relativePath: string;
  readonly line: number;
  readonly label: string;
  readonly value: string;
  readonly lastUpdated?: string;
}

interface VersionLedgerRow {
  readonly source: string;
  readonly value: string;
  readonly disposition: 'AUTHORITY' | 'ASSERTED' | 'EXCLUDED' | 'BOUNDARY_ONLY' | 'UNCLASSIFIED';
  readonly rule: string;
  readonly valid: boolean;
}

interface ReleaseVersionState {
  readonly packageVersion: string;
  readonly lockVersion: string;
  readonly lockSelfVersion: string;
  readonly changelog: string;
  readonly stamps: readonly MarkdownVersionStamp[];
  readonly newestTag?: string;
}

const projectRoot = path.resolve(__dirname, '..', '..');
const PRIVATE = requiresPrivateEvidence({
  reason:
    'release authority documents and private version stamps are absent from the public mirror',
  paths: {
    workflow: '.github/workflows/publish.yml',
    releaseRunbook: 'cmos/docs/release.md',
    agents: 'agents.md',
    buildSessionPrompt: 'cmos/docs/build-session-prompt.md',
    templateScaffold: 'cmos/templates/agents.md',
  },
});

const VERSION_STAMP_PATTERN =
  /^\*\*((?:[A-Za-z]+ )?Version)\*\*:[ \t]*([0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/gm;
const DATED_CHANGELOG_HEADING =
  /^##\s*\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\]?\s*[—-]\s*(\d{4}-\d{2}-\d{2})/m;
const RECORD_TREE_PREFIXES = [
  'cmos/db/',
  'cmos/planning/',
  'cmos/docs/archive/',
  'cmos/research/',
] as const;
const UNFILLED_SCAFFOLD_PATH = 'cmos/templates/agents.md';
const RELEASE_GATE_COMMAND =
  'npx jest tests/release/publish-pipeline.test.ts --coverage=false --runInBand';

function readTextFile(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function isInVersionSweep(relativePath: string): boolean {
  return !RECORD_TREE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function scanMarkdownVersionStamps(files: readonly string[]): MarkdownVersionStamp[] {
  const stamps: MarkdownVersionStamp[] = [];
  for (const relativePath of files.filter(
    (candidate) => isInVersionSweep(candidate) && candidate.endsWith('.md')
  )) {
    const content = readTextFile(relativePath);
    const lastUpdated = content.match(/^\*\*Last Updated\*\*:\s*(.*?)\s*$/m)?.[1];
    for (const match of content.matchAll(new RegExp(VERSION_STAMP_PATTERN))) {
      stamps.push({
        relativePath,
        line: content.slice(0, match.index).split('\n').length,
        label: match[1],
        value: match[2],
        lastUpdated,
      });
    }
  }
  return stamps;
}

function loadReleaseVersionState(): ReleaseVersionState {
  const pkg = JSON.parse(readTextFile('package.json')) as PackageJson;
  const lock = JSON.parse(readTextFile('package-lock.json')) as PackageLock;
  const files = trackedFiles();
  const newestTag = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)[0];

  return {
    packageVersion: pkg.version ?? '',
    lockVersion: lock.version ?? '',
    lockSelfVersion: lock.packages?.['']?.version ?? '',
    changelog: readTextFile('CHANGELOG.md'),
    stamps: scanMarkdownVersionStamps(files),
    newestTag,
  };
}

function evaluateReleaseVersionClass(state: ReleaseVersionState): {
  rows: VersionLedgerRow[];
  failures: string[];
} {
  const rows: VersionLedgerRow[] = [];
  const add = (
    source: string,
    value: string,
    disposition: VersionLedgerRow['disposition'],
    rule: string,
    valid: boolean
  ): void => {
    rows.push({ source, value, disposition, rule, valid });
  };

  add(
    'package.json $.version',
    state.packageVersion,
    'AUTHORITY',
    'non-empty semver authority',
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      state.packageVersion
    )
  );
  add(
    'package-lock.json $.version',
    state.lockVersion,
    'ASSERTED',
    'exactly equals package.json $.version',
    state.lockVersion === state.packageVersion
  );
  add(
    'package-lock.json $.packages[""].version',
    state.lockSelfVersion,
    'ASSERTED',
    'exactly equals package.json $.version',
    state.lockSelfVersion === state.packageVersion
  );

  const datedHeading = state.changelog.match(DATED_CHANGELOG_HEADING);
  add(
    'CHANGELOG.md newest dated heading',
    datedHeading?.[1] ?? '<not located>',
    'ASSERTED',
    'newest dated heading exactly equals package.json $.version; UNRELEASED headings do not participate',
    datedHeading?.[1] === state.packageVersion
  );

  for (const stamp of state.stamps) {
    const source = `${stamp.relativePath}:${stamp.line} **${stamp.label}**`;
    if (stamp.label === 'Schema Version' || stamp.label === 'Template Version') {
      add(
        source,
        stamp.value,
        'EXCLUDED',
        `${stamp.label} is an adjacent schema/template-format axis`,
        true
      );
      continue;
    }
    if (
      stamp.relativePath === UNFILLED_SCAFFOLD_PATH &&
      stamp.label === 'Version' &&
      /^\[[^\]]+\]$/.test(stamp.lastUpdated ?? '')
    ) {
      add(
        source,
        stamp.value,
        'EXCLUDED',
        `unfilled scaffold while Last Updated remains ${stamp.lastUpdated}`,
        true
      );
      continue;
    }
    if (stamp.label === 'Version') {
      add(
        source,
        stamp.value,
        'ASSERTED',
        'exactly equals package.json $.version',
        stamp.value === state.packageVersion
      );
      continue;
    }
    if (stamp.label === 'CMOS Version') {
      add(
        source,
        stamp.value,
        'ASSERTED',
        'major.minor prefix of package.json $.version',
        state.packageVersion.startsWith(`${stamp.value}.`)
      );
      continue;
    }
    add(
      source,
      stamp.value,
      'UNCLASSIFIED',
      'UNCLASSIFIED version-shaped stamp — assign a mechanical rule',
      false
    );
  }

  add(
    'git newest v* tag',
    state.newestTag ?? '<not observable here>',
    'BOUNDARY_ONLY',
    'checked against package.json by publish.yml and mirror-to-public.sh only during release operations',
    true
  );

  return {
    rows,
    failures: rows
      .filter((row) => !row.valid)
      .map((row) => `${row.source} has ${JSON.stringify(row.value)}; rule: ${row.rule}`),
  };
}

function missingDeclaredStamps(
  stamps: readonly MarkdownVersionStamp[],
  expected: ReadonlyArray<{ relativePath: string; label: string }>
): string[] {
  const located = new Set(stamps.map((stamp) => `${stamp.relativePath}\0${stamp.label}`));
  return expected
    .filter((target) => !located.has(`${target.relativePath}\0${target.label}`))
    .map((target) => `${target.relativePath} **${target.label}**`);
}

function runbookUsesCanonicalReleaseGate(runbook: string): boolean {
  return (
    runbook.includes(RELEASE_GATE_COMMAND) &&
    !runbook.includes('package.json and package-lock.json versions differ') &&
    !/lock\.version\s*!==\s*pkg\.version/.test(runbook)
  );
}

/**
 * s90-m06 — one ledger for the release-version class.
 *
 * SCOPE. The authority is package.json. Continuous checkout state includes both package-lock
 * roots, the newest DATED CHANGELOG heading, and bold Markdown Version/CMOS Version stamps.
 * Schema Version and Template Version are neighbouring axes, not release versions; an unfilled
 * scaffold is excluded only while its own Last Updated value is bracketed. The broad locator
 * still prints all of them so an exclusion cannot make a matching site disappear. Git tags are
 * boundary-only state: the ordinary pre-tag release commit legitimately has a newer package than
 * the newest tag, so this gate verifies the two executable tag guards instead of asserting an
 * always-wrong checkout equality.
 *
 * PUBLIC MIRROR. The scanner derives its universe from the checkout's own tracked files. Private
 * targets removed by mirror-to-public.sh are therefore not invented as a numeric floor; package,
 * lockfile, CHANGELOG, seed-axis exclusions, and the mirror tag guard remain fully asserted. The
 * private arm separately requires every declared private stamp to be located.
 *
 * FALSE-NEGATIVE PROFILE. Prose version tokens outside the declared JSON/heading/bold-stamp
 * shapes are invisible. The published npm artifact and the public mirror's own remote objects are
 * outside this checkout. src/index.ts's fallback version on a broken package read is runtime
 * behaviour, not a stamp. Tag equality is transitive through the release-only workflow/script
 * guards. Finally, this checks the resulting values, not whether an operator used `npm version`.
 * Deleting this entire describe is not independently detected; the mutation controls below make
 * partial or vacuous implementations fail but cannot prove their own file still exists.
 */
describe('release-version class', () => {
  test('classifies every located signal and validates every continuous member', () => {
    const files = trackedFiles();
    const sweptFiles = files.filter(isInVersionSweep);
    const state = loadReleaseVersionState();
    const evaluation = evaluateReleaseVersionClass(state);

    expect(files.length).toBeGreaterThan(0);
    expect(sweptFiles.length).toBeGreaterThan(0);
    expect(state.stamps.length).toBeGreaterThan(0);
    expect(evaluation.rows).toHaveLength(state.stamps.length + 5);
    expect(evaluation.failures).toEqual([]);

    console.log(
      [
        `[release-version class] tracked=${files.length} swept=${sweptFiles.length} rawSignals=${evaluation.rows.length}`,
        ...evaluation.rows.map(
          (row) => `  ${row.disposition} ${row.source}=${JSON.stringify(row.value)} — ${row.rule}`
        ),
      ].join('\n')
    );
  });

  test('turns red when package.json alone is bumped', () => {
    const state = loadReleaseVersionState();
    const evaluation = evaluateReleaseVersionClass({
      ...state,
      packageVersion: '99.99.99',
    });

    expect(evaluation.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('package-lock.json $.version'),
        expect.stringContaining('package-lock.json $.packages[""].version'),
        expect.stringContaining('CHANGELOG.md newest dated heading'),
      ])
    );
  });

  test('ignores an UNRELEASED accumulation heading but rejects a wrong dated heading', () => {
    const state = loadReleaseVersionState();
    const withUnreleasedHeading = {
      ...state,
      changelog: `## 99.99.99 — UNRELEASED\n\n${state.changelog}`,
    };
    expect(evaluateReleaseVersionClass(withUnreleasedHeading).failures).toEqual([]);

    const dated = state.changelog.match(DATED_CHANGELOG_HEADING);
    expect(dated).not.toBeNull();
    const wrongDatedHeading = state.changelog.replace(
      dated?.[0] ?? '',
      (dated?.[0] ?? '').replace(dated?.[1] ?? '', '99.99.99')
    );
    expect(
      evaluateReleaseVersionClass({ ...state, changelog: wrongDatedHeading }).failures
    ).toEqual([expect.stringContaining('CHANGELOG.md newest dated heading')]);
  });

  test('accepts the runbook-supported prerelease SemVer shape', () => {
    const state = loadReleaseVersionState();
    const dated = state.changelog.match(DATED_CHANGELOG_HEADING);
    expect(dated).not.toBeNull();
    const stable = state.packageVersion.split(/[+-]/, 1)[0];
    const [major, minor] = stable.split('.');
    const prerelease = `${stable}-rc.1`;
    const changelog = state.changelog.replace(
      dated?.[0] ?? '',
      (dated?.[0] ?? '').replace(dated?.[1] ?? '', prerelease)
    );
    const stamps = state.stamps.map((stamp) => {
      if (stamp.label === 'Version' && stamp.relativePath !== UNFILLED_SCAFFOLD_PATH) {
        return { ...stamp, value: prerelease };
      }
      if (stamp.label === 'CMOS Version') {
        return { ...stamp, value: `${major}.${minor}` };
      }
      return stamp;
    });

    expect(
      evaluateReleaseVersionClass({
        ...state,
        packageVersion: prerelease,
        lockVersion: prerelease,
        lockSelfVersion: prerelease,
        changelog,
        stamps,
      }).failures
    ).toEqual([]);
  });

  test('keeps the public mirror tag argument coupled to package.json at release time', () => {
    const mirrorScript = readTextFile('scripts/mirror-to-public.sh');
    expect(mirrorScript).toMatch(/SEMVER="\$\{VERSION#v\}"/);
    expect(mirrorScript).toMatch(/PKG_VERSION=.*require\('\.\/package\.json'\)\.version/);
    expect(mirrorScript).toMatch(/\[\[ "\$SEMVER" == "\$PKG_VERSION" \]\]/);
  });

  test('keeps the package files allowlist non-empty for the runbook gate', () => {
    const pkg = JSON.parse(readTextFile('package.json')) as PackageJson;
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files?.length).toBeGreaterThan(0);
  });

  PRIVATE.describe('private release-version members and release entrypoint', () => {
    const declaredPrivateStamps = [
      { relativePath: PRIVATE.relativePaths.agents, label: 'Version' },
      { relativePath: PRIVATE.relativePaths.buildSessionPrompt, label: 'CMOS Version' },
      { relativePath: PRIVATE.relativePaths.templateScaffold, label: 'Version' },
    ] as const;

    test('locates every declared private stamp before applying its rule', () => {
      const state = loadReleaseVersionState();
      expect(PRIVATE.relativePaths.templateScaffold).toBe(UNFILLED_SCAFFOLD_PATH);
      expect(missingDeclaredStamps(state.stamps, declaredPrivateStamps)).toEqual([]);

      const withoutAgents = state.stamps.filter(
        (stamp) => stamp.relativePath !== PRIVATE.relativePaths.agents
      );
      expect(missingDeclaredStamps(withoutAgents, declaredPrivateStamps)).toEqual([
        `${PRIVATE.relativePaths.agents} **Version**`,
      ]);
    });

    test('re-enters a filled scaffold into the exact-version class', () => {
      const state = loadReleaseVersionState();
      const filledScaffold = state.stamps.map((stamp) =>
        stamp.relativePath === PRIVATE.relativePaths.templateScaffold && stamp.label === 'Version'
          ? { ...stamp, lastUpdated: '2026-09-01' }
          : stamp
      );
      const evaluation = evaluateReleaseVersionClass({ ...state, stamps: filledScaffold });
      expect(evaluation.failures).toEqual([
        expect.stringContaining(PRIVATE.relativePaths.templateScaffold),
      ]);

      const disguisedAuthority = state.stamps.map((stamp) =>
        stamp.relativePath === PRIVATE.relativePaths.agents
          ? { ...stamp, value: '1.0.0', lastUpdated: '[Date]' }
          : stamp
      );
      expect(
        evaluateReleaseVersionClass({ ...state, stamps: disguisedAuthority }).failures
      ).toEqual([expect.stringContaining(PRIVATE.relativePaths.agents)]);
    });

    test('keeps the private tag workflow and runbook on the canonical gate', () => {
      const workflow = fs.readFileSync(PRIVATE.paths.workflow, 'utf8');
      const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');

      expect(workflow).toMatch(/TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/);
      expect(workflow).toMatch(/PACKAGE_VERSION=.*require\('\.\/package\.json'\)\.version/);
      expect(workflow).toMatch(/"\$TAG_VERSION" != "\$PACKAGE_VERSION"/);
      expect(runbookUsesCanonicalReleaseGate(runbook)).toBe(true);

      const restoredInlineCopy = runbook.replace(
        RELEASE_GATE_COMMAND,
        'node -e "if (lock.version !== pkg.version) throw new Error(\'package.json and package-lock.json versions differ\')"'
      );
      expect(runbookUsesCanonicalReleaseGate(restoredInlineCopy)).toBe(false);
    });

    test('builds the dist-driven E2E artifact before the test and rebuilds the final manifest', () => {
      const runbook = fs.readFileSync(PRIVATE.paths.releaseRunbook, 'utf8');
      const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

      expect(packageJson.scripts?.['test:e2e-firstrun']).toBe(
        'jest --config jest.e2e.config.js --runInBand'
      );
      expect(runbook).not.toContain('`test:e2e-firstrun` builds internally');
      expect(runbook).toMatch(
        /npm test -- --runInBand\nnpm run clean\nnpm run build\nnpm run test:e2e-firstrun\n\n# `test:e2e-firstrun` drives dist\/index\.js and does not build it\.[\s\S]*?npm run clean\nnpm run build\nnpm run verify:dist/
      );
    });
  });
});

describe('npm publish pipeline configuration', () => {
  test('package.json exposes dist entry points and declaration files', () => {
    const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

    expect(packageJson.main).toBe('dist/index.js');
    expect(packageJson.types).toBe('dist/index.d.ts');
    expect(packageJson.files).toContain('dist');
    expect(packageJson.bin).toMatchObject({
      'cmos-mcp': './dist/index.js',
    });

    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    });
  });

  // Arc C / s78-m01 (FORK-1 = A, hard-delete): the unauthenticated HTTP transport
  // (`cmos-mcp-http` bin, `./http-server` export, `start:http` script, `src/http-server.ts`)
  // was removed — it was a CORS-`*`, zero-auth, full-store-write channel with no consumers.
  // This guard is INVERTED from the old "must expose the http bin" assertion: it now fences
  // AGAINST a well-meaning re-add. If a real remote client ever needs it, recover the source
  // from git history and rebuild WITH authentication (do not just un-delete this surface).
  test('package.json does NOT expose the unauthenticated HTTP transport', () => {
    const packageJson = JSON.parse(readTextFile('package.json')) as PackageJson;

    expect(packageJson.bin).not.toHaveProperty('cmos-mcp-http');
    expect(packageJson.scripts ?? {}).not.toHaveProperty('start:http');
    expect(packageJson.exports ?? {}).not.toHaveProperty('./http-server');

    // No bin/export/script value may point at the deleted http-server artifact.
    const referencesHttpServer = [
      ...Object.values(packageJson.bin ?? {}),
      ...Object.values(packageJson.scripts ?? {}),
      ...Object.values(packageJson.exports ?? {}).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : Object.values(entry)
      ),
    ].some((value) => typeof value === 'string' && value.includes('http-server'));
    expect(referencesHttpServer).toBe(false);

    // The stdio bin — the product — is untouched.
    expect(packageJson.bin).toMatchObject({ 'cmos-mcp': './dist/index.js' });
  });

  test('the http-server source and transport docs are deleted from the repo', () => {
    for (const relativePath of [
      'src/http-server.ts',
      'HTTP_TRANSPORT.md',
      'README_HTTP.md',
      'ecosystem.config.js',
    ]) {
      expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  test('.npmignore excludes private workspace artifacts but not the shipped seed', () => {
    const npmIgnoreLines = readTextFile('.npmignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(npmIgnoreLines).toEqual(
      expect.arrayContaining([
        'cmos/',
        'tests/',
        'tmp/',
        'coverage/',
        '.eslintcache',
        '.github/',
        'scripts/',
      ])
    );
    expect(npmIgnoreLines).not.toContain('cmos-seed/');
  });

  PRIVATE.describe('private-source npm publish workflow', () => {
    test('triggers on version tags and publishes to npm', () => {
      const workflow = fs.readFileSync(PRIVATE.paths.workflow, 'utf8');

      expect(workflow).toMatch(/name:\s+Publish to npm/);
      expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*-\s*'v\*'/m);
      expect(workflow).toMatch(/npm pack --dry-run/);
      // Publishes with --access public (scoped package). Deliberately WITHOUT --provenance:
      // provenance requires a PUBLIC source repo, but this is the private publish source
      // (F2/F4), so `npm publish --provenance` fails with npm E422 (s73 release). The negative
      // guard stops a well-meaning re-add from re-breaking the publish.
      expect(workflow).toMatch(/npm publish --access public/);
      expect(workflow).not.toMatch(/npm publish --provenance/);
      expect(workflow).toMatch(/NODE_AUTH_TOKEN:\s+\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    });
  });
});
