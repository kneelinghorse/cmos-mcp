// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pack the existing build and install that tarball for consumer-facing E2E suites.
// ABOUTME: Never rebuild the artifact under test; callers own and clean up every temporary directory.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type NpmRunner = (
  args: string[],
  cwd: string
) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

export function installPackedArtifact(
  repoRoot: string,
  mkTmp: (prefix: string) => string,
  runNpm: NpmRunner = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8' })
): { hostDir: string; tarball: string; serverPath: string; binPath: string } {
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'index.js'))) {
    throw new Error('Run npm run build first. The E2E lane must never rebuild its artifact.');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    name: string;
  };
  const packDir = mkTmp('cmos-e2e-pack-');
  const pack = runNpm(['pack', '--ignore-scripts', '--pack-destination', packDir], repoRoot);
  if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
  const tarballs = fs.readdirSync(packDir).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1)
    throw new Error(`Expected one packed tarball, found ${tarballs.length}.`);
  const tarball = path.join(packDir, tarballs[0]);

  const hostDir = mkTmp('cmos-e2e-host-');
  fs.writeFileSync(
    path.join(hostDir, 'package.json'),
    JSON.stringify({ name: 'cmos-e2e-host', version: '1.0.0', private: true }) + '\n'
  );
  const install = runNpm(
    ['install', tarball, '--prefer-offline', '--no-audit', '--no-fund'],
    hostDir
  );
  if (install.status !== 0)
    throw new Error(`npm install failed:\n${install.stdout}\n${install.stderr}`);
  const serverPath = path.join(hostDir, 'node_modules', pkg.name, 'dist', 'index.js');
  const binPath = path.join(hostDir, 'node_modules', '.bin', 'cmos-mcp');
  if (!fs.existsSync(serverPath) || !fs.existsSync(binPath)) {
    throw new Error('The installed tarball is missing its MCP server or CLI entry point.');
  }
  return { hostDir, tarball, serverPath, binPath };
}
