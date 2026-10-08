// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m10 — fingerprints the real dist/.build-manifest.json so the jest global teardown
// ABOUTME: can prove a full run left it byte-identical (feedback #31).

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/** The env var globalSetup stamps and globalTeardown checks; both run in jest's main process. */
export const DIST_MANIFEST_FINGERPRINT_ENV = 'CMOS_JEST_DIST_MANIFEST_SHA256';

export const DIST_MANIFEST_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  '.build-manifest.json'
);

/** sha256 of the manifest's bytes, or 'absent' when there is no build. */
export function distManifestFingerprint(): string {
  if (!existsSync(DIST_MANIFEST_PATH)) return 'absent';
  return createHash('sha256').update(readFileSync(DIST_MANIFEST_PATH)).digest('hex');
}
