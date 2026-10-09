// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Finds npm tooling beside the running Node executable, keeping native installs on that runtime.
// ABOUTME: Windows installation uses npm.cmd explicitly; arbitrary CLI arguments use the adjacent npx JS entry.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function packageManager(
  name,
  args,
  { execPath = process.execPath, platform = process.platform } = {}
) {
  const directory = path.dirname(execPath);
  if (platform === 'win32') {
    if (name === 'npm') {
      const command = path.join(directory, 'npm.cmd');
      if (!fs.existsSync(command))
        throw new Error('npm.cmd is missing beside Node; install npm for this Node runtime.');
      // cmd.exe expands these variables once, inside quotes; path spaces, %, & and ! remain
      // argument data. npm install's arguments are controlled here, never arbitrary CLI text.
      const env = { CMOS_NPM_COMMAND: command };
      args.forEach((value, index) => {
        env[`CMOS_NPM_ARG_${index}`] = value;
      });
      return {
        command: '"%CMOS_NPM_COMMAND%"',
        args: args.map((_, index) => `"%CMOS_NPM_ARG_${index}%"`),
        env,
        shell: true,
      };
    }
    const script = path.join(directory, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (!fs.existsSync(script))
      throw new Error('npx is missing beside Node; install npm for this Node runtime.');
    return { command: execPath, args: [script, ...args], shell: false };
  }
  const command = path.join(directory, name);
  if (!fs.existsSync(command))
    throw new Error(`${name} is missing beside Node; install npm for this Node runtime.`);
  return { command: execPath, args: [fs.realpathSync(command), ...args], shell: false };
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
