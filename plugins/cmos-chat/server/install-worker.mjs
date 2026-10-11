// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Detached installer owns publication through package and native-runtime validation.
// ABOUTME: A completion marker travels inside the atomic directory rename; valid installations are immutable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createContext,
  validateInstall,
  validatePackage,
  writeMarker,
  writePointer,
} from './install-state.mjs';
import { acquireLock, ownsLock, releaseLock } from './install-lock.mjs';
import { packageManager, runCommand } from './package-manager.mjs';
export { acquireLock, releaseLock } from './install-lock.mjs';

async function installPackage(candidate, ctx) {
  const npm = packageManager('npm', [
    'install',
    '--prefix',
    candidate,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--omit=dev',
    `${ctx.packageName}@${ctx.version}`,
  ]);
  const code = await runCommand(npm.command, npm.args, {
    shell: npm.shell,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...npm.env,
      PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
    },
  });
  if (code !== 0) throw new Error(`npm install exited ${code}`);
}

export async function runInstall(ctx, options = {}) {
  if (validateInstall(ctx)) return 'ready';
  const lock = acquireLock(ctx, options);
  if (!lock) return 'busy';
  const candidate = `${ctx.installRoot}.tmp-${process.pid}-${lock.token}`;
  try {
    if (validateInstall(ctx)) return 'ready';
    // An incomplete destination is disposable only under this identity's exclusive lock.
    if (fs.existsSync(ctx.installRoot))
      fs.rmSync(ctx.installRoot, { recursive: true, force: true });
    fs.mkdirSync(candidate, { recursive: true });
    await (options.installPackage || installPackage)(candidate, ctx);
    const ready = validatePackage(ctx, path.join(candidate, 'node_modules', '@aquex', 'cmos-mcp'));
    if (!ready) throw new Error('Installed package identity or native SQLite validation failed');
    const check = spawnSync(process.execPath, [ready.cliPath, '--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (check.status !== 0 || check.stdout.trim() !== `cmos-mcp ${ctx.version}`)
      throw new Error('Installed CLI version validation failed');
    if (!ownsLock(lock)) throw new Error('Installer lost ownership before publication');
    writeMarker(ctx, candidate);
    options.beforePublish?.();
    fs.renameSync(candidate, ctx.installRoot);
    options.afterPublish?.();
    writePointer(ctx);
    return 'installed';
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
    releaseLock(lock);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runInstall(createContext(JSON.parse(process.argv[2])));
  } catch (error) {
    process.stderr.write(`CMOS installer: ${error.message}\n`);
    process.exitCode = 1;
  }
}
