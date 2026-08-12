// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m05 — cmos_sprint(analytics, limit=N) over real MCP stdio against the BUILT dist/,
// ABOUTME: on a tmpdir COPY of the live cmos.sqlite. Proves `limit` survives the dispatch boundary.

/**
 * Sprint 86 m05 — the analytics window, proven through the transport it actually ships over.
 *
 * WHY THIS EXISTS SEPARATELY FROM tests/tools/cmos/analytics-window-real-store.test.ts.
 * The sprint's load-bearing constraint has TWO halves and neither substitutes for the other:
 *   - a REAL-STORE positive fire proves the SQL matches a migrated store's actual columns;
 *   - a run over stdio AGAINST THE BUILT dist/ proves the parameter survives the MCP dispatch
 *     boundary and reaches the handler at all.
 * Handler-only testing is precisely what let `statusFilter`, `expiresAt` and `agentFeedback`
 * each ship declared-but-never-forwarded. `limit` is forwarded to the analytics branch by the
 * router; a handler test cannot see a router that drops it. This file does BOTH halves at once:
 * the built server, over stdio, against a copy of the real store.
 *
 * WHY IT LIVES IN tests/e2e/ AND NOT THE DEFAULT SUITE — stated rather than left to be
 * rediscovered. The `npm test` CI job (quality-tooling.yml) runs npm ci → lint → format → test
 * with NO build step, so dist/ does not exist there; a dist-dependent test in the default suite
 * would either fail CI or, worse, skip itself green. The first-run-e2e job DOES run
 * `npm run build` before `npm run test:e2e-firstrun`, and jest.e2e.config.js picks up
 * `tests/e2e/*.e2e.ts`. So this is the only place in the repo where "against the rebuilt dist/"
 * is a statement that can be true. Locally: `npm run build && npm run test:e2e-firstrun`.
 *
 * NO SILENT FAIL-OPEN (agents.md Process Hardening #4). A missing dist/ or a missing live store
 * FAILS this suite loudly. It never skips — a skipped positive-fire test reports green while
 * proving nothing, which is the defect class this sprint exists to close.
 *
 * NEVER AGAINST THE LIVE FILE. The server is pointed at an `mkdtempSync` copy.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { connectStdioServer, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const LIVE_DB = path.join(REPO_ROOT, 'cmos', 'db', 'cmos.sqlite');

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Copy the live store into a temp project root. The live file is never opened for writing. */
function copyLiveStore(): string {
  const projectRoot = mkTmp('cmos-m05-stdio-');
  const dbDir = path.join(projectRoot, 'cmos', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${LIVE_DB}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `cmos.sqlite${suffix}`));
  }
  return projectRoot;
}

describe('analytics window over stdio against the built dist (s86-m05)', () => {
  let harness: StdioHarness;
  let projectRoot: string;
  let newestFive: string[];
  let oldestFive: string[];

  beforeAll(async () => {
    // Premise checks first, as assertions rather than guards — see NO SILENT FAIL-OPEN above.
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; ` +
          `run \`npm run build\` first. It must not skip — a skipped transport test proves nothing.`
      );
    }
    if (!fs.existsSync(LIVE_DB)) {
      throw new Error(`live store not found at ${LIVE_DB}; the real-store arm cannot run.`);
    }

    projectRoot = copyLiveStore();

    // Ground the expectation in the copy rather than a hardcoded id list, so the assertion keeps
    // meaning as sprints accumulate. The pre-fix ordering is computed too, which is what makes
    // the final assertion a claim about DIRECTION and not about a particular sprint number.
    const db = new Database(path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite'), {
      readonly: true,
    });
    const ids = (sql: string): string[] =>
      db
        .prepare(sql)
        .all()
        .map((r) => (r as { sprint_id: string }).sprint_id);
    newestFive = ids(
      `SELECT sprint_id FROM sprint_summary WHERE status IN ('Completed','Active')
       ORDER BY sprint_id DESC LIMIT 5`
    );
    oldestFive = ids(
      `SELECT sprint_id FROM sprint_summary WHERE status IN ('Completed','Active')
       ORDER BY sprint_id ASC LIMIT 5`
    );
    db.close();

    harness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: projectRoot,
      env: {
        ...(process.env as Record<string, string>),
        CMOS_PROJECT_ROOT: projectRoot,
        // Isolate the per-user registry so driving the built server never touches
        // ~/.config/cmos-mcp/project-graph.sqlite.
        CMOS_CONFIG_DIR: mkTmp('cmos-m05-cfg-'),
      },
      clientName: 'cmos-m05-analytics-window',
    });
  }, 120000);

  afterAll(async () => {
    if (harness) await harness.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the NEWEST five sprints for limit=5, not the oldest five', async () => {
    const res = await harness.callOk('cmos_sprint', {
      action: 'analytics',
      limit: 5,
      projectRoot,
    });
    const data = harness.dataOf(res) as {
      sprints: Array<{ sprintId: string }>;
      window: { requestedLimit: number | null; oldestSprintId: string; newestSprintId: string };
    };

    const returned = data.sprints.map((s) => s.sprintId);

    // `limit` reached the handler at all — the dispatch-boundary half of the claim.
    expect(returned).toHaveLength(5);

    // …and it bounded the window at the NEWEST end, handed back oldest-first.
    expect(returned).toEqual([...newestFive].reverse());

    // The pre-fix result, asserted as DISJOINTNESS rather than by naming sprint ids. Hardcoding
    // 'sprint-86' would be a time-bomb that fails the moment sprint-87 opens, for a reason
    // unrelated to this code (agents.md: no hardcoded values that age out). On a 77-sprint store
    // the newest window and the oldest window share no members, which is the real claim.
    expect(newestFive).not.toEqual(oldestFive);
    for (const oldId of oldestFive) expect(returned).not.toContain(oldId);

    // The answer names the window it describes.
    expect(data.window.requestedLimit).toBe(5);
    expect(data.window.newestSprintId).toBe(newestFive[0]);
  }, 60000);

  it('renders the window in the answer text, not just the structured payload', async () => {
    // A field only present in structuredContent is invisible to an agent reading the answer —
    // the same fail-quiet shape s86-m02 fixed elsewhere in this sprint.
    const res = await harness.callOk('cmos_sprint', {
      action: 'analytics',
      limit: 5,
      projectRoot,
    });
    const text = harness.textOf(res);
    expect(text).toMatch(/\*\*Window\*\*/);
    expect(text).toContain('sprint-86');
    expect(text).toMatch(/oldest → newest/);
  }, 60000);

  it('leaves the unlimited call unbounded', async () => {
    const res = await harness.callOk('cmos_sprint', { action: 'analytics', projectRoot });
    const data = harness.dataOf(res) as {
      sprints: Array<{ sprintId: string }>;
      window: { requestedLimit: number | null };
    };
    expect(data.window.requestedLimit).toBeNull();
    expect(data.sprints.length).toBeGreaterThan(5);
    // Unbounded is still oldest-first, so the trend semantics are the same in both modes.
    expect(data.sprints[0].sprintId).toBe(oldestFive[0]);
  }, 60000);
});
