// ABOUTME: Unit coverage for the Sprint 54 attribution verification report helper.
// ABOUTME: Verifies active-project selection, follow-up derivation, and markdown rendering.

import { describe, expect, it } from '@jest/globals';

import type { ProjectListItem } from '../../src/tools/cmos/cmos-project-list';
import {
  collectVerificationFollowUps,
  formatAttributionVerificationReport,
  selectActiveVerificationProjects,
  type FirstContactHealStatus,
  type VerificationRow,
} from '../../src/intelligence/attribution-verification';

function makeProject(
  overrides: Partial<ProjectListItem> & Pick<ProjectListItem, 'projectRoot' | 'name'>
): ProjectListItem {
  return {
    projectRoot: overrides.projectRoot,
    name: overrides.name,
    isDefault: overrides.isDefault ?? false,
    dbExists: overrides.dbExists ?? true,
    registeredAt: overrides.registeredAt ?? new Date(Date.now() - 60_000).toISOString(),
    lastAccessedAt: overrides.lastAccessedAt ?? new Date(Date.now() - 30_000).toISOString(),
  };
}

function makeRow(
  overrides: Partial<VerificationRow> & Pick<VerificationRow, 'name' | 'projectRoot'>
): VerificationRow {
  const pick = <K extends keyof VerificationRow>(key: K, fallback: VerificationRow[K]) =>
    key in overrides ? (overrides[key] as VerificationRow[K]) : fallback;

  return {
    name: overrides.name,
    projectRoot: overrides.projectRoot,
    resolvedAddress: pick('resolvedAddress', 'cmos://derek/example'),
    source: pick('source', 'cwd'),
    dashboardProjectId: pick('dashboardProjectId', '11111111-1111-1111-1111-111111111111'),
    firstContactHealStatus: pick('firstContactHealStatus', 'not-needed' as FirstContactHealStatus),
    preVerificationAddress: pick('preVerificationAddress', 'cmos://derek/example'),
    postVerificationAddress: pick('postVerificationAddress', 'cmos://derek/example'),
    sendCheck: pick('sendCheck', {
      status: 'not-run',
      dashboardRecordedSender: null,
      details: null,
      messageId: null,
      targetAddress: null,
    }),
    notes: pick('notes', []),
  };
}

describe('attribution verification helper', () => {
  it('keeps only active registry projects and sorts them by name', () => {
    const projects = [
      makeProject({
        name: 'TraceLab',
        projectRoot: '/tmp/tracelab',
      }),
      makeProject({
        name: 'Broken Temp',
        projectRoot: '/tmp/missing',
        dbExists: false,
      }),
      makeProject({
        name: 'CMOS MCP',
        projectRoot: '/tmp/cmos-mcp',
      }),
    ];

    expect(selectActiveVerificationProjects(projects)).toEqual([
      expect.objectContaining({ name: 'CMOS MCP', projectRoot: '/tmp/cmos-mcp' }),
      expect.objectContaining({ name: 'TraceLab', projectRoot: '/tmp/tracelab' }),
    ]);
  });

  it('derives follow-ups for unresolved identities, failed heals, and failed sends', () => {
    const rows = [
      makeRow({
        name: 'TraceLab',
        projectRoot: '/tmp/tracelab',
        resolvedAddress: null,
        dashboardProjectId: null,
        firstContactHealStatus: 'heal-failed',
        preVerificationAddress: 'cmos://unknown/tracelab',
        postVerificationAddress: 'cmos://unknown/tracelab',
        sendCheck: {
          status: 'fail',
          details: 'dashboard recorded sender mismatch',
          dashboardRecordedSender: 'cmos://derek/cmos-mcp',
          messageId: 'msg-1',
          targetAddress: 'cmos://derek/oods-foundry-mcp',
        },
      }),
    ];

    expect(collectVerificationFollowUps(rows)).toEqual([
      'TraceLab: first-contact auto-heal did not produce a canonical cmos_address; check project_identity and dashboard owner/slug metadata before relying on cross-project sends.',
      'TraceLab: local metadata.dashboard_project_id is missing or invalid; outbound sends will fail closed until registration is repaired.',
      'TraceLab: send verification failed (dashboard recorded sender mismatch).',
      'TraceLab: whoami did not resolve a canonical cmos_address; inspect local project_identity and dashboard owner/slug metadata.',
    ]);
  });

  // Sprint 55 m04 regression: a project whose pre-verification address was
  // already canonical must render as 'not-needed' and produce no heal follow-up.
  // Pre-fix, the boolean `healedOnFirstContact: false` made every healthy
  // project look broken in the report.
  it('renders heal status as not-needed for projects whose pre-address was already canonical', () => {
    const rows = [
      makeRow({
        name: 'Healthy Project',
        projectRoot: '/tmp/healthy',
        firstContactHealStatus: 'not-needed',
        preVerificationAddress: 'cmos://derek/healthy',
        postVerificationAddress: 'cmos://derek/healthy',
      }),
    ];

    expect(collectVerificationFollowUps(rows)).toEqual([]);
    const markdown = formatAttributionVerificationReport({
      generatedAt: '2026-04-17T02:00:00.000Z',
      registryTotal: 1,
      missingCount: 0,
      guard: { passed: true, reason: 'ok' },
      rows,
    });
    expect(markdown).toContain('n/a (already canonical)');
    expect(markdown).not.toContain('did not heal on first contact');
  });

  it('renders a markdown report with summary, appendix rows, and notes', () => {
    const markdown = formatAttributionVerificationReport({
      generatedAt: '2026-04-16T18:45:00.000Z',
      registryTotal: 12,
      missingCount: 7,
      guard: {
        passed: true,
        reason: 'strict sender resolution rejected SERVER_INSTALL_ROOT with the cwd guard.',
      },
      rows: [
        makeRow({
          name: 'Stage1',
          projectRoot: '/Users/systemsystems/portfolio/Design-Tools/Stage1',
          resolvedAddress: 'cmos://derek/stage1',
          firstContactHealStatus: 'healed',
          preVerificationAddress: 'cmos://unknown/stage1',
          postVerificationAddress: 'cmos://derek/stage1',
          sendCheck: {
            status: 'pass',
            targetAddress: 'cmos://derek/oods-foundry-mcp',
            dashboardRecordedSender: 'cmos://derek/stage1',
            messageId: 'msg-stage1',
            details: 'dispatcher send attributed correctly',
          },
          notes: ['healed stale address on first whoami'],
        }),
      ],
      notes: ['Active-project scope intentionally excludes dead temp registry fixtures.'],
    });

    expect(markdown).toContain('# Attribution Rebuild Verification');
    expect(markdown).toContain('- Registry entries reviewed: 12');
    expect(markdown).toContain(
      '| Stage1 | Stage1 | cmos://derek/stage1 | cwd | yes | pass (cmos://derek/stage1) | cmos://derek/stage1 |'
    );
    expect(markdown).toContain('Send message ID: msg-stage1');
    expect(markdown).toContain('Notes: healed stale address on first whoami');
    expect(markdown).toContain('## Notes');
    expect(markdown).toContain(
      'Active-project scope intentionally excludes dead temp registry fixtures.'
    );
  });
});
