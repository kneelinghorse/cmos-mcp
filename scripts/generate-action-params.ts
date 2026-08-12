#!/usr/bin/env npx ts-node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 `npm run probe:action-params` — prints the MECHANICAL first cut of ACTION_PARAMS
// ABOUTME: from the shared router walk, plus the audit deltas between that cut and what ships.

/**
 * Sprint 86 m04 — the codegen entry point for ACTION_PARAMS.
 *
 * ACTION_PARAMS is PRODUCT DATA, not a generated artifact: it is the per-action applicability
 * contract, it is published in TOOL_REFERENCE.md, and it is machine-checked in both directions.
 * Its FIRST CUT is generated here — from `scripts/lib/router-param-walker`, the same walk
 * s86-m03's forwarding gate uses, so neither consumer re-derives the satisfies/as unwrap trap —
 * and is then HAND-AUDITED. This script exists so a later agent can re-run the derivation and see
 * exactly where the shipped map departs from it, rather than guessing whether a difference was
 * intent or drift.
 *
 * The shipped map is REQUIRED to be permitted as a superset of this cut. That is the whole point:
 * s86-m03's `evergreen` bug was invisible precisely because generation-from-the-handler agrees
 * with a handler that under-declares. A map that can only ever equal the derivation can never be
 * red about it.
 *
 * Prints only. Never writes, never asserts.
 */

import { CMOS_TOOL_DEFINITIONS, CMOS_ACTION_PARAMS } from '../src/tools/cmos/index';
import { walkRouterParams, actionEvidence } from './lib/router-param-walker';

interface ToolDefLike {
  name: string;
  inputSchema?: {
    properties?: Record<string, { enum?: readonly string[] } | undefined>;
  };
}

/** The partition rule, stated once: a tool is action-bearing IFF it publishes an action enum. */
function actionEnumOf(def: ToolDefLike): readonly string[] | undefined {
  const prop = def.inputSchema?.properties?.action;
  return prop && Array.isArray(prop.enum) ? prop.enum : undefined;
}

function main(): void {
  const defs = CMOS_TOOL_DEFINITIONS as unknown as ToolDefLike[];
  const result = walkRouterParams({
    toolDefinitions: defs as Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>,
  });
  const shipped = CMOS_ACTION_PARAMS as Record<string, Record<string, readonly string[]>>;

  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║ s86-m04 ACTION_PARAMS first cut — generated, then hand-audited               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

  const actionBearing = defs.filter((d) => actionEnumOf(d) !== undefined);
  console.log(
    `\n${actionBearing.length} of ${defs.length} tools publish an action enum ` +
      `(${defs
        .filter((d) => actionEnumOf(d) === undefined)
        .map((d) => d.name)
        .join(', ')} do not)\n`
  );

  let generatedEntries = 0;
  let shippedEntries = 0;
  let actions = 0;

  for (const def of actionBearing) {
    const enumMembers = actionEnumOf(def) ?? [];
    const model = result.tools.find((t) => t.tool === def.name);
    const evidence = model ? actionEvidence(model) : new Map();
    const schemaKeys = new Set(Object.keys(def.inputSchema?.properties ?? {}));
    const shippedForTool = shipped[def.name] ?? {};

    console.log(
      `\n### ${def.name}  [${model?.shape ?? 'UNWALKED'}]  ` +
        `router-scope: ${(model?.routerScopeReadKeys ?? []).join(', ') || '—'}`
    );
    for (const action of enumMembers) {
      actions += 1;
      // An action with no branch is NOT evidence-free: cmos_message's `whoami` early-returns
      // before the switch, so the switch has no case for it, and the router-scope reads
      // (`projectRoot`, consumed for every action) still apply.
      const ev =
        evidence.get(action) ??
        (model?.shape === 'SWITCH-ROUTER'
          ? { forwarded: [], read: [], routerScope: model.routerScopeReadKeys }
          : undefined);
      // 'action' is the DISCRIMINANT — the property whose enum defines this partition. The switch
      // that reads it is what selects the branch, so no branch forwards or re-reads it. It belongs
      // to every action by construction, not by evidence.
      const cut = ev
        ? [
            ...new Set(
              [...ev.routerScope, ...ev.forwarded, ...ev.read].filter((k) => schemaKeys.has(k))
            ),
          ].sort()
        : ['action'];
      generatedEntries += cut.length;
      const live = shippedForTool[action] ?? [];
      shippedEntries += live.length;
      const added = live.filter((k) => !cut.includes(k));
      const dropped = cut.filter((k) => !live.includes(k));
      const note =
        live.length === 0
          ? '   (not yet authored)'
          : added.length === 0 && dropped.length === 0
            ? ''
            : `\n      AUDIT +${JSON.stringify(added)} -${JSON.stringify(dropped)}`;
      console.log(`  ${action}: ${JSON.stringify(cut)}${note}`);
      if (!ev && model?.shape === 'MONOLITHIC') {
        console.log(
          '      (MONOLITHIC — no per-action branch exists; the cut is the discriminant only ' +
            'and the shipped list is entirely hand-audited)'
        );
      }
    }
    const covered = new Set(enumMembers.flatMap((a) => shippedForTool[a] ?? []));
    const uncovered = [...schemaKeys].filter((k) => !covered.has(k));
    if (uncovered.length > 0) {
      console.log(`  UNCOVERED SCHEMA KEYS (no action claims them): ${uncovered.join(', ')}`);
    }
  }

  console.log(
    `\n── TOTALS ─────────────────────────────────────────────────────────────────────\n` +
      `  actions:            ${actions}\n` +
      `  generated entries:  ${generatedEntries}\n` +
      `  shipped entries:    ${shippedEntries}\n`
  );
}

main();
