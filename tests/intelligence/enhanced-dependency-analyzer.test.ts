import { DependencyAnalyzer } from '../../src/intelligence/dependency-analyzer';
import {
  EnhancedDependencyAnalyzer,
  EnhancedDependencyAnalysisResult,
} from '../../src/intelligence/enhanced-dependency-analyzer';
import {
  MissionHistoryAnalyzer,
  MissionTransitionEdge,
  MissionHistoryHighlight,
} from '../../src/intelligence/mission-history';
import { ContextPropagatorV2 } from '../../src/intelligence/context-propagator-v2';

class StubMissionHistoryAnalyzer extends MissionHistoryAnalyzer {
  constructor(
    private readonly transitions: MissionTransitionEdge[] = [],
    private readonly highlights: MissionHistoryHighlight[] = []
  ) {
    super({ sessionsPath: '' });
  }

  async deriveTransitions(): Promise<MissionTransitionEdge[]> {
    return this.transitions;
  }

  async collectHighlights(
    missionIds: Iterable<string>,
    limitPerMission = 1
  ): Promise<MissionHistoryHighlight[]> {
    const requested = new Set(missionIds);
    if (requested.size === 0) {
      return [];
    }

    const grouped = new Map<string, MissionHistoryHighlight[]>();
    for (const highlight of this.highlights) {
      if (!requested.has(highlight.missionId)) {
        continue;
      }
      if (!grouped.has(highlight.missionId)) {
        grouped.set(highlight.missionId, []);
      }
      grouped.get(highlight.missionId)!.push(highlight);
    }

    const pruned: MissionHistoryHighlight[] = [];
    for (const items of grouped.values()) {
      pruned.push(...items.slice(0, limitPerMission));
    }

    return pruned;
  }
}

describe('EnhancedDependencyAnalyzer', () => {
  it('injects implicit dependencies derived from history', async () => {
    const history = new StubMissionHistoryAnalyzer([
      {
        from: 'B2',
        to: 'B1',
        confidence: 0.75,
        reason: 'next_hint:B1 completed -> move to B2',
        source: 'next_hint',
        ts: '2025-10-01T00:00:00Z',
      },
    ]);

    const analyzer = new EnhancedDependencyAnalyzer(history, new DependencyAnalyzer());
    const result = (await analyzer.analyze([
      {
        missionId: 'B1',
        filePath: 'missions/B1.yaml',
      },
      {
        missionId: 'B2',
        filePath: 'missions/B2.yaml',
      },
    ])) as EnhancedDependencyAnalysisResult;

    const node = result.graph.nodes.get('B2');
    expect(node).toBeDefined();
    expect(node?.dependencies).toContain('B1');
    expect(node?.implicitDependencies).toContain('B1');
    expect(result.historyDependencies).toHaveLength(1);
  });

  it('ignores history transitions that do not match provided missions', async () => {
    const history = new StubMissionHistoryAnalyzer([
      {
        from: 'B3',
        to: 'B1',
        confidence: 0.5,
        reason: 'sequence:B1->B3',
        source: 'sequence',
        ts: '2025-10-01T01:00:00Z',
      },
    ]);

    const analyzer = new EnhancedDependencyAnalyzer(history, new DependencyAnalyzer());
    const result = await analyzer.analyze([
      {
        missionId: 'B1',
        filePath: 'missions/B1.yaml',
      },
      {
        missionId: 'B2',
        filePath: 'missions/B2.yaml',
      },
    ]);

    const node = result.graph.nodes.get('B2');
    expect(node?.dependencies || []).not.toContain('B1');
    expect(result.historyDependencies).toHaveLength(0);
  });

  it('records implicit dependencies even when already present explicitly', async () => {
    const history = new StubMissionHistoryAnalyzer([
      {
        from: 'B2',
        to: 'B1',
        confidence: 0.6,
        reason: 'next_hint:B2 promotes follow-up work on B1',
        source: 'next_hint',
        ts: '2025-10-01T02:00:00Z',
      },
    ]);

    const analyzer = new EnhancedDependencyAnalyzer(history, new DependencyAnalyzer());
    const result = await analyzer.analyze([
      {
        missionId: 'B1',
        filePath: 'missions/B1.yaml',
      },
      {
        missionId: 'B2',
        domainFields: {
          handoffContext: {
            dependencies: ['B1'],
          },
        },
        filePath: 'missions/B2.yaml',
      },
    ]);

    const node = result.graph.nodes.get('B2');
    expect(node?.dependencies).toContain('B1');
    expect(node?.implicitDependencies).toContain('B1');
  });

  it('infers lifecycle dependencies and augments metadata', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const analyzer = new EnhancedDependencyAnalyzer(history, new DependencyAnalyzer());

    const missions = [
      {
        missionId: 'P1',
        name: 'Ideation Workshop',
        objective: 'Brainstorm new product ideas and capture concept brief for leadership review.',
        deliverables: ['Concept brief document'],
        filePath: 'missions/P1.yaml',
      },
      {
        missionId: 'R6.2',
        name: 'Market Research Interviews',
        objective:
          'Conduct market research interviews and validation studies with target customers.',
        deliverables: ['Research insights report'],
        context: 'Validation of MVP direction using customer interviews.',
        filePath: 'missions/R6.2.yaml',
      },
      {
        missionId: 'S6.1',
        name: 'Requirements Specification Draft',
        objective: 'Document detailed product requirements and acceptance criteria for MVP scope.',
        deliverables: ['Product Requirements Document'],
        domainFields: { type: 'Planning.Requirements.v1' },
        filePath: 'missions/S6.1.yaml',
      },
      {
        missionId: 'B6.2',
        name: 'Implementation Sprint',
        objective: 'Implement MVP codebase and integrate core application logic.',
        deliverables: ['Source code modules'],
        domainFields: { type: 'Build.Implementation.v1', teamRoles: ['Engineering'] },
        filePath: 'missions/B6.2.yaml',
      },
      {
        missionId: 'Q6.2',
        name: 'QA Regression Testing',
        objective: 'Execute regression testing, QA validation, and bug triage.',
        deliverables: ['Test report'],
        domainFields: { type: 'Quality.Assurance.v1', teamRoles: ['QA Engineer'] },
        filePath: 'missions/Q6.2.yaml',
      },
    ];

    const result = (await analyzer.analyze(missions)) as EnhancedDependencyAnalysisResult;

    expect(
      result.lifecycleDependencies.some(
        (dep) => dep.from === 'R6.2' && dep.to === 'P1' && dep.source === 'lifecycle-sequencing'
      )
    ).toBe(true);
    expect(
      result.lifecycleDependencies.some(
        (dep) => dep.from === 'B6.2' && dep.to === 'S6.1' && dep.source === 'lifecycle-sequencing'
      )
    ).toBe(true);
    expect(
      result.lifecycleDependencies.some(
        (dep) => dep.from === 'Q6.2' && dep.to === 'B6.2' && dep.source === 'lifecycle-sequencing'
      )
    ).toBe(true);

    const qNode = result.graph.nodes.get('Q6.2');
    expect(qNode?.implicitDependencies).toContain('B6.2');

    const assignments = result.lifecycleAssignments['B6.2'] ?? [];
    expect(assignments.some((phase) => phase.phase === 'Implementation')).toBe(true);
  });

  it('flags lifecycle sequencing violations when prerequisites are missing', async () => {
    const history = new StubMissionHistoryAnalyzer();
    const analyzer = new EnhancedDependencyAnalyzer(history, new DependencyAnalyzer());

    const missions = [
      {
        missionId: 'B8',
        name: 'Implementation Push',
        objective: 'Develop production features and complete coding tasks.',
        deliverables: ['Source code packages'],
        domainFields: { type: 'Build.Implementation.v1', teamRoles: ['Backend Engineer'] },
        filePath: 'missions/B8.yaml',
      },
      {
        missionId: 'D8',
        name: 'Production Deployment',
        objective: 'Prepare deployment runbook and execute production release.',
        deliverables: ['Release checklist'],
        domainFields: { type: 'Operations.Deployment.v1', teamRoles: ['DevOps'] },
        filePath: 'missions/D8.yaml',
      },
    ];

    const result = (await analyzer.analyze(missions)) as EnhancedDependencyAnalysisResult;

    expect(result.lifecycleWarnings.some((warning) => warning.missionId === 'B8')).toBe(true);
    expect(result.lifecycleWarnings.some((warning) => warning.missionId === 'D8')).toBe(true);

    const bNode = result.graph.nodes.get('B8');
    expect(bNode?.implicitDependencies ?? []).toHaveLength(0);
  });
});

describe('ContextPropagatorV2', () => {
  it('enriches summary with relevant mission history highlights', async () => {
    const history = new StubMissionHistoryAnalyzer(
      [],
      [
        {
          missionId: 'B1',
          ts: '2025-10-01T01:01:00Z',
          summary: 'Completed B1 with architecture decisions captured.',
          agent: 'gpt-5-codex',
        },
      ]
    );

    const propagator = new ContextPropagatorV2({ maxContextTokens: 2048 }, history);

    const result = await propagator.propagateContext('Mission B2 objective text', [], 'B2', {
      relatedMissionIds: ['B1'],
    });

    expect(result.historyHighlights).toHaveLength(1);
    expect(result.historyHighlights[0].missionId).toBe('B1');
  });

  it('can disable history enrichment when requested', async () => {
    const history = new StubMissionHistoryAnalyzer(
      [],
      [
        {
          missionId: 'B1',
          ts: '2025-10-01T01:01:00Z',
          summary: 'Completed B1.',
          agent: 'gpt-5-codex',
        },
      ]
    );

    const propagator = new ContextPropagatorV2({ maxContextTokens: 2048 }, history);
    const result = await propagator.propagateContext('Mission B2', [], 'B2', {
      relatedMissionIds: ['B1'],
      includeHistory: false,
    });

    expect(result.historyHighlights).toHaveLength(0);
  });

  it('skips history lookup when no related missions supplied', async () => {
    const history = new StubMissionHistoryAnalyzer(
      [],
      [
        {
          missionId: 'B1',
          ts: '2025-10-01T01:01:00Z',
          summary: 'Completed B1.',
          agent: 'gpt-5-codex',
        },
      ]
    );

    const propagator = new ContextPropagatorV2({ maxContextTokens: 2048 }, history);
    const result = await propagator.propagateContext('Mission B2', [], 'B2');

    expect(result.historyHighlights).toHaveLength(0);
  });
});
