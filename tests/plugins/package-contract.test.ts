// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The marketplace, plugin entrypoints and npm tarball must describe the same usable plugin.
// ABOUTME: Real packaging and structural checks reject missing skills, escaped paths and duplicate sources.

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { inspectNpmPack } from '../docs/npm-pack-inspection';

const ROOT = path.resolve(__dirname, '../..');
const PLUGIN = 'plugins/cmos';
const SKILLS = ['build', 'close-out', 'feedback', 'init', 'plan', 'record-decision', 'start'];
const EVENTS = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end',
} as const;
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = (file: string): any => JSON.parse(read(file));

/** Paths must remain inside the plugin directory; marketplace installs copy only that subtree. */
function containedPath(base: string, relative: string): boolean {
  const resolved = path.resolve(base, relative);
  return resolved.startsWith(`${path.resolve(base)}${path.sep}`);
}

function pluginFiles(directory: string): string[] {
  return fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${directory}/${entry.name}`;
    expect(fs.lstatSync(path.join(ROOT, rel)).isSymbolicLink()).toBe(false);
    return entry.isDirectory() ? pluginFiles(rel) : [rel];
  });
}

describe('the shipped Claude Code plugin', () => {
  it('the marketplace resolves the canonical plugin without a private checkout dependency', () => {
    const marketplace = json('.claude-plugin/marketplace.json');
    expect(marketplace.name).toBe('cmos');
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: 'cmos', source: './plugins/cmos' });
    expect(containedPath(ROOT, marketplace.plugins[0].source)).toBe(true);
    const manifest = json(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(manifest.name).toBe(marketplace.plugins[0].name);
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('every lifecycle hook reaches the same shim with an explicit adapter identity', () => {
    const hooks = json(`${PLUGIN}/hooks/hooks.json`).hooks;
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(EVENTS).sort());
    for (const [event, verb] of Object.entries(EVENTS)) {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event][0].hooks).toHaveLength(1);
      expect(hooks[event][0].hooks[0]).toMatchObject({
        type: 'command',
        command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs" hook ${verb} --hook-source cmos-plugin`,
      });
      expect(hooks[event][0].hooks[0].timeout).toBeGreaterThan(0);
    }
    const server = json(`${PLUGIN}/.mcp.json`).mcpServers;
    expect(Object.keys(server)).toEqual(['cmos']);
    expect(server.cmos).toMatchObject({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs', 'serve'],
    });
    expect(fs.existsSync(path.join(ROOT, PLUGIN, 'hooks/run.mjs'))).toBe(true);
  });

  it('ships every discoverable skill source without symlinks or an outside-subtree feedback copy', () => {
    const directory = path.join(ROOT, PLUGIN, 'skills');
    expect(fs.readdirSync(directory).sort()).toEqual(SKILLS);
    for (const name of SKILLS) {
      const folder = path.join(directory, name);
      const file = path.join(folder, 'SKILL.md');
      expect(fs.lstatSync(folder).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(file).isFile()).toBe(true);
      const source = fs.readFileSync(file, 'utf8');
      const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source);
      expect(frontmatter).not.toBeNull();
      const metadata = parseYaml(frontmatter![1]);
      expect(metadata.name).toBe(name);
      expect(metadata.description).toEqual(expect.any(String));
      expect(metadata.description.trim().length).toBeGreaterThan(20);
    }
    expect(fs.existsSync(path.join(ROOT, 'skills/feedback/SKILL.md'))).toBe(false);
  });

  it('the real npm tarball contains the complete plugin subtree and no old skill copy', () => {
    const packed = inspectNpmPack(ROOT).files;
    for (const rel of [
      `${PLUGIN}/.claude-plugin/plugin.json`,
      `${PLUGIN}/.mcp.json`,
      `${PLUGIN}/hooks/hooks.json`,
      `${PLUGIN}/hooks/run.mjs`,
      ...SKILLS.map((name) => `${PLUGIN}/skills/${name}/SKILL.md`),
    ]) {
      expect({ file: rel, packed: packed.has(rel) }).toEqual({ file: rel, packed: true });
    }
    // Helpers added beside the entrypoint must ship too; validating only run.mjs can hide a broken import.
    expect(pluginFiles(PLUGIN).filter((rel) => !packed.has(rel))).toEqual([]);
    expect([...packed].filter((name) => name.startsWith('skills/'))).toEqual([]);
  }, 30_000);

  it('a relative path cannot escape the plugin boundary', () => {
    expect(containedPath(PLUGIN, 'skills/build/SKILL.md')).toBe(true);
    expect(containedPath(PLUGIN, '../other/skill.md')).toBe(false);
    expect(containedPath(PLUGIN, path.resolve('skills/feedback/SKILL.md'))).toBe(false);
  });
});
