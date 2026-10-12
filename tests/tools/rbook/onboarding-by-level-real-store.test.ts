// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m06 real-store fire (practice 4): every behavior gated on metadata.project_type, run on
// ABOUTME: a byte copy of this project's own store set to each level, never on the live file.

import { afterAll, beforeAll, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { rbookProjectUpdate } from '../../../src/tools/rbook/rbook-project-update';
import { rbookSprintAdd } from '../../../src/tools/rbook/rbook-sprint-add';
import { rbookMissionAdd } from '../../../src/tools/rbook/rbook-mission-add';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import {
  rbookSessionStart,
  formatSessionStartForLLM,
} from '../../../src/tools/rbook/rbook-session-start';
import { rbookSessionComplete } from '../../../src/tools/rbook/rbook-session-complete';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';

const PRIVATE = requiresPrivateEvidence({
  reason: "The fire runs the level-gated paths on a copy of this project's real store.",
  paths: { liveDb: 'cmos/db/cmos.sqlite' },
});

const SPRINT_WORDS = /(?<![A-Za-z])(sprints?|missions?)(?![A-Za-z])/gi;

PRIVATE.describe('s95-m06 level-gated behavior on a real-store copy', () => {
  let root: string;
  let dbPath: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 's95-m06-real-'));
    dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const source = new Database(PRIVATE.paths.liveDb, { readonly: true, fileMustExist: true });
    try {
      await source.backup(dbPath);
    } finally {
      source.close();
    }
    // Establish, rather than inherit, an open sprint, so the sprint label has something to name. The
    // shipped sprint add stamps the real store's genesis columns (project_id and the rest).
    RbookDetector.resetInstance();
    const added = await rbookSprintAdd({
      projectRoot: root,
      sprintId: 'fire-open',
      title: 'Fire open sprint',
      status: 'Active',
    });
    expect(added.success).toBe(true);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  function setTier(tier: string | null): void {
    const db = new Database(dbPath);
    try {
      if (tier === null) db.prepare(`DELETE FROM metadata WHERE key = 'project_type'`).run();
      else
        db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_type', ?)`).run(
          tier
        );
    } finally {
      db.close();
    }
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
  }

  const digest = async (): Promise<string> => renderDigestV2(await readDigestV2(root)).text;
  const projectLine = async (): Promise<string> => (await digest()).split('\n\n')[0];
  /** Start an explicit session, read its answer, and close it so the next start is not refused. */
  const sessionStart = async (): Promise<string> => {
    const started = await rbookSessionStart({
      projectRoot: root,
      title: 's95-m06 fire',
      type: 'custom',
    });
    expect(started.success).toBe(true);
    const closed = await rbookSessionComplete({
      projectRoot: root,
      sessionId: started.data!.sessionId,
      summary: 's95-m06 fire',
    });
    expect(closed.success).toBe(true);
    return formatSessionStartForLLM(started);
  };

  /**
   * Rows per record table. Virtual tables (FTS5, sqlite-vec) and their shadow tables are indexes
   * over the record, not the record, and an index rebuild may repack them, so they are left out.
   */
  function rowCounts(): Record<string, number> {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as Array<{ name: string; sql: string | null }>;
      const indexes = tables
        .filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql ?? ''))
        .map((t) => t.name);
      return Object.fromEntries(
        tables
          .filter(({ name }) => !indexes.some((v) => name === v || name.startsWith(`${v}_`)))
          .map(({ name }) => [
            name,
            (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
          ])
      );
    } finally {
      db.close();
    }
  }

  it('at Builder the store has an open sprint the digest and session start name', async () => {
    setTier('build');
    expect(await projectLine()).toMatch(/\nSprint \S+ \[/);
    expect(await sessionStart()).toContain('**Sprint**:');
  });

  it('at Ledger neither the digest nor session start names a sprint or a mission', async () => {
    setTier('general');
    expect((await projectLine()).match(SPRINT_WORDS)).toBeNull();
    expect((await sessionStart()).match(SPRINT_WORDS)).toBeNull();
  });

  it('at Planner the digest names the open sprint as a cycle', async () => {
    setTier('managed');
    const line = await projectLine();
    expect(line).toMatch(/\nCycle \S+ \[/);
    expect(line).not.toMatch(/\nSprint /);
    expect(await sessionStart()).toMatch(/\*\*Cycle\*\*: /);
  });

  it('a missing or unknown tier reads as Builder', async () => {
    for (const tier of [null, 'tracker']) {
      setTier(tier);
      expect(await projectLine()).toMatch(/\nSprint \S+ \[/);
    }
  });

  it('a re-init with no level refuses an initial sprint when the stored tier is Ledger, and changes no row', async () => {
    setTier('general');
    const before = rowCounts();
    const refused = await rbookProjectInit({
      projectRoot: root,
      initialSprint: { id: 'fire-refused', title: 'Refused' },
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
    expect(rowCounts()).toEqual(before);
  });

  it("onboard's work suggestions say task at Planner and mission at Builder", async () => {
    // Establish open work rather than inherit it; the shipped add stamps the real store's columns.
    // A real store never looks fresh, so the fresh-project text is fired only on new stores.
    const added = await rbookMissionAdd({
      projectRoot: root,
      missionId: 'fire-work',
      sprintId: 'fire-open',
      name: 'Fire work',
      status: 'Current',
    });
    expect(added.success).toBe(true);
    const work = async (): Promise<string[]> =>
      ((await rbookAgentOnboard({ projectRoot: root })).data?.suggestedActions ?? [])
        .map((a) => a.action)
        .filter((a) => /^(Resolve blocked|Continue in-progress|Start current) /.test(a));

    setTier('managed');
    const planner = await work();
    expect(planner.length).toBeGreaterThan(0);
    for (const action of planner) {
      expect(action).toMatch(/^(Resolve blocked|Continue in-progress|Start current) task: /);
    }
    setTier('build');
    const builder = await work();
    expect(builder.length).toBeGreaterThan(0);
    for (const action of builder) expect(action).toMatch(/ mission: /);
  }, 60_000);

  it('init at the stored Ledger tier writes no Builder document; moving up adds them and loses no row', async () => {
    setTier('general');
    const init = await rbookProjectInit({ projectRoot: root });
    expect(init.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'rbook', 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'rbook', 'tiers', 'build.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'rbook', 'tiers', 'general.md'))).toBe(true);

    const before = rowCounts();
    const up = await rbookProjectUpdate({ projectRoot: root, projectType: 'build' });
    expect(up.success).toBe(true);
    expect(up.data?.filesWritten).toEqual(
      expect.arrayContaining([
        path.join('docs', 'build-session-prompt.md'),
        path.join('tiers', 'build.md'),
      ])
    );
    const after = rowCounts();
    for (const [table, n] of Object.entries(before)) {
      expect([table, after[table] >= n]).toEqual([table, true]);
    }

    const down = await rbookProjectUpdate({ projectRoot: root, projectType: 'general' });
    expect(down.success).toBe(true);
    expect(down.data?.filesWritten).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'rbook', 'tiers', 'build.md'))).toBe(true);
    const afterDown = rowCounts();
    for (const [table, n] of Object.entries(after)) {
      expect([table, afterDown[table] >= n]).toEqual([table, true]);
    }
  }, 60_000);
});
