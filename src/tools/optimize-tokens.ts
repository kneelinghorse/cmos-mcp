/**
 * update_token_optimization (alias optimize_tokens) MCP Tool
 *
 * Optimizes mission content for token efficiency using model-aware compression.
 * Implements the 4-pass pipeline from R4.1 research.
 *
 * Algorithm:
 * 1. Load mission file
 * 2. Apply multi-pass compression (sanitization, structural, linguistic, model-specific)
 * 3. Calculate compression statistics
 * 4. Return optimized content and stats
 *
 * @module tools/optimize-tokens
 * @version 1.0
 */

import * as fs from 'fs/promises';
import { TokenOptimizer } from '../intelligence/token-optimizer';
import { SupportedModel, CompressionLevel } from '../intelligence/types';
import { pathExists } from '../utils/fs';
import { resolveWorkspacePath, writeFileAtomicWithBackup } from '../utils/workspace-io';
import { ToolExecutionOptions } from './tool-execution';
import { throwIfAborted, withAbort } from '../utils/abort';

/**
 * Parameters for optimize_tokens tool
 */
export interface OptimizeTokensParams {
  /** Path to mission file to optimize */
  missionFile: string;

  /** Target model (claude, gpt, or gemini) */
  targetModel: SupportedModel;

  /** Compression level (conservative, balanced, or aggressive) */
  compressionLevel?: CompressionLevel;

  /** Dry run mode - preview changes without applying */
  dryRun?: boolean;

  /** Custom preserve tags */
  preserveTags?: string[];
}

/**
 * MCP Tool Definition for token optimization
 */
export const updateTokenOptimizationToolDefinition = {
  name: 'update_token_optimization',
  description:
    'Optimize mission content for token efficiency. Applies model-aware compression using a 4-pass pipeline: sanitization, structural refactoring, linguistic simplification, and model-specific templating. Target reduction: 20-30% tokens while maintaining semantic integrity.',
  inputSchema: {
    type: 'object',
    required: ['missionFile', 'targetModel'],
    properties: {
      missionFile: {
        type: 'string',
        description: 'Path to the mission file to optimize (YAML format)',
      },
      targetModel: {
        type: 'string',
        enum: ['claude', 'gpt', 'gemini'],
        description: 'Target AI model for optimization (determines output format)',
      },
      compressionLevel: {
        type: 'string',
        enum: ['conservative', 'balanced', 'aggressive'],
        description: 'Compression level (default: balanced)',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview mode - shows stats without applying changes (default: false)',
      },
      preserveTags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom XML tags to preserve from compression (e.g., ["critical", "exact"])',
      },
    },
  },
} as const;

/**
 * Backwards-compatible export preserving the historical optimize_tokens identifier.
 * Points to the canonical tool definition to avoid contract drift across releases.
 */
export const optimizeTokensToolDefinition = updateTokenOptimizationToolDefinition;

/**
 * Legacy alias maintained for one release cycle
 */
export const optimizeTokensToolDefinitionDeprecated = {
  ...updateTokenOptimizationToolDefinition,
  name: 'optimize_tokens',
  description:
    '[DEPRECATED] Use update_token_optimization instead. Applies the same multi-pass token compression pipeline.',
} as const;

/**
 * OptimizeTokensToolImpl
 */
export class OptimizeTokensToolImpl {
  private optimizer: TokenOptimizer;

  constructor(optimizer?: TokenOptimizer) {
    this.optimizer = optimizer || new TokenOptimizer();
  }

  /**
   * Execute the optimize_tokens tool
   */
  async execute(
    params: OptimizeTokensParams,
    options: ToolExecutionOptions = {}
  ): Promise<{
    success: boolean;
    optimizedContent?: string;
    stats?: {
      originalTokens: number;
      compressedTokens: number;
      reductionPercentage: number;
      compressionRatio: number;
      passesApplied: string[];
    };
    tokenUsage?: {
      model: SupportedModel;
      original: {
        count: number;
        estimatedCost?: number;
      };
      optimized: {
        count: number;
        estimatedCost?: number;
      };
      savings: number;
      compressionRatio: number;
    };
    warnings?: string[];
    error?: string;
  }> {
    try {
      const { signal } = options;
      throwIfAborted(signal, 'Token optimization aborted');

      const missionPath = await resolveWorkspacePath(params.missionFile, {
        allowedExtensions: ['.yaml', '.yml'],
      });

      throwIfAborted(signal, 'Token optimization aborted');

      if (!(await pathExists(missionPath))) {
        return {
          success: false,
          error: `Mission file not found: ${params.missionFile}`,
        };
      }

      // Read mission content
      const content = await withAbort(
        fs.readFile(missionPath, 'utf-8'),
        signal,
        'Reading mission file aborted'
      );
      throwIfAborted(signal, 'Token optimization aborted');

      // Optimize
      const result = await this.optimizer.optimize(
        content,
        {
          model: params.targetModel,
          level: params.compressionLevel || 'balanced',
          preserveTags: params.preserveTags,
          dryRun: params.dryRun || false,
        },
        { signal }
      );
      throwIfAborted(signal, 'Token optimization aborted');

      // Write optimized content back if not dry run
      if (!params.dryRun) {
        await writeFileAtomicWithBackup(missionPath, result.optimized, {
          encoding: 'utf-8',
          allowedExtensions: ['.yaml', '.yml'],
          allowRelative: false,
          signal,
        });
      }

      return {
        success: true,
        optimizedContent: result.optimized,
        stats: {
          originalTokens: result.stats.originalTokens,
          compressedTokens: result.stats.compressedTokens,
          reductionPercentage: result.stats.reductionPercentage,
          compressionRatio: result.stats.compressionRatio,
          passesApplied: result.stats.passesApplied,
        },
        warnings: result.warnings,
        tokenUsage: {
          model: result.tokenUsage.model,
          original: {
            count: result.tokenUsage.original.count,
            estimatedCost: result.tokenUsage.original.estimatedCost,
          },
          optimized: {
            count: result.tokenUsage.optimized.count,
            estimatedCost: result.tokenUsage.optimized.estimatedCost,
          },
          savings: result.tokenUsage.savings,
          compressionRatio: result.tokenUsage.compressionRatio,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during optimization',
      };
    }
  }
}

export type OptimizeTokensExecutionResult = Awaited<ReturnType<OptimizeTokensToolImpl['execute']>>;

/**
 * Export tool handler
 */
export async function handleOptimizeTokens(
  params: OptimizeTokensParams
): Promise<OptimizeTokensExecutionResult> {
  const tool = new OptimizeTokensToolImpl();
  return tool.execute(params);
}
