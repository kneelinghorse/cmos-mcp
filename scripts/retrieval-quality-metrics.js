// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Enforces paired private retrieval acceptance from typed retrieved and expected identities.
// ABOUTME: Publishes deterministic bootstrap intervals without using a candidate's claimed scores.

const BOOTSTRAP = Object.freeze({ seed: 9406, draws: 10000, quantiles: [0.025, 0.975] });

function unique(values, label) {
  if (!Array.isArray(values) || !values.length) throw new Error(`empty ${label}`);
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
  if (values.some((value) => typeof value !== 'string' || !value)) {
    throw new Error(`invalid ${label}`);
  }
}

function recall(unit) {
  unique(unit.positiveIds, 'positive identities');
  if (!Array.isArray(unit.retrievedIds)) throw new Error('invalid retrieved identities');
  if (unit.retrievedIds.length) unique(unit.retrievedIds, 'retrieved identities');
  const actual = new Set(unit.retrievedIds);
  return unit.positiveIds.filter((id) => actual.has(id)).length / unit.positiveIds.length;
}

function interval(values) {
  if (!values.length) throw new Error('empty denominator');
  if (values.some((value) => !Number.isFinite(value))) throw new Error('nonfinite score');
  let state = BOOTSTRAP.seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const means = Array.from({ length: BOOTSTRAP.draws }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    return sum / values.length;
  }).sort((a, b) => a - b);
  const [low, high] = BOOTSTRAP.quantiles.map((p) => means[Math.floor(p * (means.length - 1))]);
  return {
    units: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    low,
    high,
    halfWidth: (high - low) / 2,
  };
}

function summarize(units) {
  unique(
    units.map((unit) => unit.id),
    'unit ids'
  );
  return interval(units.map(recall));
}

function compareReports(baseline, candidate) {
  for (const field of ['fixtureSha256', 'labelsSha256']) {
    if (!baseline[field] || baseline[field] !== candidate[field]) {
      throw new Error(`benchmark identity changed: ${field}`);
    }
  }
  unique(
    baseline.units.map((unit) => unit.id),
    'baseline unit ids'
  );
  unique(
    candidate.units.map((unit) => unit.id),
    'candidate unit ids'
  );
  if (baseline.units.length !== candidate.units.length)
    throw new Error('paired unit count changed');
  baseline.units.forEach((before, index) => {
    const after = candidate.units[index];
    if (before.id !== after.id) throw new Error(`paired unit order changed: ${index}`);
    if (before.population !== after.population)
      throw new Error(`unit population changed: ${before.id}`);
    if (JSON.stringify(before.positiveIds) !== JSON.stringify(after.positiveIds)) {
      throw new Error(`unit labels changed: ${before.id}`);
    }
    recall(before);
    recall(after);
  });
  const population = (report, name) => report.units.filter((unit) => unit.population === name);
  const before = population(baseline, 'primary');
  const after = population(candidate, 'primary');
  const baselineStats = summarize(before);
  const primary = summarize(after);
  const pairedDelta = interval(after.map((unit, index) => recall(unit) - recall(before[index])));
  const missionBefore = summarize(population(baseline, 'mission'));
  const mission = summarize(population(candidate, 'mission'));
  const missionDelta = mission.mean - missionBefore.mean;
  if (pairedDelta.mean < -baselineStats.halfWidth - 1e-12) {
    throw new Error(`paired recall regression: ${pairedDelta.mean} < -${baselineStats.halfWidth}`);
  }
  if (primary.mean < 0.65) throw new Error(`primary recall ${primary.mean} is below 0.65`);
  if (missionDelta < -1e-12) throw new Error(`mission emission regression: ${missionDelta}`);
  return {
    primary,
    pairedDelta,
    baselineHalfWidth: baselineStats.halfWidth,
    mission,
    missionDelta,
  };
}

module.exports = { BOOTSTRAP, recall, interval, summarize, compareReports };
