import { describe, it, expect, beforeEach } from '@jest/globals';

// s77-m03: the GPT encoder path + the preload/health apparatus (ensureTokenizersReady /
// getTokenizerHealth / recordTokenizerFallback / per-model status) were excised. What
// remains is the lazy Claude (@xenova) loader — these tests cover that surface.

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

describe('tokenizer-bootstrap (Claude lazy loader)', () => {
  let bootstrap: typeof import('../../src/intelligence/tokenizer-bootstrap');
  let claudeTokenizerFn: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    claudeTokenizerFn = jest.fn(async (text: string) => ({
      input_ids: { data: Array(Math.max(1, Math.ceil(text.length / 3.5))).fill(0) },
    }));

    bootstrap = await import('../../src/intelligence/tokenizer-bootstrap');
    bootstrap.__test__.reset();
  });

  it('lazily loads the Claude tokenizer and reports loaded state', async () => {
    const fromPretrained = jest.fn(async () => claudeTokenizerFn);
    bootstrap.__test__.setModuleLoaders({
      claude: async () => ({ AutoTokenizer: { from_pretrained: fromPretrained } }),
    });

    expect(bootstrap.__test__.getState().claudeLoaded).toBe(false);

    const tokenizer = await bootstrap.getClaudeTokenizerInstance();
    expect(tokenizer).toBe(claudeTokenizerFn);
    expect(bootstrap.__test__.getState().claudeLoaded).toBe(true);
    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });

  it('caches the tokenizer across subsequent calls (single from_pretrained)', async () => {
    const fromPretrained = jest.fn(async () => claudeTokenizerFn);
    bootstrap.__test__.setModuleLoaders({
      claude: async () => ({ AutoTokenizer: { from_pretrained: fromPretrained } }),
    });

    await bootstrap.getClaudeTokenizerInstance();
    await bootstrap.getClaudeTokenizerInstance();

    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });

  it('returns null when the loader throws', async () => {
    bootstrap.__test__.setModuleLoaders({
      claude: async () => {
        throw new Error('network down');
      },
    });

    const tokenizer = await bootstrap.getClaudeTokenizerInstance();
    expect(tokenizer).toBeNull();
    expect(bootstrap.__test__.getState().claudeLoaded).toBe(false);
  });

  it('returns null when AutoTokenizer is missing from the module', async () => {
    bootstrap.__test__.setModuleLoaders({
      claude: async () => ({}),
    });

    const tokenizer = await bootstrap.getClaudeTokenizerInstance();
    expect(tokenizer).toBeNull();
  });

  it('reset() clears the cached tokenizer and loader override', async () => {
    bootstrap.__test__.setModuleLoaders({
      claude: async () => ({ AutoTokenizer: { from_pretrained: async () => claudeTokenizerFn } }),
    });
    await bootstrap.getClaudeTokenizerInstance();
    expect(bootstrap.__test__.getState().claudeLoaded).toBe(true);

    bootstrap.__test__.reset();
    expect(bootstrap.__test__.getState().claudeLoaded).toBe(false);
  });
});
