/**
 * suggest_splits MCP Tool
 *
 * Analyzes mission complexity and suggests split points without actually splitting.
 * Provides recommendations and reasoning for mission decomposition.
 *
 * Algorithm:
 * 1. Load and parse mission file
 * 2. Calculate Composite Complexity Score
 * 3. If split recommended, identify optimal breakpoints
 * 4. Return analysis with reasoning and suggestions
 *
 * @module tools/suggest-splits
 * @version 1.0
 */

import { promises as fs } from 'fs';
import * as YAML from 'yaml';
import { GenericMission, isGenericMission } from '../schemas/generic-mission';
import { MissionSplitter } from '../intelligence/mission-splitter';
import { ComplexityScorer, ComplexityAnalysis } from '../intelligence/complexity-scorer';
import { ITokenCounter, SupportedModel } from '../intelligence/types';
import { getContextWindow } from '../intelligence/context-windows';
import { pathExists } from '../utils/fs';
import { resolveWorkspacePath } from '../utils/workspace-io';
import { ToolExecutionOptions } from './tool-execution';
import { throwIfAborted, withAbort } from '../utils/abort';

type SplitAnalysisResult = Awaited<ReturnType<MissionSplitter['suggestSplits']>>;

/**
 * Parameters for suggest_splits tool
 */
export interface SuggestSplitsParams {
  /** Path to mission file to analyze */
  missionFile: string;

  /** Target model for analysis */
  model?: SupportedModel;

  /** Show detailed breakdown of complexity components */
  detailed?: boolean;
}

/**
 * Split suggestion result
 */
export interface SplitSuggestion {
  shouldSplit: boolean;
  complexity: {
    compositeScore: number;
    tokenScore: number;
    structuralScore: number;
    timeHorizonScore: number;
    computationalScore: number;
  };
  reasons: string[];
  suggestedBreakpoints?: Array<{
    position: number;
    reason: string;
    confidence: number;
    preview: string;
  }>;
  estimatedSubMissions?: number;
  estimatedHumanHours?: number;
  recommendation: string;
  tokenUsage?: {
    model: SupportedModel;
    totalTokens: number;
    estimatedCost?: number;
    contextWindow: number;
    utilization: number;
  };
}

/**
 * MCP Tool Definition for split suggestions
 */
export const getSplitSuggestionsToolDefinition = {
  name: 'get_split_suggestions',
  description:
    'Analyzes a mission for complexity and suggests optimal split points without actually splitting it. Use this to evaluate whether a mission should be split and where the natural breakpoints are. This is useful for planning and understanding mission structure before committing to a split.',
  inputSchema: {
    type: 'object',
    required: ['missionFile'],
    properties: {
      missionFile: {
        type: 'string',
        description: 'Path to the mission file (YAML) to analyze',
      },
      model: {
        type: 'string',
        enum: ['claude', 'gpt', 'gemini'],
        description: 'Target AI model for analysis (default: claude)',
      },
      detailed: {
        type: 'boolean',
        description: 'Show detailed breakdown of all complexity components (default: false)',
      },
    },
  },
} as const;

/**
 * Legacy alias maintained for one release cycle
 */
export const suggestSplitsToolDefinitionDeprecated = {
  ...getSplitSuggestionsToolDefinition,
  name: 'suggest_splits',
  description:
    '[DEPRECATED] Use get_split_suggestions instead. Produces the same mission split recommendation report.',
} as const;

/**
 * SuggestSplitsToolImpl
 *
 * Main implementation class for split suggestions
 */
export class SuggestSplitsToolImpl {
  private splitter: MissionSplitter;
  private complexityScorer: ComplexityScorer;
  private model: SupportedModel;

  constructor(tokenCounter: ITokenCounter, model: SupportedModel = 'claude') {
    this.model = model;
    // Initialize complexity scorer
    const contextWindow = getContextWindow(model);
    this.complexityScorer = new ComplexityScorer(tokenCounter, {
      model,
      contextWindow,
      agentTimeHorizon: 60,
    });

    // Initialize splitter
    this.splitter = new MissionSplitter(this.complexityScorer);
  }

  /**
   * Execute split suggestion analysis
   */
  async execute(
    params: SuggestSplitsParams,
    options: ToolExecutionOptions = {}
  ): Promise<SplitSuggestion> {
    const { signal } = options;
    throwIfAborted(signal, 'Split suggestion execution aborted');

    // Validate input
    const missionFile = await this.validateParams(params, signal);
    throwIfAborted(signal, 'Split suggestion execution aborted');

    // Load mission
    const mission = await this.loadMissionFile(missionFile, signal);
    throwIfAborted(signal, 'Split suggestion execution aborted');

    // Get split suggestions from splitter
    const suggestion = await this.splitter.suggestSplits(mission, { signal });
    throwIfAborted(signal, 'Split suggestion execution aborted');

    // Build detailed result
    const result: SplitSuggestion = {
      shouldSplit: suggestion.shouldSplit,
      complexity: {
        compositeScore: suggestion.complexity.compositeScore,
        tokenScore: suggestion.complexity.components.tokenScore,
        structuralScore: suggestion.complexity.components.structuralScore,
        timeHorizonScore: suggestion.complexity.components.timeHorizonScore,
        computationalScore: suggestion.complexity.components.computationalScore,
      },
      reasons: suggestion.complexity.reasons,
      estimatedHumanHours: suggestion.complexity.estimatedHumanHours,
      recommendation: this.generateRecommendation(suggestion),
      tokenUsage: this.buildTokenUsage(suggestion.complexity),
    };

    // Add breakpoint details if split is recommended
    if (suggestion.shouldSplit && suggestion.suggestedSplits.length > 0) {
      const missionText = typeof mission === 'string' ? mission : this.serializeMission(mission);

      result.suggestedBreakpoints = suggestion.suggestedSplits.map((split) => ({
        position: split.position,
        reason: split.reason,
        confidence: split.confidence,
        preview: this.getBreakpointPreview(missionText, split.position),
      }));

      result.estimatedSubMissions = suggestion.suggestedSplits.length + 1;
    }

    return result;
  }

  /**
   * Build token usage summary from complexity analysis
   */
  private buildTokenUsage(complexity: ComplexityAnalysis) {
    const contextWindow = getContextWindow(this.model);
    const totalTokens = complexity.tokenDetails.count;

    return {
      model: complexity.tokenDetails.model,
      totalTokens,
      estimatedCost: complexity.tokenDetails.estimatedCost,
      contextWindow,
      utilization: totalTokens / contextWindow,
    };
  }

  /**
   * Validate parameters
   */
  private async validateParams(params: SuggestSplitsParams, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal, 'Split suggestion validation aborted');

    if (!params.missionFile || params.missionFile.trim().length === 0) {
      throw new Error('missionFile is required');
    }

    const sanitizedMissionFile = await resolveWorkspacePath(params.missionFile, {
      allowedExtensions: ['.yaml', '.yml'],
    });
    throwIfAborted(signal, 'Split suggestion validation aborted');

    if (!(await pathExists(sanitizedMissionFile))) {
      throw new Error(`Mission file not found: ${params.missionFile}`);
    }

    throwIfAborted(signal, 'Split suggestion validation aborted');

    return sanitizedMissionFile;
  }

  /**
   * Load mission from file
   */
  private async loadMissionFile(
    filePath: string,
    signal?: AbortSignal
  ): Promise<GenericMission | string> {
    try {
      const content = await withAbort(
        fs.readFile(filePath, 'utf-8'),
        signal,
        'Loading mission file aborted'
      );
      throwIfAborted(signal, 'Split suggestion execution aborted');

      try {
        const parsed = YAML.parse(content);
        if (isGenericMission(parsed)) {
          return parsed;
        }
        return content;
      } catch {
        return content;
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load mission file: ${error.message}`);
      }
      throw new Error('Failed to load mission file: Unknown error');
    }
  }

  /**
   * Generate recommendation text
   */
  private generateRecommendation(suggestion: SplitAnalysisResult): string {
    if (!suggestion.shouldSplit) {
      return this.getNoSplitRecommendation(suggestion.complexity);
    }

    return this.getSplitRecommendation(suggestion);
  }

  /**
   * Recommendation when no split is needed
   */
  private getNoSplitRecommendation(complexity: ComplexityAnalysis): string {
    const score = complexity.compositeScore;

    if (score < 4.0) {
      return `This mission has low complexity (${score.toFixed(2)}/10) and can be executed efficiently as a single mission. No split is needed.`;
    } else if (score < 6.0) {
      return `This mission has moderate complexity (${score.toFixed(2)}/10). It can be executed as-is, but consider monitoring progress and being prepared to split if issues arise.`;
    } else {
      return `This mission has notable complexity (${score.toFixed(2)}/10) but is still within acceptable limits. It may be executed as a single mission, though you should be prepared for a longer execution time.`;
    }
  }

  /**
   * Recommendation when split is suggested
   */
  private getSplitRecommendation(suggestion: SplitAnalysisResult): string {
    const score = suggestion.complexity.compositeScore;
    const numSplits = suggestion.suggestedSplits.length + 1;

    const parts: string[] = [
      `This mission has high complexity (${score.toFixed(2)}/10) and should be split.`,
      '',
      `**Recommended approach:**`,
      `- Split into ${numSplits} sub-missions`,
    ];

    if (suggestion.complexity.estimatedHumanHours) {
      const hours = suggestion.complexity.estimatedHumanHours;
      parts.push(`- Estimated total effort: ${hours.toFixed(1)} hours`);
      parts.push(`- Average per sub-mission: ${(hours / numSplits).toFixed(1)} hours`);
    }

    parts.push('');
    parts.push('**Benefits of splitting:**');
    parts.push('- Reduces risk of context window overflow');
    parts.push('- Enables incremental progress tracking');
    parts.push('- Improves success rate for each step');
    parts.push('- Allows for better error recovery');

    return parts.join('\n');
  }

  /**
   * Get preview text around breakpoint
   */
  private getBreakpointPreview(text: string, position: number): string {
    const previewLength = 80;
    const start = Math.max(0, position - previewLength / 2);
    const end = Math.min(text.length, position + previewLength / 2);

    const before = text.substring(start, position).replace(/\n/g, ' ').trim();
    const after = text.substring(position, end).replace(/\n/g, ' ').trim();

    return `...${before} | ${after}...`;
  }

  /**
   * Serialize mission to text
   */
  private serializeMission(mission: GenericMission): string {
    return YAML.stringify(mission, { indent: 2, lineWidth: 0 });
  }

  /**
   * Format result for LLM consumption
   */
  formatForLLM(result: SplitSuggestion, detailed: boolean = false): string {
    const parts: string[] = [
      '# Mission Complexity Analysis',
      '',
      `**Composite Complexity Score:** ${result.complexity.compositeScore.toFixed(2)}/10`,
    ];

    parts.push('');
    if (result.tokenUsage) {
      parts.push(`**Token Usage (${result.tokenUsage.model}):**`);
      parts.push(`- Mission tokens: ${result.tokenUsage.totalTokens}`);
      parts.push(
        `- Context utilization: ${(result.tokenUsage.utilization * 100).toFixed(1)}% of ${result.tokenUsage.contextWindow.toLocaleString()} tokens`
      );
      if (result.tokenUsage.estimatedCost !== undefined) {
        parts.push(`- Estimated input cost: $${result.tokenUsage.estimatedCost.toFixed(4)}`);
      }
    } else {
      parts.push('**Token Usage:**');
      parts.push('- Token metrics unavailable for this result.');
    }

    if (detailed) {
      parts.push('');
      parts.push('**Component Breakdown:**');
      parts.push(`- Token Score: ${result.complexity.tokenScore.toFixed(2)}/10`);
      parts.push(`- Structural Score: ${result.complexity.structuralScore.toFixed(2)}/10`);
      parts.push(`- Time Horizon Score: ${result.complexity.timeHorizonScore.toFixed(2)}/10`);
      parts.push(`- Computational Score: ${result.complexity.computationalScore.toFixed(2)}/10`);
    }

    if (result.estimatedHumanHours) {
      parts.push('');
      parts.push(`**Estimated Effort:** ${result.estimatedHumanHours.toFixed(1)} hours`);
    }

    parts.push('');
    parts.push('## Analysis');
    parts.push('');

    if (result.reasons.length > 0) {
      parts.push('**Key Factors:**');
      parts.push(...result.reasons.map((r) => `- ${r}`));
      parts.push('');
    }

    parts.push('## Recommendation');
    parts.push('');
    parts.push(result.recommendation);

    if (result.shouldSplit && result.suggestedBreakpoints) {
      parts.push('');
      parts.push('## Suggested Split Points');
      parts.push('');

      for (let i = 0; i < result.suggestedBreakpoints.length; i++) {
        const bp = result.suggestedBreakpoints[i];
        parts.push(`**Breakpoint ${i + 1}** (Confidence: ${(bp.confidence * 100).toFixed(0)}%)`);
        parts.push(`- Reason: ${bp.reason}`);
        parts.push(`- Location: Character ${bp.position}`);
        parts.push(`- Preview: \`${bp.preview}\``);
        parts.push('');
      }

      parts.push('---');
      parts.push('');
      parts.push(
        `Use \`split_mission\` tool to automatically split this mission into ${result.estimatedSubMissions} sub-missions.`
      );
    }

    return parts.join('\n');
  }
}
