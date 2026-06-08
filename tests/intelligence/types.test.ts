import { describe, expect, test } from '@jest/globals';
import type {
  SupportedModel,
  CompressionLevel,
  CompressionPassType,
  TokenUsageComparison,
  CompressionRuleset,
  ModelConfig,
  ITokenCounter,
  IModelTranspiler,
  TokenOptimizerConfig,
} from '../../src/intelligence/types';

const useModels = (models: SupportedModel[]): SupportedModel[] => models;
const useLevels = (levels: CompressionLevel[]): CompressionLevel[] => levels;
const usePassTypes = (passes: CompressionPassType[]): CompressionPassType[] => passes;
const ensureTokenUsage = (usage: TokenUsageComparison): TokenUsageComparison => usage;
const ensureRuleset = (ruleset: CompressionRuleset): CompressionRuleset => ruleset;
const ensureModelConfig = (config: ModelConfig): ModelConfig => config;
const ensureOptimizerConfig = (config: TokenOptimizerConfig): TokenOptimizerConfig => config;

describe('intelligence/types', () => {
  test('supported model unions list known engines', () => {
    const models = useModels(['claude', 'gpt', 'gemini']);
    expect(models).toContain('claude');
    expect(models).toContain('gemini');
  });

  test('compression level unions enforce expected range', () => {
    const levels = useLevels(['conservative', 'balanced', 'aggressive']);
    expect(levels).toHaveLength(3);
  });

  test('compression pass type unions include structural stages', () => {
    const passes = usePassTypes(['sanitization', 'structural', 'linguistic', 'model-specific']);
    expect(passes).toContain('structural');
  });

  test('token usage comparison structure retains savings metadata', () => {
    const usage = ensureTokenUsage({
      model: 'claude',
      original: { model: 'claude', count: 1200, estimatedCost: 3.2 },
      optimized: { model: 'claude', count: 600, estimatedCost: 1.1 },
      savings: 600,
      compressionRatio: 0.5,
    });

    expect(usage.original.count).toBe(1200);
    expect(usage.optimized.count).toBe(600);
    expect(usage.savings).toBe(600);
  });

  test('compression ruleset aggregates rule buckets and preserve patterns', () => {
    const ruleset = ensureRuleset({
      sanitizationRules: [
        { type: 'regex_replace', pattern: /\s+/g, replacement: ' ', enabled: true },
      ],
      structuralRules: [
        { type: 'convert_prose_to_list', enabled: true, delimiters: ['First,', 'Next,'] },
      ],
      linguisticRules: [{ type: 'convert_passive_to_active', enabled: true }],
      preservePatterns: [/```code[\s\S]+?```/g],
    });

    expect(ruleset.sanitizationRules[0].type).toBe('regex_replace');
    expect(ruleset.preservePatterns).toHaveLength(1);
  });

  test('model config surface preferred delimiters', () => {
    const config = ensureModelConfig({
      model: 'gpt',
      templateFormat: 'markdown',
      preferredDelimiters: ['```'],
      supportsXmlTags: false,
    });

    expect(config.preferredDelimiters).toEqual(['```']);
    expect(config.supportsXmlTags).toBe(false);
  });

  test('token counter interface produces counts asynchronously', async () => {
    const counter: ITokenCounter = {
      async count(text, model) {
        return {
          model,
          count: text.length * 2,
          estimatedCost: text.length * 0.01,
        };
      },
    };

    const result = await counter.count('mission', 'gemini');
    expect(result.model).toBe('gemini');
    expect(result.count).toBe(14);
  });

  test('model transpiler interface returns transformed content', () => {
    const transpiler: IModelTranspiler = {
      transpile(content, targetModel) {
        return `[${targetModel.toUpperCase()}] ${content}`;
      },
    };

    expect(transpiler.transpile('hello', 'claude')).toBe('[CLAUDE] hello');
  });

  test('token optimizer config captures optional rule overrides', () => {
    const config = ensureOptimizerConfig({
      model: 'claude',
      level: 'balanced',
      ruleset: {
        sanitizationRules: [],
      },
      preserveTags: ['preserve'],
      dryRun: true,
    });

    expect(config.level).toBe('balanced');
    expect(config.dryRun).toBe(true);
  });
});
