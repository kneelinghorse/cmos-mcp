// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Roots discovery is scoped to the active legacy connection and never blocks named projects.
// ABOUTME: Modern requests and cache invalidation cannot inherit another connection's roots.

import type { Server, ServerContext } from '@modelcontextprotocol/server';
import {
  clearClientProjectRoots,
  clientLabelForRequest,
  clientProjectRootsForCall,
  withServerRequest,
} from '../src/server-request-context';

function server(version = '2025-11-25'): Server {
  return { getNegotiatedProtocolVersion: () => version } as Server;
}

const modern = {
  mcpReq: { envelope: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
} as unknown as ServerContext;

it('keeps legacy roots per connection and re-probes after list_changed', async () => {
  const first = server();
  const second = server();
  const probe = jest.fn(async (target: Server) => [target === first ? '/project/a' : '/project/b']);
  expect(await clientProjectRootsForCall(first, undefined, probe)).toEqual(['/project/a']);
  expect(await clientProjectRootsForCall(first, undefined, probe)).toEqual(['/project/a']);
  expect(await clientProjectRootsForCall(second, undefined, probe)).toEqual(['/project/b']);
  expect(probe).toHaveBeenCalledTimes(2);
  clearClientProjectRoots(first);
  probe.mockResolvedValueOnce(['/project/new']);
  expect(await clientProjectRootsForCall(first, undefined, probe)).toEqual(['/project/new']);
  expect(probe).toHaveBeenCalledTimes(3);
});

it.each([null, ''])('treats projectRoot=%p as absent like the legacy resolver', async (root) => {
  const target = server();
  const probe = jest.fn(async () => ['/legacy']);
  expect(await clientProjectRootsForCall(target, root, probe)).toEqual(['/legacy']);
  expect(await clientProjectRootsForCall(target, root, probe)).toEqual(['/legacy']);
  expect(probe).toHaveBeenCalledTimes(1);
  clearClientProjectRoots(target);
  expect(await clientProjectRootsForCall(target, root, probe)).toEqual(['/legacy']);
  expect(probe).toHaveBeenCalledTimes(2);
});

it('reads modern client identity from each request and keeps legacy client identity', async () => {
  const target = { getClientVersion: () => ({ name: 'legacy', version: '1' }) } as Server;
  const labels = await Promise.all(
    ['first', 'second'].map(async (name) => {
      const context = {
        mcpReq: {
          envelope: {
            'io.modelcontextprotocol/clientInfo': { name, version: '2' },
          },
        },
      } as unknown as ServerContext;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return clientLabelForRequest(target, context);
    })
  );
  expect(labels).toEqual(['first/2', 'second/2']);
  expect(clientLabelForRequest(target)).toBe('legacy/1');
  expect(
    clientLabelForRequest(target, {
      mcpReq: { envelope: { 'io.modelcontextprotocol/clientInfo': { name: 4 } } },
    } as unknown as ServerContext)
  ).toBeNull();
});

it('guards named and modern calls before consulting a warmed legacy cache', async () => {
  const target = server();
  const probe = jest.fn(async () => ['/legacy']);
  await clientProjectRootsForCall(target, undefined, probe);
  expect(await clientProjectRootsForCall(target, '/explicit', probe)).toEqual([]);
  expect(
    await withServerRequest(target, modern, () =>
      clientProjectRootsForCall(target, undefined, probe)
    )
  ).toEqual([]);
  expect(probe).toHaveBeenCalledTimes(1);
});

it('uses each active server under concurrent requests instead of the fallback singleton', async () => {
  const fallback = server();
  const legacy = server();
  const modernServer = server('2026-07-28');
  const probe = jest.fn(async (target: Server) => (target === legacy ? ['/legacy'] : ['/wrong']));
  const results = await Promise.all([
    withServerRequest(legacy, undefined, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return clientProjectRootsForCall(fallback, undefined, probe);
    }),
    withServerRequest(modernServer, undefined, () =>
      clientProjectRootsForCall(fallback, undefined, probe)
    ),
  ]);
  expect(results).toEqual([['/legacy'], []]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledWith(legacy);
});
