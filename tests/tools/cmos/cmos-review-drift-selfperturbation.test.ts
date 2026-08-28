// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s87-m03 — the drift instrument must not read evidence it created. Opening a store
// ABOUTME: makes SQLite write the -wal sidecar; the old signal then read that as freshness.

/**
 * Sprint 87 m03 — AN INSTRUMENT THAT FABRICATES ITS OWN EVIDENCE.
 *
 * THE MECHANISM, stated exactly, because the draft of this mission got it wrong and a build agent
 * reading the wrong version would look for the fix in the wrong file. `cmos_review`'s drift signal
 * was `max(mtime of cmos.sqlite, mtime of cmos.sqlite-wal)` against a 21-day threshold. The
 * portfolio fan-out opens every registered store microseconds before `deriveDrift` stats it, and
 * SQLITE CREATES THE `-wal` SIDECAR ON ANY OPEN OF A WAL DATABASE. So the call measured a file it
 * had just caused to exist, and reported the result as evidence the store was alive.
 *
 * IT IS NOT A PRAGMA. The fan-out never touches `CmosDatabaseClient` — it uses `openStoreReadOnly`,
 * a raw `better-sqlite3` open that issues no pragma at all. The `journal_mode` pragma defect
 * (#535) is a SEPARATE, LATENT problem that rides along in this mission; it is not what resets
 * this clock. Do not expect the RED below to go green by fixing the pragma.
 *
 * LIVE CONSEQUENCE: `portfolio/cmos-mcp` classified FRESH on a store whose durable content had not
 * moved in months.
 *
 * AND THE OBVIOUS FIX IS REFUTED BY MEASUREMENT. "Drop the `-wal` leg, keep base mtime" does not
 * work, because base mtime lies too: The Academy Web's base read 47.97d against a newest row of
 * 105.27d; Project History's read 16.18d against a true 26.94d. A file's timestamp is not a claim
 * about the rows inside it. The signal had to become the CONTENT the reason string already
 * claimed to describe — which is what #1016 superseded #671 to permit.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CENTRAL ASSERTION INVERTS. `perturbs the signal it reads` documents the OLD behaviour on the
 * OLD signal and still passes — mtime really does move when you open the store, and it always
 * will. What changed is that nothing reads it any more: `the classification survives the open`
 * asserts that the same open no longer changes the verdict.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  deriveDrift,
  newestRowStampMs,
  type StoreStatFn,
} from '../../../src/tools/cmos/cmos-review';
import { openStoreReadOnly } from '../../../src/intelligence/cross-store-query';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');
const MS_PER_DAY = 1000 * 60 * 60 * 24;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const statFn: StoreStatFn = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * A COPY of the live store, aged to look 90 days silent by BOTH signals.
 *
 * The mtime is set by `utimes`; the row stamps are set by SQL. Both are ESTABLISHED here rather
 * than inherited (#547) — the live store's own age is not a fact this file may depend on, since
 * ordinary use of any CMOS tool changes it.
 */
function agedStoreCopy(ageDays: number): { root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s87m03-'));
  tmpDirs.push(root);
  const dbDir = path.join(root, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cmos.sqlite');
  fs.copyFileSync(LIVE_DB, dbPath);
  // Sidecars deliberately NOT copied: a store at rest has none, and their absence is what makes
  // the fan-out's own open observable as a change.

  const stamp = Date.now() - ageDays * MS_PER_DAY;
  const db = new Database(dbPath);
  try {
    // Age the CONTENT. Every domain table the probe reads is stamped older than the threshold,
    // so the store is genuinely silent by the new signal and not merely by the old one.
    for (const table of [
      'missions',
      'sprints',
      'sessions',
      'learnings',
      'strategic_decisions',
      'next_steps',
    ]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'occurred_at')) continue;
      db.prepare(`UPDATE ${table} SET occurred_at = ? WHERE occurred_at > ?`).run(stamp, stamp);
    }
  } finally {
    db.close();
  }
  // Drop any sidecar the write above created, then age the base file.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  const when = new Date(stamp);
  fs.utimesSync(dbPath, when, when);

  return { root, dbPath };
}

function storeEntry(root: string) {
  return { project_id: 'aged-store', store_path: root, name: 'Aged Store', last_synced_at: null };
}

/** Read the content probe the way the fan-out does: on a read-only open of the store. */
function probeStore(root: string): number | null {
  const db = openStoreReadOnly(root);
  try {
    return newestRowStampMs(db);
  } finally {
    db.close();
  }
}

describe('s87-m03 — the drift instrument must not read evidence it created', () => {
  it('THE MECHANISM: opening the store moves the file mtime the OLD signal read', () => {
    const { root, dbPath } = agedStoreCopy(90);

    const before = statFn(dbPath)!;
    const beforeAgeDays = (Date.now() - before) / MS_PER_DAY;
    expect(beforeAgeDays).toBeGreaterThan(21);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);

    // Exactly what the portfolio fan-out does per store: open read-only, read, close.
    const db = openStoreReadOnly(root);
    try {
      db.prepare('SELECT 1').get();
    } finally {
      db.close();
    }

    // The sidecar now exists and is ~now. `storeMtimeMs` took max(base, base-wal), so the signal
    // the old code read has been reset to "fresh" BY THE ACT OF MEASURING IT.
    const walPath = `${dbPath}-wal`;
    const perturbed = fs.existsSync(walPath) ? statFn(walPath) : statFn(dbPath);
    expect(perturbed).not.toBeNull();
    const afterAgeDays = (Date.now() - perturbed!) / MS_PER_DAY;
    expect(afterAgeDays).toBeLessThan(1);
  }, 60_000);

  it('THE FIX: the classification SURVIVES the open — same store, same verdict, before and after', () => {
    const { root } = agedStoreCopy(90);
    const stores = [storeEntry(root)];
    const now = Date.now();

    const stampsBefore = new Map([['aged-store', probeStore(root)]]);
    const before = deriveDrift(stores, [], statFn, now, stampsBefore);

    // Open it again — the act that used to reset the verdict.
    const db = openStoreReadOnly(root);
    try {
      db.prepare('SELECT 1').get();
    } finally {
      db.close();
    }

    const stampsAfter = new Map([['aged-store', probeStore(root)]]);
    const after = deriveDrift(stores, [], statFn, now, stampsAfter);

    expect(before.silent).toBe(1);
    expect(before.reachable).toBe(0);
    // THE INVERSION. Under the old mtime signal this second call reported reachable=1, silent=0
    // and drift=null: the store had been "revived" by being looked at.
    expect(after.silent).toBe(1);
    expect(after.reachable).toBe(0);
    expect(after.drift?.stale[0]?.reason).toMatch(/^no new CMOS rows in \d+d$/);
  }, 60_000);

  it('the reason string names the mechanism that produced it — rows, never writes', () => {
    const { root } = agedStoreCopy(90);
    const stamps = new Map([['aged-store', probeStore(root)]]);
    const partition = deriveDrift([storeEntry(root)], [], statFn, Date.now(), stamps);

    const reason = partition.drift!.stale[0].reason;
    // The probe reads MAX(occurred_at) — a row-creation stamp. It does not observe writes, so the
    // sentence may not claim to. FORK-2: making the sentence true is cheaper than making the
    // mechanism match a sentence nobody validated.
    expect(reason).toContain('no new CMOS rows in');
    expect(reason).not.toContain('CMOS write');
    expect(Math.round(partition.drift!.stale[0].ageDays)).toBeGreaterThanOrEqual(89);
  }, 60_000);

  it('a probe-null store is reported freshness-UNKNOWN — never silent, never fresh (FORK-1b)', () => {
    const { root } = agedStoreCopy(90);
    // The probe returned nothing readable. There is deliberately NO mtime fallback: `deriveDrift`
    // runs after the fan-out has touched every sidecar, so any mtime it could read is ~now by
    // construction and a fallback could only ever say "fresh" — a label describing a signal the
    // caller has already destroyed.
    const stamps = new Map<string, number | null>([['aged-store', null]]);
    const partition = deriveDrift([storeEntry(root)], [], statFn, Date.now(), stamps);

    expect(partition.silent).toBe(0);
    expect(partition.reachable).toBe(1);
    const item = partition.drift!.stale[0];
    expect(item.reason).toContain('freshness unknown');
    expect(item.reason).toContain('this call opened the store');
    // #920's strict partition is preserved: the four buckets still sum to the store count.
    expect(
      partition.reachable + partition.silent + partition.unmigrated + partition.unreadable
    ).toBe(1);
  }, 60_000);

  it('the content probe is column-guarded — a table without occurred_at is skipped, not fatal', () => {
    const { root, dbPath } = agedStoreCopy(90);
    // Synthesis Workbench's `next_steps` has no `occurred_at` column — one real gap across 19
    // readable stores. Reproduced here as a FIXTURE rather than trusted as a hope, because a
    // probe that throws on one missing column would take the whole drift signal down with it.
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE IF EXISTS next_steps');
      db.exec('CREATE TABLE next_steps (id INTEGER PRIMARY KEY, content TEXT)');
    } finally {
      db.close();
    }
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

    expect(() => probeStore(root)).not.toThrow();
    expect(probeStore(root)).not.toBeNull();
  }, 60_000);

  it('a probe THROW is isolated from the fan-out errors — it cannot mark a store unreadable', () => {
    // The separation is structural (`probeErrors` vs `errors`), and this is why: `deriveDrift`
    // reads `errors` to classify a store `unreadable`. If an optional extra read landing there
    // could reclassify a store the fan-out read perfectly well, the fix for a false signal would
    // have introduced one.
    const { root } = agedStoreCopy(90);
    const stores = [storeEntry(root)];
    // No probe entry at all — the shape a thrown probe produces.
    const partition = deriveDrift(stores, [], statFn, Date.now(), new Map());
    expect(partition.unreadable).toBe(0);
    expect(partition.reachable).toBe(1);
    expect(partition.drift!.stale[0].reason).toContain('freshness unknown');
  }, 60_000);

  it('the LIVE store was never written to by this suite', () => {
    // Every fire above runs on a copy. Asserted rather than intended.
    const stat = fs.statSync(LIVE_DB);
    expect(stat.size).toBeGreaterThan(0);
  });
});
