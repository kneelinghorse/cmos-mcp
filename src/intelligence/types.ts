/**
 * Token Optimization Types
 *
 * Core interfaces and types for the token optimization engine.
 */

/**
 * Supported AI models for optimization
 */
export type SupportedModel = 'claude' | 'gpt' | 'gemini';

/**
 * Compression level configuration
 */
export type CompressionLevel = 'conservative' | 'balanced' | 'aggressive';

/**
 * Compression pass types
 */
export type CompressionPassType = 'sanitization' | 'structural' | 'linguistic' | 'model-specific';

/**
 * Token count result
 */
export interface TokenCount {
  model: SupportedModel;
  count: number;
  estimatedCost?: number;
}

/**
 * Detailed token usage metrics for before/after comparisons
 */
export interface TokenUsageComparison {
  model: SupportedModel;
  original: TokenCount;
  optimized: TokenCount;
  savings: number;
  compressionRatio: number;
}

/**
 * Options for abortable intelligence operations
 */
export interface AbortableOptions {
  signal?: AbortSignal;
}

/**
 * Compression statistics
 */
export interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  reductionPercentage: number;
  compressionRatio: number;
  passesApplied: CompressionPassType[];
}

/**
 * Optimization result
 */
export interface OptimizationResult {
  original: string;
  optimized: string;
  stats: CompressionStats;
  model: SupportedModel;
  level: CompressionLevel;
  tokenUsage: TokenUsageComparison;
  warnings?: string[];
}

/**
 * Compression rule definition
 */
export interface CompressionRule {
  type: 'regex_replace' | 'convert_prose_to_list' | 'convert_passive_to_active' | 'preserve_block';
  pattern?: string | RegExp;
  replacement?: string;
  targetSection?: string;
  enabled: boolean;
  flags?: string;
  delimiters?: string[];
}

/**
 * Ruleset configuration for compression
 */
export interface CompressionRuleset {
  sanitizationRules: CompressionRule[];
  structuralRules: CompressionRule[];
  linguisticRules: CompressionRule[];
  preservePatterns: RegExp[];
}

/**
 * Model-specific configuration
 */
export interface ModelConfig {
  model: SupportedModel;
  templateFormat: 'xml' | 'markdown' | 'ptcf';
  preferredDelimiters?: string[];
  supportsXmlTags?: boolean;
  supportsFewShot?: boolean;
}

/**
 * Token counter interface
 */
export interface ITokenCounter {
  count(text: string, model: SupportedModel, options?: AbortableOptions): Promise<TokenCount>;
}

/**
 * Model transpiler interface
 */
export interface IModelTranspiler {
  transpile(content: string, targetModel: SupportedModel): string;
}

/**
 * Token optimizer configuration
 */
export interface TokenOptimizerConfig {
  model: SupportedModel;
  level: CompressionLevel;
  ruleset?: Partial<CompressionRuleset>;
  preserveTags?: string[];
  dryRun?: boolean;
}
