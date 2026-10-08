// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m01 over real MCP stdio against the BUILT dist/: the Claude Desktop recipe
// ABOUTME: (--project-root with 2+ registered projects) and the contextless refusal without it.

/**
 * Claude Desktop launches a server with no project context: no roots, and a working directory that
 * says nothing about the user's project. Before s92-m01 the only remedy was a machine-global
 * registry default, which every other harness's contextless calls would also pick up. The recipe
 * is now a `--project-root <dir>` argument in that one server's config. These tests drive the
 * built server exactly as Desktop would: cwd `/`, an isolated HOME and registry holding two
 * projects, and the flag in argv.
 *
 * ISOLATION: a literal environment whitelist. CMOS_PROJECT_ROOT points at an empty directory so the
 * server cannot bootstrap the repository's .env (which carries real dashboard settings), and
 * checkpoint sync is off.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { connectStdioServer, dataOf, textOf, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

const tmpDirs: string[] = [];
const harnesses: StdioHarness[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

describe('s92-m01 resolution safety over built stdio', () => {
  let home: string;
  let configDir: string;
  let envRoot: string;
  let projectA: string;
  let projectB: string;

  function environment(): Record<string, string> {
    return {
      HOME: home,
      CMOS_CONFIG_DIR: configDir,
      CMOS_PROJECT_ROOT: envRoot,
      CMOS_CHECKPOINT_SYNC: 'off',
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      NODE_ENV: 'test',
    };
  }

  async function server(cwd: string, serverArgs: string[] = []): Promise<StdioHarness> {
    const harness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd,
      env: environment(),
      clientName: 's92-m01-resolution-e2e',
      serverArgs,
    });
    harnesses.push(harness);
    return harness;
  }

  beforeAll(async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; run ` +
          '`npm run build` first. It must never skip when the artifact is absent.'
      );
    }
    home = mkTmp('cmos-s92m01-home-');
    configDir = mkTmp('cmos-s92m01-config-');
    envRoot = mkTmp('cmos-s92m01-envroot-');
    projectA = mkTmp('cmos-s92m01-project-a-');
    projectB = mkTmp('cmos-s92m01-project-b-');

    // Two registered projects: the topology in which the old registry-singleton step was silent
    // and a global default was the only Desktop remedy.
    const setup = await server(mkTmp('cmos-s92m01-setup-cwd-'));
    for (const [root, name] of [
      [projectA, 'Desktop Project A'],
      [projectB, 'Desktop Project B'],
    ] as const) {
      await setup.callOk('cmos_project', { action: 'init', projectRoot: root, projectName: name });
    }
    const listed = dataOf(await setup.callOk('cmos_project', { action: 'list' }));
    expect(listed.projects.map((p: { projectRoot: string }) => p.projectRoot).sort()).toEqual(
      [projectA, projectB].sort()
    );
  }, 120_000);

  afterAll(async () => {
    for (const harness of harnesses) await harness.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the Desktop recipe: --project-root routes a contextless call to that project and says so', async () => {
    const desktop = await server('/', ['--project-root', projectA]);

    const recorded = await desktop.callOk('cmos_decisions', {
      action: 'record',
      content: 'Recorded through the Claude Desktop recipe',
    });
    expect(dataOf(recorded)).toMatchObject({
      projectRoot: projectA,
      resolvedBy: 'server-project-root',
    });
    expect(textOf(recorded)).toMatch(
      new RegExp(
        `^Project: ${projectA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(resolved by --project-root in this server's config\\)`
      )
    );

    const review = await desktop.callOk('cmos_review', {});
    expect(dataOf(review)).toMatchObject({
      projectRoot: projectA,
      resolvedBy: 'server-project-root',
    });

    // An explicit projectRoot still wins over the server's default.
    const explicit = await desktop.callOk('cmos_decisions', {
      action: 'list',
      projectRoot: projectB,
    });
    expect(dataOf(explicit)).toMatchObject({ projectRoot: projectB, resolvedBy: 'explicit' });
  }, 120_000);

  it('without --project-root, a contextless call is refused and names both remedies', async () => {
    const desktop = await server('/');
    const result = await desktop.callTool('cmos_decisions', { action: 'list' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({ code: 'CMOS_NOT_DETECTED' });
    expect(result.structuredContent?.error?.message).toContain(
      "the server's working directory '/' carries no project context"
    );
    expect(result.structuredContent?.error?.suggestion).toContain('"--project-root"');
  }, 120_000);

  it('a real working folder outside any project refuses even with --project-root configured', async () => {
    const folder = mkTmp('cmos-s92m01-working-folder-');
    const configured = await server(folder, ['--project-root', projectA]);
    const result = await configured.callTool('cmos_decisions', {
      action: 'record',
      content: 'Must not land in project A',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      code: 'CMOS_NOT_DETECTED',
      message: `No CMOS project in '${folder}'. Nothing was written.`,
    });
  }, 120_000);
});
