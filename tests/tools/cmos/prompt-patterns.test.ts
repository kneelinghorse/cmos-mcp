// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Lock the calibrated procedure list to its published synthetic examples and normalization.
// ABOUTME: Keep operator-selected ceremonies separate from instructions about CMOS procedure.
import {
  matchPrompt,
  isCeremonyCommand,
  normalizePrompt,
  slashCommand,
  PROCEDURE_PATTERNS,
} from '../../../src/tools/cmos/prompt-patterns';
it.each([
  ['P01', 'Open with the review'],
  ['P02', 'Run cmos_review'],
  ['P03', 'cmos_review()'],
  ['P04', 'Start a CMOS session'],
  ['P05', 'Make any final captures'],
  ['P06', 'Record that decision'],
  ['P07', 'Save this in CMOS'],
  ['P08', 'Keep CMOS current'],
  ['P09', 'Close the CMOS session'],
  ['P10', 'Mark this mission complete in CMOS'],
  ['P11', 'Onboard with CMOS'],
  ['P12', 'Read this from CMOS'],
  ['P13', 'Send a message through CMOS'],
])('matches calibrated %s without returning the text', (id, prompt) => {
  expect(matchPrompt(prompt).procedurePatternIds).toContain(id);
  expect(Object.keys(matchPrompt(prompt))).toEqual(['procedurePatternIds', 'ceremony']);
});
it('retains the calibrated list and normalizes rich-text transport artifacts', () => {
  expect(PROCEDURE_PATTERNS.map((p) => p.id)).toEqual(
    Array.from({ length: 13 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`)
  );
  expect(
    matchPrompt('<pasted_content>use&nbsp;cmos\\_review&#x20;()</pasted_content>')
      .procedurePatternIds
  ).toEqual(['P02', 'P03']);
  expect(normalizePrompt('a\u00a0b')).toBe('a b');
});
it('does not conflate a project mention, a path, or a plain ceremony with procedure', () => {
  for (const text of ['CMOS has a dashboard', 'Save this in cmos/planning/notes.md'])
    expect(matchPrompt(text).procedurePatternIds).toEqual([]);
  expect(matchPrompt('Close out the sprint')).toEqual({ procedurePatternIds: [], ceremony: 'C01' });
  expect(matchPrompt('Open a planning session')).toEqual({
    procedurePatternIds: [],
    ceremony: 'C02',
  });
  expect(matchPrompt('Begin the build for sprint 93')).toEqual({
    procedurePatternIds: [],
    ceremony: 'C03',
  });
});
it('marks plugin commands as exempt while preserving procedure evidence and non-plugin command identity', () => {
  const matched = matchPrompt('/cmos:close call cmos_review');
  expect(matched.procedurePatternIds).toEqual(['P02']);
  expect(isCeremonyCommand(matched.ceremony)).toBe(true);
  expect(slashCommand('/compact')).toBe('/compact');
  expect(isCeremonyCommand('/compact')).toBe(false);
  expect(slashCommand('mention /cmos:close')).toBeNull();
  expect(isCeremonyCommand(null)).toBe(false);
});
