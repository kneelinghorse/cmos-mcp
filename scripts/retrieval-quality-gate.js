#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Binds the real candidate evaluator to sealed private evidence and published defaults.
// ABOUTME: Public mirrors skip by tracked exclusion identity; incomplete private checkouts fail closed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { compareReports, summarize } = require('./retrieval-quality-metrics');

const {
  same,
  readContract,
  isPublicMirror,
  validateReport,
  snapshotSources,
  verifyCandidateSource,
  verifyEvidence,
} = require('./retrieval-quality-contract');

function ids(values, cap, label) {
  if (
    !Array.isArray(values) ||
    values.length > cap ||
    new Set(values).size !== values.length ||
    values.some((id) => !/^[dl]:[1-9]\d*$/.test(id))
  )
    throw new Error(`invalid ${label} identities`);
}
function diagnosticsSummary(report, contract, fixture) {
  const diagnostic = report.diagnostics;
  if (!diagnostic) throw new Error('missing diagnostic populations');
  same(
    diagnostic.paraphraseSha256,
    contract.evidenceHashes['paraphrase-fixture/paraphrases.json'],
    'paraphrase evidence'
  );
  same(
    diagnostic.noRelevanceSha256,
    contract.evidenceHashes['no-relevance-controls.json'],
    'control evidence'
  );
  const read = (name) => JSON.parse(fs.readFileSync(path.join(fixture, name), 'utf8'));
  const paraphrases = read('paraphrase-fixture/paraphrases.json').queries;
  const controls = read('no-relevance-controls.json').queries;
  const para = diagnostic.paraphrase?.units;
  const expected = paraphrases.flatMap((query) =>
    ['typed', 'mixed'].map((kind) => ({
      id: `${query.id}/${kind}`,
      population: `paraphrase-${kind}`,
      positiveIds: query.expected,
    }))
  );
  same(
    para?.map(({ id, population, positiveIds }) => ({ id, population, positiveIds })),
    expected,
    'paraphrase population'
  );
  for (const unit of para) ids(unit.retrievedIds, 10, 'paraphrase');
  const checkControls = (units, label) => {
    same(
      units?.map((unit) => unit.id),
      controls.map((query) => query.id),
      `${label} control population`
    );
    for (const unit of units)
      for (const key of ['internalIds', 'emittedIds']) ids(unit[key], 5, label);
    return {
      units: units.length,
      nonemptyHooks: units.filter((unit) => unit.emittedIds.length).length,
      emittedDecisions: units.reduce((n, unit) => n + unit.emittedIds.length, 0),
    };
  };
  const noRelevance = checkControls(diagnostic.noRelevance?.units, 'selected');
  const prompts = report.units.filter((unit) => unit.population === 'first-prompt');
  const internals = report.units.filter((unit) => unit.population === 'first-prompt-internal');
  same(
    internals.map((unit) => unit.id.replace(/\/first-prompt-internal$/, '/first-prompt')),
    prompts.map((unit) => unit.id),
    'prompt internal population'
  );
  const floorSweeps = diagnostic.floorSweeps;
  same(
    floorSweeps?.map((floor) => floor.threshold),
    [0, 1, 2, 3],
    'floor thresholds'
  );
  const floors = floorSweeps.map((floor) => {
    same(
      floor.units?.map(({ id, positiveIds }) => ({ id, positiveIds })),
      prompts.map(({ id, positiveIds }) => ({ id, positiveIds })),
      'floor labeled population'
    );
    for (const unit of floor.units)
      for (const key of ['internalIds', 'emittedIds']) ids(unit[key], 5, 'floor');
    const internal = summarize(
      floor.units.map((unit) => ({ ...unit, retrievedIds: unit.internalIds }))
    );
    const emitted = summarize(
      floor.units.map((unit) => ({ ...unit, retrievedIds: unit.emittedIds }))
    );
    same(floor.internal, internal, 'floor internal summary');
    same(floor.emitted, emitted, 'floor emitted summary');
    const negative = checkControls(floor.noRelevance, 'floor');
    if (floor.threshold === report.config.effectiveSurfaces.firstPromptFloor) {
      same(
        floor.units.map((unit) => unit.emittedIds),
        prompts.map((unit) => unit.retrievedIds),
        'selected floor emissions'
      );
      same(
        floor.units.map((unit) => unit.internalIds),
        internals.map((unit) => unit.retrievedIds),
        'selected floor internal'
      );
      for (const key of ['internalIds', 'emittedIds'])
        same(
          floor.noRelevance.map((unit) => unit[key]),
          diagnostic.noRelevance.units.map((unit) => unit[key]),
          'selected floor controls'
        );
    }
    return { threshold: floor.threshold, internal, emitted, noRelevance: negative };
  });
  if (![0, 1, 2, 3].includes(report.config.effectiveSurfaces.firstPromptFloor))
    throw new Error('invalid selected floor');
  return {
    paraphrase: Object.fromEntries(
      ['typed', 'mixed'].map((kind) => [
        kind,
        summarize(para.filter((unit) => unit.population === `paraphrase-${kind}`)),
      ])
    ),
    noRelevance,
    floorSweeps: floors,
  };
}
function runGate(options = {}) {
  const root = fs.realpathSync(options.root ?? path.resolve(__dirname, '..'));
  const contract = readContract(root);
  if (isPublicMirror(root))
    return {
      skipped: true,
      reason:
        'Private retrieval evidence is excluded by mirror-to-public.sh; no exclusion roots are tracked in this checkout HEAD/index.',
    };
  const { fixture, baseline } = verifyEvidence(root, contract);
  const before = snapshotSources(root);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-retrieval-gate-'));
  try {
    const output = path.join(work, 'candidate.json');
    execFileSync(
      process.execPath,
      [
        path.join(root, 'scripts/measure-retrieval-quality.js'),
        '--mode',
        'candidate',
        '--fixture',
        fixture,
        '--source-root',
        root,
        '--output',
        output,
      ],
      {
        cwd: root,
        env: { ...process.env, CMOS_CHECKPOINT_SYNC: 'off' },
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    verifyEvidence(root, contract);
    validateReport(report, contract, 'candidate');
    verifyCandidateSource(root, report, contract, before);
    const acceptance = compareReports(baseline, report);
    return {
      skipped: false,
      acceptance,
      sourceFiles: Object.keys(report.sourceHashes).length,
      populations: Object.fromEntries(
        ['primary', 'mission', 'mixed'].map((population) => [
          population,
          {
            baseline: summarize(baseline.units.filter((unit) => unit.population === population)),
            candidate: summarize(report.units.filter((unit) => unit.population === population)),
          },
        ])
      ),
      prompt: {
        baseline: summarize(baseline.units.filter((unit) => unit.population === 'first-prompt')),
        candidate: summarize(report.units.filter((unit) => unit.population === 'first-prompt')),
      },
      diagnostics: diagnosticsSummary(report, contract, fixture),
      baselineFloorSweeps: 'not measured by frozen baseline',
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
function main(argv) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--output'))
    throw new Error('Usage: retrieval-quality-gate.js [--output summary.json]');
  const result = runGate();
  const text = JSON.stringify(result, null, 2) + '\n';
  if (argv.length) {
    fs.mkdirSync(path.dirname(argv[1]), { recursive: true });
    fs.writeFileSync(argv[1], text);
  }
  process.stdout.write(text);
}
if (require.main === module)
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Retrieval quality gate failed: ${error.message}`);
    process.exitCode = 1;
  }
module.exports = { runGate, readContract, isPublicMirror, validateReport, verifyCandidateSource };
