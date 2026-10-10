// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The actual MCP dispatcher forwards structured decision fields and returns their full show answer.
// ABOUTME: Invalid nested array values must fail before a decision or authoring session is persisted.

import Database from 'better-sqlite3';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { createSeededCmosProject, type SeededCmosProject } from '../../helpers/seedCmosDb';
import { resetFirstWriteMaintenance } from '../../../src/tools/cmos/first-write-maintenance';
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let project: SeededCmosProject;
beforeAll(async () => {
  context = await buildMissionProtocolContext();
});
beforeEach(async () => {
  project = await createSeededCmosProject({}, 'cmos-decision-dispatch-');
  resetFirstWriteMaintenance();
});
afterEach(async () => {
  await project.cleanup();
  resetFirstWriteMaintenance();
});
const dispatch = (args: Record<string, unknown>) =>
  executeMissionProtocolTool(
    'cmos_decisions',
    { ...args, projectRoot: project.projectRoot },
    context
  );
it('records and shows all fields through real MCP dispatch', async () => {
  const result = await dispatch({
    action: 'record',
    content: 'Use the shared writer.',
    context: 'Keep validation consistent.',
    alternatives: ['Separate SQL'],
    consequences: 'Every interface preserves history.',
    deciders: ['Agent'],
    mode: 'autonomous',
  });
  expect(result.isError).not.toBe(true);
  const db = new Database(project.dbPath, { readonly: true });
  const row = db
    .prepare(
      'SELECT id, context_text, alternatives, consequences, deciders, approval_mode FROM strategic_decisions'
    )
    .get() as { id: number };
  db.close();
  expect(row).toMatchObject({
    context_text: 'Keep validation consistent.',
    alternatives: '["Separate SQL"]',
    consequences: 'Every interface preserves history.',
    deciders: '["Agent"]',
    approval_mode: 'autonomous',
  });
  const shown = await dispatch({ action: 'show', decisionId: row.id });
  expect(shown.isError).not.toBe(true);
  const text = JSON.stringify(shown);
  for (const value of [
    'Keep validation consistent.',
    'Separate SQL',
    'Every interface preserves history.',
    'Agent',
    'autonomous',
  ])
    expect(text).toContain(value);
});
it('rejects malformed nested values before creating a record or session', async () => {
  const result = await dispatch({
    action: 'record',
    content: 'Do not store.',
    alternatives: ['valid', 1],
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('INVALID_PARAMETER');
  const db = new Database(project.dbPath, { readonly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM strategic_decisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
