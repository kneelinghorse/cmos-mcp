/**
 * Mission Splitter
 *
 * Implements the hybrid semantic-structural decomposition algorithm from R4.2.
 * Decomposes oversized missions while preserving atomic operations and context.
 */

import { GenericMission } from '../types/mission-types';
import { ComplexityScorer, ComplexityAnalysis } from './complexity-scorer';
import { AbortableOptions } from './types';
import { throwIfAborted } from '../utils/abort';

/**
 * Proposed breakpoint from semantic analysis
 */
interface ProposedBreakpoint {
  position: number; // Character position in text
  semanticDistance: number; // Distance score
  beforeText: string;
  afterText: string;
}

/**
 * Atomic operation - sequence that must not be split
 */
interface AtomicOperation {
  startPosition: number;
  endPosition: number;
  type: 'dependency_chain' | 'numbered_list' | 'code_block' | 'nested_instruction';
  content: string;
}

interface SentenceSegment {
  text: string;
  start: number;
  end: number;
}

/**
 * Validated split point
 */
interface SplitPoint {
  position: number;
  reason: string;
  confidence: number;
}

/**
 * Sub-mission generated from split
 */
export interface SubMission {
  id: string;
  objective: string;
  context: string;
  instructions: string;
  dependencies: string[];
  deliverables: string[];
  order: number;
}

/**
 * Mission split result
 */
export interface SplitResult {
  original: string | GenericMission;
  subMissions: SubMission[];
  splitPoints: SplitPoint[];
  preservedContext: string;
  complexity: ComplexityAnalysis;
}

/**
 * Split options
 */
export interface SplitOptions {
  maxSubMissions?: number;
  minChunkSize?: number; // Minimum characters per sub-mission
  preserveStructure?: boolean;
  targetComplexity?: number; // Target CCS for each sub-mission
}

/**
 * Dependency keywords that signal atomic operations
 */
const DEPENDENCY_KEYWORDS = [
  'then',
  'next',
  'after',
  'once',
  'before',
  'first',
  'second',
  'third',
  'finally',
  'subsequently',
  'following that',
  'after that',
  'once complete',
];

/**
 * MissionSplitter class
 *
 * Autonomously decomposes missions using hybrid semantic-structural analysis
 */
export class MissionSplitter {
  private complexityScorer: ComplexityScorer;

  constructor(complexityScorer: ComplexityScorer) {
    this.complexityScorer = complexityScorer;
  }

  /**
   * Split a mission into coherent sub-missions
   */
  async split(
    mission: GenericMission | string,
    options: SplitOptions = {},
    execution: AbortableOptions = {}
  ): Promise<SplitResult> {
    const { signal } = execution;
    throwIfAborted(signal, 'Mission split aborted');

    // Analyze complexity
    const complexity = await this.complexityScorer.calculateCCS(mission, execution);
    throwIfAborted(signal, 'Mission split aborted');

    const missionText = typeof mission === 'string' ? mission : this.serializeMission(mission);
    const missionObj = typeof mission === 'string' ? null : mission;

    // Phase 1: Semantic Proposal - find topic shifts
    const proposedBreakpoints = this.proposeSemanticBreakpoints(missionText, options);
    throwIfAborted(signal, 'Mission split aborted');

    // Phase 2: Structural Validation - identify atomic operations
    const atomicOperations = this.identifyAtomicOperations(missionText);
    throwIfAborted(signal, 'Mission split aborted');

    // Phase 3: Reconciliation - validate breakpoints don't break atomic ops
    const validatedSplitPoints = this.reconcileBreakpoints(
      proposedBreakpoints,
      atomicOperations,
      options
    );
    throwIfAborted(signal, 'Mission split aborted');

    // Generate sub-missions from validated split points
    const subMissions = this.generateSubMissions(
      missionText,
      missionObj,
      validatedSplitPoints,
      options
    );
    throwIfAborted(signal, 'Mission split aborted');

    // Extract preserved context
    const preservedContext = this.extractPreservedContext(missionText, missionObj);
    throwIfAborted(signal, 'Mission split aborted');

    return {
      original: mission,
      subMissions,
      splitPoints: validatedSplitPoints,
      preservedContext,
      complexity,
    };
  }

  /**
   * Suggest split points without actually splitting
   */
  async suggestSplits(
    mission: GenericMission | string,
    execution: AbortableOptions = {}
  ): Promise<{
    shouldSplit: boolean;
    complexity: ComplexityAnalysis;
    suggestedSplits: SplitPoint[];
    reasoning: string;
  }> {
    const { signal } = execution;
    throwIfAborted(signal, 'Split suggestion aborted');

    const complexity = await this.complexityScorer.calculateCCS(mission, execution);
    throwIfAborted(signal, 'Split suggestion aborted');
    const missionText = typeof mission === 'string' ? mission : this.serializeMission(mission);

    if (!complexity.shouldSplit) {
      throwIfAborted(signal, 'Split suggestion aborted');
      return {
        shouldSplit: false,
        complexity,
        suggestedSplits: [],
        reasoning: 'Mission complexity is within acceptable limits. No split needed.',
      };
    }

    // Generate split suggestions
    const proposed = this.proposeSemanticBreakpoints(missionText, {});
    const atomic = this.identifyAtomicOperations(missionText);
    const validated = this.reconcileBreakpoints(proposed, atomic, {});
    throwIfAborted(signal, 'Split suggestion aborted');

    const reasoning = this.generateSplitReasoning(complexity, validated);

    return {
      shouldSplit: true,
      complexity,
      suggestedSplits: validated,
      reasoning,
    };
  }

  /**
   * Phase 1: Propose semantic breakpoints based on topic shifts
   */
  private proposeSemanticBreakpoints(
    missionText: string,
    _options: SplitOptions
  ): ProposedBreakpoint[] {
    const sentences = this.splitIntoSentenceSegments(missionText);
    const breakpoints: ProposedBreakpoint[] = [];

    // Simple semantic analysis: look for transitions and topic shifts
    for (let i = 1; i < sentences.length; i++) {
      const prevSentence = sentences[i - 1];
      const currSentence = sentences[i];

      // Calculate semantic distance (simplified - in production use embeddings)
      const distance = this.calculateSemanticDistance(prevSentence.text, currSentence.text);

      // Propose breakpoint if distance exceeds threshold (80th percentile heuristic)
      if (distance > 0.6) {
        breakpoints.push({
          position: currSentence.start,
          semanticDistance: distance,
          beforeText: prevSentence.text,
          afterText: currSentence.text,
        });
      }
    }

    // Also propose breaks at structural boundaries
    const structuralBreaks = this.findStructuralBoundaries(missionText);
    for (const breakPos of structuralBreaks) {
      const beforeText = missionText.substring(Math.max(0, breakPos - 100), breakPos);
      const afterText = missionText.substring(
        breakPos,
        Math.min(missionText.length, breakPos + 100)
      );

      breakpoints.push({
        position: breakPos,
        semanticDistance: 0.8, // High confidence for structural breaks
        beforeText,
        afterText,
      });
    }

    return breakpoints.sort((a, b) => a.position - b.position);
  }

  /**
   * Phase 2: Identify atomic operations that must not be split
   */
  private identifyAtomicOperations(missionText: string): AtomicOperation[] {
    const operations: AtomicOperation[] = [];

    // Identify numbered/bulleted lists
    const listBlocks = this.findListBlocks(missionText);
    operations.push(
      ...listBlocks.map((block) => ({
        startPosition: block.start,
        endPosition: block.end,
        type: 'numbered_list' as const,
        content: missionText.substring(block.start, block.end),
      }))
    );

    // Identify dependency chains
    const dependencyChains = this.findDependencyChains(missionText);
    operations.push(
      ...dependencyChains.map((chain) => ({
        startPosition: chain.start,
        endPosition: chain.end,
        type: 'dependency_chain' as const,
        content: missionText.substring(chain.start, chain.end),
      }))
    );

    // Identify code blocks
    const codeBlocks = this.findCodeBlocks(missionText);
    operations.push(
      ...codeBlocks.map((block) => ({
        startPosition: block.start,
        endPosition: block.end,
        type: 'code_block' as const,
        content: missionText.substring(block.start, block.end),
      }))
    );

    return operations.sort((a, b) => a.startPosition - b.startPosition);
  }

  /**
   * Phase 3: Reconcile semantic breakpoints with atomic operations
   */
  private reconcileBreakpoints(
    proposed: ProposedBreakpoint[],
    atomic: AtomicOperation[],
    options: SplitOptions
  ): SplitPoint[] {
    const validated: SplitPoint[] = [];
    const minChunkSize = options.minChunkSize || 500;

    let lastSplitPosition = 0;

    for (const breakpoint of proposed) {
      // Check if this breakpoint falls within an atomic operation
      const inAtomicOp = atomic.some(
        (op) => breakpoint.position > op.startPosition && breakpoint.position < op.endPosition
      );

      // Check minimum chunk size
      const tooClose = breakpoint.position - lastSplitPosition < minChunkSize;

      if (!inAtomicOp && !tooClose) {
        validated.push({
          position: breakpoint.position,
          reason: this.inferSplitReason(breakpoint),
          confidence: breakpoint.semanticDistance,
        });
        lastSplitPosition = breakpoint.position;
      }
    }

    // Limit number of splits
    const maxSplits = options.maxSubMissions ? options.maxSubMissions - 1 : 10;
    return validated.slice(0, maxSplits);
  }

  /**
   * Generate sub-missions from validated split points
   */
  private generateSubMissions(
    missionText: string,
    missionObj: GenericMission | null,
    splitPoints: SplitPoint[],
    _options: SplitOptions
  ): SubMission[] {
    const subMissions: SubMission[] = [];

    // Add start and end positions for easier chunking
    const positions = [0, ...splitPoints.map((sp) => sp.position), missionText.length];

    for (let i = 0; i < positions.length - 1; i++) {
      const start = positions[i];
      const end = positions[i + 1];
      const chunk = missionText.substring(start, end).trim();

      const subMission = this.createSubMission(chunk, i + 1, positions.length - 1, missionObj);

      subMissions.push(subMission);
    }

    // Infer dependencies between sub-missions
    this.inferDependencies(subMissions);

    return subMissions;
  }

  /**
   * Create a sub-mission from a text chunk
   */
  private createSubMission(
    chunk: string,
    order: number,
    total: number,
    originalMission: GenericMission | null
  ): SubMission {
    const objective = this.extractObjectiveFromChunk(chunk);
    const instructions = this.extractInstructions(chunk);
    const deliverables = this.extractDeliverablesFromChunk(chunk);

    return {
      id: `sub-mission-${order}`,
      objective: objective || `Complete phase ${order} of ${total}`,
      context:
        originalMission?.context?.background || `Part ${order} of ${total} of the overall mission`,
      instructions: instructions || chunk,
      dependencies: [], // Will be filled by inferDependencies
      deliverables,
      order,
    };
  }

  /**
   * Infer dependencies between sub-missions
   */
  private inferDependencies(subMissions: SubMission[]): void {
    for (let i = 1; i < subMissions.length; i++) {
      // By default, each mission depends on the previous one
      subMissions[i].dependencies.push(subMissions[i - 1].id);

      // Check for explicit references to earlier missions
      const text = subMissions[i].instructions.toLowerCase();
      for (let j = 0; j < i; j++) {
        const prevId = subMissions[j].id;
        const prevObjective = subMissions[j].objective.toLowerCase();

        // If current mission mentions previous mission's objective
        if (
          text.includes(prevObjective.substring(0, 30)) &&
          !subMissions[i].dependencies.includes(prevId)
        ) {
          subMissions[i].dependencies.push(prevId);
        }
      }
    }
  }

  /**
   * Calculate semantic distance between sentences (simplified)
   */
  private calculateSemanticDistance(sentence1: string, sentence2: string): number {
    // Simplified implementation - in production use sentence embeddings
    const words1 = new Set(sentence1.toLowerCase().split(/\s+/));
    const words2 = new Set(sentence2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter((w) => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    // Jaccard distance
    return 1 - intersection.size / union.size;
  }

  /**
   * Find structural boundaries (paragraphs, sections)
   */
  private findStructuralBoundaries(text: string): number[] {
    const boundaries: number[] = [];

    // Double newlines indicate paragraph breaks
    const paragraphBreaks = [...text.matchAll(/\n\n+/g)];
    boundaries.push(...paragraphBreaks.map((m) => m.index || 0));

    // Section headers (lines starting with #)
    const sectionHeaders = [...text.matchAll(/\n#+\s+/g)];
    boundaries.push(...sectionHeaders.map((m) => m.index || 0));

    // Horizontal rules
    const rules = [...text.matchAll(/\n---+\n/g)];
    boundaries.push(...rules.map((m) => m.index || 0));

    return [...new Set(boundaries)].sort((a, b) => a - b);
  }

  /**
   * Find list blocks that should stay together
   */
  private findListBlocks(text: string): Array<{ start: number; end: number }> {
    const blocks: Array<{ start: number; end: number }> = [];
    const lines = text.split('\n');

    let inList = false;
    let listStart = 0;
    let cursor = 0;

    for (const line of lines) {
      const lineLength = line.length;
      const lineEnd = cursor + lineLength;
      const isListItem = /^\s*[\d]+[.)]\s+/.test(line) || /^\s*[-*+]\s+/.test(line);

      if (isListItem && !inList) {
        inList = true;
        listStart = cursor;
      } else if (!isListItem && inList) {
        inList = false;
        blocks.push({ start: listStart, end: cursor });
      }

      cursor = lineEnd;

      if (cursor < text.length && text[cursor] === '\n') {
        cursor += 1;
      }
    }

    // Close an open list that extends to EOF
    if (inList) {
      blocks.push({ start: listStart, end: cursor });
    }

    return blocks;
  }

  /**
   * Find dependency chains signaled by keywords
   */
  private findDependencyChains(text: string): Array<{ start: number; end: number }> {
    const chains: Array<{ start: number; end: number }> = [];
    const sentences = this.splitIntoSentenceSegments(text);

    for (let i = 0; i < sentences.length - 1; i++) {
      const sentence = sentences[i];
      const nextSentence = sentences[i + 1];

      // Check if next sentence starts with dependency keyword
      const hasDependency = DEPENDENCY_KEYWORDS.some((keyword) =>
        nextSentence.text.toLowerCase().trim().startsWith(keyword)
      );

      if (hasDependency) {
        chains.push({
          start: sentence.start,
          end: nextSentence.end,
        });
      }
    }

    return chains;
  }

  /**
   * Find code blocks (markdown style)
   */
  private findCodeBlocks(text: string): Array<{ start: number; end: number }> {
    const blocks: Array<{ start: number; end: number }> = [];
    const codeBlockPattern = /```[\s\S]*?```/g;

    let match;
    while ((match = codeBlockPattern.exec(text)) !== null) {
      blocks.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    return blocks;
  }

  /**
   * Split text into sentence segments with positional metadata
   */
  private splitIntoSentenceSegments(text: string): SentenceSegment[] {
    const segments: SentenceSegment[] = [];
    const sentencePattern = /[^.!?]+[.!?]+|[^.!?]+$/g;
    let match: RegExpExecArray | null;

    while ((match = sentencePattern.exec(text)) !== null) {
      const rawSegment = match[0];
      const trimmedStartOffset = rawSegment.search(/\S/);

      if (trimmedStartOffset === -1) {
        continue;
      }

      const trimmedEndOffset = rawSegment.length - rawSegment.trimEnd().length;
      const start = match.index + trimmedStartOffset;
      const end = match.index + rawSegment.length - trimmedEndOffset;
      const sentenceText = rawSegment
        .slice(trimmedStartOffset, rawSegment.length - trimmedEndOffset)
        .trim();

      if (sentenceText.length > 10) {
        segments.push({ text: sentenceText, start, end });
      }
    }

    return segments;
  }

  /**
   * Infer reason for split
   */
  private inferSplitReason(breakpoint: ProposedBreakpoint): string {
    if (breakpoint.semanticDistance > 0.7) {
      return 'Major topic shift detected';
    }
    if (breakpoint.beforeText.match(/\n\n/)) {
      return 'Structural boundary (paragraph break)';
    }
    return 'Semantic transition point';
  }

  /**
   * Extract objective from chunk
   */
  private extractObjectiveFromChunk(chunk: string): string | null {
    // Look for objective-like statements
    const objectiveMatch = chunk.match(/(?:objective|goal|aim|task):\s*([^\n.]+)/i);
    if (objectiveMatch) {
      return objectiveMatch[1].trim();
    }

    // Look for imperative verbs
    const firstSentence = chunk.split(/[.!?]/)[0];
    const imperativePattern =
      /^(create|build|implement|write|test|verify|ensure|update|add|remove)/i;
    if (imperativePattern.test(firstSentence.trim())) {
      return firstSentence.trim();
    }

    return null;
  }

  /**
   * Extract instructions from chunk
   */
  private extractInstructions(chunk: string): string {
    // Remove metadata and keep core instructions
    return chunk.replace(/(?:Mission ID|Context|Dependencies):[^\n]*/gi, '').trim();
  }

  /**
   * Extract deliverables from chunk
   */
  private extractDeliverablesFromChunk(chunk: string): string[] {
    const deliverables: string[] = [];

    // Look for file mentions
    const filePattern = /(?:file|create|implement|write):\s*([^\n]+\.[\w]+)/gi;
    let match;
    while ((match = filePattern.exec(chunk)) !== null) {
      deliverables.push(match[1].trim());
    }

    return deliverables;
  }

  /**
   * Extract preserved context from mission
   */
  private extractPreservedContext(text: string, mission: GenericMission | null): string {
    if (mission) {
      return `Mission ID: ${mission.missionId}\nObjective: ${mission.objective}`;
    }

    const objective = text.match(/(?:objective|goal):\s*([^\n]+)/i);
    return objective ? objective[1] : text.substring(0, 200);
  }

  /**
   * Serialize mission to text
   */
  private serializeMission(mission: GenericMission): string {
    const parts: string[] = [
      `Mission ID: ${mission.missionId}`,
      `\nObjective: ${mission.objective}`,
    ];

    if (mission.context?.background) {
      parts.push(`\nContext: ${mission.context.background}`);
    }

    parts.push(
      `\nSuccess Criteria:\n${mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    );
    parts.push(
      `\nDeliverables:\n${mission.deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
    );

    return parts.join('');
  }

  /**
   * Generate reasoning for split recommendation
   */
  private generateSplitReasoning(complexity: ComplexityAnalysis, splits: SplitPoint[]): string {
    const parts: string[] = [
      `Mission complexity score: ${complexity.compositeScore.toFixed(2)}/10`,
      '',
      'Reasons for recommended split:',
      ...complexity.reasons.map((r) => `- ${r}`),
      '',
      `Recommended split into ${splits.length + 1} sub-missions at:`,
      ...splits.map((sp, i) => `${i + 1}. Position ${sp.position}: ${sp.reason}`),
    ];

    return parts.join('\n');
  }
}
