import type { SupportedModel } from './types';
import { emitTelemetryInfo, emitTelemetryWarning } from './telemetry';

type GPTEncodeFn = (text: string) => number[];
type ClaudeTokenizer = (text: string) => Promise<{
  input_ids: { data: { length: number } };
}>;

type PreloadModel = Extract<SupportedModel, 'gpt' | 'claude'>;

interface TokenizerStatus {
  ready: boolean;
  attempts: number;
  lastReadyAt?: string;
  lastError?: string;
  lastFailureAt?: string;
}

export interface TokenizerHealthSnapshot {
  updatedAt: string;
  models: Record<PreloadModel, TokenizerStatus>;
  fallbacks: Record<SupportedModel, number>;
}

const SOURCE = 'tokenizer-bootstrap';

const tokenizerStatus: Record<PreloadModel, TokenizerStatus> = {
  gpt: { ready: false, attempts: 0 },
  claude: { ready: false, attempts: 0 },
};

const fallbackCounts: Record<SupportedModel, number> = {
  gpt: 0,
  claude: 0,
  gemini: 0,
};

let gptEncoder: GPTEncodeFn | null = null;
let claudeTokenizer: ClaudeTokenizer | null = null;

let gptLoadPromise: Promise<GPTEncodeFn | null> | null = null;
let claudeLoadPromise: Promise<ClaudeTokenizer | null> | null = null;

type GPTModule = { encode?: unknown };
type ClaudeModule = {
  AutoTokenizer?: { from_pretrained?: (...args: unknown[]) => unknown };
  default?: { AutoTokenizer?: { from_pretrained?: (...args: unknown[]) => unknown } };
};

type ModuleLoader<T> = () => Promise<T>;

let gptModuleLoader: ModuleLoader<GPTModule> | null = null;
let claudeModuleLoader: ModuleLoader<ClaudeModule> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function updateStatus(model: PreloadModel, patch: Partial<TokenizerStatus>): void {
  tokenizerStatus[model] = {
    ...tokenizerStatus[model],
    ...patch,
  };
}

async function loadGPTEncoder(): Promise<GPTEncodeFn | null> {
  if (gptEncoder) {
    updateStatus('gpt', { ready: true });
    return gptEncoder;
  }

  if (!gptLoadPromise) {
    gptLoadPromise = (async () => {
      tokenizerStatus.gpt.attempts += 1;
      try {
        const module = await (gptModuleLoader
          ? gptModuleLoader()
          : (import('gpt-tokenizer') as Promise<GPTModule>));
        const encode = (module as { encode?: unknown }).encode;
        if (typeof encode !== 'function') {
          throw new Error('gpt-tokenizer encode export missing');
        }
        gptEncoder = encode as GPTEncodeFn;
        updateStatus('gpt', {
          ready: true,
          lastReadyAt: nowIso(),
          lastError: undefined,
          lastFailureAt: undefined,
        });
        emitTelemetryInfo(SOURCE, 'GPT tokenizer preloaded', {
          attempts: tokenizerStatus.gpt.attempts,
        });
        return gptEncoder;
      } catch (error) {
        gptEncoder = null;
        const message = errorMessage(error);
        updateStatus('gpt', {
          ready: false,
          lastError: message,
          lastFailureAt: nowIso(),
        });
        emitTelemetryWarning(SOURCE, 'Failed to preload GPT tokenizer', {
          error: message,
          attempts: tokenizerStatus.gpt.attempts,
        });
        return null;
      }
    })().finally(() => {
      gptLoadPromise = null;
    });
  }

  return gptLoadPromise;
}

async function loadClaudeTokenizer(): Promise<ClaudeTokenizer | null> {
  if (claudeTokenizer) {
    updateStatus('claude', { ready: true });
    return claudeTokenizer;
  }

  if (!claudeLoadPromise) {
    claudeLoadPromise = (async () => {
      tokenizerStatus.claude.attempts += 1;
      try {
        const module = await (claudeModuleLoader
          ? claudeModuleLoader()
          : (import('@xenova/transformers') as Promise<ClaudeModule>));
        const autoTokenizer = module.AutoTokenizer ?? module.default?.AutoTokenizer;

        if (!autoTokenizer || typeof autoTokenizer.from_pretrained !== 'function') {
          throw new Error('AutoTokenizer.from_pretrained is not available');
        }

        const tokenizer = (await autoTokenizer.from_pretrained(
          'Xenova/claude-tokenizer'
        )) as ClaudeTokenizer;
        claudeTokenizer = tokenizer;
        updateStatus('claude', {
          ready: true,
          lastReadyAt: nowIso(),
          lastError: undefined,
          lastFailureAt: undefined,
        });
        emitTelemetryInfo(SOURCE, 'Claude tokenizer preloaded', {
          attempts: tokenizerStatus.claude.attempts,
        });
        return tokenizer;
      } catch (error) {
        claudeTokenizer = null;
        const message = errorMessage(error);
        updateStatus('claude', {
          ready: false,
          lastError: message,
          lastFailureAt: nowIso(),
        });
        emitTelemetryWarning(SOURCE, 'Failed to preload Claude tokenizer', {
          error: message,
          attempts: tokenizerStatus.claude.attempts,
        });
        return null;
      }
    })().finally(() => {
      claudeLoadPromise = null;
    });
  }

  return claudeLoadPromise;
}

export async function ensureTokenizersReady(): Promise<void> {
  await Promise.all([loadGPTEncoder(), loadClaudeTokenizer()]);
}

export async function getGPTEncoder(): Promise<GPTEncodeFn | null> {
  const encoder = await loadGPTEncoder();
  return encoder ?? null;
}

export async function getClaudeTokenizerInstance(): Promise<ClaudeTokenizer | null> {
  const tokenizerInstance = await loadClaudeTokenizer();
  return tokenizerInstance ?? null;
}

export function recordTokenizerFallback(model: SupportedModel): void {
  fallbackCounts[model] += 1;
  if (model === 'gpt' || model === 'claude') {
    updateStatus(model, {
      ready: false,
      lastFailureAt: nowIso(),
    });
  }
}

export function getTokenizerHealth(): TokenizerHealthSnapshot {
  return {
    updatedAt: nowIso(),
    models: {
      gpt: { ...tokenizerStatus.gpt },
      claude: { ...tokenizerStatus.claude },
    },
    fallbacks: {
      gpt: fallbackCounts.gpt,
      claude: fallbackCounts.claude,
      gemini: fallbackCounts.gemini,
    },
  };
}

export const __test__ = {
  reset(): void {
    tokenizerStatus.gpt = { ready: false, attempts: 0 };
    tokenizerStatus.claude = { ready: false, attempts: 0 };
    fallbackCounts.gpt = 0;
    fallbackCounts.claude = 0;
    fallbackCounts.gemini = 0;
    gptEncoder = null;
    claudeTokenizer = null;
    gptLoadPromise = null;
    claudeLoadPromise = null;
    gptModuleLoader = null;
    claudeModuleLoader = null;
  },
  setModuleLoaders(loaders: {
    gpt?: ModuleLoader<GPTModule> | null;
    claude?: ModuleLoader<ClaudeModule> | null;
  }): void {
    if (typeof loaders.gpt !== 'undefined') {
      gptModuleLoader = loaders.gpt;
      gptEncoder = null;
      gptLoadPromise = null;
    }
    if (typeof loaders.claude !== 'undefined') {
      claudeModuleLoader = loaders.claude;
      claudeTokenizer = null;
      claudeLoadPromise = null;
    }
  },
  getState(): {
    gptLoaded: boolean;
    claudeLoaded: boolean;
  } {
    return {
      gptLoaded: gptEncoder !== null,
      claudeLoaded: claudeTokenizer !== null,
    };
  },
};
