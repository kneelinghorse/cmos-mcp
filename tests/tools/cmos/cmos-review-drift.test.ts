// ABOUTME: s80-m06 — unit tests for deriveDrift, the strict reachability partition +
// ABOUTME: per-project freshness drift used by the cmos_review portfolio section.

/**
 * s80-m06 — deriveDrift partitions every queried store into
 * reachable | silent | unmigrated | unreadable (summing to stores.length) and builds
 * the drift list. Tested as a pure function with an injected stat fn + fixed `now`, so
 * store-mtime freshness is deterministic (no real fs timing).
 *
 * @module tests/tools/cmos/cmos-review-drift
 */

import * as path from 'path';
import { deriveDrift, type StoreStatFn } from '../../../src/tools/cmos/cmos-review';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000 * DAY; // arbitrary fixed "now" in ms

function dbFile(root: string): string {
  return path.join(root, 'cmos', 'db', 'cmos.sqlite');
}

describe('deriveDrift (s80-m06 strict partition + drift)', () => {
  it('partitions into reachable/silent/unmigrated/unreadable summing to stores.length', () => {
    const stores = [
      { project_id: 'fresh', store_path: '/s/fresh', name: 'Fresh' },
      { project_id: 'silent', store_path: '/s/silent', name: 'Silent Proj' },
      { project_id: 'unmig', store_path: '/s/unmig', name: 'Unmig' },
      { project_id: 'unread', store_path: '/s/unread', name: 'Unread' },
    ];
    const errors = [
      { projectId: 'unmig', error: 'no such column: project_id' },
      { projectId: 'unread', error: 'database disk image is malformed' },
    ];
    const mtimes: Record<string, number> = {
      [dbFile('/s/fresh')]: NOW - 1 * DAY, // fresh
      [dbFile('/s/silent')]: NOW - 40 * DAY, // stale > 21d
    };
    const statFn: StoreStatFn = (p) => (p in mtimes ? mtimes[p] : null);

    const r = deriveDrift(stores, errors, statFn, NOW);
    expect(r.reachable).toBe(1);
    expect(r.silent).toBe(1);
    expect(r.unmigrated).toBe(1);
    expect(r.unreadable).toBe(1);
    expect(r.reachable + r.silent + r.unmigrated + r.unreadable).toBe(stores.length);

    // Drift lists silent + unmigrated (NOT fresh, NOT unreadable), sorted by ageDays desc.
    expect(r.drift).not.toBeNull();
    expect(r.drift!.staleThresholdDays).toBe(21);
    const ids = r.drift!.stale.map((s) => s.projectId);
    expect(ids).toEqual(expect.arrayContaining(['silent', 'unmig']));
    expect(ids).not.toContain('fresh');
    expect(ids).not.toContain('unread');
    expect(r.drift!.stale[0].projectId).toBe('silent'); // 40d sorts before unmig (age 0)
    const unmig = r.drift!.stale.find((s) => s.projectId === 'unmig');
    expect(unmig!.hint).toMatch(/backfill/i);
    const silent = r.drift!.stale.find((s) => s.projectId === 'silent');
    expect(silent!.hint).toBeUndefined();
    expect(silent!.reason).toMatch(/40d/);
  });

  it('returns drift=null when every store succeeded and is fresh', () => {
    const stores = [
      { project_id: 'a', store_path: '/a', name: 'A' },
      { project_id: 'b', store_path: '/b', name: 'B' },
    ];
    const statFn: StoreStatFn = () => NOW - 2 * DAY;
    const r = deriveDrift(stores, [], statFn, NOW);
    expect(r.reachable).toBe(2);
    expect(r.silent).toBe(0);
    expect(r.drift).toBeNull();
  });

  it('uses the newer WAL-sidecar mtime (a write not yet checkpointed keeps a store fresh)', () => {
    const stores = [{ project_id: 'w', store_path: '/w', name: 'W' }];
    const statFn: StoreStatFn = (p) => {
      if (p === dbFile('/w')) return NOW - 40 * DAY; // base looks stale
      if (p === `${dbFile('/w')}-wal`) return NOW - 1 * DAY; // WAL is fresh
      return null;
    };
    const r = deriveDrift(stores, [], statFn, NOW);
    expect(r.reachable).toBe(1);
    expect(r.silent).toBe(0);
    expect(r.drift).toBeNull();
  });

  // ── s81-m03: the "unsynced" (local-ahead-of-dashboard) overlay ──────────────
  it('s81-m03: flags a FRESH store whose mtime is > threshold ahead of last_synced_at as unsynced, without changing the partition', () => {
    const stores = [
      // Fresh store (mtime 1d) but last pushed 10d ago → 9d unsynced (> 3d threshold).
      {
        project_id: 'ahead',
        store_path: '/s/ahead',
        name: 'Ahead',
        last_synced_at: NOW - 10 * DAY,
      },
      // Fresh + recently synced (1d ago) → within threshold → no signal.
      {
        project_id: 'synced',
        store_path: '/s/synced',
        name: 'Synced',
        last_synced_at: NOW - 1 * DAY,
      },
      // Fresh but last_synced_at NULL (never pushed from here) → no-signal.
      { project_id: 'nullsync', store_path: '/s/nullsync', name: 'NullSync', last_synced_at: null },
    ];
    const mtimes: Record<string, number> = {
      [dbFile('/s/ahead')]: NOW - 1 * DAY,
      [dbFile('/s/synced')]: NOW - 1 * DAY,
      [dbFile('/s/nullsync')]: NOW - 1 * DAY,
    };
    const statFn: StoreStatFn = (p) => (p in mtimes ? mtimes[p] : null);

    const r = deriveDrift(stores, [], statFn, NOW);

    // Partition unchanged — all three are fresh → reachable; unsynced is an OVERLAY item.
    expect(r.reachable).toBe(3);
    expect(r.silent).toBe(0);
    expect(r.reachable + r.silent + r.unmigrated + r.unreadable).toBe(stores.length);

    // Exactly the 'ahead' store gets an unsynced drift item.
    const unsynced = r.drift!.stale.filter((s) => /unsynced/.test(s.reason));
    expect(unsynced.map((s) => s.projectId)).toEqual(['ahead']);
    expect(unsynced[0].reason).toMatch(/local ahead of dashboard by 9d \(unsynced; this machine\)/);
    expect(unsynced[0].ageDays).toBe(9);
  });

  it('s81-m03: NULL last_synced_at on every store yields no unsynced signal (drift=null when all fresh)', () => {
    const stores = [
      { project_id: 'a', store_path: '/a', name: 'A', last_synced_at: null },
      { project_id: 'b', store_path: '/b', name: 'B' }, // last_synced_at absent → undefined
    ];
    const statFn: StoreStatFn = () => NOW - 1 * DAY; // both fresh
    const r = deriveDrift(stores, [], statFn, NOW);
    expect(r.reachable).toBe(2);
    expect(r.drift).toBeNull();
  });

  it('caps the drift list to the top-N by ageDays desc', () => {
    const stores = Array.from({ length: 12 }, (_, i) => ({
      project_id: `p${i}`,
      store_path: `/p${i}`,
      name: `P${i}`,
    }));
    const statFn: StoreStatFn = (p) => {
      const m = p.match(/\/p(\d+)\//);
      if (m && p.endsWith('cmos.sqlite')) return NOW - (30 + Number(m[1])) * DAY;
      return null;
    };
    const r = deriveDrift(stores, [], statFn, NOW);
    expect(r.silent).toBe(12);
    expect(r.drift!.stale.length).toBe(8); // DRIFT_TOP_N
    expect(r.drift!.stale[0].projectId).toBe('p11'); // oldest (41d) first
  });
});
