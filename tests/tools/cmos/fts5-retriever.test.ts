/**
 * Retrieval scoring-helper tests.
 *
 * s80-m03 removed the dead sync `FTS5Retriever` class + its dedicated tests; the
 * shared scoring helpers `computeRecencyFactor` / `computeAgeDays` (used by the live
 * `HybridRetriever`) stay covered here. HybridRetriever has its own suites elsewhere.
 *
 * @module tests/tools/cmos/fts5-retriever
 */

import { computeRecencyFactor, computeAgeDays } from '../../../src/tools/cmos/fts5-retriever';

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── computeRecencyFactor ─────────────────────────────────────────────────────

describe('computeRecencyFactor', () => {
  it('returns 1.0 for age 0 days (just created)', () => {
    expect(computeRecencyFactor(0)).toBeCloseTo(1.0, 5);
  });

  it('returns ~0.368 at 60 days (half-life)', () => {
    expect(computeRecencyFactor(60)).toBeCloseTo(Math.exp(-1), 3);
  });

  it('returns ~0.135 at 120 days (2× half-life)', () => {
    expect(computeRecencyFactor(120)).toBeCloseTo(Math.exp(-2), 3);
  });

  it('returns smaller value for older items', () => {
    expect(computeRecencyFactor(30)).toBeGreaterThan(computeRecencyFactor(90));
  });
});

// ─── computeAgeDays ──────────────────────────────────────────────────────────

describe('computeAgeDays', () => {
  it('returns 0 for null', () => {
    expect(computeAgeDays(null)).toBe(0);
  });

  it('returns 0 for invalid date string', () => {
    expect(computeAgeDays('not-a-date')).toBe(0);
  });

  it('returns approximately correct age for known past date', () => {
    const tenDaysAgo = daysAgoISO(10);
    const age = computeAgeDays(tenDaysAgo);
    expect(age).toBeGreaterThan(9.9);
    expect(age).toBeLessThan(10.1);
  });

  it('returns 0 for a current timestamp', () => {
    const now = new Date().toISOString();
    expect(computeAgeDays(now)).toBeLessThan(0.01);
  });
});
