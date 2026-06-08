import { GraphValidator, ValidationResult } from '../../src/intelligence/graph-validator';
import { DependencyGraph } from '../../src/intelligence/dependency-analyzer';

describe('GraphValidator', () => {
  let validator: GraphValidator;

  beforeEach(() => {
    validator = new GraphValidator();
  });

  describe('validate', () => {
    it('should validate a valid DAG', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['B'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
          ['C', new Set(['B'])],
        ]),
      };

      const result = validator.validate(graph);

      expect(result.isValid).toBe(true);
      expect(result.isDAG).toBe(true);
      expect(result.cycles.length).toBe(0);
      expect(result.errors.length).toBe(0);
    });

    it('should detect circular dependencies', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['C'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set(['C'])],
          ['C', new Set(['A'])],
        ]),
      };

      const result = validator.validate(graph);

      expect(result.isValid).toBe(false);
      expect(result.isDAG).toBe(false);
      expect(result.cycles.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect missing dependencies', () => {
      const graph: DependencyGraph = {
        nodes: new Map([['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }]]),
        edges: new Map([['A', new Set(['B'])]]),
      };

      const result = validator.validate(graph);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('B is not in the graph');
    });

    it('should handle self-referencing nodes', () => {
      const graph: DependencyGraph = {
        nodes: new Map([['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['A'] }]]),
        edges: new Map([['A', new Set(['A'])]]),
      };

      const result = validator.validate(graph);

      expect(result.isDAG).toBe(false);
      expect(result.cycles.length).toBeGreaterThan(0);
    });
  });

  describe('detectCycles', () => {
    it('should return no cycles for acyclic graph', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
        ]),
      };

      const result = validator.detectCycles(graph);

      expect(result.hasCycles).toBe(false);
      expect(result.cycles.length).toBe(0);
    });

    it('should detect simple two-node cycle', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set(['A'])],
        ]),
      };

      const result = validator.detectCycles(graph);

      expect(result.hasCycles).toBe(true);
      expect(result.cycles.length).toBeGreaterThan(0);
      const cycle = result.cycles[0];
      expect(cycle).toContain('A');
      expect(cycle).toContain('B');
    });

    it('should detect complex multi-node cycle', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['C'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['D'] }],
          ['D', { missionId: 'D', filePath: 'D.yaml', dependencies: ['B'] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set(['C'])],
          ['C', new Set(['D'])],
          ['D', new Set(['B'])],
        ]),
      };

      const result = validator.detectCycles(graph);

      expect(result.hasCycles).toBe(true);
      expect(result.cycles.length).toBeGreaterThan(0);
    });

    it('should handle disconnected graph components', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: [] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['D'] }],
          ['D', { missionId: 'D', filePath: 'D.yaml', dependencies: [] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set()],
          ['C', new Set(['D'])],
          ['D', new Set()],
        ]),
      };

      const result = validator.detectCycles(graph);

      expect(result.hasCycles).toBe(false);
    });
  });

  describe('isDAG', () => {
    it('should return true for DAG', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
        ]),
      };

      expect(validator.isDAG(graph)).toBe(true);
    });

    it('should return false for cyclic graph', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set(['A'])],
        ]),
      };

      expect(validator.isDAG(graph)).toBe(false);
    });
  });

  describe('validateExecutionOrder', () => {
    it('should validate correct topological order', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['B'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
          ['C', new Set(['B'])],
        ]),
      };

      const executionOrder = ['A', 'B', 'C'];
      expect(validator.validateExecutionOrder(graph, executionOrder)).toBe(true);
    });

    it('should reject incorrect topological order', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['B'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
          ['C', new Set(['B'])],
        ]),
      };

      const executionOrder = ['C', 'B', 'A']; // Reversed - invalid
      expect(validator.validateExecutionOrder(graph, executionOrder)).toBe(false);
    });

    it('should reject order with missing nodes', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
        ]),
      };

      const executionOrder = ['A']; // Missing B
      expect(validator.validateExecutionOrder(graph, executionOrder)).toBe(false);
    });

    it('continues when dependency node not present in graph', () => {
      const graph: DependencyGraph = {
        nodes: new Map([['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }]]),
        edges: new Map([['A', new Set(['Ghost'])]]),
      };

      const executionOrder = ['A'];
      expect(validator.validateExecutionOrder(graph, executionOrder)).toBe(true);
    });

    it('handles nodes without explicit edge sets', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([['B', new Set(['A'])]]),
      };

      const executionOrder = ['A', 'B'];
      expect(validator.validateExecutionOrder(graph, executionOrder)).toBe(true);
    });

    it('fails when dependency missing from execution order', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
        ]),
      };

      const executionOrder = ['B']; // dependency A omitted
      expect(validator.validateExecutionOrder(graph, executionOrder)).toBe(false);
    });
  });

  describe('getStronglyConnectedComponents', () => {
    it('should find no SCCs in a DAG', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: [] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set()],
          ['B', new Set(['A'])],
        ]),
      };

      const sccs = validator.getStronglyConnectedComponents(graph);
      expect(sccs.length).toBe(0);
    });

    it('should find SCC in cyclic graph', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['C'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['A'] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set(['C'])],
          ['C', new Set(['A'])],
        ]),
      };

      const sccs = validator.getStronglyConnectedComponents(graph);
      expect(sccs.length).toBeGreaterThan(0);
      expect(sccs[0].length).toBe(3);
      expect(sccs[0]).toContain('A');
      expect(sccs[0]).toContain('B');
      expect(sccs[0]).toContain('C');
    });

    it('should handle self-loops as SCCs', () => {
      const graph: DependencyGraph = {
        nodes: new Map([['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['A'] }]]),
        edges: new Map([['A', new Set(['A'])]]),
      };

      const sccs = validator.getStronglyConnectedComponents(graph);
      expect(sccs.length).toBe(1);
      expect(sccs[0]).toContain('A');
    });

    it('should find multiple SCCs', () => {
      const graph: DependencyGraph = {
        nodes: new Map([
          ['A', { missionId: 'A', filePath: 'A.yaml', dependencies: ['B'] }],
          ['B', { missionId: 'B', filePath: 'B.yaml', dependencies: ['A'] }],
          ['C', { missionId: 'C', filePath: 'C.yaml', dependencies: ['D'] }],
          ['D', { missionId: 'D', filePath: 'D.yaml', dependencies: ['C'] }],
        ]),
        edges: new Map([
          ['A', new Set(['B'])],
          ['B', new Set(['A'])],
          ['C', new Set(['D'])],
          ['D', new Set(['C'])],
        ]),
      };

      const sccs = validator.getStronglyConnectedComponents(graph);
      expect(sccs.length).toBe(2);
    });
  });
});
