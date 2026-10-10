// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Observes the MCP dispatch boundary once, including refusals and protocol exceptions.
// ABOUTME: Request-local project resolution prevents concurrent calls from mixing telemetry files.

import { AsyncLocalStorage } from 'async_hooks';
import * as path from 'path';
import { cmosConfigDir } from './harness-session';
import { appendTelemetry, targetForStore, type TelemetryTarget } from './local-telemetry';
import { currentSessionOwner } from './session-owner';
import { returnedIds, usedIds } from './telemetry-extract';

const scope = new AsyncLocalStorage<{ projectRoot?: string; presentedIds?: readonly string[] }>();

/** Additional typed local IDs in the actual v2 presentation, beside the legacy structured fields. */
export function noteTelemetryPresentedIds(ids: readonly string[]): void {
  const current = scope.getStore();
  if (current) current.presentedIds = ids;
}

/** Called only after the dispatcher resolves a project; this is not a second resolution pass. */
export function noteTelemetryProject(projectRoot: string): void {
  const current = scope.getStore();
  if (current) current.projectRoot = projectRoot;
}

interface Observation {
  readonly name: string;
  readonly args: unknown;
  readonly mode: 'read' | 'write';
  readonly client: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

type McpResult = { isError?: boolean; structuredContent?: unknown };

/** Never changes the tool's result or exception, including when observation itself fails. */
export async function withMcpTelemetry<T extends McpResult>(
  observation: Observation,
  operation: () => Promise<T>
): Promise<T> {
  const local: { projectRoot?: string; presentedIds?: readonly string[] } = {};
  const ts = new Date().toISOString();
  let result: T | undefined;
  let failed = false;
  let protocol = false;
  return scope.run(local, async () => {
    try {
      result = await operation();
      return result;
    } catch (error) {
      failed = true;
      protocol = error !== null && typeof error === 'object' && 'code' in error;
      throw error;
    } finally {
      try {
        const params =
          observation.args && typeof observation.args === 'object'
            ? (observation.args as Record<string, unknown>)
            : {};
        const env = observation.env ?? process.env;
        // Before-resolution refusals can still name a valid explicit store. Never infer cwd or
        // registry attribution here. Project-free calls get a separate, anonymous bucket.
        const root =
          local.projectRoot ??
          (params.acrossProjects !== true && typeof params.projectRoot === 'string'
            ? params.projectRoot
            : undefined);
        const target: TelemetryTarget = (root
          ? targetForStore(path.join(root, 'cmos', 'db', 'cmos.sqlite'))
          : null) ?? {
          projectId: 'unattributed',
          dbPath: path.join(cmosConfigDir(env), 'unattributed.sqlite'),
        };
        const payload = result?.structuredContent;
        const structured =
          payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : undefined;
        const ok = !failed && result?.isError !== true && structured?.success !== false;
        const error = structured?.error as { code?: string } | undefined;
        appendTelemetry(
          {
            ts,
            session: currentSessionOwner(target.dbPath).key,
            surface: 'mcp',
            client: observation.client,
            tool: observation.name,
            action: typeof params.action === 'string' ? params.action : null,
            mode: observation.mode,
            ok,
            refused: ok
              ? null
              : (error?.code ?? (protocol ? 'PROTOCOL_ERROR' : 'TOOL_EXECUTION_ERROR')),
            failOpen: null,
            ambient: null,
            idsReturned: ok
              ? [
                  ...new Set([
                    ...returnedIds(observation.name, params, structured?.data),
                    ...(local.presentedIds ?? []),
                  ]),
                ]
              : [],
            idsCited: ok ? usedIds(observation.name, params, observation.mode, structured) : [],
          },
          target,
          env
        );
      } catch {
        // Best-effort instrumentation must never break an otherwise valid call.
      }
    }
  });
}
