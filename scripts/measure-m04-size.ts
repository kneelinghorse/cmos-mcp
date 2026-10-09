// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reconstruct count-only telemetry records from one project's local transcript day and measure bytes.
// ABOUTME: Uses the shipped serializer in an external temporary config, prints aggregates, and removes every packet.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { classifyAction } from '../src/tools/cmos/action-taxonomy';
import { harnessSessionHash } from '../src/tools/cmos/harness-session';
import {
  appendTelemetry,
  readTelemetryReport,
  targetForStore,
  telemetryDir,
  type TelemetryRecord,
  type TelemetryTarget,
} from '../src/tools/cmos/local-telemetry';
import { returnedIds, usedIds } from '../src/tools/cmos/telemetry-extract';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const counts = {
  malformedLines: 0,
  claudeCalls: 0,
  codexCalls: 0,
  claudeDayFiles: 0,
  codexDayFiles: 0,
  claudeTerminalRows: 0,
  claudeTurns: 0,
  codexTurns: 0,
  claudeCompactions: 0,
  codexCompactions: 0,
  structuredResults: 0,
  unstructuredResults: 0,
  missingResults: 0,
  returnedIds: 0,
  usedIds: 0,
  failedCalls: 0,
};

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? files(file)
      : entry.isFile() && entry.name.endsWith('.jsonl')
        ? [file]
        : [];
  });
}

async function* rows(file: string): AsyncGenerator<Obj> {
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield object(JSON.parse(line));
      } catch {
        counts.malformedLines++;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Decode structured receipts only; rendered prose is never scraped for IDs or copied to telemetry. */
function envelope(value: unknown, depth = 0): Obj | null {
  if (depth > 4) return null;
  if (typeof value === 'string') {
    try {
      return envelope(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  const v = object(value);
  if (typeof v.success === 'boolean') return v;
  if (v.structuredContent) return envelope(v.structuredContent, depth + 1);
  for (const part of array(v.content)) {
    const result = envelope(object(part).text, depth + 1);
    if (result) return result;
  }
  if (typeof v.content === 'string') return envelope(v.content, depth + 1);
  return null;
}

interface Call {
  ts: string;
  session: string;
  client: string;
  tool: string;
  args: Obj;
  result?: unknown;
  transportError?: boolean;
}

function asRecord(call: Call): TelemetryRecord {
  const action = typeof call.args.action === 'string' ? call.args.action : undefined;
  const mode = classifyAction(call.tool, action);
  const structured = envelope(call.result);
  if (call.result === undefined) counts.missingResults++;
  else if (structured) counts.structuredResults++;
  else counts.unstructuredResults++;
  const ok = call.result !== undefined && !call.transportError && structured?.success !== false;
  const returned = ok ? returnedIds(call.tool, call.args, structured?.data) : [];
  const used = ok ? usedIds(call.tool, call.args, mode, structured) : [];
  counts.returnedIds += returned.length;
  counts.usedIds += used.length;
  if (!ok) counts.failedCalls++;
  return {
    ts: call.ts,
    session: `ext:${harnessSessionHash(call.session)}`,
    surface: 'mcp',
    client: call.client,
    tool: call.tool,
    action: action ?? null,
    mode,
    ok,
    refused: ok ? null : text(object(structured?.error).code) || 'TOOL_EXECUTION_ERROR',
    failOpen: null,
    ambient: null,
    idsReturned: returned,
    idsCited: used,
  };
}

async function claude(root: string, day: string): Promise<TelemetryRecord[]> {
  const records: TelemetryRecord[] = [];
  const base = path.join(os.homedir(), '.claude', 'projects');
  const encoded = root.replace(/\//g, '-');
  const selected = fs.readdirSync(base).filter((name) => name.includes(encoded));
  for (const dir of selected)
    for (const file of files(path.join(base, dir))) {
      const calls = new Map<string, Call>();
      const turns = new Set<string>();
      let hadDay = false;
      for await (const row of rows(file)) {
        const inDay = text(row.timestamp).slice(0, 10) === day;
        if (inDay) hadDay = true;
        const message = object(row.message);
        if (
          inDay &&
          row.type === 'assistant' &&
          ['end_turn', 'stop_sequence'].includes(text(message.stop_reason))
        ) {
          counts.claudeTerminalRows++;
          turns.add(text(message.id));
        }
        if (inDay && row.type === 'system' && row.subtype === 'compact_boundary')
          counts.claudeCompactions++;
        for (const blockValue of array(message.content)) {
          const block = object(blockValue);
          if (inDay && block.type === 'tool_use' && /cmos/i.test(text(block.name))) {
            const name = text(block.name).split('__').pop()!;
            calls.set(text(block.id), {
              ts: text(row.timestamp),
              session: text(row.sessionId) || file,
              client: `claude-code/${text(row.version) || 'unknown'}`,
              tool: name,
              args: object(block.input),
            });
          }
          if (block.type === 'tool_result') {
            const call = calls.get(text(block.tool_use_id));
            if (call) {
              call.result = block;
              call.transportError = block.is_error === true;
            }
          }
        }
      }
      if (hadDay) counts.claudeDayFiles++;
      counts.claudeTurns += turns.size;
      counts.claudeCalls += calls.size;
      records.push(...[...calls.values()].map(asRecord));
    }
  return records;
}

async function codex(root: string, day: string): Promise<TelemetryRecord[]> {
  const records: TelemetryRecord[] = [];
  for (const file of files(path.join(os.homedir(), '.codex', 'sessions'))) {
    let metadata: Obj = {};
    for await (const row of rows(file)) {
      metadata = object(row.payload);
      break;
    }
    if (!text(metadata.cwd).includes(path.basename(root))) continue;
    let hadDay = false;
    const turns = new Set<string>();
    for await (const row of rows(file)) {
      if (text(row.timestamp).slice(0, 10) !== day) continue;
      hadDay = true;
      const payload = object(row.payload);
      if (row.type !== 'event_msg') continue;
      if (payload.type === 'task_complete')
        turns.add(text(payload.turn_id) || text(payload.id) || text(row.timestamp));
      if (payload.type !== 'item_completed') continue;
      const item = object(payload.item);
      if (item.type === 'ContextCompaction') counts.codexCompactions++;
      if (item.type !== 'McpToolCall' || !/cmos/i.test(text(item.server))) continue;
      let args = object(item.arguments);
      if (typeof item.arguments === 'string') {
        try {
          args = object(JSON.parse(item.arguments));
        } catch {
          args = {};
        }
      }
      records.push(
        asRecord({
          ts: text(row.timestamp),
          session: text(metadata.id) || file,
          client: `codex/${text(metadata.cli_version) || 'unknown'}`,
          tool: text(item.tool),
          args,
          result: item.result,
          transportError: object(item.result).isError === true,
        })
      );
      counts.codexCalls++;
    }
    if (hadDay) counts.codexDayFiles++;
    counts.codexTurns += turns.size;
  }
  return records;
}

function byteCount(target: TelemetryTarget, env: NodeJS.ProcessEnv): number {
  const dir = telemetryDir(target, env);
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0)
    : 0;
}

function hookSizes(day: string, target: TelemetryTarget, env: NodeJS.ProcessEnv) {
  const ids = Array.from({ length: 100 }, (_, i) => `d:${String(9000000000000000n + BigInt(i))}`);
  const sizes: Record<string, { minimum: number; capped: number }> = {};
  for (const event of ['session-start', 'prompt', 'stop', 'pre-compact', 'session-end']) {
    const base: TelemetryRecord = {
      ts: `${day}T12:00:00.000Z`,
      session: `ext:${'a'.repeat(16)}`,
      surface: 'hook',
      client: 'claude-code',
      tool: `hook ${event}`,
      action: null,
      mode: null,
      ok: true,
      refused: null,
      failOpen: null,
      ambient: 'on',
      charsInjected: 0,
      idsInjected: [],
      ...(event === 'prompt'
        ? { procedurePatternIds: [], ceremony: null, restatedRuleIds: [] }
        : {}),
    };
    let before = byteCount(target, env);
    appendTelemetry(base, target, env);
    const minimum = byteCount(target, env) - before;
    const capped: TelemetryRecord = {
      ...base,
      client: 'c'.repeat(100),
      ok: false,
      refused: 'R'.repeat(80),
      failOpen: 'deadline',
      ambient: 'digest-off',
      ...(event === 'session-start' || event === 'prompt'
        ? {
            idsReturned: ids,
            idsCited: event === 'prompt' ? ids : [],
            idsInjected: ids,
            charsInjected: event === 'session-start' ? 6000 : 1500,
            digestHash: 'f'.repeat(64),
          }
        : {}),
      ...(event === 'prompt'
        ? {
            restatedRuleIds: ids.map((id) => id.replace('d:', 'l:')),
            procedurePatternIds: Array.from(
              { length: 13 },
              (_, i) => `P${String(i + 1).padStart(2, '0')}`
            ),
            ceremony: `/cmos:${'x'.repeat(31)}`,
            ruleReadFailed: true,
          }
        : {}),
    };
    before = byteCount(target, env);
    appendTelemetry(capped, target, env);
    sizes[event] = { minimum, capped: byteCount(target, env) - before };
  }
  return sizes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string): string => {
    const at = args.indexOf(flag);
    return at < 0 ? '' : (args[at + 1] ?? '');
  };
  const root = path.resolve(value('--root'));
  const day = value('--day');
  if (!value('--root') || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error('Pass --root <project> --day YYYY-MM-DD --prompts <count> --sessions <count>');
  const prompts = Number(value('--prompts'));
  const sessions = Number(value('--sessions'));
  if (
    !value('--prompts') ||
    !value('--sessions') ||
    ![prompts, sessions].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error('Pass explicit nonnegative prompt and session projection counts');
  const target = targetForStore(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
  if (!target) throw new Error('The selected project store is unreadable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmos-m04-size-'));
  const env = { ...process.env, CMOS_CONFIG_DIR: temp };
  let output: unknown;
  try {
    const claudeRecords = await claude(root, day);
    const codexRecords = await codex(root, day);
    for (const record of claudeRecords) appendTelemetry(record, target, env);
    const claudeBytes = byteCount(target, env);
    for (const record of codexRecords) appendTelemetry(record, target, env);
    const bytes = byteCount(target, env);
    const replay = readTelemetryReport(target, env);
    if (replay.records.length !== counts.claudeCalls + counts.codexCalls || replay.warnings.length)
      throw new Error('Replay count does not equal serializer output');
    const sizes = hookSizes(
      day,
      { projectId: 'projection', dbPath: path.join(temp, 'projection.sqlite') },
      env
    );
    const compactions = counts.claudeCompactions + counts.codexCompactions;
    const hookCounts: Record<string, number> = {
      'session-start': sessions + compactions,
      prompt: prompts,
      stop: counts.claudeTurns + counts.codexTurns,
      'pre-compact': compactions,
      'session-end': sessions,
    };
    const minimum = Object.entries(hookCounts).reduce(
      (sum, [event, count]) => sum + count * sizes[event].minimum,
      0
    );
    const capped = Object.entries(hookCounts).reduce(
      (sum, [event, count]) => sum + count * sizes[event].capped,
      0
    );
    output = {
      day,
      counts,
      measuredMcp: {
        records: replay.records.length,
        claudeBytes,
        codexBytes: bytes - claudeBytes,
        bytes,
        meanBytes: bytes / replay.records.length,
      },
      projectedHooks: {
        counts: hookCounts,
        recordSizes: sizes,
        records: Object.values(hookCounts).reduce((a, b) => a + b, 0),
        minimumBytes: minimum,
        cappedBytes: capped,
      },
      daily: { minimumBytes: bytes + minimum, cappedBytes: bytes + capped },
      retained: {
        months: 3,
        maximumProjectedDays: 93,
        minimumBytes: 93 * (bytes + minimum),
        cappedBytes: 93 * (bytes + capped),
      },
      serializerPacketOutsideRepo: !temp.startsWith(`${root}${path.sep}`),
      cleaned: true,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  if (fs.existsSync(temp)) throw new Error('Temporary measurement packet was not removed');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

void main().catch(() => {
  process.stderr.write('Size measurement failed; no transcript content was emitted.\n');
  process.exitCode = 1;
});
