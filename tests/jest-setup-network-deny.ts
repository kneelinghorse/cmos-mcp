// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m10 — installs the outbound-network deny once per process and fails any test that
// ABOUTME: attempted a connection it did not opt into (see tests/helpers/network-deny.ts).

import { afterAll, afterEach } from '@jest/globals';

import {
  clearAllowedOrigins,
  installNetworkDeny,
  takeBlockedAttempts,
  type BlockedAttempt,
} from './helpers/network-deny';

installNetworkDeny();

function failIfBlocked(when: string, attempts: BlockedAttempt[]): void {
  if (attempts.length === 0) return;
  const list = attempts.map((a) => `${a.host}:${a.port}`).join(', ');
  throw new Error(
    `${when} attempted ${attempts.length} outbound network connection(s) the suite does not ` +
      `allow: ${list}. Point the code at a loopback double, or opt in with ` +
      'allowNetworkOrigins([...]) from tests/helpers/network-deny.ts.'
  );
}

afterEach(() => {
  clearAllowedOrigins();
  failIfBlocked('This test', takeBlockedAttempts());
});

// A fire-and-forget request can outlive its test; whatever is still recorded fails the file.
afterAll(() => {
  failIfBlocked('This test file', takeBlockedAttempts());
});
