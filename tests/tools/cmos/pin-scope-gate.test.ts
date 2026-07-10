// ABOUTME: s80-m04 pin-scope gate — every pin-only read stays scoped to the sender.
// ABOUTME: No src/tools/cmos handler imports the cross-store machinery except the ratified portfolio set.

/**
 * Sprint 80 m04 — pin-scope convergence gate.
 *
 * s79's fan-out deletion left every local read dispatch-pinned to its sender (index.ts
 * runs `resolveToolSenderContext` per case; a neutral multi-project dir fails CLOSED via
 * `SenderResolutionError`). This gate LOCKS that: no `src/tools/cmos` handler may import
 * the cross-store machinery (`queryAcrossStores` / the named `cross-store-queries` /
 * `ProjectGraphRegistry`) — which is how a read would fan out across projects — EXCEPT
 * the explicitly ratified portfolio surfaces:
 *
 *   Ratified `acrossProjects` reads (the 3 named §5.4 portfolio queries):
 *     - cmos-decisions-list.ts   (cmos_decisions list, acrossProjects)
 *     - cmos-learnings-list.ts   (cmos_learnings list, acrossProjects)
 *     - cmos-mission-status.ts   (cmos_mission status, acrossProjects)
 *   Ratified always-on portfolio digests:
 *     - cmos-review.ts           (≤4KB portfolio section, s79-m06 / decision #672)
 *     - cmos-agent-onboard.ts    (portfolio rollup; write-classified, not a pin-only read)
 *   Portfolio-by-design registry management (NOT pin-only reads — they ARE the registry):
 *     - cmos-project-list.ts / -register / -unregister / -init / -validate / -sweep
 *
 * Any OTHER handler importing the machinery is an offender: a pin-only read (session
 * list/search, sprint list/show, mission list/show, decisions/learnings search, context
 * view/history/search, db health, feedback list) must never fan out. The FENCE holds:
 * no `acrossProjects` on a pin-only read (none maps to a §5.4 named query).
 *
 * @module tests/tools/cmos/pin-scope-gate
 */

import * as fs from 'fs';
import * as path from 'path';

const HANDLER_DIR = path.resolve(__dirname, '../../../src/tools/cmos');

/** Handler files ALLOWED to import the cross-store machinery (repo-relative basename). */
const ALLOWLIST = new Set<string>([
  // Ratified acrossProjects reads (the 3 named §5.4 portfolio queries).
  'cmos-decisions-list.ts',
  'cmos-learnings-list.ts',
  'cmos-mission-status.ts',
  // Ratified always-on portfolio digests.
  'cmos-review.ts',
  'cmos-agent-onboard.ts',
  // Portfolio-by-design registry management (they manage the graph registry itself).
  'cmos-project-list.ts',
  'cmos-project-register.ts',
  'cmos-project-unregister.ts',
  'cmos-project-init.ts',
  'cmos-project-validate.ts',
  'cmos-project-sweep.ts',
  // s81-m03: the checkpoint push path does a SINGLE-PROJECT registry WRITE
  // (updateLastSynced, keyed by the store's OWN project_id) after a converged push — it
  // records last_synced_at for the drift signal. It is NOT a pin-only read and does NOT
  // fan out across stores (no queryAcrossStores / cross-store-queries), so it does not
  // violate the sender-scoping this gate protects.
  'checkpoint-backfill.ts',
]);

// Matches an import from the cross-store fan-out modules OR the project-graph registry —
// the machinery a pin-only read would use to escape its sender scope.
const CROSS_STORE_IMPORT =
  /from\s+['"][^'"]*\/(cross-store-query|cross-store-queries|project-graph-registry)['"]/;

/** The 3 ratified acrossProjects handlers must genuinely import a §5.4 named query. */
const RATIFIED_ACROSS_PROJECTS = [
  'cmos-decisions-list.ts',
  'cmos-learnings-list.ts',
  'cmos-mission-status.ts',
];

function listHandlerFiles(): string[] {
  return fs
    .readdirSync(HANDLER_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
    .map((e) => e.name);
}

describe('pin-scope convergence gate (Sprint 80 m04)', () => {
  it('no pin-only read handler imports the cross-store machinery outside the ratified set', () => {
    const offenders: string[] = [];
    for (const name of listHandlerFiles()) {
      if (ALLOWLIST.has(name)) continue;
      const content = fs.readFileSync(path.join(HANDLER_DIR, name), 'utf8');
      if (CROSS_STORE_IMPORT.test(content)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the 3 ratified acrossProjects handlers still import a cross-store query (keeps the list honest)', () => {
    for (const name of RATIFIED_ACROSS_PROJECTS) {
      const content = fs.readFileSync(path.join(HANDLER_DIR, name), 'utf8');
      const importsCrossStore =
        /from\s+['"][^'"]*\/(cross-store-query|cross-store-queries)['"]/.test(content);
      expect({ file: name, importsCrossStore }).toEqual({ file: name, importsCrossStore: true });
    }
  });
});
