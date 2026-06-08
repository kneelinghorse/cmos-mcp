#!/usr/bin/env ts-node
/**
 * Token Count Validation Script
 *
 * Compares offline token counts (from token-counters.ts) against official provider APIs.
 * Used in CI to detect accuracy drift in Claude/Gemini implementations.
 *
 * Environment variables required:
 * - ANTHROPIC_API_KEY: For Claude validation
 * - GOOGLE_GEMINI_API_KEY: For Gemini validation
 *
 * Exit codes:
 * - 0: All validations passed within threshold
 * - 1: One or more validations failed (drift exceeded threshold)
 * - 2: Missing API keys or configuration error
 */

import { TokenCounter } from '../src/intelligence/token-counters';

type ValidatedModel = 'claude' | 'gemini';

interface ValidationResult {
  model: ValidatedModel;
  testCase: string;
  localCount: number;
  providerCount: number;
  drift: number;
  driftPercent: number;
  passed: boolean;
}

// Test cases covering various text lengths and complexities
const TEST_CASES = [
  { name: 'short', text: 'hello world' },
  {
    name: 'medium',
    text: 'The Mission Creation Protocol enables structured, reusable mission templates for AI-assisted development workflows.',
  },
  {
    name: 'long',
    text: `
This mission file represents the master backlog and sprint plan for the Mission Creation Protocol (MCP) project.
It provides a single source of truth for what has been completed, what is in progress, and what is planned.
This structured format allows for automated status tracking and dependency management.

Success criteria include completing all missions within each sprint, from Sprint 1 (Foundation) through Sprint 4 (Intelligence Layer).
Each mission tracks its status, completion timestamp, and notes about the implementation.
`.trim(),
  },
  {
    name: 'code',
    text: `
export async function count(text: string, model: SupportedModel): Promise<TokenCount> {
  switch (model) {
    case 'gpt':
      return this.countGPT(text);
    case 'claude':
      return this.countClaude(text);
    case 'gemini':
      return this.countGemini(text);
    default:
      throw new Error(\`Unsupported model: \${model}\`);
  }
}
`.trim(),
  },
];

// Drift thresholds (percentage)
const THRESHOLDS: Record<ValidatedModel, number> = {
  claude: 50.0, // Claude can drift up to 50% (Transformers.js is unofficial)
  gemini: 100.0, // Gemini uses heuristic, allow up to 100% variance
};

const GEMINI_MODEL_ID = process.env.GOOGLE_GEMINI_MODEL_ID ?? 'models/gemini-2.5-pro';

interface AnthropicCountTokensResponse {
  input_tokens: number;
}

interface GoogleCountTokensResponse {
  totalTokens: number;
}

/**
 * Call Anthropic's official count_tokens API
 */
async function validateClaude(text: string): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

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

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as AnthropicCountTokensResponse;
  return data.input_tokens;
}

/**
 * Call Google's official countTokens API
 */
async function validateGemini(text: string): Promise<number> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY not set');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL_ID}:countTokens?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google API error: ${response.status} ${error}`);
  }

  const data = (await response.json()) as GoogleCountTokensResponse;
  return data.totalTokens;
}

/**
 * Run validation for a single model and test case
 */
async function runValidation(
  counter: TokenCounter,
  model: 'claude' | 'gemini',
  testCase: (typeof TEST_CASES)[0]
): Promise<ValidationResult> {
  const localResult = await counter.count(testCase.text, model);
  const localCount = localResult.count;

  let providerCount: number;
  if (model === 'claude') {
    providerCount = await validateClaude(testCase.text);
  } else {
    providerCount = await validateGemini(testCase.text);
  }

  const drift = Math.abs(localCount - providerCount);
  const driftPercent = (drift / providerCount) * 100;
  const threshold = THRESHOLDS[model];
  const passed = driftPercent <= threshold;

  return {
    model,
    testCase: testCase.name,
    localCount,
    providerCount,
    drift,
    driftPercent,
    passed,
  };
}

/**
 * Main validation runner
 */
async function main() {
  console.log('🔍 Token Count Validation\n');

  const counter = new TokenCounter();
  const results: ValidationResult[] = [];

  // Check for required API keys
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasGoogleKey = !!process.env.GOOGLE_GEMINI_API_KEY;

  if (!hasAnthropicKey && !hasGoogleKey) {
    console.error('❌ No API keys found. Set ANTHROPIC_API_KEY and/or GOOGLE_GEMINI_API_KEY');
    console.error('   See docs/Token_Validation_Setup.md for setup instructions.\n');
    process.exit(2);
  }

  // Run Claude validation if key is available
  if (hasAnthropicKey) {
    console.log('📊 Validating Claude tokenizer...');
    for (const testCase of TEST_CASES) {
      try {
        const result = await runValidation(counter, 'claude', testCase);
        results.push(result);

        const status = result.passed ? '✅' : '❌';
        console.log(
          `  ${status} ${result.testCase.padEnd(8)} | Local: ${result.localCount.toString().padStart(5)} | Provider: ${result.providerCount.toString().padStart(5)} | Drift: ${result.driftPercent.toFixed(1)}%`
        );
      } catch (error) {
        console.error(
          `  ❌ ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(2);
      }
    }
    console.log();
  } else {
    console.log('⚠️  Skipping Claude validation (ANTHROPIC_API_KEY not set)\n');
  }

  // Run Gemini validation if key is available
  if (hasGoogleKey) {
    console.log(`📊 Validating Gemini tokenizer (model: ${GEMINI_MODEL_ID})...`);
    for (const testCase of TEST_CASES) {
      try {
        const result = await runValidation(counter, 'gemini', testCase);
        results.push(result);

        const status = result.passed ? '✅' : '❌';
        console.log(
          `  ${status} ${result.testCase.padEnd(8)} | Local: ${result.localCount.toString().padStart(5)} | Provider: ${result.providerCount.toString().padStart(5)} | Drift: ${result.driftPercent.toFixed(1)}%`
        );
      } catch (error) {
        console.error(
          `  ❌ ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(2);
      }
    }
    console.log();
  } else {
    console.log('⚠️  Skipping Gemini validation (GOOGLE_GEMINI_API_KEY not set)\n');
  }

  // Summary
  const failedResults = results.filter((r) => !r.passed);
  if (failedResults.length > 0) {
    console.log('❌ VALIDATION FAILED\n');
    console.log('The following tests exceeded drift thresholds:');
    for (const result of failedResults) {
      console.log(
        `  - ${result.model}/${result.testCase}: ${result.driftPercent.toFixed(1)}% (threshold: ${THRESHOLDS[result.model]}%)`
      );
    }
    console.log();
    process.exit(1);
  }

  console.log(`✅ All ${results.length} validations passed!\n`);
  process.exit(0);
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(2);
  });
}

export { main as validateTokenCounts };
