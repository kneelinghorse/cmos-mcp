import path from 'path';
import { analyzeMissionOutcomes } from '../../src/intelligence/mission-outcome-analytics';

describe('mission outcome analytics', () => {
  const fixturesDir = path.join(__dirname, '..', 'test-data', 'mission-outcome');
  const backlogPath = path.join(fixturesDir, 'backlog.yaml');
  const sessionsPath = path.join(fixturesDir, 'sessions.jsonl');

  it('produces aggregated analytics from backlog and session history', async () => {
    const now = new Date('2025-10-05T00:00:00Z');
    const analytics = await analyzeMissionOutcomes({
      backlogFile: backlogPath,
      sessionsFile: sessionsPath,
      now,
      throughputWindowDays: 7,
    });

    expect(analytics.generatedAt).toBe(now.toISOString());
    expect(analytics.totals).toEqual({
      missions: 6,
      completed: 1,
      inProgress: 1,
      current: 1,
      queued: 1,
      blocked: 1,
      deferred: 1,
      active: 3,
    });

    expect(analytics.cycleTimeMinutes).toEqual({
      sampleSize: 1,
      average: 150,
      median: 150,
      p90: 150,
      fastest: 150,
      slowest: 150,
    });

    expect(analytics.throughput).toEqual({
      windowDays: 7,
      completed: 1,
      perDay: 0.14,
    });

    expect(analytics.sprints).toHaveLength(2);
    const [primarySprint, deferredSprint] = analytics.sprints;

    expect(primarySprint).toMatchObject({
      sprintId: 'Sprint Test',
      totals: {
        missions: 5,
        completed: 1,
        inProgress: 1,
        current: 1,
        queued: 1,
        blocked: 1,
        deferred: 0,
        active: 3,
      },
      progressRatio: 0.2,
      firstStartedAt: '2025-10-01T10:00:00.000Z',
      lastCompletedAt: '2025-10-01T12:30:00.000Z',
    });

    expect(deferredSprint).toMatchObject({
      sprintId: 'Sprint Deferred',
      totals: {
        missions: 1,
        completed: 0,
        inProgress: 0,
        current: 0,
        queued: 0,
        blocked: 0,
        deferred: 1,
        active: 0,
      },
      progressRatio: 0,
      firstStartedAt: undefined,
      lastCompletedAt: undefined,
    });

    expect(analytics.missions).toHaveLength(6);
    const [t1, t2] = analytics.missions;

    expect(t1).toMatchObject({
      id: 'T1',
      status: 'Completed',
      startedAt: '2025-10-01T10:00:00.000Z',
      completedAt: '2025-10-01T12:30:00.000Z',
      cycleTimeMinutes: 150,
      agentsInvolved: ['tester-a'],
      eventCounts: { starts: 1, completes: 1, blocks: 0 },
    });

    expect(t2.agentsInvolved).toEqual(['tester-b']);
    expect(t2.eventCounts).toEqual({ starts: 2, completes: 0, blocks: 1 });
    expect(t2.lastEvent).toMatchObject({
      mission: 'T2',
      action: 'start',
      status: 'in_progress',
      agent: 'tester-b',
      summary: 'Resumed work',
    });

    expect(analytics.recentActivity[0]).toMatchObject({
      mission: 'T2',
      action: 'start',
      agent: 'tester-b',
      summary: 'Resumed work',
    });
  });
});
