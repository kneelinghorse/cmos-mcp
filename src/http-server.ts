#!/usr/bin/env node

/**
 * CMOS-MCP HTTP Server
 *
 * Provides HTTP/SSE transport for CMOS-MCP server to support clients like Codex
 * that don't support stdio transport.
 *
 * Usage:
 *   PORT=3000 node dist/http-server.js
 *
 * @module http-server
 */

import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildMissionProtocolContext, registerToolHandlers } from './index.js';
import { initServerHealth, readBuildManifest } from './server-health';

/**
 * Simple in-memory event store for message resumability
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type {
  EventStore,
  StreamId,
  EventId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';

class InMemoryEventStore implements EventStore {
  private events: Map<string, Array<{ id: string; message: JSONRPCMessage }>> = new Map();
  private eventToStream: Map<string, string> = new Map();

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    if (!this.events.has(streamId)) {
      this.events.set(streamId, []);
    }
    this.events.get(streamId)!.push({ id: eventId, message });
    this.eventToStream.set(eventId, streamId);
    return eventId;
  }

  async getStreamIdForEvent(eventId: EventId): Promise<StreamId | undefined> {
    return this.eventToStream.get(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    // Find the stream ID for this event
    const streamId = this.eventToStream.get(lastEventId);
    if (!streamId) {
      throw new Error(`Stream not found for event ID: ${lastEventId}`);
    }

    const events = this.events.get(streamId) || [];
    const lastIndex = events.findIndex((e) => e.id === lastEventId);
    const eventsToReplay = lastIndex >= 0 ? events.slice(lastIndex + 1) : [];

    // Send each event using the callback
    for (const event of eventsToReplay) {
      await send(event.id, event.message);
    }

    return streamId;
  }

  async deleteStream(streamId: StreamId): Promise<void> {
    const events = this.events.get(streamId) || [];
    for (const event of events) {
      this.eventToStream.delete(event.id);
    }
    this.events.delete(streamId);
  }
}

/**
 * Parse JSON body from request
 */
async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (_error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Main HTTP server setup
 */
async function main(): Promise<void> {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const HOST = process.env.HOST || '127.0.0.1';

  console.error(`[INFO] Initializing CMOS-MCP HTTP server...`);

  // Initialize server context
  const context = await buildMissionProtocolContext();

  // Map to store transports by session ID
  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  // Create HTTP server
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { method, url } = req;

    // CORS headers for development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Last-Event-ID');

    // Handle preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only handle /mcp endpoint
    if (url !== '/mcp') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (method === 'POST') {
        // Parse request body
        const body = await parseJsonBody(req);

        if (sessionId) {
          console.error(`[INFO] Received MCP request for session: ${sessionId}`);
        }

        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          // Reuse existing transport
          transport = transports.get(sessionId)!;
        } else if (!sessionId && isInitializeRequest(body)) {
          // New initialization request
          const eventStore = new InMemoryEventStore();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore,
            onsessioninitialized: (newSessionId) => {
              console.error(`[INFO] Session initialized with ID: ${newSessionId}`);
              transports.set(newSessionId, transport);
            },
          });

          // Set up onclose handler
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports.has(sid)) {
              console.error(`[INFO] Transport closed for session ${sid}`);
              transports.delete(sid);
            }
          };

          // Create new server instance and connect transport
          const server = new Server(
            {
              name: 'cmos-mcp',
              version: '1.0.0',
            },
            {
              capabilities: {
                tools: {},
              },
            }
          );

          registerToolHandlers(context, server);
          await server.connect(transport);

          await transport.handleRequest(req, res, body);
          return;
        } else {
          // Invalid request
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          });
          return;
        }

        // Handle request with existing transport
        await transport.handleRequest(req, res, body);
      } else if (method === 'GET') {
        // SSE stream request
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
          return;
        }

        const lastEventId = req.headers['last-event-id'] as string | undefined;
        if (lastEventId) {
          console.error(`[INFO] Client reconnecting with Last-Event-ID: ${lastEventId}`);
        } else {
          console.error(`[INFO] Establishing new SSE stream for session ${sessionId}`);
        }

        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else if (method === 'DELETE') {
        // Session termination
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400);
          res.end('Invalid or missing session ID');
          return;
        }

        console.error(`[INFO] Received session termination request for session ${sessionId}`);
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(405);
        res.end('Method Not Allowed');
      }
    } catch (error) {
      console.error('[ERROR] Error handling request:', error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // Initialize server health tracking
  initServerHealth();

  // Start server
  httpServer.listen(PORT, HOST, () => {
    console.error(`[INFO] CMOS-MCP HTTP server listening on http://${HOST}:${PORT}/mcp`);
    console.error(`[INFO] Transport: Streamable HTTP with SSE support`);
    console.error(`[INFO] Ready for Codex and other HTTP-based MCP clients`);
  });

  // Watch for build manifest changes and auto-restart
  const manifestPath = path.resolve(__dirname, '..', 'dist', '.build-manifest.json');
  const manifestDir = path.dirname(manifestPath);
  const startupManifest = readBuildManifest();
  let restartScheduled = false;

  if (fs.existsSync(manifestDir)) {
    const watcher = fs.watch(manifestDir, { persistent: false }, (eventType, filename) => {
      if (filename !== '.build-manifest.json' || restartScheduled) return;

      const currentManifest = readBuildManifest();
      if (
        currentManifest &&
        startupManifest &&
        currentManifest.buildHash !== startupManifest.buildHash
      ) {
        restartScheduled = true;
        console.error(
          `[INFO] Build change detected (${startupManifest.buildHash.slice(0, 12)}… → ${currentManifest.buildHash.slice(0, 12)}…). Auto-restarting in 2s...`
        );
        setTimeout(() => {
          console.error('[INFO] Restarting due to build change...');
          process.exit(0); // PM2 or process manager will restart
        }, 2000);
      }
    });

    watcher.on('error', (err) => {
      console.error(`[WARN] Build manifest watcher error: ${err.message}`);
    });

    console.error(`[INFO] Watching for build changes at ${manifestPath}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.error('[INFO] Shutting down HTTP server...');

    // Close all active transports
    for (const [sessionId, transport] of transports.entries()) {
      try {
        console.error(`[INFO] Closing transport for session ${sessionId}`);
        await transport.close();
        transports.delete(sessionId);
      } catch (error) {
        console.error(`[ERROR] Error closing transport for session ${sessionId}:`, error);
      }
    }

    httpServer.close(() => {
      console.error('[INFO] HTTP server shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start the server
if (require.main === module) {
  main().catch((error) => {
    console.error('[FATAL] Server startup failed:', error);
    process.exit(1);
  });
}

export { main };
