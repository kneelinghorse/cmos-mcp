#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Measures actual keyword retrieval, mission emissions and prompt output on frozen temporal slices.
// ABOUTME: Never rebuilds dist or opens a live project store; immutable outputs pair with a sealed baseline.

const fs = require('fs');
const path = require('path');
const {
  sha,
  checkedJson,
  timeMs,
  loadSource,
  createSlice,
} = require('./retrieval-quality-fixture');
const { BOOTSTRAP, summarize, compareReports } = require('./retrieval-quality-metrics');

const {
  ageBuckets,
  measureDiagnostics,
  measureFloorVariants,
} = require('./retrieval-quality-diagnostics');

const EVALUATOR_FILES = [
  'measure-retrieval-quality.js',
  'retrieval-quality-fixture.js',
  'retrieval-quality-metrics.js',
  'retrieval-quality-diagnostics.js',
];
const evaluatorHashes = () =>
  Object.fromEntries(
    EVALUATOR_FILES.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, name)))])
  );
const INITIAL_EVALUATOR_HASHES = evaluatorHashes();

const DEFAULT_FIXTURE = 'cmos/research/2026-10-s94-m06';
const typedIds = (rows) => rows.map((row) => `${row.type === 'learning' ? 'l' : 'd'}:${row.id}`);

async function emittedHookIds(source, slice, query, sequence) {
  let stdout = '';
  const errors = [];
  const code = await source.runCli(
    ['hook', 'prompt', '--format', 'text', '--project-root', slice.root],
    {
      env: {
        ...process.env,
        CMOS_AMBIENT: 'on',
        CLAUDE_PROJECT_DIR: '',
        CMOS_PROJECT_ROOT: slice.root,
      },
      cwd: slice.root,
      readStdin: async () => JSON.stringify({ session_id: `quality-${sequence}`, prompt: query }),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => errors.push(text),
    }
  );
  if (code !== 0 || errors.length || stdout.length > 1501) {
    throw new Error(`hook delivery failed: ${code}; ${errors.join(';')}`);
  }
  return [...stdout.matchAll(/^ {2}• (d:[1-9]\d*) /gm)].map((match) => match[1]);
}

async function measure(options) {
  const root = options.sourceRoot ?? path.resolve(__dirname, '..');
  const fixture = path.resolve(options.fixture ?? DEFAULT_FIXTURE);
  const corpusManifest = JSON.parse(
    fs.readFileSync(path.join(fixture, 'acceptance-fixture/manifest.json'), 'utf8')
  );
  const labelManifest = JSON.parse(
    fs.readFileSync(path.join(fixture, 'frozen-labels/manifest.json'), 'utf8')
  );
  const corpus = checkedJson(
    path.join(fixture, 'acceptance-fixture/corpus.json'),
    corpusManifest.sha256
  );
  const labels = checkedJson(
    path.join(fixture, 'frozen-labels/labels.json'),
    labelManifest.labelsSha256
  );
  if (corpusManifest.sha256 !== labelManifest.corpusSha256)
    throw new Error('label corpus identity differs');
  const source = loadSource(root);
  const originalNow = Date.now;
  let slice;
  try {
    source.verify();
    const baseline = options.mode === 'baseline';
    if (
      baseline &&
      (source.DEFAULT_RECENCY_WEIGHT !== 0.2 ||
        source.DEFAULT_RRF_K !== 30 ||
        source.FTS_MAX_KEYWORDS !== 64)
    ) {
      throw new Error('baseline defaults changed');
    }
    // Trial overrides live in this isolated process and reach mission surfacing too.
    // Final acceptance omits overrides and tests the published defaults.
    if (options.recencyWeight !== undefined)
      source.retrieval.DEFAULT_RECENCY_WEIGHT = options.recencyWeight;
    const promptModule = source.moduleAt('tools/cmos/first-prompt-recall');
    if (options.promptFloor !== undefined)
      promptModule.DEFAULT_MIN_KEYWORD_MATCHES = options.promptFloor;
    slice = await createSlice(source, corpus, !baseline);
    const config = {
      mode: options.mode,
      keywordOnly: true,
      recencyWeight: source.retrieval.DEFAULT_RECENCY_WEIGHT,
      learningPrior: options.learningPrior ?? source.retrieval.DEFAULT_LEARNING_PRIOR ?? 1,
      citationRecall: !baseline,
      effectiveSurfaces: {
        directAndMissionRecency: source.retrieval.DEFAULT_RECENCY_WEIGHT,
        firstPromptRecency: 0.2,
        firstPromptFloor: promptModule.DEFAULT_MIN_KEYWORD_MATCHES ?? 0,
        learningPrior: 'mixed search only',
      },
      rrfK: 30,
      maxKeywords: 64,
      candidatePoolMultiplier: 5,
      bootstrap: BOOTSTRAP,
      statusRule: labelManifest.temporalRule,
      floorPolicy:
        'final bounded union before top-five; unchanged seeds; thresholds0/1/2/3 frozen before tuning',
    };
    const units = [];
    const floorUnits =
      'DEFAULT_MIN_KEYWORD_MATCHES' in promptModule
        ? [0, 1, 2, 3].map((threshold) => ({ threshold, units: [] }))
        : [];
    const read = async (fn) => (await source.captureToolCall('read', fn)).value;
    const search = (query, types) =>
      read(() =>
        new source.HybridRetriever(slice.client).search(query, {
          types,
          limit: 10,
          recencyWeight: config.recencyWeight,
          citationRecall: config.citationRecall,
          learningPrior: config.learningPrior,
        })
      );
    const add = (query, suffix, population, positives, retrievedIds) => {
      if (!positives.length) return;
      units.push({ id: `${query.id}/${suffix}`, population, positiveIds: positives, retrievedIds });
    };
    for (const [index, query] of labels.queries.entries()) {
      slice.fill(query);
      Date.now = () => query.cutoff;
      for (const [type, prefix] of [
        ['decision', 'd:'],
        ['learning', 'l:'],
      ]) {
        const positives = query.positiveIds.filter((id) => id.startsWith(prefix));
        if (!positives.length) continue;
        if (query.kind !== 'mission') {
          add(query, type, 'primary', positives, typedIds(await search(query.full, [type])));
          add(
            query,
            `${type}-cite`,
            'citing-sentence',
            positives,
            typedIds(await search(query.cite, [type]))
          );
        } else if (type === 'decision') {
          const rows = await read(() => source.findRelevantDecisions(slice.client, query.full));
          add(
            query,
            'mission',
            'mission',
            positives,
            rows.map((row) => `d:${row.id}`)
          );
        }
      }
      if (query.kind !== 'mission') {
        add(
          query,
          'mixed',
          'mixed',
          query.positiveIds,
          typedIds(await search(query.full, ['decision', 'learning']))
        );
        const decisions = query.positiveIds.filter((id) => id.startsWith('d:'));
        if (decisions.length) {
          const prompt = source.recallFirstPrompt(slice.dbPath, query.cite, {
            nowMs: query.cutoff,
            minimumKeywordMatches: config.effectiveSurfaces.firstPromptFloor,
          });
          if (!prompt.available || prompt.warnings.length)
            throw new Error(`first prompt failed: ${query.id}; ${prompt.warnings}`);
          add(
            query,
            'first-prompt-internal',
            'first-prompt-internal',
            decisions,
            prompt.items.map((item) => `d:${item.id}`)
          );
          add(
            query,
            'first-prompt',
            'first-prompt',
            decisions,
            await emittedHookIds(source, slice, query.cite, index)
          );
          const variants = await measureFloorVariants(
            source,
            slice,
            query.cite,
            index,
            emittedHookIds
          );
          for (const variant of variants)
            floorUnits
              .find((f) => f.threshold === variant.threshold)
              .units.push({
                id: `${query.id}/first-prompt`,
                positiveIds: decisions,
                internalIds: variant.internalIds,
                emittedIds: variant.emittedIds,
              });
        }
      }
      if ((index + 1) % 50 === 0)
        options.progress?.({ queries: index + 1, total: labels.queries.length });
    }
    const diagnostics = await measureDiagnostics(
      source,
      slice,
      fixture,
      corpus,
      search,
      read,
      config,
      emittedHookIds,
      floorUnits
    );
    const populations = {};
    for (const population of [...new Set(units.map((unit) => unit.population))]) {
      populations[population] = summarize(units.filter((unit) => unit.population === population));
    }
    if (
      populations.primary.units !== labelManifest.counts.primary ||
      populations.mission.units !== labelManifest.counts.mission ||
      populations.mixed.units !== labelManifest.counts.mixed
    ) {
      throw new Error('frozen unit count changed');
    }
    const report = {
      measuredAt: new Date(originalNow()).toISOString(),
      fixtureSha256: corpusManifest.sha256,
      labelsSha256: labelManifest.labelsSha256,
      config,
      diagnostics,
      ageBuckets: ageBuckets(units, labels, corpus),
      evaluatorHashes: INITIAL_EVALUATOR_HASHES,
      sourceHashes: source.verify(),
      populations,
      primaryRecall5: summarize(
        units
          .filter((u) => u.population === 'primary')
          .map((u) => ({ ...u, retrievedIds: u.retrievedIds.slice(0, 5) }))
      ),
      primaryMrr10: units
        .filter((u) => u.population === 'primary')
        .reduce((sum, u, _i, all) => {
          const index = u.retrievedIds.findIndex((id) => u.positiveIds.includes(id));
          return sum + (index < 0 ? 0 : 1 / (index + 1)) / all.length;
        }, 0),
      units,
      skipped: 0,
    };
    if (JSON.stringify(INITIAL_EVALUATOR_HASHES) !== JSON.stringify(evaluatorHashes()))
      throw new Error('evaluator source changed during measurement');
    return report;
  } finally {
    Date.now = originalNow;
    slice?.close();
    source.restore();
  }
}

function argumentsFor(argv) {
  const options = { mode: 'candidate' };
  const fields = {
    '--fixture': 'fixture',
    '--source-root': 'sourceRoot',
    '--output': 'output',
    '--baseline': 'baseline',
    '--mode': 'mode',
    '--recency': 'recencyWeight',
    '--learning-prior': 'learningPrior',
    '--prompt-floor': 'promptFloor',
  };
  for (let i = 0; i < argv.length; i++) {
    const field = fields[argv[i]];
    if (!field || !argv[i + 1]) throw new Error(`invalid argument: ${argv[i]}`);
    const value = argv[++i];
    options[field] = ['recencyWeight', 'learningPrior', 'promptFloor'].includes(field)
      ? Number(value)
      : value;
  }
  if (!['baseline', 'candidate'].includes(options.mode)) throw new Error('invalid mode');
  for (const field of ['recencyWeight', 'learningPrior'])
    if (
      options[field] !== undefined &&
      (!Number.isFinite(options[field]) || options[field] < 0 || options[field] > 1)
    )
      throw new Error(`invalid ${field}`);
  if (options.promptFloor !== undefined && ![0, 1, 2, 3].includes(options.promptFloor))
    throw new Error('invalid promptFloor');
  if (
    options.mode === 'baseline' &&
    ['recencyWeight', 'learningPrior', 'promptFloor'].some((field) => options[field] !== undefined)
  )
    throw new Error('baseline overrides forbidden');
  if (options.output && fs.existsSync(options.output))
    throw new Error('refusing to replace frozen measurement output');
  return options;
}

async function main(argv) {
  const options = argumentsFor(argv);
  const report = await measure({
    ...options,
    progress: (value) => console.error(JSON.stringify(value)),
  });
  let gate;
  if (options.baseline)
    gate = compareReports(JSON.parse(fs.readFileSync(options.baseline, 'utf8')), report);
  if (options.output) fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ populations: report.populations, gate, sha256: sha(JSON.stringify(report)) })
  );
}

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { measure, emittedHookIds, argumentsFor, ageBuckets };
