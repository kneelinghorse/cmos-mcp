import { describe, it, expect, beforeEach } from '@jest/globals';

jest.mock(
  'gpt-tokenizer',
  () => ({
    encode: jest.fn(),
  }),
  { virtual: true }
);

jest.mock(
  '@xenova/transformers',
  () => ({
    __esModule: true,
    AutoTokenizer: {
      from_pretrained: jest.fn(),
    },
  }),
  { virtual: true }
);

describe('tokenizer-bootstrap', () => {
  let bootstrap: typeof import('../../src/intelligence/tokenizer-bootstrap');
  let gptTokenizerMock: { encode: jest.Mock };
  let transformersMock: {
    AutoTokenizer: {
      from_pretrained: jest.Mock;
    };
  };
  let claudeTokenizerFn: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    gptTokenizerMock = jest.requireMock('gpt-tokenizer') as { encode: jest.Mock };
    transformersMock = jest.requireMock('@xenova/transformers') as {
      AutoTokenizer: {
        from_pretrained: jest.Mock;
      };
    };

    claudeTokenizerFn = jest.fn(async (text: string) => ({
      input_ids: { data: Array(Math.max(1, Math.ceil(text.length / 3.5))).fill(0) },
    }));

    gptTokenizerMock.encode.mockImplementation((text: string) =>
      Array(Math.max(1, Math.ceil(text.length / 4))).fill(0)
    );
    transformersMock.AutoTokenizer.from_pretrained.mockImplementation(
      async () => claudeTokenizerFn
    );

    bootstrap = await import('../../src/intelligence/tokenizer-bootstrap');
    bootstrap.__test__.reset();
    bootstrap.__test__.setModuleLoaders({
      gpt: async () => jest.requireMock('gpt-tokenizer'),
      claude: async () => jest.requireMock('@xenova/transformers'),
    });
  });

  it('preloads tokenizers and reports ready status', async () => {
    await bootstrap.ensureTokenizersReady();
    const health = bootstrap.getTokenizerHealth();

    expect(health.models.gpt.ready).toBe(true);
    expect(health.models.claude.ready).toBe(true);
    expect(health.models.gpt.attempts).toBe(1);
    expect(health.models.claude.attempts).toBe(1);
    expect(transformersMock.AutoTokenizer.from_pretrained).toHaveBeenCalledTimes(1);
    expect(claudeTokenizerFn).not.toHaveBeenCalled();
  });

  it('records fallback counts in health snapshot', () => {
    bootstrap.recordTokenizerFallback('gpt');
    bootstrap.recordTokenizerFallback('gemini');
    const health = bootstrap.getTokenizerHealth();

    expect(health.fallbacks.gpt).toBe(1);
    expect(health.fallbacks.gemini).toBe(1);
    expect(health.models.gpt.ready).toBe(false);
  });

  it('allows selectively overriding module loaders', async () => {
    const gptEncode = jest.fn(() => [0, 1, 2]);
    bootstrap.__test__.reset();
    bootstrap.__test__.setModuleLoaders({
      gpt: async () => ({ encode: gptEncode }),
    });

    await bootstrap.ensureTokenizersReady();
    let state = bootstrap.__test__.getState();
    expect(state.gptLoaded).toBe(true);
    const tokenizerFn = jest.fn(async () => ({
      input_ids: { data: { length: 4 } },
    }));
    const fromPretrained = jest.fn(async () => tokenizerFn);

    bootstrap.__test__.setModuleLoaders({
      claude: async () => ({
        AutoTokenizer: {
          from_pretrained: fromPretrained,
        },
      }),
    });

    await bootstrap.ensureTokenizersReady();
    state = bootstrap.__test__.getState();
    expect(state.claudeLoaded).toBe(true);
    expect(fromPretrained).toHaveBeenCalledTimes(1);

    bootstrap.__test__.setModuleLoaders({ gpt: null, claude: null });
    state = bootstrap.__test__.getState();
    expect(state.gptLoaded).toBe(false);
    expect(state.claudeLoaded).toBe(false);
  });

  it('captures failure metadata when preload fails', async () => {
    const originalEncode = gptTokenizerMock.encode;
    const originalLoader = transformersMock.AutoTokenizer.from_pretrained;

    delete (gptTokenizerMock as { encode?: unknown }).encode;
    transformersMock.AutoTokenizer.from_pretrained.mockImplementation(async () => {
      throw new Error('network down');
    });

    try {
      await bootstrap.ensureTokenizersReady();
      const health = bootstrap.getTokenizerHealth();

      expect(health.models.gpt.ready).toBe(false);
      expect(health.models.gpt.lastError).toBe('gpt-tokenizer encode export missing');
      expect(health.models.claude.ready).toBe(false);
      expect(health.models.claude.lastError).toContain('network down');
    } finally {
      gptTokenizerMock.encode = originalEncode;
      transformersMock.AutoTokenizer.from_pretrained = originalLoader;
      bootstrap.__test__.reset();
      bootstrap.__test__.setModuleLoaders({
        gpt: async () => jest.requireMock('gpt-tokenizer'),
        claude: async () => jest.requireMock('@xenova/transformers'),
      });
    }
  });

  it('handles missing AutoTokenizer in override', async () => {
    bootstrap.__test__.reset();
    bootstrap.__test__.setModuleLoaders({
      claude: async () => ({}),
    });

    await bootstrap.ensureTokenizersReady();
    const health = bootstrap.getTokenizerHealth();
    expect(health.models.claude.ready).toBe(false);
    expect(health.models.claude.lastError).toContain('AutoTokenizer');
  });

  it('reuses cached encoders on subsequent calls', async () => {
    const gptEncode = jest.fn(() => [1, 2, 3]);
    const tokenizerFn = jest.fn(async () => ({
      input_ids: { data: { length: 4 } },
    }));
    const fromPretrained = jest.fn(async () => tokenizerFn);

    bootstrap.__test__.reset();
    bootstrap.__test__.setModuleLoaders({
      gpt: async () => ({ encode: gptEncode }),
      claude: async () => ({
        AutoTokenizer: {
          from_pretrained: fromPretrained,
        },
      }),
    });

    await bootstrap.ensureTokenizersReady();
    const firstHealth = bootstrap.getTokenizerHealth();
    await bootstrap.ensureTokenizersReady();
    const secondHealth = bootstrap.getTokenizerHealth();

    expect(firstHealth.models.gpt.attempts).toBe(1);
    expect(secondHealth.models.gpt.attempts).toBe(1);
    expect(secondHealth.models.claude.attempts).toBe(1);
    expect(gptEncode).not.toHaveBeenCalled();
    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });
});
