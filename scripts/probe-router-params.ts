#!/usr/bin/env npx ts-node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m03 `npm run probe:router-params` — prints per-tool/per-action handler-accepted vs
// ABOUTME: forwarded keys from the shared walker. The codegen entry point s86-m04's ACTION_PARAMS uses.

/**
 * Sprint 86 m03 — the second consumer of `scripts/lib/router-param-walker`.
 *
 * The gate (tests/tools/cmos/router-param-forwarding.test.ts) is the first. A jest test is not
 * invokable as a codegen step, so m04 — which must generate its ACTION_PARAMS first cut from the
 * same walk — calls THIS. One walker, two consumers: the unwrap trap documented in the walker's
 * header is solved in exactly one place and the two walks cannot drift.
 *
 * Prints only. Never writes, never asserts.
 */

import { CMOS_TOOL_DEFINITIONS } from '../src/tools/cmos/index';
import {
  walkRouterParams,
  surfaceAcceptedKeys,
  undeclaredSurfaceKeys,
} from './lib/router-param-walker';

function main(): void {
  const result = walkRouterParams({
    toolDefinitions: CMOS_TOOL_DEFINITIONS as unknown as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>,
  });

  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║ s86-m03 router param probe — handler-accepted vs forwarded, per tool/action  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log(
    `\nts.Program: ${result.programFileCount} src files in ${result.programBuildMs}ms\n` +
      `Registered tools walked: ${result.tools.length} of ${CMOS_TOOL_DEFINITIONS.length}\n`
  );

  console.log('── DISPATCH SHAPE (computed for every registered tool) ─────────────────────────');
  for (const t of result.tools) {
    console.log(`  ${t.tool.padEnd(24)} ${t.shape.padEnd(14)} ${t.shapeReason}`);
  }

  console.log('\n── PER-ACTION FORWARDING ───────────────────────────────────────────────────────');
  for (const t of result.tools) {
    console.log(`\n### ${t.tool}  [${t.shape}]  entry ${t.entry.file}:${t.entry.line}`);
    for (const branch of t.branches) {
      if (branch.calls.length === 0) {
        console.log(`  ${branch.action}: (no delegated CmosToolResult call)`);
        continue;
      }
      const scored = branch.calls.filter((c) => c.shape !== 'NOT-A-FORWARDING-SITE');
      const unscored = branch.calls.filter((c) => c.shape === 'NOT-A-FORWARDING-SITE');
      if (unscored.length > 0) {
        const names = [...new Set(unscored.map((c) => c.callee))].sort();
        console.log(
          `  ${branch.action}: ${unscored.length} NOT-A-FORWARDING-SITE call(s) — no params reach them, nothing to drop: ${names.join(', ')}`
        );
      }
      for (const call of scored) {
        const tag = call.isSubRouter ? ' [sub-router]' : '';
        console.log(
          `  ${branch.action} → ${call.callee} (${call.shape}, depth ${call.depth})${tag}  ${call.file}:${call.line}`
        );
        if (call.shape === 'POSITIONAL') {
          console.log(`      accepted(positional): ${call.positionalAccepted.join(', ') || '—'}`);
        } else {
          console.log(`      accepted: ${call.accepted.join(', ') || '—'}`);
        }
        console.log(`      forwarded: ${call.forwarded.join(', ') || '—'}`);
        if (call.dropped.length > 0) {
          console.log(`      DROPPED: ${call.dropped.join(', ')}`);
        }
      }
    }
    const surface = surfaceAcceptedKeys(t)
      .map((s) => (s.from && s.from !== s.key ? `${s.key}←${s.from}` : s.key))
      .join(', ');
    console.log(`  surface-accepted (assertion B oracle): ${surface}`);
    console.log(`  inputSchema top-level: ${t.inputSchemaKeys.join(', ')}`);
    const missing = undeclaredSurfaceKeys(t);
    if (missing.length > 0) {
      console.log(
        `  NOT DECLARED ON inputSchema: ${missing
          .map((s) => (s.from ? `${s.key}(←${s.from})` : s.key))
          .join(', ')}`
      );
    }
  }

  console.log(
    '\n── RULE EXCLUSIONS (complete set; growth shows up in a diff) ────────────────────'
  );
  if (result.exclusions.length === 0) {
    console.log('  (none)');
  }
  const seen = new Set<string>();
  for (const e of result.exclusions) {
    const id = `${e.file}:${e.line}:${e.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    console.log(`  ${e.key.padEnd(22)} [${e.rule}] ${e.file}:${e.line}\n      reason: ${e.reason}`);
  }

  console.log(
    '\n── UNCLASSIFIABLE (assertion C would fail on each) ──────────────────────────────'
  );
  if (result.unclassifiable.length === 0) console.log('  (none)');
  for (const u of result.unclassifiable) {
    console.log(`  ${u.file}:${u.line} — ${u.what}\n      ${u.detail}`);
  }

  console.log(
    `\n── NON-DELEGATING in-src calls inside branches: ${result.nonDelegatingCalls.length} ` +
      `(printed so nothing is silently dropped) ──`
  );
  const uniq = new Set(result.nonDelegatingCalls.map((c) => c.callee));
  console.log(`  distinct callees: ${[...uniq].sort().join(', ')}`);
}

main();
