// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m04 over stdio: a project the client's roots or the operator's --project-root named
// ABOUTME: gets no whoami nudge from cmos_review, and one inferred from the working directory does.

/**
 * The in-process tests cover the handler rule; this proves the dispatcher feeds it, from the built
 * dist/index.js with a real client advertising real roots.
 *
 * ISOLATION: HOME and CMOS_CONFIG_DIR are throwaway directories and CMOS_PROJECT_ROOT is unset
 * (setting it is itself a whoami reason). The server therefore bootstraps this repository's .env,
 * which opts into the dashboard; that is why these cases assert whoami and the onboard-only action
 * only, never the dashboard nag (the in-process suite covers a local-only user).
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { seedCmosDb } from '../helpers/seedCmosDb';
import { connectStdioServer, type StdioHarness } from './stdio-harness';

const SERVER = path.resolve(__dirname, '../../dist/index.js');
const WHOAMI = 'cmos_message(action="whoami")';

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(opts: {
  cwd: string;
  home: string;
  roots?: string[];
  serverArgs?: string[];
}): Promise<StdioHarness> {
  const harness = await connectStdioServer({
    serverPath: SERVER,
    cwd: opts.cwd,
    env: {
      HOME: opts.home,
      CMOS_CONFIG_DIR: mkTmp('cmos-e2e-m04-config-'),
      CMOS_CHECKPOINT_SYNC: 'off',
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      NODE_ENV: 'test',
    },
    clientName: 's92-m04-honest-opener',
    ...(opts.roots ? { roots: opts.roots } : {}),
    ...(opts.serverArgs ? { serverArgs: opts.serverArgs } : {}),
  });
  cleanup.push(() => harness.close());
  return harness;
}

interface ReviewAnswer {
  commands: string[];
  resolvedBy: string;
  text: string;
}

async function review(harness: StdioHarness): Promise<ReviewAnswer> {
  const res = await harness.callOk('cmos_review', {});
  const structured = res.structuredContent as {
    data: { next_actions: Array<{ command: string }>; resolvedBy: string };
  };
  return {
    commands: structured.data.next_actions.map((a) => a.command),
    resolvedBy: structured.data.resolvedBy,
    text: harness.textOf(res),
  };
}

function freshProject(): string {
  const projectRoot = mkTmp('cmos-e2e-m04-project-');
  seedCmosDb(projectRoot, { projectName: 's92-m04 e2e' });
  return projectRoot;
}

describe('s92-m04 honest opener over stdio', () => {
  it('POSITIVE CONTROL: a project inferred from the working directory is prescribed whoami', async () => {
    const projectRoot = freshProject();
    const answer = await review(
      await connect({ cwd: projectRoot, home: mkTmp('cmos-e2e-m04-home-') })
    );
    expect(answer.resolvedBy).toBe('cwd');
    expect(answer.commands).toContain(WHOAMI);
    expect(answer.text).toContain(WHOAMI);
  });

  it("a project named by the client's roots is not, and the onboard-only action stays home", async () => {
    const projectRoot = freshProject();
    const home = mkTmp('cmos-e2e-m04-home-');
    const answer = await review(await connect({ cwd: home, home, roots: [projectRoot] }));
    expect(answer.resolvedBy).toBe('mcp-roots');
    expect(answer.commands).not.toContain(WHOAMI);
    expect(answer.commands[0]).toBe('cmos_agent_onboard()');
    expect(answer.text).not.toContain('tierSelectionPrompt');
  });

  it("a project named by the operator's --project-root is not either", async () => {
    const projectRoot = freshProject();
    const home = mkTmp('cmos-e2e-m04-home-');
    const answer = await review(
      await connect({ cwd: home, home, serverArgs: ['--project-root', projectRoot] })
    );
    expect(answer.resolvedBy).toBe('server-project-root');
    expect(answer.commands).not.toContain(WHOAMI);
    expect(answer.commands[0]).toBe('cmos_agent_onboard()');
  });
});
