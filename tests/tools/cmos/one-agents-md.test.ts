// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m12 — one AGENTS.md: what both init paths write (rules, learned practices, one CMOS line, a
// ABOUTME: CLAUDE.md that imports it), the levels, the hook-less block, and the operator profile's guards.

/**
 * The criteria (design doc cmos/planning/s93-the-loop-runs-itself-build.md, m12):
 * - init in a temp folder writes an AGENTS.md of at most 150 lines with the practices block and one
 *   CMOS line, and a CLAUDE.md that imports it (the internal-reference gate scans both templates,
 *   tests/docs/internal-references.test.ts);
 * - `cmos_project(action="init")` and `cmos-mcp init` write the same AGENTS.md;
 * - the seed keeps Builder-level method out (it moves to the plan skill);
 * - `cmos-mcp profile show` prints the profile; a write without an approved draft, or past the
 *   cap, is refused.
 *
 * WHAT COUNTS AS A CMOS LINE: a line naming CMOS (the word in capitals), a `cmos_` tool or the
 * `cmos-mcp` command. The `cmos/` folder in the layout sketch is a path, not CMOS procedure. The
 * hook-less block, between its marker comments, is counted apart, as the G1 review counts it.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { CmosDetector } from '../../../src/intelligence/cmos-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { buildFirstSessionPrompt } from '../../../src/tools/cmos/cmos-agent-onboard';
import { cmosContextViewProjectIdentity } from '../../../src/tools/cmos/cmos-context-project-identity';
import {
  cmosProjectInit,
  formatProjectInitForLLM,
} from '../../../src/tools/cmos/cmos-project-init';
import { cmosProjectUpdate } from '../../../src/tools/cmos/cmos-project-update';
import {
  addProfileLine,
  PROFILE_CAP_CHARS,
  profilePath,
  ProfileWriteRefused,
} from '../../../src/tools/cmos/operator-profile';
import {
  cmosRulesLine,
  LEVEL_QUESTION,
  refreshCmosLine,
} from '../../../src/tools/cmos/rules-files';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE = fs.readFileSync(path.join(REPO_ROOT, 'cmos-seed/templates/AGENTS.md'), 'utf8');
const savedConfigDir = process.env.CMOS_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-s93m12-'));
  process.env.CMOS_CONFIG_DIR = path.join(tmp, 'config');
  CmosDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CMOS_CONFIG_DIR;
  else process.env.CMOS_CONFIG_DIR = savedConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function cli(
  argv: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string[] }> {
  let out = '';
  const err: string[] = [];
  const io: CliIo = {
    env: process.env,
    cwd,
    readStdin: async () => '',
    stdout: (text) => {
      out += text;
    },
    stderr: (line) => {
      err.push(line);
    },
  };
  return { code: await runCli(argv, io), out, err };
}

const HOOKLESS_BLOCK = /<!-- CMOS hook-less block[\s\S]*?<!-- \/CMOS hook-less block -->/;

/** The lines that speak about CMOS itself, outside the labelled hook-less block. */
function cmosLines(agentsMd: string): string[] {
  return agentsMd
    .replace(HOOKLESS_BLOCK, '')
    .split('\n')
    .filter((line) => /\bCMOS\b|\bcmos_[a-z]|cmos-mcp/.test(line));
}

/**
 * A write through the MCP dispatch, which checks the store's identity against the registry (a
 * direct handler call does not, so it cannot see an identity conflict; the confirming critic).
 */
async function dispatchWrite(
  root: string,
  content: string
): Promise<{ ok: boolean; text: string }> {
  CmosDetector.resetInstance();
  const result = await executeMissionProtocolTool(
    'cmos_decisions',
    { action: 'record', content, projectRoot: root },
    await buildMissionProtocolContext()
  );
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  return { ok: result.isError !== true, text };
}

function meta(root: string, key: string): string | undefined {
  const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'), { readonly: true });
  try {
    return (
      db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  } finally {
    db.close();
  }
}

function storedTier(root: string): string | undefined {
  const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'), { readonly: true });
  try {
    return (
      db.prepare(`SELECT value FROM metadata WHERE key = 'project_type'`).get() as
        | { value: string }
        | undefined
    )?.value;
  } finally {
    db.close();
  }
}

describe('s93-m12 — what init writes', () => {
  it('an AGENTS.md of at most 150 lines, with the practices and one CMOS line, and a CLAUDE.md that imports it', async () => {
    const root = folder('fresh');
    const result = await cmosProjectInit({ projectRoot: root });
    expect(result.success).toBe(true);

    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents.trimEnd().split('\n').length).toBeLessThanOrEqual(150);
    expect(agents).toContain('## Hard Operating Rules');
    const practices = agents.slice(agents.indexOf('## Learned Practices'));
    expect(practices.match(/^\d+\. \*\*/gm)?.length).toBeGreaterThanOrEqual(12);

    // Exactly one CMOS line, and it names the level and the opt-out.
    expect(cmosLines(agents)).toEqual([cmosRulesLine('ledger')]);
    expect(cmosLines(agents)[0]).toMatch(/\*\*Ledger\*\* level/);
    expect(cmosLines(agents)[0]).toContain('cmos-mcp ambient off');

    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude.split('\n')).toContain('@AGENTS.md');
    expect(claude).not.toMatch(/mcp__/);
    // A new project with no answer to the init question is a Ledger.
    expect(storedTier(root)).toBe('general');
  });

  it('both init paths write the same AGENTS.md, level by level', async () => {
    for (const [level, tier] of [
      ['ledger', 'general'],
      ['planner', 'managed'],
      ['builder', 'build'],
    ] as const) {
      const viaTool = folder(`tool-${level}`);
      const viaCli = folder(`cli-${level}`);
      await cmosProjectInit({ projectRoot: viaTool, projectType: tier });
      const ran = await cli(['init', '--level', level], viaCli);
      expect(ran.code).toBe(0);
      expect(ran.out).toContain('CMOS record started');
      const read = (root: string) => fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
      expect(read(viaCli)).toBe(read(viaTool));
      expect(storedTier(viaCli)).toBe(tier);
    }
  });

  it('--no-hooks appends the labelled hook-less block, of at most 15 lines, and says so in the CMOS line', async () => {
    const root = folder('hookless');
    expect((await cli(['init', '--no-hooks'], root)).code).toBe(0);
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const block = HOOKLESS_BLOCK.exec(agents)?.[0];
    expect(block).toBeDefined();
    expect(block!.split('\n').length).toBeLessThanOrEqual(15);
    expect(cmosLines(agents)).toEqual([cmosRulesLine('ledger', { hooks: false })]);
    // The hooked file has no such block.
    const hooked = folder('hooked');
    await cli(['init'], hooked);
    expect(fs.readFileSync(path.join(hooked, 'AGENTS.md'), 'utf8')).not.toMatch(HOOKLESS_BLOCK);
  });

  it("a re-init without a level keeps an existing project's level", async () => {
    const root = folder('existing');
    await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    fs.rmSync(path.join(root, 'AGENTS.md'));
    CmosDetector.resetInstance();
    expect((await cli(['init'], root)).code).toBe(0);
    expect(storedTier(root)).toBe('build');
    expect(cmosLines(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))).toEqual([
      cmosRulesLine('builder'),
    ]);
  });

  // The build critic, B1: a re-init used to mint a new project id and blank the name, and every
  // later write was then refused as an identity conflict with the registry.
  it('a re-init through either path keeps the id and name, and the next write succeeds', async () => {
    const root = folder('identity');
    const first = await cmosProjectInit({ projectRoot: root, projectName: 'Alpha' });
    const id = first.data!.projectId;
    expect((await dispatchWrite(root, 'Before a re-init.')).ok).toBe(true);
    expect((await cmosProjectInit({ projectRoot: root })).data!.projectId).toBe(id);
    CmosDetector.resetInstance();
    expect((await cli(['init'], root)).code).toBe(0);

    expect(meta(root, 'project_id')).toBe(id);
    expect(meta(root, 'project_name')).toBe('Alpha');
    expect((await dispatchWrite(root, 'After a re-init.')).ok).toBe(true);
    // The project's identity names its real tier, not the old build default.
    CmosDetector.resetInstance();
    const identity = await cmosContextViewProjectIdentity({ projectRoot: root });
    expect(identity.data?.projectIdentity.tier).toBe('general');
  });

  // The confirming critic, B1: a store the registry already knows but that holds no id (deleted and
  // recreated by the server's own remedy, or its id row lost) got a fresh id from init, so every
  // later write was refused against the registry's.
  it('a store with no id takes the id the registry holds for its folder, through either path', async () => {
    const root = folder('recreated');
    const id = (await cmosProjectInit({ projectRoot: root, projectName: 'Beta' })).data!.projectId;
    expect((await dispatchWrite(root, 'Before the store was lost.')).ok).toBe(true);

    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(root, 'cmos', 'db', `cmos.sqlite${suffix}`), { force: true });
    }
    CmosDetector.resetInstance();
    const lost = await dispatchWrite(root, 'With the store gone.');
    expect(lost.ok).toBe(false);
    expect(lost.text).toContain('cmos_project(action="init"');
    // The remedy the answer names; the answer says it took the registry's id back.
    CmosDetector.resetInstance();
    const remedied = await cmosProjectInit({ projectRoot: root });
    expect(remedied.data!.projectId).toBe(id);
    expect((remedied.warnings ?? []).join('\n')).toContain(
      `init took back the id the project registry holds for it ('${id}')`
    );
    expect((await dispatchWrite(root, 'After the remedy.')).ok).toBe(true);

    // An id row blanked by hand, re-initialized through the CLI.
    const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    db.prepare(`UPDATE metadata SET value = '' WHERE key = 'project_id'`).run();
    db.close();
    CmosDetector.resetInstance();
    expect((await cli(['init'], root)).code).toBe(0);
    expect(meta(root, 'project_id')).toBe(id);
    expect((await dispatchWrite(root, 'After the CLI re-init.')).ok).toBe(true);
  });

  it('a re-init naming another id is refused before it writes anything', async () => {
    const root = folder('refused');
    const id = (await cmosProjectInit({ projectRoot: root })).data!.projectId;
    const seedFile = path.join(root, 'cmos', 'docs', 'README.md');
    fs.rmSync(seedFile);
    const refused = await cmosProjectInit({ projectRoot: root, projectId: 'another-id' });
    expect(refused.success).toBe(false);
    expect(refused.error?.field).toBe('projectId');
    expect(refused.error?.message).toContain(id);
    // Nothing was copied or written on the refused call.
    expect(fs.existsSync(seedFile)).toBe(false);

    // With the store's id row gone, the registry's id is the one a passed id must match.
    const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    db.prepare(`DELETE FROM metadata WHERE key = 'project_id'`).run();
    db.close();
    CmosDetector.resetInstance();
    const againstRegistry = await cmosProjectInit({ projectRoot: root, projectId: 'another-id' });
    expect(againstRegistry.success).toBe(false);
    expect(againstRegistry.error?.message).toContain(id);
    expect(meta(root, 'project_id')).toBeUndefined();
  });

  it("a re-init keeps the registry's name, and a new name or level reaches the identity", async () => {
    const root = folder('named-later');
    await cmosProjectInit({ projectRoot: root });
    CmosDetector.resetInstance();
    const registered = await executeMissionProtocolTool(
      'cmos_project',
      { action: 'register', projectRoot: root, name: 'Foo' },
      await buildMissionProtocolContext()
    );
    expect(registered.isError).not.toBe(true);
    ProjectGraphRegistry.resetInstance();
    CmosDetector.resetInstance();
    expect((await cli(['init'], root)).code).toBe(0);
    const registryName = async () => {
      ProjectGraphRegistry.resetInstance();
      const graph = await ProjectGraphRegistry.create();
      return graph.get(graph.getByStorePath(root)!)?.name;
    };
    expect(await registryName()).toBe('Foo');

    // A write seeds the identity row; a re-init with a new name and level then updates it.
    expect((await dispatchWrite(root, 'Seeds the identity row.')).ok).toBe(true);
    CmosDetector.resetInstance();
    await cmosProjectInit({ projectRoot: root, projectName: 'Gamma', projectType: 'managed' });
    CmosDetector.resetInstance();
    const identity = await cmosContextViewProjectIdentity({ projectRoot: root });
    expect(identity.data?.projectIdentity.project_name).toBe('Gamma');
    expect(identity.data?.projectIdentity.tier).toBe('managed');
    expect(await registryName()).toBe('Gamma');
  });

  // The second confirming critic, B1: a folder with no cmos/ at a registered project's old path is a
  // new project. Taking the registry's id for it left two stores sharing one, and every write in the
  // moved project was refused.
  it("a new project at a moved project's old path gets its own id, and both keep writing", async () => {
    const app = folder('app');
    const idA = (await cmosProjectInit({ projectRoot: app, projectName: 'A' })).data!.projectId;
    expect((await dispatchWrite(app, 'In A, before the move.')).ok).toBe(true);
    const archived = path.join(tmp, 'app-archived');
    fs.renameSync(app, archived);
    fs.mkdirSync(app);
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const b = await cmosProjectInit({ projectRoot: app, projectName: 'B' });
    expect(b.success).toBe(true);
    expect(b.data!.projectId).not.toBe(idA);
    expect((await dispatchWrite(app, 'In B.')).ok).toBe(true);
    ProjectGraphRegistry.resetInstance();
    expect((await dispatchWrite(archived, 'In A, after the move.')).ok).toBe(true);

    // The same through the CLI after the folder is removed outright.
    fs.rmSync(app, { recursive: true, force: true });
    fs.mkdirSync(app);
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    expect((await cli(['init'], app)).code).toBe(0);
    expect(meta(app, 'project_id')).not.toBe(b.data!.projectId);
    expect((await dispatchWrite(app, 'In the third project.')).ok).toBe(true);
  });

  // The second confirming critic, B2: the quick starts init at the Builder level, so a re-init with a
  // level is a documented route, and the CMOS line must follow it.
  it('a re-init with a level moves the CMOS line too, through either path', async () => {
    const root = folder('relevel');
    await cmosProjectInit({ projectRoot: root });
    const line = () => cmosLines(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))[0];
    expect(line()).toBe(cmosRulesLine('ledger'));
    CmosDetector.resetInstance();
    const viaTool = await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    expect(line()).toBe(cmosRulesLine('builder'));
    expect((viaTool.warnings ?? []).join('\n')).toContain(
      "AGENTS.md's CMOS line now names the Builder level"
    );
    CmosDetector.resetInstance();
    expect((await cli(['init', '--level', 'planner'], root)).code).toBe(0);
    expect(line()).toBe(cmosRulesLine('planner'));
    expect(storedTier(root)).toBe('managed');
  });

  it('a recreated store takes back its level from the CMOS line and its name from the registry', async () => {
    const root = folder('recreated-level');
    await cmosProjectInit({ projectRoot: root, projectName: 'Delta', projectType: 'build' });
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(root, 'cmos', 'db', `cmos.sqlite${suffix}`), { force: true });
    }
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root });
    expect(again.data?.projectName).toBe('Delta');
    expect(storedTier(root)).toBe('build');
    expect(meta(root, 'project_name')).toBe('Delta');
  });

  it('says so when the store and the registry already disagree about the id, and changes neither', async () => {
    const root = folder('disagree');
    const id = (await cmosProjectInit({ projectRoot: root })).data!.projectId;
    const db = new Database(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    db.prepare(`UPDATE metadata SET value = 'other-id' WHERE key = 'project_id'`).run();
    db.close();
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root });
    expect(again.success).toBe(true);
    const warned = (again.warnings ?? []).join('\n');
    expect(warned).toContain("'other-id'");
    expect(warned).toContain(`'${id}'`);
    expect(warned).toContain('cmos_project(action="unregister"');
    expect(meta(root, 'project_id')).toBe('other-id');
    ProjectGraphRegistry.resetInstance();
    const graph = await ProjectGraphRegistry.create();
    expect(graph.getByStorePath(root)).toBe(id);
  });

  it('the CLI refuses a folder inside another project, a contextless folder and an unknown level', async () => {
    const outer = folder('outer');
    await cmosProjectInit({ projectRoot: outer });
    const inner = path.join(outer, 'src');
    fs.mkdirSync(inner);
    const nested = await cli(['init'], inner);
    expect(nested.code).toBe(1);
    expect(nested.err[0]).toContain('inside the CMOS project');
    expect(fs.existsSync(path.join(inner, 'cmos'))).toBe(false);

    // A contextless folder is refused, by the guard and not by the filesystem: the filesystem root
    // stands in for the home folder (the same rule covers both, and even a regressed guard could not
    // write there; jest's process.env is a copy, so a stand-in HOME would not reach os.homedir()).
    const contextless = await cli(['init'], path.parse(os.tmpdir()).root);
    expect(contextless.code).toBe(1);
    expect(contextless.err.join('\n')).toContain('is not a project folder');
    expect((await cli(['init', '--level', 'expert'], folder('typo'))).code).toBe(1);
  });

  // The build critic: the one CMOS line must not go stale when the level or the hooks change.
  it("the CMOS line follows a level change and an ambient change, and leaves a project's own file alone", async () => {
    const root = folder('follows');
    await cmosProjectInit({ projectRoot: root });
    const agentsLine = () => cmosLines(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))[0];
    CmosDetector.resetInstance();
    const updated = await cmosProjectUpdate({ projectRoot: root, projectType: 'managed' });
    expect(updated.success).toBe(true);
    expect(agentsLine()).toBe(cmosRulesLine('planner'));
    expect((updated.warnings ?? []).join('\n')).toContain("AGENTS.md's CMOS line now names");

    expect((await cli(['ambient', 'off'], root)).code).toBe(0);
    expect(agentsLine()).toBe(cmosRulesLine('planner', { hooks: true, ambient: 'off' }));
    expect((await cli(['ambient', 'on'], root)).code).toBe(0);
    expect(agentsLine()).toBe(cmosRulesLine('planner'));

    const own = folder('own-rules');
    await cmosProjectInit({ projectRoot: own });
    fs.writeFileSync(path.join(own, 'AGENTS.md'), '# Our rules\n\nNo CMOS line here.\n');
    CmosDetector.resetInstance();
    await cmosProjectUpdate({ projectRoot: own, projectType: 'build' });
    expect(fs.readFileSync(path.join(own, 'AGENTS.md'), 'utf8')).toBe(
      '# Our rules\n\nNo CMOS line here.\n'
    );
  });

  // The confirming critic: a refresh rewrites only a line exactly as CMOS rendered it, through a
  // symlink, keeping the file's mode and line endings, and never a file the user made read-only.
  it('a refresh leaves an edited line, a read-only file and an unchanged CRLF file alone', async () => {
    const root = folder('refresh-edges');
    await cmosProjectInit({ projectRoot: root });
    const file = path.join(root, 'AGENTS.md');
    const original = fs.readFileSync(file, 'utf8');

    const edited = original.replace(
      cmosRulesLine('ledger'),
      `${cmosRulesLine('ledger')} Ask Dana first.`
    );
    fs.writeFileSync(file, edited);
    expect(refreshCmosLine(root, { level: 'builder' })).toMatchObject({
      outcome: 'left',
      why: 'edited by hand',
      line: cmosRulesLine('builder'),
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
    // An edit that leaves the line saying what the project is needs nothing said about it.
    expect(refreshCmosLine(root, { level: 'ledger' })?.outcome).toBe('unchanged');

    const crlf = original.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, crlf);
    expect(refreshCmosLine(root, { level: 'ledger' })?.outcome).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(crlf);
    expect(refreshCmosLine(root, { level: 'planner' })?.outcome).toBe('rewritten');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      crlf.replace(cmosRulesLine('ledger'), cmosRulesLine('planner'))
    );

    fs.chmodSync(file, 0o444);
    try {
      expect(refreshCmosLine(root, { level: 'builder' })).toMatchObject({
        outcome: 'left',
        why: 'read-only',
      });
      expect(fs.readFileSync(file, 'utf8')).toContain(cmosRulesLine('planner'));
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it('a refresh writes through a symlinked agents file and keeps its mode', async () => {
    const root = folder('refresh-link');
    await cmosProjectInit({ projectRoot: root });
    const target = path.join(folder('shared-rules'), 'AGENTS.md');
    fs.renameSync(path.join(root, 'AGENTS.md'), target);
    // Group-writable: a mode given when the new file is created would pass through the umask.
    fs.chmodSync(target, 0o664);
    fs.symlinkSync(target, path.join(root, 'AGENTS.md'));
    expect(refreshCmosLine(root, { level: 'builder' })?.outcome).toBe('rewritten');
    expect(fs.lstatSync(path.join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain(cmosRulesLine('builder'));
    expect(fs.statSync(target).mode & 0o777).toBe(0o664);
  });

  // The third confirming critic: a new store with no level passed takes the level its folder's
  // agents file names (a team's committed file), and the answer says where the level came from.
  it("a new project takes the level its folder's AGENTS.md names, and the answer says so", async () => {
    const team = folder('team-clone');
    fs.writeFileSync(
      path.join(team, 'AGENTS.md'),
      TEMPLATE.split('\n')
        .map((line) =>
          line.startsWith("CMOS keeps this project's record at the ")
            ? cmosRulesLine('builder')
            : line
        )
        .join('\n')
    );
    const cloned = await cmosProjectInit({ projectRoot: team });
    expect(cloned.data).toMatchObject({ level: 'builder', levelSource: 'agents-file' });
    expect(storedTier(team)).toBe('build');
    expect(formatProjectInitForLLM(cloned)).toContain(
      "**Level**: Builder (from the agents file's CMOS line)"
    );

    const fresh = await cli(['init'], folder('no-rules-yet'));
    expect(fresh.out).toContain(
      'Level: Ledger (the default for a new project; --level changes it).'
    );
  });

  it('a re-init with a level says what it left: a line edited by hand', async () => {
    const root = folder('edited-left');
    await cmosProjectInit({ projectRoot: root });
    const file = path.join(root, 'AGENTS.md');
    const edited = fs
      .readFileSync(file, 'utf8')
      .replace(cmosRulesLine('ledger'), `${cmosRulesLine('ledger')} Ask Dana first.`);
    fs.writeFileSync(file, edited);
    CmosDetector.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    expect((again.warnings ?? []).join('\n')).toContain(
      `AGENTS.md's CMOS line was edited by hand, so CMOS left it; for this project it would read: ${cmosRulesLine('builder')}`
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
  });

  it('a recreated store takes back the level of an edited line and the hooks setting the line names', async () => {
    const root = folder('recreated-edited');
    await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    CmosDetector.resetInstance();
    expect((await cli(['ambient', 'off'], root)).code).toBe(0);
    const file = path.join(root, 'AGENTS.md');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(
          cmosRulesLine('builder', { hooks: true, ambient: 'off' }),
          `${cmosRulesLine('builder', { hooks: true, ambient: 'off' })} Edited.`
        )
    );
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(root, 'cmos', 'db', `cmos.sqlite${suffix}`), { force: true });
    }
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root });
    expect(again.data).toMatchObject({ level: 'builder', levelSource: 'agents-file' });
    expect(meta(root, 'ambient')).toBe('off');
  });

  it('points out a CMOS line that names another level than the store, and changes nothing', async () => {
    const root = folder('three-way');
    await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    const file = path.join(root, 'AGENTS.md');
    const planner = fs
      .readFileSync(file, 'utf8')
      .replace(cmosRulesLine('builder'), cmosRulesLine('planner'));
    fs.writeFileSync(file, planner);
    CmosDetector.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root });
    expect((again.warnings ?? []).join('\n')).toContain(
      'says the Planner level with the hooks on, but this project is at the Builder level'
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(planner);
    expect(storedTier(root)).toBe('build');
  });

  it("keeps the registry's default for a project that moved, and says what it dropped", async () => {
    const app = folder('default-app');
    const idA = (await cmosProjectInit({ projectRoot: app })).data!.projectId;
    ProjectGraphRegistry.resetInstance();
    const graph = await ProjectGraphRegistry.create();
    graph.setDefault(idA, { confirmed: true });
    const archived = path.join(tmp, 'default-app-archived');
    fs.renameSync(app, archived);
    fs.mkdirSync(app);
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const b = await cmosProjectInit({ projectRoot: app });
    expect((b.warnings ?? []).join('\n')).toContain(
      `The project registry held '${idA}' for this folder`
    );
    ProjectGraphRegistry.resetInstance();
    expect((await dispatchWrite(archived, 'A writes from its new place.')).ok).toBe(true);
    ProjectGraphRegistry.resetInstance();
    expect((await ProjectGraphRegistry.create()).getDefault()?.project_id).toBe(idA);
  });

  it('says when the registry could not be read, and still initializes', async () => {
    const root = folder('no-registry');
    const blocked = path.join(tmp, 'config-is-a-file');
    fs.writeFileSync(blocked, 'not a folder');
    process.env.CMOS_CONFIG_DIR = blocked;
    ProjectGraphRegistry.resetInstance();
    const result = await cmosProjectInit({ projectRoot: root });
    expect(result.success).toBe(true);
    expect((result.warnings ?? []).join('\n')).toContain('The project registry could not be read');
  });

  // The fourth confirming critic: the remedies the warnings name must work when run.
  it('a line that says the hooks are off is pointed out, and the update it names re-renders it', async () => {
    const root = folder('hooks-mismatch');
    await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    const file = path.join(root, 'AGENTS.md');
    const off = cmosRulesLine('builder', { hooks: true, ambient: 'off' });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(cmosRulesLine('builder'), off));
    CmosDetector.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root });
    const warned = (again.warnings ?? []).join('\n');
    expect(warned).toContain(
      'says the Builder level with the hooks off, but this project is at the Builder level with the hooks on'
    );
    expect(warned).toContain('`cmos-mcp ambient off` sets the hooks as the line says');
    CmosDetector.resetInstance();
    const updated = await cmosProjectUpdate({ projectRoot: root, projectType: 'build' });
    expect((updated.warnings ?? []).join('\n')).toContain(
      "AGENTS.md's CMOS line now says the hooks are on."
    );
    expect(cmosLines(fs.readFileSync(file, 'utf8'))).toEqual([cmosRulesLine('builder')]);

    // And the other way: the hooks are off in the store, and a line that says on follows the store.
    CmosDetector.resetInstance();
    expect((await cli(['ambient', 'off'], root)).code).toBe(0);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(off, cmosRulesLine('builder')));
    CmosDetector.resetInstance();
    await cmosProjectUpdate({ projectRoot: root, projectType: 'build' });
    expect(cmosLines(fs.readFileSync(file, 'utf8'))).toEqual([off]);
  });

  it("a team's AGENTS.md never turns a new project's hooks off; it is pointed out", async () => {
    const team = folder('team-hooks-off');
    fs.writeFileSync(
      path.join(team, 'AGENTS.md'),
      TEMPLATE.split('\n')
        .map((line) =>
          line.startsWith("CMOS keeps this project's record at the ")
            ? cmosRulesLine('builder', { hooks: true, ambient: 'off' })
            : line
        )
        .join('\n')
    );
    const ran = await cli(['init'], team);
    expect(ran.code).toBe(0);
    expect(meta(team, 'ambient')).toBeUndefined();
    expect(ran.out).toContain('Level: Builder (from the agents file');
    expect(ran.out).toContain(
      'with the hooks off, but this project is at the Builder level with the hooks on'
    );
  });

  it('a recreated store that takes the hooks setting back from its line says so', async () => {
    const root = folder('recreated-hooks');
    await cmosProjectInit({ projectRoot: root });
    CmosDetector.resetInstance();
    expect((await cli(['ambient', 'off'], root)).code).toBe(0);
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(root, 'cmos', 'db', `cmos.sqlite${suffix}`), { force: true });
    }
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root });
    expect(meta(root, 'ambient')).toBe('off');
    expect((again.warnings ?? []).join('\n')).toContain(
      "The hooks are off here, as AGENTS.md's CMOS line says: this store was recreated in place. `cmos-mcp ambient on` turns them back on."
    );
  });

  it('a copy of a live project says it is a copy, and names no remedy that fails', async () => {
    const original = folder('original');
    const id = (await cmosProjectInit({ projectRoot: original })).data!.projectId;
    const copy = path.join(tmp, 'copy');
    fs.cpSync(original, copy, { recursive: true });
    CmosDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    const result = await cmosProjectInit({ projectRoot: copy });
    const warned = (result.warnings ?? []).join('\n');
    expect(warned).toContain(`This store holds the id '${id}' of the project at`);
    expect(warned).toContain('a copy of a live project cannot be registered beside it');
    expect(warned).not.toContain('cmos_project(action="register"');
  });

  it("a hook-less line's change names only the level; ambient proposes the project's real level", async () => {
    const root = folder('hookless-relevel');
    expect((await cli(['init', '--no-hooks'], root)).code).toBe(0);
    // A hook-less line names no hooks setting, so turning the hooks off changes nothing in it.
    expect((await cli(['ambient', 'off'], root)).code).toBe(0);
    CmosDetector.resetInstance();
    const again = await cmosProjectInit({ projectRoot: root, projectType: 'build' });
    const warned = (again.warnings ?? []).join('\n');
    expect(warned).toContain("AGENTS.md's CMOS line now names the Builder level.");
    expect(warned).not.toContain('hooks are');

    const edited = folder('edited-no-level');
    await cmosProjectInit({ projectRoot: edited, projectType: 'build' });
    const file = path.join(edited, 'AGENTS.md');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(
          cmosRulesLine('builder'),
          "CMOS keeps this project's record at the level we chose."
        )
    );
    CmosDetector.resetInstance();
    const ran = await cli(['ambient', 'off'], edited);
    expect(ran.out).toContain(
      `was edited by hand, so CMOS left it; for this project it would read: ${cmosRulesLine('builder', { hooks: true, ambient: 'off' })}`
    );
  });

  it('a re-init after the hooks were turned off writes the line that says so', async () => {
    const root = folder('ambient-off');
    await cmosProjectInit({ projectRoot: root });
    CmosDetector.resetInstance();
    expect((await cli(['ambient', 'off'], root)).code).toBe(0);
    fs.rmSync(path.join(root, 'AGENTS.md'));
    CmosDetector.resetInstance();
    await cmosProjectInit({ projectRoot: root });
    expect(cmosLines(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))).toEqual([
      cmosRulesLine('ledger', { hooks: true, ambient: 'off' }),
    ]);
  });

  it('says what it left undone: a CLAUDE.md that does not import the agents file, a skipped block', async () => {
    const root = folder('undone');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Our Claude notes\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Our rules\n');
    const ran = await cli(['init', '--no-hooks'], root);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('CLAUDE.md does not import AGENTS.md');
    expect(ran.out).toContain('the hook-less block was not added');
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('# Our Claude notes\n');
  });

  it('a folder named with --project-root inside another project is initialized, as the MCP tool does', async () => {
    const outer = folder('outer-explicit');
    await cmosProjectInit({ projectRoot: outer });
    const inner = path.join(outer, 'packages', 'app');
    fs.mkdirSync(inner, { recursive: true });
    CmosDetector.resetInstance();
    expect((await cli(['init', '--project-root', inner], outer)).code).toBe(0);
    expect(fs.existsSync(path.join(inner, 'cmos', 'db', 'cmos.sqlite'))).toBe(true);
  });

  it('asks one question in prose, naming the three levels', () => {
    expect(LEVEL_QUESTION).toMatch(/decisions and lessons.*next steps.*sprints and missions\?$/);
  });
});

// The build critic, B3: with Ledger the default, every new project's first onboard hands the agent
// this prompt, so it must say what the general guide says. Its calls run in the seed sweep.
describe('s93-m12 — a new project hears what its tier guide says', () => {
  it('the general first-session prompt starts no session, as the general guide says', () => {
    const guide = fs.readFileSync(path.join(REPO_ROOT, 'cmos-seed/tiers/general.md'), 'utf8');
    expect(guide).toContain('There is nothing to start or finish.');
    expect(guide).not.toContain('cmos_session(action="start"');
    expect(buildFirstSessionPrompt()).not.toContain('cmos_session(action="start"');
    expect(buildFirstSessionPrompt()).toContain('there is no session to start');
  });
});

describe('s93-m12 — the seed carries learned practices, not Builder-level method', () => {
  // The Process Hardening test (tests/docs/shipped-prose-truth.test.ts) keeps this repo's method out
  // of the seed; the practices block is admitted, and Builder-only method (critics, live ADR checks,
  // mission authoring, delegation, design docs) moves to the plan skill.
  it('has the practices block and no Builder-only method', () => {
    expect(TEMPLATE).toContain('## Learned Practices');
    expect(TEMPLATE).not.toMatch(/Process Hardening/);
    expect(TEMPLATE).not.toMatch(/\bcritic|\bADR\b|mission authoring|delegat|design doc/i);
  });

  it('cites nothing a stranger cannot follow and names no tool prefix', () => {
    expect(TEMPLATE).not.toMatch(/\bs\d{1,3}-m\d{2}\b|decision #\d+|#\d{3,4}\b|mcp__/);
  });
});

describe('s93-m12 — the operator profile', () => {
  it('profile show prints it with its size, and says where it lives when there is none', async () => {
    const none = await cli(['profile', 'show'], tmp);
    expect(none.code).toBe(0);
    expect(none.out).toContain(profilePath());

    fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
    fs.writeFileSync(profilePath(), '1. Ask in prose.\n');
    const shown = await cli(['profile', 'show'], tmp);
    expect(shown.out).toContain('1. Ask in prose.');
    expect(shown.out).toContain(`of ${PROFILE_CAP_CHARS} characters`);
  });

  it('an agent write without an approved profile draft is refused, and writes nothing', () => {
    expect(() => addProfileLine('Always use tabs.', null)).toThrow(ProfileWriteRefused);
    expect(() =>
      addProfileLine('Always use tabs.', {
        kind: 'profile',
        status: 'approved',
        draftId: 'd1',
        line: 'A different line.',
      })
    ).toThrow(ProfileWriteRefused);
    expect(fs.existsSync(profilePath())).toBe(false);

    const written = addProfileLine('Always use tabs.', {
      kind: 'profile',
      status: 'approved',
      draftId: 'd2',
      line: 'Always use tabs.',
    });
    expect(written.text).toBe('Always use tabs.\n');
  });

  it('a line past the cap is refused with the cap named, and the profile is never cut', () => {
    fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
    const full = `${'x'.repeat(PROFILE_CAP_CHARS - 10)}\n`;
    fs.writeFileSync(profilePath(), full);
    const line = 'One more preference.';
    expect(() =>
      addProfileLine(line, { kind: 'profile', status: 'approved', draftId: 'd3', line })
    ).toThrow(new RegExp(`capped at ${PROFILE_CAP_CHARS} characters`));
    expect(fs.readFileSync(profilePath(), 'utf8')).toBe(full);
  });
});
