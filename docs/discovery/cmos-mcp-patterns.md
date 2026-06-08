# CMOS-MCP Design Patterns

**Document Purpose**: Design patterns, error handling, and code conventions used in cmos-mcp.

**Last Updated**: 2025-12-27

---

## Core Patterns

### 1. CmosToolResult Pattern

All CMOS tools return a structured `CmosToolResult<T>` for consistent, agent-friendly responses.

```typescript
interface CmosToolResult<T = unknown> {
  success: boolean;
  data?: T; // Present when success is true
  error?: CmosToolError; // Present when success is false
  warnings?: string[]; // Optional warnings that don't prevent success
}
```

**Usage:**

```typescript
// Success case
return createSuccess({ missionId, status: 'In Progress' });

// Success with warnings
return createSuccess(data, ['Warning: Using cmos-mcp source database']);

// Error case
return createError(CmosErrors.missionNotFound(missionId));
```

**Why this pattern?**

- Agents can self-correct from structured errors
- No exceptions to catch - always a clean result
- Warnings allow partial success scenarios

---

### 2. withClient Pattern

Database operations use `withClient` for automatic connection lifecycle management.

```typescript
export async function withClient<T>(
  fn: (client: CmosDatabaseClient) => CmosToolResult<T>,
  options?: CmosDatabaseClientOptions
): Promise<CmosToolResult<T>> {
  const clientResult = await CmosDatabaseClient.create(options);
  if (!clientResult.success || !clientResult.data) {
    return clientResult as CmosToolResult<T>;
  }

  const client = clientResult.data;
  try {
    return fn(client);
  } finally {
    client.close(); // Always closes connection
  }
}
```

**Tool Implementation:**

```typescript
export async function cmosMissionStart(params) {
  // 1. Validate parameters first
  if (!params.missionId) {
    return createError(CmosErrors.missingParameter('missionId'));
  }

  // 2. Use withClient for database work
  return withClient((client) => {
    const result = client.getOne<Mission>('SELECT * FROM missions WHERE id = ?', [id]);
    // ... business logic ...
    return createSuccess({ ... });
  }, { projectRoot: params.projectRoot });
}
```

**Benefits:**

- Connection always closed, even on errors
- CMOS detection handled automatically
- Clean separation of validation vs. database logic

---

### 3. Error Factory Pattern

Errors are created via factory functions in `CmosErrors` for consistency.

```typescript
export const CmosErrors = {
  missionNotFound(missionId: string): CmosToolError {
    return {
      code: CMOS_ERROR_CODES.MISSION_NOT_FOUND,
      message: `Mission '${missionId}' not found`,
      suggestion: 'Use cmos_mission_list to see available missions',
    };
  },

  missionInvalidTransition(
    missionId: string,
    currentStatus: MissionStatus,
    targetStatus: MissionStatus
  ): CmosToolError {
    const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
    return {
      code: CMOS_ERROR_CODES.MISSION_INVALID_TRANSITION,
      message: `Cannot transition '${missionId}' from '${currentStatus}' to '${targetStatus}'`,
      currentState: currentStatus,
      validTransitions,
      suggestion:
        validTransitions.length > 0
          ? `Valid transitions: ${validTransitions.join(', ')}`
          : `Mission is in terminal state`,
    };
  },
  // ... more factories
};
```

**Error Structure:**

```typescript
interface CmosToolError {
  code: string; // Machine-readable (MISSION_NOT_FOUND)
  message: string; // Human-readable explanation
  suggestion?: string; // Actionable fix
  validValues?: string[]; // For validation errors
  currentState?: string; // For state errors
  validTransitions?: string[];
  field?: string;
  providedValue?: unknown;
}
```

**Error Codes Convention:** `ENTITY_ERROR_TYPE`

- `DB_NOT_FOUND`, `MISSION_INVALID_STATE`, `SESSION_NOT_ACTIVE`

---

### 4. LLM Formatting Pattern

Every tool has a companion `formatXxxForLLM()` function for human-readable output.

```typescript
export function formatMissionStartForLLM(result: CmosToolResult<MissionStartResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to start mission', '', `Error: ${error?.message}`];

    if (error?.currentState) lines.push(`Current status: ${error.currentState}`);
    if (error?.validTransitions?.length) {
      lines.push(`Valid transitions: ${error.validTransitions.join(', ')}`);
    }
    if (error?.suggestion) lines.push('', `Suggestion: ${error.suggestion}`);

    return lines.join('\n');
  }

  const data = result.data;
  return [
    `✓ Mission '${data.missionId}' started`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Started at: ${data.startedAt}`,
  ].join('\n');
}
```

**Conventions:**

- Use `✓` for success, `❌` for failure
- Include actionable suggestions on errors
- Show state transitions when relevant
- Keep output concise but informative

---

### 5. Tool Definition Pattern

Each tool exports a definition object matching MCP's tool schema.

```typescript
export const cmosMissionStartToolDefinition = {
  name: 'cmos_mission_start',
  description:
    'Start a mission by transitioning it to In Progress status. ' +
    'Valid from Queued or Current status. ' +
    'Returns INVALID_STATE_TRANSITION error with valid_transitions if the mission cannot be started.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to start (e.g., "s12-m06")',
      },
      notes: {
        type: 'string',
        description: 'Optional notes about why this mission is being started',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for CMOS database (defaults to cwd)',
      },
    },
    required: ['missionId'],
    additionalProperties: false,
  },
} as const;
```

**Tool Definition Conventions:**

- Description includes error behavior
- Use `as const` for type safety
- Include `projectRoot` on all CMOS tools
- Set `additionalProperties: false`

---

### 6. State Machine Pattern

Mission status transitions are enforced by a predefined state machine.

```typescript
export const VALID_STATE_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  Queued: ['Current', 'In Progress'],
  Current: ['In Progress', 'Blocked'],
  'In Progress': ['Completed', 'Blocked'],
  Completed: [], // Terminal state
  Blocked: ['In Progress', 'Current'],
};
```

**Validation in tools:**

```typescript
const validTransitions = VALID_STATE_TRANSITIONS[currentStatus];
if (!validTransitions.includes(targetStatus)) {
  return createError(CmosErrors.missionInvalidTransition(missionId, currentStatus, targetStatus));
}
```

---

### 7. Barrel Export Pattern

Each module uses a barrel `index.ts` for clean imports.

```typescript
// src/tools/cmos/index.ts

// Types
export type { CmosToolResult, Mission, Sprint } from './types';

// Error utilities
export { CMOS_ERROR_CODES, createError, createSuccess, CmosErrors } from './errors';

// Tools - grouped by category
export { cmosMissionStart, formatMissionStartForLLM } from './cmos-mission-start';
export { cmosMissionComplete, formatMissionCompleteForLLM } from './cmos-mission-complete';
// ... etc

// Aggregated tool definitions
export const CMOS_TOOL_DEFINITIONS = [
  missionListTool,
  missionShowTool,
  // ... etc
] as const;
```

**Import in main:**

```typescript
import {
  CMOS_TOOL_DEFINITIONS,
  cmosDbHealth,
  formatHealthForLLM,
  // ...
} from './tools/cmos';
```

---

### 8. Zod Schema Pattern

Parameter validation uses Zod for runtime type checking.

```typescript
export const cmosMissionStartSchema = z.object({
  missionId: z.string().min(1).describe('The mission ID to start'),
  notes: z.string().optional().describe('Optional notes'),
  projectRoot: z.string().optional().describe('Project root directory'),
});

export type CmosMissionStartParams = z.infer<typeof cmosMissionStartSchema>;
```

**Note:** Zod schemas are defined alongside tool implementations but MCP uses inputSchema objects for tool registration.

---

## Database Patterns

### 1. Statement Caching

Prepared statements are cached for performance.

```typescript
private statementCache: Map<string, Statement> = new Map();

private prepareStatement(sql: string): Statement {
  let stmt = this.statementCache.get(sql);
  if (!stmt) {
    stmt = this.db!.prepare(sql);
    this.statementCache.set(sql, stmt);
  }
  return stmt;
}
```

### 2. Query Methods

```typescript
// Single row
client.getOne<Mission>('SELECT * FROM missions WHERE id = ?', [id]);

// Multiple rows
client.getMany<Mission>('SELECT * FROM missions WHERE status = ?', ['In Progress']);

// Mutations
client.execute('UPDATE missions SET status = ? WHERE id = ?', ['Completed', id]);

// Transactions
client.transaction(() => {
  client.execute(...);
  client.execute(...);
});
```

### 3. Safe Count Pattern

```typescript
private safeCount(tableName: string): number {
  try {
    const row = this.db!.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get();
    return (row as { count: number }).count;
  } catch {
    return 0;  // Table might not exist
  }
}
```

### 4. JSON Field Pattern

Arrays and objects stored as JSON strings in SQLite.

```typescript
// Writing
const successCriteria = JSON.stringify(['Criterion 1', 'Criterion 2']);
client.execute('INSERT INTO missions (..., success_criteria) VALUES (..., ?)', [..., successCriteria]);

// Reading
const mission = client.getOne<Mission>(...);
const criteria = JSON.parse(mission.success_criteria ?? '[]');
```

---

## Naming Conventions

### File Names

- Tool files: `cmos-{entity}-{action}.ts` (e.g., `cmos-mission-start.ts`)
- Type files: `types.ts`
- Error files: `errors.ts`
- Index files: `index.ts`

### Function Names

- Tool functions: `cmos{Entity}{Action}` (e.g., `cmosMissionStart`)
- Formatters: `format{Entity}{Action}ForLLM` (e.g., `formatMissionStartForLLM`)
- Tool definitions: `cmos{Entity}{Action}ToolDefinition`

### Type Names

- Params: `Cmos{Entity}{Action}Params`
- Results: `{Entity}{Action}Result`
- DB records: `Mission`, `Sprint`, `Session` (no prefix)

### Error Codes

- Format: `{ENTITY}_{ERROR_TYPE}`
- All caps with underscores
- Examples: `MISSION_NOT_FOUND`, `DB_CONNECTION_FAILED`

---

## Testing Patterns

### 1. Mock Client Pattern

```typescript
const mockClient = {
  getOne: jest.fn(),
  getMany: jest.fn(),
  execute: jest.fn(),
  close: jest.fn(),
};

jest.mock('./client', () => ({
  withClient: jest.fn((fn) => fn(mockClient)),
}));
```

### 2. Result Testing

```typescript
it('returns error when mission not found', async () => {
  mockClient.getOne.mockReturnValue(createSuccess(undefined));

  const result = await cmosMissionStart({ missionId: 'x' });

  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('MISSION_NOT_FOUND');
});
```

---

## Performance Patterns

### 1. Lazy Tokenizer Loading

```typescript
// Tokenizers loaded on first use, not at startup
export async function ensureTokenizersReady(): Promise<void> {
  // Preload with graceful fallback
}
```

### 2. Caching with TTL

```typescript
// CmosDetector caches detection results
const detector = CmosDetector.getInstance({ cacheTtlMs: 60_000 });
```

### 3. WAL Mode

```typescript
// Enabled on connection for concurrent access
this.db.pragma('journal_mode = WAL');
```

---

## Security Patterns

### 1. Parameterized Queries

Never use string interpolation for SQL:

```typescript
// Good
client.getOne('SELECT * FROM missions WHERE id = ?', [id]);

// Bad - SQL injection risk
client.getOne(`SELECT * FROM missions WHERE id = '${id}'`);
```

### 2. Path Validation

```typescript
export class SecureYAMLLoader {
  constructor(options: { baseDir: string; followSymlinks: boolean; maxFileSize: number }) {
    // Validates paths stay within baseDir
  }
}
```

### 3. Project Root Validation

```typescript
// Warns when using cmos-mcp's own database
const sourceCheck = checkCmosMcpSourceDatabase(dbPath);
if (sourceCheck.isCmosMcpSource) {
  warnings.push('WARNING: Connected to cmos-mcp source database...');
}
```

---

## Related Documents

- [Architecture](./cmos-mcp-architecture.md) - System architecture and components
- [Tool Catalog](./cmos-mcp-tool-catalog.md) - Complete tool inventory
