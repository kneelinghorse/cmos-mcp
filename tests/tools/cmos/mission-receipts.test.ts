// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 (#602, feedback #46) — mission add and update answer with a compact receipt: id,
// ABOUTME: name, status and the fields written, never the mission echoed back. Real handlers.

/**
 * Seeding a ten-mission sprint used to cost 3-5 KB of answer per add, because add echoed the whole
 * mission it had just been given. The receipt names what was stored; cmos_mission(action="show")
 * reads it back. CEILING RULE: JSON.stringify of the structured `data`, in characters.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { cmosMission, formatMissionForLLM } from '../../../src/tools/cmos/cmos-mission';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const LONG = 'This objective is long on purpose, as real mission objectives are. '.repeat(40);

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m11-receipts-'));
  const dbPath = seedCmosDb(projectRoot, { projectName: 's93-m11 receipts' });
  reidentifyCmosTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    db.prepare(`INSERT INTO sprints (id, title, status) VALUES ('sprint-r', 'R', 'Active')`).run();
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('s93-m11 — mission receipts are compact', () => {
  it('add names what it stored and echoes none of it, under 600 characters', async () => {
    const result = await cmosMission({
      action: 'add',
      missionId: 'r-m01',
      name: 'Receipts',
      sprintId: 'sprint-r',
      objective: LONG,
      successCriteria: [LONG, LONG],
      deliverables: ['a.ts', 'b.ts', 'c.ts'],
      notes: LONG,
      projectRoot,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      id: 'r-m01',
      name: 'Receipts',
      sprintId: 'sprint-r',
      status: 'Queued',
      fields: ['objective', 'successCriteria (2)', 'deliverables (3)', 'notes'],
    });
    // The receipt keeps its `mission` field (removing a published field would be a major release)
    // and carries only the mission's identity in it.
    expect(
      (result.data as import('../../../src/tools/cmos/cmos-mission-add').MissionAddResult).mission
    ).toEqual({
      id: 'r-m01',
      name: 'Receipts',
      sprintId: 'sprint-r',
      status: 'Queued',
    });
    const json = JSON.stringify(result.data);
    expect(json).not.toContain('long on purpose');
    expect(json.length).toBeLessThanOrEqual(600);
    expect(formatMissionForLLM('add', result)).not.toContain('long on purpose');

    // The text is stored, and show reads it back.
    const shown = await cmosMission({ action: 'show', missionId: 'r-m01', projectRoot });
    expect(JSON.stringify(shown.data)).toContain('long on purpose');
  });

  it('update names the mission, its status after the update, and the fields it changed', async () => {
    await cmosMission({
      action: 'add',
      missionId: 'r-m02',
      name: 'Before',
      sprintId: 'sprint-r',
      projectRoot,
    });

    const renamed = await cmosMission({
      action: 'update',
      missionId: 'r-m02',
      fields: { name: 'After', objective: LONG },
      projectRoot,
    });
    expect(renamed.success).toBe(true);
    expect(renamed.data).toMatchObject({
      missionId: 'r-m02',
      name: 'After',
      status: 'Queued',
      updatedFields: ['name', 'objective'],
    });
    expect(JSON.stringify(renamed.data)).not.toContain('long on purpose');
    expect(formatMissionForLLM('update', renamed)).toContain("'r-m02' updated: After [Queued]");

    const started = await cmosMission({
      action: 'update',
      missionId: 'r-m02',
      fields: { status: 'Current' },
      projectRoot,
    });
    expect(started.data).toMatchObject({ status: 'Current', previousStatus: 'Queued' });
  });
});
