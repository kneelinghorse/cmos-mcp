// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Validates the plugin's exact package/runtime identity before any executable is selected.
// ABOUTME: Completion markers and install pointers are hints; package identity and native SQLite are rechecked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const PACKAGE_NAME = '@aquex/cmos-mcp';
export const MARKER = '.cmos-ready.json';

export function configDirectory(env = process.env) {
  return path.resolve(env.CMOS_CONFIG_DIR || path.join(os.homedir(), '.config', 'cmos-mcp'));
}

export function createContext({
  version,
  dataRoot,
  configDir = configDirectory(),
  platform = process.platform,
  arch = process.arch,
  abi = process.versions.modules,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid plugin version');
  if (!dataRoot || !path.isAbsolute(dataRoot))
    throw new Error('CLAUDE_PLUGIN_DATA must be absolute');
  for (const value of [platform, arch, abi]) {
    if (!/^[\w-]+$/.test(value)) throw new Error('Invalid plugin runtime identity');
  }
  const identity = { packageName: PACKAGE_NAME, version, platform, arch, abi };
  const root = path.resolve(dataRoot);
  const leaf = `${version}-${platform}-${arch}-abi${abi}`;
  return {
    ...identity,
    identity,
    dataRoot: root,
    configDir: path.resolve(configDir),
    installRoot: path.join(root, leaf),
    pointerPath: path.join(path.resolve(configDir), 'runtime', 'plugin-install.json'),
  };
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function matchesIdentity(ctx, value) {
  return value && Object.entries(ctx.identity).every(([key, expected]) => value[key] === expected);
}

export function validatePackage(ctx, packageRoot) {
  try {
    if (
      ctx.platform !== process.platform ||
      ctx.arch !== process.arch ||
      ctx.abi !== process.versions.modules
    ) {
      return undefined;
    }
    const metadataPath = path.join(packageRoot, 'package.json');
    const pkg = readJson(metadataPath);
    if (pkg?.name !== PACKAGE_NAME || pkg.version !== ctx.version) return undefined;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['cmos-mcp'];
    if (typeof bin !== 'string') return undefined;
    const root = fs.realpathSync(packageRoot);
    const cliPath = fs.realpathSync(path.resolve(packageRoot, bin));
    if (!cliPath.startsWith(root + path.sep) || !fs.statSync(cliPath).isFile()) return undefined;
    const require = createRequire(metadataPath);
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      if (db.prepare('SELECT 1 AS ready').get()?.ready !== 1) return undefined;
    } finally {
      db.close();
    }
    return { packageRoot: root, cliPath };
  } catch {
    return undefined;
  }
}

export function validateInstall(ctx, installRoot = ctx.installRoot) {
  try {
    if (fs.lstatSync(installRoot).isSymbolicLink()) return undefined;
    const root = fs.realpathSync(installRoot);
    if (path.dirname(root) !== fs.realpathSync(ctx.dataRoot)) return undefined;
    const pkg = fs.realpathSync(path.join(installRoot, 'node_modules', '@aquex', 'cmos-mcp'));
    if (!pkg.startsWith(root + path.sep)) return undefined;
  } catch {
    return undefined;
  }
  if (!matchesIdentity(ctx, readJson(path.join(installRoot, MARKER)))) return undefined;
  const ready = validatePackage(ctx, path.join(installRoot, 'node_modules', '@aquex', 'cmos-mcp'));
  return ready ? { ...ready, installRoot } : undefined;
}

export function writeMarker(ctx, candidate) {
  fs.writeFileSync(path.join(candidate, MARKER), JSON.stringify(ctx.identity), {
    flag: 'wx',
    mode: 0o600,
  });
}

export function writePointer(ctx) {
  fs.mkdirSync(path.dirname(ctx.pointerPath), { recursive: true });
  const temporary = `${ctx.pointerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...ctx.identity, installRoot: ctx.installRoot }), {
    mode: 0o600,
  });
  fs.renameSync(temporary, ctx.pointerPath);
}

export function findPathPackage(ctx, env = process.env) {
  // A fresh CLI may load its server modules to print --version; one shared budget admits
  // that measured startup cost without allowing multiple candidates to multiply it.
  const deadline = Date.now() + 400;
  const seen = new Set();
  for (const directory of (env.PATH || '').split(path.delimiter).filter(path.isAbsolute)) {
    if (Date.now() >= deadline) return undefined;
    const command = path.join(
      directory,
      process.platform === 'win32' ? 'cmos-mcp.cmd' : 'cmos-mcp'
    );
    if (!fs.existsSync(command)) continue;
    // npm's Windows wrapper sits beside node_modules; execute the validated package bin, not cmd text.
    const candidates = [path.join(directory, 'node_modules', '@aquex', 'cmos-mcp')];
    try {
      let parent = path.dirname(fs.realpathSync(command));
      for (let depth = 0; depth < 5; depth += 1) {
        candidates.push(parent);
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      if (Date.now() >= deadline) return undefined;
      let canonical;
      try {
        canonical = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const ready = validatePackage(ctx, canonical);
      if (!ready) continue;
      if (process.platform !== 'win32' && fs.realpathSync(command) !== ready.cliPath) continue;
      // PATH packages are mutable and have no worker-issued marker. All candidates share
      // one budget; a slow or mismatched CLI is unavailable, never trusted by its label.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const check = spawnSync(process.execPath, [ready.cliPath, '--version'], {
        encoding: 'utf8',
        timeout: remaining,
        killSignal: 'SIGKILL',
        env,
      });
      if (Date.now() >= deadline) return undefined;
      if (check.status === 0 && check.stdout.trim() === `cmos-mcp ${ctx.version}`) return ready;
    }
  }
  return undefined;
}

export function findReady(ctx, env = process.env) {
  const pointer = readJson(ctx.pointerPath);
  if (matchesIdentity(ctx, pointer) && pointer.installRoot === ctx.installRoot) {
    const ready = validateInstall(ctx, pointer.installRoot);
    if (ready) return ready;
  }
  return validateInstall(ctx) || findPathPackage(ctx, env);
}
