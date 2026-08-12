// ABOUTME: s86-m05 Instrument 2 — a number an answer reports must describe the rows it claims to
// ABOUTME: describe, a param published as a no-op must not be prescribed, and a value src/ writes
// ABOUTME: into an enum-published column must be nameable through that enum. No allowlist.

/**
 * Sprint 86 m05 — INSTRUMENT 2: SEMANTIC CONTRADICTION (the SQL vs the adjective).
 *
 * Instrument 1 (agent-prompt-reachability) asks "does the thing this string names exist?".
 * This instrument asks a different question that no existence check can reach: "does this string
 * describe the rows it actually returns?" Three sub-checks, one file, because they share the
 * operator-facing-literal extractor and nothing else.
 *
 * ═══ MEASURED RED BASELINE (2026-08-12, pre-fix tree) ═══
 *   sub-check 1 (ASC+LIMIT under a recency claim): 1 module — cmos-sprint-analytics.ts
 *   sub-check 2a (a no-op param prescribed as an action): 1 site — errors.ts buildStale suggestion
 *   sub-check 2b ("close blocks" against a surface published as advisory): 2 sites —
 *                 cmos-review.ts next_actions, both arms
 *   sub-check 3 (src/ writes a value the published enum forbids): 0 against the tree as it
 *                 stands, because s86-m04 already widened cmos_learnings.status to four members.
 *                 PROVEN RED by reverting that widening to ['active','archived','superseded']:
 *                 1 hit — `UPDATE learnings SET status = 'stale'` at staleness-detection.ts:519.
 *                 See the sub-check 3 block for the reversion recipe.
 *
 * ═══ THE DEFECT SUB-CHECK 1 EXISTS FOR ═══
 * cmos-sprint-analytics.ts built `ORDER BY sprint_id ASC ${limitClause}`, so
 * cmos_sprint(action="analytics", limit=N) returned the OLDEST N sprints while its own
 * highlights called them "recent". Measured on the live 76-sprint store: limit=8 returned
 * sprint-09..sprint-16 and reported velocity trending DOWN 44%, where the unlimited call
 * reports stable +8%. A wrong-direction answer, not a stale one.
 *
 * ═══ FALSE-NEGATIVE PROFILE — SUB-CHECK 1 ═══
 * The NAIVE version of this rule ("SELECT and LIMIT inside the same template literal") was
 * measured at plan time: it returns 11 hits across src/ and MISSES cmos-sprint-analytics.ts —
 * the very defect it exists to catch — because the LIMIT lives in an interpolated
 * `${limitClause}` assembled one statement earlier. That is why this rule reads the RAW node
 * text (interpolations included) rather than the concatenated literal chunks, and why an
 * interpolation whose expression text matches /limit/i counts as a bound.
 *
 * Still invisible to it, stated rather than discovered later:
 *   - a LIMIT applied in JS after the query returns (`rows.slice(0, n)`) — no SQL to read;
 *   - a query assembled across two variables where neither half contains both clauses;
 *   - a recency claim that lives in a DIFFERENT module from the query (the adjective binding is
 *     module-scoped; it cannot follow a value across a module boundary);
 *   - a synonym for recency outside /recent|latest|newest|most recent/ ("current", "fresh");
 *   - a recency claim separated from its noun by more than two words, or by punctuation rather
 *     than whitespace ("recent decisions/learnings/mission progress" does not bind `mission`).
 *
 * ═══ WHY THE RECENCY CLAUSE IS THE DISCRIMINATOR, AND NOT A DODGE ═══
 * A bare ASC+LIMIT rule ALSO flags cmos-mission-status.ts:256 and :271, where ASC is CORRECT
 * (oldest-queued-first is the intended reading order). Excluding those by name would be an
 * allowlist — the failure mode this sprint exists to close. The rule instead fires only where a
 * recency adjective MODIFIES the entity the bounded query returns, which is what makes the
 * contradiction a contradiction.
 *
 * ═══ MEASURED DELTA AGAINST THE BUILD PLAN, recorded per its standing instruction ═══
 * The plan states this rule "fires EXACTLY ONCE on the pre-fix tree" with a MODULE-SCOPED
 * recency clause, over an enumerated ASC+LIMIT candidate set. Measured 2026-08-12, the
 * module-scoped form fires FOUR times, not once: the plan's candidate enumeration omitted
 * cmos-agent-onboard.ts, which carries three ASC-resolving bounded reads (:1035 and :1045,
 * `ORDER BY CASE status … END, rowid LIMIT 5`; :1080, `ORDER BY rowid LIMIT 3`) alongside
 * recency adjectives at :477 and :721. Those three reads are CORRECT — a work queue ordered
 * In-Progress-first, and the adjectives describe decisions, not missions.
 *
 * The plan's own instruction on such a delta is "re-measure and record the delta before changing
 * anything", and its standing rule is that a rule which cannot exclude a false positive must be
 * CHANGED, never allowlisted. So the discriminator was tightened from module-scoped
 * co-occurrence to adjective-noun MODIFICATION. With that tightening the rule fires exactly once
 * on the pre-fix tree, and the plan's conclusion holds under a stricter rule than the one it
 * specified. A second flaw surfaced from the same measurement: reading "the last ORDER BY in the
 * statement" reports the MANDATED FIX as defective, because the fix restores ASC on the outside.
 * Both are fixed structurally — see boundOrderingResolvesAsc and claimsRecencyOf.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { CMOS_TOOL_DEFINITIONS } from '../../../src/tools/cmos';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

// ─── Shared extraction ───────────────────────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface RawNode {
  /** Node text AS WRITTEN, `${...}` interpolations included. */
  raw: string;
  /** Concatenated literal chunks with interpolations elided — what a reader sees. */
  text: string;
  line: number;
}

/**
 * Every string-ish node in a file. Comments and JSDoc are not literal nodes, so they never
 * appear — that is the structural rule that keeps this file free of exemptions (it is also why
 * `// NEVER blocks closeout` at cmos-sprint-complete.ts and the ` * helper cannot block sprint
 * close` JSDoc at build-freshness.ts are not candidates, rather than exclusions).
 */
function collectNodes(file: string, content: string): RawNode[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const out: RawNode[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      out.push({
        raw: node.getText(sf),
        text: ts.isTemplateExpression(node)
          ? node.head.text + node.templateSpans.map((s) => s.literal.text).join(' ')
          : node.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
      // A TemplateExpression's spans contain nested nodes; do not double-visit its own head.
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

interface Violation {
  rel: string;
  line: number;
  message: string;
}

const SRC_FILES = walkTsFiles(SRC_ROOT);
const NODES_BY_FILE = new Map<string, RawNode[]>(
  SRC_FILES.map((f) => [f, collectNodes(f, fs.readFileSync(f, 'utf8'))])
);
const rel = (f: string): string => path.relative(path.resolve(__dirname, '../../..'), f);

// ─── SUB-CHECK 1 — an ASC-ordered, LIMIT-bounded read under a recency claim ──

/** Position of the bound — a literal LIMIT, or an interpolation whose expression names one. */
function limitIndex(raw: string): number {
  const literal = raw.search(/\bLIMIT\b/i);
  if (literal !== -1) return literal;
  for (const m of raw.matchAll(/\$\{([^}]*)\}/g)) {
    if (/limit/i.test(m[1])) return m.index ?? -1;
  }
  return -1;
}

/** True when the statement is bounded at all. */
function isLimitBounded(raw: string): boolean {
  return limitIndex(raw) !== -1;
}

/**
 * True when the ORDER BY that the LIMIT actually BINDS resolves ASC.
 *
 * "The ordering nearest the bound", not "the last ordering in the statement" — and the
 * difference is load-bearing, not pedantic. The mandated fix wraps the bounded read in a DESC
 * subquery and restores ASC on the OUTSIDE:
 *     SELECT * FROM ( <select> ORDER BY sprint_id DESC ${limitClause} ) ORDER BY sprint_id ASC
 * A last-ORDER-BY reading sees that outer ASC, sees a LIMIT in the statement, and reports the
 * FIXED code as defective — a gate that cannot go green is a gate that gets deleted. Reading the
 * ordering the bound applies to gets both directions right: the defect fires, the fix does not.
 */
function boundOrderingResolvesAsc(raw: string): boolean {
  const limit = limitIndex(raw);
  if (limit === -1) return false;
  const before = raw.slice(0, limit);
  const orders = [...before.matchAll(/\bORDER\s+BY\b([\s\S]*)$/gi)];
  const last = [...before.matchAll(/\bORDER\s+BY\b/gi)].pop();
  if (!last || orders.length === 0) return false;
  const clause = before.slice((last.index ?? 0) + last[0].length);
  // Direction of the LAST sort key in that clause: `ORDER BY a DESC, b` sorts b ascending.
  const lastKey = clause.split(',').pop() ?? '';
  return !/\bDESC\b/i.test(lastKey);
}

/**
 * The entity a table is about: `sprint_summary`→sprint, `missions`→mission,
 * `strategic_decisions`→decision. Derived from the identifier, so a new table needs no entry.
 */
function entityStem(table: string): string {
  const base = table.toLowerCase().replace(/_(summary|view|stats)$/, '');
  const lastSegment = base.split('_').pop() ?? base;
  return lastSegment.replace(/s$/, '');
}

function fromTables(sql: string): string[] {
  return [...sql.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

/**
 * True when an operator-facing literal in this module uses a recency adjective TO MODIFY the
 * entity the bounded query returns — "across recent sprints" for a read of `sprint_summary`.
 *
 * Adjective-noun MODIFICATION, not module-scoped co-occurrence, and the tightening was forced by
 * measurement rather than taste (see the header's baseline delta). A module-scoped rule fires on
 * cmos-agent-onboard.ts, whose priority-ordered work-queue reads (`ORDER BY CASE status … END,
 * rowid LIMIT 5`) are CORRECT — In-Progress-first is the intended reading order — and whose
 * recency adjectives belong to entirely different rows ("pending missions, recent decisions").
 * Excluding that module by name would be an allowlist. Binding the adjective to the noun
 * excludes it by rule, and states the contradiction precisely: this string calls THESE rows
 * recent while the query returns the oldest of them.
 */
const RECENCY_ADJ = '(?:most\\s+recent|recent|latest|newest)';
function claimsRecencyOf(nodes: RawNode[], stem: string): boolean {
  const modifies = new RegExp(`\\b${RECENCY_ADJ}\\s+(?:\\w+\\s+){0,2}${stem}s?\\b`, 'i');
  return nodes.some((n) => modifies.test(n.text));
}

function sweepOrderingHonesty(): Violation[] {
  const violations: Violation[] = [];
  for (const file of SRC_FILES) {
    const nodes = NODES_BY_FILE.get(file) ?? [];
    for (const node of nodes) {
      if (!/\bSELECT\b/i.test(node.raw) || !/\bORDER\s+BY\b/i.test(node.raw)) continue;
      if (!isLimitBounded(node.raw)) continue;
      if (!boundOrderingResolvesAsc(node.raw)) continue;
      const claimed = fromTables(node.raw)
        .map(entityStem)
        .filter((stem) => claimsRecencyOf(nodes, stem));
      if (claimed.length === 0) continue;
      violations.push({
        rel: rel(file),
        line: node.line,
        message:
          `${rel(file)}:${node.line} bounds an ASC ordering with a LIMIT — it returns the OLDEST ` +
          `rows — while an operator-facing string in the same module calls those rows ` +
          `"recent ${claimed[0]}s". Bound the window with a DESC subquery and restore ` +
          `oldest-first ordering outside it, so the answer describes the rows it returns.`,
      });
    }
  }
  return violations;
}

// ─── SUB-CHECK 2 — the published surface must not contradict itself ──────────

interface JsonSchemaProp {
  description?: string;
  enum?: unknown[];
}

/** Every published param description, keyed `tool.param`. */
function publishedParams(): Map<string, JsonSchemaProp> {
  const out = new Map<string, JsonSchemaProp>();
  for (const tool of CMOS_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as { properties?: Record<string, JsonSchemaProp> };
    for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
      out.set(`${tool.name}.${name}`, prop);
    }
  }
  return out;
}

/**
 * A literal that ASSERTS the non-blocking / no-op fact is the DECLARATION, not a prescription of
 * it. Structural negation rule, not an exemption list: the same words that make a string a
 * violation make it a declaration when they appear under a negation or an advisory framing.
 */
const DECLARES_NON_BLOCKING = /\bno-op\b|\bnever blocks?\b|\bdoes not block\b|\badvisor(y|ily)\b/i;

function sweepSelfContradiction(): Violation[] {
  const violations: Violation[] = [];
  const params = publishedParams();

  // 2a — a param the published schema calls a no-op must not be prescribed as a remedy.
  const noOpParams = new Set(
    [...params.entries()]
      .filter(([, prop]) => /\bno-op\b/i.test(prop.description ?? ''))
      .map(([key]) => key.split('.')[1])
  );

  // 2b — fires only because the published schema DECLARES the condition advisory, so the rule is
  // derived from the surface rather than asserted here.
  //
  // NO SILENT FAIL-OPEN (agents.md Process Hardening #4). If that declaration is reworded — a
  // perfectly innocent edit, "advisory … never blocks" → "informational … does not block" — this
  // predicate goes false and the whole arm turns ITSELF OFF while still reporting green. The
  // gate would then be permanently, invisibly dead, which is the exact defect class this sprint
  // exists to close, and it would be dead in the file whose job is to catch it. So a missing
  // declaration THROWS rather than disabling the check: the test fails loudly and a human
  // decides whether the policy changed or only the wording did.
  const closeDeclaredAdvisory = [...params.values()].some(
    (p) => /\badvisor/i.test(p.description ?? '') && /\bnever blocks?\b/i.test(p.description ?? '')
  );
  if (!closeDeclaredAdvisory) {
    throw new Error(
      'sub-check 2b derives its rule from a published param description declaring build-freshness ' +
        'advisory ("advisory … never blocks"). No published description matches that shape any ' +
        'more, so the check can no longer be derived. Either the policy changed (build-freshness ' +
        'now blocks — then the cmos-review wording should be restored) or the description was ' +
        'reworded (then update this predicate). It must NOT silently stop checking.'
    );
  }

  for (const file of SRC_FILES) {
    for (const node of NODES_BY_FILE.get(file) ?? []) {
      if (DECLARES_NON_BLOCKING.test(node.text)) continue;

      for (const param of noOpParams) {
        const prescribed = new RegExp(`\\b${param}\\s*[:=]\\s*true\\b|\\bpass\\s+${param}\\b`, 'i');
        if (prescribed.test(node.text)) {
          violations.push({
            rel: rel(file),
            line: node.line,
            message:
              `${rel(file)}:${node.line} tells an operator to pass \`${param}\`, which this same ` +
              `package publishes as a no-op. A remedy that does nothing is worse than no remedy.`,
          });
        }
      }

      if (
        /\bclos(e|ed|eout|ing)\b[^.]{0,20}\bblocks?\b/i.test(node.text) ||
        /\bblocks?\b\s+(on\s+)?(this|the\s+)?(sprint\s+)?clos(e|eout|ing)\b/i.test(node.text)
      ) {
        violations.push({
          rel: rel(file),
          line: node.line,
          message:
            `${rel(file)}:${node.line} tells an operator that sprint close BLOCKS on this ` +
            `condition, while the published schema declares the same condition advisory and ` +
            `says it never blocks closeout. One of the two strings is lying to every operator.`,
        });
      }
    }
  }
  return violations;
}

// ─── SUB-CHECK 3 — src/ may not write a value its published enum forbids ─────

/**
 * A value CMOS itself writes into a column must be nameable by a caller through that column's
 * published input enum. The live instance this was built for: staleness-detection.ts:519 runs
 * `UPDATE learnings SET status = 'stale'` while cmos_learnings.status published a three-member
 * enum — so the server wrote a status its own tool surface forbade a caller from filtering on.
 * cmos_decisions never had the bug (its enum has always included 'stale'); that asymmetry is
 * what proves the ENUM was wrong and the DATA was right.
 *
 * TO REPRODUCE THE RED BASELINE: in src/tools/cmos/cmos-learnings.ts, drop 'stale' from the zod
 * enum (~:113) and from the JSON schema enum (~:190). This sub-check then reports exactly one
 * violation, `learnings.status = 'stale'`. s86-m04 shipped the widening (fork f04, resolved by a
 * fleet-wide probe: 246 such rows across 7 of 18 stores), so the gate is green by AGREEMENT with
 * what m04 shipped — never by an exemption.
 *
 * The tool↔table binding is DERIVED, not tabulated: a tool governs a table when the tool's name
 * (minus the `cmos_` prefix, minus a trailing plural `s`) appears in the table name. That
 * resolves cmos_learnings→learnings and cmos_decisions→strategic_decisions without anyone
 * writing the pairs down, and it declines to resolve tables no tool publishes an enum for
 * (next_steps, constraints, sprints), which is the correct answer for those: no published enum
 * means no published contradiction.
 */
const UPDATE_WRITE_RE = /\bUPDATE\s+([a-z_]+)\s+SET\s+([a-z_]+)\s*=\s*'([^']*)'/gi;

function tableGovernedBy(toolName: string, table: string): boolean {
  const base = toolName.replace(/^cmos_/, '').replace(/s$/, '');
  return table.includes(base);
}

function sweepEnumWrites(): Violation[] {
  const violations: Violation[] = [];
  for (const tool of CMOS_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as { properties?: Record<string, JsonSchemaProp> };
    for (const [param, prop] of Object.entries(schema?.properties ?? {})) {
      if (!Array.isArray(prop.enum)) continue;
      const allowed = new Set(prop.enum.map(String));

      for (const file of SRC_FILES) {
        const content = fs.readFileSync(file, 'utf8');
        UPDATE_WRITE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = UPDATE_WRITE_RE.exec(content)) !== null) {
          const [, table, column, value] = m;
          if (column !== param) continue;
          if (!tableGovernedBy(tool.name, table)) continue;
          if (allowed.has(value)) continue;
          const line = content.slice(0, m.index).split('\n').length;
          violations.push({
            rel: rel(file),
            line,
            message:
              `${rel(file)}:${line} writes ${table}.${column} = '${value}', but ${tool.name}'s ` +
              `published enum for \`${param}\` is [${[...allowed].join(', ')}] — a caller cannot ` +
              `name a value the server itself writes. Widen the enum; do not narrow the data.`,
          });
        }
      }
    }
  }
  return violations;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('sql-ordering honesty (s86-m05 Instrument 2)', () => {
  it('parses the source tree (the sweep must not be silently vacuous)', () => {
    expect(SRC_FILES.length).toBeGreaterThanOrEqual(100);
    const total = [...NODES_BY_FILE.values()].reduce((n, v) => n + v.length, 0);
    expect(total).toBeGreaterThanOrEqual(1000);
  });

  describe('sub-check 1 — a bounded window must describe the rows it returns', () => {
    it('sees the SQL it is supposed to be reading', () => {
      // If the raw-text extraction breaks, every arm below reports zero for the wrong reason.
      let selects = 0;
      for (const nodes of NODES_BY_FILE.values()) {
        for (const n of nodes)
          if (/\bSELECT\b/i.test(n.raw) && /\bORDER\s+BY\b/i.test(n.raw)) selects++;
      }
      expect(selects).toBeGreaterThanOrEqual(20);
    });

    it('reads an interpolated ${limitClause} as a bound (the naive rule misses it)', () => {
      const naive = 'SELECT a FROM t ORDER BY a ASC LIMIT 5';
      const interpolated = 'SELECT a FROM t ORDER BY a ASC ${limitClause}';
      expect(isLimitBounded(naive)).toBe(true);
      expect(isLimitBounded(interpolated)).toBe(true);
      // …and an interpolation that is NOT a limit does not count as one.
      expect(isLimitBounded('SELECT a FROM t ORDER BY a ASC ${orderSuffix}')).toBe(false);
    });

    it('reads the direction of the ordering the LIMIT binds, not the last one written', () => {
      expect(boundOrderingResolvesAsc('SELECT a FROM t ORDER BY a ASC LIMIT 3')).toBe(true);
      expect(boundOrderingResolvesAsc('SELECT a FROM t ORDER BY a LIMIT 3')).toBe(true);
      expect(boundOrderingResolvesAsc('SELECT a FROM t ORDER BY a DESC LIMIT 3')).toBe(false);
      // `ORDER BY a DESC, b` sorts the LAST key ascending.
      expect(boundOrderingResolvesAsc('SELECT a FROM t ORDER BY a DESC, b LIMIT 3')).toBe(true);
      // THE MANDATED FIX SHAPE must read as clean, or the gate can never go green.
      const fixed = 'SELECT * FROM (SELECT a FROM t ORDER BY a DESC ${limitClause}) ORDER BY a ASC';
      expect(isLimitBounded(fixed)).toBe(true);
      expect(boundOrderingResolvesAsc(fixed)).toBe(false);
    });

    it('binds the recency adjective to the noun it modifies', () => {
      const claim = (s: string): RawNode[] => [{ raw: s, text: s, line: 1 }];
      expect(claimsRecencyOf(claim('velocity across recent sprints'), 'sprint')).toBe(true);
      expect(claimsRecencyOf(claim('the most recent 5 sprints'), 'sprint')).toBe(true);
      // The exact strings that made a module-scoped rule fire on correct code: the adjective
      // modifies a DIFFERENT noun than the one the bounded query returns.
      expect(
        claimsRecencyOf(
          claim('pending missions, recent decisions, and suggested actions'),
          'mission'
        )
      ).toBe(false);
      expect(
        claimsRecencyOf(claim('capture recent decisions/learnings/mission progress'), 'mission')
      ).toBe(false);
    });

    it('derives the entity a table is about', () => {
      expect(entityStem('sprint_summary')).toBe('sprint');
      expect(entityStem('missions')).toBe('mission');
      expect(entityStem('strategic_decisions')).toBe('decision');
      expect(fromTables('SELECT a FROM sprint_summary WHERE x')).toEqual(['sprint_summary']);
    });

    it('no module claims recency while returning the oldest bounded rows', () => {
      expect(sweepOrderingHonesty().map((v) => v.message)).toEqual([]);
    });

    it('publishes the `limit` param against BOTH actions that forward it', () => {
      // The window defect had a documentation half: `limit` is forwarded by the list branch AND
      // the analytics branch, but both published descriptions said "for list action" only — so
      // a caller reading the schema had no reason to think analytics was even bounded.
      const jsonDescription = publishedParams().get('cmos_sprint.limit')?.description ?? '';
      expect(jsonDescription).toMatch(/analytics/);
      expect(jsonDescription).toMatch(/list/);

      // …and the zod `.describe()` the JSON is generated from must say the same thing.
      const src = fs.readFileSync(path.join(SRC_ROOT, 'tools/cmos/cmos-sprint.ts'), 'utf8');
      const zodDescribe = src.match(/\.describe\((['"`])(Maximum sprints[^'"`]*)\1\)/);
      expect(zodDescribe?.[2]).toMatch(/analytics/);
      expect(zodDescribe?.[2]).toMatch(/list/);
    });
  });

  describe('sub-check 2 — the published surface must not contradict itself', () => {
    it('finds the no-op declaration it derives the rule from', () => {
      // The rule is only meaningful while the surface still publishes forceComplete as a no-op.
      const noOp = [...publishedParams().entries()].filter(([, p]) =>
        /\bno-op\b/i.test(p.description ?? '')
      );
      expect(noOp.length).toBeGreaterThanOrEqual(1);
    });

    it('never prescribes a no-op param, and never calls an advisory condition blocking', () => {
      expect(sweepSelfContradiction().map((v) => v.message)).toEqual([]);
    });
  });

  describe('sub-check 3 — a written value must be nameable through its published enum', () => {
    it('finds the enum-published columns it is checking', () => {
      const enums = [...publishedParams().values()].filter((p) => Array.isArray(p.enum));
      expect(enums.length).toBeGreaterThanOrEqual(10);
    });

    it('resolves the tool↔table binding by rule', () => {
      expect(tableGovernedBy('cmos_learnings', 'learnings')).toBe(true);
      expect(tableGovernedBy('cmos_decisions', 'strategic_decisions')).toBe(true);
      expect(tableGovernedBy('cmos_learnings', 'strategic_decisions')).toBe(false);
      expect(tableGovernedBy('cmos_learnings', 'next_steps')).toBe(false);
    });

    it('sees the write it was built for (staleness-detection writes learnings.status)', () => {
      // Guards against the sweep going vacuous if the UPDATE is ever reshaped: the gate must
      // still be READING the statement whose value it validates.
      const content = fs.readFileSync(
        path.join(SRC_ROOT, 'tools/cmos/staleness-detection.ts'),
        'utf8'
      );
      UPDATE_WRITE_RE.lastIndex = 0;
      const writes = [...content.matchAll(UPDATE_WRITE_RE)].map((m) => `${m[1]}.${m[2]}='${m[3]}'`);
      expect(writes).toContain("learnings.status='stale'");
    });

    it('writes no value its own published enum forbids a caller from naming', () => {
      expect(sweepEnumWrites().map((v) => v.message)).toEqual([]);
    });
  });
});
