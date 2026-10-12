// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real MCP dispatch preserves omitted versus explicit NULL mission assignment.
// ABOUTME: Wrong JSON types and zero-sprint dependencies must not fabricate sprint or lifecycle state.
import Database from 'better-sqlite3';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { resetFirstWriteMaintenance } from '../../../src/tools/rbook/first-write-maintenance';
let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let project: SeededRbookProject, db: Database.Database;
beforeAll(async () => {
  context = await buildMissionProtocolContext();
});
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-m05-dispatch-');
  db = new Database(project.dbPath);
  RbookDetector.resetInstance();
  resetFirstWriteMaintenance();
});
afterEach(async () => {
  db.close();
  await project.cleanup();
  resetFirstWriteMaintenance();
});
const dispatch = (tool: string, args: Record<string, unknown>) =>
  executeMissionProtocolTool(tool, { ...args, projectRoot: project.projectRoot }, context);
it('preserves omitted and NULL across the actual MCP boundary with an open sprint', async () => {
  db.exec("INSERT INTO sprints(id,title,status) VALUES('s','Open','Active')");
  for (const [id, choice] of [
    ['infer', {}],
    ['free', { sprintId: null }],
  ] as const) {
    const result = await dispatch('rbook_mission', {
      action: 'add',
      missionId: id,
      name: id,
      ...choice,
    });
    expect(result.isError).not.toBe(true);
  }
  expect(db.prepare('SELECT id,sprint_id FROM missions ORDER BY id').all()).toEqual([
    { id: 'free', sprint_id: null },
    { id: 'infer', sprint_id: 's' },
  ]);
});
it.each([12, true, [], {}])(
  'refuses wrong sprint JSON %j before any mission write',
  async (sprintId) => {
    const result = await dispatch('rbook_mission', {
      action: 'add',
      missionId: 'bad',
      name: 'Bad',
      sprintId,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/INVALID_PARAMETER|Invalid.*sprintId/);
    expect(db.prepare('SELECT id FROM missions').all()).toEqual([]);
  }
);
it('runs add, dependency, list/show/status/onboard, start and complete without any sprint rows', async () => {
  for (const id of ['a', 'b'])
    expect(
      (await dispatch('rbook_mission', { action: 'add', missionId: id, name: id })).isError
    ).not.toBe(true);
  expect(
    (
      await dispatch('rbook_mission', {
        action: 'depends',
        fromId: 'a',
        toId: 'b',
        type: 'Requires',
      })
    ).isError
  ).not.toBe(true);
  for (const args of [{ action: 'list' }, { action: 'show', missionId: 'a' }, { action: 'status' }])
    expect((await dispatch('rbook_mission', args)).isError).not.toBe(true);
  expect((await dispatch('rbook_agent_onboard', {})).isError).not.toBe(true);
  expect(
    (await dispatch('rbook_mission_transition', { action: 'start', missionId: 'b' })).isError
  ).not.toBe(true);
  expect(
    (
      await dispatch('rbook_mission_transition', {
        action: 'complete',
        missionId: 'b',
        notes: 'Completed without a placeholder sprint.',
      })
    ).isError
  ).not.toBe(true);
  expect(db.prepare('SELECT id FROM sprints').all()).toEqual([]);
  expect(db.prepare('SELECT sprint_id FROM missions').all()).toEqual([
    { sprint_id: null },
    { sprint_id: null },
  ]);
});
