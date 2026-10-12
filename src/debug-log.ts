// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m07 — the RBOOK_DEBUG gate. Diagnostics a stranger does not need go through debugLog,
// ABOUTME: so a normal start writes two stderr lines and RBOOK_DEBUG=1 brings every detail back.

import { getSetting } from './intelligence/legacy-compat';
/** True when RBOOK_DEBUG is 1, true or yes (read on every call, so a test or .env can set it). */
export function debugEnabled(): boolean {
  const value = (getSetting('RBOOK_DEBUG') ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** Write one diagnostic line to stderr, only when RBOOK_DEBUG is set. */
export function debugLog(line: string): void {
  if (debugEnabled()) console.error(line);
}
