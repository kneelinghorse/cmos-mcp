// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m07 — the CMOS_DEBUG gate. Diagnostics a stranger does not need go through debugLog,
// ABOUTME: so a normal start writes two stderr lines and CMOS_DEBUG=1 brings every detail back.

/** True when CMOS_DEBUG is 1, true or yes (read on every call, so a test or .env can set it). */
export function debugEnabled(): boolean {
  const value = (process.env.CMOS_DEBUG ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** Write one diagnostic line to stderr, only when CMOS_DEBUG is set. */
export function debugLog(line: string): void {
  if (debugEnabled()) console.error(line);
}
