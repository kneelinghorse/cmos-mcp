import {
  DEFAULT_CONTEXT_WINDOW,
  getContextWindow,
  listContextWindows,
} from '../../src/intelligence/context-windows';
import { SupportedModel } from '../../src/intelligence/types';

describe('context windows', () => {
  it('returns configured context windows for supported models', () => {
    expect(getContextWindow('claude')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow('gpt')).toBeGreaterThan(0);
    expect(getContextWindow('gemini')).toBeGreaterThan(getContextWindow('gpt'));
  });

  it('falls back to the default context window for unknown models', () => {
    const fallback = getContextWindow('unknown' as SupportedModel);
    expect(fallback).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('provides a defensive copy of the model windows map', () => {
    const windows = listContextWindows();
    windows.claude = 1 as unknown as number;

    const freshWindows = listContextWindows();
    expect(freshWindows.claude).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
