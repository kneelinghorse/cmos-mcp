// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retrieval acceptance must reject real positive losses and fixture/population drift.
// ABOUTME: Scores derive from retrieved identities; paired statistics cannot conceal missing units.

const { summarize, compareReports } = require('../../scripts/retrieval-quality-metrics');

const unit = (id: string, population: string, hits = 2) => ({
  id,
  population,
  positiveIds: ['d:1', 'l:1'],
  retrievedIds: ['d:1', 'l:1'].slice(0, hits),
});
const report = (primaryHits = 2) => ({
  fixtureSha256: 'frozen-corpus',
  labelsSha256: 'frozen-labels',
  units: [
    unit('first/decision', 'primary', primaryHits),
    unit('second/learning', 'primary', primaryHits),
    unit('mission/decision', 'mission', 2),
  ],
});

describe('paired retrieval acceptance', () => {
  it('computes recall from typed identities without merging cross-kind numeric collisions', () => {
    const rows = [unit('a', 'primary', 1), unit('b', 'primary', 2)];
    const stats = summarize(rows);
    expect(stats.mean).toBe(0.75);
    expect(stats.units).toBe(2);
    expect(stats.low).toBeLessThanOrEqual(stats.mean);
    expect(stats.high).toBeGreaterThanOrEqual(stats.mean);
    expect(summarize(rows)).toEqual(stats);
  });

  it('fires when known retrieved positives disappear, even if a stored score claims success', () => {
    const baseline = report();
    const candidate = report();
    candidate.units[0].retrievedIds = [];
    Object.assign(candidate.units[0], { recall10: 1 });
    expect(() => compareReports(baseline, candidate)).toThrow(/paired.*regression/i);
  });

  it('requires the absolute 0.65 target even when the candidate improves the baseline', () => {
    expect(() => compareReports(report(0), report(1))).toThrow(/0.65/);
  });

  it('protects actual mission emissions independently of primary recall', () => {
    const candidate = report();
    candidate.units[2].retrievedIds = ['d:1'];
    expect(() => compareReports(report(), candidate)).toThrow(/mission.*regression/i);
  });

  it.each(['fixtureSha256', 'labelsSha256'])(
    'rejects changed %s rather than accepting a different benchmark',
    (field) => {
      const candidate = { ...report(), [field]: 'changed' };
      expect(() => compareReports(report(), candidate)).toThrow(/identity/i);
    }
  );

  it.each(['missing', 'duplicate', 'reordered', 'changed-label', 'changed-population'])(
    'rejects %s paired units',
    (change) => {
      const candidate = report();
      if (change === 'missing') candidate.units.pop();
      if (change === 'duplicate') candidate.units[1].id = candidate.units[0].id;
      if (change === 'reordered') candidate.units.reverse();
      if (change === 'changed-label') candidate.units[0].positiveIds = ['d:2'];
      if (change === 'changed-population') candidate.units[0].population = 'mixed';
      expect(() => compareReports(report(), candidate)).toThrow(/unit|label|population/i);
    }
  );

  it('rejects empty denominators and duplicate positives instead of inflating a score', () => {
    expect(() => summarize([])).toThrow(/empty/i);
    expect(() => summarize([{ ...unit('a', 'primary'), positiveIds: [] }])).toThrow(/positive/i);
    expect(() => summarize([{ ...unit('a', 'primary'), positiveIds: ['d:1', 'd:1'] }])).toThrow(
      /duplicate/i
    );
  });

  it('publishes the paired interval separately from the frozen baseline width', () => {
    const result = compareReports(report(), report());
    expect(result.primary.mean).toBe(1);
    expect(result.pairedDelta).toMatchObject({ mean: 0, low: 0, high: 0 });
    expect(result.baselineHalfWidth).toBe(0);
    expect(result.missionDelta).toBe(0);
  });
});
