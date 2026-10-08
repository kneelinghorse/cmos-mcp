// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A probe for tests/network-deny-loud.test.ts: code that swallows its own network error,
// ABOUTME: as fire-and-forget sync does. Run only by that test's nested jest, never by the suite.

import http from 'http';

test('swallows the error of an outbound request, like fire-and-forget code', async () => {
  await new Promise<void>((resolve) => {
    http.get('http://example.com/', () => resolve()).on('error', () => resolve());
  });
});
