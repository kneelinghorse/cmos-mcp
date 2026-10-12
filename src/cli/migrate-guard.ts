// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Offline migration refuses legacy clients and open files rather than stopping other sessions.
// ABOUTME: Client configuration and OS handle inspection fail closed when their state is unreadable.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { LEGACY } from '../intelligence/legacy-compat';

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot inspect ${file}: ${(error as Error).message}`);
  }
}

/** Only migration calls this: no path or process argument is interpreted by a shell. */
export function assertNoOpenFiles(directory: string): void {
  const inspected = spawnSync('lsof', ['-nP', '-Fpcn', '+D', directory], { encoding: 'utf8' });
  if (
    inspected.error ||
    (inspected.status !== 0 && inspected.status !== 1) ||
    inspected.stderr.trim()
  )
    throw new Error(
      `Cannot establish offline quiescence for ${directory}; lsof must be available and able to inspect every open file.`
    );
  if (inspected.stdout.trim()) {
    const ids = [...inspected.stdout.matchAll(/^p(\d+)$/gm)].map((m) => m[1]);
    throw new Error(
      `Files in ${directory} are open by process ${[...new Set(ids)].join(', ')}. Close those clients before migrating; no process was stopped.`
    );
  }
}

function oldPackage(value: string): boolean {
  if (value.includes(LEGACY.packageName)) return true;
  return /@aquex\/reasonbook@[0-3](?:\.|\b)/.test(value);
}

export function assertProjectServerVersion(projectRoot: string, moving = false): void {
  const file = path.join(projectRoot, '.mcp.json');
  const source = read(file);
  if (!source) return;
  const config = JSON.parse(source) as { mcpServers?: Record<string, unknown> };
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    const serialized = JSON.stringify(server);
    if (moving && serialized.includes(LEGACY.packageName))
      throw new Error(
        `${file} server ${name} still names the legacy package. Run reasonbook migrate --apply --docs-only, configure Reasonbook 4.x, then move the record.`
      );
    const settings = server as { command?: string; args?: unknown[] };
    const entry = settings.args?.find(
      (arg): arg is string =>
        typeof arg === 'string' && /(?:^|\/)dist\/(?:index|bin|cli)\.js$/.test(arg)
    );
    if (entry && (name === LEGACY.command || name === 'rbook' || name === 'reasonbook')) {
      const manifest = read(path.resolve(projectRoot, path.dirname(entry), '../package.json'));
      const version = manifest ? (JSON.parse(manifest) as { version?: string }).version : undefined;
      if (!version || !/^(?:[4-9]|\d{2,})\./.test(version))
        throw new Error(
          `${file} server ${name} runs a pre-4.x or unknown local build. Rebuild or configure Reasonbook 4.x before applying migration.`
        );
    }
    // An unpinned old package can be rewritten; an explicit old version must be upgraded first.
    if (
      new RegExp(
        `${LEGACY.packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@[0-3](?:\\.|\\b)`
      ).test(serialized) ||
      /@aquex\/reasonbook@[0-3](?:\.|\b)/.test(serialized)
    )
      throw new Error(
        `${file} server ${name} is pinned to a pre-4.x package; update it to Reasonbook 4.x before applying migration.`
      );
  }
}

/** Inspect installed/enabled plugin records; unknown matching versions refuse a folder move. */
export function assertModernClients(home: string, configMove = false): void {
  const installed = path.join(home, '.claude/plugins/installed_plugins.json');
  const source = read(installed);
  if (source) {
    const data = JSON.parse(source) as {
      plugins?: Record<string, Array<{ version?: string; installPath?: string }>>;
    };
    for (const [name, entries] of Object.entries(data.plugins ?? {})) {
      if (!new RegExp(`^(?:${LEGACY.recordDirectory}|reasonbook)(?:-chat)?@`).test(name)) continue;
      for (const entry of entries) {
        let version = entry.version;
        if (!version && entry.installPath) {
          const manifest = read(path.join(entry.installPath, '.claude-plugin/plugin.json'));
          if (manifest) version = (JSON.parse(manifest) as { version?: string }).version;
        }
        if (!version || !/^(?:[4-9]|\d{2,})\./.test(version))
          throw new Error(
            `${installed}: plugin ${name} is ${version ?? 'of unknown version'}; install Reasonbook 4.x before moving folders.`
          );
      }
    }
  }
  for (const relative of ['.claude/settings.json', '.codex/config.toml']) {
    const file = path.join(home, relative);
    const contents = read(file);
    if (!contents) continue;
    if (relative.endsWith('.json')) {
      const enabled =
        (JSON.parse(contents) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {};
      if (
        Object.entries(enabled).some(
          ([name, on]) => on && new RegExp(`^${LEGACY.recordDirectory}(?:-chat)?@`).test(name)
        )
      )
        throw new Error(
          `${file} enables the legacy plugin; replace it with Reasonbook 4.x before moving folders.`
        );
    } else if (
      new RegExp(`\\[plugins\\.["']?${LEGACY.recordDirectory}(?:-chat)?[@"']`).test(contents) ||
      oldPackage(contents)
    ) {
      throw new Error(
        `${file} configures a legacy plugin or package; replace it with Reasonbook 4.x before moving folders.`
      );
    }
  }
  if (configMove) {
    for (const relative of [
      '.claude.json',
      'Library/Application Support/Claude/claude_desktop_config.json',
      'Library/Application Support/Code/User/settings.json',
      'Library/Application Support/Cursor/User/settings.json',
      '.cursor/mcp.json',
      '.codex/config.toml',
    ]) {
      const file = path.join(home, relative);
      const contents = read(file);
      if (contents && (oldPackage(contents) || contents.includes(`${LEGACY.command}/dist/`)))
        throw new Error(
          `${file} still configures a legacy build; remove it before moving the shared config folder.`
        );
    }
  }
}

/** A cached path can reopen after lsof; cutover requires every record runtime to be offline. */
export function assertNoRecordProcesses(): void {
  const processes = spawnSync('ps', ['-ww', '-axo', 'pid=,args='], { encoding: 'utf8' });
  if (processes.error || processes.status !== 0)
    throw new Error(
      'Cannot inspect running clients; offline migration requires process inspection.'
    );
  for (const line of processes.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const words = match[2].split(/\s+/);
    const executable = path.basename(words[0]);
    if (!/^(?:node|nodejs|reasonbook|npx)$/.test(executable) && executable !== LEGACY.command)
      continue;
    const entry = words.find((part) =>
      /(?:^|\/)(?:dist\/(?:index|bin|cli)\.js|(?:server|hooks)\/(?:run|install-worker|installing-server|disabled-server)\.mjs)$/.test(
        part
      )
    );
    let relevant =
      executable === 'reasonbook' ||
      executable === LEGACY.command ||
      words.some(
        (word) =>
          path.basename(word) === LEGACY.command ||
          path.basename(word) === 'reasonbook' ||
          word.startsWith(LEGACY.packageName) ||
          word.startsWith('@aquex/reasonbook')
      );
    if (entry) {
      let directory = path.dirname(entry);
      let identified = false;
      for (let depth = 0; depth < 5 && path.isAbsolute(directory); depth++) {
        const manifest = read(path.join(directory, 'package.json'));
        if (manifest) {
          const pkg = JSON.parse(manifest) as { name?: string };
          relevant ||= pkg.name === LEGACY.packageName || pkg.name === '@aquex/reasonbook';
          identified = true;
          break;
        }
        const plugin = read(path.join(directory, '.claude-plugin/plugin.json'));
        if (plugin) {
          const name = (JSON.parse(plugin) as { name?: string }).name;
          relevant ||=
            name === 'reasonbook' ||
            name === 'reasonbook-chat' ||
            name === LEGACY.recordDirectory ||
            name === `${LEGACY.recordDirectory}-chat`;
          identified = true;
          break;
        }
        directory = path.dirname(directory);
      }
      // An unresolved supported entry point cannot prove that its cached path is safe.
      if (!identified) relevant = true;
    }
    if (relevant)
      throw new Error(
        `Process ${match[1]} is a live or unidentified record runtime. Exit that client before offline migration; no process was stopped.`
      );
  }
}
