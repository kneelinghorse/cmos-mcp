// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — opening and closing a harness session's CMOS sessions from the CLI (`session ensure|close`
// ABOUTME: and SessionEnd). The link itself lives in harness-session.ts, which session start loads alone.

import { withClientAsync } from '../tools/cmos/client';
import { createSuccess } from '../tools/cmos/errors';
import { tableHasColumn } from '../tools/cmos/genesis-columns';
import {
  closeHarnessSession,
  type ClosedSessionReceipt,
} from '../tools/cmos/implicit-session-lifecycle';
import {
  currentSessionOwner,
  resolveCallerSession,
  setExternalSessionOwner,
} from '../tools/cmos/session-owner';

export interface HarnessSession {
  readonly sessionId: string;
  /** False when the harness session writes into an explicit session instead of its own. */
  readonly implicit: boolean;
  /** True when this call opened it. */
  readonly opened: boolean;
}

/**
 * `session ensure`: the session a harness session writes into, opened when it has none: its own
 * explicit session, a keyless explicit one, or its own implicit session (session-owner.ts). Hooks
 * never call it: a harness session's CMOS session opens at its first write, so a conversation that
 * never uses CMOS leaves no row (the m01 build critic). A store no 3.2.0+ server has migrated (no
 * `owner_key` column) is left alone; the server's first write migrates it. Null when nothing could
 * be resolved.
 */
export async function ensureHarnessSession(
  projectRoot: string,
  rawSessionId: string
): Promise<HarnessSession | null> {
  setExternalSessionOwner(rawSessionId);
  const result = await withClientAsync(
    async (client) => {
      if (
        !tableHasColumn(client, 'sessions', 'owner_key') ||
        !tableHasColumn(client, 'sessions', 'implicit')
      ) {
        return createSuccess(null);
      }
      const outcome = resolveCallerSession(client, { open: true, agent: 'harness' });
      if (!outcome.ok || !outcome.session) return createSuccess(null);
      return createSuccess<HarnessSession>({
        sessionId: outcome.session.sessionId,
        implicit: outcome.session.implicit,
        opened: outcome.session.opened,
      });
    },
    { projectRoot, registerProject: false }
  );
  return result.success ? (result.data ?? null) : null;
}

/**
 * SessionEnd and `session close`: close every session the harness session owns, an explicit one it
 * started included. Throws when the store cannot be read, so a hook reports it.
 */
export async function endHarnessSession(
  projectRoot: string,
  rawSessionId: string,
  observations?: string
): Promise<ClosedSessionReceipt[]> {
  setExternalSessionOwner(rawSessionId);
  return closeHarnessSession(projectRoot, currentSessionOwner().key, observations);
}
