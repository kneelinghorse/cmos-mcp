// ABOUTME: s80-m07 — unit + integration tests for the self-capture guard.
// ABOUTME: Logic (fire/threshold/null) via a mock client; fail-open via a real seeded store.

/**
 * s80-m07 — calculateSelfCaptureGap fires only when BOTH the dev-activity signal and
 * the last-CMOS-write signal resolve AND commits run > thresholdDays ahead. The core
 * logic is tested with a mock client (deterministic Signal B); the real seeded store
 * proves the SQL runs cleanly against the live schema and fails open when empty.
 *
 * @module tests/tools/cmos/self-capture-guard
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CmosToolResult } from '../../../src/tools/cmos/types';
import type { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { CmosDatabaseClient as RealClient } from '../../../src/tools/cmos/client';
import { seedCmosDb } from '../../helpers/seedCmosDb';
import {
  calculateSelfCaptureGap,
  buildSelfCaptureWarning,
  DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS,
} from '../../../src/tools/cmos/self-capture-guard';

const DAY = 24 * 60 * 60 * 1000;

/** A mock client whose getOne returns a controlled last-capture timestamp (Signal B). */
function mockClient(maxTs: string | null, throws = false): CmosDatabaseClient {
  return {
    getOne: () => {
      if (throws) throw new Error('boom');
      return { success: true, data: { max_ts: maxTs } } as CmosToolResult<{
        max_ts: string | null;
      }>;
    },
  } as unknown as CmosDatabaseClient;
}

describe('self-capture guard (s80-m07)', () => {
  const NOW = Date.now();

  it('fires when dev activity is > threshold days ahead of the last CMOS write', () => {
    const capture = new Date(NOW - 30 * DAY).toISOString();
    const gap = calculateSelfCaptureGap(mockClient(capture), '/root', { devActivityMs: NOW });
    expect(gap.fires).toBe(true);
    expect(gap.gapDays).toBeGreaterThan(DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS);
    expect(gap.lastCaptureAt).toBe(capture);
    expect(gap.devActivityAt).toBe(new Date(NOW).toISOString());
    expect(buildSelfCaptureWarning(gap)).toMatch(/Self-capture gap/);
  });

  it('does NOT fire when the last CMOS write is recent (within threshold)', () => {
    const capture = new Date(NOW - 1 * DAY).toISOString();
    const gap = calculateSelfCaptureGap(mockClient(capture), '/root', { devActivityMs: NOW });
    expect(gap.fires).toBe(false);
    expect(buildSelfCaptureWarning(gap)).toBeNull();
  });

  it('does NOT fire exactly AT the threshold (strict > boundary)', () => {
    const capture = new Date(NOW - DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS * DAY).toISOString();
    const gap = calculateSelfCaptureGap(mockClient(capture), '/root', { devActivityMs: NOW });
    expect(gap.gapDays).toBe(DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS);
    expect(gap.fires).toBe(false);
  });

  it('fails open (no fire) when there is no dev-activity signal (devActivityMs=null)', () => {
    const capture = new Date(NOW - 30 * DAY).toISOString();
    const gap = calculateSelfCaptureGap(mockClient(capture), '/root', { devActivityMs: null });
    expect(gap.devActivityAt).toBeNull();
    expect(gap.fires).toBe(false);
  });

  it('fails open (no fire) when there is no CMOS write yet (Signal B null)', () => {
    const gap = calculateSelfCaptureGap(mockClient(null), '/root', { devActivityMs: NOW });
    expect(gap.lastCaptureAt).toBeNull();
    expect(gap.fires).toBe(false);
  });

  it('fails open (no fire, never throws) when the Signal B query errors', () => {
    const gap = calculateSelfCaptureGap(mockClient(null, true), '/root', { devActivityMs: NOW });
    expect(gap.fires).toBe(false);
  });

  // s80-m07 review regression: the Signal B SQL must run against the REAL schema and
  // return a genuine last-capture timestamp. A prior version filtered on a nonexistent
  // `deleted_at` column, so the query threw, the catch swallowed it, and the guard was
  // dead-on-arrival (fires always false). This drives a real seeded store end-to-end.
  describe('against a real seeded store (drives the actual Signal B SQL)', () => {
    let tmpDir: string;
    let root: string;
    let client: CmosDatabaseClient;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcap-real-'));
      root = path.join(tmpDir, 'proj');
      seedCmosDb(root, { projectId: 'p', projectName: 'P' });
      const created = await RealClient.create({ projectRoot: root });
      if (!created.success || !created.data) throw new Error('client create failed');
      client = created.data;
    });

    afterEach(() => {
      client?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Insert a decision with a controlled created_at, bypassing FK/genesis via raw sqlite. */
    function insertDecision(createdAtIso: string): void {
      const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO strategic_decisions (decision_text, created_at) VALUES (?, ?)').run(
        'd',
        createdAtIso
      );
      db.close();
    }

    it('empty store → Signal B null → no fire (query must not throw)', () => {
      const gap = calculateSelfCaptureGap(client, root, { devActivityMs: NOW });
      expect(gap.lastCaptureAt).toBeNull();
      expect(gap.fires).toBe(false);
    });

    it('FIRES when a real captured decision is >threshold days behind dev activity', () => {
      const capture = new Date(NOW - 30 * DAY).toISOString();
      insertDecision(capture);
      const gap = calculateSelfCaptureGap(client, root, { devActivityMs: NOW });
      // The bug this guards: lastCaptureAt must be the REAL decision time, not null.
      expect(gap.lastCaptureAt).toBe(capture);
      expect(gap.gapDays).toBeGreaterThan(DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS);
      expect(gap.fires).toBe(true);
    });

    it('does NOT fire when the real last capture is recent', () => {
      insertDecision(new Date(NOW - 1 * DAY).toISOString());
      const gap = calculateSelfCaptureGap(client, root, { devActivityMs: NOW });
      expect(gap.lastCaptureAt).not.toBeNull();
      expect(gap.fires).toBe(false);
    });
  });
});
