// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 Part A — the published JSON inputSchema must state exactly what its zod schema
// ABOUTME: states. Six parities, walked over all 15 tools, with no hand-written param or name list.

/**
 * Sprint 86 m04 Part A — "say only what you know", enforced on the PUBLISHED SCHEMA.
 *
 * THE DEFECT CLASS. Every CMOS tool states its input contract TWICE — once as a zod schema and once
 * as a JSON inputSchema that ships to npm and reaches every MCP host. Nothing kept the two in step,
 * so the published half drifted into saying things the server does not do.
 *
 * ── MEASURED PRE-FIX RED BASELINE (2026-08-11, by revert-run-restore against a clean worktree of
 *    b4fea88) — 45 violations across 6 legs, 15 tools / 37 numeric declarations / 221 properties:
 *
 *      type             30   a zod `.int()` publishing `number`
 *      array-item-type   3   nextStepIds[], constraintIds[], decisionIds[] — same defect, in items
 *      minimum           4   a `.positive()` publishing no `minimum`
 *      maximum           0   (no live instance — proven to fire by fixture, at the bottom)
 *      enum              3   cmos_decisions.status, cmos_learnings.category, cmos_learnings.status
 *      strict            5   zod/JSON disagreeing on whether unknown keys are accepted
 *      key-set           0   (no live instance — proven to fire by fixture)
 *
 * TWO LEGS MEASURE HIGHER THAN THE BUILD PLAN STATED, and the measured figures govern. The plan
 * said 2 minimums and 3 stricts; both counts were TOP-LEVEL ONLY. The 2 extra minimums are ARRAY
 * ELEMENTS (`cmos_context.nextStepIds[]`, `constraintIds[]`), whose `.positive()` element published
 * no `minimum`; the 2 extra stricts are NESTED OBJECTS (`cmos_project.initialSprint`,
 * `initialMissions[]`), which are `.strict()` in zod while publishing neither their properties nor
 * `additionalProperties`. The nested pair is the mirror image of the three root cases: there zod was
 * open and the JSON closed, here zod is closed and the JSON says nothing. Their fix publishes the
 * sub-shape TRANSCRIBED from the zod schema alongside `additionalProperties: false` — publishing the
 * closedness WITHOUT the keys would have said "no keys are accepted", the same defect inverted.
 *
 * THE ENUM LEG IS THE ONE THAT MATTERS MOST. `cmos_learnings.status` forbade callers from naming
 * `stale` — a value CMOS ITSELF writes at staleness-detection.ts:494-499, and which exists in 246
 * rows across 7 of 18 registered stores (measured per-store before any edit). `cmos_decisions` never
 * had this bug, and that asymmetry is the evidence the enum was wrong rather than the data.
 *
 * WHAT A CONSUMER ACTUALLY EXPERIENCES, probed rather than assumed (build plan CORRECTION 4). The
 * consolidated zod schemas are NEVER parsed at runtime: src/index.ts dispatches with no parse step
 * and all 15 cases cast (`args as Cmos*Params`), and the only two `.safeParse` calls in src/ are on
 * STANDALONE handler schemas (cmos-session-start.ts, cmos-project-init.ts). So the JSON side is the
 * ONLY enforcement any consumer ever sees, and it is client-side. That makes the divergence worse,
 * not milder: the published schema is not a redundant description of a server check, it is the
 * whole check.
 *
 * DERIVED LOCATORS, NO NAME MAP. A tool's zod schema is resolved from its own name by rule —
 * `cmos_agent_onboard` → `cmos-agent-onboard.ts` → `cmosAgentOnboardSchema` — and a tool whose
 * schema cannot be resolved FAILS LOUDLY. A hand-written tool→schema map would be an allowlist by
 * another spelling: the one tool someone forgot to add would be the one that drifts.
 *
 * ── VACUITY FLOOR ─────────────────────────────────────────────────────────────────────────────
 * A walker that silently stops walking reports zero violations and looks like success. The floor
 * (>=15 tools, >=37 numeric declarations, >=190 properties) fails instead. Modelled on
 * tests/tools/cmos/agent-prompt-tool-names.test.ts.
 *
 * ── FALSE-NEGATIVE PROFILE ────────────────────────────────────────────────────────────────────
 *  1. IT COMPARES DECLARATIONS, NOT BEHAVIOUR. `integer` on both sides says nothing about whether
 *     the handler floors a float before binding it into `LIMIT ?`. It does not (measured).
 *  2. UNWRAPPING IS FINITE. ZodOptional/ZodNullable/ZodDefault/ZodEffects are unwrapped; an exotic
 *     wrapper this walk does not know reaches the base-node check as itself and is reported, not
 *     skipped.
 *  3. NESTED PARITY IS SHALLOW BEYOND `strict`. Leg (v) recurses into nested objects for the
 *     unknown-keys check, but the type/min/max legs compare top-level properties and array items
 *     only — a divergence three levels down is invisible.
 *  4. IT CANNOT SEE A MISSING CONSTRAINT ON BOTH SIDES. If neither side declares a `maximum`, the
 *     gate is green; whether one is warranted is a design question no parity rule can answer.
 *  5. IT COMPARES DECLARED SHAPES, SO AN UNDECLARED SUB-SHAPE IS A KEY-SET FAILURE, NOT A GAP.
 *     Part A briefly exempted nested objects publishing no `properties`; Part B declared the last
 *     one (`cmos_context.arrayUpdates`) and the exemption was deleted rather than left standing —
 *     an exemption nothing reaches is indistinguishable from one that silently starts reaching
 *     something.
 */

import * as path from 'path';
import { z } from 'zod';

import { CMOS_TOOL_DEFINITIONS } from '../../src/tools/cmos/index';

/** One divergence between the two declarations of a single key. */
interface Violation {
  readonly tool: string;
  readonly key: string;
  readonly leg: 'type' | 'array-item-type' | 'minimum' | 'maximum' | 'enum' | 'strict' | 'key-set';
  readonly detail: string;
}

interface JsonProp {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: readonly unknown[];
  items?: JsonProp;
  properties?: Record<string, JsonProp>;
  additionalProperties?: boolean;
}

interface JsonSchema {
  properties?: Record<string, JsonProp>;
  additionalProperties?: boolean;
}

/**
 * Resolve a tool's ZodObject from its NAME, by rule (build plan CORRECTION 8).
 * `cmos_agent_onboard` → `src/tools/cmos/cmos-agent-onboard.ts` → export `cmosAgentOnboardSchema`.
 */
function resolveSchema(toolName: string): z.ZodObject<z.ZodRawShape> {
  const file = 'cmos-' + toolName.replace(/^cmos_/, '').replace(/_/g, '-');
  const exportName = toolName.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase()) + 'Schema';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join('../../src/tools/cmos', file)) as Record<string, unknown>;
  const schema = mod[exportName];
  if (!schema || !(schema instanceof z.ZodObject)) {
    throw new Error(
      `schema-parity: cannot resolve a ZodObject for ${toolName} — expected export ` +
        `\`${exportName}\` from src/tools/cmos/${file}.ts. The locator is DERIVED from the tool ` +
        `name on purpose; do not add a name map, fix the naming or the export.`
    );
  }
  return schema as z.ZodObject<z.ZodRawShape>;
}

/** Strip Optional/Nullable/Default/Effects to the base node. */
function baseOf(node: z.ZodTypeAny): z.ZodTypeAny {
  let cur = node;
  for (let i = 0; i < 20; i++) {
    const def = cur._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    if (
      cur instanceof z.ZodOptional ||
      cur instanceof z.ZodNullable ||
      cur instanceof z.ZodDefault
    ) {
      cur = def.innerType as z.ZodTypeAny;
      continue;
    }
    if (cur instanceof z.ZodEffects) {
      cur = def.schema as z.ZodTypeAny;
      continue;
    }
    return cur;
  }
  return cur;
}

interface NumberFacts {
  readonly isInt: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** zod records `.positive()` as `{kind:'min', value:0, inclusive:false}`. */
function numberFacts(node: z.ZodNumber): NumberFacts {
  const checks = (
    node._def as { checks: Array<{ kind: string; value?: number; inclusive?: boolean }> }
  ).checks;
  const isInt = checks.some((c) => c.kind === 'int');
  let min: number | undefined;
  let max: number | undefined;
  for (const c of checks) {
    if (c.kind === 'min' && c.value !== undefined) {
      const effective = c.inclusive === false ? (isInt ? c.value + 1 : c.value) : c.value;
      min = min === undefined ? effective : Math.max(min, effective);
    }
    if (c.kind === 'max' && c.value !== undefined) {
      max = max === undefined ? c.value : Math.min(max, c.value);
    }
  }
  return { isInt, min, max };
}

interface WalkTotals {
  tools: number;
  numericDeclarations: number;
  properties: number;
}

/** Compare one zod node against one JSON property. Pushes into `violations`. */
function compareNode(
  tool: string,
  key: string,
  zodNode: z.ZodTypeAny,
  json: JsonProp,
  violations: Violation[],
  totals: WalkTotals,
  isItem = false
): void {
  const base = baseOf(zodNode);
  const leg = isItem ? 'array-item-type' : 'type';

  if (base instanceof z.ZodNumber) {
    totals.numericDeclarations += 1;
    const facts = numberFacts(base);
    // (i) an `.int()` check must publish `integer`, not `number`.
    if (facts.isInt && json.type !== 'integer') {
      violations.push({
        tool,
        key,
        leg,
        detail: `zod .int() publishes type:'${json.type}'; expected 'integer'`,
      });
    }
    if (!facts.isInt && json.type === 'integer') {
      violations.push({
        tool,
        key,
        leg,
        detail: `zod has no .int() check but publishes type:'integer'`,
      });
    }
    // (ii) minimum parity.
    if (facts.min !== undefined && json.minimum !== facts.min) {
      violations.push({
        tool,
        key,
        leg: 'minimum',
        detail: `zod min ${facts.min} vs published minimum ${json.minimum ?? '(absent)'}`,
      });
    }
    // (iii) maximum parity. Preventive — no live instance, proven red by fixture.
    if (facts.max !== undefined && json.maximum !== facts.max) {
      violations.push({
        tool,
        key,
        leg: 'maximum',
        detail: `zod max ${facts.max} vs published maximum ${json.maximum ?? '(absent)'}`,
      });
    }
    return;
  }

  // (iv) enum parity, in BOTH directions.
  if (base instanceof z.ZodEnum) {
    const zodValues = [...(base._def as { values: readonly string[] }).values].sort();
    const jsonValues = [...((json.enum ?? []) as string[])].sort();
    if (json.enum === undefined) {
      violations.push({
        tool,
        key,
        leg: 'enum',
        detail: `zod enum [${zodValues}] but no JSON enum`,
      });
    } else if (JSON.stringify(zodValues) !== JSON.stringify(jsonValues)) {
      violations.push({
        tool,
        key,
        leg: 'enum',
        detail: `zod [${zodValues}] vs published [${jsonValues}]`,
      });
    }
    return;
  }
  if (base instanceof z.ZodString && json.enum !== undefined) {
    violations.push({
      tool,
      key,
      leg: 'enum',
      detail:
        `zod is a plain string but the published schema declares enum [${json.enum}] — an ` +
        `enforcement the server does not perform`,
    });
    return;
  }

  // Recurse into array elements.
  if (base instanceof z.ZodArray) {
    const element = (base._def as { type: z.ZodTypeAny }).type;
    if (json.items) {
      compareNode(tool, `${key}[]`, element, json.items, violations, totals, true);
    }
    return;
  }

  // (v) strict parity on nested objects.
  if (base instanceof z.ZodObject) {
    compareObject(tool, key, base, json, violations, totals);
  }
}

/** (v) + (vi) for one object level: unknown-keys parity and key-set equality. */
function compareObject(
  tool: string,
  prefix: string,
  zodObject: z.ZodObject<z.ZodRawShape>,
  json: { properties?: Record<string, JsonProp>; additionalProperties?: boolean },
  violations: Violation[],
  totals: WalkTotals
): void {
  const strict = (zodObject._def as { unknownKeys?: string }).unknownKeys === 'strict';
  const closed = json.additionalProperties === false;
  if (strict !== closed) {
    violations.push({
      tool,
      key: prefix || '(root)',
      leg: 'strict',
      detail: `zod unknownKeys='${(zodObject._def as { unknownKeys?: string }).unknownKeys}' vs published additionalProperties=${json.additionalProperties}`,
    });
  }

  const shape = zodObject.shape;
  const zodKeys = Object.keys(shape);
  const jsonKeys = Object.keys(json.properties ?? {});

  // (vi) key-set equality, BOTH directions, UNCONDITIONALLY — including nested objects.
  //
  // This was briefly carved out for nested objects publishing no `properties` at all, because
  // Part A could not fix the one remaining instance. Part B removed it: `cmos_context.arrayUpdates`
  // now declares its two real keys, so no such object exists and the carve-out was dead. It is
  // deleted rather than left as a standing exemption — an exemption nothing reaches is
  // indistinguishable from one that silently starts reaching something.
  for (const k of zodKeys) {
    if (!jsonKeys.includes(k)) {
      violations.push({
        tool,
        key: prefix ? `${prefix}.${k}` : k,
        leg: 'key-set',
        detail: 'declared in zod, absent from the published schema',
      });
    }
  }
  for (const k of jsonKeys) {
    if (!zodKeys.includes(k)) {
      violations.push({
        tool,
        key: prefix ? `${prefix}.${k}` : k,
        leg: 'key-set',
        detail: 'published but absent from zod',
      });
    }
  }

  for (const k of zodKeys) {
    const jsonProp = (json.properties ?? {})[k];
    if (!jsonProp) continue;
    totals.properties += 1;
    compareNode(tool, prefix ? `${prefix}.${k}` : k, shape[k], jsonProp, violations, totals);
  }
}

/**
 * Compare ONE synthetic zod/JSON pair. Used only by the fixture tests below, so the `maximum` and
 * `key-set` legs — which have ZERO live instances — are proven to fire rather than assumed to.
 * A leg that is green because the tree happens to contain no violation is indistinguishable from a
 * leg that is green because it never runs.
 */
export function comparePair(
  name: string,
  zodObject: z.ZodObject<z.ZodRawShape>,
  json: JsonSchema
): Violation[] {
  const violations: Violation[] = [];
  const totals: WalkTotals = { tools: 0, numericDeclarations: 0, properties: 0 };
  compareObject(name, '', zodObject, json, violations, totals);
  return violations;
}

function walkAll(): { violations: Violation[]; totals: WalkTotals } {
  const violations: Violation[] = [];
  const totals: WalkTotals = { tools: 0, numericDeclarations: 0, properties: 0 };
  for (const def of CMOS_TOOL_DEFINITIONS) {
    const schema = resolveSchema(def.name);
    const json = def.inputSchema as unknown as JsonSchema;
    totals.tools += 1;
    compareObject(def.name, '', schema, json, violations, totals);
  }
  return { violations, totals };
}

describe('published JSON inputSchema ↔ zod parity (s86-m04 Part A)', () => {
  const { violations, totals } = walkAll();
  const byLeg = (leg: Violation['leg']) => violations.filter((v) => v.leg === leg);

  it('reports its full violation set BY LEG and BY NAME (printed, so a baseline is checkable)', () => {
    const legs: Violation['leg'][] = [
      'type',
      'array-item-type',
      'minimum',
      'maximum',
      'enum',
      'strict',
      'key-set',
    ];
    // eslint-disable-next-line no-console
    console.log(
      `\n[s86-m04] schema parity — ${totals.tools} tools, ${totals.numericDeclarations} numeric ` +
        `declarations, ${totals.properties} properties compared\n` +
        legs
          .map((leg) => {
            const hits = byLeg(leg);
            return (
              `  ${leg}: ${hits.length}` +
              (hits.length
                ? '\n' + hits.map((v) => `      ${v.tool}.${v.key} — ${v.detail}`).join('\n')
                : '')
            );
          })
          .join('\n')
    );
    expect(totals.tools).toBe(15);
  });

  it('walks every tool, resolving each schema from its NAME with no hand-written map', () => {
    expect(totals.tools).toBe(15);
    for (const def of CMOS_TOOL_DEFINITIONS) {
      expect(() => resolveSchema(def.name)).not.toThrow();
    }
  });

  it('VACUITY FLOOR — a walker that stopped walking must fail here, not report zero', () => {
    // Deleting the body of compareObject's property loop drops these to 0 and fails, rather than
    // producing an empty violation list that reads as success.
    expect(totals.tools).toBeGreaterThanOrEqual(15);
    expect(totals.numericDeclarations).toBeGreaterThanOrEqual(37);
    expect(totals.properties).toBeGreaterThanOrEqual(190);
  });

  it('(i) every zod .int() publishes integer, and nothing else does', () => {
    expect(byLeg('type').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(i-array) every zod .int() ARRAY ELEMENT publishes items.type integer', () => {
    expect(byLeg('array-item-type').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(ii) every zod minimum is published, with .positive() on an integer meaning minimum 1', () => {
    expect(byLeg('minimum').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(iii) every zod maximum is published', () => {
    expect(byLeg('maximum').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(iv) enum membership agrees in BOTH directions', () => {
    expect(byLeg('enum').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(v) zod .strict() ⇔ published additionalProperties:false, recursing into nested objects', () => {
    expect(byLeg('strict').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(vi) key sets agree in BOTH directions — no JSON-only key, no zod-only key', () => {
    expect(byLeg('key-set').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('the three genuinely non-integer params still publish number, by name', () => {
    // A blanket number→integer replace breaks exactly these three. Asserted by name so the sweep
    // cannot quietly take them with it.
    const props = (name: string) =>
      (CMOS_TOOL_DEFINITIONS.find((t) => t.name === name)!.inputSchema as unknown as JsonSchema)
        .properties!;
    expect(props('cmos_sprint').targetSizePercent.type).toBe('number');
    expect(props('cmos_context').targetSizePercent.type).toBe('number');
    expect(props('cmos_context').recencyWeight.type).toBe('number');
  });
});

describe('the two legs with no live instance are proven to fire (s86-m04 Part A)', () => {
  it('(iii) maximum — a zod .max() the published schema omits is caught', () => {
    const zodSchema = z.object({ limit: z.number().int().max(50).optional() }).strict();
    const green = comparePair('fixture', zodSchema, {
      properties: { limit: { type: 'integer', maximum: 50 } },
      additionalProperties: false,
    });
    expect(green).toEqual([]);

    const red = comparePair('fixture', zodSchema, {
      properties: { limit: { type: 'integer' } },
      additionalProperties: false,
    });
    expect(red.map((v) => `${v.leg}:${v.key}`)).toContain('maximum:limit');

    // …and a DISAGREEING maximum is caught too, not just an absent one.
    const mismatched = comparePair('fixture', zodSchema, {
      properties: { limit: { type: 'integer', maximum: 100 } },
      additionalProperties: false,
    });
    expect(mismatched.map((v) => `${v.leg}:${v.key}`)).toContain('maximum:limit');
  });

  it('(vi) key-set — a JSON-only key and a zod-only key are BOTH caught', () => {
    const zodSchema = z.object({ a: z.string().optional() }).strict();

    const zodOnly = comparePair('fixture', zodSchema, {
      properties: { b: { type: 'string' } },
      additionalProperties: false,
    });
    // `a` is declared in zod but never published; `b` is published but not in zod. BOTH directions.
    expect(
      zodOnly
        .filter((v) => v.leg === 'key-set')
        .map((v) => v.key)
        .sort()
    ).toEqual(['a', 'b']);

    const agreed = comparePair('fixture', zodSchema, {
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    expect(agreed.filter((v) => v.leg === 'key-set')).toEqual([]);
  });
});

describe('arrayUpdates states ONE thing in all three places (s86-m04 Part B)', () => {
  it('zod, the published schema, and the handler type agree on the same two keys', () => {
    // The pre-fix state was three MUTUALLY INCONSISTENT statements about one parameter: zod named
    // four keys, the published JSON named none at all, and the handler accepted two. A caller who
    // passed `decisions_made` alone got INVALID_PARAMETER from an error whose own suggestion told
    // them to pass `decisions_made`.
    const zodKeys = Object.keys(
      (
        resolveSchema('cmos_context').shape.arrayUpdates as z.ZodOptional<
          z.ZodObject<z.ZodRawShape>
        >
      ).unwrap().shape
    ).sort();
    const jsonKeys = Object.keys(
      (
        CMOS_TOOL_DEFINITIONS.find((t) => t.name === 'cmos_context')!
          .inputSchema as unknown as JsonSchema
      ).properties!.arrayUpdates.properties ?? {}
    ).sort();

    expect(zodKeys).toEqual(['constraints', 'context_notes']);
    expect(jsonKeys).toEqual(['constraints', 'context_notes']);
    expect(jsonKeys).toEqual(zodKeys);
  });

  it('the published arrayUpdates object is NOT closed — its zod object is `strip`', () => {
    // Closing it would manufacture a fresh strict-parity divergence of exactly the kind leg (v)
    // exists to catch, inside the fix for a different one.
    const json = (
      CMOS_TOOL_DEFINITIONS.find((t) => t.name === 'cmos_context')!
        .inputSchema as unknown as JsonSchema
    ).properties!.arrayUpdates;
    expect(json.additionalProperties).toBeUndefined();
  });
});
