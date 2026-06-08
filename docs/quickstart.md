# CMOS-MCP Quickstart (Under 5 Minutes)

This guide gets you from zero to a working CMOS project with your first sprint, mission, and session.

## Prerequisites

- Node.js 20+
- An MCP-capable client (`claude` CLI or Claude Desktop)

## 1. Install

Install globally:

```bash
npm install -g cmos-mcp
```

Or run on demand:

```bash
npx -y cmos-mcp
```

## 2. Configure Your MCP Client

### Claude Code

```bash
claude mcp add-json cmos-mcp '{"command":"npx","args":["-y","cmos-mcp"]}'
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cmos-mcp": {
      "command": "npx",
      "args": ["-y", "cmos-mcp"]
    }
  }
}
```

If you use Claude Desktop, register a default project once:

```json
{
  "tool": "cmos_project_register",
  "arguments": {
    "projectRoot": "/absolute/path/to/your/project",
    "setAsDefault": true
  }
}
```

## 3. Initialize CMOS in Your Project

```json
{
  "tool": "cmos_project_init",
  "arguments": {
    "projectRoot": "/absolute/path/to/your/project",
    "projectName": "My Project"
  }
}
```

## 4. Create Your First Sprint

```json
{
  "tool": "cmos_sprint_add",
  "arguments": {
    "sprintId": "sprint-01",
    "title": "First Sprint",
    "focus": "Ship initial workflow"
  }
}
```

## 5. Create and Start Your First Mission

```json
{
  "tool": "cmos_mission_add",
  "arguments": {
    "missionId": "s01-m01",
    "name": "First Mission",
    "sprintId": "sprint-01",
    "objective": "Deliver first end-to-end feature",
    "successCriteria": ["Feature works", "Tests pass"]
  }
}
```

```json
{
  "tool": "cmos_mission_start",
  "arguments": {
    "missionId": "s01-m01"
  }
}
```

## 6. Run Your First Session

Start:

```json
{
  "tool": "cmos_session_start",
  "arguments": {
    "type": "planning",
    "title": "Plan first mission",
    "sprintId": "sprint-01"
  }
}
```

Capture:

```json
{
  "tool": "cmos_session_capture",
  "arguments": {
    "category": "decision",
    "content": "Use typed MCP tools for all mission state changes"
  }
}
```

Complete:

```json
{
  "tool": "cmos_session_complete",
  "arguments": {
    "summary": "Created sprint and started first mission"
  }
}
```

## 7. Complete Mission and Verify State

```json
{
  "tool": "cmos_mission_complete",
  "arguments": {
    "missionId": "s01-m01",
    "notes": "Implemented and verified"
  }
}
```

```json
{
  "tool": "cmos_agent_onboard",
  "arguments": {}
}
```

You now have a working CMOS project loop:

`queued mission -> in progress mission -> completed mission -> context updated`
