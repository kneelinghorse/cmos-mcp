import { DependencyGraph, MissionRecord } from './dependency-analyzer';

/**
 * Inferred dependency with confidence score
 */
export interface InferredDependency {
  from: string;
  to: string;
  confidence: number;
  reason: string;
  method: 'keyword' | 'semantic' | 'structural';
}

/**
 * DependencyInferrer - Infers implicit dependencies from text and structure
 * Based on research findings from R4.3_Intelligent_Mission_Sequencing
 * Uses NLP-based techniques: keyword matching, relationship extraction
 */
export class DependencyInferrer {
  // Dependency keywords that signal relationships
  private static readonly DEPENDENCY_KEYWORDS = [
    'requires',
    'depends on',
    'after completion of',
    'is followed by',
    'prerequisite',
    'based on',
    'builds on',
    'extends',
    'implements',
    'uses findings from',
    'leverages',
    'must complete before',
    'blocked by',
    'waiting for',
  ];

  // Temporal keywords that suggest sequence
  private static readonly TEMPORAL_KEYWORDS = [
    'before',
    'after',
    'then',
    'next',
    'following',
    'subsequent',
    'prior to',
    'once',
    'when complete',
  ];

  /**
   * Infer implicit dependencies from mission context and text
   * @param graph The existing dependency graph
   * @param missionData The mission data to analyze
   * @returns Array of inferred dependencies
   */
  inferDependencies(graph: DependencyGraph, missionData: MissionRecord): InferredDependency[] {
    const inferred: InferredDependency[] = [];

    // Extract mission ID
    const missionId = missionData.missionId;

    // Infer from context field using keyword matching
    if (missionData.context) {
      const keywordDeps = this.inferFromKeywords(missionId, missionData.context, graph);
      inferred.push(...keywordDeps);
    }

    // Infer from objective field
    if (missionData.objective) {
      const objectiveDeps = this.inferFromKeywords(missionId, missionData.objective, graph);
      inferred.push(...objectiveDeps);
    }

    // Infer from success criteria
    if (missionData.successCriteria) {
      const criteriaDeps = this.inferFromSuccessCriteria(
        missionId,
        missionData.successCriteria,
        graph
      );
      inferred.push(...criteriaDeps);
    }

    // Infer from deliverables
    if (missionData.deliverables) {
      const deliverableDeps = this.inferFromDeliverables(
        missionId,
        missionData.deliverables,
        graph
      );
      inferred.push(...deliverableDeps);
    }

    // Structural inference: missions with similar names might be related
    const structuralDeps = this.inferFromStructure(missionId, graph);
    inferred.push(...structuralDeps);

    return inferred;
  }

  /**
   * Infer dependencies using keyword matching and proximity analysis
   * Based on R4.3: "Keyword Matching and Heuristics"
   */
  private inferFromKeywords(
    missionId: string,
    text: string,
    graph: DependencyGraph
  ): InferredDependency[] {
    const inferred: InferredDependency[] = [];

    // Find all mission references in text
    const missionRefs = this.extractMissionReferences(text);

    // For each mission reference, look for nearby dependency keywords
    for (const ref of missionRefs) {
      if (ref === missionId || !graph.nodes.has(ref)) {
        continue;
      }

      // Check if there's a dependency keyword near this reference
      for (const keyword of DependencyInferrer.DEPENDENCY_KEYWORDS) {
        const regex = new RegExp(`${keyword}[^.]*?${ref}|${ref}[^.]*?${keyword}`, 'i');
        if (regex.test(text)) {
          // Determine direction based on keyword position
          inferred.push({
            from: missionId,
            to: ref,
            confidence: 0.7,
            reason: `Found dependency keyword "${keyword}" near mission reference "${ref}"`,
            method: 'keyword',
          });
          break;
        }
      }

      // Check for temporal keywords
      for (const keyword of DependencyInferrer.TEMPORAL_KEYWORDS) {
        const regex = new RegExp(`${keyword}[^.]*?${ref}|${ref}[^.]*?${keyword}`, 'i');
        if (regex.test(text)) {
          inferred.push({
            from: missionId,
            to: ref,
            confidence: 0.6,
            reason: `Found temporal keyword "${keyword}" near mission reference "${ref}"`,
            method: 'keyword',
          });
          break;
        }
      }
    }

    return inferred;
  }

  /**
   * Infer dependencies from success criteria
   */
  private inferFromSuccessCriteria(
    missionId: string,
    criteria: string[] | string,
    graph: DependencyGraph
  ): InferredDependency[] {
    const inferred: InferredDependency[] = [];
    const criteriaText = Array.isArray(criteria) ? criteria.join(' ') : criteria;

    // Look for mission references in criteria
    const missionRefs = this.extractMissionReferences(criteriaText);

    for (const ref of missionRefs) {
      if (ref === missionId || !graph.nodes.has(ref)) {
        continue;
      }

      inferred.push({
        from: missionId,
        to: ref,
        confidence: 0.8,
        reason: `Mission ${ref} mentioned in success criteria`,
        method: 'semantic',
      });
    }

    return inferred;
  }

  /**
   * Infer dependencies from deliverables
   */
  private inferFromDeliverables(
    missionId: string,
    deliverables: string[] | string,
    graph: DependencyGraph
  ): InferredDependency[] {
    const inferred: InferredDependency[] = [];
    const deliverablesText = Array.isArray(deliverables) ? deliverables.join(' ') : deliverables;

    // Extract file paths from deliverables
    const filePaths = this.extractFilePaths(deliverablesText);

    // Check if any other missions reference these files
    for (const [nodeId, _node] of graph.nodes.entries()) {
      if (nodeId === missionId) {
        continue;
      }

      // Check if this mission's deliverables are referenced by other missions
      for (const filePath of filePaths) {
        const nodeText = JSON.stringify(_node);
        if (nodeText.includes(filePath)) {
          inferred.push({
            from: nodeId,
            to: missionId,
            confidence: 0.7,
            reason: `Mission ${nodeId} references file ${filePath} which is a deliverable of ${missionId}`,
            method: 'structural',
          });
        }
      }
    }

    return inferred;
  }

  /**
   * Infer dependencies from structural patterns
   * Missions with sequential numbering or similar naming might be related
   */
  private inferFromStructure(missionId: string, graph: DependencyGraph): InferredDependency[] {
    const inferred: InferredDependency[] = [];

    // Extract mission number (e.g., "B3.2" -> {prefix: "B", major: 3, minor: 2})
    const parsed = this.parseMissionId(missionId);
    if (!parsed) {
      return inferred;
    }

    // Look for missions with same prefix and lower minor version
    for (const [nodeId, _node] of graph.nodes.entries()) {
      if (nodeId === missionId) {
        continue;
      }

      const otherParsed = this.parseMissionId(nodeId);
      if (!otherParsed) {
        continue;
      }

      // Same sprint (major version), previous mission (minor - 1)
      if (
        otherParsed.prefix === parsed.prefix &&
        otherParsed.major === parsed.major &&
        otherParsed.minor === parsed.minor - 1
      ) {
        inferred.push({
          from: missionId,
          to: nodeId,
          confidence: 0.5,
          reason: `Sequential mission numbering suggests ${missionId} follows ${nodeId}`,
          method: 'structural',
        });
      }

      // Research missions that build missions depend on
      if (
        parsed.prefix === 'B' &&
        otherParsed.prefix === 'R' &&
        parsed.major === otherParsed.major
      ) {
        inferred.push({
          from: missionId,
          to: nodeId,
          confidence: 0.6,
          reason: `Build mission ${missionId} likely depends on research mission ${nodeId}`,
          method: 'structural',
        });
      }
    }

    return inferred;
  }

  /**
   * Extract mission references from text
   * Pattern matches: R4.3, B3.2, etc.
   */
  private extractMissionReferences(text: string): string[] {
    const references: Set<string> = new Set();
    const missionPattern = /[A-Z]\d+\.\d+/g;
    const matches = text.match(missionPattern);

    if (matches) {
      matches.forEach((match) => references.add(match));
    }

    return Array.from(references);
  }

  /**
   * Extract file paths from text
   */
  private extractFilePaths(text: string): string[] {
    const paths: Set<string> = new Set();

    // Match patterns like: app/src/file.ts, tests/test.ts
    const pathPattern = /(?:app|tests)\/[a-zA-Z0-9/_-]+\.[a-z]+/g;
    const matches = text.match(pathPattern);

    if (matches) {
      matches.forEach((match) => paths.add(match));
    }

    return Array.from(paths);
  }

  /**
   * Parse mission ID into components
   */
  private parseMissionId(
    missionId: string
  ): { prefix: string; major: number; minor: number } | null {
    const match = missionId.match(/^([A-Z])(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }

    return {
      prefix: match[1],
      major: parseInt(match[2], 10),
      minor: parseInt(match[3], 10),
    };
  }

  /**
   * Filter inferred dependencies by confidence threshold
   */
  filterByConfidence(
    dependencies: InferredDependency[],
    minConfidence: number
  ): InferredDependency[] {
    return dependencies.filter((dep) => dep.confidence >= minConfidence);
  }

  /**
   * Merge inferred dependencies with existing graph
   * Only adds high-confidence inferred dependencies that don't create cycles
   */
  mergeWithGraph(
    graph: DependencyGraph,
    inferred: InferredDependency[],
    minConfidence: number = 0.7
  ): void {
    const filtered = this.filterByConfidence(inferred, minConfidence);

    for (const dep of filtered) {
      const node = graph.nodes.get(dep.from);
      if (node && !node.implicitDependencies) {
        node.implicitDependencies = [];
      }

      if (node && !node.implicitDependencies!.includes(dep.to)) {
        node.implicitDependencies!.push(dep.to);
      }
    }
  }
}
