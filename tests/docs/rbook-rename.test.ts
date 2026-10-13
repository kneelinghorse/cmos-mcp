// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The rename pass must preserve declared legacy spans and refuse ambiguous or drifting edits.
// ABOUTME: Isolated tracked-file fixtures prove content/path residual checks without private project data.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const { planRename, checkRename, captureCounts } = require('../../scripts/lib/rbook-rename');
const { applyPlan } = require('../../scripts/rbook-rename');

const manifest = (rules: any[] = [], replacements: any[] = []) => ({
  schemaVersion: 1,
  protections: rules,
  replacements,
  reviews: [],
});
const file = (name: string, text: string) => ({ path: name, text, mode: '100644' });

test('separates product prose, code identifiers and install names before moving paths', () => {
  const input = [
    file(
      'src/tools/cmos/cmos-review.ts',
      `// CMOS keeps decisions.\nexport class CmosReview { cmosReview = 'cmos_review'; }\n`
    ),
    file('plugins/cmos/README.md', 'Reasonbook (formerly CMOS)\n/cmos:start\nplugins/cmos-chat\n'),
  ];
  const plan = planRename(input, manifest());
  expect(plan.issues).toEqual([]);
  expect(plan.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: 'src/tools/rbook/rbook-review.ts',
        text: "// Reasonbook keeps decisions.\nexport class RbookReview { rbookReview = 'rbook_review'; }\n",
      }),
      expect.objectContaining({
        path: 'plugins/reasonbook/README.md',
        text: 'Reasonbook\n/reasonbook:start\nplugins/reasonbook-chat\n',
      }),
    ])
  );
  expect(checkRename(plan.files, manifest()).issues).toEqual([]);
});

test('protects an old token on a mixed line without retaining the old import path', () => {
  const input = [
    file(
      'tests/fixture.ts',
      `import { x } from '../src/tools/cmos/client';\nconst stored = 'cmos_address'; // CMOS record\n`
    ),
  ];
  const rules = [
    {
      id: 'stored',
      paths: ['tests/fixture.ts'],
      pattern: 'cmos_address',
      expectedCount: 1,
      reason: 'persisted key',
    },
  ];
  const plan = planRename(input, manifest(rules));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toContain('../src/tools/rbook/client');
  expect(plan.files[0].text).toContain("'cmos_address'; // Reasonbook record");
  expect(checkRename(plan.files, manifest(rules)).issues).toEqual([]);
  expect(
    checkRename([file('tests/fixture.ts', "'rbook_address'")], manifest(rules)).issues.join('\n')
  ).toMatch(/stored.*count/);
});

test('history stays byte-identical while a compatibility fixture can follow current module paths', () => {
  const input = [
    file('cmos/research/history.md', 'CMOS cmos-mcp cmos_review\n'),
    file('tests/compat.ts', "import '../src/tools/cmos/client';\nconst old = 'cmos_review';\n"),
  ];
  const rules = [
    {
      id: 'history',
      paths: ['cmos/research/**'],
      mode: 'file',
      expectedCount: 1,
      reason: 'historical',
    },
    {
      id: 'compat',
      paths: ['tests/compat.ts'],
      mode: 'compatibility',
      expectedCount: 1,
      reason: 'old literal fixtures',
    },
  ];
  const plan = planRename(input, manifest(rules));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0]).toEqual(input[0]);
  expect(plan.files[1].text).toBe(
    "import '../src/tools/rbook/client';\nconst old = 'cmos_review';\n"
  );
  expect(checkRename(plan.files, manifest(rules)).issues).toEqual([]);
});

test('ambiguous old command names block application until an exact reviewed rule supplies their meaning', () => {
  const input = [file('src/cli.ts', "console.log('cmos-mcp hook start');\n")];
  expect(planRename(input, manifest()).issues.join('\n')).toMatch(/ambiguous.*cmos-mcp/);
  const rules = [
    {
      id: 'command',
      paths: ['src/cli.ts'],
      pattern: 'cmos-mcp(?= hook)',
      replacement: 'reasonbook',
      expectedCount: 1,
      reason: 'CLI command',
    },
  ];
  const plan = planRename(input, manifest([], rules));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toContain('reasonbook hook');
});

test('compatibility fixtures follow imported symbols but preserve legacy setting keys and stored properties', () => {
  const input = [
    file(
      'tests/compat.ts',
      `import { CmosDetector, cmosReview } from '../src/tools/cmos/client';
const detector = new CmosDetector(); cmosReview();
const env = { CMOS_AMBIENT: 'on' }; process.env.CMOS_AMBIENT = env.CMOS_AMBIENT;
const old = { cmos_address: 'cmos://old/project' }; old.cmos_address;
`
    ),
  ];
  const rules = [
    {
      id: 'compat',
      paths: ['tests/compat.ts'],
      mode: 'compatibility',
      expectedCount: 1,
      reason: 'legacy setting fixture',
    },
  ];
  const plan = planRename(input, manifest(rules));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toContain('import { RbookDetector, rbookReview }');
  expect(plan.files[0].text).toContain('new RbookDetector(); rbookReview();');
  expect(plan.files[0].text).toContain(
    "{ CMOS_AMBIENT: 'on' }; process.env.CMOS_AMBIENT = env.CMOS_AMBIENT"
  );
  expect(plan.files[0].text).toContain("{ cmos_address: 'cmos://old/project' }; old.cmos_address");
});

test('a declared migration-page path remains searchable by its former name', () => {
  const input = [file('docs/migrating-from-cmos.md', 'Former CMOS instructions')];
  const rules = [
    {
      id: 'migration',
      paths: ['docs/migrating-from-cmos.md'],
      mode: 'file',
      allowOldPath: true,
      expectedCount: 1,
      reason: 'old-name search entry point',
    },
  ];
  expect(planRename(input, manifest(rules)).files).toEqual(input);
  expect(planRename(input, manifest(rules)).issues).toEqual([]);
});

test('the real policy moves current own-checkout references along with seeded project paths', () => {
  const policy = require('../../scripts/rbook-rename-protected.json');
  const input = [
    file('agents.md', 'Read cmos/tiers/build.md and cmos/docs/build-session-prompt.md.'),
    file('cmos-seed/docs/agents-md-guide.md', 'Read cmos/tiers/build.md and cmos/README.md.'),
    file(
      'tests/tools/cmos/onboarding-by-level.test.ts',
      "expect(written).toContain('cmos/tiers/managed.md');"
    ),
  ];
  const plan = planRename(input, captureCounts(input, policy));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toBe(
    'Read rbook/tiers/build.md and rbook/docs/build-session-prompt.md.'
  );
  expect(plan.files[1].text).toBe('Read rbook/tiers/build.md and rbook/README.md.');
  expect(plan.files[2].text).toContain("'rbook/tiers/managed.md'");
});

test('the real policy reaches multiline current-output assertions', () => {
  const policy = require('../../scripts/rbook-rename-protected.json');
  const input = [
    file(
      'tests/intelligence/legacy-compat.test.ts',
      "expect(normalizeAddressScheme('rbook://Owner/cmos-dashboard')).toBe(\n  'cmos://Owner/cmos-dashboard'\n);"
    ),
    file(
      'tests/intelligence/record-path-compat.test.ts',
      "import { seedCmosDb } from '../helpers/seedCmosDb'; seedCmosDb();"
    ),
  ];
  const plan = planRename(input, captureCounts(input, policy));
  expect(plan.issues.join('\n')).toMatch(/current-address-output-fixture/);
});

test('private sources follow the moved record while migration fixtures retain legacy inputs', () => {
  const policy = require('../../scripts/rbook-rename-protected.json');
  const input = [
    file(
      'tests/tools/cmos/draft-real-store.test.ts',
      "paths: { liveDb: 'cmos/db/cmos.sqlite' },\nconst copy = path.join(root, 'cmos/db/cmos.sqlite');"
    ),
    file('rbook/cli.py', 'db_path = root / "db" / "cmos.sqlite"\nreturn current / "cmos"\n'),
    file(
      'rbook/tests/test_cli_research_export.py',
      'shutil.copy2(CMOS_ROOT / "db" / "cmos.sqlite", self.db_path)\nself.db_path = temp / "cmos.sqlite"\n'
    ),
    file(
      'tests/cli/migrate-recovery.test.ts',
      "const seed = path.resolve(__dirname, '../../cmos-seed');\nconst old = 'cmos/db/cmos.sqlite';"
    ),
  ];
  const plan = planRename(input, captureCounts(input, policy));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toContain("liveDb: 'rbook/db/rbook.sqlite'");
  expect(plan.files[0].text).toContain("path.join(root, 'rbook/db/rbook.sqlite')");
  expect(plan.files[1].text).toBe(
    'db_path = root / "db" / "rbook.sqlite"\nreturn current / "rbook"\n'
  );
  expect(plan.files[2].text).toContain('RBOOK_ROOT / "db" / "rbook.sqlite"');
  expect(plan.files[2].text).toContain('temp / "rbook.sqlite"');
  expect(plan.files[3].text).toContain("'../../rbook-seed'");
  expect(plan.files[3].text).toContain("'cmos/db/cmos.sqlite'");
});

test('operator project names cannot conceal a current runtime prefix', () => {
  const policy = require('../../scripts/rbook-rename-protected.json');
  const input = [
    file(
      'src/tools/cmos/dashboard-upload.ts',
      "const project = 'cmos-dashboard'; const prefix = 'cmos-dashboard-upload-';"
    ),
  ];
  const plan = planRename(input, captureCounts(input, policy));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toContain("project = 'cmos-dashboard'");
  expect(plan.files[0].text).toContain("prefix = 'rbook-dashboard-upload-'");
  expect(checkRename(input, captureCounts(input, policy)).issues.join('\n')).toMatch(/residual/);
});

test('the private lint exclusion does not mask a current test module path', () => {
  const policy = require('../../scripts/rbook-rename-protected.json');
  const input = [
    file('package.json', '"test": "jest tests/tools/cmos/e2e-lifecycle.test.ts", "!(cmos)/**": []'),
  ];
  const plan = planRename(input, captureCounts(input, policy));
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].text).toContain('tests/tools/rbook/e2e-lifecycle.test.ts');
  expect(plan.files[0].text).toContain('!(rbook)/**');
  const guard = file('rbook/docs/release.md', '^package/(cmos|rbook|analysis|artifacts|tmp)(/|$)');
  expect(planRename([guard], captureCounts([guard], policy)).files[0].text).toBe(guard.text);
});

test('review input hashes detect uncommitted source or policy changes with identical protection counts', () => {
  const before = planRename([file('README.md', 'CMOS keeps decisions.')], manifest());
  const after = planRename([file('README.md', 'CMOS keeps notes.')], manifest());
  const policyChanged = planRename([file('README.md', 'CMOS keeps decisions.')], {
    ...manifest(),
    scope: 'changed scope',
  });
  expect(before.inputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(before.inputHash).not.toBe(after.inputHash);
  expect(before.inputHash).not.toBe(policyChanged.inputHash);
});

test('an explicit reviewed filename mapping prevents a malformed generic command-name path', () => {
  const policy = {
    ...manifest(),
    pathMappings: [
      {
        source: 'tests/p0-cmos-mcp.ts',
        target: 'tests/p0-foreign-root.ts',
        reason: 'The test describes a foreign project root.',
        expectedCount: 1,
      },
    ],
  };
  const plan = planRename([file('tests/p0-cmos-mcp.ts', 'CMOS')], policy);
  expect(plan.issues).toEqual([]);
  expect(plan.files[0].path).toBe('tests/p0-foreign-root.ts');
  expect(checkRename([], policy).issues.join('\n')).toMatch(/path mapping count/);
});

test('the residual predicate checks path names, uncommon text extensions and malformed new names', () => {
  const report = checkRename(
    [
      file('assets/cmos.txt', 'fine'),
      file('src/unusual.extension', 'cmos_review'),
      file('README.md', 'rbook-mcp formerly Reasonbook'),
    ],
    manifest()
  );
  expect(report.issues.join('\n')).toMatch(/path.*assets\/cmos/);
  expect(report.issues.join('\n')).toMatch(/residual.*unusual/);
  expect(report.issues.join('\n')).toMatch(/malformed/);
});

test('prose detector regex boundaries are not mistaken for Reasonbook inside an identifier', () => {
  expect(
    checkRename([file('src/pattern.ts', 'const prose = /\\bReasonbook\\b/;')], manifest()).issues
  ).toEqual([]);
  expect(
    checkRename([file('src/bad.ts', 'const myReasonbookFlag = true;')], manifest()).issues.join(
      '\n'
    )
  ).toMatch(/malformed/);
});

test('an address regex is valid while the short name cannot become a skill command', () => {
  expect(
    checkRename([file('src/pattern.ts', String.raw`const address = /rbook:\/\//;`)], manifest())
      .issues
  ).toEqual([]);
  expect(checkRename([file('README.md', '/rbook:start')], manifest()).issues.join('\n')).toMatch(
    /malformed/
  );
});

test('historical reconstruction keys and before tokens do not shield current target fields', () => {
  const policy = require('../../scripts/rbook-rename-protected.json');
  const contract = {
    parserHashes: { 'src/tools/cmos/errors.ts': 'fixed-original-sha' },
    sourceRenames: {
      'src/tools/cmos/errors.ts': {
        path: 'src/tools/cmos/errors.ts',
        replacements: [{ from: 'Cmos', to: 'Cmos', count: 1 }],
      },
    },
  };
  const input = [file('tests/fixtures/retrieval-quality-contract.json', JSON.stringify(contract))];
  const bound = captureCounts(input, policy);
  expect(checkRename(input, bound).issues.join('\n')).toMatch(/residual/);
  const plan = planRename(input, bound);
  expect(plan.issues).toEqual([]);
  const result = JSON.parse(plan.files[0].text);
  expect(result.parserHashes).toEqual(contract.parserHashes);
  expect(result.sourceRenames['src/tools/cmos/errors.ts']).toEqual({
    path: 'src/tools/rbook/errors.ts',
    replacements: [{ from: 'Cmos', to: 'Rbook', count: 1 }],
  });
});

test('lost, duplicated and unbound protected occurrences cannot be silently allowed', () => {
  const input = [file('README.md', 'formerly CMOS\n')];
  const rule = {
    id: 'transition',
    paths: ['README.md'],
    pattern: 'formerly CMOS',
    reason: 'transition',
  };
  expect(planRename(input, manifest([rule])).issues.join('\n')).toMatch(/expectedCount/);
  const captured = captureCounts(input, manifest([rule]));
  expect(captured.protections[0].expectedCount).toBe(1);
  expect(planRename(input, captured).issues).toEqual([]);
  expect(
    checkRename([file('README.md', 'formerly CMOS\nformerly CMOS\n')], captured).issues.join('\n')
  ).toMatch(/count/);
});

test('current sweep witnesses move while predicates and historical arithmetic remain intact', () => {
  const data = {
    schemaVersion: 1,
    universe: { paths: ['src/tools/cmos/**'] },
    arms: [
      {
        predicate: [{ pattern: 'cmos-mcp [a-z]+' }],
        historical: { count: 1, matches: [{ file: 'src/tools/cmos/old.ts', text: 'cmos_review' }] },
        witnesses: [{ file: 'src/tools/cmos/current.ts', text: 'cmos_review' }],
        residual: [{ pattern: 'cmos_mission' }],
      },
    ],
  };
  const rules = [
    {
      id: 'sweeps',
      paths: ['tests/sweeps/*.json'],
      mode: 'ledger',
      expectedCount: 1,
      reason: 'frozen history',
    },
  ];
  const plan = planRename(
    [file('tests/sweeps/example.json', JSON.stringify(data, null, 2) + '\n')],
    manifest(rules)
  );
  expect(plan.issues).toEqual([]);
  const actual = JSON.parse(plan.files[0].text);
  expect(actual.arms[0].historical).toEqual(data.arms[0].historical);
  expect(actual.arms[0].predicate).toEqual(data.arms[0].predicate);
  expect(actual.universe.paths).toEqual(['src/tools/rbook/**']);
  expect(actual.arms[0].witnesses[0]).toEqual({
    file: 'src/tools/rbook/current.ts',
    text: 'rbook_review',
  });
  expect(actual.arms[0].residual[0].pattern).toBe('rbook_mission');
});

test('public mirror checks use public counts without depending on private record files', () => {
  const input = [
    file('README.md', 'formerly CMOS'),
    file('cmos/research/notes.md', 'formerly CMOS'),
  ];
  const policy = {
    ...manifest([
      { id: 'transition', paths: ['**'], pattern: 'formerly CMOS', reason: 'transition' },
    ]),
    publicExcludes: ['cmos/**'],
  };
  const captured = captureCounts(input, policy);
  expect(captured.protections[0]).toMatchObject({ expectedCount: 2, expectedPublicCount: 1 });
  expect(checkRename(input, captured).scannedFileCount).toBe(2);
  expect(checkRename(input, captured, { publicOnly: true }).scannedFileCount).toBe(1);
  expect(checkRename(input.slice(0, 1), captured, { publicOnly: true }).issues).toEqual([]);
  expect(checkRename(input.slice(0, 1), captured).issues.join('\n')).toMatch(/count/);
  expect(
    checkRename([file('README.md', 'formerly CMOS\nformerly CMOS')], captured, {
      publicOnly: true,
    }).issues.join('\n')
  ).toMatch(/count/);
});

test('apply refuses any changed source or path collision before its first write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-rename-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const source = path.join(root, 'cmos.txt');
    fs.writeFileSync(source, 'CMOS');
    const plan = planRename([file('cmos.txt', 'CMOS')], manifest());
    fs.writeFileSync(source, 'outside edit');
    expect(() => applyPlan(root, plan)).toThrow(/changed/);
    expect(fs.readFileSync(source, 'utf8')).toBe('outside edit');
    fs.writeFileSync(source, 'CMOS');
    fs.writeFileSync(path.join(root, 'rbook.txt'), 'user data');
    expect(() => applyPlan(root, plan)).toThrow(/collision/);
    expect(fs.readFileSync(source, 'utf8')).toBe('CMOS');
    fs.unlinkSync(path.join(root, 'rbook.txt'));
    applyPlan(root, plan);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(root, 'rbook.txt'), 'utf8')).toBe('Reasonbook');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted apply restores earlier writes and leaves the failed source intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-rename-rollback-'));
  const input = [file('one.txt', 'CMOS'), file('two.txt', 'CMOS')];
  const filesystem = require('fs');
  const rename = filesystem.renameSync;
  let calls = 0;
  const spy = jest.spyOn(filesystem, 'renameSync').mockImplementation((...args: unknown[]) => {
    if (++calls === 2) throw new Error('simulated disk failure');
    return rename(...args);
  });
  try {
    for (const item of input) fs.writeFileSync(path.join(root, item.path), item.text);
    expect(() => applyPlan(root, planRename(input, manifest()))).toThrow(/simulated disk/);
    for (const item of input)
      expect(fs.readFileSync(path.join(root, item.path), 'utf8')).toBe(item.text);
    expect(fs.readdirSync(root).sort()).toEqual(['one.txt', 'two.txt']);
  } finally {
    spy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
