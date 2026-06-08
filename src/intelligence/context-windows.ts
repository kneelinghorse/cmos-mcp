import { SupportedModel } from './types';

const MODEL_CONTEXT_WINDOWS = {
  claude: 200000,
  gpt: 128000,
  gemini: 1000000,
} satisfies Record<SupportedModel, number>;

export const DEFAULT_CONTEXT_WINDOW = MODEL_CONTEXT_WINDOWS.claude;

export function getContextWindow(model: SupportedModel): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

export function listContextWindows(): Record<SupportedModel, number> {
  return { ...MODEL_CONTEXT_WINDOWS };
}
