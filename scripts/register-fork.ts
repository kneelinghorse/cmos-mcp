// ABOUTME: One-shot registration of the local CMOS DB as a fresh dashboard project.
// ABOUTME: Bypasses the triggerCheckpointBackfill env-var gate so device-code-only users can re-register.

import { resolve } from 'path';
import { DashboardClient } from '../src/tools/cmos/dashboard-client';
import { withClientAsync } from '../src/tools/cmos/client';
import { captureRegisterResponse } from '../src/auth/project-key-capture';

function deriveProjectSlug(projectName: string): string {
  return projectName.trim().toLowerCase().replace(/\s+/g, '-');
}

async function main(): Promise<void> {
  const projectRoot = resolve(process.cwd());
  process.stderr.write(`Project root: ${projectRoot}\n`);

  // Pass undefined so arm 2 (project-scoped key, bound to old UUID) is skipped
  // and arm 3 (user-scoped, with authenticatingKeyId stamped) wins.
  const dashResult = await DashboardClient.fromEnvForProject(undefined);
  if (!dashResult.success || !dashResult.data) {
    throw new Error(`fromEnvForProject failed: ${dashResult.error?.message ?? 'unknown'}`);
  }
  const dashClient = dashResult.data.client;
  process.stderr.write(
    `Dashboard client built. parentKeyId=${dashClient.authenticatingKeyId ?? 'none'}\n`
  );

  await withClientAsync(
    async (client) => {
      const nameRow = client.getOne<{ value: string }>(
        `SELECT value FROM metadata WHERE key = 'project_name'`
      );
      const projectName = (nameRow.success && nameRow.data?.value) || '';
      if (!projectName) {
        throw new Error('metadata.project_name is empty — cannot register');
      }
      const expectedSlug = deriveProjectSlug(projectName);
      process.stderr.write(`projectName="${projectName}" expectedSlug="${expectedSlug}"\n`);

      const regCheck = client.getOne<{ value: string }>(
        `SELECT value FROM metadata WHERE key = 'dashboard_registered'`
      );
      if (regCheck.success && regCheck.data?.value === 'true') {
        throw new Error(
          'dashboard_registered is already true — clear it first if you want to re-register'
        );
      }

      const sqlitePath = client.path;
      process.stderr.write(`Calling POST /api/projects/register with sqlite=${sqlitePath}\n`);
      const result = await dashClient.registerProject({
        projectName,
        sqlitePath,
        localDbPath: sqlitePath,
        expectedSlug,
      });

      if (!result.success || !result.data) {
        throw new Error(`registerProject failed: ${result.error?.message ?? 'unknown'}`);
      }
      const data = result.data;
      process.stderr.write(
        `Registered: slug=${data.slug} projectId=${data.projectId} keyId=${data.keyId} reregistered=${data.reregistered ?? false}\n`
      );

      client.execute(
        `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_registered', 'true')`
      );
      client.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', ?)`, [
        data.slug,
      ]);
      client.execute(
        `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`,
        [data.projectId]
      );

      const captureStatus = await captureRegisterResponse({
        projectRoot,
        response: data,
        parentKeyId: dashClient.authenticatingKeyId,
      });
      process.stderr.write(`Key capture status: ${captureStatus}\n`);

      process.stdout.write(
        `SUCCESS slug=${data.slug} projectId=${data.projectId} keyId=${data.keyId}\n`
      );
    },
    { projectRoot }
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(`FAILED ${msg}\n`);
  process.exit(1);
});
