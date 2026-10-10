// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Publishes fixed diagnostic retrieval slices separately from the primary gate.
// ABOUTME: Age and prompt-floor counts retain explicit denominators and actual hook emissions.

const fs = require('fs');
const path = require('path');
const { sha, checkedJson, timeMs } = require('./retrieval-quality-fixture');
const { summarize } = require('./retrieval-quality-metrics');
const typedIds = (rows) => rows.map((row) => `${row.type === 'learning' ? 'l' : 'd'}:${row.id}`);
function ageBuckets(units, labels, corpus) {
  const queries = new Map(labels.queries.map((q) => [q.id, q]));
  const times = new Map([
    ...corpus.decisions.map((r) => [`d:${r.id}`, timeMs(r.created_at)]),
    ...corpus.learnings.map((r) => [`l:${r.id}`, timeMs(r.created_at)]),
  ]);
  const buckets = Object.fromEntries(
    ['under7Days', '7To30Days', 'atLeast30Days'].map((name) => [
      name,
      { positiveInstances: 0, retrieved: 0 },
    ])
  );
  for (const unit of units.filter((u) => u.population === 'primary')) {
    const query = queries.get(unit.id.slice(0, unit.id.lastIndexOf('/')));
    for (const id of unit.positiveIds) {
      const days = (query.cutoff - times.get(id)) / 86400000;
      if (!Number.isFinite(days) || days <= 0) throw new Error('invalid labeled target age');
      const bucket = buckets[days < 7 ? 'under7Days' : days < 30 ? '7To30Days' : 'atLeast30Days'];
      bucket.positiveInstances++;
      if (unit.retrievedIds.includes(id)) bucket.retrieved++;
    }
  }
  return {
    rule: 'One primary query/typed-positive occurrence per age bucket, not macro query recall; age strictly positive at query cutoff.',
    buckets,
  };
}

async function measureDiagnostics(
  source,
  slice,
  fixture,
  corpus,
  search,
  read,
  config,
  emittedHookIds,
  floorUnits = []
) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixture, 'paraphrase-fixture/manifest.json'), 'utf8')
  );
  const fixed = checkedJson(
    path.join(fixture, 'paraphrase-fixture/paraphrases.json'),
    manifest.sha256
  );
  const controlManifest = JSON.parse(
    fs.readFileSync(path.join(fixture, 'no-relevance-manifest.json'), 'utf8')
  );
  const controls = checkedJson(
    path.join(fixture, 'no-relevance-controls.json'),
    controlManifest.sha256
  );
  if (
    fixed.corpusSha256 !== controls.corpusSha256 ||
    fixed.corpusSha256 !==
      sha(fs.readFileSync(path.join(fixture, 'acceptance-fixture/corpus.json')))
  )
    throw new Error('diagnostic corpus changed');
  const units = [];
  for (const query of fixed.queries) {
    const cutoff = timeMs(query.timeCutoff);
    slice.fill({ cutoff });
    Date.now = () => cutoff;
    for (const mixed of [false, true])
      units.push({
        id: query.id + (mixed ? '/mixed' : '/typed'),
        population: mixed ? 'paraphrase-mixed' : 'paraphrase-typed',
        positiveIds: query.expected,
        retrievedIds: typedIds(
          await search(query.query, mixed ? ['decision', 'learning'] : [query.targetType])
        ),
      });
  }
  const negatives = [];
  const cutoff = timeMs(controls.cutoff);
  slice.fill({ cutoff });
  Date.now = () => cutoff;
  for (const query of controls.queries) {
    const internal = source.recallFirstPrompt(slice.dbPath, query.query, {
      nowMs: cutoff,
      minimumKeywordMatches: config.effectiveSurfaces.firstPromptFloor,
    });
    if (!internal.available || internal.warnings.length)
      throw new Error('negative prompt read failed');
    const floors = await measureFloorVariants(source, slice, query.query, query.id, emittedHookIds);
    negatives.push({
      floors,
      id: query.id,
      internalIds: internal.items.map((r) => `d:${r.id}`),
      emittedIds: await emittedHookIds(source, slice, query.query, query.id),
      missionIds: (await read(() => source.findRelevantDecisions(slice.client, query.query))).map(
        (r) => `d:${r.id}`
      ),
    });
  }
  return {
    paraphraseSha256: manifest.sha256,
    noRelevanceSha256: controlManifest.sha256,
    paraphrase: {
      typed: summarize(units.filter((u) => u.population === 'paraphrase-typed')),
      mixed: summarize(units.filter((u) => u.population === 'paraphrase-mixed')),
      units,
    },
    floorSweeps: floorUnits.map((floor) => ({
      threshold: floor.threshold,
      units: floor.units,
      noRelevance: negatives.map((unit) => ({
        id: unit.id,
        ...unit.floors.find((f) => f.threshold === floor.threshold),
      })),
      internal: summarize(floor.units.map((unit) => ({ ...unit, retrievedIds: unit.internalIds }))),
      emitted: summarize(floor.units.map((unit) => ({ ...unit, retrievedIds: unit.emittedIds }))),
    })),
    noRelevance: {
      rule: controls.role,
      units: negatives,
      nonemptyHooks: negatives.filter((u) => u.emittedIds.length).length,
      emittedDecisions: negatives.reduce((n, u) => n + u.emittedIds.length, 0),
    },
    limitations:
      'Date.now is fixed at historical cutoff. Hook invocation tests actual formatting/output caps, not elapsed deadline latency; deadline behavior remains covered by production unit tests.',
  };
}

async function measureFloorVariants(source, slice, text, sequence, emittedHookIds) {
  const promptModule = source.moduleAt('tools/cmos/first-prompt-recall');
  if (!('DEFAULT_MIN_KEYWORD_MATCHES' in promptModule)) return [];
  const original = promptModule.DEFAULT_MIN_KEYWORD_MATCHES;
  const variants = [];
  try {
    for (const threshold of [0, 1, 2, 3]) {
      promptModule.DEFAULT_MIN_KEYWORD_MATCHES = threshold;
      const internal = source.recallFirstPrompt(slice.dbPath, text, {
        nowMs: Date.now(),
        minimumKeywordMatches: threshold,
      });
      if (!internal.available || internal.warnings.length)
        throw new Error('floor sweep read failed');
      variants.push({
        threshold,
        internalIds: internal.items.map((item) => `d:${item.id}`),
        emittedIds: await emittedHookIds(source, slice, text, `${sequence}-floor-${threshold}`),
      });
    }
    return variants;
  } finally {
    promptModule.DEFAULT_MIN_KEYWORD_MATCHES = original;
  }
}
module.exports = { ageBuckets, measureDiagnostics, measureFloorVariants };
