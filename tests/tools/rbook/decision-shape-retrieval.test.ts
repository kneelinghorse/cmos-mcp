// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Rich decision reasoning must remain searchable without expanding public previews.
// ABOUTME: Real store handlers and readonly recall protect each field and existing citation policy.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { rbookContext } from '../../../src/tools/rbook/rbook-context';
import type { ContextSearchResult } from '../../../src/tools/rbook/rbook-context-search';
import { recallLaterPrompt } from '../../../src/cli/later-prompt-recall';
import { recallFirstPrompt } from '../../../src/tools/rbook/first-prompt-recall';
import { decisionEmbeddingInput } from '../../../src/intelligence/embedding-pipeline';

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-shaped-recall-');
});
afterEach(async () => project.cleanup());
const record = async (args: Record<string, unknown>) => {
  const result = await rbookDecisions({
    action: 'record',
    projectRoot: project.projectRoot,
    ...args,
  } as never);
  expect(result.success).toBe(true);
  return (result.data as { decisionId: number }).decisionId;
};

it.each(['context', 'alternatives', 'consequences', 'deciders'])(
  'finds a token occurring only in %s through context search with a headline-only preview',
  async (field) => {
    const token = 'quartznetwork';
    const id = await record({
      content: 'Keep the selected design.',
      [field]: ['alternatives', 'deciders'].includes(field) ? [token] : token,
    });
    const result = await rbookContext({
      action: 'search',
      query: token,
      searchTypes: ['decision'],
      projectRoot: project.projectRoot,
    });
    expect(result.success).toBe(true);
    const match = (result.data as ContextSearchResult).results.find((row) => Number(row.id) === id);
    expect(match).toMatchObject({ text: 'Keep the selected design.' });
  }
);

it('applies the later-prompt keyword floor to reasoning while leaving database bytes untouched', async () => {
  const id = await record({
    content: 'Choose the stable option.',
    context: 'Transactional database safety',
  });
  const before = fs.readFileSync(project.dbPath);
  const result = recallLaterPrompt(project.dbPath, 'Transactional database safety', []);
  expect(result.available).toBe(true);
  expect(result.items).toEqual([
    expect.objectContaining({ id, text: 'Choose the stable option.' }),
  ]);
  expect(fs.readFileSync(project.dbPath)).toEqual(before);
});

it('reads citations in reasoning with the existing earlier-source and local-origin rules', async () => {
  const target = await record({ content: 'Original material choice.' });
  const source = await record({
    content: 'Alchemy revised material.',
    consequences: `Retain decision #${target}.`,
  });
  const db = new Database(project.dbPath);
  db.prepare('UPDATE strategic_decisions SET created_at=? WHERE id=?').run(
    new Date(Date.now() - 86400000).toISOString(),
    target
  );
  db.close();
  // Isolate rich-field citation parsing: the separate floor suite covers final eligibility.
  const result = recallFirstPrompt(project.dbPath, 'alchemy', { minimumKeywordMatches: 0 });
  expect(result.items.find((row) => row.id === target)).toMatchObject({
    retrievalSource: 'citation',
    via: [{ seedId: source, direction: 'out' }],
  });
});

it('composes embedding inputs from all fields and tolerates old rows and malformed arrays', () => {
  expect(
    decisionEmbeddingInput({
      decision_text: ' Headline. ',
      context_text: 'Reason.',
      alternatives: '["Option one","Option two"]',
      consequences: 'Effect.',
      deciders: '["Operator"]',
    })
  ).toBe('Headline.\nReason.\nOption one\nOption two\nEffect.\nOperator');
  expect(decisionEmbeddingInput({ decision_text: 'Old headline.', alternatives: null })).toBe(
    'Old headline.'
  );
  expect(decisionEmbeddingInput({ decision_text: 'Legacy.', alternatives: 'malformed' })).toBe(
    'Legacy.\nmalformed'
  );
});
