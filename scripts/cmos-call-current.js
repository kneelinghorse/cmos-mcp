#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Calls one CMOS tool through an isolated stdio server from this checkout's current build.
// ABOUTME: Verifies build health before dispatch and closes only the transport it created.

// Usage: node scripts/cmos-call-current.js < request.json
// Input: { "name": "cmos_review", "arguments": { "projectRoot": "/absolute/project" } }
// For hosts that cannot reconnect a stopped MCP server; this does not restart the host's connection.
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (
    !request ||
    typeof request.name !== 'string' ||
    !request.name.trim() ||
    !request.arguments ||
    typeof request.arguments !== 'object' ||
    Array.isArray(request.arguments) ||
    typeof request.arguments.projectRoot !== 'string' ||
    !request.arguments.projectRoot.trim()
  ) {
    throw new Error('Input must name a tool and provide arguments.projectRoot explicitly.');
  }

  const checkout = path.resolve(__dirname, '..');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(checkout, 'dist', 'index.js')],
    cwd: checkout,
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client(
    { name: 'cmos-call-current', version: '1.0.0' },
    {
      capabilities: {},
      supportedProtocolVersions: ['2025-11-25'],
      versionNegotiation: { mode: 'legacy' },
    }
  );
  const cancellation = new AbortController();
  const options = { signal: cancellation.signal };

  try {
    await client.connect(transport, options);
    const preflight = await client.callTool(
      {
        name: 'cmos_agent_onboard',
        arguments: { projectRoot: request.arguments.projectRoot },
      },
      options
    );
    const health = preflight.structuredContent?.data?.serverHealth;
    if (
      preflight.isError === true ||
      preflight.structuredContent?.success !== true ||
      health?.codeIsCurrent !== true ||
      typeof health.startupBuild?.buildHash !== 'string' ||
      !health.startupBuild.buildHash.trim() ||
      health.startupBuild.buildHash !== health.currentBuild?.buildHash
    ) {
      throw new Error(
        'Current build could not be verified from onboard health; requested tool was not called.'
      );
    }

    const result = await client.callTool(
      { name: request.name, arguments: request.arguments },
      options
    );
    process.stdout.write(JSON.stringify(result.structuredContent ?? result) + '\n');
    if (result.isError === true || result.structuredContent?.success === false) {
      process.exitCode = 1;
    }
  } catch (error) {
    // The SDK can retain a request timer after a broken transport; cancellation releases it.
    cancellation.abort();
    throw error;
  } finally {
    // Close even if initialization failed before the client retained its transport.
    await transport.close();
  }
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      success: false,
      error: {
        code: 'CURRENT_BUILD_CALL_FAILED',
        message: error instanceof Error ? error.message : String(error),
        suggestion:
          'Check the request and current build before retrying; inspect any prior receipt.',
      },
    }) + '\n'
  );
  process.exitCode = 1;
});
