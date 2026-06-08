/**
 * Token Optimizer
 *
 * Main class implementing the 4-pass compression pipeline:
 * 1. Sanitization & Normalization
 * 2. Structural Refactoring
 * 3. Linguistic Simplification
 * 4. Model-Specific Templating
 */

import {
  TokenOptimizerConfig,
  OptimizationResult,
  CompressionStats,
  CompressionPassType,
  SupportedModel,
  CompressionLevel,
  AbortableOptions,
} from './types';
import { TokenCounter } from './token-counters';
import { ModelTranspiler } from './model-transpilers';
import {
  getDefaultRuleset,
  applySanitization,
  applyStructuralRefactoring,
  applyLinguisticSimplification,
  extractPreservedSections,
  replaceWithPlaceholders,
  restorePreservedSections,
} from './compression-rules';
import { throwIfAborted, withAbort } from '../utils/abort';

/**
 * Token optimizer class
 */
export class TokenOptimizer {
  private tokenCounter: TokenCounter;
  private transpiler: ModelTranspiler;

  constructor(tokenCounter?: TokenCounter, transpiler?: ModelTranspiler) {
    this.tokenCounter = tokenCounter || new TokenCounter();
    this.transpiler = transpiler || new ModelTranspiler();
  }

  /**
   * Optimize mission content
   */
  async optimize(
    missionContent: string,
    config: TokenOptimizerConfig,
    execution: AbortableOptions = {}
  ): Promise<OptimizationResult> {
    const { signal } = execution;
    throwIfAborted(signal, 'Token optimization aborted');

    const { model, level, ruleset, preserveTags, dryRun } = config;

    // Get default ruleset and merge with custom rules
    const finalRuleset = {
      ...getDefaultRuleset(level),
      ...ruleset,
    };

    // Add custom preserve tags if provided
    if (preserveTags && preserveTags.length > 0) {
      for (const tag of preserveTags) {
        finalRuleset.preservePatterns.push(new RegExp(`<${tag}>.*?</${tag}>`, 'gs'));
      }
    }

    // Count original tokens
    const originalTokenCount = await this.tokenCounter.count(missionContent, model, execution);
    throwIfAborted(signal, 'Token optimization aborted');

    // Track passes applied
    const passesApplied: CompressionPassType[] = [];
    let result = missionContent;
    const warnings: string[] = [];

    try {
      // Extract and preserve protected sections
      const preserved = extractPreservedSections(result, finalRuleset.preservePatterns);
      result = replaceWithPlaceholders(result, preserved);
      throwIfAborted(signal, 'Token optimization aborted');

      // Pass 1: Sanitization & Normalization
      if (finalRuleset.sanitizationRules.length > 0) {
        result = applySanitization(result, finalRuleset.sanitizationRules);
        passesApplied.push('sanitization');
        throwIfAborted(signal, 'Token optimization aborted');
      }

      // Pass 2: Structural Refactoring
      if (finalRuleset.structuralRules.length > 0) {
        result = applyStructuralRefactoring(result, finalRuleset.structuralRules);
        passesApplied.push('structural');
        throwIfAborted(signal, 'Token optimization aborted');
      }

      // Pass 3: Linguistic Simplification
      if (finalRuleset.linguisticRules.length > 0) {
        result = applyLinguisticSimplification(result, finalRuleset.linguisticRules);
        passesApplied.push('linguistic');
        throwIfAborted(signal, 'Token optimization aborted');
      }

      // Restore preserved sections
      result = restorePreservedSections(result, preserved);
      throwIfAborted(signal, 'Token optimization aborted');

      // Pass 4: Model-Specific Templating
      result = this.transpiler.transpile(result, model);
      passesApplied.push('model-specific');
      throwIfAborted(signal, 'Token optimization aborted');

      // Count compressed tokens
      const compressedTokenCount = await this.tokenCounter.count(result, model, execution);
      throwIfAborted(signal, 'Token optimization aborted');
      const denominator = compressedTokenCount.count === 0 ? 1 : compressedTokenCount.count;

      // Calculate stats
      const stats: CompressionStats = {
        originalTokens: originalTokenCount.count,
        compressedTokens: compressedTokenCount.count,
        reductionPercentage: this.calculateReductionPercentage(
          originalTokenCount.count,
          compressedTokenCount.count
        ),
        compressionRatio: originalTokenCount.count / denominator,
        passesApplied,
      };
      const tokenUsage = {
        model,
        original: originalTokenCount,
        optimized: compressedTokenCount,
        savings: originalTokenCount.count - compressedTokenCount.count,
        compressionRatio: stats.compressionRatio,
      };

      // Check if we achieved target reduction
      if (stats.reductionPercentage < 20 || stats.reductionPercentage > 30) {
        warnings.push(
          `Compression achieved ${stats.reductionPercentage.toFixed(1)}% reduction, target is 20-30%`
        );
      }

      // If dry run, return original content
      if (dryRun) {
        result = missionContent;
      }

      return {
        original: missionContent,
        optimized: result,
        stats,
        model,
        level,
        tokenUsage,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      throw new Error(
        `Optimization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Optimize a mission file
   */
  async optimizeFile(
    filePath: string,
    config: TokenOptimizerConfig,
    execution: AbortableOptions = {}
  ): Promise<OptimizationResult> {
    const fs = await import('fs/promises');
    const content = await withAbort(
      fs.readFile(filePath, 'utf-8'),
      execution.signal,
      'Reading mission file aborted'
    );
    throwIfAborted(execution.signal, 'Token optimization aborted');
    return this.optimize(content, config, execution);
  }

  /**
   * Calculate reduction percentage
   */
  private calculateReductionPercentage(original: number, compressed: number): number {
    return ((original - compressed) / original) * 100;
  }

  /**
   * Batch optimize multiple missions
   */
  async optimizeBatch(
    missions: Array<{ content: string; id: string }>,
    config: TokenOptimizerConfig,
    execution: AbortableOptions = {}
  ): Promise<Map<string, OptimizationResult>> {
    const results = new Map<string, OptimizationResult>();
    const { signal } = execution;

    for (const mission of missions) {
      throwIfAborted(signal, 'Token optimization aborted');
      const result = await this.optimize(mission.content, config, execution);
      results.set(mission.id, result);
    }

    return results;
  }

  /**
   * Get compression preview (dry run)
   */
  async preview(
    missionContent: string,
    model: SupportedModel,
    level: CompressionLevel,
    execution: AbortableOptions = {}
  ): Promise<OptimizationResult> {
    return this.optimize(
      missionContent,
      {
        model,
        level,
        dryRun: true,
      },
      execution
    );
  }
}

/**
 * Export singleton instance
 */
export const defaultOptimizer = new TokenOptimizer();

/**
 * Convenience function for quick optimization
 */
export async function optimizeMission(
  content: string,
  model: SupportedModel,
  level: CompressionLevel = 'balanced'
): Promise<OptimizationResult> {
  return defaultOptimizer.optimize(content, { model, level });
}
