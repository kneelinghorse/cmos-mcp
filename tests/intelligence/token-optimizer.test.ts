/**
 * Token Optimizer Tests
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { TokenOptimizer, optimizeMission } from '../../src/intelligence/token-optimizer';
import { TokenCounter } from '../../src/intelligence/token-counters';
import { ModelTranspiler } from '../../src/intelligence/model-transpilers';

describe('TokenOptimizer', () => {
  let optimizer: TokenOptimizer;
  let mockTokenCounter: TokenCounter;
  let mockTranspiler: ModelTranspiler;

  beforeEach(() => {
    mockTokenCounter = new TokenCounter();
    mockTranspiler = new ModelTranspiler();
    optimizer = new TokenOptimizer(mockTokenCounter, mockTranspiler);
  });

  describe('optimize', () => {
    test('should reduce token count', async () => {
      const content = `objective: Could you please provide a detailed explanation of how to create a test mission.
context: In order to understand this, you need to know that this is just a test.
successCriteria: It is important to note that the test must pass.`;

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'balanced',
      });

      expect(result.stats.compressedTokens).toBeLessThan(result.stats.originalTokens);
      expect(result.stats.reductionPercentage).toBeGreaterThan(0);
    });

    test('should apply all 4 passes', async () => {
      const content = 'objective: Test mission with verbose content';

      const result = await optimizer.optimize(content, {
        model: 'gpt',
        level: 'aggressive',
      });

      expect(result.stats.passesApplied).toHaveLength(4);
      expect(result.stats.passesApplied).toContain('sanitization');
      expect(result.stats.passesApplied).toContain('structural');
      expect(result.stats.passesApplied).toContain('linguistic');
      expect(result.stats.passesApplied).toContain('model-specific');
    });

    test('should preserve tagged content', async () => {
      const content = '<preserve>Critical data that must not change</preserve>\nOther content';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'aggressive',
      });

      expect(result.optimized).toContain('Critical data that must not change');
    });

    test('should handle conservative compression', async () => {
      const content = 'objective: Could you please test this';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'conservative',
      });

      expect(result.level).toBe('conservative');
      expect(result.stats.passesApplied.length).toBeGreaterThan(0);
    });

    test('should handle balanced compression', async () => {
      const content = 'objective: Test mission';

      const result = await optimizer.optimize(content, {
        model: 'gpt',
        level: 'balanced',
      });

      expect(result.level).toBe('balanced');
    });

    test('should handle aggressive compression', async () => {
      const content = 'objective: Test mission with lots of verbose unnecessary filler words';

      const result = await optimizer.optimize(content, {
        model: 'gemini',
        level: 'aggressive',
      });

      expect(result.level).toBe('aggressive');
    });

    test('should support dry run mode', async () => {
      const content = 'objective: Test content';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'balanced',
        dryRun: true,
      });

      // In dry run, optimized should equal original
      expect(result.optimized).toBe(content);
      expect(result.stats).toBeDefined();
    });

    test('should warn if compression outside target range', async () => {
      const content = 'short';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'balanced',
      });

      // Very short content may not achieve 20-30% reduction
      if (result.stats.reductionPercentage < 20 || result.stats.reductionPercentage > 30) {
        expect(result.warnings).toBeDefined();
        expect(result.warnings!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('preview', () => {
    test('should provide preview without modifying content', async () => {
      const content = 'objective: Test mission content';

      const result = await optimizer.preview(content, 'claude', 'balanced');

      expect(result.optimized).toBe(content);
      expect(result.stats).toBeDefined();
    });
  });

  describe('optimizeMission convenience function', () => {
    test('should optimize with default balanced level', async () => {
      const content = 'objective: Test mission';

      const result = await optimizeMission(content, 'claude');

      expect(result.level).toBe('balanced');
      expect(result.stats).toBeDefined();
    });

    test('should accept custom compression level', async () => {
      const content = 'objective: Test mission';

      const result = await optimizeMission(content, 'gpt', 'aggressive');

      expect(result.level).toBe('aggressive');
    });
  });

  describe('Compression statistics', () => {
    test('should calculate reduction percentage correctly', async () => {
      const content = 'objective: Could you please test this verbose content';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'balanced',
      });

      const expectedReduction =
        ((result.stats.originalTokens - result.stats.compressedTokens) /
          result.stats.originalTokens) *
        100;

      expect(result.stats.reductionPercentage).toBeCloseTo(expectedReduction, 1);
    });

    test('should calculate compression ratio correctly', async () => {
      const content = 'objective: Test content';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'balanced',
      });

      const expectedRatio = result.stats.originalTokens / result.stats.compressedTokens;
      expect(result.stats.compressionRatio).toBeCloseTo(expectedRatio, 2);
    });
  });

  describe('Model-specific optimization', () => {
    test('should format for Claude with XML', async () => {
      const content = 'objective: Test mission';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'balanced',
      });

      expect(result.model).toBe('claude');
      expect(result.optimized).toContain('<');
    });

    test('should format for GPT with delimiters', async () => {
      const content = 'objective: Test mission';

      const result = await optimizer.optimize(content, {
        model: 'gpt',
        level: 'balanced',
      });

      expect(result.model).toBe('gpt');
      expect(result.optimized).toContain('###');
    });

    test('should format for Gemini with PTCF', async () => {
      const content = 'objective: Test mission';

      const result = await optimizer.optimize(content, {
        model: 'gemini',
        level: 'balanced',
      });

      expect(result.model).toBe('gemini');
      expect(result.optimized).toContain('Task:');
    });
  });

  describe('Error handling', () => {
    test('should handle errors gracefully', async () => {
      const invalidContent = null as any;

      await expect(
        optimizer.optimize(invalidContent, {
          model: 'claude',
          level: 'balanced',
        })
      ).rejects.toThrow();
    });

    test('wraps pipeline failures with optimization failed message', async () => {
      const content = 'objective: Trigger failure';
      const transpileSpy = jest.spyOn(mockTranspiler, 'transpile').mockImplementation(() => {
        throw new Error('transpile broke');
      });

      await expect(
        optimizer.optimize(content, { model: 'claude', level: 'balanced' })
      ).rejects.toThrow('Optimization failed: transpile broke');

      transpileSpy.mockRestore();
    });
  });

  describe('Custom preserve tags', () => {
    test('should preserve custom tagged sections', async () => {
      const content = '<critical>Must keep this</critical>\nOther content to compress';

      const result = await optimizer.optimize(content, {
        model: 'claude',
        level: 'aggressive',
        preserveTags: ['critical'],
      });

      expect(result.optimized).toContain('Must keep this');
    });
  });

  test('allows overriding ruleset to skip early passes', async () => {
    const result = await optimizer.optimize('Objective: keep text', {
      model: 'gpt',
      level: 'aggressive',
      ruleset: {
        sanitizationRules: [],
        structuralRules: [],
        linguisticRules: [],
      },
    });

    expect(result.stats.passesApplied).toEqual(['model-specific']);
  });
});
