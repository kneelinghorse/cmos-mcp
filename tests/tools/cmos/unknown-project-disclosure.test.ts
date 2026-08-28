// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s87-m04 — a store with no recorded identity must SAY SO, per store, naming the store.
// ABOUTME: The label stops naming a project that does not exist; the untrusted fence is unchanged.

/**
 * Sprint 87 m04 — WHAT THIS MISSION SUBTRACTS, AND WHAT IT DOES NOT.
 *
 * `getProjectId` falls back to the literal `'unknown-project'` when a store records no identity.
 * Ruling #736 approved that fallback over throwing, on the premise that "every real store carries
 * a non-empty project_id, so the fallback never fires in production". MEASURED 2026-08-27,
 * read-only, with its command:
 *
 *     find ~ -maxdepth 7 -path '*&#47;cmos/db/cmos.sqlite' -not -path '*&#47;node_modules/*'
 *
 * → 45 stores; 33 resolve via a recorded `project_id`; 12 collapse to the literal; 1
 * (`semantic-contract`) cannot be classified read-only at all. The fallback fires on twelve, and
 * has already fired in production: `derekn.com`'s store carries 217 rows stamped with the literal
 * across six tables.
 *
 * THE RULING SURVIVES; ONLY THE PREMISE IS AMENDED (#1017 / D-8). Three things were actually
 * wrong, and this file gates all three:
 *
 *   1. UNDER-DISCLOSED — `warnedMissingProjectId` was a MODULE-LEVEL boolean, so N identity-less
 *      stores in one process produced ONE stderr line, naming no path. An operator could not tell
 *      which store, or how many.
 *   2. MISNAMED AT THE POINT OF USE — the render emitted `proj:unknown-project`, naming a project
 *      that does not exist, on the PROMPT-INJECTION DEFENCE surface. Nine of `derekn.com`'s
 *      fourteen own sessions render that way, which trains an agent to discount the fence.
 *   3. MANUFACTURED BY THE TARBALL — `schema.ts` seeded three empty-string identity rows, and
 *      `cmos-seed/db/schema.sql` is GENERATED from it, so every published store shipped rows that
 *      satisfy NOT NULL while being semantically absent.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MISSION DOES NOT DO, asserted rather than promised (CUT 7). IT SHIPS NO IDENTITY
 * WRITE — no mint, no heal, no repair. The fleet is not healed. This store is not identified. A
 * store created from the CORRECTED seed still resolves to the literal, and `resolves to the
 * literal after the seed fix` asserts exactly that: if this suite ever goes green by a store
 * resolving to something else, an identity write shipped and CUT 7 was violated.
 *
 * WHY THE WRITE WAS CUT, so it is not re-proposed: routing `getProjectId` to `mintProjectId`
 * DEADLOCKS. `mintProjectId` opens a SECOND read-write connection, and `getProjectId` is reached
 * from inside the sprint closeout's own `BEGIN IMMEDIATE`; a verbatim replay with the lock held
 * gave `elapsed_ms=5203`, `SQLITE_BUSY`, nothing minted, swallowed — twice per close. It also
 * converts `cmos_context(view)`, a READ in the fail-closed taxonomy, into a write to any store an
 * agent can name.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * EVERY REAL-CLIENT CONSTRUCTION BELOW PASSES AN EXPLICIT `dbPath`, AND THAT IS NOT STYLE (D-9).
 * `client.ts`'s no-explicit-root arm calls `resolveProjectRootEnhanced(undefined, {autoRegister:
 * true})`, which reaches `graph.registerStore(cwd)` → `mintProjectId`, which WRITES to
 * `~/.config/cmos-mcp/project-graph.sqlite`. A test that constructed the client without a dbPath
 * would mint a registry row and fail this mission's own no-write gate for a reason having nothing
 * to do with the code under test.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CmosDatabaseClient } from '../../../src/tools/cmos/client';
import { getProjectId } from '../../../src/tools/cmos/genesis-columns';
import {
  frameInlineIfForeign,
  provenanceTag,
  UNRECORDED_PROJECT_ID,
} from '../../../src/intelligence/provenance-frame';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SEED_SCHEMA = path.join(REPO_ROOT, 'cmos-seed', 'db', 'schema.sql');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');
const REGISTRY = path.join(os.homedir(), '.config', 'cmos-mcp', 'project-graph.sqlite');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A store with a metadata table and NO recorded identity. */
function identitylessStore(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cmos-s87m04-${label}-`));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, 'cmos.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT);
  `);
  db.close();
  return dbPath;
}

/** Capture everything written to stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    (process.stderr as NodeJS.WriteStream).write = original;
  }
  return chunks.join('');
}

describe('s87-m04 — an unrecorded identity is disclosed per store, and named honestly', () => {
  it('RED (a): THREE identity-less stores in ONE process yield THREE disclosures, each naming its own store', async () => {
    const paths = ['alpha', 'bravo', 'charlie'].map((l) => identitylessStore(l));

    const stderr = await (async () => {
      let captured = '';
      const clients: CmosDatabaseClient[] = [];
      try {
        for (const dbPath of paths) {
          // EXPLICIT dbPath — see the header. Without it this line mints a registry row.
          const created = await CmosDatabaseClient.create({ dbPath });
          expect(created.success).toBe(true);
          clients.push(created.data!);
        }
        captured = captureStderr(() => {
          for (const c of clients) expect(getProjectId(c)).toBe(UNRECORDED_PROJECT_ID);
        });
      } finally {
        for (const c of clients) c.close();
      }
      return captured;
    })();

    // RED: one line, containing no path. The flag was module-level, so store two and three were
    // silent — and the single line an operator did get named only the fallback VALUE.
    for (const dbPath of paths) {
      expect(stderr).toContain(dbPath);
    }
    const disclosures = stderr
      .split('\n')
      .filter((l) => l.includes('NO RECORDED project identity'));
    expect(disclosures).toHaveLength(3);

    // …and it says the identity is UNRECORDED rather than implying a project by that name.
    expect(stderr).toContain('NO RECORDED project identity');
    expect(stderr).toMatch(/fallback label and not a project/i);
  }, 60_000);

  it('discloses ONCE per store, not once per row — the de-duplication survives', async () => {
    const dbPath = identitylessStore('repeat');
    const created = await CmosDatabaseClient.create({ dbPath });
    const client = created.data!;
    try {
      const stderr = captureStderr(() => {
        for (let i = 0; i < 5; i += 1) getProjectId(client);
      });
      expect(
        stderr.split('\n').filter((l) => l.includes('NO RECORDED project identity'))
      ).toHaveLength(1);
    } finally {
      client.close();
    }
  }, 60_000);

  it('RED (b): the NORMALIZED docblock scan finds the falsified premise ZERO times', () => {
    // A plain single-line grep returns 0 even BEFORE the fix and would pass vacuously — the
    // phrase wraps across comment lines. Normalize the ` * ` continuations first, exactly as the
    // criterion specifies. RED at HEAD 1a54a79: 1 hit in each file.
    const PREMISE = /never\s+fires\s+in\s+production|always\s+carry\s+a\s+non-empty\s+project_id/g;
    for (const rel of [
      'src/tools/cmos/genesis-columns.ts',
      'src/tools/cmos/schema-migrations.ts',
    ]) {
      const normalized = fs
        .readFileSync(path.join(REPO_ROOT, rel), 'utf8')
        .replace(/\n\s*\*\s*/g, ' ');
      expect({ rel, hits: normalized.match(PREMISE) ?? [] }).toEqual({ rel, hits: [] });
    }

    // ANTI-VACUITY: the scanner must be able to see the phrase when it IS present. Without this
    // a broken normalizer would report zero for the wrong reason.
    const planted = 'so the fallback\n * never fires in production.'.replace(/\n\s*\*\s*/g, ' ');
    expect(planted.match(PREMISE)).toHaveLength(1);
  });

  it('RED (c): a store carrying the literal renders UNATTRIBUTED — and is STILL fenced', () => {
    // BOTH halves, and the second is the load-bearing one. De-fencing on the literal would
    // de-fence genuinely FOREIGN content: a pull-merged row from any of the twelve collapsing
    // stores also carries it. The standing bias is stated twice in this codebase —
    // "fence-more, never fence-less".
    const rendered = frameInlineIfForeign(
      'a row from a store with no identity',
      UNRECORDED_PROJECT_ID,
      'cmos-mcp-pro'
    );

    expect(rendered).not.toContain(`proj:${UNRECORDED_PROJECT_ID}`);
    expect(rendered).toContain('unattributed');
    // THE FENCE IS UNCHANGED.
    expect(rendered).not.toBe('a row from a store with no identity');
    expect(rendered).toMatch(/untrusted/i);

    // A genuinely foreign row from a NAMED project still names it — the change is scoped to the
    // one value that names nothing.
    const named = frameInlineIfForeign('a row', 'shopify-forge', 'cmos-mcp-pro');
    expect(named).toContain('proj:shopify-forge');
    expect(provenanceTag('shopify-forge')).toBe('proj:shopify-forge');
    expect(provenanceTag(UNRECORDED_PROJECT_ID)).toBe('unattributed');
  });

  it('RED (d): the SHIPPED seed carries no empty-string identity row', () => {
    // Reads the GENERATED file, so it guards the tarball rather than a hand-patch — and it fails
    // if the regeneration was skipped. RED at HEAD 1a54a79: three rows at :19-21.
    const sql = fs.readFileSync(SEED_SCHEMA, 'utf8');
    for (const key of ['project_id', 'project_name', 'tracelab_project_id']) {
      expect({
        key,
        seeded: new RegExp(
          `INSERT OR IGNORE INTO metadata \\(key, value\\) VALUES \\('${key}', ''\\)`
        ).test(sql),
      }).toEqual({ key, seeded: false });
    }
    // Non-vacuity: the file must still seed the rows it SHOULD.
    expect(sql).toContain("VALUES ('schema_version'");
    expect(sql).toContain("VALUES ('created_at'");
  });

  it('THE ANTI-SYMPTOM GATE: a store from the corrected seed STILL resolves to the literal', async () => {
    // This is what proves the seed fix removed a FALSE CLAIM rather than silently changing
    // resolution. If this ever goes green by resolving to something else, an identity write
    // shipped and CUT 7 was violated.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s87m04-seeded-'));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'cmos.sqlite');
    const db = new Database(dbPath);
    try {
      db.exec(fs.readFileSync(SEED_SCHEMA, 'utf8'));
    } finally {
      db.close();
    }

    const created = await CmosDatabaseClient.create({ dbPath });
    const client = created.data!;
    try {
      const stderr = captureStderr(() => {
        expect(getProjectId(client)).toBe(UNRECORDED_PROJECT_ID);
      });
      // …and it discloses exactly once, naming the store.
      expect(
        stderr.split('\n').filter((l) => l.includes('NO RECORDED project identity'))
      ).toHaveLength(1);
      expect(stderr).toContain(dbPath);
    } finally {
      client.close();
    }
  }, 60_000);

  /**
   * THE CUT-7 GATE, stated as a NO-WRITE rule rather than a directory rule.
   *
   * An earlier form of this criterion asserted the mission's diff touches no file under
   * `src/intelligence/` — which the mission's own NON-CUTTABLE step makes impossible, since the
   * two shared tag constructors live in `src/intelligence/provenance-frame.ts`. A criterion that
   * fails deterministically when its mission succeeds is the same defect class as one that cannot
   * fail. Both plan-time critic lenses found that independently.
   */
  describe('CUT 7 — this mission ships NO identity write, asserted mechanically', () => {
    /**
     * The diff attributable to THIS MISSION, pinned to its own commit range.
     *
     * s87-m04, CORRECTED DURING s87-m07. This originally read `git diff HEAD`, i.e. the whole
     * uncommitted working tree. That was right for exactly as long as m04 was the mission being
     * built, and wrong from the moment m07 started editing `src/intelligence/credential-store.ts`
     * — at which point this gate reported that m04 had touched a file m04 never opened. A
     * criterion that says "the diff attributable to THIS mission" and measures "everything
     * uncommitted" is a surface asserting something that is not so, which is the class the
     * mission it guards exists to close.
     *
     * Pinned to m04's own commits. If m04 is ever amended or rebased these SHAs move with it,
     * and the range — not the working tree — is what the criterion has always meant.
     */
    const M04_RANGE_START = '1a54a79'; // s87-m03's commit
    const M04_RANGE_END = '564a2a6'; // s87-m04's commit

    /**
     * s87-m08 — RESOLVE THE RANGE BEFORE DIFFING IT, so an environment that cannot see m04's
     * commits says so instead of dying on git's "unknown revision" prose.
     *
     * This gate first ran red in CI, not locally: `actions/checkout` clones at depth 1, so
     * neither SHA existed and the failure named a file and a line but not the cause. The
     * workflows now set `fetch-depth: 0`. The check stays a FAILURE rather than a skip — a gate
     * that quietly passes when it cannot observe its subject is the defect this sprint is about,
     * and a skipped gate reports green.
     */
    function missionDiff(): string {
      for (const sha of [M04_RANGE_START, M04_RANGE_END]) {
        try {
          execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
            cwd: REPO_ROOT,
            stdio: 'ignore',
          });
        } catch {
          throw new Error(
            `commit ${sha} is not present in this clone, so CUT-7 cannot observe m04's diff. ` +
              `This is a SHALLOW-CHECKOUT problem, not a code problem: set fetch-depth: 0 on ` +
              `actions/checkout. Refusing to report green on an unobserved criterion.`
          );
        }
      }
      return execFileSync('git', ['diff', '-U0', `${M04_RANGE_START}..${M04_RANGE_END}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    }

    it('(a) touches no identity-resolution or minting surface', () => {
      const diff = missionDiff();
      const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
      const forbidden = [
        'src/intelligence/project-graph-registry.ts',
        'src/intelligence/project-resolution.ts',
      ];
      expect(changedFiles.filter((f) => forbidden.includes(f))).toEqual([]);
    });

    it('(b) adds no mint, no register, and no metadata write to SHIPPED code', () => {
      // TWO exclusions, each by a stated rule rather than by allowlist.
      //
      // 1. SCOPE IS `src/` AND `scripts/`. A test that PROVES the absence of a metadata write has
      //    to name the thing it is proving absent — this very file, and the seed-stamp gate, both
      //    carry `INTO metadata` inside a regex. Failing the mission because its own gate quotes
      //    the pattern it gates would be a criterion that fails when the mission succeeds, which
      //    is the exact shape both plan-time critic lenses rejected in the first draft of this
      //    criterion.
      // 2. COMMENTS ARE EXCLUDED. This mission's whole job is to describe the fallback honestly,
      //    so it necessarily discusses minting in prose. Code is what may not do it.
      let currentFile = '';
      const offenders: string[] = [];
      for (const line of missionDiff().split('\n')) {
        const header = line.match(/^\+\+\+ b\/(.+)$/);
        if (header) {
          currentFile = header[1];
          continue;
        }
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        if (!/^(src|scripts)\//.test(currentFile)) continue;
        const t = line.slice(1).trim();
        if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('--')) continue;
        if (/mintProjectId|registerStore|INTO metadata|UPDATE metadata/.test(t)) {
          offenders.push(`${currentFile}: ${t}`);
        }
      }
      expect(offenders).toEqual([]);

      // ANTI-VACUITY: the scanner must actually be reading src/ lines, or it proves nothing.
      const srcAdds = missionDiff()
        .split('\n')
        .reduce(
          (acc, line) => {
            const header = line.match(/^\+\+\+ b\/(.+)$/);
            if (header) return { file: header[1], n: acc.n };
            if (line.startsWith('+') && !line.startsWith('+++') && /^src\//.test(acc.file)) {
              return { file: acc.file, n: acc.n + 1 };
            }
            return acc;
          },
          { file: '', n: 0 }
        ).n;
      expect(srcAdds).toBeGreaterThan(0);
    });

    it('(c) the only src/intelligence/ file it touches is the tag constructor', () => {
      const changedFiles = [...missionDiff().matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
      const intelligence = changedFiles.filter((f) => f.startsWith('src/intelligence/'));
      expect(intelligence.every((f) => f === 'src/intelligence/provenance-frame.ts')).toBe(true);
    });

    it('(d) leaves the live store AND the project-graph registry untouched', () => {
      // Conjunct (d) is why every client construction above passes an explicit dbPath (D-9).
      const live = fs.statSync(LIVE_DB);
      expect(live.size).toBeGreaterThan(0);

      if (!fs.existsSync(REGISTRY)) return; // no registry on this machine — nothing to protect
      const db = new Database(REGISTRY, { readonly: true });
      try {
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
        // Measured at build time: 21 registered projects, all active. The assertion is that this
        // suite did not ADD one — a mint would show up here as a 22nd row.
        expect(n).toBe(21);
      } finally {
        db.close();
      }
    });
  });
});
