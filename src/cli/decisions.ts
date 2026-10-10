// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Record shaped decisions from the CLI through the same validated MCP handler.
// ABOUTME: Require the existing harness owner and parse arrays without inventing approval evidence.

import type { CliIo } from './core';
import { NO_SESSION_REMEDY } from './commands';
import { observeCliResult } from './telemetry';
import { captureToolCall } from '../tools/cmos/tool-call-context';
import { setExternalSessionOwner } from '../tools/cmos/session-owner';
import { cmosDecisions, formatDecisionsForLLM } from '../tools/cmos/cmos-decisions';
import type { CmosDecisionsParams } from '../tools/cmos/cmos-decisions';

export async function decisions(
  projectRoot: string,
  positional: readonly string[],
  flags: Readonly<Record<string, string>>,
  io: CliIo
): Promise<number> {
  if (positional[0] !== 'record') {
    io.stderr('cmos-mcp decisions: use record --session-id <id> --content <headline>.');
    return 1;
  }
  if (!flags['session-id'] || flags['session-id'] === 'true') {
    io.stderr(`cmos-mcp decisions record: ${NO_SESSION_REMEDY}.`);
    return 1;
  }
  if (!flags.content || flags.content === 'true') {
    io.stderr('cmos-mcp decisions record: pass --content <headline>.');
    return 1;
  }
  const args: Record<string, unknown> = { action: 'record', content: flags.content, projectRoot };
  for (const name of ['context', 'consequences', 'mode', 'domain'] as const) {
    if (flags[name] !== undefined) args[name] = flags[name];
  }
  for (const name of ['alternatives', 'deciders'] as const) {
    if (flags[name] === undefined) continue;
    try {
      args[name] = JSON.parse(flags[name]);
    } catch {
      io.stderr(`cmos-mcp decisions record: --${name} must be a JSON array of strings.`);
      return 1;
    }
  }
  if (flags.mission) args.missionId = flags.mission;
  if (flags.sprint) args.sprintId = flags.sprint;
  setExternalSessionOwner(flags['session-id']);
  const result = await captureToolCall('write', () => cmosDecisions(args as CmosDecisionsParams));
  observeCliResult(io, 'cmos_decisions', args, result.value);
  io.stdout(
    `${flags.format === 'json' ? JSON.stringify(result.value) : formatDecisionsForLLM('record', result.value)}\n`
  );
  return result.value.success ? 0 : 1;
}
