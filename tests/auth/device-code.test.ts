// ABOUTME: Unit tests for the RFC 8628 device code flow — Sprint 57 m01.
// ABOUTME: All dashboard endpoints mocked; covers happy path, slow_down backoff, expired/denied, malformed responses, UA header.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import {
  DeviceCodeError,
  buildUserAgent,
  pollForToken,
  pollForTokenBounded,
  requestDeviceCode,
  runDeviceCodeFlow,
} from '../../src/auth/device-code';
import type {
  BoundedPollStatus,
  DeviceCodeResponse,
  DeviceTokenSuccess,
} from '../../src/auth/device-code';
import { CMOS_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';
import {
  describeLive,
  setUpLiveConfig,
  tearDownLiveConfig,
  type LiveDashboardConfig,
} from './live-dashboard-helper';

const BASE_URL = 'http://dashboard.test';

type FetchArgs = [string | URL | Request, RequestInit?];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchMock(): jest.Mock<typeof fetch> {
  return jest.fn() as unknown as jest.Mock<typeof fetch>;
}

function callsOf(fetchImpl: jest.Mock<typeof fetch>): FetchArgs[] {
  return (fetchImpl as unknown as { mock: { calls: FetchArgs[] } }).mock.calls;
}

describe('buildUserAgent', () => {
  it('produces the agreed "cmos-mcp/<version> (<platform>; <hostname>)" format', () => {
    const ua = buildUserAgent('1.0.0', 'darwin', 'alice-mbp');
    expect(ua).toBe('cmos-mcp/1.0.0 (darwin; alice-mbp)');
  });

  it('defaults platform + hostname from the `os` module', () => {
    const ua = buildUserAgent('9.9.9');
    expect(ua.startsWith('cmos-mcp/9.9.9 (')).toBe(true);
    expect(ua).toContain(os.platform());
    expect(ua).toContain(os.hostname());
  });
});

describe('requestDeviceCode', () => {
  it('POSTs to /api/auth/device/code with the User-Agent header and returns the parsed body', async () => {
    const deviceCodeBody: DeviceCodeResponse = {
      deviceCode: 'dc-123',
      userCode: 'ABCD-1234',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 2,
    };

    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse(deviceCodeBody));

    const result = await requestDeviceCode(BASE_URL, 'cmos-mcp/1.0.0 (darwin; host)', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual(deviceCodeBody);
    expect(callsOf(fetchImpl)).toHaveLength(1);
    const [url, init] = callsOf(fetchImpl)[0];
    expect(String(url)).toBe('http://dashboard.test/api/auth/device/code');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('cmos-mcp/1.0.0 (darwin; host)');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws DeviceCodeError("request_failed") on non-2xx HTTP', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => new Response('nope', { status: 503 }));
    await expect(
      requestDeviceCode(BASE_URL, 'ua', { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({
      name: 'DeviceCodeError',
      code: 'request_failed',
    });
  });

  it('throws DeviceCodeError("malformed_response") when body is missing required fields', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(
      async () => jsonResponse({ deviceCode: 'dc', userCode: 'u' }) // missing verificationUri/expiresIn/interval
    );
    await expect(
      requestDeviceCode(BASE_URL, 'ua', { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('wraps fetch network errors as DeviceCodeError("request_failed")', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => {
      throw new Error('ENOTFOUND dashboard.test');
    });
    await expect(
      requestDeviceCode(BASE_URL, 'ua', { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({
      code: 'request_failed',
      message: expect.stringContaining('ENOTFOUND'),
    });
  });
});

describe('pollForToken', () => {
  it('returns {key,keyId,label} on HTTP 200 success', async () => {
    const success: DeviceTokenSuccess = {
      key: 'cmk_test',
      keyId: 'user-key-1',
      label: 'device: cmos-mcp/1.0.0 (darwin; host) @ 2026-04-17T12:00:00Z',
    };
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse(success));

    const sleeps: number[] = [];
    const result = await pollForToken(BASE_URL, 'dc-1', 'ua', 2, 600, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toEqual(success);
    expect(sleeps).toEqual([2000]); // one sleep of 2s before the poll
    expect(callsOf(fetchImpl)).toHaveLength(1);
    const [url, init] = callsOf(fetchImpl)[0];
    expect(String(url)).toBe('http://dashboard.test/api/auth/device/token');
    expect(JSON.parse(init?.body as string)).toEqual({ deviceCode: 'dc-1' });
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe('ua');
  });

  it('retries at the returned interval while authorization_pending, then succeeds', async () => {
    const success: DeviceTokenSuccess = { key: 'cmk_k', keyId: 'id', label: 'lbl' };
    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse(success));

    const sleeps: number[] = [];
    const result = await pollForToken(BASE_URL, 'dc', 'ua', 3, 600, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toEqual(success);
    // Three sleeps of 3s each (one before each poll).
    expect(sleeps).toEqual([3000, 3000, 3000]);
  });

  it('adds +5s to the interval on slow_down (RFC 8628)', async () => {
    const success: DeviceTokenSuccess = { key: 'k', keyId: 'id', label: 'l' };
    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse({ error: 'slow_down' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'slow_down' }, 400))
      .mockImplementationOnce(async () => jsonResponse(success));

    const sleeps: number[] = [];
    await pollForToken(BASE_URL, 'dc', 'ua', 2, 600, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    // 2s (initial) -> slow_down -> 7s -> pending (no change) -> 7s -> slow_down -> 12s -> success.
    expect(sleeps).toEqual([2000, 7000, 7000, 12000]);
  });

  it('throws DeviceCodeError("expired_token") on expired_token error body', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () =>
      jsonResponse({ error: 'expired_token', error_description: 'user too slow' }, 400)
    );
    await expect(
      pollForToken(BASE_URL, 'dc', 'ua', 1, 600, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async () => {},
      })
    ).rejects.toMatchObject({
      name: 'DeviceCodeError',
      code: 'expired_token',
      description: 'user too slow',
    });
  });

  it('throws DeviceCodeError("access_denied") when the user denies the request', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse({ error: 'access_denied' }, 400));
    await expect(
      pollForToken(BASE_URL, 'dc', 'ua', 1, 600, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async () => {},
      })
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('throws DeviceCodeError("expired_token") when the local deadline elapses before success', async () => {
    const fetchImpl = makeFetchMock();
    // Clock-driven expiry — nowFn jumps past the deadline on the second tick.
    let now = 1_000_000;
    const nowFn = () => now;
    fetchImpl.mockImplementation(async () => jsonResponse({ error: 'authorization_pending' }, 400));

    await expect(
      pollForToken(BASE_URL, 'dc', 'ua', 1, 5 /* expires in 5s */, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async () => {
          now += 6_000; // advance clock past the deadline
        },
        nowFn,
      })
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('rejects unknown RFC error strings as request_failed', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse({ error: 'banana_peel' }, 400));
    await expect(
      pollForToken(BASE_URL, 'dc', 'ua', 1, 600, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async () => {},
      })
    ).rejects.toMatchObject({ code: 'request_failed' });
  });
});

describe('runDeviceCodeFlow', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-code-'));
    delete process.env[CMOS_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('request → prompt → poll → persist to CredentialStore', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const codeResponse: DeviceCodeResponse = {
      deviceCode: 'dc-xyz',
      userCode: 'HELLO-9999',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 2,
    };
    const success: DeviceTokenSuccess = {
      key: 'cmk_live_key',
      keyId: 'user-key-abc',
      label: 'device: cmos-mcp/1.0.0 (darwin; host) @ 2026-04-17T12:00:00Z',
    };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () => jsonResponse(success));

    const prompts: DeviceCodeResponse[] = [];
    const result = await runDeviceCodeFlow({
      baseUrl: BASE_URL,
      version: '1.0.0',
      platform: 'darwin',
      hostname: 'host',
      credentialStore: store,
      prompter: (r) => prompts.push(r),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: async () => {},
    });

    expect(result).toEqual(success);
    expect(prompts).toEqual([codeResponse]);

    const persisted = await store.getUserScopedKey('user-key-abc');
    expect(persisted?.key).toBe('cmk_live_key');
    expect(persisted?.label).toBe(success.label);
    expect(persisted?.issuedAt).toBeTruthy();
    expect(persisted?.lastUsedAt).toBeTruthy();

    // Both calls should carry the cmos-mcp/1.0.0 (darwin; host) User-Agent.
    for (const [, init] of callsOf(fetchImpl)) {
      const headers = init?.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe('cmos-mcp/1.0.0 (darwin; host)');
    }
  });

  it('propagates a terminal DeviceCodeError without persisting anything', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const codeResponse: DeviceCodeResponse = {
      deviceCode: 'dc',
      userCode: 'U',
      verificationUri: 'http://dashboard.test/x',
      expiresIn: 600,
      interval: 1,
    };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () => jsonResponse({ error: 'access_denied' }, 400));

    await expect(
      runDeviceCodeFlow({
        baseUrl: BASE_URL,
        version: '1.0.0',
        platform: 'p',
        hostname: 'h',
        credentialStore: store,
        prompter: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: async () => {},
      })
    ).rejects.toBeInstanceOf(DeviceCodeError);

    expect(await store.listUserScopedKeys()).toEqual({});
  });
});

// ─── pollForTokenBounded (Sprint 59 m04) ────────────────────────────────

describe('pollForTokenBounded', () => {
  /**
   * Build a virtual clock + sleepFn pair so tests can advance time without
   * real waits. `now` ticks forward by whatever the handler sleeps for.
   */
  function virtualClock() {
    let now = 0;
    return {
      nowFn: () => now,
      sleepFn: async (ms: number): Promise<void> => {
        now += ms;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('returns approved immediately on 200', async () => {
    const success: DeviceTokenSuccess = { key: 'cmk_k', keyId: 'k1', label: 'l' };
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse(success));

    const clock = virtualClock();
    const status: BoundedPollStatus = await pollForTokenBounded({
      baseUrl: BASE_URL,
      deviceCode: 'dc',
      userAgent: 'ua',
      intervalSeconds: 2,
      maxWaitSeconds: 30,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    expect(status.status).toBe('approved');
    if (status.status === 'approved') {
      expect(status.key).toBe('cmk_k');
      expect(status.keyId).toBe('k1');
      expect(status.label).toBe('l');
      expect(status.intervalSeconds).toBe(2);
    }
    expect(callsOf(fetchImpl)).toHaveLength(1);
  });

  it('returns pending when the budget runs out before a terminal response', async () => {
    // Three pending responses at interval=5s, maxWait=12s → after 2 sleeps
    // (total 10s) a 3rd sleep of 5s would overshoot 12s → return pending.
    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400));

    const clock = virtualClock();
    const status = await pollForTokenBounded({
      baseUrl: BASE_URL,
      deviceCode: 'dc',
      userAgent: 'ua',
      intervalSeconds: 5,
      maxWaitSeconds: 12,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    expect(status.status).toBe('pending');
    if (status.status === 'pending') {
      expect(status.intervalSeconds).toBe(5);
    }
    expect(callsOf(fetchImpl)).toHaveLength(2);
  });

  it('returns expired on an expired_token 400 response', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse({ error: 'expired_token' }, 400));

    const clock = virtualClock();
    const status = await pollForTokenBounded({
      baseUrl: BASE_URL,
      deviceCode: 'dc',
      userAgent: 'ua',
      intervalSeconds: 2,
      maxWaitSeconds: 30,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    expect(status.status).toBe('expired');
  });

  it('returns denied on access_denied and surfaces the description when present', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () =>
      jsonResponse({ error: 'access_denied', error_description: 'user rejected' }, 400)
    );

    const clock = virtualClock();
    const status = await pollForTokenBounded({
      baseUrl: BASE_URL,
      deviceCode: 'dc',
      userAgent: 'ua',
      intervalSeconds: 2,
      maxWaitSeconds: 30,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    expect(status.status).toBe('denied');
    if (status.status === 'denied') {
      expect(status.description).toBe('user rejected');
    }
  });

  it('honors slow_down by bumping the interval +5s and returning it on pending/approved', async () => {
    const success: DeviceTokenSuccess = { key: 'k', keyId: 'id', label: 'l' };
    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse({ error: 'slow_down' }, 400)) // 2 → 7
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'slow_down' }, 400)) // 7 → 12
      .mockImplementationOnce(async () => jsonResponse(success));

    const clock = virtualClock();
    const status = await pollForTokenBounded({
      baseUrl: BASE_URL,
      deviceCode: 'dc',
      userAgent: 'ua',
      intervalSeconds: 2,
      maxWaitSeconds: 60,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    expect(status.status).toBe('approved');
    if (status.status === 'approved') {
      expect(status.intervalSeconds).toBe(12);
    }
  });

  it('throws DeviceCodeError on a non-RFC HTTP status', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => new Response('nope', { status: 503 }));

    const clock = virtualClock();
    await expect(
      pollForTokenBounded({
        baseUrl: BASE_URL,
        deviceCode: 'dc',
        userAgent: 'ua',
        intervalSeconds: 2,
        maxWaitSeconds: 30,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: clock.sleepFn,
        nowFn: clock.nowFn,
      })
    ).rejects.toBeInstanceOf(DeviceCodeError);
  });

  it('throws DeviceCodeError when a 200 response omits required fields', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => jsonResponse({ key: 'only-a-key' }));

    const clock = virtualClock();
    await expect(
      pollForTokenBounded({
        baseUrl: BASE_URL,
        deviceCode: 'dc',
        userAgent: 'ua',
        intervalSeconds: 2,
        maxWaitSeconds: 30,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepFn: clock.sleepFn,
        nowFn: clock.nowFn,
      })
    ).rejects.toBeInstanceOf(DeviceCodeError);
  });
});

// ─── Live dashboard (Sprint 58 m03) ───────────────────────────────────────
//
// Set CMOS_LIVE_DASHBOARD=1 AND CMOS_DASHBOARD_URL=https://cmos.aquex.ai (or
// another live dashboard) to exercise the real RFC 8628 endpoint. The test
// prints the userCode on stderr — open the verificationUri in a browser
// and approve within ~600s or the code expires. Never run this in CI.

describeLive('runDeviceCodeFlow — live dashboard', () => {
  let config: LiveDashboardConfig;
  let store: CredentialStore;

  beforeEach(async () => {
    config = await setUpLiveConfig('device-code');
    CredentialStore.resetInstance();
    store = await CredentialStore.create({ configDir: config.tempConfigDir });
  });

  afterEach(async () => {
    CredentialStore.resetInstance();
    await tearDownLiveConfig(config);
  });

  it(
    'completes a real device code round-trip and persists a user-scoped key',
    async () => {
      const token = await runDeviceCodeFlow({
        baseUrl: config.baseUrl,
        credentialStore: store,
      });

      expect(token.key).toMatch(/^cmk_/);
      expect(token.keyId).toBeTruthy();
      expect(token.label).toBeTruthy();

      const persisted = await store.getUserScopedKey(token.keyId);
      expect(persisted?.key).toBe(token.key);
      expect(persisted?.label).toBe(token.label);
      expect(persisted?.issuedAt).toBeTruthy();
      expect(persisted?.lastUsedAt).toBeTruthy();
    },
    // Poll deadline is ~600s; give jest 10 minutes before aborting.
    10 * 60 * 1000
  );
});
