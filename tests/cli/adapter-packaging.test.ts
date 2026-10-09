// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps portable hook configuration installable from the published package.
// ABOUTME: Each native schema exposes only lifecycle events whose context contract CMOS supports.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

interface Command {
  type?: string;
  command?: string;
  bash?: string;
  powershell?: string;
  timeout?: number;
  timeoutSec?: number;
}

interface Group {
  matcher?: string;
  hooks: Command[];
}

const adapters = [
  ['codex', 'adapters/codex/hooks.json'],
  ['cursor', 'adapters/cursor/hooks.json'],
  ['devin', 'adapters/devin/hooks.v1.json'],
  ['copilot', 'adapters/copilot/cmos.json'],
  ['vscode', 'adapters/vscode/cmos.json'],
] as const;

function commands(harness: string, file: string): Array<[string, Command]> {
  const config = read(file);
  const events = harness === 'devin' ? config : config.hooks;
  return Object.entries(events).flatMap(([event, entries]) =>
    (entries as Array<Command | Group>).flatMap((entry) =>
      ('hooks' in entry ? entry.hooks : [entry]).map((command): [string, Command] => [
        event,
        command,
      ])
    )
  );
}

describe('portable adapter installation contract', () => {
  it('includes every install source and its coverage guide in an actual npm pack manifest', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-adapter-pack-'));
    try {
      const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: root,
        env: { ...process.env, npm_config_cache: cache, npm_config_offline: 'true' },
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(packed.status).toBe(0);
      const entries = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
      expect(entries).toHaveLength(1);
      const shipped = entries[0].files.map((file) => file.path);
      expect(shipped).toEqual(
        expect.arrayContaining([
          ...adapters.map(([, file]) => file),
          'adapters/devin/config.json',
          'docs/harnesses.md',
        ])
      );
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it('keeps partial harnesses start-only instead of claiming unsupported prompt injection', () => {
    for (const [harness, file] of adapters.filter(([name]) =>
      ['cursor', 'copilot', 'vscode'].includes(name)
    )) {
      const config = read(file);
      expect(Object.keys(config.hooks)).toEqual([
        harness === 'vscode' ? 'SessionStart' : 'sessionStart',
      ]);
      if (harness === 'vscode') expect(config).not.toHaveProperty('version');
      else expect(config.version).toBe(1);
      expect(config.hooks[Object.keys(config.hooks)[0]]).toHaveLength(1);
    }
  });

  it('uses native nested commands for Codex and the unwrapped native Devin event map', () => {
    const codex = read('adapters/codex/hooks.json');
    expect(Object.keys(codex.hooks).sort()).toEqual(
      ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd'].sort()
    );
    const devin = read('adapters/devin/hooks.v1.json');
    expect(devin).not.toHaveProperty('hooks');
    // Devin documents no Stop reply or pre-compaction input supported by CMOS.
    expect(Object.keys(devin).sort()).toEqual(
      ['SessionStart', 'UserPromptSubmit', 'SessionEnd'].sort()
    );
    for (const events of [codex.hooks, devin]) {
      for (const groups of Object.values(events) as Group[][]) {
        expect(groups).toHaveLength(1);
        expect(groups[0].hooks).toHaveLength(1);
        expect(groups[0].hooks[0].type).toBe('command');
      }
    }
    // Import exclusion prevents native and imported Claude hook executions stacking.
    expect(read('adapters/devin/config.json')).toEqual({
      read_config_from: { claude: false },
    });
  });

  it.each(adapters)(
    '%s invokes the installed CLI without a download in the hook deadline',
    (harness, file) => {
      const verbs: Record<string, string> = {
        SessionStart: 'session-start',
        sessionStart: 'session-start',
        UserPromptSubmit: 'prompt',
        Stop: 'stop',
        PreCompact: 'pre-compact',
        SessionEnd: 'session-end',
      };
      for (const [event, command] of commands(harness, file)) {
        const executable = harness === 'copilot' ? command.bash : command.command;
        expect(executable).toBe(
          `cmos-mcp hook ${verbs[event]} --harness ${harness} --hook-source cmos-${harness}`
        );
        if (harness === 'copilot') expect(command.powershell).toBe(executable);
        if (harness !== 'cursor') expect(command.type).toBe('command');
        expect(command.timeoutSec ?? command.timeout).toBe(
          verbs[event] === 'session-start' ? 3 : 1
        );
      }
    }
  );
});
