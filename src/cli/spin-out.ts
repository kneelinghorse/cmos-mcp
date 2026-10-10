// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Spin-out accepts two explicit roots and defaults to a read-only JSON preview.
// ABOUTME: Validate selectors before resolving telemetry or opening any store; ambient routing is absent.
import path from 'path';
import { parseArgs, type CliIo } from './core';
import { CliTelemetry } from './telemetry';
import { spinOut } from '../tools/cmos/spin-out';

export async function runSpinOut(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { flags, positional } = parseArgs(argv);
    const allowed = [
      'from',
      'to',
      'sprint',
      'missions',
      'decisions',
      'learnings',
      'next-steps',
      'apply',
    ];
    const seen = new Set<string>();
    for (const arg of argv.filter((value) => value.startsWith('--'))) {
      const flag = arg.slice(2).split('=')[0];
      if (!allowed.includes(flag) || seen.has(flag))
        throw new Error(`Unknown or repeated --${flag}`);
      seen.add(flag);
    }
    if (
      positional.length ||
      !flags.from ||
      flags.from === 'true' ||
      !flags.to ||
      flags.to === 'true'
    )
      throw new Error(
        'Supply --from <root> and --to <root>, plus exactly one --sprint <id> or --missions <comma-separated ids>.'
      );
    if (flags.apply !== undefined && flags.apply !== 'true')
      throw new Error('--apply is a boolean flag; omit it for a dry run.');
    const list = (key: string): string[] | undefined =>
      flags[key] === undefined ? undefined : flags[key].split(',').map((s) => s.trim());
    const ids = (key: string): number[] | undefined => {
      const values = list(key);
      if (values?.some((s) => !/^[1-9]\d*$/.test(s)))
        throw new Error(`--${key} requires comma-separated positive integers`);
      return values?.map(Number);
    };
    const from = path.resolve(io.cwd, flags.from);
    const to = path.resolve(io.cwd, flags.to);
    const telemetry = new CliTelemetry(io, 'spin-out', ['--project-root', from]);
    telemetry.patch({ mode: flags.apply === 'true' ? 'write' : 'read' });
    let code = 1;
    try {
      const result = await spinOut({
        from,
        to,
        sprintId: flags.sprint,
        missionIds: list('missions'),
        decisionIds: ids('decisions'),
        learningIds: ids('learnings'),
        nextStepIds: ids('next-steps'),
        apply: flags.apply === 'true',
        env: io.env,
      });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      code = result.success ? 0 : 1;
      return code;
    } finally {
      telemetry.finish(code);
    }
  } catch (error) {
    io.stderr(`cmos-mcp spin-out: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
