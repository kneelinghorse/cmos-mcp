# API Naming Convention

This guide defines the canonical naming scheme for Mission Protocol MCP tools and exported functions. Apply these rules to every public API surface so that clients can predict behavior from a name alone.

## Core Principles

- **Lower snake case for tool identifiers**: All MCP tool names use `lower_snake_case`.
- **Lower camel case for TypeScript exports**: Functions, classes, and constants exported from TypeScript modules use `lowerCamelCase` or `UpperCamelCase` per language conventions.
- **Verb-noun structure**: Names follow `<verb>_<object>[_qualifier]` for tools and `<verb><Object>` for functions.
- **Canonical action verbs**: Prefer `get`, `set`, `create`, `delete` as the first token. Additional domain verbs are allowed only when they map back to one of these action families.
- **Single responsibility**: A name must describe exactly one action. Chain operations require separate APIs.
- **Status qualifiers**: Optional suffixes such as `_preview`, `_dry_run`, or `_batch` communicate execution context.

## Verb Families

| Action family | Primary verb | Purpose                                                         | Additional allowed verbs                                                      |
| ------------- | ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Retrieval     | `get`        | Returns data, reports, or analysis results without side effects | `fetch`, `read`, `render` (must alias to a `get_*` tool)                      |
| Mutation      | `update`     | Updates existing state in-place                                 | `set`, `patch` (may be provided as aliases to maintain compatibility)         |
| Creation      | `create`     | Produces a new resource or file                                 | `import`, `register`, `generate`, `combine` (must alias to a `create_*` tool) |
| Deletion      | `delete`     | Removes a resource                                              | `remove`, `unregister` (must alias to a `delete_*` tool)                      |

When an alternate verb (e.g., `import`) is necessary for clarity, expose it as a thin alias that forwards to the canonical `create_*` or `get_*` implementation and emit a deprecation warning until clients migrate.

## Tool Naming Patterns

- **Retrieval tools** → `get_<object>` (e.g., `get_available_domains`, `get_dependency_analysis`).
- **Creation tools** → `create_<object>` (e.g., `create_mission`, `create_combined_pack`).
- **Update tools** → `update_<object>` (alias `set_<object>` when legacy compatibility is needed).
- **Deletion tools** → `delete_<object>` (future work; no current tools).

## Function Naming Patterns

- Exported functions mirror the tool verb families but retain camel case (e.g., `getMissionQualityScore`, `createCombinedPack`).
- Factory helpers and classes use nouns describing the resulting type (e.g., `MissionProtocolContext`, `PackCombiner`).
- Deprecated exports keep their original name with an inline `@deprecated` JSDoc tag referencing the replacement.

## Examples

| Category  | Old name                    | New canonical name          | Notes                                                  |
| --------- | --------------------------- | --------------------------- | ------------------------------------------------------ |
| Retrieval | `list_available_domains`    | `get_available_domains`     | Standardizes on `get` for read-only access.            |
| Retrieval | `analyze_dependencies`      | `get_dependency_analysis`   | Analysis results are delivered via the `get_*` prefix. |
| Retrieval | `score_quality`             | `get_mission_quality_score` | Communicates metric retrieval.                         |
| Retrieval | `suggest_splits`            | `get_split_suggestions`     | Suggestion lists are read-only outputs.                |
| Creation  | `combine_packs`             | `create_combined_pack`      | Combining packs generates a new artifact.              |
| Creation  | `split_mission`             | `create_mission_splits`     | Splitting emits new mission files.                     |
| Creation  | `import_template`           | `create_template_import`    | Importing registers a new template in the system.      |
| Creation  | `register_template_version` | `create_template_version`   | Registration is treated as creation.                   |
| Update    | `optimize_tokens`           | `update_token_optimization` | Optimization mutates files on disk.                    |

## Deprecation Policy

1. Introduce the canonical `get|set|create|delete` name.
2. Retain the legacy alias for one minor release with a `[DEPRECATED]` prefix in the description.
3. Emit a runtime warning the first time a deprecated alias executes during a process lifetime.
4. Update all documentation, samples, and tests immediately.
5. Remove the deprecated alias in the next major release after providing at least one release cycle of overlap.

## Implementation Checklist

- [ ] Add canonical tool definitions that follow this convention.
- [ ] Register legacy aliases with warnings.
- [ ] Update switch statements, tests, and command references.
- [ ] Document migration paths in release notes and user guides.

Adhering to this convention keeps the Mission Protocol tool surface predictable and self-descriptive for both automation and operator workflows.
