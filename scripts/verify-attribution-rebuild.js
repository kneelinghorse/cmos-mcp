// ABOUTME: Live Sprint 54 verification runner for the post-Sprint-53 attribution rebuild.
// ABOUTME: Runs whoami/send checks across active registered projects and writes report artifacts.

const fs = require('fs');
const path = require('path');

const Database = require('better-sqlite3');

const { executeMissionProtocolTool } = require('../dist/index');
const {
  formatAttributionVerificationReport,
  selectActiveVerificationProjects,
} = require('../dist/intelligence/attribution-verification');
const { ProjectRegistry } = require('../dist/intelligence/project-registry');
const { resolveSenderContext } = require('../dist/intelligence/sender-context');
const { cmosProjectList } = require('../dist/tools/cmos/cmos-project-list');
const { getWhoamiDiagnostics } = require('../dist/tools/cmos/cmos-message');
const { DashboardClient } = require('../dist/tools/cmos/dashboard-client');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'cmos', 'docs', 'attribution-rebuild-verification.md');
const JSON_PATH = path.join(REPO_ROOT, 'cmos', 'reports', 'attribution-rebuild-verification.json');

function loadDotEnvIfPresent() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const delimiter = trimmed.indexOf('=');
    if (delimiter === -1) {
      continue;
    }

    const key = trimmed.slice(0, delimiter).trim();
    const value = trimmed.slice(delimiter + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function readIdentitySnapshot(projectRoot) {
  const dbPath = path.join(projectRoot, 'cmos', 'db', 'cmos.sqlite');
  const db = new Database(dbPath, { readonly: true });
  try {
    const identityRow = db
      .prepare("SELECT content FROM contexts WHERE id = 'project_identity'")
      .get();
    const identity = identityRow ? JSON.parse(identityRow.content) : {};
    const metadataRows = db
      .prepare(
        "SELECT key, value FROM metadata WHERE key IN ('project_name', 'project_id', 'dashboard_slug', 'dashboard_project_id', 'owner')"
      )
      .all();
    const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));

    return {
      projectName: metadata.project_name || path.basename(projectRoot),
      projectId: metadata.project_id || null,
      dashboardProjectId: metadata.dashboard_project_id || null,
      dashboardSlug: metadata.dashboard_slug || null,
      owner: metadata.owner || null,
      cmosAddress: identity.cmos_address || null,
    };
  } finally {
    db.close();
  }
}

function canReadIdentitySnapshot(projectRoot) {
  try {
    readIdentitySnapshot(projectRoot);
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function findProject(projects, predicate, description) {
  const match = projects.find(predicate);
  if (!match) {
    throw new Error(`Could not find ${description} in the active registry set.`);
  }
  return match;
}

async function verifyInstallRootGuard() {
  try {
    await resolveSenderContext({
      requireSenderIdentity: true,
      cwdOverride: REPO_ROOT,
      serverInstallRootOverride: REPO_ROOT,
    });
    return {
      passed: false,
      reason: 'strict sender resolution unexpectedly accepted SERVER_INSTALL_ROOT as cwd.',
    };
  } catch (error) {
    const candidates = Array.isArray(error?.candidates) ? error.candidates : [];
    const guardCandidate = candidates.find(
      (candidate) =>
        candidate.source === 'cwd' &&
        typeof candidate.rejectReason === 'string' &&
        candidate.rejectReason.includes('SERVER_INSTALL_ROOT guard')
    );

    if (!guardCandidate) {
      return {
        passed: false,
        reason:
          error instanceof Error
            ? error.message
            : 'strict sender resolution failed without the expected cwd guard evidence.',
      };
    }

    return {
      passed: true,
      reason: guardCandidate.rejectReason,
    };
  }
}

function expectedSenderAliases(expectedSenderAddress) {
  const aliases = new Set([expectedSenderAddress]);
  if (expectedSenderAddress && expectedSenderAddress.startsWith('cmos://')) {
    const [, slug] = expectedSenderAddress.replace('cmos://', '').split('/');
    if (slug) {
      aliases.add(slug);
    }
  }
  return aliases;
}

function extractDashboardSender(message) {
  return (
    message.senderAddress ||
    message.senderProject ||
    message.from ||
    message.from_project_id ||
    null
  );
}

async function resolveDashboardRecordedSender({ messageId, summary }) {
  const clientResult = DashboardClient.fromEnv();
  if (!clientResult.success) {
    return {
      messageId: messageId || null,
      sender: null,
      details: clientResult.error?.message || 'dashboard credentials unavailable',
    };
  }

  const client = clientResult.data;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tabs = ['inbox', 'sent'];
    for (const tab of tabs) {
      const listResult = await client.listMessages({ tab, limit: 50 });
      if (!listResult.success || !listResult.data) {
        continue;
      }

      const message = listResult.data.messages.find((entry) => {
        if (messageId && entry.id === messageId) {
          return true;
        }
        return summary ? entry.summary === summary : false;
      });
      if (message) {
        return {
          messageId: message.id || messageId || null,
          sender: extractDashboardSender(message),
          details: null,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    messageId: messageId || null,
    sender: null,
    details: 'message not visible in dashboard sent view after 5 retries',
  };
}

async function runStage1Send(stage1Root, targetAddress, expectedSenderAddress) {
  const originalCwd = process.cwd();
  const originalEnvRoot = process.env.CMOS_PROJECT_ROOT;
  try {
    process.chdir(stage1Root);
    process.env.CMOS_PROJECT_ROOT = REPO_ROOT;

    const summary = `Sprint 54 attribution verification ${new Date().toISOString()}`;
    const result = await executeMissionProtocolTool(
      'cmos_message',
      {
        action: 'send',
        targetAddress,
        type: 'status_update',
        summary,
        body: 'Sprint 54 live verification send from Stage1. Safe to ignore.',
      },
      {}
    );

    const toolResult = result.structuredContent;
    if (!toolResult?.success) {
      return {
        status: 'fail',
        targetAddress,
        messageId: toolResult?.data?.messageId || null,
        dashboardRecordedSender: null,
        details: toolResult?.error?.message || 'send failed without a structured error payload',
      };
    }

    const dashboardResult = await resolveDashboardRecordedSender({
      messageId: toolResult?.data?.messageId || null,
      summary,
    });
    const recordedSender = dashboardResult.sender;
    const aliases = expectedSenderAliases(expectedSenderAddress);
    return {
      status: recordedSender && aliases.has(recordedSender) ? 'pass' : 'fail',
      targetAddress,
      messageId: dashboardResult.messageId,
      dashboardRecordedSender: recordedSender,
      details:
        dashboardResult.details ||
        (recordedSender && aliases.has(recordedSender)
          ? 'dispatcher send attributed correctly'
          : `dashboard recorded sender ${recordedSender || 'unknown'}`),
    };
  } finally {
    process.chdir(originalCwd);
    if (originalEnvRoot === undefined) {
      delete process.env.CMOS_PROJECT_ROOT;
    } else {
      process.env.CMOS_PROJECT_ROOT = originalEnvRoot;
    }
  }
}

async function main() {
  loadDotEnvIfPresent();
  await ProjectRegistry.create();

  const listResult = await cmosProjectList({});
  if (!listResult.success || !listResult.data) {
    throw new Error(listResult.error?.message || 'Failed to load project registry.');
  }

  const activeProjects = selectActiveVerificationProjects(listResult.data.projects);
  const schemaInvalidProjects = [];
  const verifiableProjects = [];
  for (const project of activeProjects) {
    const verification = canReadIdentitySnapshot(project.projectRoot);
    if (verification.ok) {
      verifiableProjects.push(project);
      continue;
    }

    schemaInvalidProjects.push({
      name: project.name,
      projectRoot: project.projectRoot,
      error: verification.error,
    });
  }
  const guard = await verifyInstallRootGuard();

  const stage1Project = findProject(
    verifiableProjects,
    (project) => project.projectRoot.includes('/Design-Tools/Stage1'),
    'Stage1 project'
  );
  const oodsProject = findProject(
    verifiableProjects,
    (project) => project.projectRoot.includes('/OODS-Foundry-mcp'),
    'OODS Foundry MCP project'
  );
  const rows = [];
  for (const project of verifiableProjects) {
    const before = readIdentitySnapshot(project.projectRoot);
    const whoami = await getWhoamiDiagnostics({
      cwdOverride: project.projectRoot,
      serverInstallRootOverride: REPO_ROOT,
    });
    const after = readIdentitySnapshot(project.projectRoot);

    const notes = [];
    if (!whoami.success && whoami.error?.message) {
      notes.push(whoami.error.message);
    }
    for (const warning of whoami.warnings || []) {
      notes.push(warning);
    }

    // Sprint 55 m04: tri-state. Only counts as "not-needed" if pre was already
    // canonical — a stale or empty pre with no healed outcome means backfill
    // ran and failed (the signal Track E2 actually cares about).
    const prePresent = Boolean(before.cmosAddress);
    const preStale = !prePresent || before.cmosAddress.startsWith('cmos://unknown/');
    let firstContactHealStatus;
    if (!preStale) {
      firstContactHealStatus = 'not-needed';
    } else if (whoami.data?.resolved.healed) {
      firstContactHealStatus = 'healed';
    } else {
      firstContactHealStatus = 'heal-failed';
    }

    rows.push({
      name: project.name,
      projectRoot: project.projectRoot,
      resolvedAddress: whoami.data?.resolved.cmosAddress || null,
      source: whoami.data?.resolved.source || null,
      dashboardProjectId: after.dashboardProjectId || null,
      firstContactHealStatus,
      preVerificationAddress: before.cmosAddress || null,
      postVerificationAddress: after.cmosAddress || null,
      sendCheck: {
        status: 'not-run',
        targetAddress: null,
        messageId: null,
        dashboardRecordedSender: null,
        details: null,
      },
      notes,
    });
  }

  const oodsIdentity = readIdentitySnapshot(oodsProject.projectRoot);
  const stage1Row = rows.find((row) => row.projectRoot === stage1Project.projectRoot);
  const expectedStage1Sender =
    stage1Row?.postVerificationAddress ||
    stage1Row?.resolvedAddress ||
    readIdentitySnapshot(stage1Project.projectRoot).cmosAddress ||
    'cmos://derek/stage1';
  const stage1Send = await runStage1Send(
    stage1Project.projectRoot,
    oodsIdentity.cmosAddress || 'cmos://derek/oods-foundry-mcp',
    expectedStage1Sender
  );

  for (const row of rows) {
    if (row.projectRoot === stage1Project.projectRoot) {
      row.sendCheck = stage1Send;
    }
  }

  const reportData = {
    generatedAt: new Date().toISOString(),
    registryTotal: listResult.data.summary.total,
    missingCount: listResult.data.missingCount,
    rows,
    guard,
    notes: [
      'Active-project scope excludes dead temp registry fixtures that no longer have a CMOS database.',
      `Schema-invalid registry fixtures skipped: ${schemaInvalidProjects.length}.`,
      'Stage1 send verification intentionally runs through executeMissionProtocolTool with no explicit projectRoot and CMOS_PROJECT_ROOT pinned to the server repo to prove the Sprint 53 dispatcher fix still holds.',
      ...schemaInvalidProjects.map(
        (project) =>
          `${project.name}: skipped because ${project.projectRoot} does not expose the expected CMOS metadata/context tables (${project.error}).`
      ),
    ],
  };

  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(reportData, null, 2));
  fs.writeFileSync(DOC_PATH, formatAttributionVerificationReport(reportData));

  console.log(
    JSON.stringify(
      {
        docPath: DOC_PATH,
        jsonPath: JSON_PATH,
        activeProjects: rows.length,
        missingRegistryEntries: listResult.data.missingCount,
        guard,
        stage1Send,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
