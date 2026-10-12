// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Lock the calibrated procedure list to its published synthetic examples and normalization.
// ABOUTME: Keep operator-selected ceremonies separate from instructions about Reasonbook procedure.
import {
  matchPrompt,
  isCeremonyCommand,
  normalizePrompt,
  slashCommand,
  PROCEDURE_PATTERNS,
} from '../../../src/tools/rbook/prompt-patterns';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
it.each([
  ['P01', 'Open with the review'],
  ['P02', 'Run rbook_review'],
  ['P03', 'rbook_review()'],
  ['P04', 'Start a Reasonbook session'],
  ['P05', 'Make any final captures'],
  ['P06', 'Record that decision'],
  ['P07', 'Save this in Reasonbook'],
  ['P08', 'Keep Reasonbook current'],
  ['P09', 'Close the Reasonbook session'],
  ['P10', 'Mark this mission complete in Reasonbook'],
  ['P11', 'Onboard with Reasonbook'],
  ['P12', 'Read this from Reasonbook'],
  ['P13', 'Send a message through Reasonbook'],
])('matches calibrated %s without returning the text', (id, prompt) => {
  expect(matchPrompt(prompt).procedurePatternIds).toContain(id);
  expect(Object.keys(matchPrompt(prompt))).toEqual(['procedurePatternIds', 'ceremony']);
});
it('retains the calibrated list and normalizes rich-text transport artifacts', () => {
  expect(PROCEDURE_PATTERNS.map((p) => p.id)).toEqual(
    Array.from({ length: 13 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`)
  );
  expect(
    matchPrompt('<pasted_content>use&nbsp;rbook\\_review&#x20;()</pasted_content>')
      .procedurePatternIds
  ).toEqual(['P02', 'P03']);
  expect(normalizePrompt('a\u00a0b')).toBe('a b');
});
it('does not conflate a project mention, a path, or a plain ceremony with procedure', () => {
  for (const name of ['Reasonbook', 'rbook', LEGACY.recordDirectory]) {
    for (const text of [`${name} has a dashboard`, `Save this in ${name}/planning/notes.md`])
      expect(matchPrompt(text).procedurePatternIds).toEqual([]);
  }
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
  const matched = matchPrompt('/reasonbook:close call rbook_review');
  expect(matched.procedurePatternIds).toEqual(['P02']);
  expect(isCeremonyCommand(matched.ceremony)).toBe(true);
  expect(slashCommand('/compact')).toBe('/compact');
  expect(isCeremonyCommand('/compact')).toBe(false);
  expect(slashCommand('mention /reasonbook:close')).toBeNull();
  expect(isCeremonyCommand(null)).toBe(false);
});
it("counts the renamed plugin's commands as ceremony, and the former ones still (s99-m02)", () => {
  // An older installation still sends the former command; neither should count as prompting.
  for (const prompt of [
    '/reasonbook:close call rbook_review',
    `/${LEGACY.recordDirectory}:close call ${LEGACY.toolPrefix}review`,
  ])
    expect(isCeremonyCommand(matchPrompt(prompt).ceremony)).toBe(true);
  expect(isCeremonyCommand('/reasonbooks:close')).toBe(false);
});

it.each(['Reasonbook', 'rbook', LEGACY.proseName])(
  'recognizes procedure under %s without changing historical prompts or ceremony identity',
  (name) => {
    const tool = name === LEGACY.proseName ? `${LEGACY.toolPrefix}review` : 'rbook_review';
    for (const [id, prompt] of [
      ['P01', `Open with reviewing ${name}`],
      ['P02', `Run ${tool}`],
      ['P03', `${tool}()`],
      ['P04', `Start a ${name} session`],
      ['P07', `Save this in ${name}`],
      ['P08', `Keep ${name} current`],
      ['P09', `Close the ${name} session`],
      ['P10', `Mark this mission complete in ${name}`],
      ['P11', `Onboard with ${name}`],
      ['P12', `Read this from ${name}`],
      ['P13', `Send a message through ${name}`],
    ]) {
      expect([id, matchPrompt(prompt).procedurePatternIds]).toEqual([
        id,
        expect.arrayContaining([id]),
      ]);
    }
  }
);
