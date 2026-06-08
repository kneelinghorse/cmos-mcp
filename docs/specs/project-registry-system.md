# Project Registry System - Technical Specification

**Version**: 1.0
**Status**: Draft
**Created**: 2026-01-15
**Author**: CMOS-MCP Team

---

## Executive Summary

The Project Registry System solves the cross-project contamination problem in CMOS-MCP by providing explicit, validated project resolution. It replaces the dangerous `process.cwd()` fallback with a persistent registry of known CMOS projects, enabling Claude Desktop compatibility and multi-project workflows.

**Key Benefits**:

- Eliminates MCP server directory contamination (10% of operations hitting wrong database)
- Enables Claude Desktop support (no CWD context)
- Supports multi-project workflows with explicit project selection
- Auto-discovers projects with user visibility
- Validates database integrity before use

---

## Problem Statement

### Current Issues

1. **Dangerous Fallback**: `process.cwd()` returns MCP server directory (`/Users/kneelinghorse/projects/cmos-mcp`) instead of user's project
2. **Claude Desktop Incompatibility**: No CWD context, can't auto-discover projects
3. **Cross-Project Contamination**: ~10% of operations hit wrong database
4. **Poor Error Messages**: Silent failures when project not found

### Root Cause

Current resolution in `client.ts:44-46`:

```typescript
export function resolveProjectRoot(explicitRoot?: string): string {
  return explicitRoot ?? process.env[CMOS_PROJECT_ROOT_ENV] ?? process.cwd();
}
```

The `process.cwd()` fallback **assumes the agent is running in the user's project**, but this is false when:

- MCP server runs in its own directory
- Claude Desktop has no CWD context
- Agent operates across multiple projects

---

## Solution Overview

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ CMOS Tool Call (e.g., cmos_mission_list)                   │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ resolveProjectRoot()                                        │
│  1. Explicit projectRoot param? → Use it                   │
│  2. CMOS_PROJECT_ROOT env var? → Use it                    │
│  3. CWD has cmos/db/cmos.sqlite? → Auto-discover & register│
│  4. Registry has default project? → Validate & use         │
│  5. Error with actionable message                          │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ ProjectRegistry (Persistent State)                         │
│  - Load from ~/.config/cmos-mcp/project-registry.json     │
│  - Validate entry (DB exists, project_id matches)          │
│  - Return validated project path                           │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

1. **ProjectRegistry** - Persistent project tracking
2. **resolveProjectRoot()** - Enhanced resolution with registry fallback
3. **MCP Tools** - User-facing project management (register, list, validate)
4. **Validation Layer** - Stale entry detection and cleanup

---

## Detailed Design

### 1. Registry Schema

**File Location**: `~/.config/cmos-mcp/project-registry.json`

**Why not `~/.cmos/`?**

- MCP servers should use their own data directory
- Avoids conflicts with other tools
- Standard XDG config location

**Schema** (v1.0):

```json
{
  "version": "1.0",
  "defaultProjectId": "mac-studio-llm",
  "projects": [
    {
      "id": "mac-studio-llm",
      "name": "Mac Studio LLM",
      "path": "/Users/mac-studio/projects",
      "databasePath": "/Users/mac-studio/projects/cmos/db/cmos.sqlite",
      "projectId": "mac-studio-llm",
      "created": "2026-01-15T10:00:00Z",
      "lastAccessed": "2026-01-15T10:45:00Z",
      "lastValidated": "2026-01-15T10:45:00Z",
      "autoDiscovered": true,
      "status": "active"
    },
    {
      "id": "cmos-mcp-dev",
      "name": "CMOS-MCP Development",
      "path": "/Users/kneelinghorse/projects/cmos-mcp",
      "databasePath": "/Users/kneelinghorse/projects/cmos-mcp/cmos/db/cmos.sqlite",
      "projectId": "cmos-mcp-dev",
      "created": "2026-01-12T08:00:00Z",
      "lastAccessed": "2026-01-15T09:30:00Z",
      "lastValidated": "2026-01-15T09:30:00Z",
      "autoDiscovered": false,
      "status": "active"
    }
  ]
}
```

**Field Definitions**:

- `id`: Unique identifier (slug format, derived from project name or path)
- `name`: Human-readable project name
- `path`: Absolute path to project root
- `databasePath`: Absolute path to cmos.sqlite (for fast validation)
- `projectId`: Value from `metadata.project_id` in database (optional)
- `created`: ISO 8601 timestamp of first registration
- `lastAccessed`: ISO 8601 timestamp of last use
- `lastValidated`: ISO 8601 timestamp of last validation check
- `autoDiscovered`: Boolean - true if auto-registered, false if manual
- `status`: Enum - `active` | `stale` | `missing`

**Status Values**:

- `active`: Database exists and project_id matches (if set)
- `stale`: Database exists but project_id mismatch
- `missing`: Database file not found

---

### 2. ProjectRegistry Class

**Location**: `src/intelligence/project-registry.ts`

**Interface**:

```typescript
export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  databasePath: string;
  projectId?: string;
  created: string;
  lastAccessed: string;
  lastValidated: string;
  autoDiscovered: boolean;
  status: 'active' | 'stale' | 'missing';
}

export interface RegistryData {
  version: string;
  defaultProjectId?: string;
  projects: ProjectEntry[];
}

export class ProjectRegistry {
  private data: RegistryData;
  private registryPath: string;
  private static instance: ProjectRegistry | null = null;

  /**
   * Get singleton instance
   */
  static getInstance(): ProjectRegistry;

  /**
   * Register a new project (or update existing)
   * @param projectPath - Absolute path to project root
   * @param options - Registration options
   * @returns ProjectEntry
   */
  register(
    projectPath: string,
    options?: {
      name?: string;
      autoDiscovered?: boolean;
      setAsDefault?: boolean;
    }
  ): ProjectEntry;

  /**
   * Unregister a project
   * @param projectId - Project ID to remove
   * @returns boolean - true if removed, false if not found
   */
  unregister(projectId: string): boolean;

  /**
   * Get project by ID
   * @param projectId - Project ID
   * @returns ProjectEntry or undefined
   */
  getProject(projectId: string): ProjectEntry | undefined;

  /**
   * Get project by path
   * @param projectPath - Project path
   * @returns ProjectEntry or undefined
   */
  getProjectByPath(projectPath: string): ProjectEntry | undefined;

  /**
   * Get default project
   * @returns ProjectEntry or undefined
   */
  getDefault(): ProjectEntry | undefined;

  /**
   * Set default project
   * @param projectId - Project ID to set as default
   */
  setDefault(projectId: string): void;

  /**
   * List all projects
   * @param options - Filter options
   * @returns Array of ProjectEntry
   */
  list(options?: {
    status?: 'active' | 'stale' | 'missing';
    includeStale?: boolean;
  }): ProjectEntry[];

  /**
   * Validate a project entry (check DB exists, project_id matches)
   * Updates entry status and lastValidated timestamp
   * @param projectId - Project ID to validate
   * @returns Validation result with details
   */
  validate(projectId: string): {
    valid: boolean;
    status: 'active' | 'stale' | 'missing';
    reason?: string;
  };

  /**
   * Validate all entries (cleanup stale/missing)
   * @returns Summary of validation results
   */
  validateAll(): {
    active: number;
    stale: number;
    missing: number;
    total: number;
  };

  /**
   * Record project access (updates lastAccessed)
   * @param projectId - Project ID
   */
  recordAccess(projectId: string): void;

  /**
   * Save registry to disk
   */
  private save(): void;

  /**
   * Load registry from disk
   */
  private load(): void;
}
```

---

### 3. Enhanced resolveProjectRoot()

**Location**: `src/tools/cmos/client.ts`

**Current Implementation** (client.ts:44-46):

```typescript
export function resolveProjectRoot(explicitRoot?: string): string {
  return explicitRoot ?? process.env[CMOS_PROJECT_ROOT_ENV] ?? process.cwd();
}
```

**New Implementation**:

```typescript
import { ProjectRegistry } from '../../intelligence/project-registry';
import path from 'path';
import fs from 'fs';

export interface ProjectResolutionResult {
  projectRoot: string;
  source: 'explicit' | 'env' | 'auto-discover' | 'registry';
  registered: boolean;
}

/**
 * Resolve project root with registry fallback
 *
 * Priority order:
 * 1. Explicit projectRoot parameter
 * 2. CMOS_PROJECT_ROOT environment variable
 * 3. Auto-discover from CWD (if cmos/db/cmos.sqlite exists)
 * 4. Registry default project
 * 5. Error with actionable message
 *
 * @param explicitRoot - Explicitly provided project root
 * @returns ProjectResolutionResult
 * @throws Error if no project can be resolved
 */
export function resolveProjectRoot(explicitRoot?: string): ProjectResolutionResult {
  const registry = ProjectRegistry.getInstance();

  // 1. Explicit parameter (highest trust)
  if (explicitRoot) {
    const entry = registry.getProjectByPath(explicitRoot);
    if (entry) {
      registry.recordAccess(entry.id);
    }
    return {
      projectRoot: explicitRoot,
      source: 'explicit',
      registered: !!entry,
    };
  }

  // 2. Environment variable (CI/CD, explicit config)
  const envRoot = process.env[CMOS_PROJECT_ROOT_ENV];
  if (envRoot) {
    const entry = registry.getProjectByPath(envRoot);
    if (entry) {
      registry.recordAccess(entry.id);
    }
    return {
      projectRoot: envRoot,
      source: 'env',
      registered: !!entry,
    };
  }

  // 3. Auto-discovery from CWD (90% case for VSCode/Claude Code)
  const cwd = process.cwd();
  const dbPath = path.join(cwd, 'cmos', 'db', 'cmos.sqlite');

  if (fs.existsSync(dbPath)) {
    // Auto-register if new
    let entry = registry.getProjectByPath(cwd);
    if (!entry) {
      console.log(`📍 New CMOS project discovered: ${cwd}`);
      console.log(`   Database: ${dbPath}`);
      console.log(`   Auto-registering for future use...`);

      entry = registry.register(cwd, {
        autoDiscovered: true,
        setAsDefault: true, // First discovered project becomes default
      });
    } else {
      registry.recordAccess(entry.id);
    }

    return {
      projectRoot: cwd,
      source: 'auto-discover',
      registered: true,
    };
  }

  // 4. Registry default project (Claude Desktop fallback)
  const defaultProject = registry.getDefault();
  if (defaultProject) {
    const validation = registry.validate(defaultProject.id);

    if (validation.valid) {
      registry.recordAccess(defaultProject.id);
      return {
        projectRoot: defaultProject.path,
        source: 'registry',
        registered: true,
      };
    }

    // Default project is stale/missing - try to find any active project
    const activeProjects = registry.list({ status: 'active' });
    if (activeProjects.length > 0) {
      const fallback = activeProjects[0];
      registry.recordAccess(fallback.id);
      return {
        projectRoot: fallback.path,
        source: 'registry',
        registered: true,
      };
    }
  }

  // 5. Error with actionable message
  const registeredCount = registry.list().length;
  const errorMessage =
    registeredCount > 0
      ? `No CMOS project found in current directory. You have ${registeredCount} registered project(s).\n\n` +
        `Solutions:\n` +
        `  1. Run from a project directory (must contain cmos/db/cmos.sqlite)\n` +
        `  2. Pass projectRoot parameter explicitly\n` +
        `  3. Set CMOS_PROJECT_ROOT environment variable\n` +
        `  4. Use: cmos_project_list to see registered projects\n` +
        `  5. Use: cmos_project_register to add a project`
      : `No CMOS project found. This appears to be your first time using CMOS-MCP.\n\n` +
        `Solutions:\n` +
        `  1. Run from a project directory (must contain cmos/db/cmos.sqlite)\n` +
        `  2. Pass projectRoot parameter explicitly\n` +
        `  3. Set CMOS_PROJECT_ROOT environment variable\n` +
        `  4. Use: cmos_project_register /path/to/your/project`;

  throw new Error(errorMessage);
}

/**
 * Backward-compatible version that returns just the string
 * (for existing code that expects string return type)
 */
export function resolveProjectRootPath(explicitRoot?: string): string {
  const result = resolveProjectRoot(explicitRoot);
  return result.projectRoot;
}
```

**Breaking Change Mitigation**:

- Keep old function name but update internals
- Add new `resolveProjectRootPath()` for backward compatibility
- Update all callsites in phases

---

### 4. MCP Tools for Project Management

#### 4.1 cmos_project_register

**Purpose**: Register a CMOS project for future use

**Input**:

```typescript
{
  projectRoot: string;        // Absolute path to project
  name?: string;             // Optional display name
  setAsDefault?: boolean;    // Set as default project
}
```

**Output**:

```typescript
{
  success: true,
  data: {
    id: "mac-studio-llm",
    name: "Mac Studio LLM",
    path: "/Users/mac-studio/projects",
    databasePath: "/Users/mac-studio/projects/cmos/db/cmos.sqlite",
    projectId: "mac-studio-llm",
    status: "active",
    isDefault: true
  }
}
```

**Error Cases**:

- `CMOS_NOT_DETECTED`: No cmos/ directory found
- `DB_NOT_FOUND`: No cmos/db/cmos.sqlite found
- `INVALID_PARAMETER`: Invalid path format

---

#### 4.2 cmos_project_list

**Purpose**: List all registered projects

**Input**:

```typescript
{
  includeStale?: boolean;    // Include stale/missing projects
  validateAll?: boolean;     // Validate all entries before listing
}
```

**Output**:

```typescript
{
  success: true,
  data: {
    projects: [
      {
        id: "mac-studio-llm",
        name: "Mac Studio LLM",
        path: "/Users/mac-studio/projects",
        status: "active",
        isDefault: true,
        lastAccessed: "2026-01-15T10:45:00Z"
      }
    ],
    summary: {
      total: 2,
      active: 2,
      stale: 0,
      missing: 0
    }
  }
}
```

---

#### 4.3 cmos_project_unregister

**Purpose**: Remove a project from the registry

**Input**:

```typescript
{
  projectId: string; // Project ID to remove
}
```

**Output**:

```typescript
{
  success: true,
  data: {
    removed: true,
    projectId: "old-project"
  }
}
```

---

#### 4.4 cmos_project_validate

**Purpose**: Validate all registered projects (cleanup stale entries)

**Input**: None

**Output**:

```typescript
{
  success: true,
  data: {
    validated: 5,
    active: 3,
    stale: 1,
    missing: 1,
    details: [
      {
        id: "stale-project",
        status: "stale",
        reason: "project_id mismatch: registry has 'old-id', database has 'new-id'"
      },
      {
        id: "missing-project",
        status: "missing",
        reason: "Database not found at path"
      }
    ]
  }
}
```

---

### 5. Validation Logic

**validateProjectEntry()** (in ProjectRegistry):

```typescript
private validateProjectEntry(entry: ProjectEntry): {
  valid: boolean;
  status: 'active' | 'stale' | 'missing';
  reason?: string;
} {
  // Check if database exists
  if (!fs.existsSync(entry.databasePath)) {
    entry.status = 'missing';
    entry.lastValidated = new Date().toISOString();
    this.save();

    return {
      valid: false,
      status: 'missing',
      reason: `Database not found at ${entry.databasePath}`
    };
  }

  // If entry has project_id, validate it matches database
  if (entry.projectId) {
    try {
      const db = new Database(entry.databasePath, { readonly: true });
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?')
        .get('project_id') as { value: string } | undefined;
      db.close();

      const dbProjectId = row?.value;

      if (dbProjectId && dbProjectId !== entry.projectId) {
        entry.status = 'stale';
        entry.lastValidated = new Date().toISOString();
        this.save();

        return {
          valid: false,
          status: 'stale',
          reason: `project_id mismatch: registry has "${entry.projectId}", database has "${dbProjectId}"`
        };
      }
    } catch (error) {
      // Can't read database - mark as stale
      entry.status = 'stale';
      entry.lastValidated = new Date().toISOString();
      this.save();

      return {
        valid: false,
        status: 'stale',
        reason: `Database validation failed: ${error}`
      };
    }
  }

  // All checks passed
  entry.status = 'active';
  entry.lastValidated = new Date().toISOString();
  this.save();

  return {
    valid: true,
    status: 'active'
  };
}
```

---

## Implementation Plan

### Sprint Structure

**Estimate**: 2-3 sessions (6-8 hours total)

**Sprint**: Sprint 15 - "Project Registry & Multi-Project Support"

### Mission Breakdown

#### s15-m01: Core Registry Infrastructure (2-3 hours)

**Objective**: Implement ProjectRegistry class with persistence

**Tasks**:

1. Create `src/intelligence/project-registry.ts`
2. Implement schema (v1.0) with type definitions
3. Implement CRUD operations (register, unregister, list, get)
4. Implement persistence (load/save JSON)
5. Implement validation logic
6. Add singleton pattern
7. Write unit tests (50+ tests)

**Success Criteria**:

- ProjectRegistry class complete with all methods
- Unit tests pass (coverage > 90%)
- Can register, list, validate projects
- Handles stale/missing entries correctly

**Deliverables**:

- `src/intelligence/project-registry.ts` (~400 lines)
- `tests/intelligence/project-registry.test.ts` (~300 lines)

---

#### s15-m02: Enhanced Project Resolution (1-2 hours)

**Objective**: Update resolveProjectRoot() to use registry

**Tasks**:

1. Update `resolveProjectRoot()` in `src/tools/cmos/client.ts`
2. Implement 5-step resolution priority
3. Add auto-discovery with console feedback
4. Add backward-compatible `resolveProjectRootPath()`
5. Update error messages with actionable guidance
6. Write integration tests

**Success Criteria**:

- Resolution follows priority order correctly
- Auto-discovery works and registers new projects
- Registry fallback works (Claude Desktop scenario)
- Clear error messages when no project found
- All existing tests still pass

**Deliverables**:

- Updated `src/tools/cmos/client.ts` (~100 lines changed)
- `tests/tools/cmos/project-resolution.test.ts` (~200 lines)

---

#### s15-m03: Project Management MCP Tools (2-3 hours)

**Objective**: Implement user-facing project management tools

**Tasks**:

1. Implement `cmos_project_register` tool
2. Implement `cmos_project_list` tool
3. Implement `cmos_project_unregister` tool
4. Implement `cmos_project_validate` tool
5. Add tool definitions (MCP schemas)
6. Wire tools in `src/index.ts`
7. Write comprehensive tests

**Success Criteria**:

- 4 new MCP tools working end-to-end
- Can register projects via MCP
- Can list/validate/unregister projects
- All tools follow CmosToolResult pattern
- Integration tests pass

**Deliverables**:

- `src/tools/cmos/cmos-project-register.ts` (~150 lines)
- `src/tools/cmos/cmos-project-list.ts` (~150 lines)
- `src/tools/cmos/cmos-project-unregister.ts` (~100 lines)
- `src/tools/cmos/cmos-project-validate.ts` (~150 lines)
- `tests/tools/cmos/cmos-project-*.test.ts` (~400 lines total)

---

#### s15-m04: Documentation & Migration Guide (1 hour)

**Objective**: Document the registry system and provide migration guidance

**Tasks**:

1. Update `agents.md` with registry usage
2. Create migration guide for existing users
3. Update tool documentation
4. Add troubleshooting guide
5. Update README with registry examples

**Success Criteria**:

- Clear documentation of registry system
- Migration guide for existing projects
- Examples of all 4 project management tools
- Troubleshooting section for common issues

**Deliverables**:

- Updated `agents.md`
- `docs/migration/registry-migration-guide.md`
- Updated tool docs

---

## Testing Strategy

### Unit Tests

**ProjectRegistry**:

- ✅ Register new project
- ✅ Register duplicate (update existing)
- ✅ Unregister project
- ✅ Get project by ID
- ✅ Get project by path
- ✅ List projects (all, active only, with stale)
- ✅ Set/get default project
- ✅ Validate project (active)
- ✅ Validate project (stale - project_id mismatch)
- ✅ Validate project (missing - DB not found)
- ✅ Validate all projects
- ✅ Record access (updates lastAccessed)
- ✅ Persistence (save/load)
- ✅ Singleton pattern

**Project Resolution**:

- ✅ Resolve with explicit projectRoot
- ✅ Resolve with CMOS_PROJECT_ROOT env var
- ✅ Auto-discover from CWD
- ✅ Auto-register on discovery
- ✅ Fallback to registry default
- ✅ Error when no project found
- ✅ Skip CWD if no database present
- ✅ Validate registry entry before use

### Integration Tests

**End-to-End Scenarios**:

- ✅ New user first-time setup (auto-discovery)
- ✅ Claude Desktop scenario (registry fallback)
- ✅ Multi-project workflow (explicit projectRoot)
- ✅ Stale entry recovery (re-validation)
- ✅ Cross-project operations

### Edge Cases

- Empty registry (first use)
- Corrupt registry JSON (recovery)
- All projects stale/missing (error handling)
- Project moved to new location (detection)
- Database replaced (project_id mismatch)
- Concurrent access (file locking)

---

## Migration Strategy

### For Existing Users

**No Breaking Changes**:

- Existing code with explicit `projectRoot` → Works unchanged
- Existing code with `CMOS_PROJECT_ROOT` env var → Works unchanged
- New auto-discovery → Additive feature

**Recommended Actions**:

1. Run `cmos_project_validate` to discover current project
2. Review registered projects with `cmos_project_list`
3. Set default project if multiple projects registered
4. Remove `CMOS_PROJECT_ROOT` env var (optional - still supported)

### For New Users

**First-Time Experience**:

1. Agent runs in project directory → Auto-discovers and registers
2. Agent sees console message: "📍 New CMOS project discovered"
3. Project becomes default
4. Future operations use registry

**Claude Desktop Users**:

1. First call: Error with helpful message
2. Use `cmos_project_register /path/to/project`
3. Project registered as default
4. All future calls work automatically

---

## Security Considerations

### Registry Security

**File Permissions**:

- Registry file: `0600` (read/write owner only)
- Registry directory: `0700` (owner access only)

**Validation**:

- Always validate registry entries before use
- Never trust stale entries
- Require confirmation for mutation operations using registry fallback

**Project ID Verification**:

- Use existing `validateProjectId()` mechanism
- Registry validation is additive, not replacement
- Database self-protection still active

### Attack Surface

**Risks**:

1. **Registry Poisoning**: Malicious registry entry points to wrong database
   - **Mitigation**: Validate project_id before mutations

2. **Path Traversal**: Malicious path in registry
   - **Mitigation**: Normalize and validate paths

3. **Race Conditions**: Concurrent registry access
   - **Mitigation**: Atomic save operations, file locking

---

## Performance Considerations

### Registry Operations

**Load Time**: < 5ms (small JSON file)
**Validation Time**: ~50ms per entry (SQLite query)
**Auto-Discovery**: ~10ms (filesystem check)

**Caching**:

- Singleton pattern for in-memory cache
- Lazy validation (only when needed)
- TTL-based revalidation (optional future enhancement)

### Impact on Existing Operations

**Overhead**:

- Explicit projectRoot: +0ms (no change)
- Auto-discovery: +10ms (one-time per session)
- Registry fallback: +50ms (validation)

**Acceptable**: < 100ms for resolution is negligible compared to database operations (1-50ms each)

---

## Future Enhancements

### Phase 2 (Optional)

1. **Project Aliases**: Short names for projects

   ```bash
   cmos_project_alias add mac-studio ms
   # Now can use: projectRoot="ms"
   ```

2. **Project Groups**: Organize related projects

   ```json
   {
     "groups": {
       "work": ["project-a", "project-b"],
       "personal": ["blog", "experiments"]
     }
   }
   ```

3. **Remote Projects**: Registry entries for network databases

   ```json
   {
     "id": "shared-project",
     "type": "remote",
     "connection": "postgresql://host/db"
   }
   ```

4. **Registry Sync**: Multi-machine registry synchronization
   - Cloud-based registry backup
   - Registry merge strategies

5. **MCP Roots Integration**: Leverage MCP protocol's workspace roots
   - Auto-populate registry from MCP roots
   - Validate roots contain CMOS databases

---

## Appendix A: Error Messages

### Clear Error Messages

**No Project Found (Empty Registry)**:

```
No CMOS project found. This appears to be your first time using CMOS-MCP.

Solutions:
  1. Run from a project directory (must contain cmos/db/cmos.sqlite)
  2. Pass projectRoot parameter explicitly
  3. Set CMOS_PROJECT_ROOT environment variable
  4. Use: cmos_project_register /path/to/your/project
```

**No Project Found (Has Registry)**:

```
No CMOS project found in current directory. You have 2 registered project(s).

Solutions:
  1. Run from a project directory (must contain cmos/db/cmos.sqlite)
  2. Pass projectRoot parameter explicitly
  3. Set CMOS_PROJECT_ROOT environment variable
  4. Use: cmos_project_list to see registered projects
  5. Use: cmos_project_register to add a project
```

**Stale Default Project**:

```
Default project 'mac-studio-llm' is stale (database moved or modified).

Solutions:
  1. Run: cmos_project_validate to check all projects
  2. Set a new default: cmos_project_list then select one
  3. Unregister and re-register: cmos_project_register /path/to/project
```

---

## Appendix B: File Locations

```
cmos-mcp/
├── src/
│   ├── intelligence/
│   │   └── project-registry.ts          (NEW - Core registry class)
│   └── tools/cmos/
│       ├── client.ts                    (MODIFIED - Enhanced resolution)
│       ├── cmos-project-register.ts     (NEW - Register tool)
│       ├── cmos-project-list.ts         (NEW - List tool)
│       ├── cmos-project-unregister.ts   (NEW - Unregister tool)
│       └── cmos-project-validate.ts     (NEW - Validate tool)
├── tests/
│   ├── intelligence/
│   │   └── project-registry.test.ts     (NEW - Unit tests)
│   └── tools/cmos/
│       ├── project-resolution.test.ts   (NEW - Integration tests)
│       └── cmos-project-*.test.ts       (NEW - Tool tests)
└── docs/
    ├── specs/
    │   └── project-registry-system.md   (THIS FILE)
    └── migration/
        └── registry-migration-guide.md  (NEW - User guide)

~/.config/cmos-mcp/
└── project-registry.json                (NEW - Persistent registry)
```

---

## Appendix C: Decision Log

### Why Array-Based Registry?

**Rejected**: Object with project ID as key

```json
{
  "projects": {
    "project-1": { ... }
  }
}
```

**Chosen**: Array of projects

```json
{
  "projects": [
    { "id": "project-1", ... }
  ]
}
```

**Reasons**:

1. Allows duplicate names (disambiguate by path)
2. Easier to sort/filter
3. More flexible schema evolution
4. Standard JSON practice for collections

---

### Why Validate Before Registry Fallback?

**Ensures**:

- Database still exists
- project_id hasn't changed
- No silent failures

**Trade-off**:

- +50ms overhead for validation
- Worth it for safety and correctness

---

### Why Console Logging for Auto-Discovery?

**User Visibility**:

- Makes auto-registration transparent
- Users know what's happening
- Builds trust in the system

**Not Intrusive**:

- Only on first discovery
- Single-line, informative
- Clear emoji indicator (📍)

---

## Appendix D: References

- **Session PS-2026-01-12-001**: Original problem investigation
- **Session PS-2026-01-08-001**: First contamination fix attempt
- **Session PS-2026-01-07-001**: Database self-protection implementation
- **client.ts:44-46**: Current `resolveProjectRoot()` implementation
- **MCP Specification**: https://modelcontextprotocol.io/

---

**End of Specification**
