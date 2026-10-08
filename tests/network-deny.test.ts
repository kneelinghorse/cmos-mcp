// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m10 — the outbound-network deny blocks and records a non-loopback connection from
// ABOUTME: http and fetch alike, lets loopback through, and honours a per-test opt-in.

import { describe, expect, it, jest } from '@jest/globals';
import http from 'http';
import net, { type AddressInfo } from 'net';

import {
  allowNetworkOrigins,
  connectionDecision,
  takeBlockedAttempts,
} from './helpers/network-deny';

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

describe('s92-m10 — the unit suite denies outbound network by default', () => {
  it('blocks an http request to a non-loopback host, and records it', async () => {
    await expect(get('http://example.com/')).rejects.toThrow(/Blocked outbound network connection/);
    // Consumed here, so this test's afterEach has nothing left to fail on.
    expect(takeBlockedAttempts()).toEqual([{ host: 'example.com', port: 80 }]);
  });

  it('blocks fetch too, which reaches the network through the same socket layer', async () => {
    await expect(fetch('https://cmos.aquex.ai/api/health')).rejects.toThrow();
    expect(takeBlockedAttempts().map((a) => a.host)).toEqual(['cmos.aquex.ai']);
  });

  it('lets a loopback double through', async () => {
    const server = http.createServer((_req, res) => res.end('loopback ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(get(`http://127.0.0.1:${port}/`)).resolves.toBe('loopback ok');
      await expect(get(`http://localhost:${port}/`)).resolves.toBe('loopback ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(takeBlockedAttempts()).toEqual([]);
  });

  it('decides by host and port, and an opted-in origin goes through for this test only', () => {
    expect(connectionDecision([{ host: 'example.com', port: 443 }])).toBe('block');
    expect(connectionDecision([[{ host: 'example.com', port: 443 }, () => undefined]])).toBe(
      'block'
    );
    expect(connectionDecision([443, 'example.com'])).toBe('block');
    expect(connectionDecision([{ host: '127.0.0.1', port: 443 }])).toBe('allow');
    expect(connectionDecision([{ host: '::1', port: 443 }])).toBe('allow');
    expect(connectionDecision([{ path: '/tmp/some.sock' }])).toBe('allow');
    // http hands net its request options with path: null; that is TCP, not a pipe.
    expect(connectionDecision([[{ host: 'example.com', port: 80, path: null }, () => 0]])).toBe(
      'block'
    );
    allowNetworkOrigins(['example.com:443']);
    expect(connectionDecision([{ host: 'example.com', port: 443 }])).toBe('allow');
    expect(connectionDecision([{ host: 'example.com', port: 80 }])).toBe('block');
  });

  it('installs once per process: the copy the next test file loads neither re-wraps nor forks state', () => {
    // Each test file loads its own copy of the helper. A copy that wrapped connect again kept its
    // finished file alive through the wrapper, and the in-band run's heap grew until it ran out.
    let nextFile: typeof import('./helpers/network-deny') | undefined;
    jest.isolateModules(() => {
      nextFile = require('./helpers/network-deny');
    });
    const before = net.Socket.prototype.connect;
    nextFile!.installNetworkDeny();
    expect(net.Socket.prototype.connect).toBe(before);
    // Its opt-in lands in the one shared state, which this file's afterEach clears.
    nextFile!.allowNetworkOrigins(['example.com:443']);
    expect(connectionDecision([{ host: 'example.com', port: 443 }])).toBe('allow');
  });

  it('the opt-in did not outlive the test that made it', () => {
    expect(connectionDecision([{ host: 'example.com', port: 443 }])).toBe('block');
  });
});
