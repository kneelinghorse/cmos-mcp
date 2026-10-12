// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises the sealed retrieval gate through real child processes in isolated Git checkouts.
// ABOUTME: Mutations must fail closed; this synthetic process fixture is separate from private ranking acceptance.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
const { runGate } = require('../../scripts/retrieval-quality-gate');
const { summarize } = require('../../scripts/retrieval-quality-metrics');
const fixturePath = 'cmos/research/2026-10-s94-m06';
const contractPath = 'tests/fixtures/retrieval-quality-contract.json';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let root: string;
const put = (name: string, value: unknown) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const hash = (name: string) => sha(fs.readFileSync(path.join(root, name)));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
function setup(mirror = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-gate-test-'));
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  put('public.txt', 'public');
  if (!mirror) put(`${fixturePath.split('/')[0]}/private.txt`, 'private checkout identity');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  put(
    'scripts/mirror-to-public.sh',
    fs.readFileSync(path.resolve(__dirname, '../../scripts/mirror-to-public.sh'), 'utf8')
  );
  put('src/parser.ts', 'export const parser = true;');
  put('src/retrieval.ts', 'export const candidate = true;');
  const evaluatorNames = [
    'measure-retrieval-quality.js',
    'retrieval-quality-fixture.js',
    'retrieval-quality-metrics.js',
    'retrieval-quality-diagnostics.js',
  ];
  for (const name of evaluatorNames) put(`scripts/${name}`, '// sealed evaluator fixture');
  put(
    'scripts/measure-retrieval-quality.js',
    `const fs=require('fs'),path=require('path');
const args=process.argv.slice(2),root=process.cwd(),fixture=path.join(root,${JSON.stringify(fixturePath)});
if(JSON.stringify(args.slice(0,6))!==JSON.stringify(['--mode','candidate','--fixture',fixture,'--source-root',root])||args.length!==8||args[6]!=='--output')throw Error('unexpected override');
fs.writeFileSync(path.join(root,'child-ran'),'yes');
fs.writeFileSync(args[7],fs.readFileSync(path.join(fixture,'candidate-fixture.json')));
const mutation=path.join(root,'child-mutation.json');
if(fs.existsSync(mutation)){const target=JSON.parse(fs.readFileSync(mutation,'utf8'));fs.appendFileSync(path.join(root,target),' ');}`
  );
  put('scripts/build-retrieval-labels.js', '// sealed label generator');
  const generatorSha256 = hash('scripts/build-retrieval-labels.js');
  const parserHashes = { 'src/parser.ts': hash('src/parser.ts') };
  const data: Record<string, unknown> = {
    'acceptance-fixture/corpus.json': { rows: ['private corpus text'] },
    'acceptance-fixture/manifest.json': { frozen: true },
    'frozen-labels/labels.json': { rows: ['private labels'] },
    'frozen-labels/manifest.json': { extractorSources: parserHashes },
    'paraphrase-fixture/paraphrases.json': { queries: [{ id: 'para', expected: ['d:1'] }] },
    'paraphrase-fixture/manifest.json': { count: 1 },
    'no-relevance-controls.json': { queries: [{ id: 'negative' }] },
    'no-relevance-manifest.json': { count: 1 },
  };
  for (const [name, value] of Object.entries(data)) put(`${fixturePath}/${name}`, value);
  const labelManifest = {
    extractorSources: parserHashes,
    generatorSha256,
    corpusSha256: hash(`${fixturePath}/acceptance-fixture/corpus.json`),
    labelsSha256: hash(`${fixturePath}/frozen-labels/labels.json`),
    counts: { primary: 1, mission: 1, mixed: 1 },
  };
  put(`${fixturePath}/frozen-labels/manifest.json`, labelManifest);
  put(`${fixturePath}/labels-v5-review/manifest.json`, labelManifest);
  put(`${fixturePath}/labels-v5-review/labels.json`, data['frozen-labels/labels.json']);
  const evidenceHashes = Object.fromEntries(
    Object.keys(data).map((name) => [name, hash(`${fixturePath}/${name}`)])
  );
  const evaluatorHashes = Object.fromEntries(
    evaluatorNames.map((name) => [`scripts/${name}`, hash(`scripts/${name}`)])
  );
  const unit = (id: string, population: string) => ({
    id,
    population,
    positiveIds: ['d:1'],
    retrievedIds: ['d:1'],
  });
  const units = [
    unit('query/decision', 'primary'),
    unit('mission/decision', 'mission'),
    unit('query/mixed', 'mixed'),
    unit('query/first-prompt', 'first-prompt'),
    unit('query/first-prompt-internal', 'first-prompt-internal'),
  ];
  const baselineConfig = {
    mode: 'baseline',
    keywordOnly: true,
    effectiveSurfaces: { firstPromptFloor: 0 },
    learningPrior: 1,
  };
  const candidateConfig = { ...baselineConfig, mode: 'candidate' };
  const baseline = {
    fixtureSha256: evidenceHashes['acceptance-fixture/corpus.json'],
    labelsSha256: evidenceHashes['frozen-labels/labels.json'],
    config: baselineConfig,
    units,
    skipped: 0,
  };
  const promptUnit = {
    id: 'query/first-prompt',
    positiveIds: ['d:1'],
    internalIds: ['d:1'],
    emittedIds: ['d:1'],
  };
  const negative = { id: 'negative', internalIds: [], emittedIds: [], missionIds: [] };
  const candidate = {
    ...clone(baseline),
    config: candidateConfig,
    sourceHashes: {
      'src/parser.ts': hash('src/parser.ts'),
      'src/retrieval.ts': hash('src/retrieval.ts'),
    },
    evaluatorHashes: Object.fromEntries(
      evaluatorNames.map((name) => [name, hash(`scripts/${name}`)])
    ),
    diagnostics: {
      paraphraseSha256: evidenceHashes['paraphrase-fixture/paraphrases.json'],
      noRelevanceSha256: evidenceHashes['no-relevance-controls.json'],
      paraphrase: {
        units: [unit('para/typed', 'paraphrase-typed'), unit('para/mixed', 'paraphrase-mixed')],
      },
      noRelevance: { units: [negative] },
      floorSweeps: [0, 1, 2, 3].map((threshold) => ({
        threshold,
        units: [clone(promptUnit)],
        noRelevance: [clone(negative)],
        internal: summarize([units[3]]),
        emitted: summarize([units[3]]),
      })),
    },
  };
  put(`${fixturePath}/frozen-baseline.json`, baseline);
  const contract = {
    schemaVersion: 2,
    sourceRenames: {} as Record<
      string,
      { path: string; replacements: Array<{ from: string; to: string; count: number }> }
    >,
    mission: 's94-m06',
    fixtureRoot: fixturePath,
    baseline: {
      file: 'frozen-baseline.json',
      sha256: hash(`${fixturePath}/frozen-baseline.json`),
      sourceCommit: 'a'.repeat(40),
    },
    evidenceHashes,
    parserHashes,
    parserReview: {
      file: 'labels-v5-review/manifest.json',
      sha256: hash(`${fixturePath}/labels-v5-review/manifest.json`),
      generatorSha256,
    },
    evaluatorHashes,
    baselineConfig,
    candidateConfig,
    counts: { primary: 1, mission: 1, mixed: 1 },
    requiredSourceFiles: ['src/parser.ts', 'src/retrieval.ts'],
  };
  put(contractPath, contract);
  const saveCandidate = () => put(`${fixturePath}/candidate-fixture.json`, candidate);
  saveCandidate();
  return { candidate, contract, saveCandidate };
}
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('executes the candidate child with no tuning overrides and emits only aggregate evidence', () => {
  setup();
  const result = runGate({ root });
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
  expect(result).toMatchObject({ skipped: false, acceptance: { primary: { mean: 1 } } });
  expect(
    result.diagnostics.floorSweeps.map((floor: { threshold: number }) => floor.threshold)
  ).toEqual([0, 1, 2, 3]);
  expect(JSON.stringify(result)).not.toMatch(/d:1|query\/|negative|private corpus/);
});
it.each(['frozen-baseline.json', 'acceptance-fixture/corpus.json', 'frozen-labels/labels.json'])(
  'rejects changed sealed %s before starting a child',
  (name) => {
    setup();
    put(`${fixturePath}/${name}`, {});
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
  }
);
it.each(['src/parser.ts', 'scripts/retrieval-quality-fixture.js'])(
  'rejects changed sealed source %s before starting a child',
  (name) => {
    setup();
    put(name, 'changed');
    expect(() => runGate({ root })).toThrow(/sealed hash/);
    expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
  }
);
function renameSealedSources() {
  const fixture = setup();
  const parser = fs.readFileSync(path.join(root, 'src/parser.ts'), 'utf8');
  put('src/renamed-parser.ts', parser.replace('parser', 'renamedParser'));
  fs.unlinkSync(path.join(root, 'src/parser.ts'));
  fixture.contract.sourceRenames['src/parser.ts'] = {
    path: 'src/renamed-parser.ts',
    replacements: [{ from: 'parser', to: 'renamedParser', count: 1 }],
  };
  fixture.contract.requiredSourceFiles[0] = 'src/renamed-parser.ts';
  Reflect.deleteProperty(fixture.candidate.sourceHashes, 'src/parser.ts');
  Object.assign(fixture.candidate.sourceHashes, {
    'src/renamed-parser.ts': hash('src/renamed-parser.ts'),
  });
  const evaluator = 'scripts/measure-retrieval-quality.js';
  const bytes = fs.readFileSync(path.join(root, evaluator), 'utf8');
  put(evaluator, bytes.split('mutation').join('renamedMutation'));
  fixture.contract.sourceRenames[evaluator] = {
    path: evaluator,
    replacements: [
      { from: 'mutation', to: 'renamedMutation', count: bytes.split('mutation').length - 1 },
    ],
  };
  fixture.candidate.evaluatorHashes['measure-retrieval-quality.js'] = hash(evaluator);
  put(contractPath, fixture.contract);
  fixture.saveCandidate();
  return fixture;
}
it('proves renamed parser/evaluator bytes against their original seals without rewriting frozen evidence', () => {
  const fixture = renameSealedSources();
  const sealed = Object.entries(fixture.contract.evidenceHashes).map(([name, digest]) => [
    name,
    digest,
  ]);
  expect(runGate({ root }).skipped).toBe(false);
  for (const [name, digest] of sealed) expect(hash(`${fixturePath}/${name}`)).toBe(digest);
  expect(fixture.contract.parserHashes['src/parser.ts']).not.toBe(hash('src/renamed-parser.ts'));
});
it.each([
  'parser',
  'evaluator',
  'missing',
  'unrecorded',
  'count',
  'duplicate-path',
  'extra-mapping',
])('rejects a %s defect in the recorded source rename before running the evaluator', (change) => {
  const fixture = renameSealedSources();
  if (change === 'parser') put('src/renamed-parser.ts', 'export const renamedParser = false;');
  if (change === 'evaluator')
    fs.appendFileSync(path.join(root, 'scripts/measure-retrieval-quality.js'), '\n// unreviewed');
  if (change === 'missing') fs.unlinkSync(path.join(root, 'src/renamed-parser.ts'));
  if (change === 'unrecorded')
    Reflect.deleteProperty(fixture.contract.sourceRenames, 'src/parser.ts');
  if (change === 'count') fixture.contract.sourceRenames['src/parser.ts'].replacements[0].count++;
  if (change === 'duplicate-path')
    fixture.contract.sourceRenames['scripts/measure-retrieval-quality.js'].path =
      'src/renamed-parser.ts';
  if (change === 'extra-mapping')
    fixture.contract.sourceRenames['src/unknown.ts'] = { path: 'src/other.ts', replacements: [] };
  put(contractPath, fixture.contract);
  expect(() => runGate({ root })).toThrow(/sealed hash|source rename/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
});
it('rejects changes to renamed source during the evaluator child', () => {
  renameSealedSources();
  put('child-renamedMutation.json', JSON.stringify('src/renamed-parser.ts'));
  expect(() => runGate({ root })).toThrow(/sealed hash/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
});
it('requires the current evaluator receipt instead of reusing its historical seal', () => {
  const fixture = renameSealedSources();
  fixture.candidate.evaluatorHashes['measure-retrieval-quality.js'] =
    fixture.contract.evaluatorHashes['scripts/measure-retrieval-quality.js'];
  fixture.saveCandidate();
  expect(() => runGate({ root })).toThrow(/candidate evaluator hashes/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
});
it.each(['labels-v5-review/manifest.json', 'labels-v5-review/labels.json'])(
  'requires unchanged independent parser equivalence evidence: %s',
  (name) => {
    setup();
    put(`${fixturePath}/${name}`, {});
    expect(() => runGate({ root })).toThrow(/sealed hash/);
  }
);
it('pins the label generator that established parser equivalence', () => {
  setup();
  put('scripts/build-retrieval-labels.js', 'changed generator');
  expect(() => runGate({ root })).toThrow(/sealed hash/);
});
it.each([
  'src/retrieval.ts',
  'scripts/retrieval-quality-diagnostics.js',
  `${fixturePath}/frozen-baseline.json`,
])('rejects changing %s during the evaluator child', (name) => {
  setup();
  put('child-mutation.json', JSON.stringify(name));
  expect(() => runGate({ root })).toThrow(/source changed|sealed hash/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
});
it('rejects a candidate configuration override', () => {
  const fixture = setup();
  fixture.candidate.config.learningPrior = 0.5;
  fixture.saveCandidate();
  expect(() => runGate({ root })).toThrow(/configuration/);
});
it('recomputes acceptance from actual retrieved positives instead of claimed scores', () => {
  const fixture = setup();
  fixture.candidate.units[0].retrievedIds = [];
  Object.assign(fixture.candidate, { primary: { mean: 1 } });
  fixture.saveCandidate();
  expect(() => runGate({ root })).toThrow(/recall regression/);
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(true);
});
it.each(['omit', 'stale'])('rejects %s candidate source evidence', (change) => {
  const fixture = setup();
  if (change === 'omit') Reflect.deleteProperty(fixture.candidate.sourceHashes, 'src/retrieval.ts');
  else fixture.candidate.sourceHashes['src/retrieval.ts'] = '0'.repeat(64);
  fixture.saveCandidate();
  expect(() => runGate({ root })).toThrow(/candidate source/);
});
it.each(['missing', 'duplicate', 'wrong-label', 'selected-mismatch', 'missing-control'])(
  'rejects %s floor diagnostics rather than silently dropping a required witness',
  (change) => {
    const fixture = setup(),
      floors = fixture.candidate.diagnostics.floorSweeps;
    if (change === 'missing') floors.pop();
    if (change === 'duplicate') floors[3].threshold = 2;
    if (change === 'wrong-label') floors[1].units[0].positiveIds = ['d:2'];
    if (change === 'selected-mismatch') floors[0].units[0].emittedIds = [];
    if (change === 'missing-control') floors[2].noRelevance = [];
    fixture.saveCandidate();
    expect(() => runGate({ root })).toThrow(/floor|control/i);
  }
);
it('rejects missing independent paraphrase diagnostics', () => {
  const fixture = setup();
  fixture.candidate.diagnostics.paraphrase.units = [];
  fixture.saveCandidate();
  expect(() => runGate({ root })).toThrow(/paraphrase/);
});
it('skips a structurally identified public mirror with a reason and without reading private evidence', () => {
  setup(true);
  fs.rmSync(path.join(root, fixturePath), { recursive: true });
  expect(runGate({ root })).toMatchObject({
    skipped: true,
    reason: expect.stringMatching(/mirror-to-public.*HEAD\/index/),
  });
  expect(fs.existsSync(path.join(root, 'child-ran'))).toBe(false);
});
it('does not treat missing private fixtures or deleted HEAD-tracked roots as a mirror', () => {
  setup();
  fs.rmSync(path.join(root, fixturePath.split('/')[0]), { recursive: true });
  git('add', '-u');
  expect(() => runGate({ root })).toThrow(/missing/);
});
it('fails closed when mirror exclusion syntax is not the supported literal inventory', () => {
  setup(true);
  put('scripts/mirror-to-public.sh', 'PRIVATE_PATHS=($CUSTOM)\nDOCS_EXCLUDES=(docs/private)');
  expect(() => runGate({ root })).toThrow(/contract path/);
});
it.each([
  'PRIVATE_PATHS=(rbook) ; PRIVATE_PATHS=(other)\nDOCS_EXCLUDES=(docs/private)',
  'PRIVATE_PATHS=(rbook)\nDOCS_EXCLUDES=(rbook)',
])('does not guess the mirror policy from ambiguous shell arrays', (source) => {
  setup(true);
  put('scripts/mirror-to-public.sh', source);
  expect(() => runGate({ root })).toThrow(/mirror exclusions/);
});
