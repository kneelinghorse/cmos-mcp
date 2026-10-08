// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m05 — a sprint close leaves the sprint's decisions and learnings active unless it is
// ABOUTME: called with archive: true, which archives exactly the rows the s87-m02 predicate names.

/**
 * WHY (operator Q1, decision #1160, 2026-10-06): "data is being lost and teams are working around
 * it". Through 3.1.0 every close archived the closing sprint's active decisions and learnings, and
 * 78% of the fleet's decisions ended up archived, mostly by that step. Since 3.2.0 a close keeps
 * them active; `archive: true` opts into the s87-m02 archival, unchanged.
 *
 * THREE PARTS.
 *   1. A fixture closed through the ROUTER (`cmos_sprint(complete)`), so a router that dropped
 *      `archive` would show here as an opt-in close that archives nothing.
 *   2. A COPY OF THE LIVE STORE (process hardening practice 4). The archival predicate reaches
 *      rows through `missions` and `sessions` as well as `sprint_id`, and a fixture only imitates
 *      those tables. The sprint closed on the copy is the one the predicate reaches the most rows
 *      of, and three rows are PLANTED on it (#547: preconditions are established, never
 *      inherited), so the fire stays positive however the live store changes.
 *   3. The four documents the mission names state the shipped behaviour.
 *
 * THE ORACLE is an independent reading of the s87-m02 predicate, taken on the copy before the
 * close: active decisions, and active learnings that are not evergreen, bound to the sprint by its
 * id, by one of its missions, or by one of its sessions.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import {
  cmosSprintComplete,
  formatSprintCompleteForLLM,
  type CmosSprintCompleteResult,
} from '../../../src/tools/cmos/cmos-sprint-complete';
import {
  CMOS_SPRINT_ACTION_PARAMS,
  cmosSprint,
  cmosSprintToolDefinition,
} from '../../../src/tools/cmos/cmos-sprint';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The close is fired on a copy of the private live store's real decisions, learnings, missions " +
    'and sessions, and two of the documents it checks are private.',
  paths: {
    liveDb: 'cmos/db/cmos.sqlite',
    agents: 'agents.md',
    prompt: 'cmos/docs/build-session-prompt.md',
  },
});

/** The s87-m02 predicate, read independently of the close (`@sprint` is the closing sprint). */
const BOUND_TO_SPRINT = `status = 'active'
   AND (sprint_id = @sprint
     OR mission_id IN (SELECT id FROM missions WHERE sprint_id = @sprint)
     OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = @sprint))`;

function statusOf(dbPath: string, table: 'strategic_decisions' | 'learnings', id: number): string {
  const db = new Database(dbPath);
  try {
    return (db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string })
      .status;
  } finally {
    db.close();
  }
}

// ─── Part 1: the router ──────────────────────────────────────────────────────────────────────

const FIXTURE_SPRINT = 'sprint-m05t';

interface Fixture {
  projectRoot: string;
  dbPath: string;
  decisionId: number;
  learningId: number;
}

function buildFixture(): Fixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s92m05-'));
  const dbPath = seedCmosDb(projectRoot, { projectName: 's92-m05 fixture' });
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date) VALUES (?, 'Keeps the record', 'Active', ?)`
    ).run(FIXTURE_SPRINT, now);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, 'The only mission', 'Completed')`
    ).run(`${FIXTURE_SPRINT}-m01`, FIXTURE_SPRINT);
    const decisionId = Number(
      db
        .prepare(
          `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
           VALUES ('a decision of the closing sprint', ?, ?, 'active')`
        )
        .run(now, FIXTURE_SPRINT).lastInsertRowid
    );
    const learningId = Number(
      db
        .prepare(
          `INSERT INTO learnings (content, created_at, sprint_id, status)
           VALUES ('a learning of the closing sprint', ?, ?, 'active')`
        )
        .run(now, FIXTURE_SPRINT).lastInsertRowid
    );
    return { projectRoot, dbPath, decisionId, learningId };
  } finally {
    db.close();
  }
}

describe('s92-m05 — cmos_sprint(complete) keeps the record unless archive is true', () => {
  it('publishes the default and the opt-in on the registered definition', () => {
    expect(cmosSprintToolDefinition.description).toContain(
      "leaves the sprint's decisions and learnings ACTIVE unless archive is true"
    );
    const properties = cmosSprintToolDefinition.inputSchema.properties as Record<
      string,
      { type: string; description: string }
    >;
    expect(properties.archive).toEqual({
      type: 'boolean',
      description: expect.stringContaining('off by default since 3.2.0'),
    });
    expect(CMOS_SPRINT_ACTION_PARAMS.complete).toContain('archive');
  });

  it.each([
    ['omitted', false, undefined],
    ['false', false, false],
    ['true', true, true],
  ] as const)(
    'archive %s through the router: archives=%s',
    async (_label, archives, archive) => {
      const fixture = buildFixture();
      try {
        const result = (await cmosSprint({
          action: 'complete',
          sprintId: FIXTURE_SPRINT,
          summary: 's92-m05 router close',
          projectRoot: fixture.projectRoot,
          ...(archive === undefined ? {} : { archive }),
        })) as CmosToolResult<CmosSprintCompleteResult>;

        expect(result.success).toBe(true);
        const lifecycle = result.data!.lifecycle;
        expect(lifecycle.archived).toBe(archives);
        expect(lifecycle.archivedDecisionIds).toEqual(archives ? [fixture.decisionId] : []);
        expect(lifecycle.learningIds).toEqual(archives ? [fixture.learningId] : []);
        const expected = archives ? 'archived' : 'active';
        expect(statusOf(fixture.dbPath, 'strategic_decisions', fixture.decisionId)).toBe(expected);
        expect(statusOf(fixture.dbPath, 'learnings', fixture.learningId)).toBe(expected);
      } finally {
        fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
      }
    },
    60_000
  );
});

// ─── Part 2: a copy of the live store ────────────────────────────────────────────────────────

interface RecordState {
  activeDecisions: number[];
  activeLearnings: number[];
  /** The oracle: what the s87-m02 archival would take. */
  boundDecisions: number[];
  boundLearnings: number[];
  /** Active evergreen learnings bound to the sprint — kept even by an archiving close. */
  boundEvergreen: number[];
}

interface Planted {
  decision: number;
  learning: number;
  evergreenLearning: number;
}

interface Run {
  projectRoot: string;
  sprint: string;
  planted: Planted;
  before: RecordState;
  after: RecordState;
  result: CmosToolResult<CmosSprintCompleteResult>;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Opened writably and never `readonly: true`: a WAL store without `-shm` refuses that (C13). */
function readRecord(dbPath: string, sprint: string): RecordState {
  const db = new Database(dbPath);
  try {
    const ids = (sql: string, bound: boolean): number[] => {
      const statement = db.prepare(sql);
      const rows = (bound ? statement.all({ sprint }) : statement.all()) as Array<{ id: number }>;
      return rows.map((row) => row.id);
    };
    return {
      activeDecisions: ids(
        `SELECT id FROM strategic_decisions WHERE status = 'active' ORDER BY id`,
        false
      ),
      activeLearnings: ids(`SELECT id FROM learnings WHERE status = 'active' ORDER BY id`, false),
      boundDecisions: ids(
        `SELECT id FROM strategic_decisions WHERE ${BOUND_TO_SPRINT} ORDER BY id`,
        true
      ),
      boundLearnings: ids(
        `SELECT id FROM learnings WHERE ${BOUND_TO_SPRINT} AND evergreen = 0 ORDER BY id`,
        true
      ),
      boundEvergreen: ids(
        `SELECT id FROM learnings WHERE ${BOUND_TO_SPRINT} AND evergreen = 1 ORDER BY id`,
        true
      ),
    };
  } finally {
    db.close();
  }
}

/** The sprint the predicate reaches the most rows of (ties: the lowest id). */
function chooseSprint(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    const sprints = db.prepare('SELECT id FROM sprints ORDER BY id').all() as Array<{ id: string }>;
    const decisions = db.prepare(
      `SELECT COUNT(*) AS count FROM strategic_decisions WHERE ${BOUND_TO_SPRINT}`
    );
    const learnings = db.prepare(
      `SELECT COUNT(*) AS count FROM learnings WHERE ${BOUND_TO_SPRINT} AND evergreen = 0`
    );
    let best = sprints[0].id;
    let bestCount = -1;
    for (const { id } of sprints) {
      const count =
        (decisions.get({ sprint: id }) as { count: number }).count +
        (learnings.get({ sprint: id }) as { count: number }).count;
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    return best;
  } finally {
    db.close();
  }
}

/**
 * Make the sprint closable on the copy and plant one row of each kind on it. Missions the close
 * would refuse on are Deferred (terminal for a close). Planted rows carry the genesis columns the
 * live store's migrated tables require.
 */
function establish(dbPath: string, sprint: string): Planted {
  const db = new Database(dbPath);
  try {
    return db.transaction(() => {
      db.prepare(`UPDATE sprints SET status = 'Active' WHERE id = ?`).run(sprint);
      db.prepare(
        `UPDATE missions SET status = 'Deferred'
          WHERE sprint_id = ? AND status NOT IN ('Completed', 'Blocked', 'Dropped', 'Deferred')`
      ).run(sprint);
      const projectId = (
        db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as {
          value: string;
        }
      ).value;
      const now = new Date();
      const nextSeq = (table: string): number =>
        (
          db.prepare(`SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM ${table}`).get() as {
            next: number;
          }
        ).next;

      const decision = Number(
        db
          .prepare(
            `INSERT INTO strategic_decisions
               (decision_text, created_at, sprint_id, status,
                project_id, stable_event_id, occurred_at, origin_seq, event_type)
             VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 'decision_captured')`
          )
          .run(
            's92-m05 planted decision',
            now.toISOString(),
            sprint,
            projectId,
            randomUUID(),
            now.getTime(),
            nextSeq('strategic_decisions')
          ).lastInsertRowid
      );
      const plantLearning = (content: string, evergreen: 0 | 1): number =>
        Number(
          db
            .prepare(
              `INSERT INTO learnings
                 (content, category, status, sprint_id, created_at, evergreen,
                  project_id, stable_event_id, occurred_at, origin_seq, event_type)
               VALUES (?, 'process', 'active', ?, ?, ?, ?, ?, ?, ?, 'learning_captured')`
            )
            .run(
              content,
              sprint,
              now.toISOString(),
              evergreen,
              projectId,
              randomUUID(),
              now.getTime(),
              nextSeq('learnings')
            ).lastInsertRowid
        );
      return {
        decision,
        learning: plantLearning('s92-m05 planted learning', 0),
        evergreenLearning: plantLearning('s92-m05 planted evergreen learning', 1),
      };
    })();
  } finally {
    db.close();
  }
}

PRIVATE.describe('s92-m05 on a copy of the live store', () => {
  const runs = new Map<'default' | 'archive', Run>();
  let template: string;
  let hashBefore: string;

  beforeAll(async () => {
    hashBefore = sha256(PRIVATE.paths.liveDb);
    // One backup, copied twice: both closes start from the same bytes even if the live store is
    // written to meanwhile.
    template = fs.mkdtempSync(path.join(os.tmpdir(), 's92-m05-template-'));
    const templateDb = path.join(template, 'cmos.sqlite');
    const source = new Database(PRIVATE.paths.liveDb, { readonly: true, fileMustExist: true });
    try {
      await source.backup(templateDb);
    } finally {
      source.close();
    }

    for (const mode of ['default', 'archive'] as const) {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `s92-m05-${mode}-`));
      const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.copyFileSync(templateDb, dbPath);
      reidentifyCmosTestStore(projectRoot);

      const sprint = chooseSprint(dbPath);
      const planted = establish(dbPath, sprint);
      const before = readRecord(dbPath, sprint);
      CmosDetector.resetInstance();
      const result = await cmosSprintComplete({
        sprintId: sprint,
        summary: `s92-m05 ${mode} close on a live-store copy`,
        projectRoot,
        ...(mode === 'archive' ? { archive: true } : {}),
      });
      runs.set(mode, {
        projectRoot,
        sprint,
        planted,
        before,
        after: readRecord(dbPath, sprint),
        result,
      });
    }
  }, 240_000);

  afterAll(() => {
    for (const run of runs.values()) fs.rmSync(run.projectRoot, { recursive: true, force: true });
    if (template) fs.rmSync(template, { recursive: true, force: true });
    // The live store itself was only ever read.
    expect(sha256(PRIVATE.paths.liveDb)).toBe(hashBefore);
  });

  it('closes the same sprint over the same record in both modes', () => {
    const defaults = runs.get('default')!;
    const archiving = runs.get('archive')!;
    expect(archiving.sprint).toBe(defaults.sprint);
    expect(archiving.planted).toEqual(defaults.planted);
    expect(archiving.before).toEqual(defaults.before);
    // Non-vacuity: the 3.1.0 close would have archived rows here, the planted ones among them.
    expect(defaults.before.boundDecisions).toContain(defaults.planted.decision);
    expect(defaults.before.boundLearnings).toContain(defaults.planted.learning);
    expect(defaults.before.boundEvergreen).toContain(defaults.planted.evergreenLearning);
  });

  it('a default close leaves every active decision and learning in the store active', () => {
    const run = runs.get('default')!;
    expect(run.result.success).toBe(true);
    expect(run.after.activeDecisions).toEqual(run.before.activeDecisions);
    expect(run.after.activeLearnings).toEqual(run.before.activeLearnings);

    const lifecycle = run.result.data!.lifecycle;
    expect(lifecycle.archived).toBe(false);
    expect(lifecycle.decisionsArchived).toBe(0);
    expect(lifecycle.learningsArchived).toBe(0);
    expect(lifecycle.archivedDecisionIds).toEqual([]);
    expect(lifecycle.learningIds).toEqual([]);
    expect(formatSprintCompleteForLLM(run.result)).toContain(
      "Archived: nothing — this sprint's decisions and learnings stay active"
    );
  });

  it('archive: true archives exactly the rows the s87-m02 predicate names, and nothing else', () => {
    const run = runs.get('archive')!;
    expect(run.result.success).toBe(true);
    const lifecycle = run.result.data!.lifecycle;
    const ascending = (ids: number[]): number[] => [...ids].sort((a, b) => a - b);

    expect(lifecycle.archived).toBe(true);
    expect(ascending(lifecycle.archivedDecisionIds)).toEqual(run.before.boundDecisions);
    expect(ascending(lifecycle.learningIds)).toEqual(run.before.boundLearnings);
    expect(lifecycle.decisionsArchived).toBe(run.before.boundDecisions.length);
    expect(lifecycle.learningsArchived).toBe(run.before.boundLearnings.length);

    // The store moved by exactly those rows; evergreen learnings stayed active, as in 3.1.0.
    const without = (ids: number[], removed: number[]): number[] =>
      ids.filter((id) => !removed.includes(id));
    expect(run.after.activeDecisions).toEqual(
      without(run.before.activeDecisions, run.before.boundDecisions)
    );
    expect(run.after.activeLearnings).toEqual(
      without(run.before.activeLearnings, run.before.boundLearnings)
    );
    expect(run.after.activeLearnings).toContain(run.planted.evergreenLearning);

    // The rendered line is the itemized 3.1.0 line.
    expect(formatSprintCompleteForLLM(run.result)).toMatch(
      new RegExp(`Archived: ${lifecycle.decisionsArchived} decisions.*#${run.planted.decision}\\b`)
    );
  });
});

// ─── Part 3: the documents ───────────────────────────────────────────────────────────────────

/** The 3.1.0 wording: the close archives, unconditionally. */
const OLD_CLAIM = /triggers decision archival|archived at their sprint's close,/i;

describe('s92-m05 — the shipped documents state the close', () => {
  it.each(['docs/getting-started.md', 'cmos-seed/tiers/build.md'])(
    '%s says the close keeps the record unless archive: true',
    (relativePath) => {
      const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      expect(text).not.toMatch(OLD_CLAIM);
      expect(text).toContain("The sprint's decisions and learnings stay active unless you pass");
    }
  );
});

PRIVATE.describe('s92-m05 — agents.md and the build-session prompt state the close', () => {
  it('carry the opt-in in practice 10, and agents.md in its Automated Behaviors line', () => {
    for (const file of [PRIVATE.paths.agents, PRIVATE.paths.prompt]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(OLD_CLAIM);
      expect(text).toMatch(
        /archived at their sprint's close only when that close is called with `archive: true`/
      );
    }
    const agents = fs.readFileSync(PRIVATE.paths.agents, 'utf8');
    const automated = agents.split('\n').find((line) => line.startsWith('- **Sprint lifecycle**'));
    expect(automated).toContain('unless it is called with `archive: true`');
  });
});
