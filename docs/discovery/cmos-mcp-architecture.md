# CMOS-MCP Architecture

**Document Purpose**: Comprehensive architecture documentation for the cmos-mcp TypeScript MCP server.

**Last Updated**: 2025-12-27

---

## Overview

**cmos-mcp** is an MCP (Model Context Protocol) server providing typed, safe, reliable SQLite-backed project management for AI agents. It exposes 30 tools organized into two categories:

1. **Mission Protocol Tools** (4 tools) - Legacy domain pack system for mission creation
2. **CMOS Tools** (26 tools) - SQLite-backed project management operations

The server uses stdio transport for Claude Desktop integration.

---

## Project Structure

```
src/
├── index.ts                    # MCP server entry point
├── tools/                      # All tool implementations
│   ├── cmos/                   # CMOS tools (26 tools)
│   │   ├── index.ts            # Barrel export
│   │   ├── client.ts           # CmosDatabaseClient
│   │   ├── types.ts            # Shared types
│   │   ├── errors.ts           # Error codes and factories
│   │   └── cmos-*.ts           # Individual tool files
│   ├── create-mission.ts       # Mission creation tool
│   ├── list-domains.ts         # Domain listing tool
│   ├── score-quality.ts        # Quality scoring tool
│   ├── split-mission.ts        # Mission splitting tool
│   └── formatters/             # Output formatters
├── intelligence/               # Advanced processing modules
├── domains/                    # Domain pack loading
├── errors/                     # Global error handling
├── validation/                 # Schema validation
├── quality/                    # Quality analyzers
├── loaders/                    # YAML loading
├── registry/                   # Domain registry parsing
├── types/                      # Global type definitions
├── utils/                      # Utilities (abort, workspace I/O)
├── merge/                      # Deep merge for domain packs
├── versioning/                 # Version management
├── extraction/                 # Template extraction
├── combination/                # Pack combination
├── import-export/              # Template import/export
├── security/                   # Workspace guards
└── schemas/                    # Mission schemas
```

---

## Core Components

### 1. MCP Server (`src/index.ts`)

The main entry point implementing the MCP protocol.

**Key Responsibilities:**

- Server initialization with `@modelcontextprotocol/sdk`
- Tool registration via `ListToolsRequestSchema`
- Tool execution via `CallToolRequestSchema`
- CMOS detection and context building
- Graceful shutdown handling (SIGINT/SIGTERM)

**Configuration:**

```typescript
const SERVER_CONFIG = {
  name: 'mission-protocol',
  version: '2.0.0',
};
```

**Tool Modes:**

- `MISSION_PROTOCOL_SLIM_MODE=1`: Only core tools (2)
- Default: All canonical tools (4) + CMOS tools (26)

### 2. Mission Protocol Context

```typescript
interface MissionProtocolContext {
  baseDir: string; // Template base directory
  defaultModel: SupportedModel; // claude | gpt | gemini
  loader: SecureYAMLLoader; // Secure YAML loading
  registryParser: RegistryParser;
  listDomainsTool: ListDomainsToolImpl;
  createMissionTool: CreateMissionToolImpl;
  splitMissionTool: SplitMissionToolImpl;
  tokenCounter: TokenCounter;
  cmosDetected: boolean; // CMOS availability
  cmosDatabasePath?: string; // Path to cmos.sqlite
}
```

### 3. CmosDatabaseClient (`src/tools/cmos/client.ts`)

Wrapper around `better-sqlite3` for all CMOS database operations.

**Features:**

- Auto-detection via `CmosDetector`
- Statement caching for performance
- WAL mode enabled for concurrent access
- Transaction support
- Structured error translation

**Usage Pattern:**

```typescript
const result = await withClient((client) => client.getMany<Mission>('SELECT * FROM missions'), {
  projectRoot: params.projectRoot,
});
```

**Project Root Resolution:**

1. Explicit `projectRoot` parameter
2. `CMOS_PROJECT_ROOT` environment variable
3. `process.cwd()`

### 4. CmosDetector (`src/intelligence/cmos-detector.ts`)

Detects CMOS installations by looking for:

- `cmos/` directory
- `cmos/db/cmos.sqlite` database

Includes caching to avoid repeated filesystem checks.

---

## Data Flow

### Tool Execution Flow

```
Client Request
    ↓
CallToolRequestSchema Handler
    ↓
executeMissionProtocolTool()
    ↓
  ┌─────────────────────────────┐
  │ Tool Type Detection         │
  ├─────────────────────────────┤
  │ Mission Protocol Tools      │ → Direct execution
  │ (get_available_domains,     │   with context
  │  create_mission, etc.)      │
  ├─────────────────────────────┤
  │ CMOS Tools                  │ → withClient()
  │ (cmos_mission_*, etc.)      │   database operations
  └─────────────────────────────┘
    ↓
CmosToolResult<T>
    ↓
Format for LLM (formatXxxForLLM)
    ↓
CallToolResult
    ↓
Client Response
```

### CMOS Tool Execution Pattern

```typescript
// 1. Function validates parameters
if (!params.missionId) {
  return createError(CmosErrors.missingParameter('missionId'));
}

// 2. withClient handles connection lifecycle
return withClient((client) => {
  // 3. Query database
  const result = client.getOne<Mission>('...', [id]);

  // 4. Handle errors
  if (!result.success) return result;

  // 5. Business logic
  // ...

  // 6. Return structured result
  return createSuccess({ ... });
}, { projectRoot });
```

---

## Database Schema

The CMOS SQLite database (`cmos/db/cmos.sqlite`) contains:

| Table                  | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `missions`             | Mission records with status, objective, criteria |
| `sprints`              | Sprint containers for missions                   |
| `sessions`             | Planning/review sessions                         |
| `session_events`       | Session activity log                             |
| `contexts`             | Project/master context storage                   |
| `context_snapshots`    | Historical context timeline                      |
| `strategic_decisions`  | Captured decisions from sessions                 |
| `mission_dependencies` | Mission dependency graph                         |
| `metadata`             | Key-value project metadata                       |
| `prompt_mappings`      | Prompt template mappings                         |
| `telemetry_events`     | Runtime telemetry                                |

---

## Error Handling Architecture

### Error Types

```
MissionError (base)
├── ValidationError    # Input validation failures
├── DomainError        # Domain pack issues
├── IoError            # File/network I/O
└── ConfigError        # Configuration problems
```

### CMOS Error Pattern

```typescript
interface CmosToolError {
  code: string; // Machine-readable code
  message: string; // Human-readable message
  suggestion?: string; // Actionable fix
  validValues?: string[]; // For validation errors
  currentState?: string; // For state errors
  validTransitions?: string[];
  field?: string; // For validation
  providedValue?: unknown;
}
```

### Error Codes (`CMOS_ERROR_CODES`)

**Database Errors:**

- `DB_NOT_FOUND`, `DB_CONNECTION_FAILED`, `DB_QUERY_FAILED`, `DB_SCHEMA_MISMATCH`

**Mission Errors:**

- `MISSION_NOT_FOUND`, `MISSION_INVALID_STATE`, `MISSION_INVALID_TRANSITION`

**Context Errors:**

- `CONTEXT_NOT_FOUND`, `CONTEXT_INVALID_TYPE`, `CONTEXT_PARSE_ERROR`

**Session Errors:**

- `SESSION_NOT_FOUND`, `SESSION_ALREADY_ACTIVE`, `SESSION_NOT_ACTIVE`

**Sprint Errors:**

- `SPRINT_NOT_FOUND`, `SPRINT_ID_EXISTS`

---

## Intelligence Layer

Advanced processing modules in `src/intelligence/`:

| Module                         | Purpose                         |
| ------------------------------ | ------------------------------- |
| `agentic-controller.ts`        | Orchestration controller (65KB) |
| `mission-splitter.ts`          | Complex mission decomposition   |
| `complexity-scorer.ts`         | Mission complexity analysis     |
| `token-counters.ts`            | Token counting for models       |
| `tokenizer-bootstrap.ts`       | Lazy tokenizer initialization   |
| `cmos-detector.ts`             | CMOS installation detection     |
| `cmos-sync.ts`                 | CMOS synchronization            |
| `sqlite-client.ts`             | Raw SQLite client               |
| `boomerang-workflow.ts`        | Checkpointed execution          |
| `lifecycle-analyzer.ts`        | Mission lifecycle analysis      |
| `mission-outcome-analytics.ts` | Outcome tracking                |
| `rsip-loop.ts`                 | Refinement loops                |

---

## Dependencies

### Runtime Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.19.1", // MCP protocol
  "@xenova/transformers": "^2.17.2", // Tokenization
  "better-sqlite3": "^12.4.1", // SQLite driver
  "fast-xml-parser": "^5.3.0", // XML parsing
  "gpt-tokenizer": "^3.2.0", // GPT token counting
  "yaml": "^2.8.1", // YAML parsing
  "zod": "^3.25.76" // Schema validation
}
```

### Development Dependencies

- TypeScript 5.9+
- Jest 30+ for testing
- ESLint + Prettier for code quality
- Husky for git hooks

---

## Configuration

### Environment Variables

| Variable                     | Purpose                                  | Default         |
| ---------------------------- | ---------------------------------------- | --------------- |
| `CMOS_PROJECT_ROOT`          | Override project root for CMOS detection | `process.cwd()` |
| `MISSION_PROTOCOL_SLIM_MODE` | Set to `1` for core tools only           | `undefined`     |
| `NODE_ENV`                   | Environment mode                         | `development`   |
| `DEBUG`                      | Enable debug logging                     | `false`         |

### Tool Timeouts

```typescript
const TOOL_TIMEOUT_MS = {
  create_mission_splits: 120_000, // 2 minutes
};
```

---

## Key Architectural Decisions

1. **SQLite as Source of Truth**: All persistent state in `cmos/db/cmos.sqlite`
2. **CMOS Tools Always Available**: Return graceful errors if CMOS not detected
3. **Structured Results**: All tools return `CmosToolResult<T>` for consistency
4. **LLM-Friendly Formatting**: Every tool has a `formatXxxForLLM()` function
5. **State Machine for Missions**: Valid transitions enforced in code
6. **Statement Caching**: Prepared statements cached for performance
7. **WAL Mode**: Enabled for better concurrent access
8. **Zod Validation**: Runtime parameter validation

---

## Related Documents

- [Tool Catalog](./cmos-mcp-tool-catalog.md) - Complete inventory of all 30 MCP tools
- [Design Patterns](./cmos-mcp-patterns.md) - Code patterns and conventions
