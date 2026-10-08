// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m10 — the unit suite's outbound-network deny: any TCP connection to a host that is not
// ABOUTME: loopback fails, and fails its test, unless that test opted in to the origin.

/**
 * WHY (feedback #44, next-step #588): a test that reaches the network is slow, flaky and can touch
 * production — the s70 checkpoint sync once uploaded throwaway fixtures to the live dashboard.
 * Code under test usually swallows network errors (fire-and-forget sync, fail-quiet dashboard
 * reads), so blocking alone would be silent. Each blocked attempt is therefore recorded, and the
 * `afterEach` installed by tests/jest-setup-network-deny.ts fails the test that made it.
 *
 * HOW: every TCP client in Node — `http`, `https`, `tls`, and `fetch` (undici) — opens its
 * connection through `net.Socket.prototype.connect`. The patch lets loopback hosts and Unix
 * sockets through (local test doubles), lets an origin a test opted into through, and otherwise
 * destroys the socket with an error on the next tick, so the caller sees an ordinary connection
 * failure.
 *
 * OPT-IN: `allowNetworkOrigins(['host:port'])` in a test or its `beforeEach`; the list is cleared
 * after every test. `CMOS_LIVE_DASHBOARD=1` (the deliberate live-dashboard runs) disables the deny.
 *
 * NOT COVERED: child processes (a spawned server opens its own sockets; the packed-tarball E2E lane
 * owns those) and raw UDP, which no code here uses.
 */

import net from 'net';

export interface BlockedAttempt {
  host: string;
  port: number | string | undefined;
}

/**
 * ONE PATCH AND ONE STATE PER PROCESS. jest gives each test file a fresh module registry but shares
 * Node's core modules across an in-band run, so a per-file install wrapped connect once per file:
 * 256 nested wrappers, each a function of its file's sandbox, which kept every finished test file
 * alive (the in-band run then exhausted a 2 GB heap, as CI's does). The patch is installed once,
 * marked on the shared prototype, and its state lives on the shared `net` module object.
 */
const STATE_KEY = Symbol.for('cmos-mcp.tests.network-deny.state');
const PATCHED_KEY = Symbol.for('cmos-mcp.tests.network-deny.patched');

interface DenyState {
  blocked: BlockedAttempt[];
  allowed: Set<string>;
}

function denyState(): DenyState {
  const holder = net as unknown as Record<symbol, DenyState | undefined>;
  let state = holder[STATE_KEY];
  if (!state) {
    state = { blocked: [], allowed: new Set<string>() };
    holder[STATE_KEY] = state;
  }
  return state;
}

const LOOPBACK = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1', '0.0.0.0', '::']);

function isLoopback(host: string | undefined): boolean {
  if (host === undefined || host === '') return true; // net defaults an absent host to localhost
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK.has(bare) || /^127\./.test(bare) || bare === '::ffff:127.0.0.1';
}

/** The connection target of a `Socket#connect` call, in any of its argument shapes. */
function targetOf(args: unknown[]): { host?: string; port?: number | string; path?: string } {
  let first = args[0];
  // net.createConnection / http / tls / undici pass a normalized [options, callback] array.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const options = first as {
      host?: string;
      hostname?: string;
      port?: number | string;
      path?: string;
    };
    return { host: options.host ?? options.hostname, port: options.port, path: options.path };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first };
  return {
    port: first as number | string,
    host: typeof args[1] === 'string' ? args[1] : undefined,
  };
}

/** Whether a `Socket#connect` call with these arguments may proceed. */
export function connectionDecision(args: unknown[]): 'allow' | 'block' {
  const target = targetOf(args);
  return process.env.CMOS_LIVE_DASHBOARD === '1' ||
    // A pipe exactly when net would use one: a non-empty string path (http passes path: null).
    (typeof target.path === 'string' && target.path !== '') ||
    isLoopback(target.host) ||
    denyState().allowed.has(`${target.host}:${target.port}`)
    ? 'allow'
    : 'block';
}

export function installNetworkDeny(): void {
  const proto = net.Socket.prototype as unknown as Record<symbol, boolean | undefined>;
  if (proto[PATCHED_KEY]) return;
  proto[PATCHED_KEY] = true;
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    if (connectionDecision(args) === 'allow') {
      return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    }
    const target = targetOf(args);
    const origin = `${target.host}:${target.port}`;
    denyState().blocked.push({ host: target.host ?? '', port: target.port });
    const error = Object.assign(
      new Error(
        `Blocked outbound network connection to ${origin} from a test (tests/helpers/network-deny.ts). ` +
          'Use a loopback double, or opt in with allowNetworkOrigins([...]).'
      ),
      { code: 'ECONNREFUSED' }
    );
    process.nextTick(() => this.destroy(error));
    return this;
  } as typeof net.Socket.prototype.connect;
}

/** Let these origins (`host:port`) through for the current test only. */
export function allowNetworkOrigins(origins: readonly string[]): void {
  for (const origin of origins) denyState().allowed.add(origin);
}

/** The attempts blocked since the last call, and forget them. */
export function takeBlockedAttempts(): BlockedAttempt[] {
  const { blocked } = denyState();
  return blocked.splice(0, blocked.length);
}

export function clearAllowedOrigins(): void {
  denyState().allowed.clear();
}
