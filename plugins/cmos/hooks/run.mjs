// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Dispatches plugin hooks and explicit commands through a validated, exactly pinned CMOS package.
// ABOUTME: Hooks install asynchronously and fail open; a disabled MCP server needs no installed package.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  configDirectory,
  createContext,
  findReady,
  findPathPackage,
  readJson,
  writePointer,
} from './install-state.mjs';
import { packageManager, runCommand } from './package-manager.mjs';
import { disabledServer } from './disabled-server.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));

function serverDisabled(configDir) {
  const file = path.join(configDir, 'config.json');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(
      `Cannot read ${file}: ${error.message}; fix the config before starting the plugin server.`
    );
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.pluginServer !== undefined && !['on', 'off'].includes(value.pluginServer))
  ) {
    throw new Error(`Invalid ${file}; pluginServer must be on or off.`);
  }
  return value.pluginServer === 'off';
}

export function startInstaller(ctx, env = process.env) {
  const child = spawn(
    process.execPath,
    [path.join(directory, 'install-worker.mjs'), JSON.stringify(ctx)],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    }
  );
  child.once('error', () => {});
  child.unref();
}

export async function run(
  args,
  {
    env = process.env,
    launch = runCommand,
    startInstaller: install = startInstaller,
    writeOut = (text) => process.stdout.write(text),
    writeError = (text) => process.stderr.write(text),
  } = {}
) {
  const hook = args[0] === 'hook';
  try {
    const configDir = configDirectory(env);
    // This is deliberately before manifest/runtime discovery, native loading or any process spawn.
    if (args[0] === 'serve' && serverDisabled(configDir)) {
      await disabledServer();
      return 0;
    }
    const manifest = readJson(path.join(directory, '..', '.claude-plugin', 'plugin.json'));
    const ctx = createContext({
      version: manifest?.version,
      dataRoot: env.CLAUDE_PLUGIN_DATA || configDir,
      configDir,
    });
    const ready = env.CLAUDE_PLUGIN_DATA ? findReady(ctx, env) : findPathPackage(ctx, env);
    if (ready) {
      if (ready.installRoot) writePointer(ctx);
      const silent = hook && ['stop', 'pre-compact', 'session-end'].includes(args[1]);
      const code = await launch(process.execPath, [ready.cliPath, ...args], {
        stdio: silent ? ['inherit', 'ignore', 'inherit'] : 'inherit',
        env,
        windowsHide: true,
      });
      return hook ? 0 : code;
    }
    if (hook) {
      if (args[1] === 'session-start' && env.CLAUDE_PLUGIN_DATA) {
        install(ctx, env);
        writeOut(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'SessionStart',
              additionalContext: 'CMOS is installing; the record loads from the next session',
            },
          }) + '\n'
        );
      }
      return 0;
    }
    const npx = packageManager('npx', [
      '-y',
      '--prefer-offline',
      `${ctx.packageName}@${ctx.version}`,
      ...args,
    ]);
    return await launch(npx.command, npx.args, {
      shell: npx.shell,
      stdio: 'inherit',
      env: { ...env, PATH: path.dirname(process.execPath) + path.delimiter + (env.PATH || '') },
      windowsHide: true,
    });
  } catch (error) {
    writeError(`CMOS ${hook ? 'hook' : 'command'} unavailable: ${error.message}\n`);
    return hook ? 0 : 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
