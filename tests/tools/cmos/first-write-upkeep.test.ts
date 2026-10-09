// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — first-write upkeep runs only after a call that really wrote, never undoes a stale
// ABOUTME: someone set on purpose, retries after a lock, and never throws. Through the MCP dispatch.

/**
 * Each case is a finding of the m11 data-integrity critic, reproduced on the pre-fix code:
 *  - B1: an explicit status update that kept a decision stale wrote no review stamp, so the repair
 *    restored the row, often inside the same call;
 *  - B2: the upkeep ran after any write-CLASSIFIED call (onboard, a decisions review, a refused or
 *    failed write), and so restored rows and migrated blobs on calls that wrote nothing;
 *  - N5: a lock timeout marked the store as done for the process;
 *  - N6: a master_context that is valid JSON but not an object made the upkeep throw;
 *  - B3 (the m11 reads critic): a report that healed the address or seeded the identity row on its
 *    way counted as a write, so onboard restored statuses, which fork 4 forbids.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import {
  resetFirstWriteMaintenance,
  runFirstWriteMaintenance,
  storeNeedsFirstWriteMaintenance,
} from '../../../src/tools/cmos/first-write-maintenance';
import * as schemaMigrations from '../../../src/tools/cmos/schema-migrations';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

let context: Awaited<ReturnType<typeof buildMissionProtocolContext>>;
let projectRoot: string;
let dbPath: string;

beforeAll(async () => {
  context = await buildMissionProtocolContext();
});

/** A store holding three decisions and a learning in the shape the old opener flagged. */
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m11-upkeep-'));
  dbPath = seedCmosDb(projectRoot, { projectName: 'upkeep' });
  reidentifyCmosTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    // Real stores carry last_reviewed_at (a lazy migration adds it); the seeded schema does not.
    db.exec('ALTER TABLE strategic_decisions ADD COLUMN last_reviewed_at TEXT');
    db.exec('ALTER TABLE learnings ADD COLUMN last_reviewed_at TEXT');
    const sprint = db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)');
    for (let n = 1; n <= 31; n++) {
      sprint.run(`sprint-${n}`, `S${n}`, n === 31 ? 'Active' : 'Completed');
    }
    const decision = db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'sprint-3', 'stale')`
    );
    decision.run(1, 'flagger-shaped one');
    decision.run(2, 'flagger-shaped two');
    decision.run(3, 'flagger-shaped three');
    db.prepare(
      `INSERT INTO learnings (id, content, created_at, sprint_id, status)
       VALUES (1, 'flagger-shaped learning', '2026-01-01T00:00:00Z', 'sprint-3', 'stale')`
    ).run();
  } finally {
    db.close();
  }
  CmosDetector.resetInstance();
  resetFirstWriteMaintenance();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  resetFirstWriteMaintenance();
});

const textOf = (result: Awaited<ReturnType<typeof executeMissionProtocolTool>>): string =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

function decision(id: number): { status: string; last_reviewed_at: string | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT status, last_reviewed_at FROM strategic_decisions WHERE id = ?')
      .get(id) as {
      status: string;
      last_reviewed_at: string | null;
    };
  } finally {
    db.close();
  }
}

const call = (tool: string, args: Record<string, unknown>) =>
  executeMissionProtocolTool(tool, { ...args, projectRoot }, context);

describe('B1 — keeping a decision stale on purpose survives the repair', () => {
  it('an update to the status it already has records the review, and the repair leaves it', async () => {
    const result = await call('cmos_decisions', {
      action: 'update',
      decisionId: 1,
      status: 'stale',
    });
    expect(textOf(result)).toContain('stale (kept; its review time is recorded)');
    // The same call wrote, so its upkeep ran: the other flagger-shaped rows are restored.
    expect(textOf(result)).toContain('Restored 2 decision(s) and 1 learning(s)');
    expect(decision(1).status).toBe('stale');
    expect(decision(1).last_reviewed_at).not.toBeNull();
    expect(decision(2).status).toBe('active');
  });

  it('a batch naming rows already stale records their review, and the repair leaves them', async () => {
    const result = await call('cmos_decisions', {
      action: 'batch_update',
      decisionIds: [1, 2],
      status: 'stale',
    });
    expect(result.isError).not.toBe(true);
    expect([decision(1).status, decision(2).status, decision(3).status]).toEqual([
      'stale',
      'stale',
      'active',
    ]);
    expect(decision(1).last_reviewed_at).not.toBeNull();
  });
});

describe('B1 — an explicit stale a store cannot stamp is refused (FAULT)', () => {
  it.each([
    ['update', { action: 'update', decisionId: 1, status: 'stale' }],
    ['batch_update', { action: 'batch_update', decisionIds: [1, 2], status: 'stale' }],
  ] as const)('%s refuses rather than store a stale the repair would undo', async (_, args) => {
    const db = new Database(dbPath);
    try {
      db.exec('ALTER TABLE strategic_decisions DROP COLUMN last_reviewed_at');
      db.prepare("UPDATE strategic_decisions SET status = 'active' WHERE id IN (1, 2)").run();
    } finally {
      db.close();
    }
    // The column migration fails, as it would on a store this server cannot alter.
    const failed = jest.spyOn(schemaMigrations, 'ensureReviewTimestamps').mockReturnValue({
      columnsAdded: [],
      indexesCreated: [],
      rowsUpdated: 0,
      alreadyCurrent: false,
      warnings: ['ALTER TABLE strategic_decisions ADD COLUMN last_reviewed_at failed (injected)'],
    });
    try {
      const result = await call('cmos_decisions', args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('cannot record when');
      expect(textOf(result)).toContain('(injected)');
    } finally {
      failed.mockRestore();
    }
    const check = new Database(dbPath, { readonly: true });
    try {
      expect(
        check.prepare('SELECT status FROM strategic_decisions WHERE id IN (1, 2) ORDER BY id').all()
      ).toEqual([{ status: 'active' }, { status: 'active' }]);
    } finally {
      check.close();
    }
  });
});

describe('B2 — upkeep runs only after a call that really wrote', () => {
  it.each([
    ['cmos_agent_onboard', {}],
    ['cmos_decisions', { action: 'review' }],
    ['cmos_sprint', { action: 'analytics' }],
    // Refused before writing: no decisionId.
    ['cmos_decisions', { action: 'update', status: 'archived' }],
  ] as const)('%s %j writes nothing, so it repairs nothing', async (tool, args) => {
    const result = await call(tool, args);
    expect(textOf(result)).not.toContain('Store upkeep');
    expect([decision(1).status, decision(2).status, decision(3).status]).toEqual([
      'stale',
      'stale',
      'stale',
    ]);
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(true);
  });

  it('POSITIVE CONTROL: a capture writes, and its answer carries the repair', async () => {
    const result = await call('cmos_session', {
      action: 'capture',
      category: 'context',
      content: 'A real write.',
    });
    expect(textOf(result)).toContain('Store upkeep:');
    expect(decision(1).status).toBe('active');
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(false);
  });
});

describe("B3 — a lazy repair on the way is not the caller's write", () => {
  /** The owner is known and the address is empty, so resolution heals the address on a write. */
  function ownerKnown(): void {
    const db = new Database(dbPath);
    try {
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('owner', 'tester')").run();
    } finally {
      db.close();
    }
  }

  function storedAddress(): string | null {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as
        | { content: string }
        | undefined;
      return row ? (JSON.parse(row.content) as { cmos_address: string }).cmos_address : null;
    } finally {
      db.close();
    }
  }

  const statuses = (): string[] => [decision(1).status, decision(2).status, decision(3).status];

  it.each([
    ['cmos_agent_onboard', {}],
    // A report that is write-classified (decisions review is a read since s93-m11).
    ['cmos_sprint', { action: 'analytics' }],
  ] as const)('%s %j heals the address and still repairs nothing', async (tool, args) => {
    ownerKnown();
    const result = await call(tool, args);
    // The precondition held: the heal really wrote.
    expect(storedAddress()).toBe('cmos://tester/upkeep');
    expect(textOf(result)).not.toContain('Store upkeep');
    expect(statuses()).toEqual(['stale', 'stale', 'stale']);
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(true);
  });

  it('onboard on a store with no identity row seeds it and still repairs nothing', async () => {
    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM contexts WHERE id = 'project_identity'").run();
    } finally {
      db.close();
    }
    const result = await call('cmos_agent_onboard', {});
    expect(storedAddress()).not.toBeNull();
    expect(textOf(result)).not.toContain('Store upkeep');
    expect(statuses()).toEqual(['stale', 'stale', 'stale']);
  });

  it('onboard with feedback writes the feedback and still makes no status write (fork 4)', async () => {
    const result = await call('cmos_agent_onboard', { agentFeedback: 'The opener is clear.' });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT body FROM agent_feedback').all()).toEqual([
        { body: 'The opener is clear.' },
      ]);
    } finally {
      db.close();
    }
    expect(textOf(result)).not.toContain('Store upkeep');
    expect(statuses()).toEqual(['stale', 'stale', 'stale']);
  });

  it('POSITIVE CONTROL: a capture on the same store heals, writes, and carries the repair', async () => {
    ownerKnown();
    const result = await call('cmos_session', {
      action: 'capture',
      category: 'context',
      content: 'A real write after a heal.',
    });
    expect(storedAddress()).toBe('cmos://tester/upkeep');
    expect(textOf(result)).toContain('Store upkeep:');
    expect(statuses()).toEqual(['active', 'active', 'active']);
  });
});

describe('B2 of the reads critic — an index a read leaves out of step is rebuilt by the first write', () => {
  it('a read search names the gap and rebuilds nothing; the upkeep rebuilds it and says so', async () => {
    const db = new Database(dbPath);
    try {
      const trigger = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'decisions_fts_insert'").get() as {
          sql: string;
        }
      ).sql;
      db.exec('DROP TRIGGER decisions_fts_insert');
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
         VALUES (4, 'A decision the index missed.', '2026-10-01T00:00:00Z', 'sprint-31', 'active')`
      ).run();
      db.exec(trigger);
    } finally {
      db.close();
    }
    const indexed = (): number => {
      const check = new Database(dbPath, { readonly: true });
      try {
        return (
          check.prepare('SELECT COUNT(*) AS n FROM decisions_fts_docsize').get() as { n: number }
        ).n;
      } finally {
        check.close();
      }
    };

    const searched = await call('cmos_decisions', { action: 'search', query: 'decision' });
    expect(textOf(searched)).toContain(
      'The decisions search index holds 3 of 4 decisions, so a search can miss 1.'
    );
    expect(indexed()).toBe(3);

    // The upkeep itself, since a write may also rebuild the index on its own way (a capture's
    // related-records search, a first write's column migration).
    const notes = await runFirstWriteMaintenance(projectRoot);
    expect(notes.join('\n')).toContain("Rebuilt this store's search indexes (4 records)");
    expect(indexed()).toBe(4);
  });
});

describe('the confirming critic — a gap a read finds after the first write is rebuilt at the next', () => {
  it('a store this process already maintained still gets the rebuild its read promised', async () => {
    // The first write: full upkeep, and the store counts as maintained for this process.
    await call('cmos_session', { action: 'capture', category: 'context', content: 'First.' });
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(false);

    const db = new Database(dbPath);
    try {
      const trigger = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'decisions_fts_insert'").get() as {
          sql: string;
        }
      ).sql;
      db.exec('DROP TRIGGER decisions_fts_insert');
      // The first write's migrations made the event columns required; copy them from a row.
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status,
                                          project_id, stable_event_id, occurred_at, origin_seq, event_type)
         SELECT 9, 'A decision the index missed later.', '2026-10-01T00:00:00Z', 'sprint-31',
                'active', project_id, 'upkeep-gap-9', occurred_at, origin_seq + 1000, event_type
           FROM strategic_decisions WHERE id = 1`
      ).run();
      db.exec(trigger);
    } finally {
      db.close();
    }
    const gap = (): number => {
      const check = new Database(dbPath, { readonly: true });
      try {
        const n = (sql: string): number => (check.prepare(sql).get() as { n: number }).n;
        return (
          n('SELECT COUNT(*) AS n FROM strategic_decisions') -
          n('SELECT COUNT(*) AS n FROM decisions_fts_docsize')
        );
      } finally {
        check.close();
      }
    };

    const searched = await call('cmos_decisions', { action: 'search', query: 'decision' });
    expect(textOf(searched)).toContain('this server rebuilds it at its next write to this store');
    expect(gap()).toBe(1);
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(true);

    const added = await call('cmos_mission', {
      action: 'add',
      missionId: 'u-m02',
      name: 'Later write',
      sprintId: 'sprint-31',
    });
    expect(textOf(added)).toContain("Rebuilt this store's search indexes");
    // Only the rebuild ran: the staleness repair is not repeated.
    expect(textOf(added)).not.toContain('Restored');
    expect(gap()).toBe(0);
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(false);
  });
});

describe('N5 and N6 — upkeep retries after a failure and never throws', () => {
  it('a store locked by another writer is tried again at the next write', async () => {
    const holder = new Database(dbPath);
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    let notes: string[];
    try {
      notes = await runFirstWriteMaintenance(projectRoot);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(notes.join('\n')).toMatch(/skipped|rolled back|locked/i);
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(true);
    expect(decision(1).status).toBe('stale');

    await runFirstWriteMaintenance(projectRoot);
    expect(decision(1).status).toBe('active');
    expect(storeNeedsFirstWriteMaintenance(projectRoot)).toBe(false);
  }, 30_000);

  it('a master_context that is JSON but not an object is left as it is, without a throw', async () => {
    const db = new Database(dbPath);
    db.prepare("UPDATE contexts SET content = 'null' WHERE id = 'master_context'").run();
    db.close();
    await expect(runFirstWriteMaintenance(projectRoot)).resolves.toEqual(expect.any(Array));
    const check = new Database(dbPath, { readonly: true });
    const row = check.prepare("SELECT content FROM contexts WHERE id = 'master_context'").get() as {
      content: string;
    };
    check.close();
    expect(row.content).toBe('null');
  });
});
