# HTTP Transport for CMOS-MCP

CMOS-MCP now supports **HTTP/SSE transport** in addition to the default stdio transport, enabling compatibility with clients like Codex that don't support stdio.

## Quick Start

### Start HTTP Server

```bash
# Build first
npm run build

# Start HTTP server (default: http://127.0.0.1:3000/mcp)
npm run start:http

# Custom port
PORT=8080 npm run start:http

# Custom host (use with caution - see security notes)
HOST=0.0.0.0 PORT=3000 npm run start:http
```

### Using the Binary

```bash
# After npm install -g or npm link
cmos-mcp-http

# With custom port
PORT=3000 cmos-mcp-http
```

## Transport Modes

### Stdio Transport (Default)

**Use for:** Claude Desktop, VSCode, local development

```bash
npm start
```

- Process-based communication
- Launched as subprocess by client
- No network exposure
- Best for local, single-client scenarios

### HTTP Transport

**Use for:** Codex, remote clients, multi-client scenarios

```bash
npm run start:http
```

- Network-based communication via HTTP/HTTPS
- Supports multiple concurrent clients
- Session-based with resumability
- Ideal for hosted deployments

## HTTP Endpoint

**Base URL:** `http://127.0.0.1:3000/mcp` (configurable via PORT/HOST env vars)

### Supported Methods

- **POST /mcp** - Send JSON-RPC requests (initialization, tool calls, etc.)
- **GET /mcp** - Establish SSE stream for server-initiated messages
- **DELETE /mcp** - Terminate session

### Headers

- `Content-Type: application/json` (for POST requests)
- `mcp-session-id: <session-id>` (after initialization)
- `Last-Event-ID: <event-id>` (for SSE reconnection/resumability)

## Client Configuration

### Codex

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

### Generic HTTP Client

```typescript
// 1. Initialize session
const initResponse = await fetch('http://127.0.0.1:3000/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'my-client', version: '1.0.0' },
    },
  }),
});

const sessionId = initResponse.headers.get('mcp-session-id');

// 2. Make subsequent requests with session ID
const toolsResponse = await fetch('http://127.0.0.1:3000/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'mcp-session-id': sessionId,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }),
});
```

## Features

### Session Management

- **Stateful mode**: Server generates and tracks session IDs
- **Session persistence**: Sessions maintained across reconnections
- **Automatic cleanup**: Sessions cleaned up on explicit termination or timeout

### Message Resumability

- **Event store**: Messages stored with event IDs
- **Reconnection support**: Clients can resume from last received event using `Last-Event-ID` header
- **No message loss**: Reliable delivery even with network interruptions

### SSE Streaming

- **Server-initiated messages**: Server can send notifications, logs, and requests to client
- **Long-lived connections**: Efficient for real-time updates
- **Automatic reconnection**: Clients reconnect with event ID to resume stream

## Security Considerations

### Local Development (Default)

```bash
# Binds to localhost only - safe for local use
npm run start:http
```

- Server binds to `127.0.0.1` by default
- Only accessible from local machine
- No external network exposure

### Production Deployment

**⚠️ Important Security Notes:**

1. **Use HTTPS**: Always use TLS/SSL in production
2. **Authentication**: Implement authentication middleware (OAuth, API keys, etc.)
3. **CORS**: Configure appropriate CORS policies
4. **Rate limiting**: Add rate limiting to prevent abuse
5. **Origin validation**: Validate `Origin` header to prevent DNS rebinding attacks

```bash
# Example: Bind to all interfaces (use with reverse proxy + TLS)
HOST=0.0.0.0 PORT=3000 npm run start:http
```

**Recommended production setup:**

- Place behind reverse proxy (nginx, Caddy, etc.)
- Terminate TLS at proxy level
- Add authentication layer
- Use environment-based configuration

## Architecture

### Transport Layer

- **Base**: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`
- **Session tracking**: In-memory map of session ID → transport instance
- **Event storage**: In-memory event store for message resumability

### Request Flow

1. **Client sends POST** → Server receives JSON-RPC message
2. **Session check**:
   - If `initialize` request → Create new session + transport
   - If existing session → Reuse transport
   - If invalid session → Return 400 error
3. **Process request** → Execute tool/handler
4. **Return response** → HTTP response or SSE stream

### SSE Stream Flow

1. **Client sends GET** with `mcp-session-id` header
2. **Server establishes SSE stream** for that session
3. **Server sends events** (notifications, logs, etc.)
4. **Client reconnects** with `Last-Event-ID` if disconnected
5. **Server replays missed events** from event store

## Comparison: Stdio vs HTTP

| Feature            | Stdio               | HTTP                    |
| ------------------ | ------------------- | ----------------------- |
| **Use Case**       | Local clients       | Remote/multi-client     |
| **Network**        | No network          | HTTP/HTTPS              |
| **Clients**        | Single (subprocess) | Multiple concurrent     |
| **Security**       | Process isolation   | Network security needed |
| **Resumability**   | No                  | Yes (via event store)   |
| **Codex Support**  | ❌ No               | ✅ Yes                  |
| **Claude Desktop** | ✅ Yes              | ✅ Yes                  |

## Troubleshooting

### Port Already in Use

```bash
# Check what's using the port
lsof -i :3000

# Use a different port
PORT=3001 npm run start:http
```

### Session Not Found

- Ensure `mcp-session-id` header is included in requests after initialization
- Check that session hasn't timed out
- Verify session ID matches the one returned during initialization

### Connection Refused

- Verify server is running: `curl http://127.0.0.1:3000/mcp`
- Check firewall settings
- Ensure correct HOST/PORT configuration

### CORS Errors (Browser Clients)

The server includes permissive CORS headers for development. For production:

1. Configure specific allowed origins
2. Remove wildcard CORS
3. Implement proper authentication

## Development

### Testing HTTP Server

```bash
# Terminal 1: Start server
npm run start:http

# Terminal 2: Test with curl
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0.0"}
    }
  }'
```

### Debugging

```bash
# Enable Node.js debugging
NODE_OPTIONS='--inspect' npm run start:http

# View server logs
# All logs go to stderr, so they won't interfere with MCP protocol
```

## References

- [MCP Specification - Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [CMOS-MCP Documentation](./README.md)

---

**Version**: 1.0.0  
**Last Updated**: 2026-01-23
