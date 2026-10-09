// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — a stored timestamp read as an instant the way SQLite's julianday() reads it, so a
// ABOUTME: comparison or ordering done in JavaScript agrees with the same one done in SQL (#607, #597).

import { CmosErrors } from './errors';
import type { CmosToolError } from './types';

/**
 * WHY. Stored times are UTC, in three spellings that real stores hold side by side: ISO-8601 with
 * `Z`, the same with milliseconds, and SQLite's CURRENT_TIMESTAMP spelling `YYYY-MM-DD HH:MM:SS`
 * with no zone. Compared as text, a space sorts before `T`, so one instant spelled two ways orders
 * wrongly (a copy of the meridian store listed #480 after #475 that way); and Date.parse reads a
 * zone-less date-time as LOCAL time. SQL compares through julianday(), which reads every zone-less
 * spelling as UTC; these helpers do the same, so a sort or filter in JavaScript matches it.
 */

const ZONELESS_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Milliseconds since the epoch for a stored time, or NaN where julianday() would give NULL. A
 * zone-less date-time is UTC, and a date alone is its midnight UTC.
 */
export function storedTimeMs(value: string | null | undefined): number {
  if (typeof value !== 'string') return NaN;
  const raw = value.trim();
  if (raw === '') return NaN;
  const zoneless = ZONELESS_DATE_TIME.exec(raw);
  return Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : raw);
}

/**
 * Oldest first, as `ORDER BY julianday(x)` orders: a time it cannot read sorts first, as its NULL
 * does. For newest first, swap the arguments; an unreadable time then sorts last, as in DESC.
 */
export function compareStoredTimes(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const x = storedTimeMs(a);
  const y = storedTimeMs(b);
  const xUnread = Number.isNaN(x);
  const yUnread = Number.isNaN(y);
  if (xUnread || yUnread) return xUnread === yUnread ? 0 : xUnread ? -1 : 1;
  return x - y;
}

/** The spellings julianday() reads that a caller would write: a date, then optionally a time. */
const TIME_BOUND =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/**
 * A since/until bound as SQL will compare it, or null when it cannot be read as a time. A year or
 * a month alone, which julianday() cannot read (so `since="2026-10"` matched nothing), widens to
 * its period: a since starts it and an until ends it.
 */
export function timeBound(value: string, edge: 'since' | 'until'): string | null {
  const raw = value.trim();
  const period = /^(\d{4})(?:-(\d{2}))?$/.exec(raw);
  if (period) {
    const year = Number(period[1]);
    const month = period[2] === undefined ? null : Number(period[2]) - 1;
    if (month !== null && (month < 0 || month > 11)) return null;
    const start = Date.UTC(year, month ?? 0, 1);
    const next = month === null ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month + 1, 1);
    return new Date(edge === 'since' ? start : next - 1).toISOString();
  }
  return TIME_BOUND.test(raw) && !Number.isNaN(storedTimeMs(raw)) ? raw : null;
}

/**
 * A call's since/until read as bounds (timeBound), or the refusal for the first that cannot be.
 * Bounds the call did not pass stay absent.
 */
export function readTimeBounds(params: {
  since?: string;
  until?: string;
}): { since?: string; until?: string } | { error: CmosToolError } {
  const out: { since?: string; until?: string } = {};
  for (const edge of ['since', 'until'] as const) {
    const value = params[edge];
    if (value === undefined) continue;
    const bound = timeBound(value, edge);
    if (bound === null) return { error: CmosErrors.invalidTimeBound(edge, value) };
    out[edge] = bound;
  }
  return out;
}
