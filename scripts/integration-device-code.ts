// ABOUTME: One-shot integration: run the real device code flow against the live cmos-dashboard.
// ABOUTME: Sprint 57 m01 live validation; Sprint 58 m03 aligned under CMOS_LIVE_DASHBOARD=1 flag.

/**
 * Manual smoke script for the device-code flow.
 *
 * Prefer the jest live-mode blocks for reproducible assertions — this
 * script is a quick sanity shot for contract drift. Both paths honor the
 * same `CMOS_LIVE_DASHBOARD=1` opt-in so no one runs it accidentally.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { runDeviceCodeFlow } from '../src/auth/device-code';
import { CredentialStore } from '../src/intelligence/credential-store';

async function main(): Promise<void> {
  if (process.env.CMOS_LIVE_DASHBOARD !== '1') {
    throw new Error(
      'CMOS_LIVE_DASHBOARD=1 must be set to run the live device-code script ' +
        '(safety rail — prevents accidental live hits from test tooling).'
    );
  }

  const baseUrl = process.env.CMOS_DASHBOARD_URL;
  if (!baseUrl) {
    throw new Error('CMOS_DASHBOARD_URL must be set');
  }

  // Ephemeral credential store so we don't pollute real ~/.config/cmos-mcp/credentials.json.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-device-code-'));
  CredentialStore.resetInstance();
  const store = await CredentialStore.create({ configDir: tempDir });

  process.stderr.write(`\n[live] Targeting ${baseUrl}\n`);
  process.stderr.write(
    `[live] Ephemeral credential store: ${path.join(tempDir, 'credentials.json')}\n`
  );

  const token = await runDeviceCodeFlow({ baseUrl, credentialStore: store });

  process.stderr.write(`\n[live] SUCCESS\n`);
  process.stderr.write(`[live]   keyId: ${token.keyId}\n`);
  process.stderr.write(`[live]   label: ${token.label}\n`);
  process.stderr.write(`[live]   key:   ${token.key.slice(0, 12)}…\n`);

  const persisted = await store.getUserScopedKey(token.keyId);
  if (!persisted) {
    throw new Error('persisted user-scoped key not found in store');
  }
  process.stderr.write(`[live]   persisted issuedAt: ${persisted.issuedAt}\n\n`);

  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`\n[live] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err && typeof err === 'object' && 'code' in err) {
    process.stderr.write(`[live]   code: ${(err as { code: string }).code}\n`);
  }
  process.exit(1);
});
