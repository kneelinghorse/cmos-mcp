// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 REAL-STORE positive fire — the first-write repair restores this store's 30 + 1
// ABOUTME: flagger-written rows, again after a re-flag, never a reviewed row, and says so on the answer.

/**
 * WHICH STORE. The live store stops holding flagger-written rows the moment a 3.3.0 server makes
 * its first write here, so a copy of today's file would turn this into a test of nothing. The fire
 * reads the store as git recorded it at commit 82b2c9d (sprint-93's plan time, 2026-10-08): 30
 * decisions and 1 learning stored as 'stale', in sprints 66-78 of a store whose highest sprint is 98.
 * The precondition is asserted before anything runs, so the test fails rather than passes vacuously
 * if that commit or the file in it ever changes.
 *
 * The flagger-shaped predicate below is written out independently of the code under test.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { withClient } from '../../../src/tools/cmos/client';
import { cmosReview, formatReviewForLLM } from '../../../src/tools/cmos/cmos-review';
import { createSuccess } from '../../../src/tools/cmos/errors';
import { resetFirstWriteMaintenance } from '../../../src/tools/cmos/first-write-maintenance';
import {
  countReflaggedSinceRepair,
  readStalenessRepairLedger,
  repairFlaggerStaleness,
} from '../../../src/tools/cmos/staleness-detection';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyCmosTestStore } from '../../helpers/seedCmosDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The repair's real-store fire reads this repository's own store from its git history; the public mirror carries neither.",
  paths: { liveDb: 'cmos/db/cmos.sqlite' },
  revisions: { planTime: '82b2c9d' },
});

const COMMIT = PRIVATE.revisions.planTime;
const REPO = path.resolve(__dirname, '..', '..', '..');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  CmosDetector.resetInstance();
});

/** The store as committed at COMMIT, in a fresh temp project root. */
function storeAtCommit(): { projectRoot: string; dbPath: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m11-repair-'));
  tmpDirs.push(projectRoot);
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  fs.writeFileSync(
    dbPath,
    execFileSync('git', ['show', `${PRIVATE.revisions.planTime}:cmos/db/cmos.sqlite`], {
      cwd: REPO,
      maxBuffer: 256 * 1024 * 1024,
    })
  );
  reidentifyCmosTestStore(projectRoot);
  CmosDetector.resetInstance();
  return { projectRoot, dbPath };
}

/** Stale rows by table, read straight from the file. */
function staleIds(dbPath: string): { decisions: number[]; learnings: number[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const ids = (table: string): number[] =>
      (
        db.prepare(`SELECT id FROM ${table} WHERE status = 'stale' ORDER BY id`).all() as Array<{
          id: number;
        }>
      ).map((r) => r.id);
    return { decisions: ids('strategic_decisions'), learnings: ids('learnings') };
  } finally {
    db.close();
  }
}

/** The design doc's flagger-shaped predicate, written out independently of the code. */
function flaggerShaped(dbPath: string): { decisions: number[]; learnings: number[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const highest = (
      db
        .prepare(
          `SELECT MAX(CAST(SUBSTR(id, 8) AS INTEGER)) AS n FROM sprints
            WHERE id GLOB 'sprint-[0-9]*' AND SUBSTR(id, 8) NOT GLOB '*[^0-9]*'`
        )
        .get() as { n: number }
    ).n;
    const canonicalOld = `sprint_id GLOB 'sprint-[0-9]*' AND SUBSTR(sprint_id, 8) NOT GLOB '*[^0-9]*'
       AND CAST(SUBSTR(sprint_id, 8) AS INTEGER) <= ${highest - 10}`;
    const decisions = (
      db
        .prepare(
          `SELECT id FROM strategic_decisions
            WHERE status = 'stale' AND ${canonicalOld}
              AND (evidence IS NULL OR evidence IN ('', '[]'))
              AND id NOT IN (SELECT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL)
              AND last_reviewed_at IS NULL
            ORDER BY id`
        )
        .all() as Array<{ id: number }>
    ).map((r) => r.id);
    const learnings = (
      db
        .prepare(
          `SELECT id FROM learnings
            WHERE status = 'stale' AND ${canonicalOld} AND evergreen = 0 AND last_reviewed_at IS NULL
            ORDER BY id`
        )
        .all() as Array<{ id: number }>
    ).map((r) => r.id);
    return { decisions, learnings };
  } finally {
    db.close();
  }
}

PRIVATE.describe(`s93-m11 real-store fire: the staleness repair on this store at ${COMMIT}`, () => {
  let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
  beforeAll(async () => {
    context = await buildMissionProtocolContext();
  });

  it('PRECONDITION: the store holds 30 + 1 stale rows, every one flagger-shaped', () => {
    const { dbPath } = storeAtCommit();
    const stale = staleIds(dbPath);
    expect([stale.decisions.length, stale.learnings.length]).toEqual([30, 1]);
    expect(flaggerShaped(dbPath)).toEqual(stale);
  });

  it('restores all 31, itemizes nothing left, and stamps no review', async () => {
    const { projectRoot, dbPath } = storeAtCommit();
    const expected = flaggerShaped(dbPath);

    const receipt = await withClient((client) => createSuccess(repairFlaggerStaleness(client)), {
      projectRoot,
    });

    expect(receipt.data!.warnings).toEqual([]);
    expect(receipt.data!.restoredDecisionIds).toEqual(expected.decisions);
    expect(receipt.data!.restoredLearningIds).toEqual(expected.learnings);
    expect(receipt.data!.left).toEqual([]);
    expect(staleIds(dbPath)).toEqual({ decisions: [], learnings: [] });

    const db = new Database(dbPath, { readonly: true });
    try {
      const stamped = db
        .prepare(
          `SELECT COUNT(*) AS n FROM strategic_decisions
            WHERE id IN (${expected.decisions.join(',')}) AND last_reviewed_at IS NOT NULL`
        )
        .get() as { n: number };
      expect(stamped.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('never touches a row with a review stamp, and names why it left it', async () => {
    const { projectRoot, dbPath } = storeAtCommit();
    const { decisions } = flaggerShaped(dbPath);
    const reviewed = decisions[0];
    const write = new Database(dbPath);
    try {
      write
        .prepare('UPDATE strategic_decisions SET last_reviewed_at = ? WHERE id = ?')
        .run(new Date().toISOString(), reviewed);
    } finally {
      write.close();
    }

    const receipt = await withClient((client) => createSuccess(repairFlaggerStaleness(client)), {
      projectRoot,
    });
    expect(receipt.data!.restoredDecisionIds).not.toContain(reviewed);
    expect(receipt.data!.left).toEqual([{ table: 'decisions', id: reviewed, reason: 'reviewed' }]);
    expect(staleIds(dbPath).decisions).toEqual([reviewed]);
  });

  it('a write through the MCP dispatch repairs once, says so on the answer, and review reports a re-flag', async () => {
    const { projectRoot, dbPath } = storeAtCommit();
    const before = flaggerShaped(dbPath);
    resetFirstWriteMaintenance();

    const captured = await executeMissionProtocolTool(
      'cmos_session',
      {
        action: 'capture',
        category: 'context',
        content: 'A write that is this process’s first in the store.',
        projectRoot,
      },
      context
    );
    const text = captured.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    expect(text).toContain('Store upkeep:');
    expect(text).toContain('Restored 30 decision(s) and 1 learning(s) to active');
    expect(staleIds(dbPath)).toEqual({ decisions: [], learnings: [] });

    // An older server's opener flags the same rows again.
    const write = new Database(dbPath);
    try {
      write
        .prepare(
          `UPDATE strategic_decisions SET status = 'stale' WHERE id IN (${before.decisions.join(',')})`
        )
        .run();
    } finally {
      write.close();
    }

    const review = await cmosReview({ projectRoot }, { callerProvidedProjectRoot: true });
    expect(review.data!.staleReflagged?.count).toBe(30);
    expect(formatReviewForLLM(review)).toContain('an older CMOS server still runs the opener');

    // This process already maintained the store; a new process's first write restores them again.
    resetFirstWriteMaintenance();
    const second = await withClient((client) => createSuccess(repairFlaggerStaleness(client)), {
      projectRoot,
    });
    expect(second.data!.restoredDecisionIds).toHaveLength(30);
    expect(second.data!.reflagged).toBe(30);
    const ledger = await withClient((client) => createSuccess(readStalenessRepairLedger(client)), {
      projectRoot,
    });
    expect(ledger.data).toMatchObject({ runs: 2, totalRestored: 61, reflaggedRestored: 30 });
    const after = await withClient((client) => createSuccess(countReflaggedSinceRepair(client)), {
      projectRoot,
    });
    expect(after.data?.count).toBe(0);
  });
});
