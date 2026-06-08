// ABOUTME: Pure helpers for Sprint 54 attribution verification reporting.
// ABOUTME: Filters active registry projects, derives follow-ups, and renders the verification doc.

import path from 'path';

import type { ProjectListItem } from '../tools/cmos/cmos-project-list';
import type { SenderResolutionSource } from './sender-context';

export type VerificationProject = ProjectListItem;

export interface VerificationSendCheck {
  readonly status: 'pass' | 'fail' | 'not-run';
  readonly targetAddress?: string | null;
  readonly messageId?: string | null;
  readonly dashboardRecordedSender?: string | null;
  readonly details?: string | null;
}

/**
 * Sprint 55 m04: tri-state replacement for the prior boolean `healedOnFirstContact`
 * flag. The old boolean conflated two distinct cases — "project never needed
 * healing because its cmos_address was already canonical" and "heal was attempted
 * but the backfill couldn't rewrite the address" — so the Sprint 54 verification
 * report showed `no` for all 12 active projects and produced the false-positive
 * Track E2 caveat. The three states now mirror the actual resolver outcome:
 *
 *   - `not-needed`: the pre-verification cmos_address was already canonical, so
 *     the resolver's heal branch (validateProject @ sender-context.ts:186-199)
 *     correctly skipped backfill. This is the common case for healthy projects.
 *   - `healed`: the pre-verification cmos_address was empty or `cmos://unknown/*`
 *     and `backfillUnknownCmosAddress` rewrote it to a canonical address during
 *     whoami.
 *   - `heal-failed`: the pre-verification cmos_address was empty or stale and
 *     auto-heal ran but couldn't produce a canonical address (typically because
 *     project_identity is missing, or the dashboard owner/slug metadata is
 *     absent). This is the signal Track E2 actually wants to surface.
 */
export type FirstContactHealStatus = 'not-needed' | 'healed' | 'heal-failed';

export interface VerificationRow {
  readonly name: string;
  readonly projectRoot: string;
  readonly resolvedAddress: string | null;
  readonly source: SenderResolutionSource | null;
  readonly dashboardProjectId: string | null;
  readonly firstContactHealStatus: FirstContactHealStatus;
  readonly preVerificationAddress: string | null;
  readonly postVerificationAddress: string | null;
  readonly sendCheck: VerificationSendCheck;
  readonly notes: readonly string[];
}

export interface GuardVerification {
  readonly passed: boolean;
  readonly reason: string;
}

export interface AttributionVerificationReport {
  readonly generatedAt: string;
  readonly registryTotal: number;
  readonly missingCount: number;
  readonly rows: readonly VerificationRow[];
  readonly guard: GuardVerification;
  readonly notes?: readonly string[];
}

function compareProjectNames(left: ProjectListItem, right: ProjectListItem): number {
  const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) {
    return byName;
  }
  return left.projectRoot.localeCompare(right.projectRoot);
}

function valueOrDash(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : '-';
}

function formatHealStatus(status: FirstContactHealStatus): string {
  switch (status) {
    case 'healed':
      return 'yes';
    case 'heal-failed':
      return 'no (heal failed)';
    case 'not-needed':
    default:
      return 'n/a (already canonical)';
  }
}

function formatSendCheck(sendCheck: VerificationSendCheck): string {
  switch (sendCheck.status) {
    case 'pass':
      return `pass (${valueOrDash(sendCheck.dashboardRecordedSender)})`;
    case 'fail':
      return `fail (${valueOrDash(sendCheck.details)})`;
    default:
      return 'not run';
  }
}

export function selectActiveVerificationProjects(
  projects: readonly ProjectListItem[]
): VerificationProject[] {
  return [...projects].filter((project) => project.dbExists).sort(compareProjectNames);
}

export function collectVerificationFollowUps(rows: readonly VerificationRow[]): string[] {
  const followUps = new Set<string>();

  for (const row of rows) {
    if (!row.dashboardProjectId) {
      followUps.add(
        `${row.name}: local metadata.dashboard_project_id is missing or invalid; outbound sends will fail closed until registration is repaired.`
      );
    }

    if (!row.resolvedAddress) {
      followUps.add(
        `${row.name}: whoami did not resolve a canonical cmos_address; inspect local project_identity and dashboard owner/slug metadata.`
      );
    }

    // Sprint 55 m04: the heal-failed signal now comes directly from the tri-state
    // status instead of being re-derived from pre/post address shape. This catches
    // the empty-address-never-healed case the old preUnknown+postUnknown check
    // missed (e.g. Design Tools Orchestration with no project_identity seeded).
    if (row.firstContactHealStatus === 'heal-failed') {
      followUps.add(
        `${row.name}: first-contact auto-heal did not produce a canonical cmos_address; check project_identity and dashboard owner/slug metadata before relying on cross-project sends.`
      );
    }

    if (row.sendCheck.status === 'fail') {
      followUps.add(
        `${row.name}: send verification failed (${valueOrDash(row.sendCheck.details)}).`
      );
    }
  }

  return [...followUps].sort((left, right) => left.localeCompare(right));
}

export function formatAttributionVerificationReport(report: AttributionVerificationReport): string {
  const rows = [...report.rows].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  );
  const followUps = collectVerificationFollowUps(rows);
  const lines = [
    '<!-- ABOUTME: Sprint 54 verification report for the post-Sprint-53 sender-attribution rebuild. -->',
    '<!-- ABOUTME: Captures live whoami + send results across active registered CMOS sibling projects. -->',
    '',
    '# Attribution Rebuild Verification',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Registry entries reviewed: ${report.registryTotal}`,
    `- Active projects verified: ${rows.length}`,
    `- Missing registry fixtures skipped: ${report.missingCount}`,
    `- Install-root guard: ${report.guard.passed ? 'pass' : 'fail'} — ${report.guard.reason}`,
    '',
    '## Appendix',
    '',
    '| Project | Root | Resolved address | Source | First-contact heal | Send test | Dashboard recorded sender |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${path.basename(row.projectRoot)} | ${valueOrDash(row.resolvedAddress)} | ${valueOrDash(row.source)} | ${formatHealStatus(row.firstContactHealStatus)} | ${formatSendCheck(row.sendCheck)} | ${valueOrDash(row.sendCheck.dashboardRecordedSender)} |`
    );
    lines.push(`Project root: \`${row.projectRoot}\``);
    lines.push(`Pre-verification address: ${valueOrDash(row.preVerificationAddress)}`);
    lines.push(`Post-verification address: ${valueOrDash(row.postVerificationAddress)}`);
    lines.push(`Dashboard project ID: ${valueOrDash(row.dashboardProjectId)}`);

    if (row.sendCheck.targetAddress) {
      lines.push(`Send target: ${row.sendCheck.targetAddress}`);
    }
    if (row.sendCheck.messageId) {
      lines.push(`Send message ID: ${row.sendCheck.messageId}`);
    }
    if (row.sendCheck.details) {
      lines.push(`Send details: ${row.sendCheck.details}`);
    }
    if (row.notes.length > 0) {
      lines.push(`Notes: ${row.notes.join(' | ')}`);
    }
    lines.push('');
  }

  lines.push('## Follow-ups');
  lines.push('');
  if (followUps.length === 0) {
    lines.push('- None.');
  } else {
    for (const followUp of followUps) {
      lines.push(`- ${followUp}`);
    }
  }

  if (report.notes && report.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
