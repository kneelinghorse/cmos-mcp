// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Serves an intentionally empty MCP surface when the operator disables the plugin server.
// ABOUTME: Uses only Node built-ins so cold disabled sessions never require package discovery or installation.
import { createInterface } from 'node:readline';

export async function disabledServer({ input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try {
      if (line.length > 1024 * 1024) throw new Error('Request too large');
      message = JSON.parse(line);
    } catch {
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n'
      );
      continue;
    }
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') &&
        message.id !== null &&
        !['number', 'string'].includes(typeof message.id))
    ) {
      output.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid request' },
        }) + '\n'
      );
      continue;
    }
    if (!Object.hasOwn(message, 'id')) continue;
    let result;
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cmos-plugin-disabled', version: '1.0.0' },
        };
        break;
      case 'tools/list':
        result = { tools: [] };
        break;
      case 'ping':
        result = {};
        break;
      default:
        break;
    }
    const response =
      result === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result };
    output.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response }) + '\n');
  }
}
