// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m10 capstone — pack the tarball, install it into a temp dir, and drive
// the full documented getting-started quickstart over real MCP stdio against the
// INSTALLED server. Guards the published first-run experience against silent breakage.

/**
 * First-run E2E (s77-m10).
 *
 * This is NOT a unit test — it builds + packs the package, installs the tarball into
 * an isolated temp host, and speaks the Model Context Protocol over stdio to the
 * installed dist. It asserts the published artifact announces `cmos-mcp` @ the
 * package version (what siblings consume, not just the repo dist) and that every
 * documented quickstart command works end-to-end.
 *
 * Excluded from the default `npm test` (jest.config.js testPathIgnorePatterns) so the
 * heavy pack/install never runs in the unit suite or touches the coverage floors; run
 * it with `npm run test:e2e-firstrun` (its own jest.e2e.config.js) and in CI.
 *
 * The clean-room boot emits an expected P0 `SENDER_UNRESOLVABLE` on stderr — do NOT
 * assert clean stderr (it would flake). Assert on isError + key substrings.
 *
 * @module tests/e2e/first-run.e2e
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectStdioServer, textOf, dataOf } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

// Collect every tmp dir we create so afterAll can tear them all down.
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let installedServer = ''; // absolute path to the installed dist/index.js
let projectDir = ''; // fresh project cwd for the server
let configDir = ''; // isolated CMOS_CONFIG_DIR
let client: Client;
let transport: StdioClientTransport;

// textOf / dataOf come from the shared stdio harness (s80-m01) so the first-run
// E2E and scripts/verify-dist.ts never drift on payload extraction.

async function callOk(name: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    structuredContent?: { data?: unknown };
  };
  expect({ tool: name, isError: res.isError === true }).toEqual({ tool: name, isError: false });
  return res;
}

describe('first-run E2E: pack -> install -> drive quickstart over stdio (s77-m10)', () => {
  beforeAll(async () => {
    // 1. Build + pack the current tree into an isolated tarball dir.
    const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`npm run build failed:\n${build.stdout}\n${build.stderr}`);
    }
    const packDir = mkTmp('cmos-e2e-pack-');
    const pack = spawnSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (pack.status !== 0) {
      throw new Error(`npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
    }
    const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`no .tgz produced in ${packDir}`);
    const tarball = path.join(packDir, tgz);

    // 2. Install the tarball into a fresh host dir (as a consumer would).
    const hostDir = mkTmp('cmos-e2e-host-');
    fs.writeFileSync(
      path.join(hostDir, 'package.json'),
      JSON.stringify({ name: 'cmos-e2e-host', version: '1.0.0', private: true }) + '\n'
    );
    const install = spawnSync(
      'npm',
      ['install', tarball, '--prefer-offline', '--no-audit', '--no-fund'],
      { cwd: hostDir, encoding: 'utf8' }
    );
    if (install.status !== 0) {
      throw new Error(`npm install <tarball> failed:\n${install.stdout}\n${install.stderr}`);
    }
    installedServer = path.join(hostDir, 'node_modules', PKG.name, 'dist', 'index.js');
    expect(fs.existsSync(installedServer)).toBe(true);

    // 3. Spawn the INSTALLED server over real MCP stdio from a fresh project cwd,
    //    with an isolated config dir and CMOS_PROJECT_ROOT deleted (auto-discovery).
    projectDir = mkTmp('cmos-e2e-project-');
    configDir = mkTmp('cmos-e2e-config-');
    const env = { ...process.env, CMOS_CONFIG_DIR: configDir } as Record<string, string>;
    delete env.CMOS_PROJECT_ROOT;

    // s80-m01: connect via the shared stdio bootstrap (also used by verify:dist).
    const harness = await connectStdioServer({
      serverPath: installedServer,
      cwd: projectDir,
      env,
      clientName: 'first-run-e2e',
    });
    client = harness.client;
    transport = harness.transport;
  }, 180000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('announces cmos-mcp @ the package version and exposes all 15 tools', async () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('cmos-mcp');
    expect(info?.version).toBe(PKG.version);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(15);
  });

  it('`--version` on the installed dist prints cmos-mcp <version> and exits 0', () => {
    const res = spawnSync(process.execPath, [installedServer, '--version'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(`cmos-mcp ${PKG.version}`);
  });

  it('drives the documented quickstart lifecycle end-to-end', async () => {
    // Init a fresh project — the seed store must land in the project cwd.
    await callOk('cmos_project', {
      action: 'init',
      projectRoot: projectDir,
      projectName: 'e2e-first-run',
    });
    expect(fs.existsSync(path.join(projectDir, 'cmos', 'db', 'cmos.sqlite'))).toBe(true);

    // The documented opener (m07) works against the freshly-initialized store.
    const review = await callOk('cmos_review', { projectRoot: projectDir });
    expect(textOf(review).length).toBeGreaterThan(0);

    // Cold-start onboard shows the fresh project + its name.
    const onboard1 = await callOk('cmos_agent_onboard', { projectRoot: projectDir });
    const onboard1Data = dataOf(onboard1);
    expect(onboard1Data?.project?.name).toBe('e2e-first-run');
    expect(onboard1Data?.freshProject).toBe(true);

    // Sprint -> session -> capture -> mission -> transitions -> complete.
    await callOk('cmos_sprint', {
      action: 'add',
      sprintId: 'sprint-01',
      title: 'First sprint',
      focus: 'Ship the first feature',
      projectRoot: projectDir,
    });
    await callOk('cmos_session', {
      action: 'start',
      type: 'planning',
      title: 'Plan sprint 01',
      sprintId: 'sprint-01',
      projectRoot: projectDir,
    });
    await callOk('cmos_session', {
      action: 'capture',
      category: 'decision',
      content: 'Use device-code auth for the dashboard handshake',
      projectRoot: projectDir,
    });
    await callOk('cmos_mission', {
      action: 'add',
      missionId: 's01-m01',
      name: 'First mission',
      sprintId: 'sprint-01',
      objective: 'Deliver the first end-to-end feature',
      successCriteria: ['Feature works', 'Tests pass'],
      projectRoot: projectDir,
    });
    await callOk('cmos_mission_transition', {
      action: 'start',
      missionId: 's01-m01',
      projectRoot: projectDir,
    });
    await callOk('cmos_mission_transition', {
      action: 'complete',
      missionId: 's01-m01',
      notes: 'Shipped the feature end-to-end',
      projectRoot: projectDir,
    });
    await callOk('cmos_session', {
      action: 'complete',
      summary: 'Sprint 01 first mission shipped',
      projectRoot: projectDir,
    });

    // A second onboard reflects the completed mission + the captured decision. The
    // completed mission leaves the pending queue and shows up as real completion
    // activity (onboard doesn't echo completed-mission ids, so assert the signals it
    // actually surfaces).
    const onboard2 = await callOk('cmos_agent_onboard', { projectRoot: projectDir });
    const onboard2Data = dataOf(onboard2);
    const onboard2Text = textOf(onboard2) + JSON.stringify(onboard2Data ?? {});
    expect(onboard2Data?.contextFreshness?.latestMissionCompletionAt).toBeTruthy();
    expect(onboard2Data?.pendingMissions ?? []).toHaveLength(0);
    expect(onboard2Text.toLowerCase()).toContain('device-code auth');

    // cmos_status: 5-field health snapshot, local-only auth tier.
    const status = await callOk('cmos_status', { projectRoot: projectDir });
    const statusText = textOf(status) + JSON.stringify(dataOf(status) ?? {});
    expect(statusText).toContain('auth_tier');
    expect(statusText).toContain('none');
  });
});
