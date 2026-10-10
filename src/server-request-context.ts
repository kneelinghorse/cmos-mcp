// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Binds roots discovery to the current protocol connection instead of a process singleton.
// ABOUTME: Named projects and modern requests bypass legacy roots, including previously cached roots.

import { AsyncLocalStorage } from 'async_hooks';
import {
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type Server,
  type ServerContext,
} from '@modelcontextprotocol/server';

const requests = new AsyncLocalStorage<{ server: Server; version?: string }>();
const roots = new WeakMap<Server, Promise<string[]>>();

export function withServerRequest<T>(
  server: Server,
  context: ServerContext | undefined,
  operation: () => T
): T {
  // SDK 2.3.1 emits these envelope keys but declares RequestMetaEnvelope as {}.
  const declared = (context?.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    PROTOCOL_VERSION_META_KEY
  ];
  const version = typeof declared === 'string' ? declared : server.getNegotiatedProtocolVersion?.();
  return requests.run({ server, version }, operation);
}

export function clientLabelForRequest(server: Server, context?: ServerContext): string | null {
  const declared = (context?.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    CLIENT_INFO_META_KEY
  ];
  const client = declared ?? server.getClientVersion?.();
  return client !== null &&
    typeof client === 'object' &&
    'name' in client &&
    typeof client.name === 'string' &&
    'version' in client &&
    typeof client.version === 'string'
    ? `${client.name}/${client.version}`
    : null;
}

export function clearClientProjectRoots(server: Server): void {
  roots.delete(server);
}

export async function clientProjectRootsForCall(
  fallback: Server,
  explicitRoot: string | null | undefined,
  probe: (server: Server) => Promise<string[]>
): Promise<string[]> {
  const request = requests.getStore();
  const server = request?.server ?? fallback;
  const version = request?.version ?? server.getNegotiatedProtocolVersion?.();
  // Match sender-context's explicit-project selection: null and empty strings are absent.
  if (explicitRoot || (version !== undefined && version >= '2026-07-28')) return [];
  let cached = roots.get(server);
  if (!cached) {
    cached = probe(server);
    roots.set(server, cached);
  }
  return cached;
}
