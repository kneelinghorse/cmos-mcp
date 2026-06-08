import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, afterEach } from '@jest/globals';
import { analyzeMissionOutcomes } from '../../src/intelligence/mission-outcome-analytics';

const makeTempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'mission-outcome-edge-'));

describe('mission outcome analytics edge handling', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('returns empty analytics when sprints are missing', async () => {
    tempDir = await makeTempDir();
    const backlogPath = path.join(tempDir, 'backlog.yaml');
    const sessionsPath = path.join(tempDir, 'sessions.jsonl');

    await fs.writeFile(backlogPath, 'domainFields: {}', 'utf-8');

    const analytics = await analyzeMissionOutcomes({
      backlogFile: backlogPath,
      sessionsFile: sessionsPath,
      now: new Date('2025-11-05T00:00:00Z'),
      throughputWindowDays: 7,
    });

    expect(analytics.totals).toEqual({
      missions: 0,
      completed: 0,
      inProgress: 0,
      current: 0,
      queued: 0,
      blocked: 0,
      deferred: 0,
      active: 0,
    });
    expect(analytics.sprints).toHaveLength(0);
    expect(analytics.missions).toHaveLength(0);
    expect(analytics.recentActivity).toHaveLength(0);
  });

  it('handles missing session history and mixed statuses gracefully', async () => {
    tempDir = await makeTempDir();
    const backlogPath = path.join(tempDir, 'backlog.yaml');
    const sessionsPath = path.join(tempDir, 'sessions.jsonl');

    const backlog = `domainFields:
  sprints:
    - sprintId: "Edge-1"
      title: "Edge Sprint"
      status: "active"
      missions:
        - id: "Q1"
          name: "Queued mission"
          status: "Queued"
        - id: "C1"
          name: "Current mission"
          status: "current"
        - id: "IP1"
          name: "In progress mission"
          status: "In_Progress"
        - id: "Done1"
          name: "Completed mission"
          status: "Completed"
          started_at: "2025-11-01T10:00:00Z"
          completed_at: "bad-date"
        - id: "Block1"
          name: "Blocked mission"
          status: "Blocked"
        - id: "Def1"
          name: "Deferred mission"
          status: "Deferred"
        - id: "Mystery1"
          name: "Mystery mission"
          status: "mystery"
    - sprintId: "Empty"
      title: "Empty sprint"
      status: "planning"
      missions: "n/a"
`;
    await fs.writeFile(backlogPath, backlog, 'utf-8');

    const analytics = await analyzeMissionOutcomes({
      backlogFile: backlogPath,
      sessionsFile: sessionsPath,
      now: new Date('2025-11-05T00:00:00Z'),
      throughputWindowDays: 0,
    });

    expect(analytics.totals).toEqual({
      missions: 7,
      completed: 1,
      inProgress: 1,
      current: 1,
      queued: 1,
      blocked: 1,
      deferred: 1,
      active: 3,
    });
    expect(analytics.cycleTimeMinutes).toEqual({ sampleSize: 0 });
    expect(analytics.throughput).toEqual({ windowDays: 0, completed: 0, perDay: 0 });
    expect(analytics.recentActivity).toHaveLength(0);

    const primarySprint = analytics.sprints.find((sprint) => sprint.sprintId === 'Edge-1');
    expect(primarySprint?.missionIds.length).toBe(7);
    const emptySprint = analytics.sprints.find((sprint) => sprint.sprintId === 'Empty');
    expect(emptySprint?.missionIds.length).toBe(0);
  });

  it('normalizes timestamps and filters invalid session entries', async () => {
    tempDir = await makeTempDir();
    const backlogPath = path.join(tempDir, 'backlog.yaml');
    const sessionsPath = path.join(tempDir, 'sessions.jsonl');

    const backlog = `domainFields:
  sprints:
    - sprintId: "Sprint-A"
      missions:
        - id: "X1"
          name: "Timestamp checks"
          status: "Queued"
`;
    await fs.writeFile(backlogPath, backlog, 'utf-8');

    const sessionLines = [
      '{"ts":"2025-11-01 10:00:00+0000","mission":"X1","action":"start","status":"in_progress","agent":"edge"}',
      'not-a-json-line',
      '{"ts":"2025-11-02T11:00:00N+0000","mission":"X1","action":"complete","status":"completed","agent":"edge","summary":"wrapped up"}',
      '{"ts":"2025-10-30T09:00:00Z","mission":"OTHER","action":"start"}',
      '{"ts":"2025-11-03T12:00:00Z","mission":"UNKNOWN","action":"complete","status":"completed"}',
      '{"mission":"X1","action":"blocked","status":"blocked","summary":"missing timestamp"}',
    ];
    await fs.writeFile(sessionsPath, sessionLines.join('\n'), 'utf-8');

    const analytics = await analyzeMissionOutcomes({
      backlogFile: backlogPath,
      sessionsFile: sessionsPath,
      now: new Date('2025-11-05T00:00:00Z'),
      throughputWindowDays: 10,
    });

    const [mission] = analytics.missions;
    expect(mission.startedAt).toBe('2025-11-01T10:00:00.000Z');
    expect(mission.completedAt).toBe('2025-11-02T11:00:00.000Z');
    expect(mission.cycleTimeMinutes).toBe(1500);
    expect(mission.eventCounts).toEqual({ starts: 1, completes: 1, blocks: 1 });

    expect(analytics.throughput).toEqual({ windowDays: 10, completed: 1, perDay: 0.1 });
    expect(analytics.recentActivity).toHaveLength(3);
    const actions = analytics.recentActivity.map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['start', 'complete', 'blocked']));
    const blocked = analytics.recentActivity.find((event) => event.action === 'blocked');
    expect(blocked?.ts).toBe('');
    const completed = analytics.recentActivity.find((event) => event.action === 'complete');
    expect(completed?.ts).toBe('2025-11-02T11:00:00.000Z');
  });

  it('skips malformed sprint and mission entries while parsing events', async () => {
    tempDir = await makeTempDir();
    const backlogPath = path.join(tempDir, 'backlog.yaml');
    const sessionsPath = path.join(tempDir, 'sessions.jsonl');

    const backlog = `domainFields:
  sprints:
    - 5
    - sprintId: ""
      missions:
        - id: "skip-name"
    - sprintId: "ValidSprint"
      missions:
        - "string mission"
        - id: "NegDur"
          name: "Negative duration"
          status: "done"
          started_at: "2025-11-03T10:00:00Z"
          completed_at: "2025-11-02T09:00:00Z"
        - id: "Good"
          name: "Good mission"
          status: "blocked"
          notes: "has-notes"
`;
    await fs.writeFile(backlogPath, backlog, 'utf-8');

    const sessionLines = [
      '{"mission":"Good","action":"blocked","status":"blocked","summary":"first blocker"}',
      '{"mission":"Good","action":"start","status":"in_progress"}',
      '{"ts":"2025-11-03T13:00:00Z","mission":"Good","action":"start","status":"in_progress"}',
      '{"ts":"2025-11-04T14:00:00Z","mission":"UNKNOWN","action":"complete","status":"completed"}',
    ];
    await fs.writeFile(sessionsPath, sessionLines.join('\n'), 'utf-8');

    const analytics = await analyzeMissionOutcomes({
      backlogFile: backlogPath,
      sessionsFile: sessionsPath,
      now: new Date('2025-11-05T00:00:00Z'),
      throughputWindowDays: 2,
    });

    expect(analytics.missions).toHaveLength(2);
    const negDur = analytics.missions.find((mission) => mission.id === 'NegDur');
    expect(negDur?.cycleTimeMinutes).toBeUndefined();
    const goodMission = analytics.missions.find((mission) => mission.id === 'Good');
    expect(goodMission?.eventCounts.blocks).toBe(1);
    expect(analytics.throughput.completed).toBe(0);
    expect(analytics.recentActivity.find((event) => event.action === 'blocked')?.ts).toBe('');
  });

  it('rejects empty or non-object backlog documents', async () => {
    tempDir = await makeTempDir();
    const backlogPath = path.join(tempDir, 'backlog.yaml');
    const sessionsPath = path.join(tempDir, 'sessions.jsonl');

    await fs.writeFile(backlogPath, '', 'utf-8');
    await expect(
      analyzeMissionOutcomes({
        backlogFile: backlogPath,
        sessionsFile: sessionsPath,
        now: new Date('2025-11-05T00:00:00Z'),
      })
    ).rejects.toThrow('Backlog file is empty.');

    await fs.writeFile(backlogPath, '42', 'utf-8');
    await expect(
      analyzeMissionOutcomes({
        backlogFile: backlogPath,
        sessionsFile: sessionsPath,
        now: new Date('2025-11-05T00:00:00Z'),
      })
    ).rejects.toThrow('Backlog file does not contain a mission document.');
  });
});
