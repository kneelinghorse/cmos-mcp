// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — `hook session-start`: link the harness process to its session and inject the record's
// ABOUTME: digest; in a git repo with no store, offer init until declined. The session opens at its first write.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HookDelivery, HookVerbContext } from '../cli';
import { isSameDirectory } from '../intelligence/resolution-policy';
import { isDeclined, linkHarness } from '../tools/cmos/harness-session';
import { hookRuntimeIdentity } from './hook-runtime';
import { captureBaseline, consumeCompactMarker } from './lifecycle-runtime';
import { deliverRecallContext } from './recall-runtime';
import { preparedRenderedContext } from './telemetry';
import { processBusyTimeout } from '../tools/cmos/sqlite-busy';
import { assertStoreReadable, hookStore, resolutionDir } from './core';

/**
 * The command that runs this CLI, as the user's shell would type it: `cmos-mcp` when that is how
 * it was started (a global install or a PATH shim), else node and the bin's path (a plugin's
 * private install, a checkout), so the remedy works however the hook reached it.
 */
export function cliCommand(argv: readonly string[] = process.argv): string {
  const script = argv[1] ?? '';
  if (path.basename(script) === 'cmos-mcp') return 'cmos-mcp';
  const quote = (text: string): string => (/^[\w@%+=:,./-]+$/.test(text) ? text : `"${text}"`);
  return `${quote(argv[0] ?? 'node')} ${quote(script)}`;
}

/** The one line offered in a git repository that has no CMOS record. */
export function initOffer(command: string = cliCommand(), portable = false): string {
  return (
    'No CMOS record in this repository. If the user wants decisions, learnings and next steps ' +
    `kept across sessions, ${portable ? `run \`${command} init\` with their agreement to start one` : '/cmos:init starts one'}; if they decline, run \`${command} ambient off\` ` +
    'here and this offer stops.'
  );
}

/**
 * The root of the git work tree enclosing `start`, or null. The same ceiling as the store walk:
 * `$HOME` is never examined unless the walk started there, so a home directory under version
 * control does not make every folder beneath it a repository.
 */
export function gitWorkTreeRoot(start: string, homeDir: string = os.homedir()): string | null {
  let dir = path.resolve(start);
  const startsAtHome = isSameDirectory(dir, homeDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    if (!startsAtHome && isSameDirectory(parent, homeDir)) return null;
    dir = parent;
  }
}

/**
 * The link comes first and needs no store: it tells the harness's MCP server which conversation it
 * serves, and where (a git repository can gain a store mid-conversation). No session row is written
 * here. The harness session's CMOS session opens at its first write, so
 * a conversation that never uses CMOS leaves nothing in the record (the m01 build critic).
 */
export async function run(ctx: HookVerbContext): Promise<string | HookDelivery | null> {
  const { input, io, resolution } = ctx;
  const rawId = input.session_id?.trim();
  // The link records the conversation's folder: its key applies only in the store enclosing it.
  if (rawId) linkHarness(rawId, input.source, resolutionDir(resolution), io.env);

  const runtime = hookRuntimeIdentity(input, io.env);
  captureBaseline(runtime, io.env, ctx.deadlineAtMs ?? Date.now() + 1000);
  const store = hookStore(resolution);
  if (!store) {
    if (resolution.kind !== 'none' || resolution.contextless) return null;
    const repo = gitWorkTreeRoot(resolution.workingDir);
    return repo && !isDeclined(repo, io.env)
      ? initOffer(undefined, Boolean(ctx.harness && ctx.harness !== 'claude'))
      : null;
  }
  // s93-m06: a session start counts toward a draft's expiry, outside the store, before any digest
  // choice: digest-off silences the digest, not the approval loop.
  if (rawId)
    (await import('./drafts-hook')).onSessionStart(store.dbPath, rawId, input.source, io.env);
  if (ctx.ambient === 'digest-off') return null;
  assertStoreReadable(store.dbPath, processBusyTimeout() ?? 250);
  const text = await (
    await import('./digest')
  ).buildDigest(store.projectRoot, io, ctx.deadlineAtMs);
  const context = preparedRenderedContext(io);
  return {
    deliver: (emit) => {
      if (rawId && context)
        deliverRecallContext(
          {
            dbPath: store.dbPath,
            rawSessionId: rawId,
            env: io.env,
            deadlineAtMs: ctx.deadlineAtMs ?? Date.now() + 1000,
          },
          context,
          emit
        );
      else emit(text);
      if (input.source === 'compact') consumeCompactMarker(runtime, io.env);
    },
  };
}
