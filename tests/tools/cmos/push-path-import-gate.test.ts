// ABOUTME: s81-m02 push-path import gate — the T4 push/convergence path imports ZERO
// ABOUTME: pull-merge machinery (sync-pull / sync-merge / insert-union / clone). Fence lock.

/**
 * Sprint 81 m02 — T4 push-keying convergence fence gate.
 *
 * T4 is PUSH-KEYING ONLY (operator-ratified F-A): the client adopts the incumbent
 * dashboard key before pushing so a same-owner file-copy converges into the incumbent
 * row instead of minting a dup container. It does a pure identity read + a bulk file
 * upload — ZERO entity merge. The parked collab/pull-merge arc (§6) must stay parked:
 * the FK-hitting insert-union in `sync-pull.ts` is the #369 FK-parity precondition
 * surface, and it is imported ONLY by `cmos-db.ts` pull/clone + the parked collab paths.
 *
 * This gate LOCKS the fence: none of the four push-path source files may import the
 * pull-merge machinery. If a future change wires merge into the push path, this fails —
 * surfacing the scope-fence violation at build time, not in production dup-minting.
 *
 * @module tests/tools/cmos/push-path-import-gate
 */

import * as fs from 'fs';
import * as path from 'path';

const CMOS_DIR = path.resolve(__dirname, '../../../src/tools/cmos');

/** The T4 push / convergence path (grep-confirmed clean in the s81 investigation). */
const PUSH_PATH_FILES = [
  'owner-resolution.ts',
  'checkpoint-backfill.ts',
  'cmos-db-backfill.ts',
  'dashboard-client.ts',
];

// Matches an import from any parked pull-merge module — the machinery a push must never
// touch. `clone` is matched as the sync-clone module basename, not the substring.
const PULL_MERGE_IMPORT = /from\s+['"][^'"]*\/(sync-pull|sync-merge|sync-clone|insert-union)['"]/;

describe('push-path import gate (Sprint 81 m02)', () => {
  it('no T4 push-path file imports pull-merge machinery (sync-pull / sync-merge / clone / insert-union)', () => {
    const offenders: Array<{ file: string; line: string }> = [];
    for (const name of PUSH_PATH_FILES) {
      const content = fs.readFileSync(path.join(CMOS_DIR, name), 'utf8');
      for (const line of content.split('\n')) {
        if (PULL_MERGE_IMPORT.test(line)) {
          offenders.push({ file: name, line: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the push-path file list stays honest (every listed file exists)', () => {
    for (const name of PUSH_PATH_FILES) {
      expect(fs.existsSync(path.join(CMOS_DIR, name))).toBe(true);
    }
  });
});
