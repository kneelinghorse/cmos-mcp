/**
 * Sprint 69 m03 — event_type coverage guard (s68 ADR §2.4).
 *
 * Walks every `INSERT INTO <firehose_table>` site in src/ and asserts the row is
 * stamped with the genesis columns — either a literal `event_type` in the column
 * list, or a `genesisColumns(...)` splice (`g.columns` / `genesis.columns`, incl.
 * the dynamic-column-builder form). Because event_type has NO DEFAULT, an INSERT
 * that omits it fails at runtime; this test catches such a regression pre-merge.
 *
 * @module tests/tools/cmos/event-type-coverage
 */

import * as fs from 'fs';
import * as path from 'path';
import { FIREHOSE_TABLES } from '../../../src/types/event-types';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

/**
 * Files intentionally exempt from the genesis-stamp requirement, with rationale:
 *  - cmos-project-init.ts: initializes a fresh store via raw better-sqlite3 (not
 *    CmosDatabaseClient) where the genesis columns are still NULLABLE; its initial
 *    sprint/mission rows are backfilled by the lazy firehose migration on the
 *    first genesis write.
 *
 * (Sprint 76 Great Deletion removed the former sqlite-client.ts exemption — the
 * dead legacy SQLiteClient was deleted in G2, so it no longer needs allowlisting.)
 */
const ALLOWLIST = new Set([path.join('tools', 'cmos', 'cmos-project-init.ts')]);

const FIREHOSE_RE = FIREHOSE_TABLES.join('|');
// An INSERT into a firehose table, capturing the column-list region up to VALUES/SELECT.
const INSERT_RE = new RegExp(
  `INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+(${FIREHOSE_RE})\\b([\\s\\S]*?)(?:VALUES|SELECT)\\b`,
  'gi'
);
// The genesis stamp present in the column-list region: a literal event_type or a
// genesisColumns splice (g.columns / genesis.columns).
const STAMP_RE = /\bevent_type\b|\bg\.columns\b|\bgenesis\.columns\b/;
// A dynamic column list interpolating a variable (e.g. `(${insertColumns})`).
const DYNAMIC_RE = /\(\s*\$\{[\w.]+\}\s*\)/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface InsertSite {
  file: string;
  rel: string;
  table: string;
  columnRegion: string;
  fileContent: string;
}

function collectFirehoseInserts(): InsertSite[] {
  const sites: InsertSite[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_ROOT, file);
    INSERT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INSERT_RE.exec(content)) !== null) {
      sites.push({ file, rel, table: m[1], columnRegion: m[2], fileContent: content });
    }
  }
  return sites;
}

describe('event_type coverage (Sprint 69 m03)', () => {
  const sites = collectFirehoseInserts();

  it('finds the expected firehose INSERT sites in production code', () => {
    // Sanity floor: the sweep wired ~20+ production sites. If this drops sharply,
    // the regex broke or sites were deleted — fail so we notice.
    const production = sites.filter((s) => !ALLOWLIST.has(s.rel));
    expect(production.length).toBeGreaterThanOrEqual(18);
  });

  it('stamps event_type on every production firehose INSERT', () => {
    const violations: string[] = [];
    for (const site of sites) {
      if (ALLOWLIST.has(site.rel)) continue;
      const hasStamp = STAMP_RE.test(site.columnRegion);
      // The dynamic-builder site uses `(${insertColumns})`; accept it only when the
      // file also extends that list via genesisColumns (genesis.columns / g.columns).
      const isDynamicStamped =
        DYNAMIC_RE.test(site.columnRegion) && /\b(?:g|genesis)\.columns\b/.test(site.fileContent);
      if (!hasStamp && !isDynamicStamped) {
        violations.push(`${site.rel}: INSERT INTO ${site.table} omits the genesis stamp`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the allowlist tightly scoped (no silent additions)', () => {
    expect([...ALLOWLIST].sort()).toEqual(
      [path.join('tools', 'cmos', 'cmos-project-init.ts')].sort()
    );
  });
});
