// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Wire-test preload that redirects only the baked dashboard origin to a loopback double.

'use strict';

const CANONICAL_DASHBOARD_ORIGIN = 'https://cmos.aquex.ai';
const redirectOrigin = process.env.CMOS_TEST_DASHBOARD_REDIRECT_ORIGIN;

if (!redirectOrigin) {
  throw new Error('CMOS_TEST_DASHBOARD_REDIRECT_ORIGIN is required by the wire-test preload');
}

const originalFetch = globalThis.fetch;
if (typeof originalFetch !== 'function') {
  throw new Error('global fetch is unavailable in the wire-test child process');
}

globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const requested = new URL(raw);
  if (requested.origin === redirectOrigin) {
    return originalFetch(input, init);
  }
  if (requested.origin !== CANONICAL_DASHBOARD_ORIGIN) {
    throw new Error(`wire-test outbound request blocked: ${requested.href}`);
  }

  const redirected = new URL(`${requested.pathname}${requested.search}`, redirectOrigin);
  const redirectedInput =
    typeof Request !== 'undefined' && input instanceof Request
      ? new Request(redirected, input)
      : redirected;
  return originalFetch(redirectedInput, init);
};
