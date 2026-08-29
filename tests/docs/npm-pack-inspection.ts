// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Builds an npm tarball in a temp directory and reads packed Markdown from archive bytes.
// ABOUTME: Keeps package-content assertions tied to npm's real packlist without leaving artifacts.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'zlib';

export interface NpmPackInspection {
  readonly files: ReadonlySet<string>;
  readonly seedMarkdown: ReadonlyMap<string, string>;
}

interface NpmPackManifest {
  readonly filename: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

export interface NpmPackInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export function toPackagePath(filePath: string, separator: string = path.sep): string {
  return filePath.split(separator).join('/');
}

export function npmPackInvocation(
  packDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  nodeExecutable: string = process.execPath
): NpmPackInvocation {
  const packArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir];
  if (env.npm_execpath) {
    return { command: nodeExecutable, args: [env.npm_execpath, ...packArgs] };
  }
  if (platform === 'win32') {
    return {
      command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', ...packArgs],
    };
  }
  return { command: 'npm', args: packArgs };
}

function tarString(archive: Buffer, offset: number, length: number): string {
  const field = archive.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

function regularTarFiles(tarball: string): ReadonlyMap<string, Buffer> {
  const archive = gunzipSync(fs.readFileSync(tarball));
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const memberPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar size "${sizeText}" for ${memberPath}`);
    }

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new Error(`Truncated tar member ${memberPath}`);
    const type = String.fromCharCode(header[156]);
    if (type === '\0' || type === '0')
      files.set(memberPath, archive.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function inspectNpmPack(repoRoot: string): NpmPackInspection {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-stamp-pack-'));
  try {
    const invocation = npmPackInvocation(packDir);
    const raw = execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const manifests = JSON.parse(raw) as NpmPackManifest[];
    if (manifests.length !== 1) {
      throw new Error(`npm pack returned ${manifests.length} manifests; expected exactly one`);
    }

    const manifest = manifests[0];
    const tarball = path.join(packDir, manifest.filename);
    if (!fs.existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);

    const files = new Set(manifest.files.map((file) => file.path));
    const archiveFiles = regularTarFiles(tarball);
    const seedMarkdown = new Map<string, string>();
    for (const rel of [...files].filter((file) => /^cmos-seed\/.*\.md$/.test(file)).sort()) {
      const content = archiveFiles.get(`package/${rel}`);
      if (!content) throw new Error(`npm tarball has no readable package/${rel} member`);
      seedMarkdown.set(rel, content.toString('utf8'));
    }

    return { files, seedMarkdown };
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}
