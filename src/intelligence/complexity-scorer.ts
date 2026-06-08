/**
 * Mission Complexity Scorer
 *
 * Implements the Composite Complexity Score (CCS) framework from research mission R4.2.
 * Combines Token Score, Structural Score, Time Horizon Score, and Computational Complexity
 * to determine when a mission should be split.
 */

import { GenericMission } from '../types/mission-types';
import { AbortableOptions, ITokenCounter, SupportedModel, TokenCount } from './types';
import { throwIfAborted } from '../utils/abort';

/**
 * Complexity score components
 */
export interface ComplexityComponents {
  tokenScore: number;
  structuralScore: number;
  timeHorizonScore: number;
  computationalScore: number;
}

/**
 * Complete complexity analysis result
 */
export interface ComplexityAnalysis {
  compositeScore: number;
  components: ComplexityComponents;
  shouldSplit: boolean;
  reasons: string[];
  estimatedHumanHours?: number;
  tokenDetails: TokenCount;
}

/**
 * Configuration for complexity scoring
 */
export interface ComplexityScorerConfig {
  model: SupportedModel;
  contextWindow: number; // Maximum tokens for the model
  agentTimeHorizon: number; // Agent's 50%-task-completion time in minutes
  weights?: {
    token: number;
    structural: number;
    timeHorizon: number;
    computational: number;
  };
  thresholds?: {
    compositeScore: number;
    tokenPercentage: number;
    timeHorizonMultiplier: number;
  };
}

/**
 * Default configuration values
 */
const DEFAULT_WEIGHTS = {
  token: 0.35,
  structural: 0.25,
  timeHorizon: 0.3,
  computational: 0.1,
};

const DEFAULT_THRESHOLDS = {
  compositeScore: 8.0, // On a scale of 1-10
  tokenPercentage: 0.8, // 80% of context window
  timeHorizonMultiplier: 1.5, // 150% of agent's capability
};

/**
 * Procedural dependency keywords that signal atomic operations
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
  'following',
  'preceding',
];

/**
 * Complexity indicators in mission text
 */
const COMPLEXITY_INDICATORS = {
  loops: /\b(for each|while|iterate|loop|repeat)\b/gi,
  conditionals: /\b(if|else|when|unless|depending|whether)\b/gi,
  nested: /\b(nested|hierarchical|multi-level|recursive)\b/gi,
  integration: /\b(integrate|connect|combine|merge|sync)\b/gi,
  optimization: /\b(optimize|improve|refactor|enhance)\b/gi,
};

/**
 * ComplexityScorer class
 *
 * Calculates the Composite Complexity Score (CCS) for missions
 */
export class ComplexityScorer {
  private config: Required<ComplexityScorerConfig>;
  private tokenCounter: ITokenCounter;

  constructor(tokenCounter: ITokenCounter, config: ComplexityScorerConfig) {
    this.tokenCounter = tokenCounter;
    this.config = {
      ...config,
      weights: config.weights || DEFAULT_WEIGHTS,
      thresholds: config.thresholds || DEFAULT_THRESHOLDS,
    };
  }

  /**
   * Calculate the Composite Complexity Score for a mission
   */
  async calculateCCS(
    mission: GenericMission | string,
    options: AbortableOptions = {}
  ): Promise<ComplexityAnalysis> {
    const { signal } = options;
    throwIfAborted(signal, 'Complexity scoring aborted');

    const missionText = typeof mission === 'string' ? mission : this.serializeMission(mission);
    const missionObj = typeof mission === 'string' ? null : mission;

    // Calculate individual components
    const tokenCount = await this.tokenCounter.count(missionText, this.config.model, options);
    throwIfAborted(signal, 'Complexity scoring aborted');
    const tokenScore = this.calculateTokenScoreFromCount(tokenCount.count);
    const structuralScore = this.calculateStructuralScore(missionText, missionObj);
    throwIfAborted(signal, 'Complexity scoring aborted');
    const timeHorizonScore = this.calculateTimeHorizonScore(missionText, missionObj);
    const computationalScore = this.calculateComputationalScore(missionText);

    const components: ComplexityComponents = {
      tokenScore,
      structuralScore,
      timeHorizonScore,
      computationalScore,
    };

    // Calculate composite score using weighted sum
    const compositeScore = this.computeCompositeScore(components);

    // Determine if split is needed
    const { shouldSplit, reasons } = this.evaluateSplitNeed(compositeScore, components);

    throwIfAborted(signal, 'Complexity scoring aborted');

    const analysis: ComplexityAnalysis = {
      compositeScore,
      components,
      shouldSplit,
      reasons,
      estimatedHumanHours: this.estimateHumanHours(missionText, missionObj),
      tokenDetails: tokenCount,
    };

    throwIfAborted(signal, 'Complexity scoring aborted');

    return analysis;
  }

  /**
   * Token Score (TS): Normalized score representing proximity to context limit
   * TS = mission_token_count / model_context_window
   */
  private calculateTokenScoreFromCount(tokenCount: number): number {
    const ratio = tokenCount / this.config.contextWindow;

    // Normalize to 0-10 scale, with 1.0 ratio = 10
    return Math.min(ratio * 10, 10);
  }

  /**
   * Structural Score (SS): Static analysis of mission complexity
   * Analyzes discrete instructions, logical operators, nested goals, dependencies
   */
  private calculateStructuralScore(missionText: string, mission: GenericMission | null): number {
    let score = 0;

    // Count discrete instructions (bullet points, numbered items, sentences)
    const instructions = this.countInstructions(missionText);
    score += Math.min(instructions / 20, 3); // Max 3 points for instructions

    // Count logical operators
    const logicalOps = this.countLogicalOperators(missionText);
    score += Math.min(logicalOps / 10, 2); // Max 2 points for operators

    // Count dependencies
    if (mission?.context?.dependencies) {
      score += Math.min(mission.context.dependencies.length / 5, 2); // Max 2 points for dependencies
    }

    // Count nested structures (indentation, sub-items)
    const nestingLevel = this.estimateNestingLevel(missionText);
    score += Math.min(nestingLevel, 2); // Max 2 points for nesting

    // Count deliverables (more deliverables = more complex)
    if (mission?.deliverables) {
      score += Math.min(mission.deliverables.length / 10, 1); // Max 1 point for deliverables
    }

    return Math.min(score, 10); // Normalize to 0-10
  }

  /**
   * Time Horizon Score (THS): Ratio of estimated duration to agent capability
   * THS = estimated_human_completion_time / agent_time_horizon
   */
  private calculateTimeHorizonScore(missionText: string, mission: GenericMission | null): number {
    const estimatedMinutes = this.estimateHumanHours(missionText, mission) * 60;
    const ratio = estimatedMinutes / this.config.agentTimeHorizon;

    // Normalize to 0-10 scale, with ratio > 1.0 indicating exceeding capacity
    return Math.min(ratio * 5, 10); // ratio of 2.0 = score of 10
  }

  /**
   * Computational Complexity Score: Assessment of algorithmic complexity
   * Distinguishes between O(n) and O(2^n) operations
   */
  private calculateComputationalScore(missionText: string): number {
    let score = 0;

    // Check for complexity indicators
    for (const [type, pattern] of Object.entries(COMPLEXITY_INDICATORS)) {
      const matches = (missionText.match(pattern) || []).length;
      if (type === 'nested' || type === 'optimization') {
        score += matches * 1.5; // Higher weight for nested/optimization
      } else {
        score += matches * 0.5;
      }
    }

    // Check for exponential complexity keywords
    const exponentialKeywords =
      /\b(all combinations|permutations|exponential|factorial|brute[ -]?force)\b/gi;
    const exponentialMatches = (missionText.match(exponentialKeywords) || []).length;
    score += exponentialMatches * 3;

    return Math.min(score, 10); // Normalize to 0-10
  }

  /**
   * Compute the weighted composite score
   */
  private computeCompositeScore(components: ComplexityComponents): number {
    const { weights } = this.config;

    const score =
      weights.token * components.tokenScore +
      weights.structural * components.structuralScore +
      weights.timeHorizon * components.timeHorizonScore +
      weights.computational * components.computationalScore;

    return Math.min(score, 10); // Ensure 0-10 range
  }

  /**
   * Evaluate whether mission should be split
   */
  private evaluateSplitNeed(
    compositeScore: number,
    components: ComplexityComponents
  ): { shouldSplit: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let shouldSplit = false;

    // Check composite score threshold
    if (compositeScore > this.config.thresholds.compositeScore) {
      shouldSplit = true;
      reasons.push(
        `Composite complexity score (${compositeScore.toFixed(2)}) exceeds threshold (${this.config.thresholds.compositeScore})`
      );
    }

    // Check token threshold
    const tokenRatio = components.tokenScore / 10; // Convert back to ratio
    if (tokenRatio > this.config.thresholds.tokenPercentage) {
      shouldSplit = true;
      reasons.push(`Token count at ${(tokenRatio * 100).toFixed(0)}% of context window`);
    }

    // Check time horizon threshold
    const timeRatio = components.timeHorizonScore / 5; // Convert back to ratio
    if (timeRatio > this.config.thresholds.timeHorizonMultiplier) {
      shouldSplit = true;
      reasons.push(
        `Estimated duration exceeds agent time horizon by ${((timeRatio - 1) * 100).toFixed(0)}%`
      );
    }

    return { shouldSplit, reasons };
  }

  /**
   * Estimate human completion time in hours
   */
  private estimateHumanHours(missionText: string, mission: GenericMission | null): number {
    // Base estimate on word count (avg reading speed ~200 wpm)
    const words = missionText.split(/\s+/).length;
    let hours = words / 200 / 60; // Convert to hours

    // Adjust based on deliverables (30 min per deliverable)
    if (mission?.deliverables) {
      hours += mission.deliverables.length * 0.5;
    }

    // Adjust based on success criteria (15 min per criterion)
    if (mission?.successCriteria) {
      hours += mission.successCriteria.length * 0.25;
    }

    // Adjust for complexity indicators
    for (const pattern of Object.values(COMPLEXITY_INDICATORS)) {
      const matches = (missionText.match(pattern) || []).length;
      hours += matches * 0.5; // 30 min per complexity indicator
    }

    return Math.max(hours, 0.5); // Minimum 30 minutes
  }

  /**
   * Count discrete instructions in mission text
   */
  private countInstructions(text: string): number {
    // Count numbered items
    const numberedItems = (text.match(/^\s*\d+[.)]\s+/gm) || []).length;

    // Count bullet points
    const bulletPoints = (text.match(/^\s*[-*+]\s+/gm) || []).length;

    // Count sentences with imperative verbs (crude estimate)
    const imperativeVerbs =
      /\b(create|build|implement|write|test|verify|ensure|update|add|remove|delete|check|validate|generate)\b/gi;
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const imperativeSentences = sentences.filter((s) => imperativeVerbs.test(s)).length;

    return Math.max(numberedItems, bulletPoints, imperativeSentences);
  }

  /**
   * Count logical operators in text
   */
  private countLogicalOperators(text: string): number {
    let count = 0;

    // Count conditionals
    count += (text.match(COMPLEXITY_INDICATORS.conditionals) || []).length;

    // Count loops
    count += (text.match(COMPLEXITY_INDICATORS.loops) || []).length;

    // Count dependency keywords
    for (const keyword of DEPENDENCY_KEYWORDS) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      count += (text.match(regex) || []).length;
    }

    return count;
  }

  /**
   * Estimate nesting level from indentation
   */
  private estimateNestingLevel(text: string): number {
    const lines = text.split('\n');
    let maxNesting = 0;

    for (const line of lines) {
      // Count leading spaces/tabs
      const leadingWhitespace = line.match(/^[\s\t]*/)?.[0] || '';
      const spaces = leadingWhitespace.replace(/\t/g, '  ').length;
      const nestingLevel = Math.floor(spaces / 2);

      maxNesting = Math.max(maxNesting, nestingLevel);
    }

    return maxNesting;
  }

  /**
   * Serialize mission object to text for analysis
   */
  private serializeMission(mission: GenericMission): string {
    const parts: string[] = [
      `Mission ID: ${mission.missionId}`,
      `\nObjective: ${mission.objective}`,
    ];

    if (mission.context) {
      if (mission.context.background) {
        parts.push(`\nContext: ${mission.context.background}`);
      }
      if (mission.context.dependencies?.length) {
        parts.push(`\nDependencies: ${mission.context.dependencies.join(', ')}`);
      }
      if (mission.context.constraints?.length) {
        parts.push(`\nConstraints: ${mission.context.constraints.join(', ')}`);
      }
    }

    parts.push(
      `\nSuccess Criteria:\n${mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    );
    parts.push(
      `\nDeliverables:\n${mission.deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
    );

    return parts.join('');
  }
}
