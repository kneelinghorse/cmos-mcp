# HTTP Transport Quick Reference

## Start HTTP Server

```bash
npm run build
npm run start:http
```

**Default endpoint:** `http://127.0.0.1:3000/mcp`

## Environment Variables

- `PORT` - Server port (default: 3000)
- `HOST` - Bind address (default: 127.0.0.1)

## Codex Configuration

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

## Test Connection

```bash
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

See [HTTP_TRANSPORT.md](./HTTP_TRANSPORT.md) for complete documentation.
