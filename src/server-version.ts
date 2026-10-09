// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Resolves the package version for the server and lightweight bin readiness probes.
// ABOUTME: Uses only filesystem reads and preserves the existing fallback when metadata is unavailable.

import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve the server version from package.json at runtime — shared by both bins.
 *
 * s77-m04: a sync fs read of the sibling package.json (dist/ sits one level below
 * package.json in both the repo and the installed tarball) with a hardcoded
 * fallback, so bumping package.json changes the announced version with NO code
 * edit (chosen over a JSON import or the build-manifest to keep the announce
 * decoupled from the build step).
 */
export function getServerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through to the hardcoded fallback below
  }
  return '2.0.0';
}
