/**
 * TokenCounter offline implementation tests
 * Tests the hybrid offline tokenizer strategy (R2.1)
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../../src/intelligence/telemetry', () => {
  const actual = jest.requireActual(
    '../../src/intelligence/telemetry'
  ) as typeof import('../../src/intelligence/telemetry');
  return {
    ...actual,
    emitTelemetryWarning: jest.fn(),
    emitTelemetryInfo: jest.fn(),
    emitTelemetryError: jest.fn(),
  };
});

// Mock gpt-tokenizer
jest.mock(
  'gpt-tokenizer',
  () => ({
    encode: jest.fn((text: string) => Array(Math.max(1, Math.ceil(text.length / 4))).fill(0)),
  }),
  { virtual: true }
);

// Mock @xenova/transformers for Claude
jest.mock(
  '@xenova/transformers',
  () => ({
    __esModule: true,
    AutoTokenizer: {
      from_pretrained: jest.fn(async () => {
        return async (text: string) => ({
          input_ids: {
            data: Array(Math.max(1, Math.ceil(text.length / 3.5))).fill(0),
          },
        });
      }),
    },
  }),
  { virtual: true }
);

let telemetryWarningMock: jest.MockedFunction<
  typeof import('../../src/intelligence/telemetry').emitTelemetryWarning
>;

type TokenCounterClass = typeof import('../../src/intelligence/token-counters').TokenCounter;

let TokenCounter: TokenCounterClass;
let tokenCounter: InstanceType<TokenCounterClass>;
let transformersMock: {
  AutoTokenizer: {
    from_pretrained: jest.Mock;
  };
};
let gptTokenizerMock: {
  encode: jest.Mock;
};
let bootstrapTestUtils: { reset: () => void } | undefined;
let getTokenizerHealth:
  | typeof import('../../src/intelligence/tokenizer-bootstrap').getTokenizerHealth
  | undefined;
let ensureTokenizersReady:
  | typeof import('../../src/intelligence/tokenizer-bootstrap').ensureTokenizersReady
  | undefined;

describe('TokenCounter offline implementation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getTokenizerHealth = undefined;
    ensureTokenizersReady = undefined;
    jest.isolateModules(() => {
      ({ TokenCounter } = require('../../src/intelligence/token-counters'));
      const bootstrapModule = require('../../src/intelligence/tokenizer-bootstrap');
      bootstrapTestUtils = bootstrapModule.__test__;
      getTokenizerHealth = bootstrapModule.getTokenizerHealth;
      ensureTokenizersReady = bootstrapModule.ensureTokenizersReady;
    });
    bootstrapTestUtils?.reset();
    tokenCounter = new TokenCounter();
    transformersMock = jest.requireMock('@xenova/transformers') as {
      AutoTokenizer: {
        from_pretrained: jest.Mock;
      };
    };
    gptTokenizerMock = jest.requireMock('gpt-tokenizer') as {
      encode: jest.Mock;
    };
    telemetryWarningMock = require('../../src/intelligence/telemetry')
      .emitTelemetryWarning as jest.MockedFunction<
      typeof import('../../src/intelligence/telemetry').emitTelemetryWarning
    >;
    gptTokenizerMock.encode.mockImplementation((text: unknown) =>
      Array(Math.max(1, Math.ceil(String(text ?? '').length / 4))).fill(0)
    );
    transformersMock.AutoTokenizer.from_pretrained.mockImplementation(async () => {
      return async (text: string) => ({
        input_ids: {
          data: Array(Math.max(1, Math.ceil(text.length / 3.5))).fill(0),
        },
      });
    });
  });

  test('GPT uses gpt-tokenizer (offline)', async () => {
    const result = await tokenCounter.count('hello world', 'gpt');
    expect(result.model).toBe('gpt');
    expect(result.count).toBeGreaterThan(0);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  test('Claude uses Transformers.js (offline)', async () => {
    const result = await tokenCounter.count('hello world', 'claude');
    expect(result.model).toBe('claude');
    expect(result.count).toBeGreaterThan(0);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  test('Gemini uses enhanced heuristic (1.5x safety margin)', async () => {
    const text = 'hello world'; // 11 chars
    const result = await tokenCounter.count(text, 'gemini');
    expect(result.model).toBe('gemini');
    // Should be Math.ceil(11/4 * 1.5) = Math.ceil(4.125) = 5
    expect(result.count).toBe(5);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  test('GPT falls back to heuristic on library failure', async () => {
    gptTokenizerMock.encode.mockImplementationOnce(() => {
      throw new Error('Library not available');
    });

    const result = await tokenCounter.count('test text', 'gpt');
    expect(result.model).toBe('gpt');
    expect(result.count).toBeGreaterThan(0);
  });

  test('Unsupported model throws error', async () => {
    await expect(tokenCounter.count('test', 'unknown' as any)).rejects.toThrow('Unsupported model');
  });

  test('Cost estimation is proportional to token count', async () => {
    const result1 = await tokenCounter.count('short', 'gpt');
    const result2 = await tokenCounter.count(
      'This is a much longer text that should result in more tokens and higher cost',
      'gpt'
    );

    expect(result2.count).toBeGreaterThan(result1.count);
    expect(result2.estimatedCost).toBeGreaterThan(result1.estimatedCost!);
  });

  test('Claude tokenizer is cached between invocations', async () => {
    expect(ensureTokenizersReady).toBeDefined();
    await ensureTokenizersReady?.();
    expect(transformersMock.AutoTokenizer.from_pretrained).toBeDefined();
    transformersMock.AutoTokenizer.from_pretrained.mockClear();

    await tokenCounter.count('first run', 'claude');
    await tokenCounter.count('second run', 'claude');
    expect(transformersMock.AutoTokenizer.from_pretrained).not.toHaveBeenCalled();
  });

  test('Claude path uses cached tokenizer when available', async () => {
    (TokenCounter as unknown as { claudeTokenizerCache: unknown }).claudeTokenizerCache = async (
      text: string
    ) => ({
      input_ids: { data: Array(Math.max(1, Math.ceil(text.length / 5))).fill(0) },
    });

    const result = await tokenCounter.count('cached tokenizer', 'claude');

    expect(result.model).toBe('claude');
    expect(result.count).toBeGreaterThan(0);
  });

  test('Claude falls back when tokenizer fails to load', async () => {
    transformersMock.AutoTokenizer.from_pretrained.mockImplementationOnce(async () => {
      throw new Error('network down');
    });

    const result = await tokenCounter.count('fallback path', 'claude');

    expect(result.model).toBe('claude');
    expect(result.count).toBeGreaterThan(0);
  });
});
