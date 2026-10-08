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

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

describe('s92-m07 — launch recipes', () => {
  it('pin an exact version in every command and config', () => {
    const unpinned: string[] = [];
    for (const doc of DOCS) {
      for (const spec of packageSpecs(read(doc))) {
        if (!/^@aquex\/cmos-mcp@\d+\.\d+\.\d+$/.test(spec)) unpinned.push(`${doc}: ${spec}`);
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
