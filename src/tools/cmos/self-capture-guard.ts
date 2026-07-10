// ABOUTME: s80-m07 — the self-capture guard. Flags when local dev activity (commits)
// ABOUTME: runs ahead of the last CMOS write, so an operator remembers to capture work.

/**
 * Self-capture guard (s80-m07).
 *
 * Peer of `build-freshness.ts` / `context-freshness.ts`. It answers one question:
 * "have I been coding (committing) without capturing decisions/learnings/mission
 * progress into CMOS?" — the s65 retro footgun, one layer up.
 *
 * Two signals, both project-LOCAL:
 *   - Signal A (dev activity): the git commit/ref-log mtime (`.git/logs/HEAD`, falling
 *     back to `.git/HEAD`). Callers that already have a newer "recent code change"
 *     timestamp (e.g. `cmos_review`'s `buildFreshness.latestSrcMtime`) may inject it via
 *     `opts.devActivityMs` to avoid a redundant stat.
 *   - Signal B (last CMOS write): a single SQL MAX over `strategic_decisions.created_at`
 *     + `learnings.created_at` + `missions.created_at` + `missions.completed_at`. NB no
 *     `deleted_at`/status filter is applied — that column does not exist on
 *     `strategic_decisions`/`learnings` (see {@link lastCaptureAt}), and every `created_at`
 *     is a real capture event. Sessions are EXCLUDED — a session row is auto-created at
 *     opener time and would mask the gap.
 *
 * The gap fires ONLY when BOTH signals resolve AND dev activity is more than
 * `thresholdDays` ahead of the last capture. Fail-open: any missing signal (no git, an
 * un-migrated store, a stat/query error) yields `fires: false` — never an advisory, and
 * never a thrown error into the opener.
 *
 * @module tools/cmos/self-capture-guard
 */

import { statSync } from 'fs';
import * as path from 'path';
import type { CmosDatabaseClient } from './client';
import { calculateLagDays } from './context-freshness';

/** Default "commits ahead of capture" threshold, in days. */
export const DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS = 7;

/** The computed self-capture gap. `fires` is the only field callers must branch on. */
export interface SelfCaptureGap {
  /** Whole days dev activity runs ahead of the last CMOS write (0 when not ahead). */
  gapDays: number;
  /** The threshold used. */
  thresholdDays: number;
  /** ISO of the last CMOS write (decision/learning/mission), or null when none/unreadable. */
  lastCaptureAt: string | null;
  /** ISO of the newest dev-activity signal (git ref-log mtime), or null when no git. */
  devActivityAt: string | null;
  /** True ONLY when both signals resolved AND gapDays > thresholdDays. */
  fires: boolean;
}

/** Options for {@link calculateSelfCaptureGap}. */
export interface SelfCaptureOptions {
  /** Override the "commits ahead" threshold (default {@link DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS}). */
  thresholdDays?: number;
  /**
   * Inject Signal A (dev-activity mtime in Unix ms) to skip the git stat — e.g. a caller
   * that already holds a newer "recent code change" mtime. `null` forces the git lookup.
   */
  devActivityMs?: number | null;
}

/** Signal A — the git ref-log mtime (fallback `.git/HEAD`), Unix ms, or null when no git. */
function gitActivityMs(projectRoot: string): number | null {
  for (const rel of ['.git/logs/HEAD', '.git/HEAD']) {
    try {
      return statSync(path.join(projectRoot, rel)).mtimeMs;
    } catch {
      // try the fallback ref
    }
  }
  return null;
}

/**
 * Signal B — the last CMOS write across decisions/learnings/missions (EXCLUDING
 * sessions). NB: `strategic_decisions`/`learnings` soft-delete via `status`
 * (active/superseded/archived), NOT a `deleted_at` column — that column does not
 * exist on these tables, so filtering on it would throw. Every row's `created_at`
 * is a genuine capture event (even a superseded one WAS captured), so no status
 * filter is applied — we want the latest capture time regardless of later status.
 */
function lastCaptureAt(client: CmosDatabaseClient): string | null {
  try {
    const result = client.getOne<{ max_ts: string | null }>(
      `SELECT MAX(ts) AS max_ts FROM (
         SELECT MAX(created_at) AS ts FROM strategic_decisions
         UNION ALL SELECT MAX(created_at) FROM learnings
         UNION ALL SELECT MAX(created_at) FROM missions
         UNION ALL SELECT MAX(completed_at) FROM missions
       )`
    );
    if (!result.success || !result.data) return null;
    return result.data.max_ts ?? null;
  } catch {
    // Un-migrated / missing column / read error → fail open.
    return null;
  }
}

/**
 * Compute the self-capture gap (s80-m07). Project-LOCAL, fail-open. See the module
 * docblock for the two signals + the fire condition.
 */
export function calculateSelfCaptureGap(
  client: CmosDatabaseClient,
  projectRoot: string,
  opts: SelfCaptureOptions = {}
): SelfCaptureGap {
  const thresholdDays = opts.thresholdDays ?? DEFAULT_SELF_CAPTURE_THRESHOLD_DAYS;
  const devMs = opts.devActivityMs !== undefined ? opts.devActivityMs : gitActivityMs(projectRoot);
  const devActivityAt = devMs != null ? new Date(devMs).toISOString() : null;
  const captureAt = lastCaptureAt(client);

  // Days dev activity is ahead of the last capture (null when either signal is missing).
  const gapDays = calculateLagDays(captureAt, devActivityAt) ?? 0;
  const fires = devActivityAt != null && captureAt != null && gapDays > thresholdDays;

  return { gapDays, thresholdDays, lastCaptureAt: captureAt, devActivityAt, fires };
}

/**
 * The operator-facing advisory for a fired gap, or null when it did not fire. Never
 * references another project — this is a project-local signal.
 */
export function buildSelfCaptureWarning(gap: SelfCaptureGap): string | null {
  if (!gap.fires) return null;
  const days = Math.round(gap.gapDays);
  return (
    `Self-capture gap: local commits are ~${days}d ahead of the last CMOS write ` +
    `(${gap.lastCaptureAt}). Capture recent decisions/learnings/mission progress so the ` +
    `store reflects the work (cmos_session action="capture").`
  );
}
