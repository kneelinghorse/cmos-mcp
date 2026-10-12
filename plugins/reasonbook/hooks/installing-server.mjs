// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Answers cold MCP startup before installation and proxies the validated server once ready.
// ABOUTME: Preserves the client's metadata and capabilities; Codex needs a new session to refresh its tools.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { findReady } from './install-state.mjs';

export async function installingServer(
  ctx,
  {
    env = process.env,
    input = process.stdin,
    output = process.stdout,
    writeError = (text) => process.stderr.write(text),
    startInstaller,
    resolveReady = () => findReady(ctx, env),
    pollMs = 500,
    installTimeoutMs = 5 * 60_000,
  } = {}
) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const initializationId = `rbook-bootstrap-${randomUUID()}`;
  let initialization;
  let clientReady = false;
  let child;
  let childLines;
  let ready = false;
  let finished = false;
  let handshakeTimer;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const send = (value) => output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const forward = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  function finish(code = 0) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(installTimer);
    clearTimeout(handshakeTimer);
    lines.close();
    input.pause();
    childLines?.close();
    child?.kill('SIGTERM');
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    resolveDone(code);
  }
  function fail(error) {
    writeError(
      `Reasonbook server unavailable: ${error.message}; start a new session after fixing the installation.\n`
    );
    finish(1);
  }
  const onSignal = () => finish();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const timer = setInterval(() => {
    if (finished || child || !initialization || !clientReady) return;
    try {
      const installed = resolveReady();
      if (!installed) return;
      clearTimeout(installTimer);
      child = spawn(process.execPath, [installed.cliPath, 'serve'], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      child.once('error', fail);
      child.stdin.on('error', fail);
      child.once('exit', (code, signal) => {
        if (!finished) fail(new Error(`installed server exited ${code ?? signal}`));
      });
      childLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      childLines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.id === initializationId) {
            if (message.error || !message.result)
              throw new Error(message.error?.message || 'installed server handshake failed');
            clearTimeout(handshakeTimer);
            forward({ jsonrpc: '2.0', method: 'notifications/initialized' });
            ready = true;
            send({ method: 'notifications/tools/list_changed' });
            return;
          }
          send(message);
        } catch (error) {
          fail(error);
        }
      });
      handshakeTimer = setTimeout(
        () => fail(new Error('installed server handshake timed out')),
        30_000
      );
      forward({
        jsonrpc: '2.0',
        id: initializationId,
        method: 'initialize',
        params: initialization,
      });
    } catch (error) {
      fail(error);
    }
  }, pollMs);
  const installTimer = setTimeout(
    () => fail(new Error('installation timed out; check Node, npm and registry connectivity')),
    installTimeoutMs
  );
  lines.on('line', (line) => {
    try {
      if (line.length > 1024 * 1024) throw new Error('request exceeds 1 MiB');
      const message = JSON.parse(line);
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        message.jsonrpc !== '2.0'
      ) {
        send({ id: null, error: { code: -32600, message: 'Invalid request' } });
        return;
      }
      if (ready || (child && ('result' in message || 'error' in message))) {
        forward(message);
        return;
      }
      if (message.method === 'notifications/initialized') clientReady = true;
      if (!Object.hasOwn(message, 'id')) return;
      let result;
      if (message.method === 'initialize') {
        initialization = message.params;
        result = {
          protocolVersion: message.params?.protocolVersion || '2025-06-18',
          capabilities: {
            tools: { listChanged: true },
            prompts: {},
            experimental: { 'codex/sandbox-state-meta': {} },
          },
          serverInfo: { name: 'rbook-installing', version: ctx.version },
          instructions:
            'Reasonbook is installing in the background. Start a new session once installation finishes to load the project tools.',
        };
      } else if (message.method === 'tools/list') result = { tools: [] };
      else if (message.method === 'prompts/list') result = { prompts: [] };
      else if (message.method === 'ping') result = {};
      send(
        result === undefined
          ? {
              id: message.id,
              error: {
                code: -32002,
                message:
                  'Reasonbook is installing; start a new session once installation finishes.',
              },
            }
          : { id: message.id, result }
      );
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
  });
  lines.once('close', () => finish());
  try {
    const worker = startInstaller(ctx, env);
    worker?.once('error', fail);
    worker?.once('exit', (code, signal) => {
      if (!finished && (code !== 0 || signal))
        fail(
          new Error(`installer exited ${code ?? signal}; check Node, npm and registry connectivity`)
        );
    });
  } catch (error) {
    fail(error);
  }
  return done;
}
