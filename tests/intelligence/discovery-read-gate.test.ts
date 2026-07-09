// ABOUTME: s80-m02 grep-gate — the project-graph registry is the SOLE discovery source.
// ABOUTME: No src/ file imports a project-registry module or reads project-registry.json (except the backfill).

/**
 * Sprint 80 m02 — discovery-read convergence gate.
 *
 * The JSON `ProjectRegistry` class + the `project-registry.json` derivation layer are
 * DELETED (s80-m02). The `ProjectGraphRegistry` SQLite registry is now the genuine
 * single discovery source. This gate fails the build if any `src/` file re-introduces
 * the split-brain read by either:
 *
 *   (1) importing a `project-registry` module — the module no longer exists, so ANY
 *       import of it is a regression; or
 *   (2) reading the legacy `project-registry.json` file — EXCEPT the ONE exempt reader,
 *       `intelligence/project-graph-registry.ts`, whose `readLegacyJsonRegistry` performs
 *       the one-time, marker-gated, WRITE-NOTHING migration of pre-s80 operators (F1=A).
 *
 * (`project-registry` is NOT a substring of `project-graph-registry`, so imports of the
 * live graph registry never match the module regex.)
 *
 * @module tests/intelligence/discovery-read-gate
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');

/** The sole file allowed to READ the legacy project-registry.json (F1=A, s80-m02). */
const JSON_READ_ALLOWLIST = new Set<string>(['intelligence/project-graph-registry.ts']);

// Matches loading a `project-registry` module by ANY mechanism — static `import … from`,
// `export … from`, `require('…')`, or dynamic `import('…')`. The module is deleted, so any
// match is an offender. Does NOT match `project-graph-registry` (`project-registry` is not
// a substring of it). The require/import() arms close the s80-m02-review completeness gap.
const PROJECT_REGISTRY_MODULE_IMPORT =
  /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"][^'"]*project-registry['"]/;

// Matches any reference to the legacy JSON file by name (import, fs read, path.join).
const PROJECT_REGISTRY_JSON = /project-registry\.json/;

/** Recursively collect every `.ts` file under `dir` (skips `.d.ts`). */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('discovery-read convergence gate (Sprint 80 m02)', () => {
  it('no src/ file imports a project-registry module (the JSON class is deleted)', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const content = fs.readFileSync(file, 'utf8');
      if (PROJECT_REGISTRY_MODULE_IMPORT.test(content)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no src/ file reads project-registry.json except the exempt backfill', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (JSON_READ_ALLOWLIST.has(rel)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (PROJECT_REGISTRY_JSON.test(content)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the exempt backfill still actually reads the legacy JSON (keeps the allowlist honest)', () => {
    // If project-graph-registry.ts stops reading project-registry.json, prune it from
    // JSON_READ_ALLOWLIST — a stale exemption is a latent hole. s80-m02-review: assert
    // the real reader (a readFileSync of the JSON path), NOT a bare string match that a
    // leftover comment could satisfy after the read itself was removed.
    const content = fs.readFileSync(
      path.join(SRC_ROOT, 'intelligence/project-graph-registry.ts'),
      'utf8'
    );
    const readsTheJson =
      /readFileSync\(/.test(content) &&
      /path\.join\([^)]*['"]project-registry\.json['"]\)/.test(content);
    expect(readsTheJson).toBe(true);
  });
});
