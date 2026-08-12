// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m05 Instrument 1 — a command, path or call we PRESCRIBE to an operator must be
// ABOUTME: reachable from what package.json actually ships. Oracle is files[]+bin, never existsSync.

/**
 * Sprint 86 m05 — INSTRUMENT 1: REACHABILITY.
 *
 * s85-m01's sibling gate asks "does the TOOL this string names exist?". This one asks the
 * question that one cannot reach: "can the person reading this string actually DO it?"
 *
 * ═══ THE DEFECT IT WAS BUILT FOR ═══
 * `cmos_sprint(action="complete")` pushed a warning telling operators to run
 * `npm run prune:snapshots`. That script is real — in THIS repo. package.json `files` ships
 * ["dist","cmos-seed","LICENSE","NOTICE","README.md","CHANGELOG.md","SECURITY.md",
 * "TOOL_REFERENCE.md","docs/getting-started.md"] and `bin` is {"cmos-mcp":"./dist/index.js"}.
 * `scripts/` is in neither. So no consumer of @aquex/cmos-mcp has ever been able to run the
 * command their sprint close told them to run.
 *
 * ═══ WHY THE ORACLE IS package.json, NOT fs.existsSync ═══
 * THIS IS THE WHOLE POINT OF THE INSTRUMENT. `fs.existsSync('scripts/prune-context-snapshots.ts')`
 * answers true — in this clone, for a developer, forever. It answers a question nobody asked.
 * The question is what the TARBALL contains, and only package.json knows that. (existsSync is
 * also case-insensitive on macOS, so it would additionally pass a path that breaks on Linux.)
 * A gate built on existsSync is precisely how this defect survived two prior sweeps.
 *
 * ═══ MEASURED RED BASELINE (2026-08-12, pre-fix tree) ═══
 *   unreachable npm commands prescribed to operators: 4 sites in 3 files
 *     - cmos-sprint-complete.ts:574 growth advisory  → `npm run prune:snapshots`
 *     - cmos-review.ts next_actions, BOTH arms       → `npm run build` (the two `action`
 *       strings plus the shared `command` field; line numbers moved when the fix landed, so
 *       they are deliberately not cited here — the test below pins the sites by CONTENT)
 *     - server-health.ts:106 startup WARN            → `npm run build`
 *   cmos_project() call in a shipped doc rejected by the real schema: 1
 *     - cmos-seed/README.md Quick Start, `createDocs: true` → unrecognized_keys
 *
 * DELTA against the build plan, recorded per its standing instruction: the plan enumerates the
 * `npm run build` prescriptions as src/server-health.ts:106, cmos-review.ts:420/:422 and
 * cmos-sprint-complete.ts:715, and treats only the server-health and sprint-complete pair as
 * needing a wording decision. Measured, cmos-review's TWO next_actions arms are prescriptions in
 * their own right and are fixed with the same wording; cmos-sprint-complete's buildStaleAdvisory
 * is the fourth. Line numbers throughout the file have shifted since plan time (s86-m02b added
 * ~60 lines to cmos-sprint-complete.ts): the growth advisory is at :574, not :551-555.
 *
 * ═══ THE MARKDOWN ARM MUST JOIN CONTINUATION LINES ═══
 * cmos-seed/README.md's Quick Start is a `cmos_project({ … })` call spread over eleven lines,
 * with the offending key alone on one of them. A single-line matcher sees eleven fragments and
 * no call, which is exactly how that defect survived both prior sweeps. The joiner is proven by
 * a synthetic fixture below, not asserted.
 *
 * ═══ FALSE POSITIVES EXCLUDED BY RULE — no allowlist, and if a rule cannot exclude one, the
 *     rule changes ═══
 *   - Import/export/require literals: a module specifier is not advice to an operator.
 *   - Comments and JSDoc: not literal nodes, so never candidates (this is what removes 9 of the
 *     15 `cmos/db/cmos.sqlite` mentions in src/).
 *   - npm-run strings in scripts/ are repo-internal by construction: scripts/ does not ship, so a
 *     string inside it is not addressed to a consumer.
 *   - A string that merely NAMES a command inside a source-checkout context (README's `git clone`
 *     block) is a developer instruction; the rule keys on the `npm run` prescription reaching an
 *     operator-facing SINK, not on the characters appearing somewhere.
 *   - An unreachable command IS acceptable when the same entry names the packaged alternative —
 *     see namesThePackagedCase. The rule is "never leave a reader with nothing", not "never say
 *     npm run build".
 *
 * ═══ WHAT THIS FILE CHECKS, AND WHAT IT DOES NOT ═══
 * SCOPE, stated because an earlier revision's header described arms that were never implemented.
 * Two sweeps run over src/, and both are about COMMANDS:
 *   1. `npm run <script>` in an operator-facing literal, against package.json files[]+bin;
 *   2. the markdown arm — continuation-joined `cmos_*( … )` calls in shipped docs, run through
 *      the real zod schema.
 * There is NO general path-reachability sweep over src/ string literals. Consumer-project paths
 * (`cmos/…`) are covered instead by the freshly-init'd-root fire test at the bottom of this file,
 * which is case-SENSITIVE and checks the seed templates against a real init. Repo-relative path
 * tokens in shipped PROSE are Instrument 3's identifier arm, not this file's.
 *
 * ═══ FALSE-NEGATIVE PROFILE ═══
 *   - A command assembled at runtime from variables is invisible (no literal to read).
 *   - A path inside a template interpolation is only partially visible.
 *   - files[] entries are matched by prefix, so a gate on a file that exists in a shipped
 *     DIRECTORY but is deleted later would still resolve.
 *   - Non-npm commands (a bare binary name) are not checked; only `npm run` is.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { cmosProjectSchema } from '../../../src/tools/cmos/cmos-project';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const r = (...p: string[]): string => path.join(REPO_ROOT, ...p);

const PKG = JSON.parse(fs.readFileSync(r('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
};

// ─── The reachability oracle: what the tarball actually contains ─────────────

/**
 * Is `relPath` inside the published tarball? files[] entries are files or directories, matched
 * as prefixes; bin values are additional shipped paths.
 */
function shipsInTarball(relPath: string): boolean {
  const normalized = relPath.replace(/^\.\//, '').replace(/\/+$/, '');
  const shipped = [...PKG.files, ...Object.values(PKG.bin).map((b) => b.replace(/^\.\//, ''))];
  return shipped.some(
    (entry) => normalized === entry || normalized.startsWith(`${entry.replace(/\/+$/, '')}/`)
  );
}

/** An `npm run <name>` is reachable only if the script's own file ships. */
function npmScriptIsReachable(scriptName: string): boolean {
  const body = PKG.scripts[scriptName];
  if (body === undefined) return false;
  // Every path token the script body references must ship for a consumer to run it.
  const referenced = [...body.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs))/g)].map((m) => m[1]);
  if (referenced.length === 0) {
    // No file reference — a bare toolchain invocation (tsc, jest, eslint). Those need devDeps
    // and a source checkout, so they are not consumer-reachable either.
    return false;
  }
  return referenced.every((p) => shipsInTarball(p));
}

// ─── Source arm: operator-facing string literals in src/ + scripts/ ──────────

function walkTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Literal {
  text: string;
  line: number;
  /** True when the literal reaches a sink that an operator or agent reads. */
  operatorFacing: boolean;
  /**
   * Every string in the SAME object literal, joined. A `next_actions` entry is `{action,
   * command}` and the reader sees both at once — `formatReviewForLLM` renders them on one line
   * as `[1] <action> → <command>`. So the unit of honesty is the entry, not the literal: a
   * `command` that only works in a source checkout is fine when its own `action` says so, and
   * judging the two separately would force the command field to be deleted or lied about.
   */
  entryText: string;
}

/** The known sinks: text that reaches a human or an agent, as opposed to internal plumbing. */
const SINK_PROPERTIES = new Set([
  'suggestion',
  'message',
  'description',
  'action',
  'command',
  'reason',
  'warning',
]);

/**
 * String literals in a TS file with a structural judgement of whether each is operator-facing.
 * Comments are not literal nodes, so they are absent by construction — no exclusion needed.
 */
function collectLiterals(file: string, content: string): Literal[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const out: Literal[] = [];

  const isModuleSpecifier = (node: ts.Node): boolean => {
    const p = node.parent;
    if (!p) return false;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
    if (ts.isCallExpression(p) && p.expression.getText(sf) === 'require') return true;
    if (ts.isExternalModuleReference(p)) return true;
    return false;
  };

  /**
   * A function whose NAME declares it builds operator-facing text. Its return value is a message
   * by construction, so a literal inside it is operator-facing even with no sink in sight.
   *
   * Without this, the gate misses `buildStaleAdvisory` (cmos-sprint-complete.ts) entirely: the
   * literal lives in a bare `return (...)`, the `warnings.push` that consumes it is in a
   * different function, and no property-assignment or call ancestor exists within reach. The
   * gate would have reported green on a site this mission CLAIMS to have fixed — the fix would
   * be real but unguarded, and a future revert would go unnoticed.
   */
  const MESSAGE_BUILDER = /(advisory|message|warning|suggestion|hint|prompt|summary|text)$/i;

  const inMessageBuilder = (node: ts.Node): boolean => {
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (
        (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) &&
        cur.name &&
        MESSAGE_BUILDER.test(cur.name.getText(sf))
      ) {
        return true;
      }
      if (ts.isVariableDeclaration(cur) && MESSAGE_BUILDER.test(cur.name.getText(sf))) return true;
      cur = cur.parent;
    }
    return false;
  };

  /**
   * Walk to the enclosing STATEMENT rather than a fixed number of ancestors.
   *
   * A fixed depth-6 cap looked safe and was not: the sprint-close growth advisory is a six-part
   * `+` concatenation, so its first chunk sits SEVEN levels below the `warnings.push` that
   * consumes it (template → 5 nested BinaryExpressions → call). The gate silently classified the
   * longest, most operator-facing string in the file as internal. A message does not become less
   * operator-facing because someone wrapped one more line — the statement boundary is the real
   * limit, so that is what is walked to.
   */
  const reachesSink = (node: ts.Node): boolean => {
    let cur: ts.Node | undefined = node;
    while (cur) {
      const p: ts.Node | undefined = cur.parent;
      if (!p) break;
      if (ts.isPropertyAssignment(p) && SINK_PROPERTIES.has(p.name.getText(sf))) return true;
      if (ts.isCallExpression(p)) {
        const callee = p.expression.getText(sf);
        if (
          /warnings\.push|\.describe|suggestedActions|highlights\.push|console\.(error|warn)/.test(
            callee
          )
        ) {
          return true;
        }
      }
      // Stop at the statement that contains the literal — beyond it, an ancestor call is a
      // different expression, not this string's consumer.
      if (ts.isStatement(p) || ts.isBlock(p)) break;
      cur = p;
    }
    return inMessageBuilder(node);
  };

  /** Text of every string in the nearest enclosing object literal — the entry a reader sees. */
  const enclosingEntryText = (node: ts.Node): string => {
    let cur: ts.Node | undefined = node.parent;
    for (let depth = 0; cur && depth < 4; depth++) {
      if (ts.isObjectLiteralExpression(cur)) return cur.getText(sf);
      cur = cur.parent;
    }
    return '';
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!isModuleSpecifier(node)) {
        out.push({
          text: node.text,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          // Operator-facing when it reads as prose (contains whitespace) AND reaches a sink.
          operatorFacing: /\s/.test(node.text) && reachesSink(node),
          entryText: enclosingEntryText(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

interface Violation {
  message: string;
}

/**
 * A source-only command is acceptable when the SAME string tells a packaged consumer what to do
 * instead. The rule is not "never say npm run build" — some readers are in a source checkout and
 * for them it is the right answer. The rule is that a string must not leave the other reader with
 * nothing, so an unreachable command is fine exactly when it is offered as one of two branches.
 */
function namesThePackagedCase(text: string): boolean {
  return /\breinstall\b|\bfrom source\b|\bsource checkout\b|\bpackaged install\b/i.test(text);
}

function sweepSourceCommands(): Violation[] {
  const violations: Violation[] = [];
  // scripts/ does not ship, so a prescription inside it is addressed to a contributor working
  // from a source checkout, never to a consumer. Structural, not an exemption: the rule is
  // "does this string reach a CONSUMER", and nothing in scripts/ reaches one.
  for (const file of walkTsFiles(r('src'))) {
    const rel = path.relative(REPO_ROOT, file);
    for (const lit of collectLiterals(file, fs.readFileSync(file, 'utf8'))) {
      if (!lit.operatorFacing) continue;
      for (const m of lit.text.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
        if (npmScriptIsReachable(m[1])) continue;
        if (namesThePackagedCase(lit.text) || namesThePackagedCase(lit.entryText)) continue;
        violations.push({
          message:
            `${rel}:${lit.line} prescribes \`npm run ${m[1]}\` to an operator, but nothing that ` +
            `script needs is in package.json files[]+bin — a consumer of the published package ` +
            `cannot run it, and this string offers them no alternative. Either describe the ` +
            `situation without a command, or name the packaged case alongside the source case.`,
        });
      }
    }
  }
  return violations;
}

// ─── Markdown arm: continuation-joined `cmos_*( … )` calls ───────────────────

/**
 * Join a markdown document's wrapped/multi-line constructs so a call spread over many lines is
 * ONE string to match against. Proven by the synthetic fixture in the tests below.
 */
export function joinContinuations(content: string): string[] {
  const lines = content.split('\n');
  const out: string[] = [];
  let buffer: string[] | null = null;
  let depth = 0;

  // Strip a trailing `//` comment PER LINE, before joining. Doing it after the join is a bug
  // with teeth: the joined string has no newlines left, so a `[^\n]*` comment strip consumes
  // the entire rest of the call. The `(?<!:)` guard keeps `https://` intact.
  const stripLineComment = (line: string): string => line.replace(/(?<!:)\/\/.*$/, '').trimEnd();

  for (const raw of lines) {
    const line = stripLineComment(raw);
    const opens = (line.match(/\(/g) ?? []).length;
    const closes = (line.match(/\)/g) ?? []).length;
    if (buffer === null && /\bcmos_[a-z_]+\s*\(/.test(line)) {
      buffer = [line.trim()];
      depth = opens - closes;
      if (depth <= 0) {
        out.push(buffer.join(' '));
        buffer = null;
      }
      continue;
    }
    if (buffer !== null) {
      buffer.push(line.trim());
      depth += opens - closes;
      if (depth <= 0) {
        out.push(buffer.join(' '));
        buffer = null;
      }
      continue;
    }
    out.push(raw);
  }
  if (buffer !== null) out.push(buffer.join(' '));
  return out;
}

/** Pull the object literal out of a joined `cmos_project({ … })` call. */
export function extractProjectCallObject(joined: string): string | null {
  const m = joined.match(/cmos_project\s*\(\s*(\{[\s\S]*\})\s*\)/);
  return m ? m[1] : null;
}

/**
 * Turn a documented JS-ish object literal into a value. The Quick Start is written as JS with
 * `//` comments and unquoted keys, so it is normalized rather than JSON.parse'd directly.
 */
export function evalDocumentedObject(literal: string): Record<string, unknown> {
  const withoutComments = literal.replace(/\/\/[^\n]*/g, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`"use strict"; return (${withoutComments});`)() as Record<string, unknown>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('operator-facing reachability (s86-m05 Instrument 1)', () => {
  it('uses package.json as the oracle, and would NOT be satisfied by existsSync', () => {
    // The distinction the whole instrument rests on, asserted so it cannot quietly regress into
    // a working-tree check.
    expect(fs.existsSync(r('scripts', 'prune-context-snapshots.ts'))).toBe(true);
    expect(shipsInTarball('scripts/prune-context-snapshots.ts')).toBe(false);
    expect(npmScriptIsReachable('prune:snapshots')).toBe(false);
    expect(npmScriptIsReachable('build')).toBe(false);
    // …while a genuinely shipped path resolves.
    expect(shipsInTarball('dist/index.js')).toBe(true);
    expect(shipsInTarball('docs/getting-started.md')).toBe(true);
    expect(shipsInTarball('cmos-seed/db/schema.sql')).toBe(true);
  });

  it('reads the source tree (the sweep must not be silently vacuous)', () => {
    const files = walkTsFiles(r('src'));
    expect(files.length).toBeGreaterThanOrEqual(100);
    const operatorFacing = files.reduce(
      (n, f) =>
        n + collectLiterals(f, fs.readFileSync(f, 'utf8')).filter((l) => l.operatorFacing).length,
      0
    );
    expect(operatorFacing).toBeGreaterThanOrEqual(100);
  });

  it('actually SEES each site this mission fixed (the sweep must guard what it claims)', () => {
    // A green sweep proves nothing about a site the sweep cannot reach. Each of the four fixed
    // sites must be VISIBLE to the extractor as operator-facing text, so that reverting any one
    // of them turns this file red. buildStaleAdvisory was invisible until `inMessageBuilder`
    // landed: its literal is in a bare `return (...)`, with the warnings.push in another function.
    const seen = (relPath: string, needle: string): boolean => {
      const full = r(relPath);
      return collectLiterals(full, fs.readFileSync(full, 'utf8')).some(
        (l) => l.operatorFacing && l.text.includes(needle)
      );
    };
    expect(seen('src/server-health.ts', 'npm run build')).toBe(true);
    expect(seen('src/tools/cmos/cmos-review.ts', 'rebuild from source')).toBe(true);
    expect(seen('src/tools/cmos/cmos-sprint-complete.ts', 'Rebuild from source')).toBe(true);
    expect(seen('src/tools/cmos/cmos-sprint-complete.ts', 'context_snapshots has grown')).toBe(
      true
    );
  });

  it('prescribes no command a consumer of the published package cannot run', () => {
    expect(sweepSourceCommands().map((v) => v.message)).toEqual([]);
  });

  it('has no array or Set of literal exemptions', () => {
    // Criterion 1's self-check: this gate discriminates BY RULE. Scoped to the SWEEP MACHINERY —
    // everything above the first `describe(` — because a fixture defined inside a test is input
    // to the gate, not a carve-out from it. The only collection there is SINK_PROPERTIES, which
    // WIDENS what counts as operator-facing rather than narrowing what counts as a violation:
    // the opposite of an allowlist, and it makes the gate stricter, not looser.
    const self = fs.readFileSync(__filename, 'utf8');
    const machinery = self.slice(0, self.indexOf('\ndescribe('));
    // WHAT AN ALLOWLIST ACTUALLY LOOKS LIKE, in any identifier case: a MODULE-SCOPE collection
    // (declared at column 0) whose initializer contains string literals. Two earlier revisions
    // each got one half wrong — a `[A-Z_]`-anchored pattern missed `const skipList = [...]`
    // entirely, and matching every case flagged ordinary local accumulators (`out`,
    // `violations`, `referenced`) that hold no literals and exempt nothing. The two conditions
    // together are what make this a check rather than noise.
    const declarations = [
      ...machinery.matchAll(
        /^(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(new Set\(\[|\[)([\s\S]*?)\n(?:\]|\);|\];)/gm
      ),
    ];
    const collections = declarations
      .filter((m) => /['"`]/.test(m[3])) // holds literals — an empty accumulator exempts nothing
      .map((m) => m[1])
      // SINK_PROPERTIES WIDENS what counts as operator-facing rather than narrowing what counts
      // as a violation — it makes the gate stricter, so it is not an exemption list.
      .filter((name) => name !== 'SINK_PROPERTIES');
    expect(collections).toEqual([]);

    // Premise check: the pattern can still SEE a module-scope literal collection at all. Without
    // this the assertion above passes trivially if the regex stops matching anything.
    expect(declarations.map((m) => m[1])).toContain('SINK_PROPERTIES');
  });
});

describe('markdown arm joins continuation lines (s86-m05 Instrument 1)', () => {
  const SYNTHETIC = [
    'Some prose before.',
    '```',
    'cmos_project({',
    '  action: "init",',
    '  projectRoot: "/tmp/x",',
    '  bogusKey: true,',
    '})',
    '```',
    'Some prose after.',
  ].join('\n');

  it('finds a multi-line call that a single-line matcher cannot see', () => {
    // THE PROOF, not the assertion: a single-line matcher over the same fixture finds nothing,
    // because no one line contains both the call and its arguments.
    const singleLineHits = SYNTHETIC.split('\n').filter((l) =>
      /cmos_project\s*\(\s*\{[\s\S]*\}\s*\)/.test(l)
    );
    expect(singleLineHits).toEqual([]);

    const joined = joinContinuations(SYNTHETIC).find((l) => l.includes('cmos_project'));
    expect(joined).toBeDefined();
    const obj = extractProjectCallObject(joined as string);
    expect(obj).not.toBeNull();
    expect(Object.keys(evalDocumentedObject(obj as string))).toContain('bogusKey');
  });

  it('flags the bogus key against the real schema', () => {
    const joined = joinContinuations(SYNTHETIC).find((l) => l.includes('cmos_project')) as string;
    const parsed = cmosProjectSchema.safeParse(
      evalDocumentedObject(extractProjectCallObject(joined) as string)
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.code)).toContain('unrecognized_keys');
    }
  });
});

describe("cmos-seed's own recommended first command (s86-m05 Instrument 1)", () => {
  it('is accepted by the real cmos_project schema', () => {
    // The seed's Quick Start is the FIRST thing a new project is told to run, and the server
    // rejected it: cmosProjectSchema is .strict() and declares no `createDocs`, so safeParse
    // returned unrecognized_keys ['createDocs']. Two prior sweeps missed it because the call is
    // spread over eleven lines.
    const content = fs.readFileSync(r('cmos-seed', 'README.md'), 'utf8');
    // The README names `cmos_project(action="init")` in prose BEFORE the fenced call, so take
    // every joined candidate that actually carries an object literal, not merely the first
    // mention of the tool.
    const objectLiterals = joinContinuations(content)
      .map(extractProjectCallObject)
      .filter((o): o is string => o !== null);
    expect(objectLiterals.length).toBeGreaterThanOrEqual(1);

    const parsed = cmosProjectSchema.safeParse(evalDocumentedObject(objectLiterals[0]));
    if (!parsed.success) {
      throw new Error(
        `cmos-seed/README.md's Quick Start is rejected by cmosProjectSchema: ` +
          JSON.stringify(parsed.error.issues, null, 2)
      );
    }
    expect(parsed.success).toBe(true);
  });

  it('claims no conditional the init path does not implement', () => {
    // `cmos/docs/` is copied unconditionally by copySeedDir; nothing reads a createDocs flag.
    const content = fs.readFileSync(r('cmos-seed', 'README.md'), 'utf8');
    expect(content).not.toMatch(/createDocs/);
  });
});

// ─── Seed templates: a path a seeded project is told to read must be created ─

/**
 * cmos_project(init) copies cmos-seed verbatim into `<projectRoot>/cmos`. Every path token in
 * the seed TEMPLATES that is rooted at `cmos/` therefore names a file the tool itself is
 * responsible for creating — and three of them named files nothing has ever created
 * (`cmos/missions/backlog.yaml`, `cmos/SESSIONS.jsonl`), while two more had the CASE wrong
 * (`cmos/PROJECT_CONTEXT.json` and `cmos/context/MASTER_CONTEXT.json`; the real files are
 * `cmos/context/project_context.json` and `cmos/context/master_context.json`).
 *
 * THE SCOPE RULE IS STRUCTURAL: only `cmos/`-rooted paths are checked. PROJECT-README-template.md
 * is explicitly a fill-in template — the line after the ones in question reads "[Link to your API
 * docs if applicable]" — so `docs/roadmap.md` and `docs/technical_architecture.md` are
 * CONSUMER-PROJECT paths the consumer creates, not phantoms. Not rooted at `cmos/`, therefore not
 * checked, by rule rather than by judgement.
 *
 * AND THE COMPARISON IS CASE-SENSITIVE, VIA readdirSync. `fs.existsSync` is case-INSENSITIVE on
 * macOS, so it would happily resolve `cmos/context/MASTER_CONTEXT.json` against the real
 * lowercase file and pass the exact defect this test exists to catch — while a consumer on Linux
 * got a missing file.
 */
describe('seed templates name only paths init creates (s86-m05 Instrument 1)', () => {
  const templates = ['PROJECT-README-template.md', 'agents.md'];

  it('names no cli.py — cmos_project(init) has never created one', () => {
    // copySeedDir copies cmos-seed verbatim and cmos-seed contains no cli.py; scripts/ does not
    // ship. The three `./cmos/cli.py` commands told every seeded project to run a file that
    // could not exist.
    for (const t of templates) {
      expect(fs.readFileSync(r('cmos-seed', 'templates', t), 'utf8')).not.toMatch(/cli\.py/);
    }
  });

  it("every cmos/-rooted path exists CASE-SENSITIVELY in a freshly-init'd root", async () => {
    const { cmosProjectInit } = await import('../../../src/tools/cmos/cmos-project-init');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m05-init-'));
    try {
      const result = await cmosProjectInit({
        projectRoot,
        projectName: 'Seed Template Fire Test',
      });
      expect(result.success).toBe(true);

      /** Case-SENSITIVE existence: walk the real directory entries, never existsSync. */
      const existsExactly = (relPath: string): boolean => {
        const segments = relPath.split('/').filter(Boolean);
        let dir = projectRoot;
        for (let i = 0; i < segments.length; i++) {
          let entries: string[];
          try {
            entries = fs.readdirSync(dir);
          } catch {
            return false;
          }
          if (!entries.includes(segments[i])) return false;
          dir = path.join(dir, segments[i]);
        }
        return true;
      };

      // Premise check: the init actually produced the tree we are about to assert against.
      expect(existsExactly('cmos/db/cmos.sqlite')).toBe(true);
      expect(existsExactly('cmos/context/master_context.json')).toBe(true);
      // …and the case-insensitive trap the plan named is genuinely a trap here.
      expect(existsExactly('cmos/context/MASTER_CONTEXT.json')).toBe(false);

      const missing: string[] = [];
      for (const t of templates) {
        const content = fs.readFileSync(r('cmos-seed', 'templates', t), 'utf8');
        for (const m of content.matchAll(/`\.?\/?(cmos\/[A-Za-z0-9_./-]+)`/g)) {
          const target = m[1].replace(/[.,;:]+$/, '');
          if (!existsExactly(target)) missing.push(`cmos-seed/templates/${t} → ${target}`);
        }
      }
      expect(missing).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60000);
});
