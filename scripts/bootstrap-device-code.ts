// ABOUTME: One-shot bootstrap of a real user-scoped dashboard key via RFC 8628 device code.
// ABOUTME: Writes to the default CredentialStore (~/.config/cmos-mcp/credentials.json). Safe to re-run.

import { runDeviceCodeFlow, type DeviceCodeResponse } from '../src/auth/device-code';

async function main(): Promise<void> {
  const baseUrl = process.env.CMOS_DASHBOARD_URL;
  if (!baseUrl) {
    throw new Error('CMOS_DASHBOARD_URL must be set');
  }

  const prompter = (response: DeviceCodeResponse): void => {
    process.stdout.write(`AUTH_URL: ${response.verificationUri}\n`);
    process.stdout.write(`AUTH_CODE: ${response.userCode}\n`);
    process.stdout.write(`AUTH_EXPIRES_IN: ${response.expiresIn}\n`);
  };

  const token = await runDeviceCodeFlow({ baseUrl, prompter });

  process.stdout.write(`SUCCESS keyId=${token.keyId} label="${token.label}"\n`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
  process.stdout.write(`FAILED ${code} ${msg}\n`);
  process.exit(1);
});
