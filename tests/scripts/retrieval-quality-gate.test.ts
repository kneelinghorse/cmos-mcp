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
  if (!mirror) put('cmos/private.txt', 'private checkout identity');
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
    schemaVersion: 1,
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
  fs.rmSync(path.join(root, 'cmos'), { recursive: true });
  git('add', '-u');
  expect(() => runGate({ root })).toThrow(/missing/);
});
it('fails closed when mirror exclusion syntax is not the supported literal inventory', () => {
  setup(true);
  put('scripts/mirror-to-public.sh', 'PRIVATE_PATHS=($CUSTOM)\nDOCS_EXCLUDES=(docs/private)');
  expect(() => runGate({ root })).toThrow(/contract path/);
});
it.each([
  'PRIVATE_PATHS=(cmos) ; PRIVATE_PATHS=(other)\nDOCS_EXCLUDES=(docs/private)',
  'PRIVATE_PATHS=(cmos)\nDOCS_EXCLUDES=(cmos)',
])('does not guess the mirror policy from ambiguous shell arrays', (source) => {
  setup(true);
  put('scripts/mirror-to-public.sh', source);
  expect(() => runGate({ root })).toThrow(/mirror exclusions/);
});
