import { describe, expect, test, afterEach } from '@jest/globals';
import path from 'path';
import { promises as fs } from 'fs';
import * as YAML from 'yaml';

import { ensureTempDir } from '../../src/utils/fs';
import { AgentsMdLoader } from '../../src/intelligence/agents-md-loader';
import { analyzeMissionOutcomes } from '../../src/intelligence/mission-outcome-analytics';

const SAMPLE_AGENTS_MD = [
  '# Interoperability Guidance',
  '',
  '## Project Overview',
  '- Mission Protocol analytics consume CMOS context to drive QA scenarios.',
  '',
  '## Build & Development Commands',
  '- Run `npx jest --runInBand tests/integration/cmos-mission-interoperability.test.ts`',
  '',
  '## AI Agent Specific Instructions',
  '- Synchronize agents.md guidance with mission backlog updates.',
  '- Keep sessions.jsonl append-only and timestamped in UTC.',
  '- Confirm analytics totals after every run.',
  '',
  '**Version**: 1.2.3',
].join('\n');

const SAMPLE_SESSIONS = [
  {
    ts: '2025-11-04T04:45:00Z',
    agent: 'codex',
    mission: 'QA-AGENTIC',
    action: 'start',
    status: 'in_progress',
    summary: 'Kickoff: validating CMOS ↔ Mission Protocol handshake.',
  },
  {
    ts: '2025-11-04T05:15:00Z',
    agent: 'codex',
    mission: 'QA-AGENTIC',
    action: 'complete',
    status: 'completed',
    summary: 'Handshake telemetry validated; preparing telemetry contract run.',
  },
  {
    ts: '2025-11-04T05:10:00Z',
    agent: 'codex',
    mission: 'QA-TELEMETRY',
    action: 'start',
    status: 'in_progress',
    summary: 'Telemetry contract QA run in progress.',
  },
];

const AGENTIC_MISSION_YAML = YAML.stringify({
  missionId: 'QA-AGENTIC',
  objective: 'Validate CMOS ↔ Mission Protocol handshake',
  status: 'Completed',
  notes: 'Telemetry handshake validated across CMOS and Mission Protocol.',
});

const TELEMETRY_MISSION_YAML = YAML.stringify({
  missionId: 'QA-TELEMETRY',
  objective: 'Capture telemetry contract evidence for interoperability',
  status: 'In Progress',
  notes: 'QA harness collecting live telemetry samples.',
});

describe('CMOS ↔ Mission Protocol interoperability', () => {
  const loader = new AgentsMdLoader({ cacheTtlMs: 0 });

  afterEach(() => {
    loader.clearCache();
  });

  test('agents.md guidance stays aligned with mission analytics', async () => {
    const [agenticMission, telemetryMission] = [
      YAML.parse(AGENTIC_MISSION_YAML) as { missionId: string; objective: string },
      YAML.parse(TELEMETRY_MISSION_YAML) as { missionId: string; objective: string },
    ];

    const workspace = await ensureTempDir('cmos-mission-interop-');

    const agentsPath = path.join(workspace, 'agents.md');
    await fs.writeFile(agentsPath, SAMPLE_AGENTS_MD, 'utf-8');

    const backlogPath = path.join(workspace, 'backlog.yaml');
    const backlogObject = {
      domainFields: {
        sprints: [
          {
            sprintId: 'QA Sprint',
            title: 'Agentic Integration QA',
            status: 'Current',
            missions: [
              {
                id: agenticMission.missionId,
                name: agenticMission.objective,
                status: 'Completed',
                started_at: '2025-11-04T04:45:00Z',
                completed_at: '2025-11-04T05:15:00Z',
                notes: 'Telemetry handshake validated across CMOS and Mission Protocol.',
              },
              {
                id: telemetryMission.missionId,
                name: telemetryMission.objective,
                status: 'In Progress',
                started_at: '2025-11-04T05:10:00Z',
                notes: 'QA harness collecting live telemetry samples.',
              },
              {
                id: 'QA-DOCS',
                name: 'Document QA harness usage and troubleshooting tips.',
                status: 'Queued',
                notes: 'Draft runbook outlining interoperability validation steps.',
              },
            ],
          },
        ],
      },
    };
    await fs.writeFile(backlogPath, YAML.stringify(backlogObject), 'utf-8');

    const sessionsPath = path.join(workspace, 'sessions.jsonl');
    const sessionsPayload = SAMPLE_SESSIONS.map((entry) => JSON.stringify(entry)).join('\n');
    await fs.writeFile(sessionsPath, `${sessionsPayload}\n`, 'utf-8');

    const projectContext = {
      working_memory: {
        agents_md_path: './agents.md',
        agents_md_loaded: false,
        agents_md_version: '0.0.0',
        active_mission: telemetryMission.missionId,
      },
    };

    const loadResult = await loader.load(workspace, projectContext);

    expect(loadResult.loaded).toBe(true);
    expect(loadResult.sections?.['Project Overview']).toMatch(/Mission Protocol analytics/);
    expect(loadResult.sections?.['AI Agent Specific Instructions']).toMatch(/sessions.jsonl/);
    expect(loadResult.version).toBe('1.2.3');
    expect(loadResult.contextPatch.working_memory).toEqual({
      agents_md_path: './agents.md',
      agents_md_loaded: true,
      agents_md_version: '1.2.3',
    });
    expect(
      loadResult.validations.some((validation) => validation.code === 'AGENTS_MD_LOAD_METRICS')
    ).toBe(true);

    const mergedWorkingMemory = {
      ...projectContext.working_memory,
      ...loadResult.contextPatch.working_memory,
    };

    expect(mergedWorkingMemory).toEqual({
      agents_md_path: './agents.md',
      agents_md_loaded: true,
      agents_md_version: '1.2.3',
      active_mission: telemetryMission.missionId,
    });

    const analytics = await analyzeMissionOutcomes({
      backlogFile: backlogPath,
      sessionsFile: sessionsPath,
      now: new Date('2025-11-04T06:00:00Z'),
      throughputWindowDays: 7,
    });

    expect(analytics.totals.missions).toBe(3);
    expect(analytics.totals.completed).toBe(1);
    expect(analytics.totals.inProgress).toBe(1);
    expect(analytics.totals.queued).toBe(1);
    expect(analytics.totals.active).toBeGreaterThanOrEqual(1);
    expect(analytics.throughput.windowDays).toBe(7);
    expect(analytics.throughput.completed).toBe(1);
    expect(analytics.throughput.perDay).toBeCloseTo(1 / 7, 2);

    const agenticOutcome = analytics.missions.find(
      (mission) => mission.id === agenticMission.missionId
    );
    expect(agenticOutcome?.status).toBe('Completed');
    expect(agenticOutcome?.cycleTimeMinutes).toBe(30);
    expect(agenticOutcome?.eventCounts.completes).toBe(1);
    expect(agenticOutcome?.agentsInvolved).toContain('codex');

    const telemetryOutcome = analytics.missions.find(
      (mission) => mission.id === telemetryMission.missionId
    );
    expect(telemetryOutcome?.status).toBe('In Progress');
    expect(telemetryOutcome?.eventCounts.starts).toBe(1);
    expect(telemetryOutcome?.agentsInvolved).toContain('codex');

    const recentMissionIds = analytics.recentActivity.map((event) => event.mission);
    expect(recentMissionIds).toEqual(
      expect.arrayContaining([agenticMission.missionId, telemetryMission.missionId])
    );

    expect(telemetryOutcome?.status).toBe('In Progress');
  });
});
