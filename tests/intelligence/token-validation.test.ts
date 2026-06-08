/**
 * Tests for token count validation against provider APIs
 *
 * These tests verify that our offline token counters produce counts
 * that are reasonably close to official provider APIs.
 *
 * NOTE: These tests are skipped by default in CI because they require
 * API keys. Enable by setting ENABLE_API_VALIDATION=true in environment.
 */

import { TokenCounter } from '../../src/intelligence/token-counters';
import {
  emitTelemetryWarning,
  registerTelemetryHandler,
  TelemetryEvent,
} from '../../src/intelligence/telemetry';

describe('Token Validation', () => {
  let counter: TokenCounter;
  let telemetryEvents: TelemetryEvent[];

  beforeEach(() => {
    counter = new TokenCounter();
    telemetryEvents = [];

    // Capture telemetry events
    registerTelemetryHandler((event) => {
      telemetryEvents.push(event);
    });
  });

  afterEach(() => {
    registerTelemetryHandler(null);
  });

  describe('Telemetry Instrumentation', () => {
    it('should emit telemetry warning for Gemini heuristic counts', async () => {
      await counter.count('hello world', 'gemini');

      const geminiEvents = telemetryEvents.filter(
        (e) => e.source === 'token-counter' && e.message.includes('Gemini heuristic')
      );

      expect(geminiEvents).toHaveLength(1);
      expect(geminiEvents[0].level).toBe('warning');
      expect(geminiEvents[0].context).toMatchObject({
        safetyFactor: 1.5,
      });
    });

    it('should emit telemetry warning for Claude unofficial tokenizer', async () => {
      await counter.count('hello world', 'claude');

      // Accept either the official tokenizer message or the fallback message
      const claudeEvents = telemetryEvents.filter(
        (e) =>
          e.source === 'token-counter' &&
          (e.message.includes('Claude token count') ||
            e.message.includes('Fallback heuristic used for claude'))
      );

      expect(claudeEvents.length).toBeGreaterThanOrEqual(1);
      expect(claudeEvents[0].level).toBe('warning');
      // Context varies between official tokenizer and fallback
      expect(claudeEvents[0].context).toMatchObject({
        textLength: expect.any(Number),
        estimatedTokens: expect.any(Number),
      });
    });

    it('should NOT emit telemetry for GPT counts (100% accurate)', async () => {
      await counter.count('hello world', 'gpt');

      const gptEvents = telemetryEvents.filter(
        (e) => e.source === 'token-counter' && e.message.includes('GPT')
      );

      expect(gptEvents).toHaveLength(0);
    });

    it('should capture text length and token count in telemetry context', async () => {
      const text = 'This is a test message for telemetry validation.';
      await counter.count(text, 'gemini');

      expect(telemetryEvents[0].context).toMatchObject({
        textLength: text.length,
        estimatedTokens: expect.any(Number),
      });
    });
  });

  describe('Offline Token Counting', () => {
    it('should count GPT tokens without emitting warnings', async () => {
      const result = await counter.count('hello world', 'gpt');

      expect(result.model).toBe('gpt');
      expect(result.count).toBeGreaterThan(0);
      expect(result.estimatedCost).toBeDefined();
    });

    it('should count Claude tokens with drift warning', async () => {
      const result = await counter.count('hello world', 'claude');

      expect(result.model).toBe('claude');
      expect(result.count).toBeGreaterThan(0);
      expect(result.estimatedCost).toBeDefined();

      // Should have emitted telemetry
      expect(telemetryEvents.length).toBeGreaterThan(0);
    });

    it('should count Gemini tokens with heuristic warning', async () => {
      const result = await counter.count('hello world', 'gemini');

      expect(result.model).toBe('gemini');
      expect(result.count).toBeGreaterThan(0);
      expect(result.estimatedCost).toBeDefined();

      // Should have emitted telemetry
      expect(telemetryEvents.length).toBeGreaterThan(0);
    });

    it('should apply 1.5x safety margin to Gemini heuristic', async () => {
      const text = 'test'.repeat(100); // 400 characters
      const result = await counter.count(text, 'gemini');

      // Base estimate: 400/4 = 100 tokens
      // With 1.5x margin: 150 tokens
      expect(result.count).toBeGreaterThanOrEqual(150);
    });
  });

  describe('Provider API Validation (optional)', () => {
    const shouldRunAPITests = process.env.ENABLE_API_VALIDATION === 'true';

    (shouldRunAPITests ? it : it.skip)(
      'should validate Claude counts against Anthropic API',
      async () => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new Error('ANTHROPIC_API_KEY required for API validation tests');
        }

        const text = 'hello world';
        const localResult = await counter.count(text, 'claude');

        // Call Anthropic API
        const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            messages: [{ role: 'user', content: text }],
          }),
        });

        const data = (await response.json()) as { input_tokens: number };
        const providerCount = data.input_tokens;

        // Allow up to 50% drift
        const drift = Math.abs(localResult.count - providerCount);
        const driftPercent = (drift / providerCount) * 100;

        expect(driftPercent).toBeLessThanOrEqual(50);
      }
    );

    (shouldRunAPITests ? it : it.skip)(
      'should validate Gemini counts against Google API',
      async () => {
        const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('GOOGLE_GEMINI_API_KEY required for API validation tests');
        }

        const geminiModelId = process.env.GOOGLE_GEMINI_MODEL_ID ?? 'models/gemini-2.5-pro';

        const text = 'hello world';
        const localResult = await counter.count(text, 'gemini');

        // Call Google API
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1/${geminiModelId}:countTokens?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text }] }],
            }),
          }
        );

        const data = (await response.json()) as { totalTokens: number };
        const providerCount = data.totalTokens;

        // Gemini heuristic should overestimate (safer than underestimating)
        // Allow up to 100% drift
        const drift = Math.abs(localResult.count - providerCount);
        const driftPercent = (drift / providerCount) * 100;

        expect(driftPercent).toBeLessThanOrEqual(100);
        expect(localResult.count).toBeGreaterThanOrEqual(providerCount * 0.9); // Should not severely underestimate
      }
    );
  });
});
