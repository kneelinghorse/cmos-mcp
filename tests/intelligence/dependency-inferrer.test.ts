import { DependencyInferrer, InferredDependency } from '../../src/intelligence/dependency-inferrer';
import { DependencyGraph } from '../../src/intelligence/dependency-analyzer';

describe('DependencyInferrer', () => {
  let inferrer: DependencyInferrer;
  let graph: DependencyGraph;

  beforeEach(() => {
    inferrer = new DependencyInferrer();
    graph = {
      nodes: new Map([
        ['R4.3', { missionId: 'R4.3', filePath: 'missions/R4.3.yaml', dependencies: [] } as any],
        [
          'B4.3',
          { missionId: 'B4.3', filePath: 'missions/B4.3.yaml', dependencies: ['R4.3'] } as any,
        ],
        [
          'B4.4',
          { missionId: 'B4.4', filePath: 'missions/B4.4.yaml', dependencies: ['B4.3'] } as any,
        ],
      ]),
      edges: new Map([
        ['R4.3', new Set()],
        ['B4.3', new Set(['R4.3'])],
        ['B4.4', new Set(['B4.3'])],
      ]),
    };
  });

  it('infers dependencies via keyword proximity and temporal cues', () => {
    const mission = {
      missionId: 'B4.4',
      context: 'This mission depends on B4.3 and is executed after R4.3 findings.',
      objective: 'Implements improvements after completion of B4.3',
    };

    const inferred = inferrer.inferDependencies(graph, mission);
    const toIds = inferred.map((i) => i.to);

    expect(inferred.length).toBeGreaterThan(0);
    expect(toIds).toContain('B4.3');
    expect(toIds).toContain('R4.3');

    // Ensure methods include keyword-based detections
    expect(inferred.some((i) => i.method === 'keyword')).toBe(true);
  });

  it('infers dependencies from success criteria mentions', () => {
    const mission = {
      missionId: 'B4.4',
      successCriteria: [
        'Must align with research from R4.3',
        'Verify outputs from B4.3 are integrated',
      ],
    };

    const inferred = inferrer.inferDependencies(graph, mission);
    expect(inferred.some((i) => i.to === 'R4.3' && i.method === 'semantic')).toBe(true);
  });

  it('infers structural dependencies from sequential numbering and research linkage', () => {
    // For B4.4, structural inference should suggest dependency on B4.3
    const mission = { missionId: 'B4.4' };
    const inferred = inferrer.inferDependencies(graph, mission);

    expect(inferred.some((i) => i.to === 'B4.3' && i.method === 'structural')).toBe(true);

    // For B4.3, structural inference should suggest dependency on R4.3 (build depends on research)
    const inferredB43 = inferrer.inferDependencies(graph, { missionId: 'B4.3' });
    expect(inferredB43.some((i) => i.to === 'R4.3' && i.method === 'structural')).toBe(true);
  });

  it('extracts mission references and file paths from text', () => {
    const refs = (inferrer as any).extractMissionReferences('This builds on R4.3 then B4.3.');
    expect(refs).toEqual(expect.arrayContaining(['R4.3', 'B4.3']));

    const files = (inferrer as any).extractFilePaths(
      'Uses app/src/tools/optimize-tokens.ts and tests/tools/x.test.ts'
    );
    expect(files).toContain('app/src/tools/optimize-tokens.ts');
    expect(files.some((p: string) => p.startsWith('tests/tools/x.test'))).toBe(true);
  });

  it('parses mission IDs and filters by confidence', () => {
    const parsed = (inferrer as any).parseMissionId('B4.4');
    expect(parsed).toMatchObject({ prefix: 'B', major: 4, minor: 4 });

    // Invalid should return null
    expect((inferrer as any).parseMissionId('invalid')).toBeNull();

    const deps: InferredDependency[] = [
      { from: 'B4.4', to: 'B4.3', confidence: 0.5, reason: 'struct', method: 'structural' },
      { from: 'B4.4', to: 'R4.3', confidence: 0.8, reason: 'keyword', method: 'keyword' },
    ];

    const filtered = inferrer.filterByConfidence(deps, 0.7);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].to).toBe('R4.3');
  });

  it('merges high-confidence inferred dependencies into graph', () => {
    const deps: InferredDependency[] = [
      { from: 'B4.4', to: 'B4.3', confidence: 0.9, reason: 'keyword', method: 'keyword' },
      { from: 'B4.4', to: 'R4.3', confidence: 0.6, reason: 'struct', method: 'structural' },
    ];

    inferrer.mergeWithGraph(graph, deps, 0.7);
    const nodeB44 = graph.nodes.get('B4.4') as any;
    expect(nodeB44.implicitDependencies).toBeDefined();
    expect(nodeB44.implicitDependencies).toContain('B4.3');
    expect(nodeB44.implicitDependencies).not.toContain('R4.3');
  });

  it('optionally infers from deliverables when other nodes reference those files', () => {
    // Add a node with extra field containing a deliverable path to trigger structural inference
    graph.nodes.set('X4.1', {
      missionId: 'X4.1',
      filePath: 'missions/X4.1.yaml',
      dependencies: [],
      // extra content to be scanned by JSON.stringify in inferFromDeliverables
      extra: 'References app/src/intelligence/dependency-analyzer.ts in docs',
    } as any);
    graph.edges.set('X4.1', new Set());

    const mission = {
      missionId: 'B4.3',
      deliverables: [
        'app/src/intelligence/dependency-analyzer.ts',
        'app/src/intelligence/graph-validator.ts',
      ],
    };

    const inferred = inferrer.inferDependencies(graph, mission);
    // Expect a structural inference from X4.1 -> B4.3 based on deliverable reference in node X4.1
    expect(
      inferred.some((i) => i.from === 'X4.1' && i.to === 'B4.3' && i.method === 'structural')
    ).toBe(true);
  });

  describe('edge cases', () => {
    it('ignores self-references and accepts success criteria strings', () => {
      const mission = {
        missionId: 'B4.3',
        successCriteria: 'Ensure B4.3 delivers before B4.4',
      };

      const inferred = inferrer.inferDependencies(graph, mission);
      expect(inferred.every((dep) => dep.to !== 'B4.3')).toBe(true);
    });

    it('handles deliverable strings without matches gracefully', () => {
      const mission = {
        missionId: 'B4.4',
        deliverables: 'No matching file paths here',
      };

      const inferred = inferrer.inferDependencies(graph, mission);
      expect(inferred.length).toBeGreaterThan(0); // structural inference still runs
    });

    it('skips structural inference when mission id is not parseable', () => {
      const mission = { missionId: 'invalid-id' };
      const inferred = inferrer.inferDependencies(graph, mission);
      expect(inferred).toHaveLength(0);
    });

    it('mergeWithGraph uses default confidence threshold and deduplicates deps', () => {
      const deps: InferredDependency[] = [
        { from: 'B4.3', to: 'R4.3', confidence: 0.8, reason: 'keyword', method: 'keyword' },
        { from: 'B4.3', to: 'R4.3', confidence: 0.9, reason: 'structural', method: 'structural' },
      ];

      inferrer.mergeWithGraph(graph, deps);
      const node = graph.nodes.get('B4.3') as any;
      expect(node.implicitDependencies).toEqual(['R4.3']);
    });
  });
});
