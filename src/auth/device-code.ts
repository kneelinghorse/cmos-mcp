// ABOUTME: RFC 8628 device code client for cmos-dashboard bootstrap auth.
// ABOUTME: Thin request + poll loop + User-Agent helper; orchestrator persists into CredentialStore.

/**
 * Device code flow (RFC 8628) against the cmos-dashboard.
 *
 * Contract locked 2026-04-17 (dashboard message `aa02f1ec`):
 * - `POST /api/auth/device/code` → `{ deviceCode, userCode, verificationUri, expiresIn, interval }`
 * - `POST /api/auth/device/token` body `{ deviceCode }`:
 *     - HTTP 200 + `{ key, keyId, label }` on approval
 *     - HTTP 400 + `{ error, error_description? }` where
 *       `error ∈ { authorization_pending, slow_down, expired_token, access_denied }`
 *   Strict RFC 8628 shape — all errors at HTTP 400.
 * - User-Agent on both endpoints: `cmos-mcp/<version> (<platform>; <hostname>)` so
 *   the dashboard can auto-populate a human-readable label on issuance.
 *
 * @module auth/device-code
 */

import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { CredentialStore } from '../intelligence/credential-store';
import type { UserScopedKeyRecord } from '../intelligence/credential-store';

/** Response from `POST /api/auth/device/code`. */
export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until `deviceCode` expires. */
  expiresIn: number;
  /** Seconds between successive polls (baseline; slow_down adds to it). */
  interval: number;
}

/** Successful token body returned by `POST /api/auth/device/token`. */
export interface DeviceTokenSuccess {
  key: string;
  keyId: string;
  label: string;
}

/** RFC 8628 error code strings returned by the token endpoint. */
export type DeviceCodeErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied';

/** Typed error covering the four RFC 8628 strings plus transport failures. */
export class DeviceCodeError extends Error {
  public readonly code: DeviceCodeErrorCode | 'request_failed' | 'malformed_response';
  public readonly description?: string;

  constructor(code: DeviceCodeError['code'], message: string, description?: string) {
    super(message);
    this.name = 'DeviceCodeError';
    this.code = code;
    if (description !== undefined) {
      this.description = description;
    }
  }
}

type FetchImpl = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;
type Prompter = (response: DeviceCodeResponse) => void;

const DEFAULT_TIMEOUT_MS = 10_000;
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/**
 * Build the MCP User-Agent string for device-code calls.
 * Dashboard parses this to auto-populate the key label.
 */
export function buildUserAgent(
  version: string,
  platform: string = os.platform(),
  hostname: string = os.hostname()
): string {
  return `cmos-mcp/${version} (${platform}; ${hostname})`;
}

/** Read the package version so the runtime User-Agent matches the shipped build. */
export async function readPackageVersion(): Promise<string> {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  try {
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function fetchWithTimeout(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Internal: POST `/api/auth/device/code` and return the parsed response. */
export async function requestDeviceCode(
  baseUrl: string,
  userAgent: string,
  options: { fetchImpl?: FetchImpl; timeoutMs?: number } = {}
): Promise<DeviceCodeResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl.replace(/\/+$/, '')}/api/auth/device/code`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
        body: JSON.stringify({}),
      },
      timeoutMs
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeviceCodeError('request_failed', `device/code request failed: ${msg}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new DeviceCodeError(
      'request_failed',
      `device/code HTTP ${response.status}: ${text || 'no body'}`
    );
  }

  let body: Partial<DeviceCodeResponse>;
  try {
    body = (await response.json()) as Partial<DeviceCodeResponse>;
  } catch {
    throw new DeviceCodeError('malformed_response', 'device/code returned invalid JSON');
  }

  if (
    typeof body.deviceCode !== 'string' ||
    typeof body.userCode !== 'string' ||
    typeof body.verificationUri !== 'string' ||
    typeof body.expiresIn !== 'number' ||
    typeof body.interval !== 'number'
  ) {
    throw new DeviceCodeError('malformed_response', 'device/code missing required fields');
  }

  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUri: body.verificationUri,
    expiresIn: body.expiresIn,
    interval: body.interval,
  };
}

/**
 * Internal: poll `/api/auth/device/token` until success or terminal error.
 * Honors RFC 8628 semantics:
 *  - `authorization_pending` → wait `interval` seconds and retry
 *  - `slow_down` → add 5s to `interval` and retry
 *  - `expired_token` / `access_denied` → throw `DeviceCodeError`
 */
export async function pollForToken(
  baseUrl: string,
  deviceCode: string,
  userAgent: string,
  initialIntervalSeconds: number,
  expiresInSeconds: number,
  options: {
    fetchImpl?: FetchImpl;
    sleepFn?: SleepFn;
    timeoutMs?: number;
    nowFn?: () => number;
  } = {}
): Promise<DeviceTokenSuccess> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowFn = options.nowFn ?? (() => Date.now());

  const url = `${baseUrl.replace(/\/+$/, '')}/api/auth/device/token`;
  const deadlineMs = nowFn() + expiresInSeconds * 1000;
  let intervalSeconds = initialIntervalSeconds;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (nowFn() >= deadlineMs) {
      throw new DeviceCodeError(
        'expired_token',
        'device code expired before authorization completed'
      );
    }

    await sleepFn(intervalSeconds * 1000);

    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': userAgent,
          },
          body: JSON.stringify({ deviceCode }),
        },
        timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DeviceCodeError('request_failed', `device/token request failed: ${msg}`);
    }

    if (response.status === 200) {
      let body: Partial<DeviceTokenSuccess>;
      try {
        body = (await response.json()) as Partial<DeviceTokenSuccess>;
      } catch {
        throw new DeviceCodeError('malformed_response', 'device/token returned invalid JSON');
      }
      if (
        typeof body.key !== 'string' ||
        typeof body.keyId !== 'string' ||
        typeof body.label !== 'string'
      ) {
        throw new DeviceCodeError('malformed_response', 'device/token missing required fields');
      }
      return { key: body.key, keyId: body.keyId, label: body.label };
    }

    if (response.status === 400) {
      let body: { error?: string; error_description?: string };
      try {
        body = (await response.json()) as { error?: string; error_description?: string };
      } catch {
        throw new DeviceCodeError(
          'malformed_response',
          'device/token 400 response was not valid JSON'
        );
      }
      const err = body.error;
      const desc = body.error_description;
      if (err === 'authorization_pending') {
        continue;
      }
      if (err === 'slow_down') {
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      }
      if (err === 'expired_token' || err === 'access_denied') {
        throw new DeviceCodeError(err, `device/token: ${err}`, desc);
      }
      throw new DeviceCodeError(
        'request_failed',
        `device/token returned unknown error '${err ?? 'missing'}'`,
        desc
      );
    }

    const text = await response.text().catch(() => '');
    throw new DeviceCodeError(
      'request_failed',
      `device/token HTTP ${response.status}: ${text || 'no body'}`
    );
  }
}

/**
 * Sprint 59 m04 — bounded-poll variant for the two-call login surface.
 *
 * Unlike `pollForToken` which blocks until a terminal state (approved, expired,
 * access_denied, or transport error), `pollForTokenBounded` returns a typed
 * status after at most `maxWaitSeconds` of wall-clock — letting the MCP
 * `cmos_auth(action="login_complete")` handler return control to the agent so
 * the agent can keep polling or surface "still waiting" to the user.
 *
 * Terminal dashboard-side states (`expired_token`, `access_denied`) are
 * returned as `{status: 'expired'}` / `{status: 'denied'}` — NOT thrown —
 * because the agent needs to branch on them. Only transport / malformed
 * failures throw `DeviceCodeError` (caller maps to `DASHBOARD_ERROR`).
 *
 * `intervalSeconds` is returned on `approved` / `pending` so the caller can
 * carry any `slow_down`-adjusted interval across multiple calls.
 */
export type BoundedPollStatus =
  | {
      status: 'approved';
      key: string;
      keyId: string;
      label: string;
      intervalSeconds: number;
    }
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'expired' }
  | { status: 'denied'; description?: string };

export interface BoundedPollOptions {
  baseUrl: string;
  deviceCode: string;
  userAgent: string;
  /** Starting poll interval seconds (typically from the device/code response). */
  intervalSeconds: number;
  /** Maximum wall-clock seconds to spend in this call before returning pending. */
  maxWaitSeconds: number;
  fetchImpl?: FetchImpl;
  sleepFn?: SleepFn;
  timeoutMs?: number;
  nowFn?: () => number;
}

export async function pollForTokenBounded(options: BoundedPollOptions): Promise<BoundedPollStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowFn = options.nowFn ?? (() => Date.now());

  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/auth/device/token`;
  const pollDeadlineMs = nowFn() + options.maxWaitSeconds * 1000;
  let intervalSeconds = options.intervalSeconds;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // If the next required sleep would push us past the budget, return pending
    // without sleeping — the agent can call again to keep polling.
    if (nowFn() + intervalSeconds * 1000 > pollDeadlineMs) {
      return { status: 'pending', intervalSeconds };
    }

    await sleepFn(intervalSeconds * 1000);

    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': options.userAgent,
          },
          body: JSON.stringify({ deviceCode: options.deviceCode }),
        },
        timeoutMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DeviceCodeError('request_failed', `device/token request failed: ${msg}`);
    }

    if (response.status === 200) {
      let body: Partial<DeviceTokenSuccess>;
      try {
        body = (await response.json()) as Partial<DeviceTokenSuccess>;
      } catch {
        throw new DeviceCodeError('malformed_response', 'device/token returned invalid JSON');
      }
      if (
        typeof body.key !== 'string' ||
        typeof body.keyId !== 'string' ||
        typeof body.label !== 'string'
      ) {
        throw new DeviceCodeError('malformed_response', 'device/token missing required fields');
      }
      return {
        status: 'approved',
        key: body.key,
        keyId: body.keyId,
        label: body.label,
        intervalSeconds,
      };
    }

    if (response.status === 400) {
      let body: { error?: string; error_description?: string };
      try {
        body = (await response.json()) as { error?: string; error_description?: string };
      } catch {
        throw new DeviceCodeError(
          'malformed_response',
          'device/token 400 response was not valid JSON'
        );
      }
      const err = body.error;
      const desc = body.error_description;
      if (err === 'authorization_pending') {
        continue;
      }
      if (err === 'slow_down') {
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      }
      if (err === 'expired_token') {
        return { status: 'expired' };
      }
      if (err === 'access_denied') {
        return desc !== undefined ? { status: 'denied', description: desc } : { status: 'denied' };
      }
      throw new DeviceCodeError(
        'request_failed',
        `device/token returned unknown error '${err ?? 'missing'}'`,
        desc
      );
    }

    const text = await response.text().catch(() => '');
    throw new DeviceCodeError(
      'request_failed',
      `device/token HTTP ${response.status}: ${text || 'no body'}`
    );
  }
}

/** Print the user-facing prompt to stderr in a terminal-friendly form. */
export function defaultPrompter(response: DeviceCodeResponse): void {
  const divider = '─'.repeat(60);
  process.stderr.write(
    [
      '',
      divider,
      '[cmos-mcp] Dashboard authorization required',
      divider,
      `Open:  ${response.verificationUri}`,
      `Code:  ${response.userCode}`,
      `(Code expires in ${response.expiresIn}s; this client will poll every ${response.interval}s.)`,
      divider,
      '',
    ].join('\n')
  );
}

export interface DeviceCodeFlowOptions {
  /** Dashboard base URL (e.g. `https://dashboard.cmos.ai`). */
  baseUrl: string;
  /** MCP version for the User-Agent (default: read from package.json at runtime). */
  version?: string;
  /** Platform string (default: `os.platform()`). */
  platform?: string;
  /** Hostname (default: `os.hostname()`). */
  hostname?: string;
  /** CredentialStore instance (default: singleton). Persists the minted key on success. */
  credentialStore?: CredentialStore;
  /** How the user is prompted to visit the verificationUri (default: stderr). */
  prompter?: Prompter;
  /** Injected fetch (tests). Default: global fetch. */
  fetchImpl?: FetchImpl;
  /** Injected sleep (tests). Default: setTimeout-backed. */
  sleepFn?: SleepFn;
  /** Per-HTTP-request timeout (default 10s). */
  timeoutMs?: number;
  /** Clock function (tests). Default: Date.now. */
  nowFn?: () => number;
  /** Supply a User-Agent override (tests). Default: buildUserAgent(version, ...). */
  userAgent?: string;
}

/**
 * Full RFC 8628 bootstrap: request a device code, print the prompt, poll
 * until approval or terminal error, and persist the resulting user-scoped
 * key to the CredentialStore.
 *
 * On success returns the `{key, keyId, label}` body so callers can also
 * surface the minted identity (for m02's register call + m04's whoami).
 */
export async function runDeviceCodeFlow(
  options: DeviceCodeFlowOptions
): Promise<DeviceTokenSuccess> {
  const version = options.version ?? (await readPackageVersion());
  const userAgent =
    options.userAgent ?? buildUserAgent(version, options.platform, options.hostname);
  const prompter = options.prompter ?? defaultPrompter;

  const codeResponse = await requestDeviceCode(options.baseUrl, userAgent, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  prompter(codeResponse);

  const token = await pollForToken(
    options.baseUrl,
    codeResponse.deviceCode,
    userAgent,
    codeResponse.interval,
    codeResponse.expiresIn,
    {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.nowFn ? { nowFn: options.nowFn } : {}),
    }
  );

  const store = options.credentialStore ?? (await CredentialStore.create());
  const now = new Date().toISOString();
  const record: UserScopedKeyRecord = {
    key: token.key,
    label: token.label,
    issuedAt: now,
    lastUsedAt: now,
  };
  await store.upsertUserScopedKey(token.keyId, record);

  return token;
}
