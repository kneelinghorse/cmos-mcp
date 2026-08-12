// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m02b criterion "safecount" — the sprint's own close instrument must not report a
// ABOUTME: failed query as a zero. Proven on real temp stores, asserted on the rendered block.

/**
 * Sprint 86 m02b — the fail-quiet defect INSIDE the instrument that measures it.
 *
 * WHY THIS MATTERS (agents.md Rule 9 — this test encodes intent, not shape):
 *
 * `scripts/measure-cross-store-baseline.ts` walks every registered CMOS store and COUNT(*)s the
 * append-only domain tables. Those counts are the DENOMINATOR of the mutable-write share, and
 * that share is the number the s68 App-View / CRDT trigger is read against — the number
 * s86's arc recommendation ("21.04% vs the 25% CRDT trigger") rests on. The script does not
 * merely print it: `main()` rewrites `cmos/planning/phase-2-master-plan.md` IN PLACE, splicing
 * the rendered block between `<!-- BASELINE-MEASUREMENT-S69M01 -->` markers. Whatever this
 * instrument believes becomes the roadmap's stated fact.
 *
 * Before this mission, `safeCount` returned 0 for BOTH of these, indistinguishably and silently:
 *
 *   1. the table is ABSENT      → the count genuinely IS zero (a foreign or partial store)
 *   2. the query ERRORED        → the count is UNKNOWN, and it is NOT zero
 *
 * Case 2 is a lie with a number attached, and it biases in a specific direction: `constraints`
 * feeds `sumAppendWrites`, so swallowing its count SHRINKS the denominator and pushes the
 * mutable share UP, toward the trigger. This is not hypothetical — the s86 planning replication
 * recorded a fleet aggregate coming back 20.94% instead of 21.04% because one store's
 * `constraints` read errored to zero.
 *
 * SO THE BEHAVIOUR UNDER TEST IS: the two zeros must stay apart, and the second one must reach
 * the reader. "Reach the reader" means the FORMATTED TEXT — `renderMarkdownSummary`, which IS
 * the block written between the file markers. A diagnostic that lives only on the report object
 * is exactly the fail-quiet class this sprint exists to close.
 *
 * HOW THE FAILURE IS FORCED — at the DATABASE, never with a mock client (agents.md Process
 * Hardening #4: a mock cannot catch a wrong-column or wrong-table SQL bug). On a temp store we
 * replace `constraints` with an FTS5 virtual table and then drop its `constraints_data` shadow.
 * The result is precisely the case the criterion names and the hardest one to fake:
 *   - `sqlite_master` still carries `constraints` with `type='table'` — so `probeTable` reports
 *     PRESENT and we are provably in the failed-QUERY branch, not the absent-table branch;
 *   - `SELECT COUNT(*) FROM constraints` raises SQLITE_CORRUPT_VTAB;
 *   - every OTHER table on that same store still counts correctly, so the failure is
 *     attributable to one table rather than to a globally broken fixture.
 *
 * NEVER AGAINST THE LIVE STORE. Every store here is `fs.mkdtempSync` + `seedCmosDb`, and
 * `main()` is never invoked — see the "run output" test at the bottom for why, and for what
 * that costs.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildReport,
  countStoreWrites,
  materializeDefaultQueries,
  newReadDiagnostics,
  readStoreCounts,
  renderMarkdownSummary,
  safeCount,
} from '../../../scripts/measure-cross-store-baseline';
import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { seedCmosDb } from '../../helpers/seedCmosDb';

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/measure-cross-store-baseline.ts');

// The markers `main()` splices the rendered block between (script :51-52). Duplicated here on
// purpose: if the script's markers ever change, the roadmap's existing block stops being
// replaced and starts being appended — a silent doubling this assertion catches.
const MARK_START = '<!-- BASELINE-MEASUREMENT-S69M01 -->';
const MARK_END = '<!-- /BASELINE-MEASUREMENT-S69M01 -->';

// No hardcoded dates (agents.md): every timestamp below is Date.now()-relative.
const NOW = Date.now();
const isoDaysBefore = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface StoreSeed {
  decisions: number;
  supersededDecisions: number;
  learnings: number;
  missions: number;
  completedMissions: number;
  sprints: number;
  completedSprints: number;
  constraints: number;
}

/** A real, seeded CMOS store in a temp dir. WAL, because the script opens read-only. */
function seedStore(prefix: string, seed: StoreSeed): { projectRoot: string; dbPath: string } {
  const projectRoot = mkTmp(prefix);
  const dbPath = seedCmosDb(projectRoot, { projectName: path.basename(projectRoot) });

  const db = new Database(dbPath);
  try {
    // The client forces WAL on open; a read-only open cannot set it, so match real stores.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    const dec = db.prepare(
      'INSERT INTO strategic_decisions (decision_text, created_at, superseded_by) VALUES (?, ?, ?)'
    );
    for (let i = 0; i < seed.decisions; i += 1) {
      dec.run(`decision ${i}`, isoDaysBefore(i + 1), i < seed.supersededDecisions ? 1 : null);
    }
    const lrn = db.prepare(
      'INSERT INTO learnings (content, category, created_at) VALUES (?, ?, ?)'
    );
    for (let i = 0; i < seed.learnings; i += 1)
      lrn.run(`learning ${i}`, 'technical', isoDaysBefore(2));

    const mis = db.prepare(
      'INSERT INTO missions (id, name, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < seed.missions; i += 1) {
      const done = i < seed.completedMissions;
      mis.run(
        `m${i}`,
        `mission ${i}`,
        done ? 'Completed' : 'In Progress',
        isoDaysBefore(3),
        done ? isoDaysBefore(1) : null
      );
    }
    const spr = db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)');
    for (let i = 0; i < seed.sprints; i += 1) {
      spr.run(`s${i}`, `sprint ${i}`, i < seed.completedSprints ? 'Completed' : 'Active');
    }
    const con = db.prepare(
      'INSERT INTO constraints (content, status, created_at) VALUES (?, ?, ?)'
    );
    for (let i = 0; i < seed.constraints; i += 1)
      con.run(`constraint ${i}`, 'active', isoDaysBefore(4));
  } finally {
    db.close();
  }
  return { projectRoot, dbPath };
}

/** The two states a `constraints` count can legitimately be zero-ish in — kept strictly apart. */
function removeConstraintsTable(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec('DROP TABLE constraints');
  } finally {
    db.close();
  }
}

/**
 * Make `constraints` EXIST but be UNQUERYABLE.
 *
 * Swap the real table for an FTS5 virtual table of the same name, then drop the
 * `constraints_data` shadow table out from under it. `sqlite_master` keeps a `type='table'` row
 * named `constraints` (so the presence probe says PRESENT), while any read of it raises
 * SQLITE_CORRUPT_VTAB. `unsafeMode` is required only to lift better-sqlite3's defensive
 * shadow-table protection; nothing outside this temp file is touched.
 */
function makeConstraintsUnqueryable(dbPath: string, rows: number): void {
  const db = new Database(dbPath);
  try {
    db.exec('DROP TABLE constraints');
    db.exec('CREATE VIRTUAL TABLE constraints USING fts5(content)');
    const ins = db.prepare('INSERT INTO constraints (content) VALUES (?)');
    for (let i = 0; i < rows; i += 1) ins.run(`constraint ${i}`);

    // PROBE-BEFORE-ENCODE: the table must be queryable HERE, so the breakage below is what
    // makes it fail — not the swap itself.
    expect(db.prepare('SELECT COUNT(*) AS c FROM constraints').get()).toEqual({ c: rows });

    db.unsafeMode(true);
    db.exec('DROP TABLE constraints_data');
  } finally {
    db.close();
  }
}

/** Read `sqlite_master` directly — independent of the script's own presence probe. */
function sqliteMasterEntry(
  dbPath: string,
  name: string
): { name: string; type: string } | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, type FROM sqlite_master WHERE name = ?').get(name) as
      | { name: string; type: string }
      | undefined;
  } finally {
    db.close();
  }
}

async function openReadonly(dbPath: string): Promise<CmosDatabaseClient> {
  const res = await CmosDatabaseClient.create({ dbPath, readonly: true });
  expect(res.success).toBe(true);
  return res.data!;
}

const HEALTHY: StoreSeed = {
  decisions: 2,
  supersededDecisions: 1,
  learnings: 1,
  missions: 2,
  completedMissions: 1,
  sprints: 2,
  completedSprints: 1,
  constraints: 3,
};
// append = 2 decisions + 1 learning + 2 missions + 2 sprints + 3 constraints = 10
const HEALTHY_APPEND = 10;
// transition = 2 started + 1 completed + 1 sprint completed + 1 superseded = 5
const HEALTHY_TRANSITION = 5;

const OTHER: StoreSeed = {
  decisions: 5,
  supersededDecisions: 0,
  learnings: 4,
  missions: 3,
  completedMissions: 0,
  sprints: 1,
  completedSprints: 0,
  constraints: 3,
};

describe('safeCount: an absent table and a failed query are not the same zero', () => {
  it('a healthy store counts `constraints` for real, with an empty diagnostics sink', async () => {
    // NEGATIVE CONTROL for everything below: if the fixture could not count `constraints` in the
    // first place, the two failure tests would pass for the wrong reason.
    const { dbPath } = seedStore('safecount-healthy-', HEALTHY);
    const client = await openReadonly(dbPath);
    try {
      const diag = newReadDiagnostics();
      expect(safeCount(client, 'constraints', '', diag)).toBe(3);
      expect(diag.absentTables).toEqual([]);
      expect(diag.queryErrors).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('an ABSENT table returns a genuine 0 and is NOTED — not silently swallowed', async () => {
    const { projectRoot, dbPath } = seedStore('safecount-absent-', HEALTHY);
    removeConstraintsTable(dbPath);
    expect(sqliteMasterEntry(dbPath, 'constraints')).toBeUndefined();

    const client = await openReadonly(dbPath);
    try {
      const diag = newReadDiagnostics();
      expect(safeCount(client, 'constraints', '', diag)).toBe(0);
      // The zero is real, so it is a COUNT — but it is disclosed, not silent.
      expect(diag.absentTables).toContain('constraints');
      expect(diag.queryErrors).toEqual([]);

      // A store missing a table is still RELIABLE: its other counts are true.
      const per = readStoreCounts(projectRoot, client);
      expect(per.reliable).toBe(true);
      expect(per.constraints).toBe(0);
      expect(per.decisions).toBe(2);
      expect(per.appendWrites).toBe(HEALTHY_APPEND - 3);
    } finally {
      client.close();
    }
  });

  it('records an absent table ONCE per store even though `missions` is counted three times', async () => {
    // `countStoreWrites` calls safeCount on `missions` three times (total / started / completed).
    // Three identical notes would be noise the operator learns to skip past.
    const { dbPath } = seedStore('safecount-absent-missions-', HEALTHY);
    const db = new Database(dbPath);
    db.exec('DROP TABLE missions');
    db.close();

    const client = await openReadonly(dbPath);
    try {
      const diag = newReadDiagnostics();
      countStoreWrites(client, diag);
      expect(diag.absentTables.filter((t) => t === 'missions')).toEqual(['missions']);
      expect(diag.queryErrors).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('a query that ERRORS on an EXISTING table is recorded as UNKNOWN, never as a count', async () => {
    const { projectRoot, dbPath } = seedStore('safecount-unqueryable-', HEALTHY);
    makeConstraintsUnqueryable(dbPath, 3);

    // FIRST: prove we are in the failed-query branch, not the absent-table branch. These are
    // precisely the two cases the criterion says must be distinguishable.
    expect(sqliteMasterEntry(dbPath, 'constraints')).toEqual({
      name: 'constraints',
      type: 'table',
    });

    const client = await openReadonly(dbPath);
    try {
      const diag = newReadDiagnostics();
      const returned = safeCount(client, 'constraints', '', diag);

      // The table is PRESENT, so nothing may claim it is absent.
      expect(diag.absentTables).not.toContain('constraints');
      // The error is captured with the failing query and the DB's own words.
      expect(diag.queryErrors).toHaveLength(1);
      expect(diag.queryErrors[0].query).toBe('constraints');
      expect(diag.queryErrors[0].reason).toMatch(/fts5|corrupt|Query failed/i);

      // The returned number is a placeholder. `reliable` is the flag that says so — and it is
      // the flag every publishing path is required to read.
      expect(returned).toBe(0);
      const per = readStoreCounts(projectRoot, client);
      expect(per.reliable).toBe(false);
      expect(per.queryErrors.map((e) => e.query)).toContain('constraints');
      expect(per.absentTables).not.toContain('constraints');
    } finally {
      client.close();
    }
  });

  it('RED PHASE: the pre-fix helper returns a silent 0 on this exact store', async () => {
    // The fixture must exercise the DEFECT, not merely satisfy the fix. This is the pre-s86-m02b
    // body of safeCount, quoted from the mission doc's own citation of scripts/
    // measure-cross-store-baseline.ts:270-277 — two branches, one of which swallows the error:
    //
    //     if (!tableExists(client, table)) return 0;
    //     const row = client.getOne(`SELECT COUNT(*) AS c FROM ${label}`, []);
    //     return row.success && row.data ? row.data.c : 0;
    //
    // Reconstructed here rather than reverted in place: other agents are running against this
    // tree concurrently, and a temporary mutation of scripts/ would break their runs.
    const preFixSafeCount = (client: CmosDatabaseClient, table: string): number => {
      const exists = client.getOne<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [table]
      );
      if (!exists.success || !exists.data) return 0;
      const row = client.getOne<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`, []);
      return row.success && row.data ? row.data.c : 0;
    };

    const { dbPath } = seedStore('safecount-redphase-', HEALTHY);
    makeConstraintsUnqueryable(dbPath, 3);
    const client = await openReadonly(dbPath);
    try {
      // OLD: indistinguishable from a genuine zero, and nothing anywhere records that it failed.
      expect(preFixSafeCount(client, 'constraints')).toBe(0);
      // NEW: same store, same query — the failure is captured.
      const diag = newReadDiagnostics();
      safeCount(client, 'constraints', '', diag);
      expect(diag.queryErrors).toHaveLength(1);

      // And on a table that is genuinely absent the two helpers agree on 0 — which is why the
      // old one looked correct for so long.
      const absent = seedStore('safecount-redphase-absent-', HEALTHY);
      removeConstraintsTable(absent.dbPath);
      const absentClient = await openReadonly(absent.dbPath);
      try {
        expect(preFixSafeCount(absentClient, 'constraints')).toBe(0);
        const absentDiag = newReadDiagnostics();
        expect(safeCount(absentClient, 'constraints', '', absentDiag)).toBe(0);
        expect(absentDiag.queryErrors).toEqual([]);
        expect(absentDiag.absentTables).toEqual(['constraints']);
      } finally {
        absentClient.close();
      }
    } finally {
      client.close();
    }
  });

  it('breaks ONE table only — every other count on the same store is still correct', async () => {
    // Without this, a test that passes because the whole store is broken would look identical
    // to a test that proves per-table attribution.
    const { projectRoot, dbPath } = seedStore('safecount-surgical-', HEALTHY);
    makeConstraintsUnqueryable(dbPath, 3);

    const client = await openReadonly(dbPath);
    try {
      const per = readStoreCounts(projectRoot, client);
      expect(per.decisions).toBe(2);
      expect(per.learnings).toBe(1);
      expect(per.missions).toBe(2);
      expect(per.missionsStarted).toBe(2);
      expect(per.missionsCompleted).toBe(1);
      expect(per.sprints).toBe(2);
      expect(per.sprintsCompleted).toBe(1);
      expect(per.decisionsSuperseded).toBe(1);
      // Exactly one query failed, and it is the one we broke.
      expect(per.queryErrors.map((e) => e.query)).toEqual(['constraints']);
    } finally {
      client.close();
    }
  });
});

describe('the run: an unreliable store is excluded and NAMED in the block written to the roadmap', () => {
  it('holds the unreliable store OUT of the aggregate instead of contributing a false 0', async () => {
    const healthy = seedStore('safecount-run-healthy-', HEALTHY);
    const broken = seedStore('safecount-run-broken-', OTHER);
    makeConstraintsUnqueryable(broken.dbPath, 3);

    const report = await buildReport(
      [
        { projectRoot: healthy.projectRoot, dbPath: healthy.dbPath },
        { projectRoot: broken.projectRoot, dbPath: broken.dbPath },
      ],
      [],
      2,
      materializeDefaultQueries(NOW),
      { now: NOW, configSource: 'test', runsPerQuery: 1 }
    );

    expect(report.stores.queried).toBe(2);
    expect(report.stores.unreliable.map((u) => u.projectRoot)).toEqual([broken.projectRoot]);
    expect(report.stores.unreliable[0].queryErrors.map((e) => e.query)).toContain('constraints');
    // An UNQUERYABLE table is not an ABSENT table. Nothing may report it as a genuine zero.
    expect(report.stores.absentTables).toEqual([]);

    expect(report.mutableWriteShare.coverage.complete).toBe(false);
    expect(report.mutableWriteShare.coverage.storesCounted).toBe(1);
    expect(report.mutableWriteShare.coverage.storesExcluded).toBe(1);

    // THE NUMBER. The aggregate is the healthy store ALONE. The broken store's own append
    // count is large and non-zero, so folding it in — placeholder zeros and all — would move
    // this figure; that is the corruption the criterion forbids.
    const brokenPer = report.mutableWriteShare.perProject.find(
      (p) => p.projectRoot === broken.projectRoot
    )!;
    expect(brokenPer.reliable).toBe(false);
    expect(brokenPer.appendWrites).toBeGreaterThan(0);
    expect(report.mutableWriteShare.overall.appendWrites).toBe(HEALTHY_APPEND);
    expect(report.mutableWriteShare.overall.transitionWrites).toBe(HEALTHY_TRANSITION);
  });

  it('names the store and the failing query INSIDE the marker block — the text, not the object', async () => {
    const healthy = seedStore('safecount-md-healthy-', HEALTHY);
    const broken = seedStore('safecount-md-broken-', OTHER);
    makeConstraintsUnqueryable(broken.dbPath, 3);

    const report = await buildReport(
      [
        { projectRoot: healthy.projectRoot, dbPath: healthy.dbPath },
        { projectRoot: broken.projectRoot, dbPath: broken.dbPath },
      ],
      [],
      2,
      materializeDefaultQueries(NOW),
      { now: NOW, configSource: 'test', runsPerQuery: 1 }
    );

    const block = renderMarkdownSummary(report);

    // This string IS what `main()` splices into cmos/planning/phase-2-master-plan.md between the
    // markers. Asserting the markers bracket it is what makes "in the block written between the
    // file markers" a claim about the file and not just about a helper's return value.
    expect(block.startsWith(MARK_START)).toBe(true);
    expect(block.trimEnd().endsWith(MARK_END)).toBe(true);

    // The store is named, by name, in the published text.
    expect(block).toContain(path.basename(broken.projectRoot));
    expect(block).toContain('COUNTS INCOMPLETE');
    expect(block).toContain('1 of 2 queried store(s) EXCLUDED');
    expect(block).toContain('constraints');
    expect(block).toMatch(/UNKNOWN \(never 0\)/);

    // The headline share carries the caveat ON the number, not only in a footnote — a reader
    // who quotes the percentage without reading the block cannot miss it.
    expect(block).toMatch(/write share \(upper bound\):\*\* [\d.]+%.*PARTIAL CORPUS/);
    expect(block).toContain('PROVISIONAL');

    // And the healthy store is NOT slandered — only the broken one is called out.
    const excludedLine = block.split('\n').find((l) => l.includes('COUNTS INCOMPLETE'))!;
    expect(excludedLine).not.toContain(path.basename(healthy.projectRoot));
  });

  it('renders an ABSENT table as a disclosed genuine zero — a DIFFERENT line from UNRELIABLE', async () => {
    // The discriminating assertion of the whole criterion: the two zeros must not render alike.
    const healthy = seedStore('safecount-md-ok-', HEALTHY);
    const partial = seedStore('safecount-md-absent-', OTHER);
    removeConstraintsTable(partial.dbPath);

    const report = await buildReport(
      [
        { projectRoot: healthy.projectRoot, dbPath: healthy.dbPath },
        { projectRoot: partial.projectRoot, dbPath: partial.dbPath },
      ],
      [],
      2,
      materializeDefaultQueries(NOW),
      { now: NOW, configSource: 'test', runsPerQuery: 1 }
    );

    expect(report.stores.absentTables).toEqual([
      { projectRoot: partial.projectRoot, tables: ['constraints'] },
    ]);
    expect(report.stores.unreliable).toEqual([]);
    // A genuine zero is still COUNTED — the corpus is complete, so the share stands as fact.
    expect(report.mutableWriteShare.coverage.complete).toBe(true);
    expect(report.mutableWriteShare.coverage.storesCounted).toBe(2);
    // OTHER minus its 3 constraints rows: 5 + 4 + 3 + 1 = 13.
    expect(report.mutableWriteShare.overall.appendWrites).toBe(HEALTHY_APPEND + 13);

    const block = renderMarkdownSummary(report);
    expect(block).toContain('Absent tables (a genuine zero, recorded not swallowed)');
    expect(block).toContain(path.basename(partial.projectRoot));
    // …and NOT the unreliable vocabulary. Same 0, different story, different words.
    expect(block).not.toContain('COUNTS INCOMPLETE');
    expect(block).not.toContain('PARTIAL CORPUS');
    expect(block).not.toContain('PROVISIONAL');
  });

  it('publishes PER-STORE rows, and prints no share at all for an unreliable store', async () => {
    // s86-m09 §4(2): "PRINT AND RECORD PER-STORE RESULTS, never a bare total", and the close's
    // DO-NOT list forbids publishing a bare fleet aggregate anywhere. A reader of the aggregate
    // alone cannot tell whether one store dominates the share or whether a store contributed
    // nothing because it could not be counted — different facts, and this block ships as fact.
    const healthy = seedStore('safecount-perstore-healthy-', HEALTHY);
    const broken = seedStore('safecount-perstore-broken-', OTHER);
    makeConstraintsUnqueryable(broken.dbPath, 3);

    const report = await buildReport(
      [
        { projectRoot: healthy.projectRoot, dbPath: healthy.dbPath },
        { projectRoot: broken.projectRoot, dbPath: broken.dbPath },
      ],
      [],
      2,
      materializeDefaultQueries(NOW),
      { now: NOW, configSource: 'test', runsPerQuery: 1 }
    );

    const block = renderMarkdownSummary(report);
    const rowFor = (root: string): string =>
      block.split('\n').find((l) => l.startsWith(`| ${path.basename(root)} |`))!;

    // Both stores appear BY NAME as their own row — including the one held out of the aggregate.
    // An excluded store that vanishes from the table is a hole the reader cannot see.
    expect(rowFor(healthy.projectRoot)).toBeDefined();
    expect(rowFor(broken.projectRoot)).toBeDefined();

    // The healthy store's row carries its real counts and a computable share.
    const healthyRow = rowFor(healthy.projectRoot);
    expect(healthyRow).toContain(`| ${HEALTHY_APPEND} | ${HEALTHY_TRANSITION} |`);
    expect(healthyRow).toMatch(/\| \d+(\.\d+)?% \|/);

    // THE DISCRIMINATING ASSERTION: the unreliable store's counts are UNKNOWN, so its row
    // carries no numbers to be misread as counts and no percentage at all. A share printed
    // here would be precisely the "confident assertion of something that is not so" this
    // whole sprint exists to close — inside the instrument that measures it.
    const brokenRow = rowFor(broken.projectRoot);
    expect(brokenRow).toContain('UNRELIABLE, EXCLUDED');
    expect(brokenRow).toContain('constraints');
    expect(brokenRow).not.toMatch(/\d+(\.\d+)?%/);
    expect(brokenRow).toContain('| ? | ? |');

    // And the table states which population the aggregate above it actually sums.
    expect(block).toContain(
      'the aggregate above is the sum of the reliable rows only — 1 of 2 queried'
    );
  });

  it('per-store append/transition rows SUM to the published aggregate', async () => {
    // Without this, the per-store table could be decorative — rendered from a different pass,
    // or stale — while the headline share came from somewhere else. The rows must BE the
    // aggregate's terms, so a reader can add them up and land on the published number.
    const a = seedStore('safecount-sum-a-', HEALTHY);
    const b = seedStore('safecount-sum-b-', OTHER);

    const report = await buildReport(
      [
        { projectRoot: a.projectRoot, dbPath: a.dbPath },
        { projectRoot: b.projectRoot, dbPath: b.dbPath },
      ],
      [],
      2,
      materializeDefaultQueries(NOW),
      { now: NOW, configSource: 'test', runsPerQuery: 1 }
    );

    const block = renderMarkdownSummary(report);
    const dataRows = block
      .split('\n')
      .filter((l) => l.startsWith('| safecount-sum-'))
      .map((l) => l.split('|').map((c) => c.trim()));
    expect(dataRows).toHaveLength(2);

    const appendSum = dataRows.reduce((n, cells) => n + Number(cells[2]), 0);
    const transitionSum = dataRows.reduce((n, cells) => n + Number(cells[3]), 0);
    expect(appendSum).toBe(report.mutableWriteShare.overall.appendWrites);
    expect(transitionSum).toBe(report.mutableWriteShare.overall.transitionWrites);
  });

  it('NEGATIVE CONTROL: an all-healthy run publishes neither disclosure line', async () => {
    // Without this, every assertion above could be satisfied by boilerplate that always prints
    // the warnings — which would make the instrument exactly as uninformative as silence.
    const a = seedStore('safecount-clean-a-', HEALTHY);
    const b = seedStore('safecount-clean-b-', OTHER);

    const report = await buildReport(
      [
        { projectRoot: a.projectRoot, dbPath: a.dbPath },
        { projectRoot: b.projectRoot, dbPath: b.dbPath },
      ],
      [],
      2,
      materializeDefaultQueries(NOW),
      { now: NOW, configSource: 'test', runsPerQuery: 1 }
    );

    expect(report.stores.unreliable).toEqual([]);
    expect(report.stores.absentTables).toEqual([]);
    expect(report.mutableWriteShare.coverage.complete).toBe(true);
    // OTHER in full: 5 + 4 + 3 + 1 + 3 = 16.
    expect(report.mutableWriteShare.overall.appendWrites).toBe(HEALTHY_APPEND + 16);

    const block = renderMarkdownSummary(report);
    expect(block).not.toContain('COUNTS INCOMPLETE');
    expect(block).not.toContain('Absent tables');
    expect(block).not.toContain('PARTIAL CORPUS');
    expect(block).not.toContain('PROVISIONAL');
    expect(block.startsWith(MARK_START)).toBe(true);
  });
});

describe('the run OUTPUT half of the criterion', () => {
  /**
   * The criterion also requires the disclosure in the RUN OUTPUT. That output is written by
   * `main()`, which is not exported and is guarded by `require.main === module`; its report and
   * roadmap paths are `path.resolve(__dirname, '..')`-anchored to THIS repository, so executing
   * it would enumerate the operator's live project-graph registry and rewrite
   * cmos/planning/phase-2-master-plan.md. That is forbidden here, and no seam exists to redirect
   * it. So this is a WIRING guard over the source, not a behavioural proof — it fails if the
   * disclosure loops are deleted or decoupled from the report fields the tests above verify, and
   * it is reported as the weaker assertion it is.
   */
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

  it('main() writes the UNRELIABLE stores to stderr and the absent tables to stdout', () => {
    expect(source).toMatch(
      /for \(const s of report\.stores\.unreliable\)[\s\S]{0,200}?process\.stderr\.write\(/
    );
    expect(source).toMatch(/UNRELIABLE, EXCLUDED from the aggregate/);
    expect(source).toMatch(
      /for \(const s of report\.stores\.absentTables\)[\s\S]{0,200}?process\.stdout\.write\(/
    );
    // The one-line summary must carry the partial-corpus caveat too, so a reader who sees only
    // the last line of the run still learns the share does not cover every store.
    expect(source).toMatch(/coverage\.complete[\s\S]{0,200}?PARTIAL — counts from/);
  });

  it('the marker constants this test asserts against are the ones the script splices with', () => {
    expect(source).toContain(`const MARK_START = '${MARK_START}'`);
    expect(source).toContain(`const MARK_END = '${MARK_END}'`);
    expect(source).toContain("'cmos/planning/phase-2-master-plan.md'");
  });
});
