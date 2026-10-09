// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — `hook session-end`: mark the harness link ended and close the harness session's sessions.
// ABOUTME: Never prints: Claude Code discards SessionEnd output. A close that fails is reported, not dropped.

import type { HookVerbContext } from '../cli';
import { unlinkHarness } from '../tools/cmos/harness-session';
import { hookRuntimeIdentity } from './hook-runtime';
import { cleanupLifecycle, gitObservations } from './lifecycle-runtime';
import { CliStoreError, hookStore } from './core';

export async function run(ctx: HookVerbContext): Promise<null> {
  const rawId = ctx.input.session_id?.trim();
  if (!rawId) return null;
  // The link first: it is quick, and a close cut short by the deadline is finished by reconcile.
  unlinkHarness(rawId, ctx.io.env);
  const runtime = hookRuntimeIdentity(ctx.input, ctx.io.env);
  const store = hookStore(ctx.resolution);
  if (!store) {
    cleanupLifecycle(runtime, ctx.io.env);
    return null;
  }
  // s93-m06: the operator's words, offers and window for this session go first; nothing in them
  // outlives the session.
  (await import('./drafts-hook')).onSessionEnd(store.dbPath, rawId, ctx.io.env);
  const ops = await import('./harness-ops');
  if (Date.now() >= (ctx.deadlineAtMs ?? Infinity))
    throw new Error('session-end deadline exceeded');
  let receipts;
  try {
    const observations = gitObservations(runtime, ctx.io.env, ctx.deadlineAtMs ?? Date.now() + 500);
    if (Date.now() >= (ctx.deadlineAtMs ?? Infinity))
      throw new Error('session-end deadline exceeded');
    receipts = await ops.endHarnessSession(store.projectRoot, rawId, observations);
  } catch (error) {
    throw new CliStoreError(error instanceof Error ? error.message : String(error));
  }
  const failed = receipts.find((receipt) => !receipt.closed);
  if (failed) {
    throw new CliStoreError(
      `session ${failed.sessionId} was left open: ${failed.error ?? 'unknown'}`
    );
  }
  cleanupLifecycle(runtime, ctx.io.env);
  return null;
}
