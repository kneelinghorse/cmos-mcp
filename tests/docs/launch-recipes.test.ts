// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m07 — every documented launch recipe pins the package version and runs npx with
// ABOUTME: --prefer-offline, and the pinned version is this release, so a copied config cannot float.

/**
 * An unpinned `npx -y @aquex/cmos-mcp` can resolve the package against the registry on every
 * launch; the first-run study measured 35-49 s cold starts under load, and an unpinned config
 * silently moves to whatever was published last. The recipes now pin one version and prefer the
 * npm cache, or recommend the global install.
 *
 * THE VERSION RULE: the pin equals package.json's version, except while a release is being prepared
 * (CHANGELOG.md opens with "## Unreleased"), when the pin may be the release being prepared and so
 * may run ahead of package.json.
 */

import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS = ['README.md', 'docs/getting-started.md'];
const PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Package specs in commands and configs; the badge and npm page URLs are links, not launches. */
function packageSpecs(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !line.includes('img.shields.io') && !line.includes('npmjs.com/package'))
    .flatMap((line) => line.match(/@aquex\/cmos-mcp(@[^\s"'`,\]]*)?/g) ?? []);
}

function parseSemver(value: string): { core: bigint[]; pre: string[] } | undefined {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match) return undefined;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return undefined;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Invalid release version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1)
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length)
    return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const left = pa.pre[i];
    const right = pb.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const numericLeft = /^\d+$/.test(left);
    const numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function isExactPackageSpec(spec: string): boolean {
  const prefix = '@aquex/cmos-mcp@';
  return spec.startsWith(prefix) && parseSemver(spec.slice(prefix.length)) !== undefined;
}

describe('s92-m07 — launch recipes', () => {
  it('accepts exact stable and prerelease pins, but refuses ranges, tags and malformed versions', () => {
    for (const version of ['3.2.0', '3.3.0-rc.1', '3.3.0-rc.1+build.2']) {
      expect(isExactPackageSpec(`@aquex/cmos-mcp@${version}`)).toBe(true);
    }
    for (const spec of [
      '@aquex/cmos-mcp',
      '@aquex/cmos-mcp@latest',
      '@aquex/cmos-mcp@^3.3.0',
      '@aquex/cmos-mcp@~3.3.0',
      '@aquex/cmos-mcp@3.3.x',
      '@aquex/cmos-mcp@3.03.0',
      '@aquex/cmos-mcp@3.3.0-rc.01',
      '@aquex/cmos-mcp@3.3.0-',
    ]) {
      expect(isExactPackageSpec(spec)).toBe(false);
    }
  });

  it('orders prereleases for the existing Unreleased-ahead exception without treating another RC as equal', () => {
    expect(compareSemver('3.3.0-rc.1', '3.3.0-rc.1')).toBe(0);
    expect(compareSemver('3.2.0', '3.3.0-rc.1')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.1', '3.3.0-rc.2')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.2', '3.3.0-rc.10')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.10', '3.3.0')).toBeLessThan(0);
    expect(compareSemver('3.3.0', '3.3.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('3.3.0-alpha.1', '3.3.0-alpha.beta')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc', '3.3.0-rc.1')).toBeLessThan(0);
    expect(compareSemver('3.3.0-rc.1+build.1', '3.3.0-rc.1+build.2')).toBe(0);
  });

  it('pin an exact version in every command and config', () => {
    const unpinned: string[] = [];
    for (const doc of DOCS) {
      for (const spec of packageSpecs(read(doc))) {
        if (!isExactPackageSpec(spec)) unpinned.push(`${doc}: ${spec}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it('run npx with --prefer-offline wherever npx launches the package', () => {
    const offenders: string[] = [];
    for (const doc of DOCS) {
      const text = read(doc);
      // Shell form: an npx command line that names the package.
      for (const line of text.split('\n')) {
        if (
          /\bnpx\b/.test(line) &&
          line.includes('@aquex/cmos-mcp') &&
          !line.includes('--prefer-offline')
        ) {
          offenders.push(`${doc}: ${line.trim()}`);
        }
      }
      // JSON form: "command": "npx" followed by an args array naming the package.
      const configs = text.match(/"command":\s*"npx",\s*"args":\s*\[[^\]]*\]/g) ?? [];
      for (const config of configs) {
        if (!config.includes('"--prefer-offline"'))
          offenders.push(`${doc}: ${config.replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: both forms are present in the docs this gate reads.
    expect(DOCS.some((doc) => /"command":\s*"npx"/.test(read(doc)))).toBe(true);
    expect(DOCS.some((doc) => /^npx .*@aquex\/cmos-mcp/m.test(read(doc)))).toBe(true);
  });

  it('pin one version, and that version is this release', () => {
    const pins = new Set(
      DOCS.flatMap((doc) => packageSpecs(read(doc))).map((spec) => spec.split('@').pop()!)
    );
    expect(pins.size).toBe(1);
    const [pin] = [...pins];
    const preparing = /^## Unreleased\b/m.test(read('CHANGELOG.md'));
    if (pin !== PKG_VERSION) {
      expect({
        pin,
        pkg: PKG_VERSION,
        preparing,
        ahead: compareSemver(pin, PKG_VERSION) > 0,
      }).toEqual({
        pin,
        pkg: PKG_VERSION,
        preparing: true,
        ahead: true,
      });
    }
  });

  it('recommend the global install as well', () => {
    for (const doc of DOCS) {
      expect(read(doc)).toContain(`npm install -g @aquex/cmos-mcp@`);
    }
  });
});
