// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s80-m01 — shared MCP-over-stdio bootstrap for the first-run E2E and the
// ABOUTME: verify:dist answer-shape gate, so the two never drift on transport setup.

/**
 * Shared stdio bootstrap (s80-m01).
 *
 * Both the published-artifact first-run E2E (`tests/e2e/first-run.e2e.ts`, which
 * packs+installs the tarball) and the answer-shape release gate (`scripts/verify-dist.ts`,
 * which drives the repo `dist/index.js` directly, no pack/install) speak MCP over stdio
 * to a spawned server. This module owns the ONE connection routine + the payload
 * extractors so the two callers cannot drift on transport wiring.
 *
 * Framework-agnostic on purpose: `verify:dist` runs under `ts-node` (no jest `expect`),
 * so nothing here depends on a test runner. `callOk` throws on `isError` rather than
 * asserting.
 *
 * @module tests/e2e/stdio-harness
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Minimal shape of an MCP tool-call result we read from. */
export interface ToolResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: { data?: unknown };
}

/** A connected stdio server + the extractors/drivers bound to its client. */
export interface StdioHarness {
  client: Client;
  transport: StdioClientTransport;
  /** Call a tool, returning the raw result (no error assertion). */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Call a tool and throw if it returns `isError: true`. */
  callOk(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Join every text content part of a result. */
  textOf(res: ToolResult): string;
  /** The structuredContent JSON payload, if present. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dataOf(res: ToolResult): any;
  /** Close the client (swallows teardown errors). */
  close(): Promise<void>;
}

/** Join every text content part of a tool result. */
export function textOf(res: ToolResult): string {
  return (res.content ?? []).map((c) => c.text ?? '').join('\n');
}

/** The structuredContent (JSON digest) of a tool result, if present. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dataOf(res: ToolResult): any {
  return res.structuredContent?.data;
}

/**
 * Spawn `node <serverPath>` and connect an MCP client over stdio. `stderr` is
 * ignored because a clean-room boot can emit an expected `SENDER_UNRESOLVABLE` P0
 * on stderr — asserting clean stderr would flake.
 */
export async function connectStdioServer(opts: {
  serverPath: string;
  cwd: string;
  env: Record<string, string>;
  clientName?: string;
}): Promise<StdioHarness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [opts.serverPath],
    cwd: opts.cwd,
    env: opts.env,
    stderr: 'ignore',
  });
  const client = new Client(
    { name: opts.clientName ?? 'cmos-stdio-harness', version: '0.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);

  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  const callOk = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const res = await callTool(name, args);
    if (res.isError === true) {
      throw new Error(`tool ${name} returned isError=true: ${textOf(res)}`);
    }
    return res;
  };

  const close = async (): Promise<void> => {
    try {
      await client.close();
    } catch {
      /* ignore teardown errors */
    }
  };

  return { client, transport, callTool, callOk, textOf, dataOf, close };
}
