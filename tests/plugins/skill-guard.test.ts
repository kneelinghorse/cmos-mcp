// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s95-m08 — every developer skill stops when the Reasonbook tools are absent, telling an install in
// ABOUTME: progress (start a new session) from a missing local server (install pointer), per decision #1305.

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SKILLS = ['build', 'close-out', 'feedback', 'init', 'plan', 'record-decision', 'start'];
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A skill's body as the agent reads it, frontmatter removed. */
function body(name: string): string {
  return read(`plugins/reasonbook/skills/${name}/SKILL.md`).replace(
    /^---\r?\n[\s\S]+?\r?\n---\r?\n/,
    ''
  );
}

const GUARD = /\*\*First, check that the Reasonbook tools are here\.\*\*[\s\S]+?#readme\.\n/;

describe('s95-m08: the developer skills guard against absent Reasonbook tools', () => {
  it('each skill opens with the same guard, before any other instruction', () => {
    const guards = SKILLS.map((name) => {
      const text = body(name);
      const match = GUARD.exec(text);
      expect({ name, guarded: match !== null }).toEqual({ name, guarded: true });
      // Only the heading comes before it, so no tool is called and nothing is read first.
      expect(text.slice(0, match!.index).trim()).toMatch(/^# Reasonbook [\w-]+$/);
      expect(text.match(new RegExp(GUARD.source, 'g'))).toHaveLength(1);
      return match![0];
    });
    expect(new Set(guards).size).toBe(1);
  });

  it('the guard tells installing from no server, and names what to do in each case', () => {
    const guard = GUARD.exec(body('start'))![0].replace(/\s+/g, ' ');
    expect(guard).toContain('do not do the work: stop');
    expect(guard).toContain(
      "If the session-start message or the server's instructions say Reasonbook is installing, they should start a new session once installation finishes."
    );
    expect(guard).toContain(
      'Otherwise Reasonbook needs its local server, which runs in Claude Code or Codex but not in claude.ai chat'
    );
    expect(guard).toContain('https://github.com/kneelinghorse/reasonbook#readme');
  });

  it('the installing signals the guard relies on are the ones the plugin sends', () => {
    // While it installs, the plugin's server lists no tools and its instructions say it is installing,
    // and the session-start hook says so too. If either wording moved, the guard would stop matching.
    for (const plugin of ['plugins/reasonbook/hooks', 'plugins/reasonbook-chat/server']) {
      const server = read(`${plugin}/installing-server.mjs`);
      expect(server).toContain('result = { tools: [] }');
      expect(server).toContain(
        "'Reasonbook is installing in the background. Start a new session once installation finishes to load the project tools.'"
      );
    }
    expect(read('plugins/reasonbook/hooks/run.mjs')).toContain(
      "additionalContext: 'Reasonbook is installing; the record loads from the next session'"
    );
  });
});
