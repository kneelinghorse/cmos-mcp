# Project Registry Migration Guide

This guide helps existing CMOS-MCP users migrate to the new Project Registry system introduced in Sprint 15.

## What Changed?

### Before: Environment Variable Requirement

Previously, CMOS-MCP required the `CMOS_PROJECT_ROOT` environment variable to locate your project:

```bash
# Old approach - environment variable required
export CMOS_PROJECT_ROOT=/Users/you/projects/my-project
```

If this wasn't set and `process.cwd()` pointed to the wrong directory (common in MCP server contexts), operations could silently affect the wrong database.

### After: Persistent Project Registry

The new Project Registry provides intelligent project resolution with automatic fallback:

1. **Explicit `projectRoot` parameter** - Always works
2. **`CMOS_PROJECT_ROOT` environment variable** - Still supported
3. **Auto-discovery from CWD** - Automatically detects and registers projects
4. **Registry default project** - Falls back to last registered default
5. **Actionable error messages** - Clear guidance when no project found

## Migration Steps

### Step 1: Update CMOS-MCP

Ensure you have the latest CMOS-MCP version:

```bash
cd /path/to/cmos-mcp
git pull
npm install
npm run build
```

### Step 2: Register Your Project(s)

For each project you work with, register it using the new tool:

```json
{
  "tool": "cmos_project_register",
  "arguments": {
    "projectRoot": "/Users/you/projects/my-project",
    "name": "My Project",
    "setAsDefault": true
  }
}
```

Or let auto-discovery handle it - when you run any CMOS tool from your project directory, it will be automatically registered.

### Step 3: Verify Registration

Check that your projects are registered:

```json
{
  "tool": "cmos_project_list",
  "arguments": {}
}
```

Expected output:

```
📋 Registered Projects (1)

   My Project (default)
   └─ /Users/you/projects/my-project
```

### Step 4: Remove Environment Variable (Optional)

If you were using `CMOS_PROJECT_ROOT`, you can now remove it:

```bash
# Remove from your shell config (.bashrc, .zshrc, etc.)
# unset CMOS_PROJECT_ROOT
```

The environment variable still works but is no longer required for most workflows.

### Step 5: Validate Projects

Run validation to ensure all registered projects are healthy:

```json
{
  "tool": "cmos_project_validate",
  "arguments": {}
}
```

Expected output for healthy projects:

```
✓ Validation Complete

   Active: 1  |  Stale: 0  |  Missing: 0

Active Projects:
   ✓ My Project
```

## Troubleshooting

### "No CMOS project found" Error

If you see this error:

```
No CMOS project found. This appears to be your first time using CMOS-MCP.

Solutions:
  1. Run from a project directory (must contain cmos/db/cmos.sqlite)
  2. Pass projectRoot parameter explicitly
  3. Set CMOS_PROJECT_ROOT environment variable
  4. Use: cmos_project_register /path/to/your/project
```

**Solution**: Register your project explicitly:

```json
{
  "tool": "cmos_project_register",
  "arguments": {
    "projectRoot": "/path/to/your/project",
    "setAsDefault": true
  }
}
```

### Stale or Missing Projects

If validation shows stale or missing projects:

```
⚠️ Validation Complete

   Active: 1  |  Stale: 1  |  Missing: 1

Stale Projects (CMOS database missing):
   ⚠️ Old Project
      /path/to/old-project

Missing Projects (directory not found):
   ❌ Deleted Project
      /path/to/deleted-project
```

**Solution**: Prune invalid entries:

```json
{
  "tool": "cmos_project_validate",
  "arguments": {
    "prune": true
  }
}
```

### Wrong Project Being Used

If operations are affecting the wrong project:

1. Check which project is default:

   ```json
   { "tool": "cmos_project_list", "arguments": {} }
   ```

2. Set the correct default:

   ```json
   {
     "tool": "cmos_project_register",
     "arguments": {
       "projectRoot": "/path/to/correct/project",
       "setAsDefault": true
     }
   }
   ```

3. Or pass `projectRoot` explicitly on each call:
   ```json
   {
     "tool": "cmos_mission_list",
     "arguments": {
       "projectRoot": "/path/to/correct/project"
     }
   }
   ```

### Claude Desktop Not Finding Project

Claude Desktop doesn't have a working directory context. You must:

1. Register your project with `setAsDefault: true`
2. Or pass `projectRoot` explicitly on each tool call

## Breaking Changes

### Return Type Change (Internal)

The internal `resolveProjectRoot()` function now returns a `ProjectResolutionResult` object instead of a plain string. This is handled internally and shouldn't affect users.

### Error Messages

Error messages when no project is found have been improved and now include actionable suggestions. If you have automation that parses error messages, you may need to update it.

## New Tools Reference

### cmos_project_register

Register a project in the persistent registry.

| Parameter      | Type    | Required | Description                            |
| -------------- | ------- | -------- | -------------------------------------- |
| `projectRoot`  | string  | Yes      | Absolute path to project directory     |
| `name`         | string  | No       | Display name for the project           |
| `setAsDefault` | boolean | No       | Set as default for fallback resolution |

### cmos_project_list

List all registered projects. No parameters.

### cmos_project_unregister

Remove a project from the registry.

| Parameter     | Type   | Required | Description                        |
| ------------- | ------ | -------- | ---------------------------------- |
| `projectRoot` | string | Yes      | Absolute path to project to remove |

### cmos_project_validate

Validate all registered projects.

| Parameter | Type    | Required | Description                           |
| --------- | ------- | -------- | ------------------------------------- |
| `prune`   | boolean | No       | Remove stale/missing projects if true |

## Registry File Location

The registry is stored at:

```
~/.config/cmos-mcp/project-registry.json
```

You can safely delete this file to reset the registry - projects will be auto-discovered again when you run CMOS tools from project directories.

## FAQ

**Q: Do I need to change my existing workflows?**
A: No, existing workflows continue to work. The registry is additive and provides better fallback behavior.

**Q: Can I have multiple projects?**
A: Yes, register multiple projects and use `projectRoot` to specify which one to use.

**Q: What happens if I delete a project directory?**
A: The registry entry becomes "missing". Use `cmos_project_validate(prune: true)` to clean it up.

**Q: Is the registry shared across machines?**
A: No, each machine has its own registry at `~/.config/cmos-mcp/project-registry.json`.

---

**Version**: 1.0
**Last Updated**: 2026-01-16
