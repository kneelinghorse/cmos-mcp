/**
 * Additional Token Optimizer Coverage Tests
 */

import { describe, test, expect, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TokenOptimizer } from '../../src/intelligence/token-optimizer';
import { TokenCount } from '../../src/intelligence/types';

class StubTokenCounter {
  private index = 0;
  constructor(private readonly responses: TokenCount[]) {}

  async count(): Promise<TokenCount> {
    const response = this.responses[this.index] ?? this.responses[this.responses.length - 1];
    this.index += 1;
    return response;
  }
}
import * as compressionRules from '../../src/intelligence/compression-rules';

describe('TokenOptimizer extra', () => {
  test('optimizeFile reads file and returns result', async () => {
    const optimizer = new TokenOptimizer();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opt-file-'));
    const filePath = path.join(tmpDir, 'mission.yaml');
    const content = 'objective: Minimal mission for optimizeFile test';
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await optimizer.optimizeFile(filePath, { model: 'gpt', level: 'balanced' });
    expect(result.original).toBe(content);
    expect(result.optimized.length).toBeGreaterThan(0);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('optimizeBatch processes multiple missions and returns map', async () => {
    const optimizer = new TokenOptimizer();
    const missions = [
      { id: 'a', content: 'objective: A' },
      { id: 'b', content: 'objective: B' },
    ];
    const map = await optimizer.optimizeBatch(missions, { model: 'claude', level: 'balanced' });
    expect(map.size).toBe(2);
    expect(map.get('a')!.model).toBe('claude');
  });

  test('warns when reduction is outside 20-30% target', async () => {
    const optimizer = new TokenOptimizer();
    // Short content + templating likely yields small or negative reduction
    const content = 'objective: x';
    const result = await optimizer.optimize(content, { model: 'gemini', level: 'aggressive' });
    // We assert that either warnings exist or reduction is within target
    if (result.stats.reductionPercentage < 20 || result.stats.reductionPercentage > 30) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toMatch(/Compression achieved/);
    }
  });

  test('preserveTags adds custom patterns and restores content', async () => {
    const optimizer = new TokenOptimizer();
    const content = '<keep>Do not touch</keep> Replace this text.';

    const result = await optimizer.optimize(content, {
      model: 'claude',
      level: 'balanced',
      preserveTags: ['keep'],
    });

    expect(result.optimized).toContain('Do not touch');
  });

  test('respects custom ruleset overrides that skip passes', async () => {
    const optimizer = new TokenOptimizer();
    const content = 'objective: structured content?';

    const result = await optimizer.optimize(content, {
      model: 'gpt',
      level: 'balanced',
      ruleset: {
        sanitizationRules: [],
        structuralRules: [],
        linguisticRules: [],
      },
    });

    // Only model-specific templating should run when other rule arrays empty
    expect(result.stats.passesApplied).toEqual(['model-specific']);
  });

  test('wraps errors from sanitization pass', async () => {
    const optimizer = new TokenOptimizer();
    const sanitizeSpy = jest.spyOn(compressionRules, 'applySanitization').mockImplementation(() => {
      throw new Error('sanitization busted');
    });

    await expect(
      optimizer.optimize('content', { model: 'claude', level: 'balanced' })
    ).rejects.toThrow('Optimization failed: sanitization busted');

    sanitizeSpy.mockRestore();
  });

  test('does not emit warnings when reduction within target range', async () => {
    const tokenCounter = new StubTokenCounter([
      { model: 'claude', count: 100, estimatedCost: 1 },
      { model: 'claude', count: 75, estimatedCost: 0.75 },
    ]);
    const transpiler = { transpile: jest.fn((value: string) => value) };
    const optimizer = new TokenOptimizer(tokenCounter as unknown as any, transpiler as any);

    const result = await optimizer.optimize('mission', {
      model: 'claude',
      level: 'balanced',
      ruleset: {
        sanitizationRules: [],
        structuralRules: [],
        linguisticRules: [],
      },
    });

    expect(result.stats.reductionPercentage).toBeCloseTo(25);
    expect(result.warnings).toBeUndefined();
    expect(transpiler.transpile).toHaveBeenCalled();
  });

  test('handles zero compressed token count gracefully', async () => {
    const tokenCounter = new StubTokenCounter([
      { model: 'claude', count: 40, estimatedCost: 0.4 },
      { model: 'claude', count: 0, estimatedCost: 0 },
    ]);
    const optimizer = new TokenOptimizer(
      tokenCounter as unknown as any,
      { transpile: (value: string) => value } as any
    );

    const result = await optimizer.optimize('tiny mission', {
      model: 'claude',
      level: 'balanced',
      ruleset: {
        sanitizationRules: [],
        structuralRules: [],
        linguisticRules: [],
      },
    });

    expect(result.stats.compressedTokens).toBe(0);
    expect(result.stats.compressionRatio).toBeCloseTo(40);
    expect(result.tokenUsage.optimized.count).toBe(0);
  });
});
