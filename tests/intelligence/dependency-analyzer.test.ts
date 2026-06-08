import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  DependencyAnalyzer,
  DependencyGraph,
  DependencyNode,
} from '../../src/intelligence/dependency-analyzer';
import { ensureTempDir, removeDir } from '../../src/utils/fs';

describe('DependencyAnalyzer', () => {
  let analyzer: DependencyAnalyzer;

  beforeEach(() => {
    analyzer = new DependencyAnalyzer();
  });

  describe('analyze', () => {
    it('should build a dependency graph from mission objects', async () => {
      const missions = [
        {
          missionId: 'R4.3',
          context: 'Research mission',
          filePath: 'missions/R4.3.yaml',
        },
        {
          missionId: 'B4.3',
          context: 'Build mission based on R4.3',
          domainFields: {
            researchFoundation: [{ finding: 'Use DAGs', sourceMission: 'R4.3' }],
          },
          filePath: 'missions/B4.3.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.graph.nodes.size).toBe(2);
      expect(result.graph.nodes.has('R4.3')).toBe(true);
      expect(result.graph.nodes.has('B4.3')).toBe(true);
      expect(result.graph.edges.get('B4.3')?.has('R4.3')).toBe(true);
    });

    it('should detect no cycles in a valid DAG', async () => {
      const missions = [
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          context: 'Depends on A',
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          context: 'Depends on B',
          filePath: 'missions/C.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.hasCycles).toBe(false);
      expect(result.executionOrder).toBeDefined();
      expect(result.executionOrder?.length).toBe(3);
    });

    it('should detect cycles in a circular dependency', async () => {
      const missions = [
        {
          missionId: 'A',
          domainFields: {
            handoffContext: {
              dependencies: ['C'],
            },
          },
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          domainFields: {
            handoffContext: {
              dependencies: ['B'],
            },
          },
          filePath: 'missions/C.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.hasCycles).toBe(true);
      expect(result.cycles).toBeDefined();
      expect(result.cycles!.length).toBeGreaterThan(0);
    });

    it('should compute execution order using topological sort', async () => {
      const missions = [
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          domainFields: {
            handoffContext: {
              dependencies: ['B'],
            },
          },
          filePath: 'missions/C.yaml',
        },
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.executionOrder).toBeDefined();
      const order = result.executionOrder!;

      // A should come before B
      expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
      // B should come before C
      expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
    });

    it('should find critical path', async () => {
      const missions = [
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          domainFields: {
            handoffContext: {
              dependencies: ['B'],
            },
          },
          filePath: 'missions/C.yaml',
        },
        {
          missionId: 'D',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/D.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.criticalPath).toBeDefined();
      expect(result.criticalPath!.length).toBeGreaterThan(0);
      // Critical path should be A -> B -> C (longest path)
      expect(result.criticalPath).toContain('A');
      expect(result.criticalPath).toContain('C');
    });
  });

  describe('extractExplicitDependencies', () => {
    it('should extract dependencies from researchFoundation', async () => {
      const missions = [
        {
          missionId: 'R4.3',
          filePath: 'missions/R4.3.yaml',
        },
        {
          missionId: 'B4.3',
          domainFields: {
            researchFoundation: [
              { finding: 'Finding 1', sourceMission: '<R4.3_Intelligent_Mission_Sequencing>' },
            ],
          },
          filePath: 'missions/B4.3.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);
      const b43Node = result.graph.nodes.get('B4.3');

      expect(b43Node).toBeDefined();
      expect(b43Node!.dependencies).toContain('R4.3');
    });

    it('should extract dependencies from handoffContext', async () => {
      const missions = [
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/B.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);
      const bNode = result.graph.nodes.get('B');

      expect(bNode).toBeDefined();
      expect(bNode!.dependencies).toContain('A');
    });

    it('should extract mission references from context text', async () => {
      const missions = [
        {
          missionId: 'R4.3',
          filePath: 'missions/R4.3.yaml',
        },
        {
          missionId: 'B4.3',
          context: 'This mission implements findings from R4.3 research',
          filePath: 'missions/B4.3.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);
      const b43Node = result.graph.nodes.get('B4.3');

      expect(b43Node).toBeDefined();
      expect(b43Node!.dependencies).toContain('R4.3');
    });
  });

  describe('detectCycles', () => {
    it('should detect a simple cycle', async () => {
      const missions = [
        {
          missionId: 'A',
          domainFields: {
            handoffContext: {
              dependencies: ['B'],
            },
          },
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/B.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.hasCycles).toBe(true);
      expect(result.cycles).toBeDefined();
      expect(result.cycles!.length).toBe(1);
    });

    it('should detect a complex cycle', async () => {
      const missions = [
        {
          missionId: 'A',
          domainFields: {
            handoffContext: {
              dependencies: ['B'],
            },
          },
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['C'],
            },
          },
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          domainFields: {
            handoffContext: {
              dependencies: ['D'],
            },
          },
          filePath: 'missions/C.yaml',
        },
        {
          missionId: 'D',
          domainFields: {
            handoffContext: {
              dependencies: ['B'],
            },
          },
          filePath: 'missions/D.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.hasCycles).toBe(true);
      expect(result.cycles).toBeDefined();
      const cycle = result.cycles![0];
      expect(cycle).toContain('B');
      expect(cycle).toContain('C');
      expect(cycle).toContain('D');
    });

    it('should handle self-referencing cycle', async () => {
      const missions = [
        {
          missionId: 'A',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/A.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.hasCycles).toBe(true);
    });
  });

  describe('topologicalSort', () => {
    it('should produce valid topological ordering', async () => {
      const missions = [
        {
          missionId: 'D',
          domainFields: {
            handoffContext: {
              dependencies: ['B', 'C'],
            },
          },
          filePath: 'missions/D.yaml',
        },
        {
          missionId: 'B',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          domainFields: {
            handoffContext: {
              dependencies: ['A'],
            },
          },
          filePath: 'missions/C.yaml',
        },
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.executionOrder).toBeDefined();
      const order = result.executionOrder!;

      // A must be first
      expect(order[0]).toBe('A');
      // D must be last
      expect(order[order.length - 1]).toBe('D');
      // B and C must come after A but before D
      expect(order.indexOf('B')).toBeGreaterThan(order.indexOf('A'));
      expect(order.indexOf('C')).toBeGreaterThan(order.indexOf('A'));
      expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
      expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
    });

    it('should handle missions with no dependencies', async () => {
      const missions = [
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
        {
          missionId: 'B',
          filePath: 'missions/B.yaml',
        },
        {
          missionId: 'C',
          filePath: 'missions/C.yaml',
        },
      ];

      const result = await analyzer.analyze(missions);

      expect(result.executionOrder).toBeDefined();
      expect(result.executionOrder!.length).toBe(3);
    });
  });

  describe('getGraph', () => {
    it('should return the current dependency graph', async () => {
      const missions = [
        {
          missionId: 'A',
          filePath: 'missions/A.yaml',
        },
      ];

      await analyzer.analyze(missions);
      const graph = analyzer.getGraph();

      expect(graph).toBeDefined();
      expect(graph.nodes).toBeDefined();
      expect(graph.edges).toBeDefined();
      expect(graph.nodes.size).toBe(1);
    });
  });

  describe('edge cases and fallbacks', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await ensureTempDir('dependency-analyzer-');
    });

    afterEach(async () => {
      await removeDir(tempDir, { recursive: true, force: true });
    });

    it('analyzes mission file paths and records blockers without crashing', async () => {
      const filePath = path.join(tempDir, 'M9.yaml');
      const mission = {
        missionId: 'M9',
        context: 'References missing mission M8',
        domainFields: {
          handoffContext: {
            dependencies: ['M8'],
            blockers: [{ missionId: 'M7' }],
          },
        },
      };
      await fs.writeFile(filePath, yaml.dump(mission), 'utf-8');

      const result = await analyzer.analyze([filePath]);

      const node = result.graph.nodes.get('M9');
      expect(node?.filePath).toBe(filePath);
      // Missing dependencies should be ignored gracefully
      expect(result.hasCycles).toBe(false);
    });

    it('defaults mission file path to unknown when field omitted', async () => {
      const missions = [
        {
          missionId: 'B',
          domainFields: { handoffContext: { dependencies: [] } },
        },
      ];

      const result = await analyzer.analyze(missions);
      expect(result.graph.nodes.get('B')?.filePath).toBe('unknown');
    });

    it('extractMissionId covers simple identifiers and rejects blank strings', () => {
      const extractMissionId = (analyzer as any).extractMissionId.bind(analyzer);
      expect(extractMissionId('<A>')).toBe('A');
      expect(extractMissionId('')).toBeNull();
    });

    it('detects absence of mission references gracefully', () => {
      const refs = (analyzer as any).extractMissionReferencesFromText('No IDs present here.');
      expect(refs).toHaveLength(0);
    });

    it('handles analyze calls with no missions', async () => {
      const result = await analyzer.analyze([]);
      expect(result.criticalPath).toEqual([]);
      expect(result.executionOrder).toEqual([]);
    });
  });
});
