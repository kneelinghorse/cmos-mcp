import { DependencyGraph } from './dependency-analyzer';

/**
 * Cycle information
 */
export interface CycleInfo {
  nodes: string[];
  path: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  isDAG: boolean;
  cycles: CycleInfo[];
  errors: string[];
  warnings: string[];
}

/**
 * GraphValidator - Validates dependency graphs for DAG properties and cycles
 * Based on research findings from R4.3_Intelligent_Mission_Sequencing
 */
export class GraphValidator {
  /**
   * Validate a dependency graph
   * @param graph The dependency graph to validate
   * @returns ValidationResult
   */
  validate(graph: DependencyGraph): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const cycles: CycleInfo[] = [];

    // Check for missing dependencies
    this.checkMissingDependencies(graph, warnings);

    // Detect cycles using DFS with back-edge detection
    const cycleDetection = this.detectCycles(graph);

    if (cycleDetection.hasCycles) {
      for (const cycle of cycleDetection.cycles) {
        cycles.push({
          nodes: cycle,
          path: cycle.join(' -> '),
        });
        errors.push(`Circular dependency detected: ${cycle.join(' -> ')}`);
      }
    }

    const isDAG = !cycleDetection.hasCycles;
    const isValid = errors.length === 0;

    return {
      isValid,
      isDAG,
      cycles,
      errors,
      warnings,
    };
  }

  /**
   * Check for missing dependencies (dependencies referenced but not in graph)
   */
  private checkMissingDependencies(graph: DependencyGraph, warnings: string[]): void {
    for (const [nodeId, edges] of graph.edges.entries()) {
      for (const depId of edges) {
        if (!graph.nodes.has(depId)) {
          warnings.push(`Mission ${nodeId} depends on ${depId}, but ${depId} is not in the graph`);
        }
      }
    }
  }

  /**
   * Detect cycles using DFS with three-color algorithm
   * Based on R4.3: "Implement DFS-based cycle detection with back-edge identification"
   */
  detectCycles(graph: DependencyGraph): { hasCycles: boolean; cycles: string[][] } {
    const WHITE = 0; // Not visited
    const GREY = 1; // Currently visiting
    const BLACK = 2; // Completely visited

    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();
    const cycles: string[][] = [];

    // Initialize all nodes as white
    for (const nodeId of graph.nodes.keys()) {
      color.set(nodeId, WHITE);
      parent.set(nodeId, null);
    }

    // DFS helper function
    const dfs = (nodeId: string, recursionStack: Set<string>): void => {
      color.set(nodeId, GREY);
      recursionStack.add(nodeId);

      const edges = graph.edges.get(nodeId);
      if (edges) {
        for (const neighbor of edges) {
          // Skip if neighbor doesn't exist in graph
          if (!graph.nodes.has(neighbor)) {
            continue;
          }

          if (color.get(neighbor) === WHITE) {
            parent.set(neighbor, nodeId);
            dfs(neighbor, recursionStack);
          } else if (color.get(neighbor) === GREY) {
            // Back edge found - we have a cycle
            const cycle = this.extractCycle(nodeId, neighbor, parent);
            cycles.push(cycle);
          }
        }
      }

      color.set(nodeId, BLACK);
      recursionStack.delete(nodeId);
    };

    // Run DFS from each unvisited node
    for (const nodeId of graph.nodes.keys()) {
      if (color.get(nodeId) === WHITE) {
        dfs(nodeId, new Set());
      }
    }

    return {
      hasCycles: cycles.length > 0,
      cycles,
    };
  }

  /**
   * Extract the cycle path when a back edge is detected
   */
  private extractCycle(
    current: string,
    backEdge: string,
    parent: Map<string, string | null>
  ): string[] {
    const cycle: string[] = [backEdge, current];
    let node = parent.get(current);

    while (node && node !== backEdge) {
      cycle.unshift(node);
      node = parent.get(node);
    }

    cycle.unshift(backEdge); // Complete the cycle
    return cycle;
  }

  /**
   * Check if graph is a valid DAG (Directed Acyclic Graph)
   */
  isDAG(graph: DependencyGraph): boolean {
    return !this.detectCycles(graph).hasCycles;
  }

  /**
   * Validate execution order against graph
   * Ensures topological ordering is valid
   */
  validateExecutionOrder(graph: DependencyGraph, executionOrder: string[]): boolean {
    // Create a position map
    const position = new Map<string, number>();
    executionOrder.forEach((nodeId, index) => {
      position.set(nodeId, index);
    });

    // Check that all dependencies come before dependents
    // In our graph: edge from A to B means A depends on B, so B must execute before A
    for (const [nodeId, edges] of graph.edges.entries()) {
      const nodePos = position.get(nodeId);
      if (nodePos === undefined) {
        return false;
      }

      for (const depId of edges) {
        if (!graph.nodes.has(depId)) {
          continue; // Skip missing dependencies
        }

        const depPos = position.get(depId);
        if (depPos === undefined) {
          return false;
        }

        // Dependency (depId) must come before the node that depends on it (nodeId)
        if (depPos >= nodePos) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Get strongly connected components (useful for advanced cycle analysis)
   * Uses Tarjan's algorithm
   */
  getStronglyConnectedComponents(graph: DependencyGraph): string[][] {
    const index = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Map<string, boolean>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let currentIndex = 0;

    const strongConnect = (nodeId: string): void => {
      index.set(nodeId, currentIndex);
      lowLink.set(nodeId, currentIndex);
      currentIndex++;
      stack.push(nodeId);
      onStack.set(nodeId, true);

      const edges = graph.edges.get(nodeId);
      if (edges) {
        for (const neighbor of edges) {
          if (!graph.nodes.has(neighbor)) {
            continue;
          }

          if (!index.has(neighbor)) {
            strongConnect(neighbor);
            lowLink.set(nodeId, Math.min(lowLink.get(nodeId)!, lowLink.get(neighbor)!));
          } else if (onStack.get(neighbor)) {
            lowLink.set(nodeId, Math.min(lowLink.get(nodeId)!, index.get(neighbor)!));
          }
        }
      }

      // If nodeId is a root node, pop the stack and create an SCC
      if (lowLink.get(nodeId) === index.get(nodeId)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.set(w, false);
          scc.push(w);
        } while (w !== nodeId);

        if (scc.length > 1 || (scc.length === 1 && graph.edges.get(scc[0])?.has(scc[0]))) {
          sccs.push(scc);
        }
      }
    };

    for (const nodeId of graph.nodes.keys()) {
      if (!index.has(nodeId)) {
        strongConnect(nodeId);
      }
    }

    return sccs;
  }
}
