// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keep the published restatement instrument sensitive to shared content, not boilerplate.
// ABOUTME: Verify both minimum shared terms and cosine dilution with deterministic synthetic rules.
import {
  contentTerms,
  restatedRuleIds,
  RESTATEMENT_MIN_SHARED,
  RESTATEMENT_THRESHOLD,
} from '../../../src/tools/cmos/restatement';
it('keeps the published tokenizer, stemming and calibrated thresholds', () => {
  expect(RESTATEMENT_THRESHOLD).toBe(0.3);
  expect(RESTATEMENT_MIN_SHARED).toBe(5);
  expect([
    ...contentTerms('Please CAPTURE snapshots before migrations; tables changed safely.'),
  ]).toEqual(['capture', 'snapshot', 'migration', 'tabl', 'chang', 'safely']);
});
it('requires at least five shared content terms even for otherwise identical text', () => {
  expect(
    restatedRuleIds('backup schema migration lock', [
      { id: 'c:1', content: 'backup schema migration lock' },
    ])
  ).toEqual([]);
  const text = 'backup schema migration lock snapshots';
  expect(restatedRuleIds(text, [{ id: 'c:1', content: text }])).toEqual(['c:1']);
});
it('rejects long incidental overlap below the calibrated cosine and ignores stopword-only prompts', () => {
  const content = 'backup schema migration lock snapshots';
  const diluted = `${content} ${Array.from({ length: 200 }, (_, i) => `unrelated${i}`).join(' ')}`;
  expect(restatedRuleIds(diluted, [{ id: 'c:1', content }])).toEqual([]);
  expect(restatedRuleIds('please do the work', [{ id: 'l:1', content }])).toEqual([]);
  expect(restatedRuleIds(content, [])).toEqual([]);
});
it('returns stronger matching rule IDs first without leaking content', () => {
  const text = 'backup schema migration lock snapshots';
  expect(
    restatedRuleIds(text, [
      { id: 'l:8', content: `${text} extra conditions caution` },
      { id: 'c:2', content: text },
    ])
  ).toEqual(['c:2', 'l:8']);
});
