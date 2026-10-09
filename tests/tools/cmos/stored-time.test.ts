// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — stored times compare and sort in JavaScript as julianday() does in SQL, and a
// ABOUTME: since/until of a year or a month covers its period instead of matching nothing.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { cmosDecisions } from '../../../src/tools/cmos/cmos-decisions';
import { compareStoredTimes, storedTimeMs, timeBound } from '../../../src/tools/cmos/stored-time';
import { reidentifyCmosTestStore, seedCmosDb } from '../../helpers/seedCmosDb';

describe('storedTimeMs reads every stored spelling as UTC, as julianday() does', () => {
  it.each([
    ['2026-06-30 03:10:21', Date.UTC(2026, 5, 30, 3, 10, 21)],
    ['2026-06-30T03:10:21', Date.UTC(2026, 5, 30, 3, 10, 21)],
    ['2026-06-30T03:10:21Z', Date.UTC(2026, 5, 30, 3, 10, 21)],
    ['2026-06-30T03:10:21.500Z', Date.UTC(2026, 5, 30, 3, 10, 21, 500)],
    ['2026-06-30T05:10:21+02:00', Date.UTC(2026, 5, 30, 3, 10, 21)],
    ['2026-06-30', Date.UTC(2026, 5, 30)],
  ])('%s', (spelling, expected) => {
    expect(storedTimeMs(spelling)).toBe(expected);
  });

  it('agrees with julianday() on each spelling', () => {
    const db = new Database(':memory:');
    try {
      for (const spelling of ['2026-06-30 03:10:21', '2026-06-30T02:14:08.987Z', '2026-06-30']) {
        const { ms } = db
          .prepare('SELECT CAST(ROUND((julianday(?) - 2440587.5) * 86400000) AS INTEGER) AS ms')
          .get(spelling) as { ms: number };
        expect(storedTimeMs(spelling)).toBe(ms);
      }
    } finally {
      db.close();
    }
  });

  it('reads nothing it cannot place in time', () => {
    for (const value of ['', '   ', 'yesterday', null, undefined]) {
      expect(Number.isNaN(storedTimeMs(value))).toBe(true);
    }
  });
});

describe('compareStoredTimes orders as ORDER BY julianday() does', () => {
  it('the meridian case: a space-spelled time is later than an earlier ISO one on the same day', () => {
    const later = '2026-06-30 03:10:21'; // #480
    const earlier = '2026-06-30T02:14:08.987Z'; // #475
    expect(later.localeCompare(earlier)).toBeLessThan(0); // text gets it backwards
    expect(compareStoredTimes(later, earlier)).toBeGreaterThan(0);
  });

  it('an unreadable time sorts first ascending and last descending, as NULL does', () => {
    const times = ['2026-01-02', 'garbage', '2026-01-01'];
    expect([...times].sort(compareStoredTimes)).toEqual(['garbage', '2026-01-01', '2026-01-02']);
    expect([...times].sort((a, b) => compareStoredTimes(b, a))).toEqual([
      '2026-01-02',
      '2026-01-01',
      'garbage',
    ]);
  });
});

describe('timeBound widens a year or a month to its period and refuses what it cannot read', () => {
  it.each([
    ['2026-10', 'since', '2026-10-01T00:00:00.000Z'],
    ['2026-10', 'until', '2026-10-31T23:59:59.999Z'],
    ['2026-02', 'until', '2026-02-28T23:59:59.999Z'],
    ['2026', 'since', '2026-01-01T00:00:00.000Z'],
    ['2026', 'until', '2026-12-31T23:59:59.999Z'],
    ['2026-10-08', 'since', '2026-10-08'],
    ['2026-10-08T14:00:00Z', 'until', '2026-10-08T14:00:00Z'],
    ['2026-10-08 14:00:00', 'since', '2026-10-08 14:00:00'],
    // julianday() reads a lowercase z too (the confirming critic).
    ['2026-10-08T12:00:00z', 'until', '2026-10-08T12:00:00z'],
  ] as const)('%s as %s → %s', (value, edge, expected) => {
    expect(timeBound(value, edge)).toBe(expected);
  });

  it.each(['2026-13', 'October', 'last week', '10/08/2026', ''])('refuses %j', (value) => {
    expect(timeBound(value, 'since')).toBeNull();
  });
});

describe('every read that takes since/until reads them as time bounds', () => {
  // The confirming critic: the fold covered three of the five handlers; learnings list and session
  // search still passed a month straight into julianday(?) and matched nothing.
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m11-bounds-'));
    const dbPath = seedCmosDb(projectRoot, { projectName: 'bounds' });
    reidentifyCmosTestStore(projectRoot);
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO learnings (id, content, created_at, status)
         VALUES (1, 'An October storage learning.', '2026-10-08 09:00:00', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO sessions (id, type, title, started_at, completed_at, status, summary)
         VALUES ('PS-2026-10-08-001', 'research', 'Storage', '2026-10-08 09:00:00',
                 '2026-10-08 10:00:00', 'completed', 'Talked about storage.')`
      ).run();
    } finally {
      db.close();
    }
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('learnings list: a month covers the month, and words are refused', async () => {
    const { cmosLearnings } = await import('../../../src/tools/cmos/cmos-learnings');
    const october = await cmosLearnings({ action: 'list', since: '2026-10', projectRoot });
    expect(
      (october.data as { learnings: Array<{ id: number }> }).learnings.map((l) => l.id)
    ).toEqual([1]);
    const september = await cmosLearnings({ action: 'list', until: '2026-09', projectRoot });
    expect((september.data as { learnings: unknown[] }).learnings).toEqual([]);
    const refused = await cmosLearnings({ action: 'list', since: 'last week', projectRoot });
    expect(refused.error?.code).toBe('INVALID_PARAMETER');
  });

  it('session search: a month covers the month, and words are refused', async () => {
    const { cmosSession } = await import('../../../src/tools/cmos/cmos-session');
    const october = await cmosSession({
      action: 'search',
      query: 'storage',
      since: '2026-10',
      projectRoot,
    });
    expect((october.data as { results: Array<{ id: string }> }).results.map((r) => r.id)).toEqual([
      'PS-2026-10-08-001',
    ]);
    const refused = await cmosSession({
      action: 'search',
      query: 'storage',
      until: 'yesterday',
      projectRoot,
    });
    expect(refused.error?.code).toBe('INVALID_PARAMETER');
  });
});

describe('cmos_decisions(list) filters and orders as times', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m11-stored-time-'));
    const dbPath = seedCmosDb(projectRoot, { projectName: 'stored time' });
    reidentifyCmosTestStore(projectRoot);
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, status)
         VALUES (?, ?, ?, 'active')`
      );
      insert.run(475, 'Earlier, ISO spelling.', '2026-06-30T02:14:08.987Z');
      insert.run(480, 'Later, SQLite spelling.', '2026-06-30 03:10:21');
      insert.run(500, 'October.', '2026-10-08T12:00:00.000Z');
    } finally {
      db.close();
    }
    CmosDetector.resetInstance();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const ids = (result: Awaited<ReturnType<typeof cmosDecisions>>): number[] =>
    ((result.data as { decisions: Array<{ id: number }> }).decisions ?? []).map((d) => d.id);

  it('lists newest first by time, whatever the spelling', async () => {
    const listed = await cmosDecisions({ action: 'list', projectRoot });
    expect(listed.success).toBe(true);
    expect(ids(listed)).toEqual([500, 480, 475]);
  });

  it('since and until of a month cover the month', async () => {
    const october = await cmosDecisions({ action: 'list', since: '2026-10', projectRoot });
    expect(ids(october)).toEqual([500]);
    const june = await cmosDecisions({
      action: 'list',
      since: '2026-06',
      until: '2026-06',
      projectRoot,
    });
    expect(ids(june)).toEqual([480, 475]);
  });

  it('refuses a bound it cannot read, naming the forms it takes', async () => {
    const refused = await cmosDecisions({ action: 'list', since: 'last week', projectRoot });
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('INVALID_PARAMETER');
    expect(refused.error?.suggestion).toContain('YYYY-MM');
  });
});
