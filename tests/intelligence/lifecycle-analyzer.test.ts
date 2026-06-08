import { LifecycleAnalyzer } from '../../src/intelligence/lifecycle-analyzer';
import { MissionRecord } from '../../src/intelligence/dependency-analyzer';

describe('LifecycleAnalyzer edge cases', () => {
  const analyzer = new LifecycleAnalyzer({ minAssignmentConfidence: 0.1 });

  it('normalizes mission text, deliverables, roles, and artifacts', () => {
    const mission: MissionRecord = {
      missionId: 'M1',
      name: 'Lifecycle Mission',
      objective: 'Assess lifecycle signals',
      context: 'Testing lifecycle analyzer helpers',
      successCriteria: ['Ship design doc', 'Collect qa results'],
      deliverables: 'Design Doc',
      notes: 'Include post-launch support notes',
      domainFields: { roles: 'Engineer, QA' },
    };

    const text = (analyzer as any).collectMissionText(mission);
    expect(text).toContain('assess lifecycle signals');
    expect(text).toContain('ship design doc');
    expect(text).toContain('post-launch support notes');

    const deliverablesFromArray = (analyzer as any).collectMissionDeliverables({
      missionId: 'M2',
      deliverables: ['Report', 42 as unknown as string],
    });
    expect(deliverablesFromArray).toEqual(['report']);

    const deliverablesFromString = (analyzer as any).collectMissionDeliverables({
      missionId: 'M3',
      deliverables: 'Prototype Plan',
    });
    expect(deliverablesFromString).toEqual(['prototype plan']);

    const deliverablesFallback = (analyzer as any).collectMissionDeliverables({
      missionId: 'M4',
      deliverables: 123 as unknown as string[],
    });
    expect(deliverablesFallback).toEqual([]);

    const rolesFromString = (analyzer as any).collectRoleEntries({
      missionId: 'R1',
      domainFields: { roles: 'Engineer, QA' },
    });
    expect(rolesFromString).toEqual(['engineer', 'qa']);

    const rolesFromArray = (analyzer as any).collectRoleEntries({
      missionId: 'R2',
      domainFields: { teamRoles: ['Lead', 'Designer', 99 as unknown as string] },
    });
    expect(rolesFromArray).toContain('designer');

    const roleFallback = (analyzer as any).collectRoleEntries({
      missionId: 'R3',
      domainFields: { roles: 5 as unknown as string },
    });
    expect(roleFallback).toEqual([]);

    const artifacts = (analyzer as any).extractArtifacts({
      missionId: 'A1',
      deliverables: ['Short', 'artifacttoken'],
      successCriteria: 'Usability Report',
    });
    expect(artifacts).toContain('usability report');

    expect((analyzer as any).textContains('', 'needle')).toBe(false);
    expect((analyzer as any).textContains('haystack', '   ')).toBe(false);
    expect((analyzer as any).textContains('design document ready', 'design document')).toBe(true);
    expect((analyzer as any).textContains('guards regex+chars', 'regex+chars')).toBe(true);
    expect((analyzer as any).isArtifactCandidate('short')).toBe(false);
    expect((analyzer as any).isArtifactCandidate('longsingleword')).toBe(false);
  });

  it('handles lifecycle dependency ordering, ties, and low-confidence assignments', () => {
    const missions: MissionRecord[] = [
      { missionId: 'A0' },
      { missionId: 'A1' },
      { missionId: 'A2' },
      { missionId: 'A3' },
      { missionId: 'A4' },
    ];

    const assignments = {
      A0: [
        { phaseType: 'SDLC', phase: 'System Design', confidence: 0.8, score: 0.8, evidence: [] },
      ],
      A1: [
        { phaseType: 'SDLC', phase: 'Implementation', confidence: 0.9, score: 0.9, evidence: [] },
      ],
      A2: [
        { phaseType: 'SDLC', phase: 'Implementation', confidence: 0.85, score: 0.85, evidence: [] },
      ],
      A3: [
        { phaseType: 'SDLC', phase: 'Unknown Phase', confidence: 0.95, score: 0.95, evidence: [] },
      ],
      A4: [{ phaseType: 'SDLC', phase: 'Testing & QA', confidence: 0.5, score: 0.5, evidence: [] }],
    };

    const { dependencies, anomalies } = (analyzer as any).buildLifecycleDependencies(
      missions,
      assignments
    );

    expect(anomalies.some((anomaly: any) => anomaly.missionId === 'A1')).toBe(true);
    expect(dependencies.some((dep: any) => dep.from === 'A2' && dep.to === 'A0')).toBe(true);
  });

  it('builds artifact dependencies, skips missing producers, and deduplicates links', () => {
    const missions: MissionRecord[] = [
      { missionId: 'P1', deliverables: 'Design Document' },
      { missionId: 'C1', objective: 'Consumes design document' },
      { missionId: 'C1', notes: 'Design document handed over again' },
    ];

    const textIndex = new Map(
      missions.map((mission) => [
        mission.missionId,
        (analyzer as any).collectMissionText(mission as MissionRecord),
      ])
    );

    const assignments = {
      P1: [
        { phaseType: 'SDLC', phase: 'Implementation', confidence: 0.9, score: 0.9, evidence: [] },
      ],
      C1: [{ phaseType: 'SDLC', phase: 'Testing & QA', confidence: 0.8, score: 0.8, evidence: [] }],
    };

    const emptyArtifactIndex = new Map([['prototype plan', []]]);
    const emptyResult = (analyzer as any).buildArtifactDependencies(
      missions,
      assignments,
      textIndex,
      emptyArtifactIndex
    );
    expect(emptyResult.dependencies).toHaveLength(0);

    const artifactIndex = new Map([
      [
        'design document',
        [
          {
            missionId: 'P1',
            artifact: 'Design Document',
          },
        ],
      ],
    ]);

    const result = (analyzer as any).buildArtifactDependencies(
      missions,
      assignments,
      textIndex,
      artifactIndex
    );

    expect(result.dependencies.some((dep: any) => dep.from === 'C1' && dep.to === 'P1')).toBe(true);
    expect(result.dependencies.filter((dep: any) => dep.from === 'C1').length).toBe(1);
  });
});
