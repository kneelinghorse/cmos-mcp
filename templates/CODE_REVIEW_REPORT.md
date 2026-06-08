# Mission Protocol v2 — Code Review / Current State / Bug Report

**Scope**: Templates, MCP server surface, Intelligence layer (optimizer, splitter, complexity)
**Date**: 2025-10-30

---

## Executive Summary

The system is in strong shape with clear architecture, robust MCP integration, and practical intelligence utilities. Templates are mature with predictable loading/validation. MCP registers canonical tools with deprecation coverage and smoke tests. Intelligence tools (token optimization, split suggestions, mission splitting) are cohesive and instrumented with token usage.

Key improvements focus on validation rigor (hybrid template components), versioning clarity, a few safety hardenings, test additions, and centralizing model/window constants.

- **Overall**: Stable and production-ready.
- **Critical bugs**: None blocking.
- **High-priority fixes**: 5 (validation hardening, component resolution checks, versioning consistency, context-window centralization, test gaps).

---

## Current State by Area

### Templates

- Runtime store documented and structured; packs follow `pack.yaml` + `schema.json` + `template.yaml` pattern.
- Hybrid XML format present with components and embedded JSON Schema; parser/utilities referenced in docs and tests.
- Loader/validation use secure YAML loading, Ajv-based schema validation, path checks, and file-size limits.
- Usage surfaced via MCP tools: `get_available_domains`, `create_mission`.

### MCP Server

- Canonical tool registration in `src/index.ts` (quality, templates, combination, intelligence). Deprecated aliases emit warnings and remain discoverable.
- Server context wires token counting/bootstrap; smoke tests validate `list_tools` and end-to-end invocation for intelligence tools with token usage present.
- Error handling centralized with `ErrorHandler` + `ErrorLogger`.

### Intelligence Layer

- Token Optimizer implements 4-pass pipeline with token usage metrics and dry-run; ensures write-back via atomic backups.
- Split Suggestions and Mission Splitting share `ComplexityScorer` and `MissionSplitter`, return reasoning and token window utilization.
- Context windows per model currently defined in multiple modules.

---

## Notable Issues and Risks

- Validation gaps in hybrid templates:
  - Component `src` resolution lacks explicit path traversal guard beyond base-dir assumptions.
  - No pre-parse existence check of referenced component files.
  - Embedded JSON Schema in XML not constrained for size/complexity (potential DoS vectors).
- Versioning consistency:
  - Packs/registry/hybrid use different fields (`version`, `schema_version`, `apiVersion`) without a documented contract or cross-check.
- Placeholder consistency in YAML templates:
  - Empty strings vs empty arrays vs null inconsistently used; not enforced by schema.
- Context window constants duplicated:
  - Hardcoded windows in `split-mission.ts` and `suggest-splits.ts`; risk of drift across modules.
- Test coverage gaps:
  - No explicit tests for hybrid component missing file handling.
  - No CI check ensuring registry entries map to existing pack directories.
  - No CI enforcing `template.yaml` values satisfy `schema.json` required fields.
- Resilience:
  - Long-running operations (e.g., optimization on very large missions) lack timeout/cancellation pathways at tool layer.

---

## Evidence (Code References)

```56:186:src/index.ts
const CANONICAL_TOOL_DEFINITIONS = [
  getAvailableDomainsToolDefinition,
  createMissionToolDefinition,
  getTemplateExtractionToolDefinition,
  createTemplateImportToolDefinition,
  getTemplateExportToolDefinition,
  createCombinedPackToolDefinition,
  getDependencyAnalysisToolDefinition,
  getMissionQualityScoreTool,
  updateTokenOptimizationToolDefinition,
  createMissionSplitsToolDefinition,
  getSplitSuggestionsToolDefinition,
] as const;

const DEPRECATED_TOOL_ALIASES: Record<string, { replacement: string }> = {
  list_available_domains: { replacement: 'get_available_domains' },
  analyze_dependencies: { replacement: 'get_dependency_analysis' },
  score_quality: { replacement: 'get_mission_quality_score' },
  optimize_tokens: { replacement: 'update_token_optimization' },
  split_mission: { replacement: 'create_mission_splits' },
  suggest_splits: { replacement: 'get_split_suggestions' },
};
```

```97:155:src/tools/optimize-tokens.ts
export class OptimizeTokensToolImpl {
  async execute(params: OptimizeTokensParams) {
    // ... load, optimize, atomic write, return tokenUsage/stats ...
  }
}
```

```120:170:src/tools/suggest-splits.ts
constructor(tokenCounter: ITokenCounter, model: SupportedModel = 'claude') {
  const contextWindow = this.getContextWindow(model);
  this.complexityScorer = new ComplexityScorer(tokenCounter, {
    model,
    contextWindow,
    agentTimeHorizon: 60,
  });
}
```

```430:437:src/tools/split-mission.ts
private getContextWindow(model: SupportedModel): number {
  const windows: Record<SupportedModel, number> = {
    claude: 200000,
    gpt: 128000,
    gemini: 1000000,
  };
  return windows[model] || 200000;
}
```

```69:101:tests/smoke/mcp-intelligence-tools-smoke.test.ts
it('list_tools exposes update_token_optimization, create_mission_splits, and get_split_suggestions', () => {
  const toolNames = getToolDefinitions().map((tool) => tool.name);
  expect(toolNames).toEqual(expect.arrayContaining([
    'update_token_optimization',
    'create_mission_splits',
    'get_split_suggestions',
  ]));
});
```

---

## Prioritized Recommendations

- High priority
  - Add hybrid component resolution validation and explicit path traversal checks for `src` attributes.
  - Validate embedded JSON Schema size/complexity; enforce Draft-07 (or documented draft) compliance.
  - Introduce a single `ContextWindowRegistry` (or reuse `TokenCounter` config) and import it in tools to remove hardcoded windows.
  - Add CI checks:
    - `templates/registry.yaml` ↔ actual pack directories match.
    - Every `template.yaml` validates against its `schema.json` with non-empty required placeholders.
  - Document versioning contract across `version`/`schema_version`/`apiVersion`; add a cross-validator.

- Medium priority
  - Standardize placeholder conventions (empty string/array/null) and add a validator.
  - Cache compiled Ajv schemas across pack loads; consider lazy-loading packs when count grows.
  - Add cancellation/timeout support on long-running tool executions.

- Low priority
  - Style guide for quoting and description length in pack manifests.
  - Add hybrid component catalog `templates/hybrid/components/README.md`.

---

## Potential Bugs (Actionable)

- Hybrid `src` references not pre-validated may cause runtime failures with non-existent components; add existence checks and descriptive error messages.
- Duplicate context window constants risk inconsistency; centralize and import.
- Missing CI validation for registry entries could allow stale paths; add test.

---

## Test Additions

- Hybrid: missing component file yields clear error; path traversal attempts rejected.
- Registry: ensure every registry entry points to an existing directory.
- Schema/template: enforce that all templates satisfy required fields with non-empty values.
- Intelligence: add small unit tests for recommendation branches in `suggest-splits` (score buckets) and dry-run behavior in optimizer.

---

## Quick Wins

- Centralize context windows in a shared module and update `split-mission.ts` and `suggest-splits.ts` to consume it.
- Add a lightweight pre-parse check for hybrid `src` existence before full parse.
- Write a short versioning doc and link it from `templates/README.md`.

---

## Closing Notes

The platform is technically solid and thoughtfully architected. Addressing the above validation, versioning, and test items will harden reliability and reduce maintenance risk without large refactors.

