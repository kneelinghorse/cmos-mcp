/**
 * Quality Scoring Engine
 * Implements the three-dimensional quality model from R4.4_Mission_Quality_metrics
 */

import {
  QualityScore,
  QualityScorerConfig,
  MissionContent,
  ImprovementSuggestion,
  DEFAULT_WEIGHTS,
  WeightsConfig,
} from './types';
import { ClarityAnalyzer } from './analyzers/clarity-analyzer';
import { CompletenessAnalyzer } from './analyzers/completeness-analyzer';
import { AIReadinessAnalyzer } from './analyzers/ai-readiness-analyzer';
import { ImprovementEngine } from './improvement-engine';

/**
 * Main quality scoring engine that orchestrates all dimensions
 */
export class QualityScorer {
  private clarityAnalyzer: ClarityAnalyzer;
  private completenessAnalyzer: CompletenessAnalyzer;
  private aiReadinessAnalyzer: AIReadinessAnalyzer;
  private improvementEngine: ImprovementEngine;
  private weights: WeightsConfig;
  private metricWeights: NonNullable<QualityScorerConfig['metricWeights']>;
  private performanceTargetMs: number;

  constructor(config: QualityScorerConfig = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(config.weights || {}) };
    this.metricWeights = config.metricWeights || {};
    this.performanceTargetMs = config.performanceTargetMs || 3000;

    this.clarityAnalyzer = new ClarityAnalyzer(this.metricWeights.clarity);
    this.completenessAnalyzer = new CompletenessAnalyzer(this.metricWeights.completeness);
    this.aiReadinessAnalyzer = new AIReadinessAnalyzer(this.metricWeights.aiReadiness);
    this.improvementEngine = new ImprovementEngine();
  }

  /**
   * Score a mission and return comprehensive quality report
   */
  async score(mission: MissionContent, missionId?: string): Promise<QualityScore> {
    const startTime = Date.now();

    // Analyze all dimensions in parallel for performance
    const [clarityScore, completenessScore, aiReadinessScore] = await Promise.all([
      this.clarityAnalyzer.analyze(mission),
      this.completenessAnalyzer.analyze(mission),
      this.aiReadinessAnalyzer.analyze(mission),
    ]);

    // Calculate total weighted score
    const totalScore = this.calculateTotalScore(
      clarityScore.score,
      completenessScore.score,
      aiReadinessScore.score
    );

    // Generate improvement suggestions
    const suggestions = this.improvementEngine.generateSuggestions(
      clarityScore,
      completenessScore,
      aiReadinessScore,
      mission
    );

    const processingTimeMs = Date.now() - startTime;

    // Validate performance target
    if (processingTimeMs > this.performanceTargetMs) {
      console.warn(
        `Quality scoring exceeded performance target: ${processingTimeMs}ms > ${this.performanceTargetMs}ms`
      );
    }

    return {
      total: totalScore,
      dimensions: {
        clarity: clarityScore,
        completeness: completenessScore,
        aiReadiness: aiReadinessScore,
      },
      suggestions,
      metadata: {
        assessedAt: new Date().toISOString(),
        processingTimeMs,
        missionId,
      },
    };
  }

  /**
   * Calculate unified quality score using weighted formula
   */
  private calculateTotalScore(
    clarityScore: number,
    completenessScore: number,
    aiReadinessScore: number,
    benchmarkScore: number = 0
  ): number {
    const total =
      this.weights.clarity * clarityScore +
      this.weights.completeness * completenessScore +
      this.weights.aiReadiness * aiReadinessScore +
      this.weights.benchmark * benchmarkScore;

    // Ensure score is between 0 and 1
    return Math.max(0, Math.min(1, total));
  }

  /**
   * Calculate Mission Maintainability Index (MMI)
   * Adapted from software Maintainability Index
   */
  calculateMaintainabilityIndex(
    wordCount: number,
    cyclomaticComplexity: number,
    lexicalDensity: number
  ): number {
    // Adapted formula: MMI = 171 - 5.2 * ln(Volume) - 0.23 * CC - 16.2 * ln(LOC) + 50 * sin(sqrt(2.4 * LD))
    // Simplified for mission context with empirical weights
    const volumeFactor = Math.log(wordCount * lexicalDensity);
    const complexityFactor = cyclomaticComplexity;
    const sizeFactor = Math.log(Math.max(1, wordCount));

    const mmi = 171 - 5.2 * volumeFactor - 0.23 * complexityFactor - 16.2 * sizeFactor;

    // Normalize to 0-100 scale
    return Math.max(0, Math.min(100, mmi));
  }

  /**
   * Get suggested improvements for a mission
   */
  async suggestImprovements(mission: MissionContent): Promise<ImprovementSuggestion[]> {
    const score = await this.score(mission);
    return score.suggestions;
  }
}
