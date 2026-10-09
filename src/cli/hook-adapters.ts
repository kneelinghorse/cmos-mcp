// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Maps documented native hook fields and injection envelopes onto the shared CLI contract.
// ABOUTME: Missing identities stay missing; foreign transcripts never enter the Claude transcript scanner.

import type { HookEvent } from './core';

export type HookHarness = 'claude' | 'codex' | 'cursor' | 'devin' | 'copilot' | 'vscode';
export type HookFormat = 'claude' | 'cursor' | 'copilot' | 'text';

export function hookHarness(value: string | undefined, event: HookEvent): HookHarness {
  const harness = value ?? 'claude';
  if (!['claude', 'codex', 'cursor', 'devin', 'copilot', 'vscode'].includes(harness))
    throw new Error('Unknown hook harness. Use claude, codex, cursor, devin, copilot or vscode.');
  if (['cursor', 'copilot', 'vscode'].includes(harness) && event !== 'session-start')
    throw new Error(
      `${harness} adapter supports session-start only; use the MCP tools for other work.`
    );
  return harness as HookHarness;
}

export function hookFormat(harness: HookHarness, text: boolean): HookFormat {
  if (text) return 'text';
  return harness === 'cursor' || harness === 'copilot' ? harness : 'claude';
}

export function nativeHookInput(
  input: Record<string, unknown>,
  harness: HookHarness
): Record<string, unknown> {
  if (harness === 'claude') return input;
  const result: Record<string, unknown> = { ...input, transcript_path: undefined };
  // Only Codex documents the latest assistant message on Stop. Other adapters cannot infer it.
  if (harness !== 'codex') result.last_assistant_message = undefined;
  if (harness === 'codex') result.prompt_id = input.turn_id;
  if (harness === 'copilot') result.session_id = input.sessionId;
  if (harness === 'cursor') {
    result.session_id = input.session_id ?? input.conversation_id;
    const roots = input.workspace_roots;
    result.cwd = input.cwd ?? (Array.isArray(roots) && roots.length === 1 ? roots[0] : undefined);
  }
  return result;
}
