// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s80-m01 — the verify:dist answer-shape release gate. Drives the BUILT
// ABOUTME: dist/index.js over MCP stdio (no pack/install) and asserts s80 invariants.

/**
 * verify:dist (s80-m01 scaffold, grown across m01–m07).
 *
 * This is the committed answer-shape release gate — it speaks MCP over stdio to the
 * repo's freshly-built `dist/index.js` and asserts the standing invariants (server
 * identity, the 15-tool line) plus the sprint's answer-shape deltas. It reuses the
 * shared stdio bootstrap (`tests/e2e/stdio-harness.ts`) with the first-run E2E so the
 * two never drift on transport wiring, but — unlike first-run — it does NOT pack/install
 * (fast, run against the working `dist/`). Kept OUT of the coverage-gated default jest
 * suite; run explicitly with `npm run verify:dist` (after `npm run build`).
 *
 * Exit 0 = all checks passed; exit 1 = at least one failed (details on stderr).
 *
 * @module scripts/verify-dist
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connectStdioServer, textOf } from '../tests/e2e/stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_SERVER = path.join(REPO_ROOT, 'dist', 'index.js');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIST_SERVER)) {
    console.error(`verify:dist — ${DIST_SERVER} not found. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const projectDir = mkTmp('cmos-verify-project-');
  const configDir = mkTmp('cmos-verify-config-');
  const env = { ...process.env, CMOS_CONFIG_DIR: configDir } as Record<string, string>;
  delete env.CMOS_PROJECT_ROOT;

  const h = await connectStdioServer({
    serverPath: DIST_SERVER,
    cwd: projectDir,
    env,
    clientName: 'verify-dist',
  });

  try {
    // --- Standing invariants (every sprint) ---
    const info = h.client.getServerVersion();
    check('server announces cmos-mcp', info?.name === 'cmos-mcp', `got ${info?.name}`);
    check(
      `server version === ${PKG.version}`,
      info?.version === PKG.version,
      `got ${info?.version}`
    );

    const tools = await h.client.listTools();
    check('exposes exactly 15 tools', tools.tools.length === 15, `got ${tools.tools.length}`);

    // s80-m05: cmos_message(get) shipped as an ACTION (not a tool — 15-tool line holds).
    // The byte-cap + body-on-get BEHAVIOR is covered by unit tests (the isolated verify:dist
    // env has no dashboard auth); here we assert the action reached the built dist schema.
    const messageTool = tools.tools.find((t) => t.name === 'cmos_message');
    const messageActions =
      (messageTool?.inputSchema?.properties as { action?: { enum?: string[] } })?.action?.enum ??
      [];
    check(
      'cmos_message advertises the get action (body-on-get)',
      messageActions.includes('get'),
      `actions=${messageActions.join(',')}`
    );

    // --- s80-m01: the dist is drivable end-to-end against a fresh graph-only store ---
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: projectDir,
      projectName: 'verify-dist',
    });
    check(
      'cmos_project(init) writes the seed store',
      fs.existsSync(path.join(projectDir, 'cmos', 'db', 'cmos.sqlite'))
    );

    // s80-m02: init registers into the project-graph registry (single source) and
    // writes NO legacy project-registry.json.
    check(
      'init writes the project-graph registry',
      fs.existsSync(path.join(configDir, 'project-graph.sqlite'))
    );
    check(
      'init writes NO legacy project-registry.json',
      !fs.existsSync(path.join(configDir, 'project-registry.json'))
    );

    const review = await h.callOk('cmos_review', { projectRoot: projectDir });
    check('cmos_review returns a non-empty digest', textOf(review).length > 0);

    // --- s80-m04: a pin-only read pins to the sender; a neutral multi-project dir
    //     fails CLOSED (never fans out). Register a 2nd project so the registry is
    //     multi-project (sender-context auto-picks ONLY a size-1 registry).
    const projectDir2 = mkTmp('cmos-verify-project2-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: projectDir2,
      projectName: 'verify-dist-2',
    });

    // s80-m06: with a multi-project registry, cmos_review carries a strict-partition
    // portfolio (reachable + silent + unmigrated + unreadable === projects) within budget.
    const review2 = h.dataOf(await h.callOk('cmos_review', { projectRoot: projectDir })) as {
      portfolio?: {
        projects: number;
        reachable: number;
        silent: number;
        unmigrated: number;
        unreadable: number;
      } | null;
      digestSizeBytes?: number;
    };
    const pf = review2?.portfolio;
    check(
      'cmos_review portfolio is a strict partition (reachable+silent+unmigrated+unreadable === projects)',
      !!pf && pf.reachable + pf.silent + pf.unmigrated + pf.unreadable === pf.projects,
      `portfolio=${JSON.stringify(pf)}`
    );

    // s80-m07: the self-capture guard is wired into onboard but must NOT false-fire on a
    // fresh store (no decisions/learnings/missions yet → Signal B null → no advisory).
    const onboardData = h.dataOf(
      await h.callOk('cmos_agent_onboard', { projectRoot: projectDir })
    ) as { selfCapture?: { fires?: boolean } };
    check(
      'self-capture guard is present and does not false-fire on a fresh store',
      onboardData?.selfCapture != null && onboardData.selfCapture.fires === false,
      `selfCapture=${JSON.stringify(onboardData?.selfCapture)}`
    );
    check(
      'cmos_review digest stays within the 4KB budget',
      typeof review2?.digestSizeBytes === 'number' && review2.digestSizeBytes <= 4096,
      `digestSizeBytes=${review2?.digestSizeBytes}`
    );

    // Mode (i): from a REAL project cwd, a pin-only read (mission list, no projectRoot)
    // resolves to the sender and succeeds — scoped, not fanned out.
    const pinnedRead = await h.callTool('cmos_mission', { action: 'list' });
    check(
      'pin-only read from a real cwd resolves to the sender (not isError)',
      pinnedRead.isError !== true
    );

    // Mode (ii): from a NEUTRAL dir with a multi-project registry, the same read fails
    // CLOSED (SenderResolutionError) rather than walking every project.
    const neutralDir = mkTmp('cmos-verify-neutral-');
    const h2 = await connectStdioServer({
      serverPath: DIST_SERVER,
      cwd: neutralDir,
      env,
      clientName: 'verify-dist-neutral',
    });
    try {
      const neutralRead = await h2.callTool('cmos_mission', { action: 'list' });
      check(
        'pin-only read from a neutral multi-project dir fails CLOSED (isError, no fan-out)',
        neutralRead.isError === true,
        `isError=${neutralRead.isError}; text=${h2.textOf(neutralRead).slice(0, 120)}`
      );
    } finally {
      await h2.close();
    }
  } finally {
    await h.close();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failures > 0) {
    console.error(`\nverify:dist FAILED — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nverify:dist PASSED — all answer-shape checks green.');
}

main().catch((err) => {
  console.error('verify:dist crashed:', err);
  process.exit(1);
});
