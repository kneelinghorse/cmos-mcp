// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m05 Instrument 3 — every code-shaped token in a shipped document must resolve to
// ABOUTME: something real, and no shipped document may assert what another one in the same tarball denies.

/**
 * Sprint 86 m05 — INSTRUMENT 3: SHIPPED-PROSE TRUTH.
 *
 * ═══ THE DEFECT CLASS, AND WHY TWO PRIOR ARCS MISSED IT ═══
 * README.md and SECURITY.md ship in the SAME npm tarball and contradicted each other on three
 * data-loss guarantees — soft deletes via `deleted_at`, an automatic snapshot before destructive
 * operations, and a `dry_run` flag. README asserted all three; SECURITY.md, under a heading
 * literally called "Backups & deletion — the honest reality", denied all three. That
 * contradiction shipped in 2.3.0, 2.4.0 and 2.5.0.
 *
 * `git log -L 216,232:README.md` dates that block to 2026-05-07 (826f542, s62-m01) — BEFORE Arc B
 * ("everything documented is true") and before Arc C (which authored SECURITY.md). Both arcs
 * closed over it because both verified GENERATED artifacts against their generators, and prose
 * has no generator. This file is that generator's replacement: not a proofread, a resolver.
 *
 * ═══ MEASURED RED BASELINE (2026-08-12, pre-fix tree) — 13 findings, no false positives ═══
 *   identifier arm (8): `deleted_at` at README.md:218 (0 in the seed schema, 0 in src/ CODE — the
 *                      only two src/ mentions are JSDoc saying the column does NOT exist);
 *                      `CMOS_AUTO_SNAPSHOT` and `CMOS_SNAPSHOT_RETENTION_DAYS` at README.md:194-195
 *                      and agents.md:403-404 (0 reads anywhere in src/ or scripts/); `dry_run` at
 *                      README.md:221 (0 in src/ — the real param is `dryRun`, on 2 of 15 tools);
 *                      and `valid_values` at README.md:214 and agents.md:138.
 *   contradiction arm (5): the CMOS_AUTO_SNAPSHOT / CMOS_SNAPSHOT_RETENTION_DAYS / deleted_at
 *                      trio, asserted in README.md and agents.md, denied in SECURITY.md.
 *
 * `valid_values` was NOT in the build plan's fix list — the gate found it. Both README.md and
 * agents.md document the error envelope as carrying `valid_values` and `current_state`, while
 * every error the code actually emits uses `validValues` / `currentState` (errors.ts:218,
 * cmos-next-steps.ts:80, and the `result.error.validValues` reads in five routers). A consumer
 * writing `if (err.valid_values)` against the documented shape gets `undefined` forever. Same
 * class as the trio, found by rule rather than by having been noticed.
 *
 * ═══ DIRECTION OF FIX IS ONE-WAY ═══
 * SECURITY.md is the correct document. Every fix moved README.md and docs/getting-started.md
 * TOWARD it, and each claim was re-proven against SOURCE (grep the identifier, read the schema),
 * never against SECURITY.md's prose. That ordering is not a style preference: SECURITY.md's
 * claims are the ones a security reader relies on, and "make the docs agree" would have been
 * satisfied just as well by deleting the true statement.
 *
 * ═══ RESOLUTION CORPUS — WHY CODE AND NOT `grep src/` ═══
 * A token resolves against src/ and scripts/ CODE (AST identifiers + string literals), the seed
 * schema, package.json `scripts`, and package.json `files`. Comments are excluded, and that is
 * load-bearing rather than tidy: `deleted_at` appears twice in src/, both times inside JSDoc
 * saying *"that column does not exist"*. A raw `grep src/` would have resolved the token and
 * passed the very defect this gate exists to catch.
 *
 * ═══ THE NEGATION RULE (no allowlist, and SECURITY.md must stay sayable) ═══
 * A document naming an identifier in order to DENY it is not claiming it exists. SECURITY.md
 * says `CMOS_AUTO_SNAPSHOT`, `CMOS_SNAPSHOT_RETENTION_DAYS` and `DB_PATH` "are vestigial — no
 * code reads them", which is TRUE and is exactly the disclosure a reader needs. Without a
 * negation rule this gate would fire on the honest document and the only way to green it would
 * be an allowlist — the failure mode this sprint exists to close. So a token inside a negated
 * sentence is excluded BY RULE, and the same rule is what lets the contradiction arm read
 * SECURITY.md's denials as the authority they are.
 *
 * ═══ FALSE-NEGATIVE PROFILE ═══
 *   - A claim made in prose with no backticked token ("snapshots are taken automatically") is
 *     invisible to both arms. The contradiction arm reaches it only when SECURITY.md's denial
 *     carries a backticked token.
 *   - A token that exists but means something else — a real column named in a false claim about
 *     its behavior — resolves and passes. Existence is not semantics.
 *   - A contradiction between two documents that BOTH state a claim positively (neither denies
 *     the other) is invisible; the arm keys on an explicit denial.
 *   - camelCase identifiers are not checked (too many are prose words). Exactly three token
 *     shapes are: ENV-shaped (`CMOS_*`), snake_case, and `npm run <script>`. PATHS ARE NOT
 *     CHECKED HERE — path reachability belongs to Instrument 1
 *     (tests/tools/cmos/agent-prompt-reachability.test.ts), which owns the package.json
 *     files[]+bin oracle and the freshly-init'd-root fire test. An earlier revision declared a
 *     'path' token kind that nothing ever constructed, which claimed coverage this file does
 *     not have — the same defect it exists to catch.
 *
 * ═══ EXCLUDED FROM THE TARGET SET, with the rule reason — printed by the gate ═══
 * See EXCLUSIONS below. The gate PRINTS them, because a silent exclusion is this sprint's own
 * defect class.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { CMOS_TOOL_DEFINITIONS } from '../../src/tools/cmos';
import { lastUpdatedBodyChangeFindings } from './last-updated-body-oracle';
import { inspectNpmPack, toPackagePath } from './npm-pack-inspection';

const REPO_ROOT = path.resolve(__dirname, '../..');
const r = (...p: string[]): string => path.join(REPO_ROOT, ...p);

/**
 * TARGET SET — an explicit path list, NOT "package.json files[] entries".
 *
 * The two roles of files[] are different and conflating them was a plan-time defect caught by a
 * critic: files[] is the REACHABILITY ORACLE (what actually ships), but it cannot be the TARGET
 * SET because directory entries mix prose with schemas and configuration. Every shipped prose
 * subtree in scope is named below, so a newly noticed subtree cannot remain absent from both the
 * targets and exclusions.
 */
const PUBLIC_TARGETS = [
  'README.md',
  'SECURITY.md',
  'docs/getting-started.md',
  'TOOL_REFERENCE.md',
  // Ships inside the `cmos-seed` files[] entry and is the seed's own front page — every claim in
  // it reaches a consumer. It was absent from BOTH lists in the first revision, which is the
  // failure this instrument is about: not a wrong scope decision, an UNSTATED one.
  'cmos-seed/README.md',
];

/**
 * Targets that exist ONLY in this private repo. `scripts/mirror-to-public.sh` deletes `agents.md`
 * and the whole `cmos/` tree (PRIVATE_PATHS at :25) while MIRRORING `tests/` — and a test is
 * public-mirror-exposed surface (learning #281). So a gate that unconditionally reads these two
 * files throws ENOENT in the public repo and breaks its suite for everyone.
 *
 * NOT A SILENT SKIP. Absence is only acceptable when it is CONSISTENT with a mirrored checkout —
 * every private target missing together. A partially-missing set means a file was deleted or
 * moved for some other reason, and that fails loudly. Whatever is skipped is PRINTED.
 */
const PRIVATE_TARGETS = ['agents.md', 'cmos/docs/build-session-prompt.md'];

const presentPrivateTargets = PRIVATE_TARGETS.filter((p) => fs.existsSync(r(p)));
const inPublicMirror = presentPrivateTargets.length === 0;

/**
 * s87-m04 — the seed's own documentation, swept for IDENTIFIER claims.
 *
 * These ship inside the `cmos-seed` files[] entry and are copied verbatim into every project by
 * `cmos_project(action="init")`, so every identifier they name reaches a consumer as instruction.
 * They are NOT in PRIVATE_TARGETS and must never be added there: `mirror-to-public.sh`'s
 * PRIVATE_PATHS does not list `cmos-seed`, so they ship to the public mirror too — and a check
 * gated on `inPublicMirror` would leave the public copies unchecked in the one repo an external
 * consumer actually reads.
 */
const SEED_DOC_TARGETS = fs
  .readdirSync(r('cmos-seed/docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `cmos-seed/docs/${f}`)
  .sort();

/**
 * s88-m03 — both templates ship inside package.json's `cmos-seed` entry and are copied into every
 * initialized project. They were previously absent from BOTH the targets and exclusions: the
 * exact undeclared-scope failure this instrument's header says it prevents.
 */
const SEED_TEMPLATE_TARGETS = fs
  .readdirSync(r('cmos-seed/templates'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `cmos-seed/templates/${f}`)
  .sort();

/** Tier guides are executable agent instruction prose, not inert configuration. */
const SEED_TIER_TARGETS = fs
  .readdirSync(r('cmos-seed/tiers'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `cmos-seed/tiers/${f}`)
  .sort();

const TARGETS = [
  ...PUBLIC_TARGETS,
  ...SEED_DOC_TARGETS,
  ...SEED_TEMPLATE_TARGETS,
  ...SEED_TIER_TARGETS,
  ...presentPrivateTargets,
];

/** Excluded from the target set, each with the RULE that excludes it. Printed, never silent. */
const EXCLUSIONS: Array<{ pathGlob: string; reason: string }> = [
  {
    pathGlob: 'cmos/planning/**',
    reason:
      'Sprint planning records. Naming a retired tool or a superseded figure there is CORRECT — ' +
      'they are a historical record, not a description of the current surface.',
  },
  {
    pathGlob: 'CHANGELOG.md',
    reason:
      'A release history. Every entry describes the surface AT THAT VERSION; identifiers removed ' +
      'since are supposed to still appear under their old release heading.',
  },
  {
    pathGlob: 'cmos-seed/foundational-docs/**',
    reason:
      'Fill-in-the-blank project scaffolds. Tokens such as `operation_name` and `tool_name` are ' +
      'deliberate consumer placeholders, not claims that those identifiers exist in CMOS.',
  },
];

function isExplicitlyExcluded(rel: string): boolean {
  return EXCLUSIONS.some(({ pathGlob }) =>
    pathGlob.endsWith('/**') ? rel.startsWith(pathGlob.slice(0, -2)) : rel === pathGlob
  );
}

// ─── Resolution corpus: what a token may resolve AGAINST ─────────────────────

function walkFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (entry.name.endsWith(ext) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Every identifier and string-literal chunk in a TS file — i.e. the CODE, with comments and
 * JSDoc structurally absent. See the header for why that distinction decides this gate.
 */
function codeTokens(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.push(node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const PKG = JSON.parse(fs.readFileSync(r('package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
};

/**
 * What counts as REAL. Every entry is a place a token can legitimately exist; none of them is an
 * exemption for a token that does not.
 *
 *   src/ + scripts/ CODE  — identifiers and string literals only (comments excluded; see header)
 *   cmos-seed/db/schema.sql — column and table names
 *   cmos-seed/tiers/*.md    — shipped tier config (YAML frontmatter in a .md file). agents.md
 *                             documents its keys (`tools_use`, `onboard_fields_show`), which exist
 *                             ONLY there: tier-config.ts mentions `tools_use` in a comment
 *                             explaining the parser ignores it, so a code-only corpus would call
 *                             a true statement false.
 *   tests/ `process.env` READS ONLY — and the narrowness is load-bearing, not fussiness. See
 *                             ENV_READS below.
 */
const CODE_CORPUS: string = (() => {
  const parts: string[] = [];
  for (const f of [...walkFiles(r('src'), '.ts'), ...walkFiles(r('scripts'), '.ts')]) {
    parts.push(codeTokens(f).join('\n'));
  }
  const schema = r('cmos-seed', 'db', 'schema.sql');
  if (fs.existsSync(schema)) parts.push(fs.readFileSync(schema, 'utf8'));
  for (const t of walkFiles(r('cmos-seed', 'tiers'), '.md')) {
    parts.push(fs.readFileSync(t, 'utf8'));
  }
  return parts.join('\n');
})();

/**
 * Env vars actually READ via `process.env` anywhere in the repo, tests included.
 *
 * WHY NOT JUST ADD tests/ TO THE CORPUS — a mistake this gate made and caught on itself, worth
 * recording because it is the failure mode the whole instrument is about. agents.md documents
 * `CMOS_LIVE_PROJECT_ID`, which is real but read only by a test, so tests/ was added to the
 * corpus wholesale. That immediately turned the gate GREEN on `deleted_at`,
 * `CMOS_AUTO_SNAPSHOT` and `CMOS_SNAPSHOT_RETENTION_DAYS` — because THIS FILE names all three,
 * in its own header and assertions, as examples of things that do not exist. The corpus had
 * become self-referential: the gate documenting a defect was what made the defect resolve.
 *
 * So the tests/ contribution is exactly the thing that justified it — a name passed to
 * `process.env` — and nothing else. A test MENTIONING a token proves nothing; a test READING an
 * env var proves that env var is real.
 */
const ENV_READS: Set<string> = (() => {
  const found = new Set<string>();
  const files = [
    ...walkFiles(r('src'), '.ts'),
    ...walkFiles(r('scripts'), '.ts'),
    ...walkFiles(r('tests'), '.ts'),
  ];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    for (const m of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]);
    for (const m of content.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) {
      found.add(m[1]);
    }
  }
  return found;
})();

function existsInCode(token: string, kind?: Token['kind']): boolean {
  if (kind === 'env' && ENV_READS.has(token)) return true;
  return new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(CODE_CORPUS);
}

// ─── Token extraction from a markdown document ───────────────────────────────

interface Token {
  text: string;
  kind: 'env' | 'snake' | 'script';
  line: number;
  sentence: string;
}

/**
 * A sentence is negated when it DENIES the existence of the thing it names. Deliberately
 * narrower than "contains a negation word": `only when you set CMOS_DASHBOARD_URL` contains no
 * denial of CMOS_DASHBOARD_URL, and a loose rule reads it as one.
 */
const NEGATED = new RegExp(
  [
    'vestigial',
    'no code reads',
    // Hyphenated compounds are how this reads in practice: "a-column-that-doesn't-exist".
    "does(n't| not)[- ]exist",
    'not[- ]exist',
    'no such',
    'there is (\\*\\*)?no\\b',
    '(is|are|was|were|has been|have been)\\s+(\\w+\\s+and\\s+)?(removed|retired|superseded|deleted)\\b',
    'no table has',
    'no longer (exists|shipped|supported|read)',
    'nothing (implements|writes|reads)',
    'never (created|exists|existed|shipped)',
    'no (automatic|`?deleted_at`?)',
  ].join('|'),
  'i'
);

/**
 * Does the denial in `sentence` actually GOVERN `token`, or does it merely share a sentence with
 * it? Two shapes count, and nothing else does:
 *
 *   (a) the negation immediately precedes the token — "There is **no `deleted_at` net**";
 *   (b) the token is the SUBJECT of a denial predicate — "`CMOS_AUTO_SNAPSHOT`, … are
 *       **vestigial**", "the legacy `CMOS_DASHBOARD_SECRET` shared-secret is retired".
 *
 * Sentence co-occurrence alone is not enough, and the counter-example is in SECURITY.md itself:
 * "The `cmk_` keys in that file are stored in plaintext — there is **no** encryption at rest."
 * That sentence denies ENCRYPTION, not `cmk_`. A co-occurrence rule reads it as a denial of the
 * key prefix and then reports agents.md as contradicting SECURITY.md for mentioning `cmk_` at
 * all — a false positive that could only be silenced with an allowlist.
 */
function denialGoverns(sentence: string, token: string): boolean {
  const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const precedes = new RegExp(`\\b(no|not|never)\\b[^.]{0,30}?\`?${t}\`?(?![A-Za-z0-9_])`, 'i');
  const predicate = new RegExp(
    `\`?${t}\`?(?![A-Za-z0-9_])[^.]{0,140}?\\b(is|are|was|were|has been|have been)\\b[^.]{0,40}?` +
      `(vestigial|removed|retired|superseded|deleted|no longer)`,
    'i'
  );
  return precedes.test(sentence) || predicate.test(sentence);
}

/**
 * A markdown document as UNITS — a bullet or paragraph with its continuation lines JOINED.
 *
 * The joining is not cosmetic. SECURITY.md's denial wraps across two lines:
 *     - The environment variables `CMOS_AUTO_SNAPSHOT`, `CMOS_SNAPSHOT_RETENTION_DAYS`, …
 *       appear in older docs but are **vestigial — no code reads them.**
 * A line-scoped reader sees the tokens on one line and the denial on the next, and reports the
 * HONEST document as making a false claim. The same shape hides agents.md's "no table has a
 * literal `deleted_at` column". Continuation-joining is what makes the negation rule work at
 * all — the identical defect Instrument 1's markdown arm exists to fix.
 */
interface Unit {
  text: string;
  line: number;
  inFence: boolean;
}

function markdownUnits(content: string): Unit[] {
  const lines = content.split('\n');
  const units: Unit[] = [];
  let current: { parts: string[]; line: number; inFence: boolean } | null = null;
  let inFence = false;

  const flush = (): void => {
    if (current)
      units.push({ text: current.parts.join(' '), line: current.line, inFence: current.inFence });
    current = null;
  };

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) {
      // Inside a fence every line is its own code unit; wrapping is not a thing there.
      units.push({ text: line, line: i + 1, inFence: true });
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    // A new bullet, numbered item, heading or table row starts a new unit; anything else that
    // follows a non-empty line is a CONTINUATION of it.
    if (/^\s*([-*+]|\d+\.|#{1,6}\s|\|)/.test(line) || current === null) {
      flush();
      current = { parts: [line.trim()], line: i + 1, inFence: false };
    } else {
      current.parts.push(line.trim());
    }
  });
  flush();
  return units;
}

/** The sentence within `unit` that contains `token`, or the whole unit when it is one sentence. */
function sentenceFor(unit: string, token: string): string {
  const sentences = unit.split(/(?<=[.!?])\s+(?=[A-Z*`-])/);
  const hit = sentences.find((s) =>
    new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(s)
  );
  return hit ?? unit;
}

function extractTokens(rel: string): Token[] {
  const out: Token[] = [];
  for (const unit of markdownUnits(fs.readFileSync(r(rel), 'utf8'))) {
    // Inside a fenced block the whole line is code; outside, only backticked spans are.
    const candidates: string[] = unit.inFence
      ? [unit.text]
      : [...unit.text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

    const push = (text: string, kind: Token['kind']): void => {
      // A SQLite PRAGMA name belongs to SQLite's surface, not CMOS's — the same "not ours to
      // own" class as a consumer-project path. `PRAGMA user_version` is a real thing that will
      // never appear in src/ or in our schema, and the oracle has nothing to resolve it against.
      // Structural (the token is qualified by the PRAGMA keyword), so no name is written down.
      if (new RegExp(`\\bPRAGMA\\s+\`?${text}\\b`, 'i').test(unit.text)) return;
      out.push({ text, kind, line: unit.line, sentence: sentenceFor(unit.text, text) });
    };

    for (const candidate of candidates) {
      // npm scripts, wherever they appear.
      for (const m of candidate.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) push(m[1], 'script');
      // ENV-shaped names.
      for (const m of candidate.matchAll(/\b(CMOS_[A-Z0-9_]+)\b/g)) push(m[1], 'env');
      // snake_case identifiers (columns, params, fields).
      const bare = candidate.trim();
      if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(bare)) push(bare, 'snake');
      // `dry_run: true`-shaped claims: a snake_case key with a value. Inside a fence this also
      // catches interface fields (`valid_values?: any[]`), which is how a documented envelope
      // shape gets checked against the shape the code actually emits.
      for (const m of candidate.matchAll(/(?:^|\s)([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\??\s*:\s*\S/g)) {
        push(m[1], 'snake');
      }
    }
  }
  return out;
}

interface Finding {
  where: string;
  message: string;
}

function sweepIdentifierExistence(): Finding[] {
  const findings: Finding[] = [];
  for (const rel of TARGETS) {
    for (const tok of extractTokens(rel)) {
      if (NEGATED.test(tok.sentence)) continue; // denying a thing is not claiming it
      if (tok.kind === 'script') {
        if (!(tok.text in PKG.scripts)) {
          findings.push({
            where: `${rel}:${tok.line}`,
            message: `${rel}:${tok.line} tells a reader to run \`npm run ${tok.text}\`, which is not a package.json script.`,
          });
        }
        continue;
      }
      if (!existsInCode(tok.text, tok.kind)) {
        findings.push({
          where: `${rel}:${tok.line}`,
          message:
            `${rel}:${tok.line} names \`${tok.text}\`, which does not exist in src/ or scripts/ code, ` +
            `nor in cmos-seed/db/schema.sql, cmos-seed/tiers/, or any process.env read. A shipped ` +
            `document may not describe a thing the shipped code does not have.`,
        });
      }
    }
  }
  return findings;
}

// ─── Cross-document contradiction ────────────────────────────────────────────

/**
 * SECURITY.md is the DESIGNATED AUTHORITY, and the arm derives its claim set from that document
 * rather than from a table written here: every backticked token SECURITY.md explicitly denies
 * becomes a claim no other shipped document may assert positively. That is why the trio
 * (`deleted_at`, `CMOS_AUTO_SNAPSHOT`, `CMOS_SNAPSHOT_RETENTION_DAYS`) needs no seeding by hand —
 * SECURITY.md already denies all three, in the section it calls "the honest reality".
 */
function deniedBySecurityDoc(): Map<string, string> {
  const denied = new Map<string, string>();
  for (const unit of markdownUnits(fs.readFileSync(r('SECURITY.md'), 'utf8'))) {
    if (unit.inFence) continue;
    for (const m of unit.text.matchAll(/`([^`]+)`/g)) {
      const token = m[1].trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) continue;
      if (!/_/.test(token)) continue; // ENV or snake_case only; prose words are not claims
      // SENTENCE scope, not paragraph scope. A paragraph-scoped rule treats every backticked
      // token in any paragraph containing a negation as denied — measured at 144 findings, of
      // which 141 were tokens SECURITY.md merely mentions ("only when you set
      // `CMOS_DASHBOARD_URL`"). The denial has to be ABOUT the token to be a denial of it.
      const sentence = sentenceFor(unit.text, token);
      if (!NEGATED.test(sentence)) continue;
      if (!denialGoverns(sentence, token)) continue;
      denied.set(token, sentence);
    }
  }
  return denied;
}

function sweepContradictions(): Finding[] {
  const findings: Finding[] = [];
  const denied = deniedBySecurityDoc();
  for (const rel of TARGETS) {
    if (rel === 'SECURITY.md') continue;
    for (const unit of markdownUnits(fs.readFileSync(r(rel), 'utf8'))) {
      for (const [token, denial] of denied) {
        if (!new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(unit.text)) continue;
        const sentence = sentenceFor(unit.text, token);
        if (NEGATED.test(sentence)) continue; // this document denies it too — they agree
        findings.push({
          where: `${rel}:${unit.line}`,
          message:
            `${rel}:${unit.line} asserts \`${token}\`, which SECURITY.md — shipped in the SAME npm ` +
            `tarball — denies: "${denial.slice(0, 140).replace(/\s+/g, ' ')}…". One of the two is ` +
            `lying to every reader. SECURITY.md is the authority; move this document toward it.`,
        });
      }
    }
  }
  return findings;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('shipped-prose truth (s86-m05 Instrument 3)', () => {
  it('states its excluded set with the rule that excludes each one', () => {
    // A silent exclusion is this sprint's own defect class. Print, then assert the exclusions
    // are real scope statements rather than an allowlist smuggled in under another name.
    const printed = EXCLUSIONS.map((e) => `  EXCLUDED ${e.pathGlob}\n    reason: ${e.reason}`);
    // eslint-disable-next-line no-console
    console.log(
      `Instrument 3 target set:\n${TARGETS.map((t) => `  ${t}`).join('\n')}\n${printed.join('\n')}`
    );

    expect(EXCLUSIONS.every((e) => e.reason.length > 40)).toBe(true);
    // The exclusions are scope statements, never individual findings. Seed docs are targets for
    // identifier claims here and their eight date stamps are gated by the always-running arm.
    expect(TARGETS.some((t) => t.startsWith('cmos-seed/docs/'))).toBe(true);
    expect(TARGETS.some((t) => t.startsWith('cmos/planning/'))).toBe(false);
  });

  it('accounts for every shipped Markdown file under cmos-seed', () => {
    const shippedSeedMarkdown = walkFiles(r('cmos-seed'), '.md')
      .map((absolute) => toPackagePath(path.relative(REPO_ROOT, absolute)))
      .sort();
    expect(
      shippedSeedMarkdown.filter((rel) => !TARGETS.includes(rel) && !isExplicitlyExcluded(rel))
    ).toEqual([]);
  });

  it('reads every target document (the sweep must not be silently vacuous)', () => {
    for (const rel of TARGETS) expect(fs.existsSync(r(rel))).toBe(true);
    const total = TARGETS.reduce((n, rel) => n + extractTokens(rel).length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
  });

  it('handles the public mirror without either throwing or skipping silently', () => {
    // The mirror deletes agents.md and cmos/ but keeps tests/, so this file runs there too.
    // Partial absence is NOT a mirrored checkout — it is a moved or deleted file, and it fails.
    if (!inPublicMirror && presentPrivateTargets.length !== PRIVATE_TARGETS.length) {
      throw new Error(
        `Private targets are partially missing: present=[${presentPrivateTargets.join(', ')}], ` +
          `expected all of [${PRIVATE_TARGETS.join(', ')}]. In the public mirror ALL of them are ` +
          `absent together; a partial set means one was moved or deleted. Fix the path or update ` +
          `PRIVATE_TARGETS — do not let this gate quietly stop checking a document.`
      );
    }
    if (inPublicMirror) {
      // eslint-disable-next-line no-console
      console.log(
        `Public mirror detected — skipping ${PRIVATE_TARGETS.join(', ')} (deleted by ` +
          `scripts/mirror-to-public.sh PRIVATE_PATHS). Every other target is still swept.`
      );
    }
    // The public half is never skippable: those files ship in the tarball.
    for (const rel of PUBLIC_TARGETS) expect(fs.existsSync(r(rel))).toBe(true);
  });

  it('resolves tokens against CODE, not comments', () => {
    // The distinction that decides this gate: `deleted_at` appears twice in src/, both inside
    // JSDoc stating the column does not exist. A comment-blind corpus would resolve it.
    const raw = fs.readFileSync(r('src/tools/cmos/self-capture-guard.ts'), 'utf8');
    expect(raw).toContain('deleted_at');
    expect(codeTokens(r('src/tools/cmos/self-capture-guard.ts'))).not.toContain('deleted_at');
    // …and a real identifier still resolves.
    expect(existsInCode('sprint_id')).toBe(true);
  });

  it('does not resolve a token against its own test file (no self-referential corpus)', () => {
    // This file NAMES `deleted_at`, `CMOS_AUTO_SNAPSHOT` and `CMOS_SNAPSHOT_RETENTION_DAYS` as
    // examples of things that do not exist. An earlier revision put tests/ in the corpus
    // wholesale and those mentions made all three resolve — the gate's own documentation of a
    // defect is what silenced it. The corpus is src/ + scripts/ + schema + tiers; tests/
    // contributes process.env READS only.
    expect(existsInCode('deleted_at')).toBe(false);
    expect(existsInCode('CMOS_AUTO_SNAPSHOT', 'env')).toBe(false);
    expect(existsInCode('CMOS_SNAPSHOT_RETENTION_DAYS', 'env')).toBe(false);
    // …while an env var read only by a test helper is still real.
    expect(ENV_READS.has('CMOS_LIVE_PROJECT_ID')).toBe(true);
    expect(existsInCode('CMOS_LIVE_PROJECT_ID', 'env')).toBe(true);
  });

  it('treats a denial as a denial, not as a claim', () => {
    // SECURITY.md must stay able to name a vestigial variable in order to warn about it.
    expect(NEGATED.test('These variables are **vestigial — no code reads them.**')).toBe(true);
    expect(NEGATED.test('There is **no automatic snapshot** before destructive operations.')).toBe(
      true
    );
    expect(NEGATED.test('Snapshot retention (defaults shown)')).toBe(false);
  });

  it('requires the denial to GOVERN the token, not merely share a sentence with it', () => {
    // (a) negation immediately precedes the token
    expect(denialGoverns('There is **no `deleted_at` soft-delete net**.', 'deleted_at')).toBe(true);
    // (b) the token is the subject of a denial predicate
    expect(
      denialGoverns(
        'The environment variables `CMOS_AUTO_SNAPSHOT`, `DB_PATH` appear in older docs but are **vestigial**',
        'CMOS_AUTO_SNAPSHOT'
      )
    ).toBe(true);
    expect(
      denialGoverns(
        'the legacy `CMOS_DASHBOARD_SECRET` shared-secret is retired',
        'CMOS_DASHBOARD_SECRET'
      )
    ).toBe(true);
    // THE COUNTER-EXAMPLE, from SECURITY.md itself: the sentence denies ENCRYPTION, not `cmk_`.
    expect(
      denialGoverns(
        'The `cmk_` keys in that file are stored in plaintext — there is **no** encryption at rest',
        'cmk_'
      )
    ).toBe(false);
  });

  it('derives its denied-claim set from SECURITY.md', () => {
    const denied = deniedBySecurityDoc();
    // The trio the whole instrument was built around, derived rather than seeded by hand.
    expect([...denied.keys()]).toEqual(
      expect.arrayContaining(['deleted_at', 'CMOS_AUTO_SNAPSHOT', 'CMOS_SNAPSHOT_RETENTION_DAYS'])
    );
  });

  it('names nothing the shipped code does not have', () => {
    expect(sweepIdentifierExistence().map((f) => f.message)).toEqual([]);
  });

  it('asserts nothing another shipped document denies', () => {
    expect(sweepContradictions().map((f) => f.message)).toEqual([]);
  });
});

// ─── agents.md environment-variable read set, derived mechanically ───────────

/**
 * Every `CMOS_*` env var a tree actually READS, across FOUR access shapes. A deriver that
 * handles only the first two silently misses three real vars, so the shapes are enumerated:
 *
 *   (i)   `process.env.NAME` / `process.env['NAME']`
 *   (ii)  `process.env[CONST]` where CONST is a module-level string constant —
 *         CMOS_CONFIG_DIR_ENV, the four dashboard-client *_ENV constants, CMOS_PROJECT_ROOT_ENV,
 *         CMOS_PROJECT_ID_ENV, STALENESS_THRESHOLD_ENV, CMOS_CHECKPOINT_SYNC_ENV
 *   (iii) a member read on a `NodeJS.ProcessEnv`-typed PARAMETER that defaults to process.env —
 *         read-only-agent-guard.ts (`env[READ_ONLY_AGENT_ENV]` → CMOS_AGENT_ROLE),
 *         transformers-offline-env.ts (`env.CMOS_OFFLINE_EMBEDDINGS`,
 *         `processEnv.CMOS_MODEL_CACHE_DIR`)
 *   (iv)  a helper taking the name as a string literal — envFloat/envOptFloat/envOptInt in
 *         scripts/measure-retrieval-production.ts
 *
 * FALSE-NEGATIVE PROFILE: a name assembled at runtime (`process.env['CMOS_' + suffix]`), a name
 * reaching the process through a shell wrapper rather than a code read, and a constant defined
 * in one module and consumed in another are all invisible. None exists in the tree today.
 */
function deriveEnvReads(root: string): Set<string> {
  const out = new Set<string>();
  const files = walkFiles(r(root), '.ts');
  const constMap = new Map<string, string>();
  for (const f of files) {
    for (const m of fs
      .readFileSync(f, 'utf8')
      .matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"](CMOS_[A-Z0-9_]+)['"]/g)) {
      constMap.set(m[1], m[2]);
    }
  }
  for (const f of files) {
    const c = fs.readFileSync(f, 'utf8');
    for (const m of c.matchAll(/process\.env\.(CMOS_[A-Z0-9_]+)/g)) out.add(m[1]); // (i)
    for (const m of c.matchAll(/process\.env\[\s*['"](CMOS_[A-Z0-9_]+)['"]\s*\]/g)) out.add(m[1]);
    for (const m of c.matchAll(/process\.env\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
      const v = constMap.get(m[1]); // (ii)
      if (v) out.add(v);
    }
    for (const m of c.matchAll(/\b(?:env|processEnv)\.(CMOS_[A-Z0-9_]+)/g)) out.add(m[1]); // (iii)
    for (const m of c.matchAll(/\b(?:env|processEnv)\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
      const v = constMap.get(m[1]);
      if (v) out.add(v);
    }
    for (const m of c.matchAll(/\b(?:env|processEnv)\[\s*['"](CMOS_[A-Z0-9_]+)['"]\s*\]/g)) {
      out.add(m[1]);
    }
    for (const m of c.matchAll(/\benv[A-Za-z]*\(\s*['"](CMOS_[A-Z0-9_]+)['"]/g)) out.add(m[1]); // (iv)
  }
  return out;
}

/** The CMOS_* names agents.md lists, split by which subsection they appear under. */
function agentsMdEnvSections(): { server: string[]; scripts: string[] } {
  const content = fs.readFileSync(r('agents.md'), 'utf8');
  // Read the FENCED BLOCK under the heading, not the whole section. Prose around the block
  // legitimately mentions other variables (the note that CMOS_PROJECT_ROOT is optional), and
  // counting those would make the assertion depend on the surrounding wording rather than on
  // the list itself.
  const grab = (heading: RegExp): string[] => {
    const start = content.search(heading);
    if (start === -1) return [];
    const rest = content.slice(start);
    const open = rest.indexOf('```');
    if (open === -1) return [];
    const close = rest.indexOf('```', open + 3);
    const fence = rest.slice(open, close === -1 ? undefined : close);
    return [...new Set([...fence.matchAll(/\b(CMOS_[A-Z0-9_]+)\b/g)].map((m) => m[1]))];
  };
  return {
    server: grab(/^###\s+`CMOS_\*` names read by the shipped server/m),
    scripts: grab(/^###\s+Read only by repo scripts/m),
  };
}

/**
 * PRIVATE-REPO ONLY. These blocks read agents.md and cmos/docs/build-session-prompt.md, both of
 * which scripts/mirror-to-public.sh deletes while still mirroring tests/. `describe.skip` in the
 * mirror is a SCOPE statement, not a silent pass: the block above fails loudly if the private
 * targets are only PARTIALLY missing, and prints what it skipped when they are all absent.
 */
const describePrivate = inPublicMirror ? describe.skip : describe;

describePrivate('agents.md environment-variable block is derived, not maintained (s86-m05)', () => {
  const srcReads = deriveEnvReads('src');
  const scriptReads = deriveEnvReads('scripts');
  const scriptsOnly = [...scriptReads].filter((n) => !srcReads.has(n));

  it('recovers the three shape-(iii) vars a two-shape deriver misses', () => {
    // The fixture the build plan requires: without shape (iii) these three vanish silently, and
    // the documented list would be quietly short by three with nothing to notice it.
    for (const name of ['CMOS_AGENT_ROLE', 'CMOS_OFFLINE_EMBEDDINGS', 'CMOS_MODEL_CACHE_DIR']) {
      expect([...srcReads]).toContain(name);
    }
  });

  it('recovers the shape-(ii) constant-indirection vars', () => {
    for (const name of [
      'CMOS_CONFIG_DIR',
      'CMOS_PROJECT_ID',
      'CMOS_DASHBOARD_USER',
      'CMOS_DASHBOARD_PASSWORD',
      'CMOS_STALENESS_THRESHOLD_SPRINTS',
      'CMOS_CHECKPOINT_SYNC',
    ]) {
      expect([...srcReads]).toContain(name);
    }
  });

  it('recovers the shape-(iv) helper-literal vars from scripts/', () => {
    for (const name of ['CMOS_RECENCY_OVERRIDE', 'CMOS_RRFK_OVERRIDE', 'CMOS_GRAPH_WEIGHT']) {
      expect(scriptsOnly).toContain(name);
    }
  });

  it('documents exactly the server-read set, no more and no less', () => {
    // MEASURED DELTA against the build plan, recorded per its standing instruction: the plan
    // states 16 server-read names. The deriver finds 17 — the plan's enumeration omitted
    // CMOS_CHECKPOINT_SYNC, a genuine shape-(ii) read at checkpoint-backfill.ts:348
    // (`process.env[CMOS_CHECKPOINT_SYNC_ENV]`, constant declared :64). 17 is the measured
    // number and the one the document carries.
    expect(srcReads.size).toBe(17);
    expect(agentsMdEnvSections().server.sort()).toEqual([...srcReads].sort());
  });

  it('documents exactly the scripts-only read set', () => {
    expect(scriptsOnly.length).toBe(11);
    expect(agentsMdEnvSections().scripts.sort()).toEqual([...scriptsOnly].sort());
  });

  it('no longer documents a variable nothing reads', () => {
    for (const dead of ['CMOS_AUTO_SNAPSHOT', 'CMOS_SNAPSHOT_RETENTION_DAYS']) {
      expect(srcReads.has(dead)).toBe(false);
      expect(scriptReads.has(dead)).toBe(false);
      expect(agentsMdEnvSections().server).not.toContain(dead);
      expect(agentsMdEnvSections().scripts).not.toContain(dead);
    }
  });
});

// ─── Stamps, citations and the build-session-prompt reconcile ────────────────

describe('shipped-document stamps and citations (s86-m05)', () => {
  it('cites a CHANGELOG section that exists and is non-empty', () => {
    // SECURITY.md cited "the `[Unreleased] → Removed` entry"; [Unreleased] is empty and the
    // HTTP-transport removal lives under 2.0.0. A citation into an empty section is a claim
    // that evidence exists where it does not.
    const security = fs.readFileSync(r('SECURITY.md'), 'utf8');
    const changelog = fs.readFileSync(r('CHANGELOG.md'), 'utf8');

    const cite = security.match(/the `\[?([^`\]]+)\]?\s*→\s*([A-Za-z]+)` entry/);
    expect(cite).not.toBeNull();
    const [, section, subsection] = cite as RegExpMatchArray;

    // The cited release heading must exist…
    const headingRe = new RegExp(
      `^##\\s*\\[?${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?.*$`,
      'm'
    );
    const headingMatch = changelog.match(headingRe);
    expect(headingMatch).not.toBeNull();

    // …and the cited subsection under it must carry at least one bullet.
    const after = changelog.slice((headingMatch as RegExpMatchArray).index ?? 0);
    const body = after.slice(
      0,
      after.indexOf('\n## ', 1) === -1 ? undefined : after.indexOf('\n## ', 1)
    );
    const sub = body.match(new RegExp(`^###\\s*${subsection}\\s*$([\\s\\S]*?)(?=^###|\\z)`, 'm'));
    expect(sub).not.toBeNull();
    expect(
      (sub as RegExpMatchArray)[1]
        .trim()
        .split('\n')
        .filter((l) => l.trim().startsWith('-')).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('stamps SECURITY.md against a sprint at least as new as the ones it documents', () => {
    const security = fs.readFileSync(r('SECURITY.md'), 'utf8');
    const footer = security.match(/_Last verified against the source: Sprint (\d+)/);
    expect(footer).not.toBeNull();
    const verified = Number((footer as RegExpMatchArray)[1]);

    // The highest sprint the BODY cites. A footer older than the newest thing documented tells
    // a reader the document was checked before content that is in it was written.
    const cited = [...security.matchAll(/\bs(\d{2,})-m\d+\b/g)].map((m) => Number(m[1]));
    expect(cited.length).toBeGreaterThan(0);
    expect(verified).toBeGreaterThanOrEqual(Math.max(...cited));
  });

  (inPublicMirror ? it.skip : it)(
    'stamps agents.md and build-session-prompt.md at the package version',
    () => {
      const agents = fs.readFileSync(r('agents.md'), 'utf8');
      const prompt = fs.readFileSync(r('cmos/docs/build-session-prompt.md'), 'utf8');

      const agentsVersion = agents.match(/\*\*Version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/);
      expect(agentsVersion?.[1]).toBe(PKG.version);

      // build-session-prompt.md's stamp is written as a minor line ("CMOS Version: 2.2"), so it is
      // asserted as a version PREFIX rather than an exact string.
      const promptVersion = prompt.match(/\*\*CMOS Version\*\*:\s*([0-9]+\.[0-9]+)/);
      expect(promptVersion).not.toBeNull();
      expect(PKG.version.startsWith(`${promptVersion?.[1]}.`)).toBe(true);
    }
  );

  (inPublicMirror ? it.skip : it)(
    'stamps Last Updated no earlier than the release whose content the file documents',
    () => {
      // WHAT THIS ASSERTS, stated plainly because an earlier revision's NAME promised more than
      // its body delivered: it claimed "not older than the newest sprint the file documents" and
      // then only checked that the date parsed and was not in the future — a bar a 2020 stamp
      // clears. Naming a check you do not perform is this mission's own defect class, in the
      // file that exists to close it.
      //
      // Sprint→date is not available here without the DB, so the ORACLE is CHANGELOG.md: the
      // date of the newest released version. Both files document the surface as of the current
      // release, so a stamp predating that release is stale by construction. Derived from repo
      // content, no hardcoded date, and it fails for the reason its name gives.
      const changelog = fs.readFileSync(r('CHANGELOG.md'), 'utf8');
      const release = changelog.match(/^##\s*\[?(\d+\.\d+\.\d+)\]?\s*[—-]\s*(\d{4}-\d{2}-\d{2})/m);
      expect(release).not.toBeNull();
      const releaseDate = new Date((release as RegExpMatchArray)[2]).getTime();
      expect(Number.isNaN(releaseDate)).toBe(false);

      for (const rel of PRIVATE_TARGETS) {
        const content = fs.readFileSync(r(rel), 'utf8');
        const stamp = content.match(/\*\*Last Updated\*\*:\s*(\d{4}-\d{2}-\d{2})/);
        expect(stamp).not.toBeNull();
        const stamped = new Date((stamp as RegExpMatchArray)[1]).getTime();
        expect(Number.isNaN(stamped)).toBe(false);

        // The real assertion: not older than the newest release.
        if (stamped < releaseDate) {
          throw new Error(
            `${rel} is stamped "**Last Updated**: ${(stamp as RegExpMatchArray)[1]}", which is ` +
              `EARLIER than the newest release in CHANGELOG.md ` +
              `(${(release as RegExpMatchArray)[1]} — ${(release as RegExpMatchArray)[2]}). ` +
              `The file documents the current surface, so its stamp cannot predate that release.`
          );
        }
        // …and not in the future.
        expect(stamped).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
      }
    }
  );
});

describePrivate('build-session-prompt ↔ agents.md process-hardening parity (s86-m05, #500)', () => {
  const promptPath = r('cmos/docs/build-session-prompt.md');

  /**
   * The Process Hardening section of one document, as its numbered practice titles.
   *
   * SECTION-SCOPED, and the scoping is the whole test. An earlier revision matched a
   * numbered-bold-heading pattern across each WHOLE file and asserted only "at least 6" on each
   * side. It passed — for entirely the wrong reason: it found 22 headings in agents.md (five
   * unrelated numbered lists — project-resolution priority, the known-accepted consequences, the
   * AI-agent instructions) and 6 in build-session-prompt.md that were the FIXTURE-CHECKLIST
   * items, not the practices. It never compared the two lists, and could not have failed if the
   * prompt had dropped a practice. Rule 9: a test that cannot fail when the logic changes is wrong.
   *
   * The two files write the same list differently — agents.md puts the number outside the bold
   * span, build-session-prompt.md puts it inside — so both shapes are accepted, but ONLY within
   * the Process Hardening section of each file.
   */
  const processHardeningPractices = (content: string): string[] => {
    const start = content.search(/^#{2,3}\s+Process Hardening/m);
    if (start === -1) return [];
    // Slice past the whole heading LINE. Advancing by one character leaves `## …` behind when
    // the heading was `### …`, which matches the section-END pattern at offset 0 and yields an
    // empty section — silently, and the parity assertion would then compare [] to [].
    const afterHeading = content.indexOf('\n', start);
    const rest = content.slice(afterHeading === -1 ? start : afterHeading + 1);
    const end = rest.search(/^#{2,3}\s/m);
    const section = end === -1 ? rest : rest.slice(0, end);
    // Two shapes exist and each document uses ONE of them for its practices:
    //   OUTSIDE — `1. **Title** — …`   (agents.md's practices, and the prompt's nested
    //                                   6-path fixture checklist)
    //   INSIDE  — `**1. Title — …**`   (the prompt's practices)
    // Matching both shapes in both files double-counts the prompt: it returns 13, the seven
    // practices PLUS the six checklist items nested inside practice 4. Which shape a file uses
    // is decided by its FIRST numbered item in the section — practice 1 — so the shape is read
    // off the document rather than assumed per-file.
    const OUTSIDE = /^(\d)\.\s+\*\*([^*]+?)\*\*/gm;
    const INSIDE = /^\*\*(\d)\.\s+([^*—]+?)(?:\s+—|\*\*)/gm;
    const firstOutside = section.search(/^\d\.\s+\*\*/m);
    const firstInside = section.search(/^\*\*\d\.\s+/m);
    const usesInside = firstInside !== -1 && (firstOutside === -1 || firstInside < firstOutside);
    const pattern = usesInside ? INSIDE : OUTSIDE;
    return [...section.matchAll(pattern)].map((m) => `${m[1]}. ${m[2].trim()}`);
  };

  it('carries seven numbered practices, at parity with agents.md', () => {
    // agents.md says "Full text + evidence lives in build-session-prompt.md" — so the cited
    // authority must not be the weaker of the two documents.
    const agentsPractices = processHardeningPractices(fs.readFileSync(r('agents.md'), 'utf8'));
    const promptPractices = processHardeningPractices(fs.readFileSync(promptPath, 'utf8'));

    // Premise check: the extractor found a Process Hardening section in BOTH files. Without
    // this, two empty lists would compare equal and the parity assertion would be vacuous.
    expect(agentsPractices.length).toBe(7);
    expect(promptPractices.length).toBe(7);

    // Same practices, same order — compared by NUMBER and by the leading words of the title,
    // so a reworded title does not fail but a DROPPED or REORDERED practice does.
    const key = (s: string): string =>
      s.toLowerCase().replace(/[`_*]/g, '').split(/\s+/).slice(0, 3).join(' ');
    expect(promptPractices.map(key)).toEqual(agentsPractices.map(key));
  });

  it('carries the 6-path checklist, the positive-fire clause and the no-silent-fail-open rule', () => {
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toMatch(/6-path/);
    expect(prompt).toMatch(/POSITIVE FIRE|positive-fire/i);
    expect(prompt).toMatch(/silent fail-open/i);
  });

  it('describes the adversarial critic as blocking at BOTH plan-time and build-time', () => {
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toMatch(/plan-time/i);
    expect(prompt).toMatch(/build-time/i);
    expect(prompt).toMatch(/blocking/i);
  });

  it("says '5-path' in neither file", () => {
    expect(fs.readFileSync(promptPath, 'utf8')).not.toMatch(/5-path/);
    expect(fs.readFileSync(r('agents.md'), 'utf8')).not.toMatch(/5-path/);
  });

  it('points See-Also at a document that exists', () => {
    // cmos/docs/mcp-reference.md never existed; the generated tool documentation is
    // TOOL_REFERENCE.md.
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).not.toMatch(/mcp-reference\.md/);
  });

  it('leaves the cmos-seed copy untouched (it has no Process Hardening section at all)', () => {
    // REFUTED at plan time and re-verified here: "syncing" the two would import ~370 lines of
    // CMOS-internal sprint methodology into every consumer project.
    const seed = fs.readFileSync(r('cmos-seed/docs/build-session-prompt.md'), 'utf8');
    expect(seed).not.toMatch(/Process Hardening/);
    expect(seed).not.toMatch(/6-path/);
    expect(seed).not.toMatch(/5-path/);
  });
});

/**
 * s87-m04 + s88-m03 + s88-m07 — ARC F ITEM 3, ALL BOLD SHIPPED SEED-MARKDOWN STAMPS.
 *
 * #1009's enumeration named the seed's stale stamps as an Arc F item. The schema-version and tool-
 * count claims are checkable against something the tarball itself ships. s88-m03 performed the
 * required per-file review and corrected all eight bold **Last Updated** stamps in shipped seed
 * Markdown. s88-m07 replaces its release-date proxy with the body-change oracle: git is available
 * at TEST time, so a stamp must be at least as recent as the file's latest non-stamp body change.
 * Stamp-only edits are ignored. A real temporary npm tarball supplies the files and stamp bytes.
 * The oracle follows committed renames, compares merge diffs per parent, and treats a tracked
 * working-tree body edit as a change today. It fails loudly when a file is untracked, history is
 * shallow/unavailable, or a file's lineage combines a committed rename with a merge — git --follow
 * cannot prove per-parent paths for that bounded composition, so it is never allowed to silently
 * green. It runs in both source repositories;
 * a public-mirror transport commit therefore counts at that repository's committer date. This is a
 * necessary freshness relation, not proof that a human reviewed the prose: a dishonest stamp-only
 * bump remains outside what git can establish. Lowercase prose-like source-code comments are
 * outside this deliberately bold-Markdown contract, and date-only stamps cannot distinguish two
 * body edits made on the same calendar day.
 *
 * ALWAYS-RUNNING, NEVER `inPublicMirror`-GATED, AND THAT IS THE TRAP THIS AVOIDS. The existing
 * **Last Updated** arm below is declared `(inPublicMirror ? it.skip : it)` and loops
 * `PRIVATE_TARGETS`, which is correct for documents the mirror deletes. `cmos-seed/**` is NOT in
 * `mirror-to-public.sh`'s PRIVATE_PATHS — it ships to the public repo — so appending these files
 * to that arm would have left the public stamps unchecked in the one repo an external consumer
 * reads. Separate `it`, no skip, no PRIVATE_TARGETS entry.
 */
describe('the seed ships stamps that describe the seed (s87-m04 + s88-m03 + s88-m07)', () => {
  /** The schema version the SHIPPED seed actually seeds. Read from the generated file, not typed. */
  function seededSchemaVersion(): string {
    const sql = fs.readFileSync(r('cmos-seed/db/schema.sql'), 'utf8');
    const m = sql.match(
      /INSERT OR IGNORE INTO metadata \(key, value\) VALUES \('schema_version', '([^']+)'\)/
    );
    if (!m) throw new Error('cmos-seed/db/schema.sql seeds no schema_version — the oracle is gone');
    return m[1];
  }

  function stampsIn(rel: string, label: string): Array<{ rel: string; value: string }> {
    return stampsInContent(rel, label, fs.readFileSync(r(rel), 'utf8'));
  }

  function stampsInContent(
    rel: string,
    label: string,
    content: string
  ): Array<{ rel: string; value: string }> {
    const re = new RegExp(`\\*\\*${label}\\*\\*:\\s*([^\\n]+)`, 'g');
    const out: Array<{ rel: string; value: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push({ rel, value: m[1].trim() });
    return out;
  }

  /** Every Markdown file under package.json's shipped `cmos-seed` directory entry. */
  const SEED_MD = walkFiles(r('cmos-seed'), '.md')
    .map((absolute) => toPackagePath(path.relative(REPO_ROOT, absolute)))
    .sort();

  const PACKED = inspectNpmPack(REPO_ROOT);

  const shipsInPackage = (rel: string): boolean => PACKED.files.has(rel);

  it('records that the old private-only Last Updated arm covered zero tarball stamps', () => {
    // Anti-vacuity on both sides: the old arm named exactly two paths, and neither appears in the
    // real npm tarball. In this private source tree both paths carry a stamp; the public mirror
    // deliberately lacks both files, so opening them there would recreate the scope bug.
    expect(PRIVATE_TARGETS).toHaveLength(2);
    expect(PRIVATE_TARGETS.filter(shipsInPackage)).toEqual([]);
    if (!inPublicMirror) {
      expect(PRIVATE_TARGETS.flatMap((rel) => stampsIn(rel, 'Last Updated'))).toHaveLength(2);
    }
  });

  it('checks the eight bold Last Updated stamps in actual packed seed Markdown', () => {
    const stamps = [...PACKED.seedMarkdown].flatMap(([rel, content]) =>
      stampsInContent(rel, 'Last Updated', content)
    );
    const expectedStampPaths = [
      'cmos-seed/README.md',
      'cmos-seed/docs/README.md',
      'cmos-seed/docs/agents-md-guide.md',
      'cmos-seed/docs/build-session-prompt.md',
      'cmos-seed/docs/getting-started.md',
      'cmos-seed/docs/session-management-guide.md',
      'cmos-seed/docs/sqlite-schema-reference.md',
      'cmos-seed/templates/agents.md',
    ].sort();

    // The count is a regression floor, not prose: six docs + the seed README + templates/agents.md.
    // Both template files are also ordinary identifier/contradiction targets even though only one
    // currently carries a date stamp.
    expect(stamps).toHaveLength(8);
    expect(stamps.map((stamp) => stamp.rel).sort()).toEqual(expectedStampPaths);
    expect([...PACKED.seedMarkdown.keys()].sort()).toEqual(SEED_MD);
    expect(stamps.every((stamp) => shipsInPackage(stamp.rel))).toBe(true);
    expect(SEED_TEMPLATE_TARGETS).toHaveLength(2);
    expect(SEED_TEMPLATE_TARGETS.every((rel) => TARGETS.includes(rel))).toBe(true);
    expect(SEED_TEMPLATE_TARGETS.every(shipsInPackage)).toBe(true);

    const malformed = stamps
      .filter((stamp) => !/^\d{4}-\d{2}-\d{2}$/.test(stamp.value))
      .map((stamp) => `${stamp.rel} has malformed Last Updated value "${stamp.value}"`);
    expect(malformed).toEqual([]);

    const stale = lastUpdatedBodyChangeFindings(REPO_ROOT, stamps);
    expect(stale).toEqual([]);

    const future = stamps
      .filter((stamp) => new Date(stamp.value).getTime() > Date.now() + 24 * 60 * 60 * 1000)
      .map((stamp) => `${stamp.rel} has future Last Updated value "${stamp.value}"`);
    expect(future).toEqual([]);
  });

  it('every **Schema Version** stamp in the shipped seed names the version the seed seeds', () => {
    const expected = seededSchemaVersion();
    // Non-vacuity: if nobody stamps a schema version, this arm has nothing to protect and should
    // say so rather than pass. RED baseline at HEAD 1a54a79: THREE stamps read "2.0" against a
    // seed that seeds "2.1" — cmos-seed/README.md, docs/README.md, docs/getting-started.md.
    const stamps = SEED_MD.flatMap((rel) => stampsIn(rel, 'Schema Version'));
    expect(stamps.length).toBeGreaterThanOrEqual(3);

    const wrong = stamps
      .filter((st) => !st.value.startsWith(expected))
      .map((st) => `${st.rel} stamps "Schema Version: ${st.value}" but the seed seeds ${expected}`);
    expect(wrong).toEqual([]);
  });

  it('the **Tool Count** stamp equals the number of tools actually registered', () => {
    // GREEN AT BASELINE (15 = 15), and it ships as a REGRESSION FLOOR: it fires the moment a
    // sixteenth tool registers and nobody updates the seed's front page. That is the only thing
    // that makes it a gate rather than a decoration — and it is the one stamp in the set that was
    // already a working claim, which #539's coordinate range omitted.
    const stamps = SEED_MD.flatMap((rel) => stampsIn(rel, 'Tool Count'));
    expect(stamps.length).toBeGreaterThanOrEqual(1);

    const wrong = stamps
      .filter((st) => !st.value.startsWith(String(CMOS_TOOL_DEFINITIONS.length)))
      .map(
        (st) =>
          `${st.rel} stamps "Tool Count: ${st.value}" but ${CMOS_TOOL_DEFINITIONS.length} tools ` +
          `are registered`
      );
    expect(wrong).toEqual([]);
  });

  it('this arm is not gated on the public mirror, and the seed is not a PRIVATE_TARGET', () => {
    // The trap, asserted rather than intended. cmos-seed/** ships to the public repo, so gating
    // these checks on `inPublicMirror` would leave the public copies unchecked.
    expect(PRIVATE_TARGETS).toHaveLength(2);
    expect(PRIVATE_TARGETS.some((t) => t.startsWith('cmos-seed'))).toBe(false);
    for (const rel of SEED_MD) expect(fs.existsSync(r(rel))).toBe(true);
  });
});
