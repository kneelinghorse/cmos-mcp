// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Benchmark trials reject invalid knobs and cannot silently override the sealed baseline.
// ABOUTME: The explicit finite grid keeps published floor comparisons reviewable.
const { argumentsFor } = require('../../scripts/measure-retrieval-quality');
it.each(['NaN', 'Infinity', '-0.1', '1.1'])(
  'rejects invalid recency %s before measuring',
  (value) => {
    expect(() => argumentsFor(['--recency', value])).toThrow(/invalid recencyWeight/);
  }
);
it.each(['NaN', '-1', '0.5', '4'])('rejects floor outside frozen integer grid %s', (value) => {
  expect(() => argumentsFor(['--prompt-floor', value])).toThrow(/invalid promptFloor/);
});
it.each(['--recency', '--learning-prior', '--prompt-floor'])(
  'refuses baseline knob override %s',
  (flag) => {
    expect(() => argumentsFor(['--mode', 'baseline', flag, '0'])).toThrow(/baseline overrides/);
  }
);
it('accepts the complete prespecified candidate grid', () => {
  for (const recency of ['0.2', '0.5'])
    for (const prior of ['1', '0.5'])
      for (const floor of ['0', '1', '2', '3'])
        expect(
          argumentsFor(['--recency', recency, '--learning-prior', prior, '--prompt-floor', floor])
        ).toMatchObject({
          mode: 'candidate',
          recencyWeight: Number(recency),
          learningPrior: Number(prior),
          promptFloor: Number(floor),
        });
});
