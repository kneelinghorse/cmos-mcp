// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The one renderer for the ENVELOPE warnings channel (CmosToolResult.warnings), so a
// ABOUTME: warning an agent can only read in content[0].text cannot be dropped by a lone formatter.

import type { CmosToolResult } from './types';
import type { WriteFailure } from './write-guard';

/**
 * Attach warnings accumulated outside a result constructor to either a success or error envelope.
 *
 * Keeping this at the handler boundary prevents an early `createError(...)` from bypassing a
 * migration warning gathered earlier in the same call. Warning-free results are returned by
 * identity so existing envelope shapes remain byte-for-byte unchanged.
 */
export function attachWarnings<T>(
  result: CmosToolResult<T>,
  warnings: readonly string[]
): CmosToolResult<T> {
  if (warnings.length === 0) return result;
  const merged = [...warnings];
  for (const warning of result.warnings ?? []) {
    if (!merged.includes(warning)) merged.push(warning);
  }
  return { ...result, warnings: merged };
}

/**
 * Render `result.warnings` — the ENVELOPE channel — into a formatter's line buffer.
 *
 * WHY THIS EXISTS AS A MODULE. `createSuccess` (errors.ts:147-158) writes `warnings` onto the
 * envelope, and src/index.ts returns `content: [{type:'text', text: formatted}]` alongside
 * `structuredContent`. An agent reads `formatted`. So a warning that no `format*ForLLM` renders is
 * present in the payload and unreadable in practice — which is how s85-m04's `missionId` advisory
 * shipped invisible in 2.5.0. Before s86-m02 the channel was rendered by 14 of 76 leaf formatters
 * and absent from 57; the remaining 4 rendered only the DATA-level `result.data.warnings`, which
 * is a different channel entirely.
 *
 * The body below is LIFTED VERBATIM from the idiom those 14 sites already shared (read
 * cmos-session-start.ts, cmos-mission-defer.ts, cmos-sprint-complete.ts before this commit), so
 * no shipped answer changes shape — only the number of answers that render at all.
 *
 * PRESENCE, NOT POSITION. Call it wherever the section belongs in that answer; several formatters
 * legitimately push more lines afterwards. tests/tools/cmos/formatter-warnings.test.ts asserts the
 * call EXISTS in every leaf, and never where.
 *
 * ENVELOPE ONLY. Do not route `result.data.warnings` through here. The four formatters that carry
 * both channels render them under distinct headings so a reader can tell a transport-level
 * advisory from a domain-level one, and so neither is printed twice.
 */
export function appendWarnings(lines: string[], result: CmosToolResult<unknown>): void {
  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
}

/**
 * Render the s86-m02b `writeFailures` channel — a DB write that did not happen, on an answer that
 * otherwise reports success.
 *
 * SEPARATE FROM `appendWarnings` BY DESIGN (fork f09). A lost decision and "you forgot missionId"
 * are not the same kind of news, and an operator scanning an answer must be able to tell them
 * apart at a glance — hence a distinct heading, and the DB error code printed verbatim beside the
 * message rather than folded into prose.
 *
 * An EMPTY array renders nothing. That is load-bearing: `changes: 0` from a WHERE that matched no
 * rows is a legitimate outcome, not a failure, so the handlers that emit this field emit `[]` for
 * it — and this renderer must stay silent rather than inventing a warning about a clean write.
 */
export function appendWriteFailures(
  lines: string[],
  writeFailures: readonly WriteFailure[] | undefined
): void {
  if (!writeFailures || writeFailures.length === 0) return;
  lines.push('');
  lines.push('Write failures (the database rejected these; the counts above exclude them):');
  for (const failure of writeFailures) {
    lines.push(`- ${failure.op}: ${failure.code} — ${failure.message}`);
  }
}
