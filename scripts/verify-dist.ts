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

    // --- s81-m03: the "unsynced" drift class must NOT false-fire on a fresh store
    //     (last_synced_at is NULL = no-signal; it never fabricates a positive). The
    //     partition-sum + budget checks above already prove the overlay never inflates
    //     the partition or the digest.
    const driftStale =
      (
        review2 as {
          portfolio?: { drift?: { stale?: Array<{ reason?: string }> } | null };
        }
      )?.portfolio?.drift?.stale ?? [];
    check(
      's81-m03: no false "unsynced" drift on a fresh store (NULL last_synced_at = no-signal)',
      Array.isArray(driftStale) && !driftStale.some((d) => /unsynced/i.test(d?.reason ?? '')),
      `drift=${JSON.stringify(driftStale)}`
    );

    // --- s81-m06: cmos_sprint(complete) carries the next_steps TABLE reconcile receipt
    //     (nextStepsReconciled / nextStepsCarried / pendingFlagged). Drive a minimal
    //     empty-sprint close on a fresh project and assert the receipt SHAPE shipped in dist.
    const projectDir3 = mkTmp('cmos-verify-m06-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: projectDir3,
      projectName: 'verify-m06',
    });
    await h.callOk('cmos_sprint', {
      action: 'add',
      projectRoot: projectDir3,
      sprintId: 'sv-1',
      title: 'SV1',
      focus: 'verify',
    });
    const closeData = h.dataOf(
      await h.callOk('cmos_sprint', {
        action: 'complete',
        projectRoot: projectDir3,
        sprintId: 'sv-1',
        summary: 'verify:dist reconcile-receipt shape',
      })
    ) as { nextStepsReconciled?: unknown; nextStepsCarried?: unknown; pendingFlagged?: unknown };
    check(
      's81-m06: cmos_sprint(complete) returns the next_steps reconcile receipt shape',
      typeof closeData?.nextStepsReconciled === 'number' &&
        typeof closeData?.nextStepsCarried === 'number' &&
        Array.isArray(closeData?.pendingFlagged),
      `receipt=${JSON.stringify({
        reconciled: closeData?.nextStepsReconciled,
        carried: closeData?.nextStepsCarried,
        flagged: closeData?.pendingFlagged,
      })}`
    );

    // --- s83-m05: tiers that work for strangers ---
    // (a) Auto-discovery (NO projectRoot): onboard must resolve tiers from the RESOLVED
    //     store root (dirname^3 of the connected DB path), not the server install dir.
    //     The server runs with cwd=projectDir and CMOS_PROJECT_ROOT deleted, so this is
    //     the real npm-consumer path. Asserting tierConfig != null alone is NOT enough —
    //     the always-present bundled cmos-seed/tiers fallback would satisfy that even if
    //     the onboard fix were reverted. So stamp a unique label into projectDir's OWN
    //     build.md and assert onboard echoes it: a regression to raw params.projectRoot
    //     (undefined on auto-discovery) would fall back to the seed and miss the marker.
    const storeBuildTier = path.join(projectDir, 'cmos', 'tiers', 'build.md');
    const originalTier = fs.readFileSync(storeBuildTier, 'utf8');
    const storeMarker = 'StoreRootMarker-s83m05';
    fs.writeFileSync(storeBuildTier, originalTier.replace(/^label:.*$/m, `label: ${storeMarker}`));
    let onboardNoRoot: { tierConfig?: { tier?: string; label?: string } | null };
    try {
      onboardNoRoot = h.dataOf(await h.callOk('cmos_agent_onboard', {})) as typeof onboardNoRoot;
    } finally {
      fs.writeFileSync(storeBuildTier, originalTier);
    }
    check(
      's83-m05: auto-discovery onboard (no projectRoot) reads tiers from the resolved STORE root, not the seed',
      onboardNoRoot?.tierConfig?.label === storeMarker,
      `tierConfig=${JSON.stringify(onboardNoRoot?.tierConfig)}`
    );

    // (b) cmos_project(init, projectType=managed) writes the tier and onboard surfaces
    //     the managed first-session flow (sprintZeroReady + a Managed prompt).
    const managedDir = mkTmp('cmos-verify-managed-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: managedDir,
      projectName: 'verify-managed',
      projectType: 'managed',
    });
    const managedOnboard = h.dataOf(
      await h.callOk('cmos_agent_onboard', { projectRoot: managedDir })
    ) as {
      project?: { projectType?: string };
      sprintZeroReady?: boolean;
      tierSelectionPrompt?: string;
    };
    check(
      's83-m05: init(projectType=managed) is read back as the managed tier on onboard',
      managedOnboard?.project?.projectType === 'managed',
      `projectType=${managedOnboard?.project?.projectType}`
    );
    check(
      's83-m05: managed fresh project surfaces sprintZeroReady + a Managed tier prompt',
      managedOnboard?.sprintZeroReady === true &&
        /Managed workspace/.test(managedOnboard?.tierSelectionPrompt ?? ''),
      `sprintZeroReady=${managedOnboard?.sprintZeroReady}; prompt=${(
        managedOnboard?.tierSelectionPrompt ?? ''
      ).slice(0, 60)}`
    );

    // --- s83-m06: project_id-aware retrieval trust. Over stdio we can only prove the
    //     framing PLUMBING shipped (result carries localProjectId) and that a LOCAL row
    //     is NOT false-framed. The foreign-row positive-fire lives in the jest
    //     provenance-surfaces suite — a foreign row can only enter a store via
    //     sync-merge/pull, which isn't reachable over plain MCP stdio.
    const m06Dir = mkTmp('cmos-verify-m06frame-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: m06Dir,
      projectName: 'verify-m06frame',
    });
    await h.callOk('cmos_session', {
      action: 'start',
      type: 'planning',
      title: 'plan',
      projectRoot: m06Dir,
    });
    await h.callOk('cmos_session', {
      action: 'capture',
      category: 'decision',
      content: 'Adopt widget-sqlite-retrieval as the local decision',
      projectRoot: m06Dir,
    });
    const dsearchRes = await h.callOk('cmos_decisions', {
      action: 'search',
      query: 'widget sqlite retrieval',
      projectRoot: m06Dir,
    });
    const dsearch = h.dataOf(dsearchRes) as { localProjectId?: string | null };
    const dsearchText = h.textOf(dsearchRes);
    check(
      's83-m06: decisions(search) result carries localProjectId (framing plumbing shipped)',
      typeof dsearch?.localProjectId === 'string' && (dsearch.localProjectId ?? '').length > 0,
      `localProjectId=${dsearch?.localProjectId}`
    );
    check(
      's83-m06: a LOCAL decision renders BARE (no untrusted fence — no false-framing)',
      dsearchText.includes('widget-sqlite-retrieval') && !dsearchText.includes('[UNTRUSTED DATA'),
      `text=${dsearchText.slice(0, 140)}`
    );
    // The review-closure surfaces (onboard recentDecisions, context-view) also ship the
    // plumbing and must NOT false-frame the local decision.
    const m06Onboard = h.dataOf(await h.callOk('cmos_agent_onboard', { projectRoot: m06Dir })) as {
      localProjectId?: string | null;
    };
    check(
      's83-m06: cmos_agent_onboard result carries localProjectId (recentDecisions framing plumbing)',
      typeof m06Onboard?.localProjectId === 'string' &&
        (m06Onboard.localProjectId ?? '').length > 0,
      `localProjectId=${m06Onboard?.localProjectId}`
    );
    const m06ViewText = h.textOf(
      await h.callOk('cmos_context', { action: 'view', projectRoot: m06Dir })
    );
    check(
      's83-m06: cmos_context(view) renders the LOCAL decision BARE (no false-framing)',
      m06ViewText.includes('widget-sqlite-retrieval') && !m06ViewText.includes('[UNTRUSTED DATA'),
      `text=${m06ViewText.slice(0, 140)}`
    );

    // --- s84 answer shapes (this release's deltas). Only what is provable over PLAIN stdio:
    //     the verify:dist env has no dashboard auth, so anything requiring a live dashboard
    //     round-trip stays owned by the jest suites and is asserted here at the SCHEMA level.
    const s84Dir = mkTmp('cmos-verify-s84-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: s84Dir,
      projectName: 'verify-s84',
    });

    // (a) s84-m02: SQL-side pagination reached the built schema. The behavior (offset echo +
    //     returnedCount) needs a dashboard; the INPUT contract is provable here.
    const messageProps = (messageTool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    check(
      's84-m02: cmos_message advertises the offset pagination param',
      Object.prototype.hasOwnProperty.call(messageProps, 'offset'),
      `props=${Object.keys(messageProps).join(',')}`
    );

    // (b) s84-m05: an EVERGREEN constraint is excluded from staleness review end-to-end.
    //     Drivable on a fresh store: capture two constraints, flag one evergreen, and assert
    //     review returns the other and not it. This is the positive fire for the flag.
    await h.callOk('cmos_session', {
      action: 'start',
      type: 'planning',
      title: 's84 constraints',
      projectRoot: s84Dir,
    });
    await h.callOk('cmos_session', {
      action: 'capture',
      category: 'constraint',
      content: 'Institutional rule: the review digest stays under 4KB',
      projectRoot: s84Dir,
    });
    await h.callOk('cmos_session', {
      action: 'capture',
      category: 'constraint',
      content: 'Temporary rule: deploy freeze until the release lands',
      projectRoot: s84Dir,
    });
    const listedConstraints = h.dataOf(
      await h.callOk('cmos_context', {
        action: 'constraints',
        constraintAction: 'list',
        projectRoot: s84Dir,
      })
    ) as { items?: Array<{ id: number; content: string; evergreen?: boolean }> };
    const constraintItems = listedConstraints?.items ?? [];
    const institutional = constraintItems.find((c) => /Institutional rule/.test(c.content));
    const temporary = constraintItems.find((c) => /Temporary rule/.test(c.content));
    check(
      's84-m05: constraints(list) returns both captured constraints, evergreen false by default',
      constraintItems.length === 2 &&
        institutional != null &&
        constraintItems.every((c) => c.evergreen === false),
      `items=${JSON.stringify(constraintItems)}`
    );

    if (institutional && temporary) {
      await h.callOk('cmos_context', {
        action: 'constraints',
        constraintAction: 'reaffirm',
        constraintId: institutional.id,
        evergreen: true,
        projectRoot: s84Dir,
      });
      const relisted = h.dataOf(
        await h.callOk('cmos_context', {
          action: 'constraints',
          constraintAction: 'list',
          projectRoot: s84Dir,
        })
      ) as { items?: Array<{ id: number; evergreen?: boolean }> };
      const flagById = new Map((relisted?.items ?? []).map((c) => [c.id, c.evergreen]));
      check(
        's84-m05: reaffirm(evergreen=true) durably flags ONLY the targeted constraint',
        flagById.get(institutional.id) === true && flagById.get(temporary.id) === false,
        `flags=${JSON.stringify([...flagById])}`
      );

      // The EXCLUSION leg is deliberately NOT asserted here, and the reason matters: it is
      // not provable over plain stdio on a fresh store. A seconds-old no-expiry constraint
      // scores 20 (the no-expiry bonus alone) and never reaches the 50 review floor, so a
      // review here returns nothing for BOTH rows and absence would prove nothing. Driving
      // the threshold below the elapsed age would fix that, but `stalenessThresholdDays` is
      // `.int().positive()` in zod, and the smallest legal value (1 day) still scores a
      // seconds-old row at 20. Backdating `created_at` is the only way, which needs direct
      // DB access — so the exclusion leg is owned by
      // tests/tools/cmos/constraint-staleness.test.ts ("evergreen=true durably drops the
      // constraint off review + banner"), which seeds a 90-day-old constraint and asserts
      // flagged-before / absent-after plus a PRAGMA positive-fire on the column.
      // What stdio CAN prove — and does, above — is that the flag reaches the built dist,
      // persists, and targets exactly one row.
      const reviewed = h.dataOf(
        await h.callOk('cmos_context', {
          action: 'constraints',
          constraintAction: 'review',
          projectRoot: s84Dir,
        })
      ) as { reviewItems?: Array<{ id: number }> };
      check(
        's84-m05: review runs clean on a fresh store (neither young constraint is stale)',
        Array.isArray(reviewed?.reviewItems) && reviewed.reviewItems.length === 0,
        `reviewItems=${JSON.stringify(reviewed?.reviewItems)}`
      );
    }

    // (c) s84-m04: cmos_context(history) surfaces contentPruned per row. On a fresh store
    //     nothing is tombstoned, so the assertion is that the FIELD ships and reads false —
    //     a regression that dropped the column mapping would surface as undefined.
    await h.callOk('cmos_context', {
      action: 'snapshot',
      projectRoot: s84Dir,
      source: 'verify-dist',
    });
    const history = h.dataOf(
      await h.callOk('cmos_context', { action: 'history', projectRoot: s84Dir })
    ) as { snapshots?: Array<{ contentPruned?: boolean }> };
    const snaps = history?.snapshots ?? [];
    check(
      's84-m04: cmos_context(history) surfaces contentPruned per row (false on a fresh store)',
      snaps.length > 0 && snaps.every((s) => s.contentPruned === false),
      `snapshots=${JSON.stringify(snaps.map((s) => s.contentPruned))}`
    );

    // --- s85-m03: write-side sprint tagging. On a store whose only sprint is Completed, a
    //     session start must persist sprint_id NULL, report advisorySprintId, and warn —
    //     while DISPLAY still names the Completed sprint. Fully drivable over stdio.
    const m03Dir = mkTmp('cmos-verify-m03-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: m03Dir,
      projectName: 'verify-m03',
    });
    await h.callOk('cmos_sprint', {
      action: 'add',
      projectRoot: m03Dir,
      sprintId: 'sp-closed',
      title: 'Closed sprint',
      focus: 'verify',
    });
    await h.callOk('cmos_sprint', {
      action: 'complete',
      projectRoot: m03Dir,
      sprintId: 'sp-closed',
      summary: 'closed so nothing is open',
    });

    const m03Start = await h.callOk('cmos_session', {
      action: 'start',
      type: 'planning',
      title: 'verify m03',
      projectRoot: m03Dir,
    });
    const m03Data = h.dataOf(m03Start) as {
      sprintId?: string | null;
      sprintAutoTagged?: boolean;
      advisorySprintId?: string | null;
    };
    check(
      's85-m03: session start on an all-Completed store persists sprintId NULL',
      m03Data?.sprintId === null && m03Data?.sprintAutoTagged === false,
      `sprintId=${JSON.stringify(m03Data?.sprintId)} autoTagged=${m03Data?.sprintAutoTagged}`
    );
    check(
      's85-m03: the read-resolved sprint rides advisorySprintId, NOT sprintId',
      m03Data?.advisorySprintId === 'sp-closed',
      `advisorySprintId=${JSON.stringify(m03Data?.advisorySprintId)}`
    );
    // warnings ride the CmosToolResult envelope in structuredContent (dataOf returns only
    // `.data`), while the text part is the LLM-formatted view.
    const m03Warnings = ((m03Start as { structuredContent?: { warnings?: string[] } })
      .structuredContent?.warnings ?? []) as string[];
    check(
      's85-m03: session start warns that the session is recorded untagged',
      m03Warnings.some((w) => /sprint_id NULL/.test(w)),
      `warnings=${JSON.stringify(m03Warnings)}`
    );
    check(
      's85-m03: the LLM view says "none open — recorded untagged" rather than omitting the sprint line',
      /none open — recorded untagged/.test(h.textOf(m03Start)),
      h.textOf(m03Start).slice(0, 160)
    );

    // Display is deliberately unchanged — onboard still NAMES the Completed sprint.
    const m03Onboard = h.dataOf(await h.callOk('cmos_agent_onboard', { projectRoot: m03Dir })) as {
      currentSprint?: { id?: string } | null;
    };
    check(
      's85-m03: DISPLAY unchanged — onboard still names the Completed sprint',
      m03Onboard?.currentSprint?.id === 'sp-closed',
      `currentSprint=${JSON.stringify(m03Onboard?.currentSprint?.id)}`
    );

    // --- s85-m04 (#487): the WHOLE mission_id path over stdio, not the handler. The router
    //     at cmos-session.ts forwards `missionId` to complete; if that one line regresses,
    //     every handler test still passes and this check is the one that fails.
    const m04Dir = mkTmp('cmos-verify-m04-');
    await h.callOk('cmos_project', {
      action: 'init',
      projectRoot: m04Dir,
      projectName: 'verify-m04',
    });
    await h.callOk('cmos_sprint', {
      action: 'add',
      projectRoot: m04Dir,
      sprintId: 'sp-m04',
      title: 'm04',
      focus: 'verify',
    });
    await h.callOk('cmos_mission', {
      action: 'add',
      projectRoot: m04Dir,
      missionId: 'mv-1',
      name: 'Verify mission',
      sprintId: 'sp-m04',
    });
    await h.callOk('cmos_session', {
      action: 'start',
      type: 'planning',
      title: 'verify m04',
      projectRoot: m04Dir,
    });
    await h.callOk('cmos_session', {
      action: 'complete',
      summary: 'verify m04 close',
      missionId: 'mv-1',
      decisions: ['verify-dist decision stamped to mv-1'],
      nextSteps: ['verify-dist next step stamped to mv-1'],
      projectRoot: m04Dir,
    });

    const m04Decisions = h.dataOf(
      await h.callOk('cmos_decisions', {
        action: 'list',
        missionId: 'mv-1',
        projectRoot: m04Dir,
      })
    ) as { decisions?: Array<{ decision?: string; missionId?: string | null }> };
    check(
      's85-m04: complete(missionId) -> decisions(list, missionId) round-trips the stamped row',
      (m04Decisions?.decisions ?? []).length === 1 &&
        m04Decisions.decisions?.[0]?.missionId === 'mv-1',
      `decisions=${JSON.stringify(m04Decisions?.decisions)}`
    );

    const m04Steps = h.dataOf(
      await h.callOk('cmos_context', {
        action: 'next_steps',
        nextStepAction: 'list',
        missionId: 'mv-1',
        projectRoot: m04Dir,
      })
    ) as { items?: Array<{ missionId?: string | null }> };
    check(
      's85-m04: complete(missionId) also stamps next_steps, and the filter finds it',
      (m04Steps?.items ?? []).length === 1 && m04Steps.items?.[0]?.missionId === 'mv-1',
      `items=${JSON.stringify(m04Steps?.items)}`
    );

    // A mission with nothing stamped returns none rather than everything — proves the
    // predicate is applied rather than ignored.
    const m04Empty = h.dataOf(
      await h.callOk('cmos_decisions', {
        action: 'list',
        missionId: 'mv-absent',
        projectRoot: m04Dir,
      })
    ) as { decisions?: unknown[] };
    check(
      's85-m04: the missionId filter EXCLUDES rather than being ignored',
      (m04Empty?.decisions ?? []).length === 0,
      `decisions=${JSON.stringify(m04Empty?.decisions)}`
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
