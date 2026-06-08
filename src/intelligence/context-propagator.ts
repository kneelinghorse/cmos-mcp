/**
 * Context Propagation System
 *
 * Implements context preservation mechanisms from research mission R4.2.
 * Manages LLM context window for mission chains using summarization strategies.
 */

/**
 * Strategy for context propagation
 */
export type ContextStrategy = 'full' | 'extractive' | 'abstractive' | 'map-reduce';

/**
 * Sub-mission execution result
 */
export interface SubMissionResult {
  missionId: string;
  input: string;
  output: string;
  status: 'success' | 'failed';
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Context summary
 */
export interface ContextSummary {
  originalMission: string;
  completedSteps: SubMissionResult[];
  summary: string;
  tokenCount: number;
  strategy: ContextStrategy;
}

/**
 * Configuration for context propagation
 */
export interface ContextPropagatorConfig {
  maxContextTokens: number; // Maximum tokens to include in context
  strategy?: ContextStrategy;
  summaryModel?: string; // Model to use for summarization
}

/**
 * Extractive summary - key sentences/phrases extracted from text
 */
interface ExtractiveSummary {
  keySentences: string[];
  keyPhrases: string[];
  importance: number;
}

/**
 * ContextPropagator class
 *
 * Manages context across mission chains to prevent context window overflow
 */
export class ContextPropagator {
  private config: Required<ContextPropagatorConfig>;

  constructor(config: ContextPropagatorConfig) {
    this.config = {
      strategy: config.strategy || 'map-reduce',
      summaryModel: config.summaryModel || 'claude',
      ...config,
    };
  }

  /**
   * Generate context for next sub-mission
   */
  async propagateContext(
    originalMission: string,
    completedResults: SubMissionResult[],
    _currentSubMission: string
  ): Promise<ContextSummary> {
    const strategy = this.determineStrategy(completedResults);

    let summary: string;
    switch (strategy) {
      case 'full':
        summary = this.fullContextStuffing(originalMission, completedResults);
        break;
      case 'extractive':
        summary = this.extractiveSummarization(originalMission, completedResults);
        break;
      case 'abstractive':
        summary = this.abstractiveSummarization(originalMission, completedResults);
        break;
      case 'map-reduce':
        summary = this.mapReduceSummarization(originalMission, completedResults);
        break;
    }

    const tokenCount = this.estimateTokens(summary);

    return {
      originalMission,
      completedSteps: completedResults,
      summary,
      tokenCount,
      strategy,
    };
  }

  /**
   * Determine optimal strategy based on context size
   */
  private determineStrategy(completedResults: SubMissionResult[]): ContextStrategy {
    const totalSize = completedResults.reduce(
      (sum, result) => sum + result.input.length + result.output.length,
      0
    );

    // For short chains, use full context
    if (completedResults.length <= 2 && totalSize < this.config.maxContextTokens * 3) {
      return 'full';
    }

    // For medium chains, use extractive
    if (completedResults.length <= 4) {
      return 'extractive';
    }

    // For narrative chains with moderate length, use abstractive
    if (completedResults.length <= 6 || totalSize < this.config.maxContextTokens * 6) {
      return 'abstractive';
    }

    // For long chains, use map-reduce
    return 'map-reduce';
  }

  /**
   * Strategy 1: Full Context Repetition (Stuffing)
   * Concatenates all context - only suitable for short chains
   */
  private fullContextStuffing(
    originalMission: string,
    completedResults: SubMissionResult[]
  ): string {
    const parts: string[] = [
      '=== ORIGINAL MISSION ===',
      originalMission,
      '',
      '=== COMPLETED SUB-MISSIONS ===',
    ];

    for (const result of completedResults) {
      parts.push(`\n--- Sub-Mission: ${result.missionId} ---`);
      parts.push(`Status: ${result.status}`);
      parts.push(`Input: ${result.input}`);
      parts.push(`Output: ${result.output}`);
    }

    return parts.join('\n');
  }

  /**
   * Strategy 2: Extractive Summarization
   * Extracts key sentences and phrases from outputs
   */
  private extractiveSummarization(
    originalMission: string,
    completedResults: SubMissionResult[]
  ): string {
    const parts: string[] = [
      '=== ORIGINAL MISSION (Summary) ===',
      this.extractKeyInfo(originalMission).keySentences.slice(0, 3).join(' '),
      '',
      '=== COMPLETED STEPS (Key Outputs) ===',
    ];

    for (const result of completedResults) {
      const extracted = this.extractKeyInfo(result.output);
      parts.push(`\n${result.missionId}: ${extracted.keySentences.slice(0, 2).join(' ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Strategy 3: Abstractive Summarization
   * Generates human-like summaries (placeholder for LLM-based summarization)
   */
  private abstractiveSummarization(
    originalMission: string,
    completedResults: SubMissionResult[]
  ): string {
    // In a production system, this would call an LLM to generate summaries
    // For now, we'll use extractive as a fallback with narrative structure
    const parts: string[] = [
      '=== MISSION OVERVIEW ===',
      `The mission aims to: ${this.extractObjective(originalMission)}`,
      '',
      '=== PROGRESS ===',
    ];

    for (let i = 0; i < completedResults.length; i++) {
      const result = completedResults[i];
      const keyPoints = this.extractKeyInfo(result.output).keySentences.slice(0, 1);
      parts.push(`Step ${i + 1}: ${keyPoints[0] || 'Completed successfully'}`);
    }

    return parts.join('\n');
  }

  /**
   * Strategy 4: Map-Reduce Summarization
   * Recursively summarizes individual results then combines summaries
   */
  private mapReduceSummarization(
    originalMission: string,
    completedResults: SubMissionResult[]
  ): string {
    // Map phase: Summarize each result individually
    const individualSummaries = completedResults.map((result) => {
      const extracted = this.extractKeyInfo(result.output);
      return {
        missionId: result.missionId,
        summary: extracted.keySentences.slice(0, 2).join(' '),
        status: result.status,
      };
    });

    // Reduce phase: Group and synthesize summaries
    const grouped = this.groupSummaries(individualSummaries);

    const parts: string[] = [
      '=== MISSION CONTEXT ===',
      this.extractKeyInfo(originalMission).keySentences.slice(0, 2).join(' '),
      '',
      '=== EXECUTION SUMMARY ===',
    ];

    for (const [group, summaries] of Object.entries(grouped)) {
      parts.push(`\n${group}:`);
      for (const summary of summaries) {
        parts.push(`- ${summary.summary}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract key information using simple heuristics
   */
  private extractKeyInfo(text: string): ExtractiveSummary {
    const sentences = text
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20); // Filter out very short sentences

    // Score sentences by importance
    const scoredSentences = sentences.map((sentence) => {
      let score = 0;

      // Keywords indicating importance
      const importantKeywords = [
        'objective',
        'goal',
        'success',
        'complete',
        'implement',
        'create',
        'result',
        'achieve',
        'deliver',
      ];

      for (const keyword of importantKeywords) {
        if (sentence.toLowerCase().includes(keyword)) {
          score += 2;
        }
      }

      // Position bias - earlier sentences often more important
      const position = sentences.indexOf(sentence);
      if (position < 3) score += 3;
      if (position >= sentences.length - 3) score += 2; // Last sentences also important

      // Length - prefer medium-length sentences
      if (sentence.split(/\s+/).length > 10 && sentence.split(/\s+/).length < 30) {
        score += 1;
      }

      return { sentence, score };
    });

    // Sort by score and take top sentences
    const keySentences = scoredSentences
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.sentence);

    // Extract key phrases (simple noun phrase extraction)
    const keyPhrases = this.extractKeyPhrases(text);

    return {
      keySentences,
      keyPhrases,
      importance: scoredSentences.reduce((sum, s) => sum + s.score, 0) / sentences.length,
    };
  }

  /**
   * Extract key phrases (simple implementation)
   */
  private extractKeyPhrases(text: string): string[] {
    const phrases: string[] = [];

    // Extract quoted text
    const quoted = text.match(/"([^"]+)"/g) || [];
    phrases.push(...quoted.map((q) => q.replace(/"/g, '')));

    // Extract capitalized multi-word terms
    const capitalized = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    phrases.push(...capitalized);

    return [...new Set(phrases)].slice(0, 10);
  }

  /**
   * Extract objective from mission text
   */
  private extractObjective(missionText: string): string {
    // Look for objective/goal statements
    const objectiveMatch = missionText.match(/(?:objective|goal|purpose|aim):\s*([^.\n]+)/i);
    if (objectiveMatch) {
      return objectiveMatch[1].trim();
    }

    // Fallback: first sentence
    const firstSentence = missionText.split(/[.!?]/)[0];
    return firstSentence.trim();
  }

  /**
   * Group summaries by semantic similarity (simple implementation)
   */
  private groupSummaries(
    summaries: Array<{ missionId: string; summary: string; status: string }>
  ): Record<string, Array<{ missionId: string; summary: string }>> {
    // Simple grouping by sequential order
    // In production, this would use embedding similarity
    const grouped: Record<string, Array<{ missionId: string; summary: string }>> = {};

    for (let i = 0; i < summaries.length; i++) {
      const groupKey = `Phase ${Math.floor(i / 3) + 1}`;
      if (!grouped[groupKey]) {
        grouped[groupKey] = [];
      }
      grouped[groupKey].push({
        missionId: summaries[i].missionId,
        summary: summaries[i].summary,
      });
    }

    return grouped;
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Validate context fits within token limits
   */
  validateContextSize(summary: ContextSummary): { valid: boolean; overflow: number } {
    const overflow = summary.tokenCount - this.config.maxContextTokens;
    return {
      valid: overflow <= 0,
      overflow: Math.max(0, overflow),
    };
  }

  /**
   * Create minimal context for emergency situations
   */
  createMinimalContext(originalMission: string, lastResult: SubMissionResult): string {
    const objective = this.extractObjective(originalMission);
    const lastOutput = this.extractKeyInfo(lastResult.output).keySentences[0] || 'No output';

    return `Mission: ${objective}\nLast step: ${lastOutput}\nContinuing...`;
  }
}
